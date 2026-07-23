"""Deterministic preflight and agent-authored semantic acceptance records."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .manifest import add_artifact, load_manifest, utc_now, write_manifest
from .private_access import write_private_json


CLAIM_RISK = re.compile(r"\b(?:guaranteed?|cure[sd]?|risk[- ]free|make\s+you\s+rich|overnight|100%|no\s+risk)\b", re.IGNORECASE)


def semantic_preflight(manifest_path: str | Path) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    failures: list[dict[str, Any]] = []
    scenes = manifest.get("brief", {}).get("scenes") or []
    for index, raw in enumerate(scenes, start=1):
        scene = raw if isinstance(raw, dict) else {"beat": str(raw)}
        source_text = " ".join(str(scene.get(key) or "") for key in ("beat", "voice", "overlay", "subtext"))
        overlay = str(scene.get("overlay") or "")
        if CLAIM_RISK.search(source_text):
            failures.append({"scene": index, "check": "claim_grounding", "evidence": "Potential guarantee, outcome, or risk-free claim requires evidence and approval."})
        if len(overlay) > 60 or len(overlay.split()) > 12:
            failures.append({"scene": index, "check": "text_legibility", "evidence": "Mobile overlay exceeds the default one-glance density limit."})
    return {
        "passed": not failures,
        "score": max(0, 100 - 20 * len(failures)),
        "checks": {"claim_grounding": not any(item["check"] == "claim_grounding" for item in failures), "text_legibility": not any(item["check"] == "text_legibility" for item in failures)},
        "scene_failures": failures,
        "regeneration_instructions": [
            {"scene": item["scene"], "instruction": "Remove or substantiate the claim." if item["check"] == "claim_grounding" else "Reduce the overlay to at most twelve short words."}
            for item in failures
        ],
    }


def record_semantic_evaluation(
    manifest_path: str | Path,
    *,
    evaluator: str,
    passed: bool,
    score: float,
    checks: dict[str, Any],
    scene_failures: list[dict[str, Any]],
    regeneration_instructions: list[dict[str, Any]],
) -> dict[str, Any]:
    if not 0 <= float(score) <= 100:
        raise ValueError("Evaluation score must be between 0 and 100")
    if any("scene" not in failure for failure in scene_failures):
        raise ValueError("Every semantic failure must identify a scene")
    if not evaluator.strip():
        raise ValueError("Evaluator identity is required")
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    result = {
        "schema_version": 1,
        "run_id": manifest["run_id"],
        "evaluator": evaluator.strip(),
        "passed": bool(passed),
        "score": round(float(score), 2),
        "checks": checks,
        "scene_failures": scene_failures,
        "regeneration_instructions": regeneration_instructions,
        "evaluated_at": utc_now(),
    }
    path = manifest_file.parent / "semantic-evaluation.json"
    write_private_json(path, result)
    manifest["artifacts"] = [item for item in manifest["artifacts"] if item["role"] != "semantic-evaluation"]
    add_artifact(manifest, role="semantic-evaluation", path=path, provider="agent-evaluator")
    manifest.setdefault("quality", {})["semantic"] = {"passed": result["passed"], "score": result["score"], "evaluated_at": result["evaluated_at"]}
    write_manifest(manifest_file, manifest)
    return result
