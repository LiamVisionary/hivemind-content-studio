from __future__ import annotations

import json
from pathlib import Path

import pytest

from hivemind_content_studio.evaluation import record_semantic_evaluation, semantic_preflight
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan


def test_semantic_evaluation_records_scene_failures_and_regeneration_instructions(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: eval\nlane: stickman-performance-ad\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    manifest_path = plan(brief)

    result = record_semantic_evaluation(
        manifest_path,
        evaluator="vision-agent",
        passed=False,
        score=62,
        checks={"hook_alignment": 80, "text_legibility": 40},
        scene_failures=[{"scene": 1, "check": "text_legibility", "evidence": "Overlay is too dense"}],
        regeneration_instructions=[{"scene": 1, "instruction": "Reduce the overlay to six words"}],
    )

    assert result["passed"] is False
    artifact = next(item for item in load_manifest(manifest_path)["artifacts"] if item["role"] == "semantic-evaluation")
    payload = json.loads(Path(artifact["path"]).read_text(encoding="utf-8"))
    assert payload["regeneration_instructions"][0]["scene"] == 1


def test_evaluation_rejects_unbounded_scores_and_non_scene_specific_failures(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: invalid-eval\nlane: animation\nscenes: []\n", encoding="utf-8")
    manifest_path = plan(brief)

    with pytest.raises(ValueError, match="0 and 100"):
        record_semantic_evaluation(manifest_path, evaluator="agent", passed=False, score=101, checks={}, scene_failures=[], regeneration_instructions=[])
    with pytest.raises(ValueError, match="scene"):
        record_semantic_evaluation(manifest_path, evaluator="agent", passed=False, score=50, checks={}, scene_failures=[{"check": "pacing"}], regeneration_instructions=[])


def test_semantic_preflight_flags_claims_and_overlong_mobile_overlays(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        """id: preflight
lane: static-text-ad
scenes:
  - beat: Guaranteed to make you rich overnight
    overlay: This is an extremely long mobile overlay that is much too dense to understand in one glance
""",
        encoding="utf-8",
    )
    manifest_path = plan(brief)

    result = semantic_preflight(manifest_path)

    assert result["passed"] is False
    assert {failure["check"] for failure in result["scene_failures"]} == {"claim_grounding", "text_legibility"}
