"""Creative lineage, idempotent performance ingestion, and controlled variants."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .manifest import load_manifest, utc_now, write_manifest
from .metrics import record_metrics, summarize_metrics


def tag_creative(
    manifest_path: str | Path,
    *,
    variant_id: str,
    parent_run_id: str | None,
    features: dict[str, Any],
) -> dict[str, Any]:
    if not variant_id.strip():
        raise ValueError("variant_id is required")
    manifest = load_manifest(manifest_path)
    creative = {
        "variant_id": variant_id.strip(),
        "parent_run_id": parent_run_id,
        "features": features,
        "tagged_at": utc_now(),
    }
    manifest["creative"] = creative
    write_manifest(manifest_path, manifest)
    return creative


def ingest_performance_batch(manifest_path: str | Path, entries: list[dict[str, Any]]) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    existing_ids = {str(item.get("external_id")) for item in manifest.get("performance", []) if item.get("external_id")}
    ingested = 0
    skipped = 0
    for entry in entries:
        external_id = str(entry.get("external_id") or "").strip()
        if not external_id:
            raise ValueError("Every imported performance entry requires external_id")
        if external_id in existing_ids:
            skipped += 1
            continue
        record_metrics(
            manifest_path,
            platform=str(entry.get("platform") or "unknown"),
            views=int(entry.get("views") or 0),
            completed_views=int(entry.get("completed_views") or 0),
            clicks=int(entry.get("clicks") or 0),
            conversions=int(entry.get("conversions") or 0),
            revenue=float(entry.get("revenue") or 0),
            spend=float(entry.get("spend") or 0),
            external_id=external_id,
            retention={str(key): float(value) for key, value in (entry.get("retention") or {}).items()},
            source=str(entry.get("source") or "import"),
        )
        existing_ids.add(external_id)
        ingested += 1
    return {"ingested": ingested, "skipped": skipped, "summary": summarize_metrics(manifest_path)}


def recommend_next_variant(
    manifest_paths: list[str | Path],
    *,
    change_dimension: str,
    candidate_value: Any,
) -> dict[str, Any]:
    if not manifest_paths:
        raise ValueError("At least one measured run is required")
    ranked: list[tuple[float, dict[str, Any], dict[str, Any]]] = []
    for path in manifest_paths:
        manifest = load_manifest(path)
        summary = summarize_metrics(path)["totals"]
        score = float(summary["revenue"]) - float(summary["spend"]) + float(summary["conversion_rate"]) * 100
        ranked.append((score, manifest, summary))
    ranked.sort(key=lambda item: item[0], reverse=True)
    _, winner, metrics = ranked[0]
    features = dict(winner.get("creative", {}).get("features") or {})
    features[change_dimension] = candidate_value
    return {
        "parent_run_id": winner["run_id"],
        "parent_variant_id": winner.get("creative", {}).get("variant_id"),
        "features": features,
        "changed_dimensions": [change_dimension],
        "winner_metrics": metrics,
        "reason": "Preserve the best measured creative and change one controlled dimension.",
    }
