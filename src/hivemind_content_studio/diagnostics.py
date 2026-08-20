"""Funnel bottleneck diagnosis over recorded distribution outcomes.

`metrics.py` stores what happened and `experiments.py` proposes the next controlled
variant. Neither says which link in the funnel is actually broken, so operators read
raw ratios and guess. This module answers that question from the numbers already in
the manifests: it walks reach -> retention -> intent -> conversion -> economics and
names the first stage that underperforms.

Every band is calibrated from the operator's own measured runs. Absolute view
thresholds published by creator networks are vendor claims and are deliberately not
encoded here; a run with no comparable history returns `unknown`, never a verdict.
The stage ids match the shared creator-rewards diagnostic ladder (CRD01-CRD05) so a
studio diagnosis and a campaign brief use one vocabulary.
"""

from __future__ import annotations

from pathlib import Path
from statistics import median
from typing import Any

from .metrics import summarize_metrics

# Ordered funnel stages. The first failing stage is the bottleneck: scaling creative
# above a broken downstream link only buys more of the same loss.
STAGES: tuple[dict[str, str], ...] = (
    {
        "stage": "reach",
        "ladder_id": "CRD01",
        "metric": "views",
        "suspect": "hook, first frame, format-audience fit, or account eligibility",
        "next_test": "hold the body constant and test several hooks after checking platform diagnostics",
    },
    {
        "stage": "retention",
        "ladder_id": "CRD02",
        "metric": "completion_rate",
        "suspect": "pacing, dead space, story tension, creator execution, or reveal timing",
        "next_test": "recut the middle, move proof earlier, and compare creators on the same brief",
    },
    {
        "stage": "intent",
        "ladder_id": "CRD03",
        "metric": "click_through_rate",
        "suspect": "low product intent, unclear demo, CTA timing, caption naming, or store mismatch",
        "next_test": "add a truthful product demo and explicit next step, then align the destination promise",
    },
    {
        "stage": "conversion",
        "ladder_id": "CRD04",
        "metric": "conversion_rate",
        "suspect": "onboarding, paywall, trial terms, value delivery, or product retention",
        "next_test": "stop creative scale and fix the downstream funnel",
    },
    {
        "stage": "economics",
        "ladder_id": "CRD05",
        "metric": "roas",
        "suspect": "expectation mismatch, claim quality, product value, or overpriced traffic",
        "next_test": "stop scale, audit the promise, and repair value before buying more traffic",
    },
)

_RATIO_METRICS = {"completion_rate", "click_through_rate", "conversion_rate", "roas"}


def build_baseline(manifest_paths: list[str | Path]) -> dict[str, Any]:
    """Median performance across measured runs, used as this operator's own band."""
    samples: dict[str, list[float]] = {entry["metric"]: [] for entry in STAGES}
    measured = 0
    for path in manifest_paths:
        totals = summarize_metrics(path)["totals"]
        if not totals["views"]:
            continue
        measured += 1
        for metric in samples:
            if metric == "roas" and not totals["spend"]:
                continue
            samples[metric].append(float(totals[metric]))
    return {
        "source": "portfolio-median",
        "measured_runs": measured,
        "medians": {metric: median(values) for metric, values in samples.items() if values},
    }


def diagnose_performance(
    manifest_path: str | Path,
    *,
    baseline: dict[str, Any] | None = None,
    roas_target: float | None = None,
    underperformance: float = 0.5,
) -> dict[str, Any]:
    """Name the first funnel stage that underperforms, with the evidence behind it.

    `underperformance` is the share of the operator's own median below which a stage
    counts as failing. It is a tunable operating convention, not a measured constant.
    """
    if not 0 < underperformance <= 1:
        raise ValueError("underperformance must be within (0, 1]")
    summary = summarize_metrics(manifest_path)
    totals = summary["totals"]
    medians = dict((baseline or {}).get("medians") or {})
    stages: list[dict[str, Any]] = []

    for entry in STAGES:
        metric = entry["metric"]
        observed = float(totals[metric])
        upstream, upstream_label = _upstream(metric, totals, len(summary["entries"]))
        floor = medians.get(metric)
        threshold = floor * underperformance if floor is not None else None
        if metric == "roas" and roas_target is not None:
            threshold = float(roas_target)

        if not upstream:
            verdict, reason = "unknown", f"no {upstream_label} recorded, so {metric} cannot be judged"
        elif observed == 0:
            verdict, reason = "fail", f"{metric} is zero across {upstream:g} {upstream_label}"
        elif threshold is None:
            verdict, reason = "unknown", f"no calibration available for {metric}"
        elif observed < threshold:
            verdict, reason = "fail", f"{metric} {observed:.4g} is below {threshold:.4g}"
        else:
            verdict, reason = "pass", f"{metric} {observed:.4g} meets {threshold:.4g}"

        stages.append({**entry, "observed": observed, "threshold": threshold, "verdict": verdict, "evidence": reason})

    failing = next((stage for stage in stages if stage["verdict"] == "fail"), None)
    unresolved = next((stage for stage in stages if stage["verdict"] == "unknown"), None)
    return {
        "bottleneck": failing["stage"] if failing else ("unknown" if unresolved else None),
        "ladder_id": (failing or unresolved or {}).get("ladder_id"),
        "suspect": (failing or unresolved or {}).get("suspect"),
        "next_test": failing["next_test"] if failing else None,
        "stages": stages,
        "totals": totals,
        "calibration": {
            "source": (baseline or {}).get("source", "none"),
            "measured_runs": (baseline or {}).get("measured_runs", 0),
            "underperformance": underperformance,
            "roas_target": roas_target,
        },
    }


