from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.experiments import ingest_performance_batch, recommend_next_variant, tag_creative
from hivemind_content_studio.manifest import create_manifest, load_manifest
from hivemind_content_studio.metrics import summarize_metrics


def test_metrics_ingestion_is_idempotent_and_retains_creative_features(tmp_path: Path) -> None:
    manifest_path, _ = create_manifest(lane="static-text-ad", brief={"id": "experiment"}, runs_dir=tmp_path / "runs", providers={})
    tag_creative(manifest_path, variant_id="v2", parent_run_id="run-parent", features={"hook_type": "contrarian", "first_frame": "plain-text", "cta": "compare"})
    entries = [{"external_id": "post-1", "platform": "instagram", "views": 1000, "completed_views": 500, "clicks": 30, "conversions": 3, "revenue": 90, "spend": 15, "retention": {"1": 0.82, "3": 0.61}}]

    ingest_performance_batch(manifest_path, entries)
    ingest_performance_batch(manifest_path, entries)
    summary = summarize_metrics(manifest_path)

    assert len(summary["entries"]) == 1
    assert summary["totals"]["roas"] == 6
    assert summary["totals"]["cost_per_conversion"] == 5
    assert load_manifest(manifest_path)["creative"]["features"]["hook_type"] == "contrarian"


def test_next_variant_recommendation_preserves_winner_and_changes_one_dimension(tmp_path: Path) -> None:
    winner_path, winner = create_manifest(lane="static-text-ad", brief={"id": "winner"}, runs_dir=tmp_path / "runs", providers={})
    tag_creative(winner_path, variant_id="v1", parent_run_id=None, features={"hook_type": "contrarian", "first_frame": "plain-text", "cta": "compare"})
    ingest_performance_batch(winner_path, [{"external_id": "winner-post", "platform": "instagram", "views": 1000, "completed_views": 700, "clicks": 50, "conversions": 5, "revenue": 100, "spend": 20}])

    proposal = recommend_next_variant([winner_path], change_dimension="cta", candidate_value="comment-keyword")

    assert proposal["parent_run_id"] == winner["run_id"]
    assert proposal["features"]["hook_type"] == "contrarian"
    assert proposal["features"]["cta"] == "comment-keyword"
    assert proposal["changed_dimensions"] == ["cta"]
