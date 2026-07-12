from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.capability_router import CapabilityRouter
from hivemind_content_studio.intent_service import ContentIntentService
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.run_store import RunStore


def _service(tmp_path: Path, monkeypatch, report: list[dict]) -> tuple[ContentIntentService, str]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: intent\nlane: first-frame-animation-ad\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    run = orchestrator.execute_content_run(brief, policy={"privacy": "cloud-allowed"}, budget={"max_cost_usd": 10})
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    return ContentIntentService(orchestrator, CapabilityRouter(report), approvals), run["run_id"]


def test_paid_intent_creates_exact_approval_request_before_execution(tmp_path: Path, monkeypatch) -> None:
    report = [{"id": "higgsfield-cloud", "roles": ["keyframe"], "mode": "cloud", "cost": "paid", "available": True, "side_effects": ["spend"], "detail": "credential present"}]
    service, run_id = _service(tmp_path, monkeypatch, report)

    result = service.prepare_intent(run_id, "generate_keyframes", estimated_cost_usd=2.5)

    assert result["status"] == "awaiting_approval"
    assert result["approval"]["provider"] == "higgsfield-cloud"
    assert result["approval"]["amount_usd"] == 2.5
    assert result["execute"] is False


def test_approved_intent_consumes_receipt_and_becomes_executable(tmp_path: Path, monkeypatch) -> None:
    report = [{"id": "higgsfield-cloud", "roles": ["keyframe"], "mode": "cloud", "cost": "paid", "available": True, "side_effects": ["spend"], "detail": "credential present"}]
    service, run_id = _service(tmp_path, monkeypatch, report)
    pending = service.prepare_intent(run_id, "generate_keyframes", estimated_cost_usd=2.5)
    receipt = service.approvals.approve(pending["approval"]["id"], operator_token="operator-secret", decided_by="owner")

    result = service.prepare_intent(run_id, "generate_keyframes", estimated_cost_usd=2.5, approval_token=receipt["token"])

    assert result["status"] == "authorized"
    assert result["execute"] is True
    assert service.approvals.get(pending["approval"]["id"])["status"] == "consumed"


