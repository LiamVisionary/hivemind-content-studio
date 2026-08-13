"""Klein Character Sheet — one reference image in, a labeled multi-view
character sheet out.

Assimilated from the Civitai workflow "Flux2 Klein Multi-view Character
Generation" v2.0 (civitai.red/models/2401955, by lrzjason). The donor is a
446-node ComfyUI graph across eight custom-node packs (EditUtils, Impact,
Comfyroll, LayerStyle, KJNodes, rgthree, easy-use, pysssss); we keep its
load-bearing recipe — white-background per-view edit prompts against a Flux2
Klein 9B edit model, one shared seed across every view, a composited labeled
sheet — and run it through the studio's existing native Klein edit lane
instead of importing the graph. The donor's pose-guided mode ("change the
character in image 1 to the pose in image 2") is out of scope: its pose
reference images ship on RunningHub, not in the workflow file.

Kept dependency-free (stdlib only): app.py imports this under the system
python3, and the pure view/prompt logic stays unit-testable without PIL.
Pixel work reuses bin/compose-strength-hunt-sheet.py via the repo venv.
"""

from __future__ import annotations

# Registry order is sheet order for presets. Phrases follow the donor's
# single-reference prompt shape ("生成图中角色全身的正视图" — "generate the
# full-body front view of the character in the image").
# `crop` is a framing re-assertion for the views that do NOT show the whole
# body. It is emitted AFTER the caller's text so it gets the last word: a
# wardrobe clause detailed enough to pin an outfit ("...wide-leg trousers and
# black flat shoes") otherwise drags a close-up out to a full-body shot, because
# the model renders what it was most recently told to show. Phrased positively —
# the distilled 4-step build runs at cfg=1 and ignores negatives.
KLEIN_SHEET_VIEWS = {
    "front": {"label": "Front", "phrase": "the full-body front view"},
    "front_45": {"label": "Front 3/4", "phrase": "a full-body front three-quarter (45 degree) view"},
    "left": {"label": "Left", "phrase": "the full-body left side view"},
    "right": {"label": "Right", "phrase": "the full-body right side view"},
    "back": {"label": "Back", "phrase": "the full-body back view"},
    "back_45": {"label": "Rear 3/4", "phrase": "a full-body rear three-quarter (45 degree) view"},
    "upper_front": {"label": "Bust front", "phrase": "an upper-body front view",
                    "crop": "Framing: upper body only, cropped at the waist."},
    "upper_back": {"label": "Bust back", "phrase": "an upper-body back view",
                   "crop": "Framing: upper body only, cropped at the waist."},
    "face": {"label": "Face", "phrase": "a frontal close-up of the face",
             "crop": "Framing: the face fills the frame."},
    "head": {"label": "Portrait", "phrase": "a frontal close-up of the head and shoulders",
             "crop": "Framing: head and shoulders only, cropped at the chest."},
}

KLEIN_SHEET_PRESETS = {
    # Classic turnaround rotation order, not registry order.
    "turnaround": ["front", "right", "back", "left"],
    "standard": ["front", "front_45", "left", "right", "back", "back_45"],
    "full": [
        "front", "front_45", "left", "right", "back", "back_45",
        "upper_front", "upper_back", "face",
    ],
}

MAX_SHEET_VIEWS = len(KLEIN_SHEET_VIEWS)

# The donor pins white backgrounds so views cut out cleanly; the consistency
# clause stands in for its f2k_consis LoRA, which the studio may not have.
_VIEW_PROMPT_TEMPLATE = (
    "White background. Generate {phrase} of the character in the image, "
    "keeping the exact same character, outfit, hairstyle, and proportions."
)


def resolve_character_sheet_views(sheet_req):
    """Resolve a character_sheet request into an ordered list of view dicts.

    Accepts {preset: "turnaround"} or an explicit list. A views entry is either
    a plain id ("front") or {"id": "front", "prompt": "..."} — a PER-VIEW prompt,
    which replaces the shared prompt for that view alone. That exists because one
    shared string cannot serve every view: wording precise enough to pin a
    wardrobe head-to-toe also tells a portrait view to show shoes, so a mixed
    sheet (close-up + full bodies) needs each view to describe only what it
    actually shows.

    Raises ValueError on unknown presets/views or an empty selection. Explicit
    views win over the preset and keep their caller order; duplicates collapse to
    the first occurrence (the first one's prompt wins with it)."""
    sheet_req = sheet_req if isinstance(sheet_req, dict) else {}
    requested = sheet_req.get("views")
    if not isinstance(requested, list) or not requested:
        preset = str(sheet_req.get("preset") or "").strip().lower()
        if not preset:
            raise ValueError("character sheet needs a preset or a views list")
        if preset not in KLEIN_SHEET_PRESETS:
            raise ValueError(
                f"unknown character sheet preset: {preset} "
                f"(expected one of {', '.join(sorted(KLEIN_SHEET_PRESETS))})"
            )
        requested = KLEIN_SHEET_PRESETS[preset]
    views = []
    seen = set()
    for value in requested:
        view_prompt = ""
        if isinstance(value, dict):
            view_prompt = str(value.get("prompt") or "").strip()
            value = value.get("id")
        view_id = str(value or "").strip().lower()
        if not view_id or view_id in seen:
            continue
        if view_id not in KLEIN_SHEET_VIEWS:
            raise ValueError(
                f"unknown character sheet view: {view_id} "
                f"(expected one of {', '.join(KLEIN_SHEET_VIEWS)})"
            )
        seen.add(view_id)
        entry = {"id": view_id, **KLEIN_SHEET_VIEWS[view_id]}
        if view_prompt:
            entry["prompt"] = view_prompt
        views.append(entry)
    if not views:
        raise ValueError("character sheet needs at least one view")
    return views[:MAX_SHEET_VIEWS]


def character_sheet_view_prompt(view, user_prompt=""):
    """The per-view edit prompt, in the order the model reads it:

      1. the donor's view instruction ("generate {phrase} ... same outfit"),
      2. this view's own prompt if it has one, otherwise the shared prompt,
      3. for views that are not full-body, a framing re-assertion.

    Step 3 is last on purpose. Whatever describes the subject most recently wins
    the composition, so a wardrobe clause mentioning trousers and shoes would
    otherwise turn a head-and-shoulders view into a full-body shot."""
    prompt = _VIEW_PROMPT_TEMPLATE.format(phrase=view["phrase"])
    own = str(view.get("prompt") or "").strip()
    text = own or str(user_prompt or "").strip()
    if text:
        prompt = f"{prompt} {text}"
        crop = str(view.get("crop") or "").strip()
        if crop:
            prompt = f"{prompt} {crop}"
    return prompt


def character_sheet_grid(count):
    """Grid hints for the sheet composer: strips stay strips, larger sets pack
    near-square (sheet_layout's square repack keys off rows == 1 + square)."""
    count = max(1, int(count))
    return {"rows": 1, "cols": count, "square": count > 4}
