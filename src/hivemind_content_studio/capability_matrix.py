"""Which models are FIT for a studio feature — not merely capable of one.

The workflow registry already answers *can*: a graph's `accepts` list says
whether it has an image input, a steps slot, reference rows. That question is
settled in ONE place (media_catalog + the frontend registry mapper) and this
module does not re-answer it.

What `accepts` cannot say is *should*. Every image model in the catalog accepts
a prompt, so every one of them is "capable" of drawing a game sprite — and most
of them draw a soft, shaded, photographic thing with a busy background that
cannot be cut out. A capability list that treats those as equal sends the user
to the wrong model and the failure looks like a bug in the feature.

So a row here is a JUDGEMENT with its provenance attached:

  structural  derived from the live catalog — the model does not take the
              inputs this feature needs. Not an opinion; it cannot run.
  rating      good / workable / poor, declared below.
  evidence    how we know. `measured` = a run on this machine. `reported` =
              the owner ran it and said so. `contract` = the vendor/registry
              says so in a schema. `reasoned` = an inference from what the
              model IS, never from a run. Absent a rule the answer is
              `unmeasured`, which the UI must render as "nobody has tried this
              here" — not as a recommendation and not as a warning.

The evidence class exists because the alternative is a matrix that quietly
promotes guesses to measurements. Ratings without runs behind them are marked
`reasoned` on purpose, and the UI says so.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .media_catalog import media_catalog


Rating = Literal["good", "workable", "poor", "unsupported", "unmeasured"]
Evidence = Literal["measured", "reported", "contract", "reasoned", "none"]

# Ranked best-first. The picker sorts on this, so the order is the contract.
RATING_ORDER: dict[str, int] = {"good": 0, "workable": 1, "unmeasured": 2, "poor": 3, "unsupported": 4}

# What a model with no declared rule gets. Deliberately not a warning and not a
# recommendation: it is the honest answer that nobody has run this combination
# on this machine.
_UNMATCHED_REASON = "Nobody has run this model through this feature here."


# ── What is not a model ─────────────────────────────────────────────────────
#
# The media catalog is an INVENTORY: it lists every route the app can take,
# including two that are not a model anyone chooses. A studio picker asking
# "which model should draw this?" must not offer either of them, and until
# 2026-08-24 it offered both — four rows reading "Automatic" with no way to tell
# what they were.

# Routing SENTINELS. `workflow-default` means "whatever the selected workflow
# is"; it is not a registered id and media_studio.py has to strip it before the
# MCP sees it, because the MCP answers it with "unknown video workflow_id:
# workflow-default". A row you cannot select without the backend rejecting it
# does not belong in a picker.
PLACEHOLDER_MODEL_IDS = frozenset({"workflow-default"})

# Providers that draw something other than a generated image: a stick figure, a
# text card. Real routes that the agent pipeline uses on purpose — they are not
# broken and they are not removed from the catalog — but they are never an answer
# to "draw a character reference sheet".
NON_GENERATIVE_PROVIDERS = frozenset({"stickman-renderer", "static-text-renderer"})


def is_selectable(provider_id: str, model_id: str) -> bool:
    """Is this catalog row a model a person can pick for a studio feature?"""
    return (
        str(provider_id or "") not in NON_GENERATIVE_PROVIDERS
        and str(model_id or "") not in PLACEHOLDER_MODEL_IDS
    )


@dataclass(frozen=True)
class FeatureRule:
    """One declared verdict. `match` is resolved most-specific first:
    `model:<id>` beats `family:<name>` beats `provider:<id>`."""

    match: str
    rating: Rating
    reason: str
    evidence: Evidence = "reasoned"


@dataclass(frozen=True)
class Feature:
    id: str
    label: str
    kind: Literal["image", "video"]
    summary: str
    # `accepts` fields the graph must declare for the feature to run at all.
    # Checked against the LIVE catalog, so a workflow that gains an input stops
    # being marked unsupported without anyone editing this file.
    requires_any: tuple[tuple[str, ...], ...] = ()
    # Fields whose presence means the model cannot start from a prompt alone.
    # Used by sprite_source: an edit-only graph has no "draw me a sprite" mode.
    forbids: tuple[str, ...] = ()
    rules: tuple[FeatureRule, ...] = ()


# ── Sprite pipeline ─────────────────────────────────────────────────────────
#
# The pipeline is: draw a sprite → animate it → pull key frames → cut the
# background out → pack a sheet. Only the first two stages pick a model, so
# only those two are features here. Frame extraction and matting are fixed
# tools, not choices, and a matrix row for them would be theatre.

SPRITE_SOURCE = Feature(
    id="sprite_source",
    label="Draw a game sprite",
    kind="image",
    summary=(
        "One character, flat even lighting, hard edges, on a plain background the "
        "matte step can cut away. Photographic realism and painterly shading are "
        "what make a sprite impossible to cut out later."
    ),
    rules=(
        FeatureRule(
            "model:anything-v5", "good",
            "Anime/illustration SD 1.5 finetune: flat cel shading and hard outlines are "
            "its default output, which is exactly what a sprite needs.",
            "reasoned",
        ),
        FeatureRule(
            "model:z-image-turbo", "good",
            "Local, 8 steps, and follows a flat-background instruction well enough to key. "
            "The fastest way to iterate on a sprite before spending an H3 run on it.",
            "reasoned",
        ),
        FeatureRule(
            "model:z-image-base", "workable",
            "Same model at 50 steps — more detail than a sprite wants, and six times the wait "
            "for a frame that gets downscaled anyway.",
            "reasoned",
        ),
        FeatureRule(
            "model:ideogram4-fp8", "workable",
            "Best-in-class typography, so it is the one to use when the sprite carries text or a "
            "UI badge. Its default look is a design render, not a game sprite.",
            "reasoned",
        ),
        FeatureRule(
            "model:realistic-vision-v51", "poor",
            "A photorealism finetune. It will draw a convincing creature with soft edges and "
            "depth-of-field haze, and the matte step cannot find a clean silhouette in that.",
            "reasoned",
        ),
        FeatureRule(
            "model:dreamshaper-8", "workable",
            "General SD 1.5 — takes a pixel-art or cel-shaded style instruction, but needs the "
            "style stated explicitly or it drifts to painterly.",
            "reasoned",
        ),
        FeatureRule(
            "model:stable-diffusion-xl-base", "workable",
            "SDXL base is style-neutral: it does what the prompt says, including flat sprite "
            "art, but has no sprite bias of its own to fall back on.",
            "reasoned",
        ),
        FeatureRule(
            "provider:higgsfield-consumer", "workable",
            "Cloud text-to-image. Fine for a one-off hero sprite; every iteration is a paid "
            "round-trip and the sprite leaves this machine.",
            "contract",
        ),
        FeatureRule(
            "provider:muapi", "workable",
            "Cloud text-to-image. Same trade as Higgsfield — spend and an upload per iteration.",
            "contract",
        ),
        FeatureRule(
            "provider:sdcpp", "workable",
            "A local sd.cpp checkpoint. Free to iterate on and never leaves this machine; how "
            "sprite-like the result is depends entirely on the checkpoint's own bias.",
            "reasoned",
        ),
        FeatureRule(
            "provider:wan2gp", "unmeasured",
            "Served by a Wan2GP server you run. Nothing about sprites has been measured through "
            "that path here.",
            "none",
        ),
        FeatureRule(
            "family:krea-2", "poor",
            "An identity-edit graph: it re-draws a person from a reference. Pointed at a blank "
            "canvas it has nothing to preserve.",
            "contract",
        ),
        FeatureRule(
            "family:flux-2-klein", "workable",
            "An edit graph — no good as a first draw, but the right tool for restyling a sprite "
            "you already have (recolour, add a hat, change the pose sheet).",
            "contract",
        ),
    ),
)

SPRITE_ANIMATION = Feature(
    id="sprite_animation",
    label="Animate a sprite",
    kind="video",
    summary=(
        "Take one sprite still and move it — an idle loop, a walk cycle, a reaction — "
        "while holding the character's shape and palette steady enough that every frame "
        "cuts out to the same silhouette."
    ),
    # A sprite is a STILL going in. Without an image input the graph would draw
    # a new character from text and the sheet would not be of your sprite.
    requires_any=(("image_base64", "image_path", "image_url"),),
    rules=(
        FeatureRule(
            "model:minimax-h3", "good",
            "The lane this feature was built on. H3 holds one character's shape and colour "
            "across a whole clip and takes direction per beat, which is what turns a still "
            "into an animation cycle rather than a drifting morph.",
            "reported",
        ),
        FeatureRule(
            "model:minimax-h3-turbo", "workable",
            "Distilled 4-8 step build of the same model. A sprite carries little fine detail, "
            "so the distillation costs less here than it would on a face — but identity drifts "
            "sooner, which shows up as a silhouette that changes between frames.",
            "reasoned",
        ),
        FeatureRule(
            "model:minimax-h3-reference", "workable",
            "H3 reference mode conditions on character pictures instead of a start frame. Useful "
            "when you have a turnaround sheet of the sprite; the plain tier is the right one when "
            "you have a single still.",
            "contract",
        ),
        FeatureRule(
            "family:ltx-2.3", "unmeasured",
            "LTX takes a start frame and can drive it, but no sprite run has been measured on this "
            "machine. Its motion LoRAs are trained on filmed footage, so expect camera-like drift "
            "rather than the anchored, on-the-spot motion a sprite cycle needs.",
            "reasoned",
        ),
        FeatureRule(
            "provider:higgsfield-consumer", "unmeasured",
            "Cloud image-to-video. Untried for sprites here, and each attempt is a paid round-trip "
            "with the sprite uploaded off this machine.",
            "contract",
        ),
        FeatureRule(
            "provider:muapi", "unmeasured",
            "Cloud image-to-video. Same trade as Higgsfield.",
            "contract",
        ),
    ),
)

# ── Story pipeline ──────────────────────────────────────────────────────────
#
# Concept -> character sheets -> location plate -> storyboard -> motion script.
# Three of those stages draw an image and each one asks for something different,
# so each gets its own verdict rather than one blanket "good at images" row:
#
#   the sheet  needs the SAME character three times on one canvas. That is an
#              instruction-following problem, not an aesthetics problem.
#   the plate  needs depth and restraint — and, above all, no people in it.
#   the board  needs a numbered grid whose panels differ, built on top of
#              attached references. The hardest of the three by some distance.
#
# The motion stage is not a feature here on purpose: it hands its script to the
# Video studio, which already has a model picker, a reference budget and a lane.
# A second video-model verdict two pages away from that one would be a second
# opinion about the same choice.

_MULTI_VIEW = (
    "Three views of one character on one canvas is an instruction-following task "
    "before it is an art task: the model has to keep proportions, markings and the "
    "accessory side identical across all three, and most image models treat each "
    "view as an independent draw."
)

STORY_CHARACTER_SHEET = Feature(
    id="story_character_sheet",
    label="Draw a character reference sheet",
    kind="image",
    summary=(
        "Front, exact side profile and back of one character on a single plain canvas, "
        "with proportions, markings, clothing construction and the signature detail "
        "identical in every view. Neutral posture, even light, nothing hidden."
    ),
    rules=(
        FeatureRule(
            "model:gpt-image-2", "good",
            "Strongest instruction follower in the catalog for multi-panel layout: it holds "
            "one subject across three views on one canvas and respects 'no props, no "
            "typography' instead of drawing a poster. " + _MULTI_VIEW,
            "reasoned",
        ),
        FeatureRule(
            "model:gpt_image_2", "good",
            "The same model through Higgsfield. Same verdict; a paid round-trip per attempt.",
            "reasoned",
        ),
        FeatureRule(
            "model:nano_banana_pro", "good",
            "Built for reference-conditioned edits and multi-subject layouts, so a turnaround "
            "sheet stays one character. " + _MULTI_VIEW,
            "reasoned",
        ),
        FeatureRule(
            "model:ideogram4-fp8", "workable",
            "Follows layout and typography instructions well, which is what keeps the three "
            "views separated and labelled. Its default look is a design render, so state the "
            "art style explicitly.",
            "reasoned",
        ),
        FeatureRule(
            "model:flux-2-pro", "workable",
            "Good prompt adherence and clean edges. No particular bias toward turnarounds, so "
            "expect to regenerate until the three views agree.",
            "reasoned",
        ),
        FeatureRule(
            "family:flux-2-klein", "workable",
            "An edit graph. Wrong tool for the first sheet, right tool for changing one thing "
            "about a sheet you have already approved.",
            "contract",
        ),
        FeatureRule(
            "family:krea-2", "poor",
            "An identity-edit graph: it redraws a person from a reference photo. It has no "
            "blank-canvas mode, so there is nothing for it to preserve here.",
            "contract",
        ),
        FeatureRule(
            "provider:sdcpp", "workable",
            "A local checkpoint. Free to iterate on and the sheet never leaves this machine, "
            "but SD-class models draw the three views as three separate characters far more "
            "often than the frontier models do — budget for several attempts and the audit.",
            "reasoned",
        ),
        FeatureRule(
            "model:realistic-vision-v51", "poor",
            "A photorealism finetune with soft edges and shallow depth of field. A reference "
            "sheet needs flat readable light, which is the opposite of what it is for.",
            "reasoned",
        ),
    ),
)

STORY_LOCATION = Feature(
    id="story_location",
    label="Draw an empty location plate",
    kind="image",
    summary=(
        "One clean plate of the place with nobody in it: layout, foreground-to-background "
        "depth, practical light, palette, and the objects that will later move. Empty on "
        "purpose — the character sheets own the characters."
    ),
    rules=(
        FeatureRule(
            "model:gpt-image-2", "good",
            "Follows 'no people' — which most image models quietly ignore when the scene "
            "reads as somewhere a person would be — and builds legible foreground, midground "
            "and background.",
            "reasoned",
        ),
        FeatureRule(
            "model:gpt_image_2", "good",
            "The same model through Higgsfield.",
            "reasoned",
        ),
        FeatureRule(
            "model:google-imagen4", "good",
            "Strong at environments, atmosphere and depth cues, which is nearly all of what a "
            "plate is for.",
            "reasoned",
        ),
        FeatureRule(
            "model:flux-2-pro", "good",
            "Handles architecture, weather and light without inventing a figure to look at it.",
            "reasoned",
        ),
        FeatureRule(
            "model:nano_banana_pro", "workable",
            "Capable, but tuned toward subject-led images — say 'empty, no people' twice or a "
            "lone figure appears under the awning.",
            "reasoned",
        ),
        FeatureRule(
            "provider:sdcpp", "workable",
            "Local and free to iterate. Character-focused checkpoints put a person in the "
            "frame by reflex; a landscape or architecture checkpoint is the one to pick.",
            "reasoned",
        ),
        FeatureRule(
            "model:anything-v5", "poor",
            "An anime character finetune. Asked for an empty street it draws a girl standing "
            "in one.",
            "reasoned",
        ),
        FeatureRule(
            "family:krea-2", "unsupported",
            "An identity-edit graph with no draw-from-prompt mode; a plate has no identity to "
            "edit.",
            "contract",
        ),
    ),
)

STORY_BOARD = Feature(
    id="story_board",
    label="Draw a storyboard sheet",
    kind="image",
    summary=(
        "One canvas of numbered panels — four for cinematic pacing, sixteen for coverage, "
        "or two frames for one exact action — each a different moment with its own camera "
        "distance, built on the character sheets and the location plate."
    ),
    # No requires_any: a text-only image model CAN draw a storyboard — it just
    # draws four strangers, because it never saw the sheets. That is a bad board,
    # not an impossible one, so it is a rating below and not a structural refusal.
    rules=(
        FeatureRule(
            "model:gpt-image-2", "good",
            "The one job here that is mostly layout compliance — a numbered grid, a different "
            "moment in every cell, references honoured. This is what it is best at.",
            "reasoned",
        ),
        FeatureRule(
            "model:gpt_image_2", "good",
            "The same model through Higgsfield.",
            "reasoned",
        ),
        FeatureRule(
            "model:nano_banana_pro", "good",
            "Reference-conditioned by design, so the panels stay the characters you locked "
            "rather than four new ones.",
            "reasoned",
        ),
        FeatureRule(
            "model:nano-banana-pro-edit", "workable",
            "The edit variant. Right for fixing one panel of an approved board; for the first "
            "board it has nothing to edit.",
            "contract",
        ),
        FeatureRule(
            "model:ideogram4-fp8", "workable",
            "Panel numbering and borders come out clean. Expect to state the shot distance of "
            "every panel or it settles into one framing for all of them.",
            "reasoned",
        ),
        FeatureRule(
            "provider:sdcpp", "poor",
            "SD-class checkpoints draw one image, not a grid of different moments. Asked for "
            "four panels they usually produce four near-identical ones — the exact failure "
            "the board exists to prevent.",
            "reasoned",
        ),
        FeatureRule(
            "family:krea-2", "unsupported",
            "An identity-edit graph. It has no multi-panel mode.",
            "contract",
        ),
    ),
)


FEATURES: tuple[Feature, ...] = (
    SPRITE_SOURCE,
    SPRITE_ANIMATION,
    STORY_CHARACTER_SHEET,
    STORY_LOCATION,
    STORY_BOARD,
)


# Verdicts that are true of a PROVIDER whatever the feature is.
#
# Appended to every feature's rules rather than copied into each one — the last
# time this was a copy it was pasted into one of four features and the other
# three silently read "nobody has tried it here" for the same row. A feature
# that declares its own rule for the same match key still wins, because
# _matching_rule takes the first hit and these come last.
COMMON_RULES: tuple[FeatureRule, ...] = (
    FeatureRule(
        # `workable`, not `unmeasured`: it is not that nobody has tried it, it is
        # that there is nothing fixed to try. It will return an image.
        "provider:hivemindos-hosted-media", "workable",
        "The hosted service picks a current model for you, so what actually draws this is "
        "not something the picker can rate in advance.",
        "contract",
    ),
)


def _feature(feature_id: str) -> Feature:
    for feature in FEATURES:
        if feature.id == feature_id:
            return feature
    raise ValueError(f"Unknown studio capability feature: {feature_id}")


def _structural_reason(feature: Feature, model: dict[str, Any]) -> str | None:
    """Why the LIVE catalog says this model cannot run the feature at all.

    Derived, never declared: a workflow that gains an image input stops being
    unsupported the moment the registry says so.
    """
    accepts = {str(value) for value in model.get("accepts") or ()}
    # An empty accepts list is an unread registry, not a graph with no inputs.
    # Refusing every model on a degraded catalog would be the worst possible
    # failure here: it reads as "your models cannot do this".
    if not accepts:
        return None
    for group in feature.requires_any:
        if not accepts.intersection(group):
            names = " / ".join(group)
            return f"The workflow declares no {names} input, so it cannot start from your sprite."
    forbidden = sorted(accepts.intersection(feature.forbids))
    if forbidden and not accepts.intersection({"prompt"}):
        return "The workflow only edits an existing image; it has no draw-from-prompt mode."
    return None


def _matching_rule(feature: Feature, provider_id: str, model: dict[str, Any]) -> FeatureRule | None:
    """Most-specific match wins: model id, then registry family, then provider."""
    model_id = str(model.get("id") or "")
    family = str(model.get("family") or "")
    for key in (f"model:{model_id}", f"family:{family}" if family else "", f"provider:{provider_id}"):
        if not key:
            continue
        for rule in (*feature.rules, *COMMON_RULES):
            if rule.match == key:
                return rule
    return None


def feature_rows(feature_id: str, catalog: dict[str, list[dict]] | None = None) -> list[dict[str, Any]]:
    """Every catalogued model of the feature's kind, rated, best first."""
    feature = _feature(feature_id)
    data = catalog if catalog is not None else media_catalog()
    rows: list[dict[str, Any]] = []
    for provider in data.get(feature.kind, []):
        provider_id = str(provider.get("id") or "")
        for model in provider.get("models", []):
            # Sentinels and renderers are inventory, not choices. Dropped here
            # rather than in each picker, so one rule serves every consumer.
            if not is_selectable(provider_id, str(model.get("id") or "")):
                continue
            blocked = _structural_reason(feature, model)
            rule = _matching_rule(feature, provider_id, model)
            if blocked:
                rating: Rating = "unsupported"
                reason = blocked
                evidence: Evidence = "contract"
            elif rule:
                rating, reason, evidence = rule.rating, rule.reason, rule.evidence
            else:
                rating, reason, evidence = "unmeasured", _UNMATCHED_REASON, "none"
            rows.append({
                "feature": feature.id,
                "provider": provider_id,
                "provider_label": str(provider.get("label") or provider_id),
                "model": str(model.get("id") or ""),
                "model_label": str(model.get("label") or model.get("id") or ""),
                "family": str(model.get("family") or ""),
                "rating": rating,
                "reason": reason,
                "evidence": evidence,
                # Whether the provider answered its readiness probe, and whether
                # its model list was read live. A `good` rating on a provider
                # that is down is still a good rating — but the picker has to be
                # able to say "and it is offline right now" rather than offering
                # it as if it would run.
                "available": bool(provider.get("available")),
                "registry_live": bool(provider.get("registry_live", True)),
            })
    rows.sort(key=lambda row: (RATING_ORDER.get(row["rating"], 9), not row["available"], row["model_label"].lower()))
    return rows


