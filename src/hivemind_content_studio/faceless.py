"""Adapter from the canonical manifest to the MoneyPrinterTurbo engine."""

from __future__ import annotations

from pathlib import Path

from app.models.schema import VideoParams
from app.services import task

from .faceless_media import generate_faceless_materials, is_studio_media_source
from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, read_private_json


def render_faceless(manifest_path: str | Path) -> dict:
    path = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(path)
    if manifest.get("lane") != "faceless":
        raise ValueError("Manifest lane must be faceless")
    params_path = _artifact_path(manifest, "faceless-params")
    params = VideoParams(**read_private_json(params_path))

    # A generated source renders its own visuals first, then hands them to the
    # engine as owned local material. Everything else (stock search, a folder of
    # owned files) reaches the engine exactly as upstream expects.
    brief = manifest.get("brief") if isinstance(manifest.get("brief"), dict) else {}
    if is_studio_media_source(brief.get("media_source")):
        params.video_source = "local"
        params.video_materials = generate_faceless_materials(path)

    result = task.start(manifest["run_id"], params, stop_at="video")
    if not isinstance(result, dict) or not result.get("videos"):
        raise RuntimeError("MoneyPrinterTurbo did not return final video paths")
    for video in result["videos"]:
        video_path = Path(video).expanduser().resolve()
        add_artifact(manifest, role="final-video", path=video_path, provider="moneyprinterturbo")
        if video_path.is_relative_to(path.parent):
            encrypt_private_media(video_path)
    manifest["status"] = "rendered"
    write_manifest(path, manifest)
    return result


def _artifact_path(manifest: dict, role: str) -> Path:
    for artifact in manifest.get("artifacts", []):
        if artifact.get("role") == role:
            return Path(artifact["path"])
    raise ValueError(f"Manifest is missing {role} artifact")
