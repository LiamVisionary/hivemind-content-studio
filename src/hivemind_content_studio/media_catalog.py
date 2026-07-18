"""Typed media model inventory shared by the simple studio and agent routes."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

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


@dataclass(frozen=True)
class MediaProviderModels:
    id: str
    label: str
    kind: MediaKind
    models: tuple[MediaModel, ...]


BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS: tuple[MediaModel, ...] = (
    MediaModel("workflow-default", "Workflow default", ("start", "reference"), None, "selected MCP workflow schema", ("image_base64", "video_base64", "video_mode")),
    MediaModel("ltx23-eros-fast", "LTX 2.3 Eros Fast", ("start", "reference"), None, "Media Studio MCP workflow registry", ("image_base64", "video_base64", "video_mode")),
    MediaModel("ltx23-eros-exact", "LTX 2.3 Eros Exact", ("start", "reference"), None, "Media Studio MCP workflow registry", ("image_base64", "video_base64", "video_mode")),
    MediaModel("ltx23-regular-fp8", "LTX 2.3 Regular FP8", ("start", "reference"), None, "Media Studio MCP workflow registry", ("image_base64", "video_base64", "video_mode")),
)


MEDIA_MODEL_MATRIX: tuple[MediaProviderModels, ...] = (
    MediaProviderModels("stickman-renderer", "Stickman renderer", "image", (MediaModel("automatic", "Automatic"),)),
    MediaProviderModels("static-text-renderer", "Static text renderer", "image", (MediaModel("automatic", "Automatic"),)),
    MediaProviderModels("comfyui", "ComfyUI", "image", (MediaModel("workflow-default", "Workflow default", ("reference",), None, "selected workflow schema"),)),
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
    MediaProviderModels("muapi", "MUAPI", "image", (
        MediaModel("gpt-image-1.5", "GPT Image 1.5", ("reference",), None, "live MUAPI endpoint schema"),
        MediaModel("flux-2-pro", "Flux 2 Pro", ("reference",), None, "live MUAPI endpoint schema"),
        MediaModel("google-imagen4", "Google Imagen 4", ("reference",), None, "live MUAPI endpoint schema"),
        MediaModel("nano-banana-pro-edit", "Nano Banana Pro Edit", ("reference",), None, "live MUAPI endpoint schema"),
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
    MediaProviderModels("muapi", "MUAPI", "video", (
        MediaModel("seedance-v2.0-t2v", "Seedance 2.0", ("start", "end", "reference"), None, "live MUAPI endpoint schema"),
        MediaModel("seedance-pro-i2v", "Seedance Pro I2V", ("start", "reference"), None, "live MUAPI endpoint schema"),
        MediaModel("kling-v3.0-pro-text-to-video", "Kling 3.0 Pro", ("start", "end"), None, "live MUAPI endpoint schema"),
        MediaModel("veo3.1-image-to-video", "Veo 3.1", ("start", "reference"), None, "live MUAPI endpoint schema"),
        MediaModel("vidu-q2-reference", "Vidu Q2 Reference", ("reference",), None, "live MUAPI endpoint schema"),
    )),
    MediaProviderModels("hivemindos-hosted-media", "HivemindOS hosted", "video", (
        MediaModel("automatic", "Automatic hosted model", ("start", "end", "reference"), None, "hosted catalog schema"),
    )),
)


def _media_studio_video_models(status: dict | None = None) -> tuple[MediaModel, ...]:
    models = {model.id: model for model in BUILT_IN_MEDIA_STUDIO_VIDEO_MODELS}
    if status is not None and not status.get("available"):
        return tuple(models.values())
    try:
        from .media_studio import list_media_studio_workflows

        workflows = list_media_studio_workflows("video")
    except Exception:
        return tuple(models.values())
    for workflow in workflows:
        workflow_id = str(workflow.get("id") or "").strip()
        if not workflow_id:
            continue
        label = str(workflow.get("title") or workflow_id).strip()
        models[workflow_id] = MediaModel(
            workflow_id,
            label,
            ("start", "reference"),
            None,
            "live Media Studio MCP workflow registry",
            tuple(str(value) for value in workflow.get("accepts", []) if str(value).strip()),
        )
    return tuple(models.values())


def media_catalog() -> dict[str, list[dict]]:
    readiness = {row["id"]: row for row in provider_report()}
    result: dict[str, list[dict]] = {"image": [], "video": []}
    for provider in MEDIA_MODEL_MATRIX:
        status = readiness.get(provider.id, {})
        models = _media_studio_video_models(status) if provider.id == "media-studio-mcp" and provider.kind == "video" else provider.models
        result[provider.kind].append({
            "id": provider.id,
            "label": provider.label,
            "available": bool(status.get("available")),
            "detail": str(status.get("detail") or ""),
            "models": [{**asdict(model), "reference_roles": list(model.reference_roles), "accepts": list(model.accepts)} for model in models],
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
