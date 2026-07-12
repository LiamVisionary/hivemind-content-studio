from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
from PIL import Image

from hivemind_content_studio.asset_store import AssetPolicy, AssetStore
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "purple").save(buffer, format="PNG")
    return buffer.getvalue()


def test_remote_agents_can_ingest_bounded_base64_assets_into_the_run(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: assets\nlane: animation\nscenes: []\n", encoding="utf-8")
    manifest_path = plan(brief)
    store = AssetStore(AssetPolicy(allowed_roots=(tmp_path,), max_bytes=1024 * 1024))

    artifact = store.ingest_base64(manifest_path, file_name="reference.png", encoded=base64.b64encode(_png()).decode(), role="reference-image")

    assert Path(artifact["path"]).parent == manifest_path.parent / "assets"
    assert artifact["sha256"]
    assert artifact["mime_type"] == "image/png"
    assert load_manifest(manifest_path)["artifacts"][-1]["id"] == artifact["id"]


def test_asset_ingestion_rejects_path_escape_private_urls_and_oversize_data(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: guarded\nlane: animation\nscenes: []\n", encoding="utf-8")
    manifest_path = plan(brief)
    store = AssetStore(AssetPolicy(allowed_roots=(manifest_path.parent,), max_bytes=16))
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")

    with pytest.raises(ValueError, match="allowed roots"):
        store.ingest_local(manifest_path, outside, role="reference")
    with pytest.raises(ValueError, match="public HTTPS"):
        store.ingest_url(manifest_path, "http://127.0.0.1:9999/secret", role="reference")
    with pytest.raises(ValueError, match="maximum size"):
        store.ingest_base64(manifest_path, file_name="large.png", encoded=base64.b64encode(b"x" * 32).decode(), role="reference")
