"""One unreadable record must never take the run list down with it.

On 2026-09-04 GET /api/runs answered 500 on the owner's own machine. A single
run planned in July still pointed at an absolute manifest path under a checkout
that had since moved, `_envelope` raised FileNotFoundError out of the list
comprehension that builds every run, and Productions was empty behind an
incident id — for the owner AND for every agent, since the route needs no
session. Two halves are pinned here: the read tolerates a broken row, and the
row stops being broken by moving, because manifest paths are stored relative to
the data root and resolved on the way out.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator, RunRecordUnavailable
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


def _brief(tmp_path: Path, name: str) -> Path:
    brief = tmp_path / f"{name}.yaml"
    brief.write_text(
        f"id: {name}\nlane: static-text-ad\ntitle: {name}\nscenes:\n  - overlay: Test\n",
        encoding="utf-8",
    )
    return brief


@pytest.fixture
def studio(tmp_path: Path, monkeypatch) -> ContentOrchestrator:
    """An orchestrator whose runs live inside its own data root."""
    root = tmp_path / "data"
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(root))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(root / "runs"))
    return ContentOrchestrator(RunStore(root / "content-studio.sqlite3"))


def _stored_path(database: Path, run_id: str) -> str:
    connection = sqlite3.connect(database)
    try:
        row = connection.execute("SELECT manifest_path FROM runs WHERE run_id=?", (run_id,)).fetchone()
    finally:
        connection.close()
    assert row is not None
    return str(row[0])


def test_a_run_whose_manifest_is_deleted_still_lists_with_a_degraded_card(studio, tmp_path: Path) -> None:
    kept = studio.execute_content_run(_brief(tmp_path, "kept"))
    lost = studio.execute_content_run(_brief(tmp_path, "lost"))
    Path(lost["manifest_path"]).unlink()

    listed = {run["run_id"]: run for run in studio.list_runs()}

    assert set(listed) == {kept["run_id"], lost["run_id"]}, "the good run must survive the bad one"
    assert listed[kept["run_id"]]["brief"]["title"] == "kept"
    assert "record_status" not in listed[kept["run_id"]]

    broken = listed[lost["run_id"]]
    assert broken["record_status"] == "unreadable"
    assert broken["ok"] is False
    assert broken["record_failure"]["reason"] == "missing"
    # A sentence, then the evidence behind it — never the traceback as the
    # sentence (the studio's rule for every failure it shows).
    assert broken["record_failure"]["message"] == (
        "This production's record file is missing, so the studio cannot read it."
    )
    assert "FileNotFoundError" in broken["record_failure"]["detail"]
    # Everything the store itself knows is still true and still carried.
    assert broken["status"] == lost["status"]
    assert [step["step_id"] for step in broken["steps"]] == [step["step_id"] for step in lost["steps"]]
    assert broken["artifact_records"] == []


def test_several_broken_records_never_hide_the_good_ones(studio, tmp_path: Path) -> None:
    runs = [studio.execute_content_run(_brief(tmp_path, f"run{index}")) for index in range(5)]
    for run in runs[:3]:
        Path(run["manifest_path"]).unlink()

    listed = studio.list_runs()

    assert len(listed) == 5
    assert sum(1 for run in listed if run.get("record_status") == "unreadable") == 3
    readable = [run for run in listed if run.get("record_status") is None]
    assert sorted(run["brief"]["title"] for run in readable) == ["run3", "run4"]


def test_a_record_that_is_not_a_manifest_degrades_rather_than_raising(studio, tmp_path: Path) -> None:
    run = studio.execute_content_run(_brief(tmp_path, "corrupt"))
    Path(run["manifest_path"]).write_text("{ not json", encoding="utf-8")

    degraded = studio.get_run(run["run_id"])

    assert degraded["record_status"] == "unreadable"
    assert degraded["record_failure"]["reason"] == "unreadable"


def test_driving_a_run_without_its_record_says_so_instead_of_raising_a_filesystem_error(studio, tmp_path: Path) -> None:
    run = studio.execute_content_run(_brief(tmp_path, "undrivable"))
    Path(run["manifest_path"]).unlink()

    with pytest.raises(RunRecordUnavailable) as raised:
        studio.resume_run(run["run_id"])

    assert str(raised.value) == "This production's record file is missing, so the studio cannot read it."
    assert raised.value.reason == "missing"


def test_a_new_run_records_a_manifest_path_that_survives_moving_the_folder(studio, tmp_path: Path) -> None:
    run = studio.execute_content_run(_brief(tmp_path, "portable"))
    database = tmp_path / "data" / "content-studio.sqlite3"

    stored = _stored_path(database, run["run_id"])
    assert not Path(stored).is_absolute(), "an absolute path is what orphaned the July run"
    assert stored == f"runs/{run['run_id']}/manifest.json"

    moved = tmp_path / "moved-data"
    shutil.move(str(tmp_path / "data"), str(moved))
    reopened = ContentOrchestrator(RunStore(moved / "content-studio.sqlite3"))

    listed = reopened.list_runs()
    assert [entry["run_id"] for entry in listed] == [run["run_id"]]
    assert listed[0].get("record_status") is None, "a moved folder must not degrade a run"
    assert listed[0]["brief"]["title"] == "portable"
    assert Path(listed[0]["manifest_path"]).is_relative_to(moved)


def test_a_row_written_before_the_change_still_resolves_and_is_migrated(studio, tmp_path: Path) -> None:
    run = studio.execute_content_run(_brief(tmp_path, "legacy"))
    database = tmp_path / "data" / "content-studio.sqlite3"
    # Exactly the owner's row: an absolute path under a checkout that has moved.
    legacy = f"/Users/someone/comfy/hivemind-content-studio/data/runs/{run['run_id']}/manifest.json"
    connection = sqlite3.connect(database)
    try:
        connection.execute("UPDATE runs SET manifest_path=? WHERE run_id=?", (legacy, run["run_id"]))
        connection.commit()
    finally:
        connection.close()

    reopened = ContentOrchestrator(RunStore(database))
    listed = reopened.list_runs()

    assert listed[0].get("record_status") is None, "the manifest is right here; nothing is degraded"
    assert listed[0]["brief"]["title"] == "legacy"
    assert _stored_path(database, run["run_id"]) == f"runs/{run['run_id']}/manifest.json"


def test_an_absolute_row_the_studio_cannot_place_is_left_alone(tmp_path: Path, monkeypatch) -> None:
    """A runs folder outside the data root keeps working exactly as before."""
    root = tmp_path / "data"
    elsewhere = tmp_path / "elsewhere"
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(root))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(elsewhere))
    orchestrator = ContentOrchestrator(RunStore(root / "content-studio.sqlite3"))

    run = orchestrator.execute_content_run(_brief(tmp_path, "outside"))

    stored = _stored_path(root / "content-studio.sqlite3", run["run_id"])
    assert Path(stored).is_absolute()
    assert orchestrator.list_runs()[0]["brief"]["title"] == "outside"


def _client(tmp_path: Path, monkeypatch) -> tuple[TestClient, ContentOrchestrator]:
    root = tmp_path / "data"
    monkeypatch.setenv("CONTENT_STUDIO_DATA_DIR", str(root))
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(root / "runs"))
    orchestrator = ContentOrchestrator(RunStore(root / "content-studio.sqlite3"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"}).status_code == 200
    return client, orchestrator


def test_the_runs_route_answers_200_with_a_degraded_card_when_a_record_is_missing(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator = _client(tmp_path, monkeypatch)
    kept = orchestrator.execute_content_run(_brief(tmp_path, "kept"))
    lost = orchestrator.execute_content_run(_brief(tmp_path, "lost"))
    Path(lost["manifest_path"]).unlink()

    response = client.get("/api/runs")

    assert response.status_code == 200, "one stale path may not take the list down"
    listed = {run["run_id"]: run for run in response.json()["runs"]}
    assert set(listed) == {kept["run_id"], lost["run_id"]}
    assert listed[kept["run_id"]]["brief"]["title"] == "kept"
    assert listed[lost["run_id"]]["record_status"] == "unreadable"
    assert client.get(f"/api/runs/{lost['run_id']}").status_code == 200


def test_an_agent_reading_the_machine_surface_is_told_the_record_is_gone(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator = _client(tmp_path, monkeypatch)
    lost = orchestrator.execute_content_run(_brief(tmp_path, "lost"))
    Path(lost["manifest_path"]).unlink()
    assert client.post("/api/owner/lock").status_code == 200

    response = client.get("/api/runs")

    assert response.status_code == 200
    receipt = response.json()["runs"][0]
    assert receipt["record_status"] == "unreadable"
    assert receipt["record_reason"] == "missing"
    # Redaction still holds: no path, no prompt, no traceback on the machine lane.
    assert "record_failure" not in receipt
    assert "manifest_path" not in json.dumps(receipt)


def test_resuming_a_run_without_its_record_is_a_conflict_not_an_incident(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator = _client(tmp_path, monkeypatch)
    lost = orchestrator.execute_content_run(_brief(tmp_path, "lost"))
    Path(lost["manifest_path"]).unlink()

    resumed = client.post(f"/api/runs/{lost['run_id']}/resume")
    retried = client.post(f"/api/runs/{lost['run_id']}/retry", json={"step_id": "script"})

    for response in (resumed, retried):
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert detail == "This production's record file is missing, so the studio cannot read it."
        assert "Traceback" not in detail and "/" not in detail
