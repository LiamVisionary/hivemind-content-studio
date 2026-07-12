from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.manifest import create_manifest
from hivemind_content_studio.metrics import record_metrics, summarize_metrics


def test_metrics_close_the_distribution_feedback_loop(tmp_path: Path) -> None:
    manifest, _ = create_manifest(lane="social-post", brief={"id": "metrics"}, runs_dir=tmp_path / "runs", providers={})
    record_metrics(manifest, platform="youtube", views=1000, completed_views=600, clicks=40, conversions=4, revenue=80)
    summary = summarize_metrics(manifest)["totals"]
    assert summary["completion_rate"] == 0.6
    assert summary["click_through_rate"] == 0.04
    assert summary["conversion_rate"] == 0.1
    assert summary["revenue_per_thousand_views"] == 80
