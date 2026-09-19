"""Does a lane's registry row tell the truth about what it needs?

This file exists because the same bug kept coming back under different model
names: a lane declared `requires.image` it did not actually have, the composer
refused the run before it was ever sent, and a model that has always done
text-to-image was presented as an editing tool. BigLove Klein 3 was the last
one — the registry said image-only, the Swift engine had had
`Flux2GenerationMode.textToImage` the whole time.

The root cause was never the flag. It was that a lane reached only by "an image
happens to be attached" has no other way to be selected, so `requires.image`
was doing the routing's job. The rule these tests pin is therefore twofold:

  1. a lane that declares `requires.image` must say WHY, here, by name; and
  2. a lane that does not declare it must be reachable BY NAME, so a
     reference-free request actually lands on it instead of falling through to
     whatever runner happens to be last.
"""
import json
import unittest
from pathlib import Path

REGISTRY = Path(__file__).with_name("workflow-registry.json")

# The only image lanes allowed to refuse a prompt-only run, and the reason each
# one genuinely cannot start from words. Adding a row here is a claim about the
# GRAPH, not about which mode someone wired first — check the runner before you
# add one, and prefer making the lane accept both.
IMAGE_IS_THE_INSTRUCTION = {
    "flux2-klein-eyes-direction":
        "the LoRA reads a rendered red-dot reference; there is nothing to point the eyes of without a picture",
    "flux2-klein-sun-direction":
        "the LoRA reads a rendered lit sphere and relights an existing exterior",
    "ltx23-ic-ingredients-lora":
        "the IC-LoRA conditions on the ingredient sheet itself",
}


def registry_rows():
    return json.loads(REGISTRY.read_text())["workflows"]


# Mirrors NOT_INHERITED in hosted-local-models.js and bin/media-studio-mcp.mjs:
# `routing_only` says THIS row is not a lane, which a lane built on its weights
# does not take on. Inherited, it silently marked comfy-flux2-klein-9b and both
# direction lanes unpickable in every resolved view.
NOT_INHERITED = {"routing_only"}


def resolved_rows():
    """Rows with `inherits` folded in, the way hosted-local-models.js does."""
    by_id = {row["id"]: row for row in registry_rows()}
    resolved = {}

    def resolve(row_id):
        if row_id in resolved:
            return resolved[row_id]
        row = by_id[row_id]
        parent = str(row.get("inherits") or "").strip()
        if parent:
            base = {k: v for k, v in resolve(parent).items() if k not in NOT_INHERITED}
            merged = {**base, **row}
        else:
            merged = dict(row)
        merged.pop("inherits", None)
        resolved[row_id] = merged
        return merged

    return [resolve(row_id) for row_id in by_id]


SELECTABLE_BUILDERS = {"image-backend", "comfy-api-image", "comfy-api", "comfy-api-audio"}


def selectable_rows(media_type=None):
    """Every lane a person can actually pick, of one media type or all."""
    return [
        row for row in resolved_rows()
        if row.get("builder") in SELECTABLE_BUILDERS
        and not row.get("routing_only")
        and (media_type is None or row.get("media_type") == media_type)
    ]


def selectable_image_rows():
    return selectable_rows("image")


def claimant(row_id):
    """Which row in this lane's inheritance chain actually DECLARED `requires`.

    A lane that inherits the flag unchanged inherits the reason with it: the
    Eros builds of the IC-ingredients lane all get their demand for a sheet
    from one parent, and writing the sentence out four times would only rot in
    three places. So the row that stated the flag is the one that has to
    justify it.
    """
    by_id = {row["id"]: row for row in registry_rows()}
    seen = set()
    while row_id and row_id not in seen:
        seen.add(row_id)
        row = by_id.get(row_id)
        if row is None:
            return row_id
        if row.get("requires") is not None:
            return row_id
        row_id = str(row.get("inherits") or "").strip()
    return row_id


