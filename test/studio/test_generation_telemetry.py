from __future__ import annotations

from pathlib import Path
import json

from hivemind_content_studio.generation_telemetry import generation_telemetry_snapshot, record_hivemind_generation_metric
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.run_store import RunStore


def test_generation_telemetry_aggregates_success_failure_provider_kind_and_cost(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: telemetry\nlane: first-frame-animation-ad\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    store = RunStore(tmp_path / "state.sqlite3")
    run = ContentOrchestrator(store).execute_content_run(brief)
    shared = {"intent": "generate_keyframes", "kind": "image", "provider": "muapi", "model": "flux", "estimated_cost_usd": 1.0}
    store.append_event(run["run_id"], "generation.started", {"telemetry_id": "gen-1", **shared, "status": "running"})
    store.append_event(run["run_id"], "generation.completed", {"telemetry_id": "gen-1", **shared, "status": "completed", "duration_ms": 1000, "artifact_count": 2, "charged_usd": 0.75})
    store.append_event(run["run_id"], "generation.started", {"telemetry_id": "gen-2", **shared, "status": "running"})
    store.append_event(run["run_id"], "generation.failed", {"telemetry_id": "gen-2", **shared, "status": "failed", "duration_ms": 500, "artifact_count": 0, "charged_usd": 0, "error_type": "TimeoutError"})

    telemetry = generation_telemetry_snapshot(store, limit=20)

    assert telemetry["ok"] is True
    assert telemetry["summary"] == {
        "attempts": 2,
        "completed": 1,
        "failed": 1,
        "running": 0,
        "success_rate": 0.5,
        "average_duration_ms": 1000,
        "p50_duration_ms": 1000,
        "p95_duration_ms": 1000,
        "charged_usd": 0.75,
        "artifacts": 2,
    }
    assert telemetry["by_provider"][0]["provider"] == "muapi"
    assert telemetry["by_kind"][0]["kind"] == "image"
    assert [attempt["status"] for attempt in telemetry["recent_attempts"]] == ["failed", "completed"]
    assert "prompt" not in str(telemetry["recent_attempts"]).lower()


def test_completed_timing_bridge_sends_only_compact_metrics_to_authenticated_hivemind_route(monkeypatch) -> None:
    monkeypatch.setenv("HIVEMINDOS_URL", "http://127.0.0.1:5020")
    monkeypatch.setenv("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "device-secret")
    seen: list[dict] = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self, _size: int) -> bytes:
            return b"{"

    def open_request(request, timeout: int):
        seen.append({
            "url": request.full_url,
            "token": request.get_header("X-hivemindos-device-token"),
            "body": json.loads(request.data.decode("utf-8")),
            "timeout": timeout,
        })
        return Response()

    monkeypatch.setattr("hivemind_content_studio.generation_telemetry.urllib.request.urlopen", open_request)

    record_hivemind_generation_metric({
        "telemetry_id": "gen-1",
        "run_id": "run-1",
        "kind": "video",
        "provider": "muapi",
        "model": "seedance-v2",
        "status": "completed",
        "duration_ms": 1500,
        "prompt": "must not cross the boundary",
    })

    assert seen[0]["url"] == "http://127.0.0.1:5020/api/generation-metrics"
    assert seen[0]["token"] == "device-secret"
    assert seen[0]["body"] == {
        "kind": "video",
        "appId": "content-studio:muapi",
        "appName": "Content Studio · muapi",
        "serviceKind": "muapi",
        "modelName": "seedance-v2",
        "durationMs": 1500,
        "runId": "run-1:gen-1",
    }
