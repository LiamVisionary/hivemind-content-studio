"""Typed media model inventory shared by the simple studio and agent routes."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from functools import lru_cache
from typing import Literal

from . import muapi_catalog
from .providers import provider_report


MediaKind = Literal["image", "video"]


@dataclass(frozen=True)
class MediaModel:
    id: str
    label: str
    reference_roles: tuple[str, ...] = ()
    max_reference_images: int | None = 0
    limit_source: str = "provider contract"
    accepts: tuple[str, ...] = ()
    # Workflow family from the registry (ltx / minimax / ...). Capability
    # differences follow the family: extend + head swap are LTX-graph
    # features, so the studio must not offer them for an H3 workflow.
    family: str = ""
    supports_loras: bool = False
    compatible_base_models: tuple[str, ...] = ()
    ingredient_inputs: dict | None = None
    # How many reference pictures / videos / audio clips the workflow's graph
    # actually wired (MiniMax H3 Reference mode). The studio sizes its
    # References panel from this instead of hardcoding the counts.
    reference_slots: dict | None = None
    aspect_ratios: tuple[str, ...] = ()
    default_duration_seconds: float | None = None
    # Longest stretch of MOTION REFERENCE each canvas can carry, keyed
    # "<tier>|<aspect>" (see motion_reference_duration_limits). The node trims a
    # reference video to min(its own length, the clip's length), so a reference
    # at or beyond the clip's length makes the CLIP the thing that has to fit,
    # while a shorter reference costs only its own length and leaves the full
    # duration range open. The studio drops the unreachable durations from its
    # picker instead of letting the run fail at submit. Empty for workflows with
    # no measured budget — unmeasured is not the same as impossible, so those
    # keep the full range.
    motion_reference_max_seconds: dict | None = None
    # The inputs behind those ceilings (budget, frame lattice, rows per canvas,
    # full vs compact reference rows, audio row rate), so the studio can price
    # the run it is ACTUALLY about to send — compact staging, a trimmed clip,
    # fewer pictures, no soundtrack — instead of showing the pessimistic
    # per-canvas ceiling above. See motion_reference_pricing. None without a
    # measured budget.
    motion_reference_pricing: dict | None = None
    # The workflow's registered sampling-step default. Lets the studio label its
    # step presets truthfully ("Standard (15 steps)") and tell a full-step lane
    # from a distilled one (a turbo build's 4-8 steps must not get a 32-step
    # "High detail" option bolted on).
    default_steps: float | None = None
    # Models that ship both a distilled and a full-step build pair up here: same
    # tier_group, different tier. The studio collapses a group into one row with
    # a Lite/Standard switch instead of listing near-identical models twice.
    # Left None for anything that only has one build.
    tier_group: str | None = None
    tier: Literal["lite", "standard"] | None = None
    # Experimental workflows (preview weights, unfinished training runs) get a
    # beta badge in the pickers instead of a separate catalog section.
    beta: bool = False
    # Reached by routing, never picked by hand: the studio routes a run here
    # when references are attached to the family's normal tier, so offering it
    # as its own tier only strands the user on a graph with no frame inputs.
    routing_only: bool = False


@dataclass(frozen=True)
class MediaProviderModels:
    id: str
    label: str
    kind: MediaKind
    models: tuple[MediaModel, ...]


# Keyword args from `accepts` on: an earlier field insertion (family) silently
# shifted these positional entries — supports_loras became family, and the
# minimax row put its default duration into aspect_ratios, crashing the whole
# catalog whenever the MCP was unreachable. Keywords make the next field
# insertion a no-op here.
BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS: tuple[MediaModel, ...] = (
    MediaModel("workflow-default", "Workflow default", ("start", "reference"), None, "selected MCP workflow schema", accepts=("image_base64", "video_base64", "video_mode", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-eros-dmd-v12", "LTX 2.3 Eros DMD (v1.2)", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "video_base64", "video_mode", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-regular-fp8", "LTX 2.3 Regular FP8", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "video_base64", "video_mode", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-eros-ic-ingredients-lora", "LTX 2.3 Eros IC-LoRA Ingredients", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "ingredient_images", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-eros-dmd-ic-ingredients-lora", "LTX 2.3 Eros DMD IC-LoRA Ingredients", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "ingredient_images", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-eros-v14-ic-ingredients-lora", "LTX 2.3 Eros v1.4 IC-LoRA Ingredients", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "ingredient_images", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("ltx23-eros-v14-dmd", "LTX 2.3 Eros v1.4 DMD", ("start", "reference"), None, "Media Studio MCP workflow registry", accepts=("image_base64", "video_base64", "video_mode", "loras"), family="ltx-2.3", supports_loras=True, compatible_base_models=("LTXV",)),
    MediaModel("minimax-h3", "MiniMax H3", ("start",), None, "Media Studio MCP workflow registry", accepts=("image_base64",), family="minimax", default_duration_seconds=5.0),
)


def _muapi_models(*selection: tuple[str, tuple[str, ...]]) -> tuple[MediaModel, ...]:
    """The producer's MUAPI rows, named by the one MUAPI catalog.

    The producer offers a chosen handful of the provider's models, and which
    reference roles it wires for each is a routing decision of ours (Seedance
    2.0 is listed here as its text-to-video endpoint, and the producer switches
    to the image sibling when frames are attached — so the row advertises frames
    the t2v endpoint itself has no input for). What is NOT ours to invent is the
    model's existence or its name: those come from the catalog the studios read,
    which is why this raises on an id the catalog does not carry rather than
    quietly advertising a model the provider does not serve.
    `test_muapi_catalog.py` runs that check at test time, so a drifted id fails
    the suite instead of the studio.
    """
    models = []
    for model_id, roles in selection:
        if not muapi_catalog.knows(model_id):
            raise ValueError(f"MUAPI catalog has no model '{model_id}' — see catalog/muapi_models.json")
        models.append(MediaModel(model_id, muapi_catalog.label_for(model_id), roles, None, "live MUAPI endpoint schema"))
    return tuple(models)


MEDIA_MODEL_MATRIX: tuple[MediaProviderModels, ...] = (
    MediaProviderModels("stickman-renderer", "Stickman renderer", "image", (MediaModel("automatic", "Automatic"),)),
    MediaProviderModels("static-text-renderer", "Static text renderer", "image", (MediaModel("automatic", "Automatic"),)),
    MediaProviderModels("comfyui", "ComfyUI", "image", (
        MediaModel("workflow-default", "Workflow default", ("reference",), None, "selected workflow schema"),
        MediaModel(
            "comfy-krea2-turbo-identity-edit",
            "Krea 2 Turbo Identity Edit",
            ("reference",),
            1,
            "Krea 2 identity-edit workflow contract",
            ("image_base64", "image_url", "image_path"),
        ),
    )),
    MediaProviderModels("openai-gpt-image", "OpenAI · GPT Image API", "image", (
        MediaModel("gpt-image-2", "GPT Image 2", ("reference",), 16, "OpenAI image edits contract"),
        MediaModel("gpt-image-1.5", "GPT Image 1.5", ("reference",), 16, "OpenAI image edits contract"),
        MediaModel("gpt-image-1", "GPT Image 1", ("reference",), 16, "OpenAI image edits contract"),
        MediaModel("gpt-image-1-mini", "GPT Image 1 Mini", ("reference",), 16, "OpenAI image edits contract"),
    )),
    MediaProviderModels("openai-gpt-image-oauth", "OpenAI · GPT Image OAuth", "image", (
        MediaModel("gpt-image-2", "GPT Image 2", ("reference",), 16, "OpenAI image edits contract"),
    )),
    MediaProviderModels("xai-imagine-api", "xAI · Imagine API", "image", (
        MediaModel("grok-imagine-image", "Grok Imagine Image", ("reference",), 1),
        MediaModel("grok-imagine-image-quality", "Grok Imagine Image Quality", ("reference",), 1),
    )),
    MediaProviderModels("xai-imagine-oauth", "xAI · Imagine OAuth", "image", (
        MediaModel("grok-imagine-image", "Grok Imagine Image", ("reference",), 1),
        MediaModel("grok-imagine-image-quality", "Grok Imagine Image Quality", ("reference",), 1),
    )),
    MediaProviderModels("higgsfield-consumer", "Higgsfield", "image", (
        MediaModel("gpt_image_2", "GPT Image 2", ("reference",), None, "live Higgsfield model schema"),
        MediaModel("nano_banana_2", "Nano Banana 2", ("reference",), None, "live Higgsfield model schema"),
        MediaModel("nano_banana_pro", "Nano Banana Pro", ("reference",), None, "live Higgsfield model schema"),
        MediaModel("text2image_soul_v2", "Soul 2.0"),
        MediaModel("soul_cinematic", "Soul Cinema"),
        MediaModel("recraft_v4_1", "Recraft V4.1"),
        MediaModel("z_image", "Z Image"),
    )),
    MediaProviderModels("higgsfield-cloud", "Higgsfield Cloud", "image", (
        MediaModel("higgsfield-ai/soul/standard", "Soul Standard"),
        MediaModel("reve/text-to-image", "Reve"),
    )),
    MediaProviderModels("muapi", "MUAPI", "image", _muapi_models(
        ("gpt-image-1.5", ("reference",)),
        ("flux-2-pro", ("reference",)),
        ("google-imagen4", ("reference",)),
        ("nano-banana-pro-edit", ("reference",)),
    )),
    MediaProviderModels("hivemindos-hosted-media", "HivemindOS hosted", "image", (
        MediaModel("automatic", "Automatic hosted model", ("reference",), None, "hosted catalog schema"),
    )),
    MediaProviderModels("xai-imagine-api", "xAI · Imagine API", "video", (
        MediaModel("grok-imagine-video", "Grok Imagine Video", ("start",), 1),
    )),
    MediaProviderModels("xai-imagine-oauth", "xAI · Imagine OAuth", "video", (
        MediaModel("grok-imagine-video", "Grok Imagine Video", ("start",), 1),
    )),
    MediaProviderModels("media-studio-mcp", "HivemindOS · Media Studio MCP", "video", BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS),
    MediaProviderModels("comfyui", "ComfyUI", "video", (
        MediaModel("workflow-default", "Workflow default", ("start", "end", "reference"), None, "selected workflow schema"),
    )),
    MediaProviderModels("higgsfield-consumer", "Higgsfield", "video", (
        MediaModel("seedance_2_0", "Seedance 2.0", ("start", "end", "reference"), None, "live Higgsfield model schema"),
        MediaModel("kling3_0", "Kling 3.0", ("start", "end"), 2),
        MediaModel("kling3_0_turbo", "Kling 3.0 Turbo", ("start", "end"), 2),
        MediaModel("grok_video_v15", "Grok Video 1.5", ("start",), 1),
        MediaModel("veo3_1", "Veo 3.1", ("start",), 1),
        MediaModel("marketing_studio_video", "Marketing Studio", ("start", "end", "reference"), None, "live Higgsfield model schema"),
    )),
    MediaProviderModels("higgsfield-cloud", "Higgsfield Cloud", "video", (
        MediaModel("higgsfield-ai/dop/standard", "DoP Standard", ("start",), 1),
        MediaModel("bytedance/seedance/v1/pro/image-to-video", "Seedance Pro", ("start",), 1),
        MediaModel("kling-video/v2.1/pro/image-to-video", "Kling 2.1 Pro", ("start",), 1),
    )),
    MediaProviderModels("muapi", "MUAPI", "video", _muapi_models(
        ("seedance-v2.0-t2v", ("start", "end", "reference")),
        ("seedance-pro-i2v", ("start", "reference")),
        ("kling-v3.0-pro-text-to-video", ("start", "end")),
        ("veo3.1-image-to-video", ("start", "reference")),
        ("vidu-q2-reference", ("reference",)),
    )),
    MediaProviderModels("hivemindos-hosted-media", "HivemindOS hosted", "video", (
        MediaModel("automatic", "Automatic hosted model", ("start", "end", "reference"), None, "hosted catalog schema"),
    )),
)


# The last workflow registry that actually answered. A capability list is not
# something the catalog may approximate: BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS
# knows nothing of reference mode, end frames or motion context, so handing it
# out in place of a live read silently strips the References and Frames controls
# out of the studio — the same MiniMax H3 model, rendered with its pre-reference
# toolbar. The reachability probe that gates the read is a 3s initialize POST
# while the read itself gets 30s, so a gateway that is merely busy (mid-
# generation) or still starting fails the probe and passes the read. Remembering
# the last live answer means a transient miss can never downgrade the UI.
_last_live_media_studio_models: tuple[MediaModel, ...] = ()


# MiniMax H3's measured packed-row budget and frame lattice, mirrored from the
# workflow registry (minimax-h3.motion_reference_budget / frame_grid). The unit
# is rows of the whole DiT sequence — see motion_reference_duration_limits.
# Duplicated ON PURPOSE: the built-in list is what the studio gets when the
# registry cannot be read, and a fallback that dropped this ceiling would
# silently put back the 15s range the card cannot render — the exact shape of
# the last degradation bug, where the fallback list quietly stripped H3
# reference mode. test_media_studio_mcp_contract pins these equal to the
# registry, so the two cannot drift apart unnoticed.
# 76,000 since 2026-08-23: the previous 85,000 was interpolated between a
# 76,600-row run that worked and a 95,092-row run that thrashed and died, and a
# job at ~80,400 counted rows then OOM'd inside that gap. A budget is the
# largest run PROVEN clean on the card, never a midpoint.
_H3_MOTION_REFERENCE_PACKED_ROWS = 76_000
# The same budget per card ("32": the 5090 the base number was measured on,
# "96": the RTX PRO 6000 Blackwell). Pinned equal to the registry's
# max_packed_rows_by_vram_gb by the same contract test.
# 96GB is 161,000 for the same reason: the only thing proven on a PRO 6000 is
# that the ~161k-row job ran (134s a step, job 185f117f). 240,000 was another
# interpolation and would have reproduced the 32GB failure on the bigger card.
_H3_MOTION_REFERENCE_PACKED_ROWS_BY_VRAM_GB = {"32": 76_000, "96": 161_000}
_H3_FRAME_GRID = {"modulus": 17, "offset": 5}
_H3_FRAME_RATE = 24


@lru_cache(maxsize=1)
def _built_in_video_models_with_limits() -> tuple[MediaModel, ...]:
    """The built-in list with the measured capacity limits filled in.

    A degraded catalog still has to refuse a length the card cannot render.
    """
    from .media_studio import motion_reference_duration_limits, motion_reference_pricing

    built_in = {
        "motion_reference_max_packed_rows": _H3_MOTION_REFERENCE_PACKED_ROWS,
        "motion_reference_max_packed_rows_by_vram_gb": dict(_H3_MOTION_REFERENCE_PACKED_ROWS_BY_VRAM_GB),
        "frame_grid": _H3_FRAME_GRID,
        "defaults": {"frame_rate": _H3_FRAME_RATE},
    }
    limits = motion_reference_duration_limits(built_in)
    pricing = motion_reference_pricing(built_in) or None
    if not limits:
        return BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS
    return tuple(
        replace(model, motion_reference_max_seconds=limits, motion_reference_pricing=pricing)
        if model.family == "minimax" else model
        for model in BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS
    )


def _media_studio_fallback_models() -> tuple[MediaModel, ...]:
    return _last_live_media_studio_models or _built_in_video_models_with_limits()


def _media_studio_registry(status: dict | None = None) -> tuple[tuple[MediaModel, ...], bool]:
    """The Media Studio video workflows, and whether they were read LIVE.

    `live` is False whenever the registry could not be reached this time round.
    The models are then the last live read, or the built-in list if there has
    never been one; callers surface the flag so the studio can retry rather than
    render a model with the wrong capabilities and stay that way.
    """
    global _last_live_media_studio_models
    models = {model.id: model for model in BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS}
    if status is not None and not status.get("available"):
        # Skipping the read keeps the catalog responsive when the endpoint is
        # genuinely down (list_media_studio_workflows would wait out its own
        # 30s); the remembered registry above keeps the answer honest.
        return _media_studio_fallback_models(), False
    try:
        from .media_studio import list_media_studio_workflows, motion_reference_duration_limits, motion_reference_pricing

        workflows = list_media_studio_workflows("video")
    except Exception:
        return _media_studio_fallback_models(), False
    if not workflows:
        return _media_studio_fallback_models(), False
    for workflow in workflows:
        workflow_id = str(workflow.get("id") or "").strip()
        if not workflow_id:
            continue
        label = str(workflow.get("title") or workflow_id).strip()
        defaults = workflow.get("defaults") if isinstance(workflow.get("defaults"), dict) else {}
        models[workflow_id] = MediaModel(
            id=workflow_id,
            label=label,
            reference_roles=("start", "reference"),
            max_reference_images=None,
            limit_source="live Media Studio MCP workflow registry",
            accepts=tuple(str(value) for value in workflow.get("accepts", []) if str(value).strip()),
            family=str(workflow.get("family") or "").strip(),
            supports_loras=bool(workflow.get("supports_loras")),
            compatible_base_models=tuple(str(value) for value in workflow.get("compatible_base_models", []) if str(value).strip()),
            ingredient_inputs=dict(workflow.get("ingredient_inputs")) if isinstance(workflow.get("ingredient_inputs"), dict) else None,
            reference_slots=dict(workflow.get("reference_slots")) if isinstance(workflow.get("reference_slots"), dict) else None,
            aspect_ratios=tuple(str(value) for value in workflow.get("aspect_ratios", []) if str(value).strip()),
            default_duration_seconds=float(defaults["duration_seconds"]) if defaults.get("duration_seconds") is not None else None,
            motion_reference_max_seconds=motion_reference_duration_limits(workflow) or None,
            motion_reference_pricing=motion_reference_pricing(workflow) or None,
            default_steps=float(defaults["steps"]) if defaults.get("steps") is not None else None,
            beta=bool(workflow.get("beta")),
            routing_only=bool(workflow.get("routing_only")),
        )
    _last_live_media_studio_models = tuple(models.values())
    return _last_live_media_studio_models, True


def _media_studio_video_models(status: dict | None = None) -> tuple[MediaModel, ...]:
    return _media_studio_registry(status)[0]


def media_catalog() -> dict[str, list[dict]]:
    readiness = {row["id"]: row for row in provider_report()}
    result: dict[str, list[dict]] = {"image": [], "video": []}
    for provider in MEDIA_MODEL_MATRIX:
        status = readiness.get(provider.id, {})
        if provider.id == "media-studio-mcp" and provider.kind == "video":
            models, registry_live = _media_studio_registry(status)
        else:
            models, registry_live = provider.models, True
        result[provider.kind].append({
            "id": provider.id,
            "label": provider.label,
            "available": bool(status.get("available")),
            "detail": str(status.get("detail") or ""),
            # What the row is waiting for, in the provider report's own words,
            # and the credential names behind it. The studio prints the sentence
            # on the row and puts an "Add key" beside it, so a greyed model says
            # which key it needs rather than nothing at all.
            "needs": str(status.get("needs") or ""),
            "keys": list(status.get("keys") or []),
            # False when this row's model list could not be read live. Distinct
            # from `available`: the provider can be down while the list is still
            # the real one (remembered), and a list can be a stale guess while
            # the probe passes. Only the flag tells a client its capability
            # fields are trustworthy.
            "registry_live": registry_live,
            "models": [{
                **asdict(model),
                "reference_roles": list(model.reference_roles),
                "accepts": list(model.accepts),
                "compatible_base_models": list(model.compatible_base_models),
                "aspect_ratios": list(model.aspect_ratios),
            } for model in models],
        })
    return result


def reference_limit(provider_id: str, model_id: str) -> int | None:
    if not provider_id or provider_id == "automatic" or not model_id or model_id == "automatic":
        return 30
    for provider in MEDIA_MODEL_MATRIX:
        if provider.id != provider_id:
            continue
        models = _media_studio_video_models() if provider.id == "media-studio-mcp" and provider.kind == "video" else provider.models
        model = next((item for item in models if item.id == model_id), None)
        if model:
            return model.max_reference_images
    raise ValueError("The selected media provider/model is not in the studio capability catalog")