class LaneCapabilityHonesty(unittest.TestCase):
    def test_only_lanes_whose_input_is_the_instruction_may_demand_an_image(self):
        # Every media type, not just image: a video lane can make the same
        # false claim, and an LTX graph that CAN start from a prompt but says
        # `requires.image` is refused in the composer exactly as Klein was.
        demanding = {
            row["id"] for row in selectable_rows()
            if (row.get("requires") or {}).get("image")
        }
        undocumented = sorted(
            lane for lane in demanding
            if claimant(lane) not in IMAGE_IS_THE_INSTRUCTION
        )
        self.assertEqual(
            undocumented, [],
            "These lanes refuse a prompt-only run without saying why. A model "
            "that can write a picture from words must not be declared "
            "image-only: give the lane a text-to-image path, or add it to "
            "IMAGE_IS_THE_INSTRUCTION with the reason its graph cannot start "
            "from a prompt.\n  " + "\n  ".join(undocumented),
        )

    def test_the_exception_list_does_not_outlive_its_lanes(self):
        known = {row["id"] for row in registry_rows()}
        stale = sorted(set(IMAGE_IS_THE_INSTRUCTION) - known)
        self.assertEqual(stale, [], f"exception recorded for lanes that no longer exist: {stale}")

    def test_a_lane_that_accepts_a_prompt_alone_is_reachable_by_name(self):
        """The gateway must route it on its own backend name.

        Reached only by "an image is attached", a reference-free request lands
        on the generic runner instead — a different model, silently. That is
        what `requires.image: true` was covering up on the Klein lane.

        Image lanes only, and deliberately: a video or audio lane is addressed
        by `workflow_id` on every path into it (gateway/http.py's dependency
        routes, bin/media-studio-mcp.mjs's videoWorkflowRegistry), so it is
        name-addressed by construction and cannot fall through this way.
        """
        from gateway import config, graphs

        named = (
            set(config.KREA2_IDENTITY_BACKENDS)
            | set(graphs.BIGLOVE_KLEIN3_BACKENDS)
            | {graphs.FLUX2_KLEIN_9B_BACKEND}
            # These builders carry their own graph file and are dispatched on
            # the builder name rather than on a per-lane backend.
            | {"comfy-api-image"}
            # The fallthrough lane, which is what an empty backend selects.
            | {""}
        )


        def effective_backend(row):
            # A comfy-api-image lane carries its graph file and is dispatched on
            # the builder name — hosted-local-models.js sets the same value.
            if row.get("builder") == "comfy-api-image":
                return "comfy-api-image"
            # An empty backend IS the route: the request falls through to the
            # generic runner. Exactly one lane may claim that, the declared
            # default, so "no name" can never quietly mean "some other model".
            return str(row.get("backend") or "").strip() or ("" if row.get("default") else "<unnamed>")

        unreachable = sorted(
            row["id"] for row in selectable_image_rows()
            if not (row.get("requires") or {}).get("image")
            and effective_backend(row) not in named
        )
        self.assertEqual(
            unreachable, [],
            "These lanes accept a prompt-only run but the gateway has no name "
            "to route one on, so it would fall through to another model. Add "
            "the backend to its lane's named set in gateway/graphs.py and "
            "dispatch it in gateway/http.py.\n  " + "\n  ".join(unreachable),
        )

    def test_an_action_only_lane_is_never_a_model_you_pick(self):
        """An image lane driven by a button in the UI says so on its row.

        The Klein direction tools have their own dialog on a finished picture;
        listing them in the model picker as well made them look like two more
        models to choose between, which is exactly what the dialog replaced.

        This is about image lanes that STEER a finished picture, not about
        every lane that takes one: the LTX ingredients lane needs its sheet and
        is still a model you pick and press Generate on.
        """
        for row in selectable_image_rows():
            if row["id"] in IMAGE_IS_THE_INSTRUCTION:
                self.assertTrue(
                    row.get("action_only"),
                    f"{row['id']} needs a picture to act on, so it belongs to a button, "
                    "not to the model picker: set action_only on its registry row.",
                )
                self.assertTrue(
                    str(row.get("action_label") or "").strip(),
                    f"{row['id']} is action_only but has no action_label to name its button.",
                )


if __name__ == "__main__":
    unittest.main()


class InheritanceDoesNotLeakSelectability(unittest.TestCase):
    """`routing_only` must not travel down an `inherits` chain.

    Three resolvers fold inheritance — hosted-local-models.js, the MCP's
    bin/media-studio-mcp.mjs, and resolved_rows() above — and each keeps its
    own copy of the merge. This pins the shared rule from the data side, where
    all three have to agree: a lane whose parent is a shared-weights row must
    come out pickable.
    """

    def test_a_lane_built_on_shared_weights_is_still_a_lane(self):
        raw = {row["id"]: row for row in registry_rows()}
        declared = {row_id for row_id, row in raw.items() if row.get("routing_only")}
        leaked = sorted(
            row["id"] for row in resolved_rows()
            if row.get("routing_only") and row["id"] not in declared
        )
        self.assertEqual(
            leaked, [],
            "These lanes inherited routing_only from a parent that is only a "
            "weights declaration. Nothing picks them, and no picker says why. "
            "Keep the key in NOT_INHERITED in all three resolvers.\n  "
            + "\n  ".join(leaked),
        )
