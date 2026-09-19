from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import read_private_media
from hivemind_content_studio.static_text import render_static_text_frames


def test_static_text_ad_is_a_first_class_deterministic_lane(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "static.yaml"
    brief.write_text(
        """id: static-ad
lane: static-text-ad
aspect_ratio: 4:5
palette:
  background: '#F4F0FF'
  foreground: '#17131F'
scenes:
  - title: Hook
    overlay: Your ad should make one point
    subtext: Not twelve.
""",
        encoding="utf-8",
    )
    manifest_path = plan(brief)
    result = render_static_text_frames(manifest_path)

    assert load_manifest(manifest_path)["providers"]["image"] == "static-text-renderer"
    frame = Path(result["frames"][0])
    assert not frame.is_file()  # keyframes are encrypted at rest
    with Image.open(io.BytesIO(read_private_media(frame))) as image:
        assert image.size == (1080, 1350)
    assert result["provider"] == "static-text-renderer"
