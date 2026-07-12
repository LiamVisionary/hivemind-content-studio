from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.agent_runtime import attach_script
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.run_store import RunStore


def test_execute_run_returns_agent_next_action_instead_of_requiring_manual_tool_discovery(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: agent-first\nlane: stickman-performance-ad\nvoice:\n  enabled: false\nscenes:\n  - beat: Hook\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))

    result = orchestrator.execute_content_run(brief)

    assert result["status"] == "awaiting_agent"
    assert result["current_step"] == "script"
    assert result["next_actions"][0]["intent"] == "attach_script"
    assert result["next_actions"][0]["tool"] == "attach_agent_script"


def test_resume_runs_safe_local_steps_until_semantic_evaluation_is_needed(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        "id: local-run\nlane: stickman-performance-ad\nvoice:\n  enabled: false\nscenes:\n  - beat: Hook\n    overlay: One clear idea\n    duration_seconds: 1\n",
        encoding="utf-8",
    )
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    initial = orchestrator.execute_content_run(brief)
    script = tmp_path / "script.md"
    script.write_text("# Script\n\nOne clear idea.\n", encoding="utf-8")
    attach_script(initial["manifest_path"], script, runtime="test-agent")

    result = orchestrator.resume_run(initial["run_id"])

    assert result["status"] == "awaiting_evaluation"
    assert result["current_step"] == "evaluation"
    assert result["next_actions"][0]["intent"] == "evaluate_content"
    assert Path(result["artifacts"]["final_video"]).is_file()
    generation_events = [event for event in result["events"] if event["kind"].startswith("generation.")]
    assert [event["kind"] for event in generation_events] == ["generation.started", "generation.completed"]
    assert generation_events[-1]["payload"]["provider"] == "stickman-renderer"
    assert generation_events[-1]["payload"]["kind"] == "image"
    assert generation_events[-1]["payload"]["artifact_count"] == 1


def test_orchestrator_lists_and_cancels_runs(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    brief = tmp_path / "brief.yaml"
    brief.write_text("id: cancel-me\nlane: animation\nscenes: []\n", encoding="utf-8")
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    created = orchestrator.execute_content_run(brief)

    cancelled = orchestrator.cancel_run(created["run_id"], "no longer needed")

    assert cancelled["status"] == "cancelled"
    assert [item["run_id"] for item in orchestrator.list_runs()] == [created["run_id"]]
