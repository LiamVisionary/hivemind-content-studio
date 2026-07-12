"""Adapter from the canonical manifest to the MoneyPrinterTurbo engine."""

from __future__ import annotations

import json
from pathlib import Path

from app.models.schema import VideoParams
from app.services import task

from .manifest import add_artifact, load_manifest, write_manifest


def render_faceless(manifest_path: str | Path) -> dict:
    path = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(path)
    if manifest.get("lane") != "faceless":
        raise ValueError("Manifest lane must be faceless")
    params_path = _artifact_path(manifest, "faceless-params")
    params = VideoParams(**json.loads(params_path.read_text(encoding="utf-8")))
    result = task.start(manifest["run_id"], params, stop_at="video")
    if not isinstance(result, dict) or not result.get("videos"):
        raise RuntimeError("MoneyPrinterTurbo did not return final video paths")
    for video in result["videos"]:
        add_artifact(manifest, role="final-video", path=Path(video), provider="moneyprinterturbo")
    manifest["status"] = "rendered"
    write_manifest(path, manifest)
    return result


def _artifact_path(manifest: dict, role: str) -> Path:
    for artifact in manifest.get("artifacts", []):
        if artifact.get("role") == role:
            return Path(artifact["path"])
    raise ValueError(f"Manifest is missing {role} artifact")