def capability_matrix(catalog: dict[str, list[dict]] | None = None) -> dict[str, Any]:
    """The whole matrix: declared features, their rated rows, and their rules.

    `rows` is this module joined against the SERVER's inventory (the media
    catalog). `rules` is the same verdicts unjoined, because half the studio's
    image models are a client-side catalog the server has never heard of —
    sd.cpp checkpoints on disk, a Wan2GP server the owner runs. Shipping the
    rules lets the browser rate those against the identical declarations
    instead of growing a second opinion about which model draws a good sprite.
    """
    data = catalog if catalog is not None else media_catalog()
    return {
        "ratings": list(RATING_ORDER),
        "unmatched": {"rating": "unmeasured", "reason": _UNMATCHED_REASON, "evidence": "none"},
        "features": [
            {
                "id": feature.id,
                "label": feature.label,
                "kind": feature.kind,
                "summary": feature.summary,
                "requires_any": [list(group) for group in feature.requires_any],
                "forbids": list(feature.forbids),
                # Shipped with the common rules folded in, in the same order
                # _matching_rule applies them, so the browser's copy of a verdict
                # cannot disagree with the server's.
                "rules": [
                    {"match": rule.match, "rating": rule.rating, "reason": rule.reason, "evidence": rule.evidence}
                    for rule in (*feature.rules, *COMMON_RULES)
                ],
                "rows": feature_rows(feature.id, data),
            }
            for feature in FEATURES
        ],
    }


def best_models(feature_id: str, limit: int = 3, catalog: dict[str, list[dict]] | None = None) -> list[dict[str, Any]]:
    """The top-rated models that are actually ready to run right now."""
    rows = [row for row in feature_rows(feature_id, catalog)
            if row["available"] and row["rating"] in {"good", "workable"}]
    return rows[: max(0, limit)]
