from __future__ import annotations

import json
from pathlib import Path

from hivemind_content_studio.diagnostics import (
    build_baseline,
    diagnose_performance,
    diagnose_portfolio,
    vanity_leak,
)
from hivemind_content_studio.manifest import create_manifest
from hivemind_content_studio.metrics import record_metrics


def _measured_run(tmp_path: Path, name: str, **metrics: float) -> Path:
    manifest, _ = create_manifest(lane="social-post", brief={"id": name}, runs_dir=tmp_path / "runs", providers={})
    record_metrics(manifest, platform="tiktok", **metrics)
    return manifest


def test_unmeasured_stages_report_unknown_instead_of_inventing_a_verdict(tmp_path: Path) -> None:
    manifest = _measured_run(tmp_path, "solo", views=5000, completed_views=3000, clicks=200, conversions=20, revenue=400)

    diagnosis = diagnose_performance(manifest)

    assert diagnosis["bottleneck"] == "unknown"
    assert diagnosis["calibration"]["source"] == "none"
    assert [stage["verdict"] for stage in diagnosis["stages"]][:4] == ["unknown"] * 4


def test_zero_clicks_names_the_intent_stage_without_any_baseline(tmp_path: Path) -> None:
    manifest = _measured_run(tmp_path, "vanity", views=250000, completed_views=150000, clicks=0)

    diagnosis = diagnose_performance(manifest)

    assert diagnosis["bottleneck"] == "intent"
    assert diagnosis["ladder_id"] == "CRD03"
    assert "click_through_rate is zero across 250000 views" in diagnosis["stages"][2]["evidence"]


def test_the_first_broken_link_wins_over_later_ones(tmp_path: Path) -> None:
    healthy = [
        _measured_run(tmp_path, f"healthy-{index}", views=10000, completed_views=6000, clicks=400, conversions=40, revenue=800, spend=100)
        for index in range(3)
    ]
    weak_middle = _measured_run(tmp_path, "weak", views=9000, completed_views=900, clicks=18, conversions=0, revenue=0, spend=100)

    baseline = build_baseline(healthy)
    diagnosis = diagnose_performance(weak_middle, baseline=baseline)

    assert diagnosis["bottleneck"] == "retention"
    assert diagnosis["ladder_id"] == "CRD02"
    assert diagnosis["stages"][0]["verdict"] == "pass"
    assert diagnosis["next_test"].startswith("recut the middle")
    assert diagnosis["calibration"]["measured_runs"] == 3


def test_roas_target_overrides_portfolio_median_for_economics(tmp_path: Path) -> None:
    runs = [
        _measured_run(tmp_path, f"run-{index}", views=10000, completed_views=6000, clicks=400, conversions=40, revenue=120, spend=100)
        for index in range(3)
    ]

    baseline = build_baseline(runs)
    without_target = diagnose_performance(runs[0], baseline=baseline)
    with_target = diagnose_performance(runs[0], baseline=baseline, roas_target=1.5)

    assert without_target["bottleneck"] is None
    assert with_target["bottleneck"] == "economics"
    assert with_target["ladder_id"] == "CRD05"


def test_vanity_leak_ranks_attention_that_does_not_convert(tmp_path: Path) -> None:
    converter = _measured_run(tmp_path, "converter", views=20000, completed_views=12000, clicks=900, conversions=90, revenue=1800)
    vanity = _measured_run(tmp_path, "vanity", views=180000, completed_views=90000, clicks=300, conversions=10, revenue=200)

    leak = vanity_leak([converter, vanity])

    assert leak["runs"][0]["manifest"] == str(vanity)
    assert leak["runs"][0]["vanity"] is True
    assert [item["manifest"] for item in leak["vanity_runs"]] == [str(vanity)]
    assert leak["views_per_conversion"] == 2000


def test_portfolio_diagnosis_shares_one_baseline_and_counts_bottlenecks(tmp_path: Path) -> None:
    runs = [
        _measured_run(tmp_path, f"healthy-{index}", views=10000, completed_views=6000, clicks=400, conversions=40, revenue=800, spend=100)
        for index in range(3)
    ]
    runs.append(_measured_run(tmp_path, "cold", views=500, completed_views=300, clicks=20, conversions=2, revenue=40, spend=100))

    portfolio = diagnose_portfolio(runs)

    assert portfolio["baseline"]["measured_runs"] == 4
    assert portfolio["diagnoses"][str(runs[-1])]["bottleneck"] == "reach"
    assert portfolio["bottleneck_counts"]["reach"] == 1
    assert portfolio["bottleneck_counts"]["none"] == 3
    assert portfolio["shared_bottleneck"] == "reach"
    assert portfolio["vanity_leak"]["conversions"] == 122


def test_mcp_diagnosis_returns_verdicts_without_leaking_metrics_or_paths(tmp_path: Path, monkeypatch) -> None:
    import asyncio

    from hivemind_content_studio import mcp_server

    runs = {
        "run-winner": _measured_run(tmp_path, "winner", views=12000, completed_views=7200, clicks=520, conversions=52, revenue=1040, spend=120),
        "run-twin": _measured_run(tmp_path, "twin", views=11000, completed_views=6600, clicks=470, conversions=44, revenue=900, spend=120),
        "run-vanity": _measured_run(tmp_path, "vanity", views=180000, completed_views=95000, clicks=310, conversions=3, revenue=60, spend=120),
    }
    monkeypatch.setattr(mcp_server, "_manifest_for_run", lambda run_id: str(runs[run_id]))

    server = mcp_server.build_mcp_server()
    blocks = asyncio.run(server.call_tool("diagnose_content_bottleneck", {"run_ids": list(runs)}))
    payload = json.loads(blocks[0].text)

    assert payload["diagnoses"]["run-vanity"]["bottleneck"] == "intent"
    assert payload["diagnoses"]["run-vanity"]["ladder_id"] == "CRD03"
    assert payload["diagnoses"]["run-winner"]["bottleneck"] is None
    assert payload["vanity_run_ids"] == ["run-vanity"]
    assert payload["calibration"]["measured_runs"] == 3

    serialized = json.dumps(payload)
    assert str(tmp_path) not in serialized
    assert "180000" not in serialized and "1040" not in serialized
