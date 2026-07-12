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
