from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from hivemind_content_studio.config import load_config
from hivemind_content_studio.manifest import approve_manifest, create_manifest
from hivemind_content_studio.publishing import PublishError, build_postiz_payload, dry_run, execute_publish, prepare_publish


def _manifest(tmp_path: Path) -> Path:
    path, _ = create_manifest(lane="social-post", brief={"id": "publish-test"}, runs_dir=tmp_path / "runs", providers={"publish": "postiz"})
    return path


def test_prepare_and_dry_run_never_publish(tmp_path: Path, monkeypatch) -> None:
    manifest = _manifest(tmp_path)
    video = tmp_path / "final.mp4"
    video.write_bytes(b"not-a-real-video-for-unit-test")
    monkeypatch.setattr("hivemind_content_studio.publishing.qa_asset", lambda *_args, **_kwargs: {"kind": "video", "ok": True, "failures": [], "visual_inspection_required": True})
    draft = prepare_publish(manifest, video=video, title="Title", caption="Caption", platforms=["youtube", "tiktok"], provider="upload-post")
    result = dry_run(manifest)
    assert draft["status"] == "prepared"
    assert result["ok"] is True
    assert result["would_publish"] is False
    assert result["approval_status"] == "pending"


def test_live_publish_has_three_independent_gates(tmp_path: Path, monkeypatch) -> None:
    manifest = _manifest(tmp_path)
    video = tmp_path / "final.mp4"
    video.write_bytes(b"video")
    monkeypatch.setattr("hivemind_content_studio.publishing.qa_asset", lambda *_args, **_kwargs: {"kind": "video", "ok": True, "failures": [], "visual_inspection_required": True})
    prepare_publish(manifest, video=video, title="Title", caption="Caption", platforms=["youtube"], provider="upload-post")

    disabled = replace(load_config(), live_publish_enabled=False)
    with pytest.raises(PublishError, match="confirmation token"):
        execute_publish(manifest, confirm="", cfg=disabled)
    with pytest.raises(PublishError, match="disabled"):
        execute_publish(manifest, confirm="LIVE_PUBLISH", cfg=disabled)

    approve_manifest(manifest, reviewer="owner", rights_note="Owned content.")
    enabled_without_credentials = replace(load_config(), live_publish_enabled=True, upload_post_api_key=None, upload_post_username=None)
    with pytest.raises(PublishError, match="not configured"):
        execute_publish(manifest, confirm="LIVE_PUBLISH", cfg=enabled_without_credentials)


def test_postiz_payload_matches_current_nested_contract() -> None:
    payload = build_postiz_payload(
        platform="instagram",
        integration_id="integration-1",
        caption="Hello",
        media=[{"id": "media-1", "path": "https://cdn.example/video.mp4"}],
        scheduled_at="2026-07-11T12:00:00+00:00",
    )
    post = payload["posts"][0]
    assert post["integration"]["id"] == "integration-1"
    assert post["value"][0]["image"][0]["id"] == "media-1"
    assert post["settings"]["__type"] == "instagram"