def vanity_leak(manifest_paths: list[str | Path], *, tolerance: float = 0.1) -> dict[str, Any]:
    """Compare each run's share of attention against its share of outcomes.

    Views are only worth what they convert. A run that takes a large share of the
    portfolio's views while returning a much smaller share of its conversions is the
    operating leak, regardless of how good its view count looks on its own.
    """
    if not manifest_paths:
        raise ValueError("At least one measured run is required")
    if not 0 <= tolerance < 1:
        raise ValueError("tolerance must be within [0, 1)")
    runs = [(str(path), summarize_metrics(path)["totals"]) for path in manifest_paths]
    total_views = sum(totals["views"] for _, totals in runs)
    total_conversions = sum(totals["conversions"] for _, totals in runs)
    if not total_views:
        raise ValueError("No measured views to compare")

    leaks = []
    for path, totals in runs:
        view_share = totals["views"] / total_views
        conversion_share = totals["conversions"] / total_conversions if total_conversions else 0.0
        leaks.append(
            {
                "manifest": path,
                "views": totals["views"],
                "conversions": totals["conversions"],
                "view_share": round(view_share, 4),
                "conversion_share": round(conversion_share, 4),
                "leak": round(view_share - conversion_share, 4),
                "vanity": (view_share - conversion_share) > tolerance,
            }
        )
    leaks.sort(key=lambda item: item["leak"], reverse=True)
    return {
        "views": total_views,
        "conversions": total_conversions,
        "views_per_conversion": total_views / total_conversions if total_conversions else None,
        "tolerance": tolerance,
        "vanity_runs": [item for item in leaks if item["vanity"]],
        "runs": leaks,
    }


def diagnose_portfolio(
    manifest_paths: list[str | Path],
    *,
    roas_target: float | None = None,
    underperformance: float = 0.5,
    tolerance: float = 0.1,
) -> dict[str, Any]:
    """Diagnose every measured run against the portfolio's own bands, then rank leaks."""
    if not manifest_paths:
        raise ValueError("At least one measured run is required")
    baseline = build_baseline(manifest_paths)
    diagnoses = {
        str(path): diagnose_performance(
            path, baseline=baseline, roas_target=roas_target, underperformance=underperformance
        )
        for path in manifest_paths
    }
    counts: dict[str, int] = {}
    for diagnosis in diagnoses.values():
        key = diagnosis["bottleneck"] or "none"
        counts[key] = counts.get(key, 0) + 1
    # A roster-wide fix is only worth proposing for a stage that actually failed, so
    # healthy runs never win the vote just by being the majority.
    failing = {stage: count for stage, count in counts.items() if stage not in {"none", "unknown"}}
    return {
        "baseline": baseline,
        "diagnoses": diagnoses,
        "bottleneck_counts": counts,
        "shared_bottleneck": max(failing, key=failing.get) if failing else None,
        "vanity_leak": vanity_leak(manifest_paths, tolerance=tolerance),
    }


def _upstream(metric: str, totals: dict[str, Any], entry_count: int) -> tuple[float, str]:
    """Volume feeding a stage, so an unmeasured stage reads unknown instead of failed."""
    if metric == "views":
        return float(entry_count), "recorded posts"
    if metric in {"completion_rate", "click_through_rate"}:
        return float(totals["views"]), "views"
    if metric == "conversion_rate":
        return float(totals["clicks"]), "clicks"
    return float(totals["spend"]), "spend"
