from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.stickman import render_stickman_frames


def test_stickman_renderer_creates_mobile_frames_and_records_them(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: stickman-render
lane: stickman-performance-ad
title: Stickman test
aspect_ratio: 9:16
scenes:
  - title: Hook
    beat: A stick figure points at a falling chart.
    overlay: Stop paying for ignored ads
  - title: Payoff
    beat: The stick figure points at the product.
    overlay: Make the idea impossible to miss
""",
        encoding="utf-8",
    )
    manifest_path = plan(brief)

    result = render_stickman_frames(manifest_path)

    assert len(result["frames"]) == 2
    with Image.open(result["frames"][0]) as image:
        assert image.size == (1080, 1920)
    manifest = load_manifest(manifest_path)
    assert len([item for item in manifest["artifacts"] if item["role"] == "keyframe"]) == 2


def test_stickman_scene_contract_is_plain_json(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: one\nlane: stickman-performance-ad\nscenes:\n  - beat: One clear idea.\n", encoding="utf-8")

    manifest_path = plan(brief)
    scenes_path = next(Path(item["path"]) for item in load_manifest(manifest_path)["artifacts"] if item["role"] == "stickman-scenes")

    assert json.loads(scenes_path.read_text(encoding="utf-8"))[0]["beat"] == "One clear idea."
