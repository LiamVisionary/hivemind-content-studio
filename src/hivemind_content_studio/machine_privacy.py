"""Machine-facing receipts that exclude prompts, media, and private paths."""

from __future__ import annotations

from typing import Any


def machine_next_actions(actions: object) -> list[dict[str, Any]]:
    if not isinstance(actions, list):
        return []
    safe: list[dict[str, Any]] = []
    for action in actions:
        if not isinstance(action, dict):
            continue
        arguments = action.get("arguments") if isinstance(action.get("arguments"), dict) else {}
        safe_arguments = {
            key: arguments[key]
            for key in ("run_id", "step_id", "approval_id", "intent", "kind", "provider", "amount_usd")
            if key in arguments and isinstance(arguments[key], (str, int, float, bool))
        }
        safe.append({
            key: value
            for key, value in {
                "intent": str(action.get("intent") or "")[:120],
                "tool": str(action.get("tool") or "")[:120],
                "arguments": safe_arguments,
            }.items()
            if value not in ("", {})
        })
    return safe


def machine_run_receipt(run: dict[str, Any]) -> dict[str, Any]:
    steps = []
    for step in run.get("steps", []) if isinstance(run.get("steps"), list) else []:
        if not isinstance(step, dict):
            continue
        steps.append({
            key: value
            for key, value in {
                "step_id": step.get("step_id"),
                "status": step.get("status"),
                "attempts": step.get("attempts"),
                "max_attempts": step.get("max_attempts"),
                "provider": step.get("provider"),
                "job_id": step.get("job_id"),
                "error_type": "StepError" if step.get("error") else None,
                "next_actions": machine_next_actions(step.get("next_actions")),
            }.items()
            if value not in (None, "", [])
        })
    artifacts = run.get("artifact_records") if isinstance(run.get("artifact_records"), list) else []
    roles: dict[str, int] = {}
    for artifact in artifacts:
        if isinstance(artifact, dict):
            role = str(artifact.get("role") or "artifact")[:80]
            roles[role] = roles.get(role, 0) + 1
    return {
        "ok": bool(run.get("ok", True)),
        "privacy": "machine-redacted",
        "run_id": str(run.get("run_id") or ""),
        "lane": str(run.get("lane") or ""),
        "status": str(run.get("status") or ""),
        "current_step": run.get("current_step"),
        "revision": int(run.get("revision") or 0),
        "created_at": run.get("created_at"),
        "updated_at": run.get("updated_at"),
        "steps": steps,
        "next_actions": machine_next_actions(run.get("next_actions")),
        "approval_required": bool(run.get("approval_required", False)),
        "cost": dict(run.get("cost") or run.get("budget") or {}),
        "artifact_count": len(artifacts),
        "artifact_roles": roles,
        "prompts_redacted": True,
        "media_redacted": True,
    }


def machine_artifact_receipt(artifact: object) -> dict[str, Any]:
    if not isinstance(artifact, dict):
        return {"accepted": True, "media_redacted": True}
    return {
        "accepted": True,
        "artifact_id": str(artifact.get("id") or "")[:160],
        "role": str(artifact.get("role") or "")[:80],
        "provider": str(artifact.get("provider") or "")[:120],
        "media_redacted": True,
    }


def machine_operation_receipt(value: object) -> dict[str, Any]:
    """Keep automation status/IDs/counts while dropping creative payloads."""
    if not isinstance(value, dict):
        return {"ok": True, "privacy": "machine-redacted"}
    if value.get("run_id") and ("steps" in value or "artifact_records" in value or "brief" in value):
        return machine_run_receipt(value)
    allowed = {
        "ok", "id", "run_id", "telemetry_id", "status", "intent", "kind",
        "provider", "model", "backend", "job_id", "prompt_id", "approval_id",
        "current_step", "revision", "created_at", "updated_at", "duration_ms",
        "estimated_cost_usd", "charged_usd", "amount_usd", "artifact_count",
        "count", "completed", "failed", "running", "success_rate", "accepted",
        "changed", "wait_timed_out",
    }
    receipt = {
        key: item
        for key, item in value.items()
        if key in allowed and isinstance(item, (str, int, float, bool, type(None)))
    }
    if isinstance(value.get("next_actions"), list):
        receipt["next_actions"] = machine_next_actions(value["next_actions"])
    for key in ("job", "submission", "approval", "receipt", "decision", "summary", "result"):
        if isinstance(value.get(key), dict):
            receipt[key] = machine_operation_receipt(value[key])
    receipt.setdefault("ok", bool(value.get("ok", True)))
    receipt["privacy"] = "machine-redacted"
    receipt["prompts_redacted"] = True
    receipt["media_redacted"] = True
    return receipt
