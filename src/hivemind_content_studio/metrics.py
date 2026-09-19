"""Run-level performance and revenue feedback for the content loop."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .manifest import load_manifest, utc_now, write_manifest


def record_metrics(
    manifest_path: str | Path,
    *,
    platform: str,
    views: int = 0,
    completed_views: int = 0,
    clicks: int = 0,
    conversions: int = 0,
    revenue: float = 0.0,
    spend: float = 0.0,
    external_id: str | None = None,
    retention: dict[str, float] | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    values = (views, completed_views, clicks, conversions)
    if any(value < 0 for value in values) or revenue < 0 or spend < 0:
        raise ValueError("Metrics cannot be negative")
    if completed_views > views or clicks > views:
        raise ValueError("Completed views and clicks cannot exceed views")
    manifest = load_manifest(manifest_path)
    entry = {
        "platform": platform.strip().lower(),
        "views": views,
        "completed_views": completed_views,
        "clicks": clicks,
        "conversions": conversions,
        "revenue": round(revenue, 2),
        "spend": round(spend, 2),
        "external_id": external_id,
        "retention": retention or {},
        "source": source,
        "recorded_at": utc_now(),
    }
    manifest.setdefault("performance", []).append(entry)
    write_manifest(manifest_path, manifest)
    return entry


#: Platform counter names that mean "how many times it was seen", best first.
_VIEW_KEYS = ("views", "impressions", "reach", "plays")
_CLICK_KEYS = ("clicks", "link_clicks", "url_clicks")


def upsert_post_metrics(
    manifest_path: str | Path,
    *,
    platform: str,
    external_id: str,
    metrics: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    """Record a post's latest platform counters, replacing the previous read.

    A post's numbers keep growing, so unlike ``record_metrics`` (one entry per
    event) this keeps ONE entry per post and source: summing every poll would
    count the same views again each time. Counters the run summary does not
    model (likes, reposts, saves...) are kept verbatim under ``engagement``.
    """
    if not external_id.strip():
        raise ValueError("external_id is required")
    counters = {str(key): int(value) for key, value in metrics.items() if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0}
    views = next((counters[key] for key in _VIEW_KEYS if key in counters), 0)
    clicks = min(next((counters[key] for key in _CLICK_KEYS if key in counters), 0), views)
    manifest = load_manifest(manifest_path)
    entries = manifest.setdefault("performance", [])
    previous = next((item for item in entries if item.get("external_id") == external_id and item.get("source") == source), None)
    entry = {
        "platform": platform.strip().lower(),
        "views": views,
        "completed_views": 0,
        "clicks": clicks,
        # Money is entered by hand or by a revenue import; a counter refresh must not erase it.
        "conversions": int(previous.get("conversions", 0)) if previous else 0,
        "revenue": float(previous.get("revenue", 0.0)) if previous else 0.0,
        "spend": float(previous.get("spend", 0.0)) if previous else 0.0,
        "external_id": external_id,
        "retention": dict(previous.get("retention") or {}) if previous else {},
        "engagement": {key: value for key, value in counters.items() if key not in _VIEW_KEYS and key not in _CLICK_KEYS},
        "source": source,
        "recorded_at": utc_now(),
    }
    if previous:
        entries[entries.index(previous)] = entry
    else:
        entries.append(entry)
    write_manifest(manifest_path, manifest)
    return entry


def summarize_metrics(manifest_path: str | Path) -> dict[str, Any]:
    entries = load_manifest(manifest_path).get("performance", [])
    totals = {
        "views": sum(int(entry.get("views", 0)) for entry in entries),
        "completed_views": sum(int(entry.get("completed_views", 0)) for entry in entries),
        "clicks": sum(int(entry.get("clicks", 0)) for entry in entries),
        "conversions": sum(int(entry.get("conversions", 0)) for entry in entries),
        "revenue": round(sum(float(entry.get("revenue", 0)) for entry in entries), 2),
        "spend": round(sum(float(entry.get("spend", 0)) for entry in entries), 2),
    }
    views = totals["views"]
    clicks = totals["clicks"]
    totals.update(
        {
            "completion_rate": totals["completed_views"] / views if views else 0.0,
            "click_through_rate": clicks / views if views else 0.0,
            "conversion_rate": totals["conversions"] / clicks if clicks else 0.0,
            "revenue_per_thousand_views": totals["revenue"] * 1000 / views if views else 0.0,
            "roas": totals["revenue"] / totals["spend"] if totals["spend"] else 0.0,
            "cost_per_conversion": totals["spend"] / totals["conversions"] if totals["conversions"] else 0.0,
        }
    )
    return {"entries": entries, "totals": totals}