def test_local_intent_needs_no_spend_approval(tmp_path: Path, monkeypatch) -> None:
    report = [{"id": "comfyui", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"}]
    service, run_id = _service(tmp_path, monkeypatch, report)

    result = service.prepare_intent(run_id, "generate_keyframes", estimated_cost_usd=0)

    assert result["status"] == "authorized"
    assert result["approval"] is None
    assert result["execute"] is True


def test_execute_intent_runs_deterministic_provider_and_records_assets(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "static.yaml"
    brief.write_text("id: execute-static\nlane: static-text-ad\nscenes:\n  - overlay: One idea\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    run = orchestrator.execute_content_run(brief, policy={"privacy": "local-only"}, budget={"max_cost_usd": 0})
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    report = [{"id": "static-text-renderer", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"}]
    service = ContentIntentService(orchestrator, CapabilityRouter(report), approvals)

    result = service.execute_intent(run["run_id"], "generate_keyframes", estimated_cost_usd=0)

    assert result["status"] == "completed"
    assert result["provider"] == "static-text-renderer"
    assert len(result["artifacts"]) == 1
    assert Path(result["artifacts"][0]).is_file()


def test_local_intent_does_not_require_approval_infrastructure(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "static.yaml"
    brief.write_text("id: no-ledger\nlane: static-text-ad\nscenes:\n  - overlay: Local works\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    run = orchestrator.execute_content_run(brief, policy={"privacy": "local-only"}, budget={"max_cost_usd": 0})
    report = [{"id": "static-text-renderer", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"}]
    service = ContentIntentService(orchestrator, CapabilityRouter(report), None)

    result = service.execute_intent(run["run_id"], "generate_keyframes", estimated_cost_usd=0)

    assert result["status"] == "completed"


def test_approved_paid_intent_dispatches_only_the_selected_registered_executor(tmp_path: Path, monkeypatch) -> None:
    report = [{"id": "higgsfield-cloud", "roles": ["keyframe"], "mode": "cloud", "cost": "paid", "available": True, "side_effects": ["spend"], "detail": "ready"}]
    service, run_id = _service(tmp_path, monkeypatch, report)
    calls: list[str] = []
    service.executors[("generate_keyframes", "higgsfield-cloud")] = lambda manifest: calls.append(str(manifest)) or {"artifacts": ["generated.png"]}
    pending = service.prepare_intent(run_id, "generate_keyframes", estimated_cost_usd=1.25)
    receipt = service.approvals.approve(pending["approval"]["id"], operator_token="operator-secret", decided_by="owner")

    result = service.execute_intent(
        run_id,
        "generate_keyframes",
        estimated_cost_usd=1.25,
        approval_token=receipt["token"],
    )

    assert calls == [service.orchestrator.store.get_run(run_id)["manifest_path"]]
    assert result["provider"] == "higgsfield-cloud"
    assert result["artifacts"] == ["generated.png"]
    assert service.orchestrator.store.get_run(run_id)["budget"]["spent_usd"] == 1.25


def test_generation_execution_records_privacy_safe_timing_and_mirrors_success(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "static.yaml"
    brief.write_text("id: telemetry-success\nlane: static-text-ad\nscenes:\n  - overlay: Measured\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    run = orchestrator.execute_content_run(brief, policy={"privacy": "local-only"}, budget={"max_cost_usd": 0})
    report = [{"id": "static-text-renderer", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"}]
    ticks = iter((10.0, 11.25))
    mirrored: list[dict] = []
    service = ContentIntentService(
        orchestrator,
        CapabilityRouter(report),
        None,
        monotonic=lambda: next(ticks),
        generation_metric_sink=mirrored.append,
    )

    result = service.execute_intent(run["run_id"], "generate_keyframes", estimated_cost_usd=0)

    events = [event for event in orchestrator.store.get_run(run["run_id"])["events"] if event["kind"].startswith("generation.")]
    assert [event["kind"] for event in events] == ["generation.started", "generation.completed"]
    completed = events[-1]["payload"]
    assert completed == {
        "telemetry_id": completed["telemetry_id"],
        "intent": "generate_keyframes",
        "kind": "image",
        "provider": "static-text-renderer",
        "model": "automatic",
        "status": "completed",
        "duration_ms": 1250,
        "artifact_count": 1,
        "estimated_cost_usd": 0.0,
        "charged_usd": 0.0,
    }
    assert mirrored == [{**completed, "run_id": run["run_id"]}]
    assert "prompt" not in str(events).lower()
    assert result["telemetry"] == completed


def test_generation_failure_records_error_type_without_prompt_or_secret_text(tmp_path: Path, monkeypatch) -> None:
    report = [{"id": "comfyui", "roles": ["keyframe"], "mode": "local", "cost": "local", "available": True, "side_effects": ["filesystem"], "detail": "ready"}]
    service, run_id = _service(tmp_path, monkeypatch, report)
    service.executors[("generate_keyframes", "comfyui")] = lambda _manifest: (_ for _ in ()).throw(
        TimeoutError("prompt and sk-live-secret must never enter telemetry")
    )
    ticks = iter((3.0, 3.4))
    service.monotonic = lambda: next(ticks)

    with pytest.raises(TimeoutError):
        service.execute_intent(run_id, "generate_keyframes", estimated_cost_usd=0)

    failed = [event for event in service.orchestrator.store.get_run(run_id)["events"] if event["kind"] == "generation.failed"][0]
    assert failed["payload"]["status"] == "failed"
    assert failed["payload"]["duration_ms"] == 400
    assert failed["payload"]["error_type"] == "TimeoutError"
    assert "prompt" not in str(failed).lower()
    assert "secret" not in str(failed).lower()
