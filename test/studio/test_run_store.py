from __future__ import annotations

from pathlib import Path

from hivemind_content_studio.run_store import RunStore


def test_run_store_persists_steps_events_and_next_actions(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs.sqlite3")
    store.create_run(
        run_id="run-1",
        manifest_path=tmp_path / "manifest.json",
        lane="stickman-performance-ad",
        steps=["script", "keyframes", "voice", "assembly"],
        policy={"privacy": "local-first"},
        budget={"max_cost_usd": 5},
    )

    store.set_step_status("run-1", "script", "awaiting_agent", next_actions=[{"tool": "attach_agent_script"}])
    store.append_event("run-1", "step.blocked", {"step": "script"})
    state = store.get_run("run-1")

    assert state["status"] == "awaiting_agent"
    assert state["current_step"] == "script"
    assert state["steps"][0]["next_actions"] == [{"tool": "attach_agent_script"}]
    assert state["events"][-1]["kind"] == "step.blocked"
    assert state["policy"]["privacy"] == "local-first"


def test_cancel_resume_and_retry_are_durable_state_transitions(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs.sqlite3")
    store.create_run(run_id="run-2", manifest_path=tmp_path / "manifest.json", lane="animation", steps=["script", "keyframes"], policy={}, budget={})
    store.set_step_status("run-2", "script", "failed", error="runtime failed")

    retried = store.retry_step("run-2", "script")
    assert retried["status"] == "pending"
    assert retried["attempts"] == 1

    store.cancel_run("run-2", "operator stop")
    assert store.get_run("run-2")["status"] == "cancelled"
    store.resume_run("run-2")
    assert store.get_run("run-2")["status"] == "queued"


def test_spend_is_atomic_and_cannot_exceed_the_run_budget(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs.sqlite3")
    store.create_run(run_id="run-3", manifest_path=tmp_path / "manifest.json", lane="animation", steps=["script"], policy={}, budget={"max_cost_usd": 2.0, "spent_usd": 0.0})

    assert store.record_spend("run-3", 1.25, provider="higgsfield-cloud", intent="generate_keyframes")["spent_usd"] == 1.25

    try:
        store.record_spend("run-3", 1.0, provider="higgsfield-cloud", intent="generate_keyframes")
    except ValueError as exc:
        assert "budget" in str(exc).lower()
    else:
        raise AssertionError("overspend should have been rejected")
    assert store.get_run("run-3")["budget"]["spent_usd"] == 1.25
