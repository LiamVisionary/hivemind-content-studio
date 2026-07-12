"""Privacy-safe telemetry for run-associated media generation attempts."""

from __future__ import annotations

import json
import math
import os
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
import time
import uuid
from typing import Any, Callable

from .run_store import RunStore


GENERATION_KINDS = {
    "generate_keyframes": "image",
    "animate_scenes": "video",
    "generate_voice": "tts",
    "generate_music": "music",
    "generate_product_cutins": "image",
    "generate_ugc_shots": "video",
    "lip_sync_scenes": "video",
}
TERMINAL_STATUSES = {"completed", "failed"}


@dataclass
class GenerationAttempt:
    store: RunStore
    run_id: str
    telemetry_id: str
    intent: str
    kind: str
    provider: str
    model: str
    estimated_cost_usd: float
    started_at: float
    monotonic: Callable[[], float]
    metric_sink: Callable[[dict[str, Any]], None] | None = None

    @classmethod
    def start(
        cls,
        store: RunStore,
        *,
        run_id: str,
        intent: str,
        kind: str,
        provider: str,
        model: str,
        estimated_cost_usd: float = 0,
        monotonic: Callable[[], float] = time.perf_counter,
        metric_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> "GenerationAttempt":
        attempt = cls(
            store=store,
            run_id=run_id,
            telemetry_id=f"gen_{uuid.uuid4().hex[:16]}",
            intent=intent,
            kind=kind,
            provider=provider,
            model=model,
            estimated_cost_usd=round(max(0.0, float(estimated_cost_usd)), 6),
            started_at=monotonic(),
            monotonic=monotonic,
            metric_sink=metric_sink,
        )
        store.append_event(run_id, "generation.started", {**attempt._base("running")})
        return attempt

    def complete(self, *, model: str = "", artifact_count: int = 0, charged_usd: float = 0) -> dict[str, Any]:
        payload = {
            **self._base("completed", model=model),
            "duration_ms": self._duration_ms(),
            "artifact_count": max(0, int(artifact_count)),
            "charged_usd": round(max(0.0, float(charged_usd)), 6),
        }
        self.store.append_event(self.run_id, "generation.completed", payload)
        if self.metric_sink:
            try:
                self.metric_sink({**payload, "run_id": self.run_id})
            except Exception:
                pass
        return payload

    def fail(self, error: Exception) -> dict[str, Any]:
        payload = {
            **self._base("failed"),
            "duration_ms": self._duration_ms(),
            "artifact_count": 0,
            "charged_usd": 0.0,
            "error_type": type(error).__name__,
        }
        self.store.append_event(self.run_id, "generation.failed", payload)
        return payload

    def _base(self, status: str, *, model: str = "") -> dict[str, Any]:
        return {
            "telemetry_id": self.telemetry_id,
            "intent": self.intent,
            "kind": self.kind,
            "provider": self.provider,
            "model": (model.strip() or self.model)[:240],
            "status": status,
            "estimated_cost_usd": self.estimated_cost_usd,
        }

    def _duration_ms(self) -> int:
        return max(0, round((self.monotonic() - self.started_at) * 1000))


def generation_kind(intent: str) -> str | None:
    return GENERATION_KINDS.get(intent)


def generation_model(manifest: dict[str, Any], provider: str, intent: str, execution: dict[str, Any] | None = None) -> str:
    if execution:
        direct = str(execution.get("model") or "").strip()
        if direct:
            return direct[:240]
        telemetry = execution.get("telemetry")
        if isinstance(telemetry, dict) and str(telemetry.get("model") or "").strip():
            return str(telemetry["model"]).strip()[:240]
    all_options = manifest.get("brief", {}).get("provider_options")
    options = all_options.get(provider) if isinstance(all_options, dict) else None
    if not isinstance(options, dict):
        return "automatic"
    kind = {"generate_keyframes": "keyframe", "animate_scenes": "motion", "generate_voice": "voice"}.get(intent, "")
    nested = options.get(kind) if kind and isinstance(options.get(kind), dict) else {}
    for value in (
        nested.get("model") if isinstance(nested, dict) else None,
        options.get(f"{kind}_model") if kind else None,
        options.get("model"),
    ):
        if str(value or "").strip():
            return str(value).strip()[:240]
    return "automatic"


def generation_telemetry_snapshot(store: RunStore, *, limit: int = 100) -> dict[str, Any]:
    events = store.list_events(kind_prefix="generation.", limit=10_000)
    attempts: dict[str, dict[str, Any]] = {}
    for event in reversed(events):
        payload = event["payload"] if isinstance(event.get("payload"), dict) else {}
        telemetry_id = str(payload.get("telemetry_id") or "").strip()
        if not telemetry_id:
            continue
        current = attempts.setdefault(telemetry_id, {"telemetry_id": telemetry_id})
        current.update(_safe_attempt_fields(payload))
        current.update({"run_id": event["run_id"], "lane": event["lane"], "updated_at": event["created_at"], "_event_id": event["id"]})

    values = list(attempts.values())
    terminal = [item for item in values if item.get("status") in TERMINAL_STATUSES]
    running = [item for item in values if item.get("status") == "running"]
    ordered = sorted(
        values,
        key=lambda item: (str(item.get("updated_at") or ""), int(item.get("_event_id") or 0)),
        reverse=True,
    )[: max(1, min(500, int(limit)))]
    recent = [{key: value for key, value in item.items() if not key.startswith("_")} for item in ordered]
    by_provider = _breakdown(terminal, "provider")
    by_kind = _breakdown(terminal, "kind")
    return {
        "ok": True,
        "privacy": "Local aggregate telemetry only. Prompts, media, credentials, tokens, and provider payloads are excluded.",
        "summary": _aggregate(terminal, running=len(running)),
        "by_provider": by_provider,
        "by_kind": by_kind,
        "recent_attempts": recent,
    }


def _safe_attempt_fields(payload: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key in ("intent", "kind", "provider", "model", "status", "error_type"):
        value = str(payload.get(key) or "").strip()
        if value:
            safe[key] = value[:240]
    for key in ("duration_ms", "artifact_count"):
        if payload.get(key) is not None:
            safe[key] = max(0, int(float(payload[key])))
    for key in ("estimated_cost_usd", "charged_usd"):
        if payload.get(key) is not None:
            safe[key] = round(max(0.0, float(payload[key])), 6)
    return safe


def _aggregate(attempts: list[dict[str, Any]], *, running: int = 0) -> dict[str, Any]:
    completed = [item for item in attempts if item.get("status") == "completed"]
    failed = [item for item in attempts if item.get("status") == "failed"]
    durations = [int(item.get("duration_ms") or 0) for item in completed if int(item.get("duration_ms") or 0) >= 0]
    total = len(completed) + len(failed)
    return {
        "attempts": total,
        "completed": len(completed),
        "failed": len(failed),
        "running": running,
        "success_rate": round(len(completed) / total, 4) if total else 0.0,
        "average_duration_ms": round(sum(durations) / len(durations)) if durations else 0,
        "p50_duration_ms": _percentile(durations, 50),
        "p95_duration_ms": _percentile(durations, 95),
        "charged_usd": round(sum(float(item.get("charged_usd") or 0) for item in attempts), 6),
        "artifacts": sum(int(item.get("artifact_count") or 0) for item in completed),
    }


def _breakdown(attempts: list[dict[str, Any]], field: str) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for attempt in attempts:
        groups[str(attempt.get(field) or "unknown")].append(attempt)
    rows = [{field: name, **_aggregate(items)} for name, items in groups.items()]
    return sorted(rows, key=lambda row: (-int(row["attempts"]), str(row[field])))


def _percentile(values: list[int], percent: int) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil((percent / 100) * len(ordered)) - 1))
    return int(ordered[index])


def record_hivemind_generation_metric(sample: dict[str, Any]) -> None:
    """Best-effort bridge into HivemindOS's cross-app timing aggregates."""
    if sample.get("status") != "completed" or int(sample.get("duration_ms") or 0) < 500:
        return
    token = os.environ.get("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "").strip()
    if not token:
        return
    base = os.environ.get("HIVEMINDOS_URL", "http://127.0.0.1:5020").strip().rstrip("/")
    if not base.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        return
    provider = str(sample.get("provider") or "content-studio")[:160]
    body = {
        "kind": sample.get("kind"),
        "appId": f"content-studio:{provider}",
        "appName": f"Content Studio · {provider}",
        "serviceKind": provider,
        "modelName": str(sample.get("model") or "automatic")[:240],
        "durationMs": int(sample["duration_ms"]),
        "runId": f"{sample.get('run_id')}:{sample.get('telemetry_id')}",
    }
    request = urllib.request.Request(
        f"{base}/api/generation-metrics",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "x-hivemindos-device-token": token},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read(1)
