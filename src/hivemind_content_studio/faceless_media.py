"""Generated visuals for the faceless lane.

The faceless engine assembles a narrated short out of *material clips*. Upstream
only knows how to find those by searching stock libraries (Pexels, Pixabay,
Coverr) or by reading a folder of owned files. This module adds the third
option the studio already has everywhere else: render the visuals with our own
connected models.

It deliberately reuses the existing production machinery instead of introducing
a second one. Beats become the same ``keyframe-requests`` / ``motion-requests``
contract the animation lane writes, and they execute through
:class:`~hivemind_content_studio.provider_execution.ProviderExecutors`, so every
route the studios expose — local ComfyUI, a fleet machine, an attached rental,
a cloud API, an OAuth account — works here with no per-provider code.

The handoff back to the engine is the narrow part: rendered assets are staged
into ``storage/local_videos`` (the only directory ``video.preprocess_video``
will resolve, by design) and returned as ``MaterialInfo`` rows for
``video_source="local"``. Nothing upstream is modified.
"""

from __future__ import annotations

import math
import re
import shutil
from pathlib import Path
from typing import Any

from app.models.schema import MaterialInfo
from app.utils import utils

from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import private_media_exists, read_private_media, write_private_json
from .provider_execution import ProviderExecutors

# Media sources that mean "render this ourselves" rather than "go find footage".
STUDIO_IMAGE_SOURCE = "studio-image"
STUDIO_VIDEO_SOURCE = "studio-video"
STUDIO_MEDIA_SOURCES = (STUDIO_IMAGE_SOURCE, STUDIO_VIDEO_SOURCE)

# preprocess_video resolves materials against const.FILE_TYPE_IMAGES, which does
# not list webp. A generated webp would be read as a video and skipped, so it is
# transcoded on the way in rather than silently dropped.
_ENGINE_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp"}
_ENGINE_VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm"}

# A short is a handful of beats. The cap keeps a careless runtime/cadence pair
# (600s at 1s cadence) from queueing hundreds of paid generations.
_MAX_VISUALS = 24


def is_studio_media_source(value: str | None) -> bool:
    return str(value or "").strip().lower() in STUDIO_MEDIA_SOURCES


def visual_kind(media_source: str | None) -> str:
    """'keyframe' for generated stills, 'motion' for generated clips."""
    return "motion" if str(media_source or "").strip().lower() == STUDIO_VIDEO_SOURCE else "keyframe"


def plan_visual_beats(brief: dict[str, Any]) -> list[dict[str, Any]]:
    """One prompt per visual the short needs, in order.

    Preference order is explicit scenes, then the planner's search terms, then
    the narration split into sentences. The script is the best fallback because
    a beat cut from the narration stays in sync with what is being said over it.
    """
    runtime = _positive_float(brief.get("runtime_seconds"), 30.0)
    cadence = _positive_float(brief.get("clip_duration_seconds"), 5.0)
    wanted = max(1, min(_MAX_VISUALS, math.ceil(runtime / cadence)))

    scenes = brief.get("scenes")
    if isinstance(scenes, list) and scenes:
        prompts = [
            str(scene.get("image_prompt") or scene.get("beat") or scene.get("title") or "").strip()
            for scene in scenes
            if isinstance(scene, dict)
        ]
        prompts = [item for item in prompts if item]
        if prompts:
            return _as_beats(prompts, cadence)

    terms = brief.get("search_terms")
    if isinstance(terms, list) and terms:
        prompts = [str(term).strip() for term in terms if str(term).strip()]
        if prompts:
            return _as_beats(_fit(prompts, wanted), cadence)

    sentences = _sentences(str(brief.get("script") or ""))
    if sentences:
        return _as_beats(_fit(sentences, wanted), cadence)

    subject = str(brief.get("subject") or brief.get("title") or brief.get("goal") or "").strip()
    if not subject:
        raise ValueError("A generated faceless short needs a subject, script, scenes, or search terms to render from")
    return _as_beats([subject] * wanted, cadence)


def generate_faceless_materials(
    manifest_path: str | Path,
    *,
    executors: ProviderExecutors | None = None,
) -> list[MaterialInfo]:
    """Render every beat through the brief's chosen route and stage the results.

    Returns the ``video_materials`` rows the engine consumes. Assets already
    recorded on the manifest are reused, so a resumed run does not pay to
    regenerate what it already has.
    """
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    brief = manifest.get("brief") if isinstance(manifest.get("brief"), dict) else {}
    media_source = str(brief.get("media_source") or "").strip().lower()
    if not is_studio_media_source(media_source):
        raise ValueError(f"media_source {media_source!r} is not a generated studio source")

    kind = visual_kind(media_source)
    request_role = "keyframe-requests" if kind == "keyframe" else "motion-requests"
    output_role = "keyframe" if kind == "keyframe" else "scene-video"
    provider = selected_provider(brief)

    beats = plan_visual_beats(brief)
    _ensure_requests(manifest_file, manifest, beats, brief=brief, request_role=request_role)

    runner = executors or ProviderExecutors()
    if kind == "keyframe":
        runner.generate_keyframes(manifest_file, provider)
    else:
        runner.animate_scenes(manifest_file, provider)

    rendered = _rendered_assets(load_manifest(manifest_file), output_role)
    if not rendered:
        raise RuntimeError(f"The {provider} route produced no {output_role} assets for this run")

    staging = Path(utils.storage_dir("local_videos", create=True)) / _run_slug(manifest, manifest_file)
    staging.mkdir(parents=True, exist_ok=True)
    materials: list[MaterialInfo] = []
    for index, source in enumerate(rendered, start=1):
        staged = _stage_for_engine(source, staging, index=index, kind=kind)
        if staged is None:
            continue
        materials.append(
            MaterialInfo(
                provider=f"hivemind-{provider}",
                url=str(staged),
                duration=int(_positive_float(brief.get("clip_duration_seconds"), 5.0)),
            )
        )
    if not materials:
        raise RuntimeError("No generated asset survived staging into the engine's material directory")
    return materials


