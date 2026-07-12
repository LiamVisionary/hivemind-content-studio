from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio.manifest import approve_manifest, load_manifest
from hivemind_content_studio.planner import plan


def test_animation_plan_uses_one_provider_neutral_artifact_set(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: test-animation
lane: animation
title: Test animation
scenes:
  - title: Hook
    beat: A bright paper bird crosses a dark sky.
    duration_seconds: 4
publish:
  platforms: [youtube, tiktok]
""",
        encoding="utf-8",
    )

    manifest_path = plan(brief)
    manifest = load_manifest(manifest_path)
    roles = [artifact["role"] for artifact in manifest["artifacts"]]

    assert manifest["lane"] == "animation"
    assert manifest["approval"]["status"] == "pending"
    assert roles == [
        "brief",
        "scene-manifest",
        "image-prompts",
        "motion-prompts",
        "voice-lines",
        "music-brief",
        "publish-metadata",
    ]
    assert not list(manifest_path.parent.glob("*midjourney*"))
    assert not list(manifest_path.parent.glob("*runway*"))


def test_faceless_plan_and_approval(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: short-1\nlane: faceless\nsubject: Three practical AI tools\n", encoding="utf-8")

    manifest_path = plan(brief)
    manifest = load_manifest(manifest_path)
    params_path = Path(next(item["path"] for item in manifest["artifacts"] if item["role"] == "faceless-params"))
    params = json.loads(params_path.read_text(encoding="utf-8"))
    assert params["video_subject"] == "Three practical AI tools"
    assert params["video_aspect"] == "9:16"

    approved = approve_manifest(manifest_path, reviewer="owner", rights_note="Original script and licensed media.")
    assert approved["approval"]["status"] == "approved"
    assert approved["approval"]["reviewer"] == "owner"


def test_first_frame_animation_ad_plan_is_an_agent_neutral_production_contract(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "first-frame.yaml"
    brief.write_text(
        """id: first-frame-ad
lane: first-frame-animation-ad
title: Product animation ad
audience: busy founders
goal: demonstrate the product in 15 seconds
aspect_ratio: 9:16
scenes:
  - title: Hook
    beat: A founder stares at ten unfinished content tabs.
    duration_seconds: 3
  - title: Payoff
    beat: One studio turns the tabs into a finished campaign.
    duration_seconds: 4
""",
        encoding="utf-8",
    )

    manifest_path = plan(brief)
    manifest = load_manifest(manifest_path)
    roles = {artifact["role"] for artifact in manifest["artifacts"]}

    assert manifest["lane"] == "first-frame-animation-ad"
    assert manifest["providers"]["script"] == "agent-runtime"
    assert {
        "script-request",
        "scene-manifest",
        "keyframe-requests",
        "motion-requests",
        "voice-lines",
        "editor-handoff",
    } <= roles


def test_stickman_ad_plan_uses_deterministic_vectors_as_the_default_visual_provider(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "stickman.yaml"
    brief.write_text(
        """id: stickman-ad
lane: stickman-performance-ad
title: Cheap creative does not mean weak creative
scenes:
  - title: Hook
    beat: A stick figure watches an expensive ad lose attention.
    voice: The most expensive-looking ad is not always the winner.
    duration_seconds: 3
""",
        encoding="utf-8",
    )

    manifest = load_manifest(plan(brief))
    roles = {artifact["role"] for artifact in manifest["artifacts"]}

    assert manifest["providers"]["image"] == "stickman-renderer"
    assert "stickman-scenes" in roles
    assert "keyframe-requests" not in roles