def selected_provider(brief: dict[str, Any]) -> str:
    """The route the operator picked, falling back to the local studio lane.

    'comfyui' is the catalog's name for whatever the Media Studio registry
    currently fronts — local ComfyUI, a fleet machine, or an attached rental —
    so it is the right default for a run that did not name a provider.
    """
    route = brief.get("media_route") if isinstance(brief.get("media_route"), dict) else {}
    provider = str(route.get("provider") or "").strip()
    return provider if provider and provider != "automatic" else "comfyui"


def _ensure_requests(
    manifest_file: Path,
    manifest: dict[str, Any],
    beats: list[dict[str, Any]],
    *,
    brief: dict[str, Any],
    request_role: str,
) -> None:
    """Write the scene-request contract the executors read, once per run."""
    existing = next((item for item in manifest["artifacts"] if item.get("role") == request_role), None)
    if existing and private_media_exists(Path(str(existing.get("path") or ""))):
        return
    aspect_ratio = str(brief.get("aspect_ratio") or "9:16").strip() or "9:16"
    payload = [
        {
            "scene": beat["scene"],
            "prompt": beat["prompt"],
            "aspect_ratio": aspect_ratio,
            "duration_seconds": beat["duration_seconds"],
        }
        for beat in beats
    ]
    path = manifest_file.parent / f"{request_role}.json"
    write_private_json(path, payload)
    add_artifact(manifest, role=request_role, path=path, provider="content-studio")
    write_manifest(manifest_file, manifest)


def _rendered_assets(manifest: dict[str, Any], output_role: str) -> list[Path]:
    rows = [
        item
        for item in manifest.get("artifacts", [])
        if item.get("role") == output_role and item.get("path")
    ]
    rows.sort(key=lambda item: int(item.get("scene") or 0))
    return [Path(str(item["path"])) for item in rows]


def _stage_for_engine(source: Path, staging: Path, *, index: int, kind: str) -> Path | None:
    """Copy one rendered asset into the engine's material directory.

    Run artifacts are encrypted at rest, so this reads through the private-media
    layer rather than assuming a plaintext file on disk.
    """
    suffix = source.suffix.lower()
    allowed = _ENGINE_IMAGE_SUFFIXES if kind == "keyframe" else _ENGINE_VIDEO_SUFFIXES
    if suffix not in allowed:
        # .webp stills and other unlisted containers would be misread by the
        # engine's extension check; normalise the common one and skip the rest.
        if kind == "keyframe" and suffix == ".webp":
            converted = _convert_to_png(source, staging / f"{index:03d}.png")
            return converted
        return None

    destination = staging / f"{index:03d}{suffix}"
    if source.is_file():
        shutil.copy2(source, destination)
        return destination
    if private_media_exists(source):
        destination.write_bytes(read_private_media(source))
        return destination
    return None


def _convert_to_png(source: Path, destination: Path) -> Path | None:
    try:
        from PIL import Image
    except ImportError:
        return None
    payload = source if source.is_file() else None
    if payload is None:
        if not private_media_exists(source):
            return None
        staged = destination.with_suffix(".staged.webp")
        staged.write_bytes(read_private_media(source))
        payload = staged
    try:
        with Image.open(payload) as handle:
            handle.convert("RGB").save(destination, format="PNG")
    except Exception:
        return None
    finally:
        if payload != source:
            payload.unlink(missing_ok=True)
    return destination


def _as_beats(prompts: list[str], cadence: float) -> list[dict[str, Any]]:
    return [
        {"scene": index, "prompt": prompt, "duration_seconds": round(cadence, 3)}
        for index, prompt in enumerate(prompts[:_MAX_VISUALS], start=1)
    ]


def _fit(values: list[str], wanted: int) -> list[str]:
    """Repeat or truncate to exactly `wanted` entries, preserving order."""
    if not values:
        return []
    if len(values) >= wanted:
        return values[:wanted]
    return [values[index % len(values)] for index in range(wanted)]


def _sentences(script: str) -> list[str]:
    parts = [part.strip() for part in re.split(r"(?<=[.!?。！？])\s+|\n+", script) if part.strip()]
    return [part for part in parts if len(part) > 1]


def _positive_float(value: Any, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def _run_slug(manifest: dict[str, Any], manifest_file: Path) -> str:
    raw = str(manifest.get("run_id") or manifest_file.parent.name)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-")
    return slug or "run"
