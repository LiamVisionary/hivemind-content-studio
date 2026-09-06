"""Automatic, prompt-free telemetry for generations the STUDIO starts.

Liam generated with MiniMax H3 Turbo on this Mac (2026-09-06) and got "Media
Studio did not return a job id: the backend redacted the reason
(machine-private mode)". The real reason — ComfyUI refused the graph because
the local lane has no SpectrumApplyMiniMaxH3 custom node — existed only as a
stderr line in the supervisor's node-services log. No telemetry row, no
control-api log line, no sentence with the fix in it. These tests pin the
three things that changed: the classification survives redaction, the
studio's attempts are recorded automatically (identifiers only), and the
Activity feed shows why."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.generation_telemetry import generation_telemetry_snapshot
from hivemind_content_studio.media_studio import MediaStudioStartError
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.studio_telemetry import (
    StudioGenerationLedger,
    classify_exception,
    failure_hint,
    lora_base_for_workflow,
    safe_failure,
)

MISSING_NODE = {
    "code": "missing_node_type",
    "node_class": "SpectrumApplyMiniMaxH3",
    "node_id": "30",
    "message": "Node 'SpectrumApplyMiniMaxH3' not found. The custom node may not be installed.",
}


# ── the classification is identifiers only ───────────────────────────────


def test_safe_failure_keeps_identifiers_and_drops_everything_else() -> None:
    failure = safe_failure({
        **MISSING_NODE,
        "details": "Node ID '#30'",
        "value": "a prompt about a dog on /Users/liam/private/dog.png",
        "node_classes": ["SpectrumApplyMiniMaxH3", "not a class name", "LoadImage", "LoadImage"],
    })
    assert failure == {
        "code": "missing_node_type",
        "node_class": "SpectrumApplyMiniMaxH3",
        "node_id": "30",
        "node_classes": ["SpectrumApplyMiniMaxH3", "LoadImage"],
    }
    # A code that is not an identifier is no classification at all.
    assert safe_failure({"code": "rm -rf /"}) is None
    assert safe_failure("missing_node_type") is None


def test_the_hint_names_the_node_and_the_fix() -> None:
    hint = failure_hint(safe_failure(MISSING_NODE))
    assert "SpectrumApplyMiniMaxH3" in hint
    assert "Install that node pack" in hint
    assert "Run on" in hint
    assert failure_hint({"code": "made_up_code"}) == ""


def test_classify_exception_reads_the_carried_failure_or_the_message_shape() -> None:
    carried = MediaStudioStartError("refused", failure=MISSING_NODE)
    assert classify_exception(carried) == safe_failure(MISSING_NODE)
    assert classify_exception(RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")) == {"code": "out_of_memory"}
    assert classify_exception(TimeoutError("timed out")) == {"code": "timeout"}
    assert classify_exception(RuntimeError("something else"), default="backend_refused") == {"code": "backend_refused"}


# ── the ledger writes what is allowed and nothing else ────────────────────


def test_the_ledger_keeps_allowlisted_columns_and_never_prompt_text(tmp_path: Path) -> None:
    ledger = StudioGenerationLedger(tmp_path / "studio-generations.jsonl")
    row = ledger.record(
        telemetry_id="gen_abc",
        status="failed",
        stage="start",
        kind="video",
        surface="studio",
        provider="Managed Media Studio MCP",
        workflow_id="minimax-h3-turbo",
        run_on="vast:48352597",
        duration_ms=812.6,
        error_type="MediaStudioStartError",
        failure_code="missing_node_type",
        failure_node_class="SpectrumApplyMiniMaxH3",
        lora_count=2,
        lora_base="minimax-h3",
        # None of these are columns: they must not reach the file.
        loras=[{"id": "liam-private-style-v3.safetensors", "strength": 0.8}],
        lora_names=["liam-private-style-v3"],
        prompt="a dog on the beach",
        detail="Node 'X' not found at /Users/liam/private/x.png",
        image_path="/Users/liam/private/x.png",
    )
    assert row["failure_code"] == "missing_node_type"
    assert row["duration_ms"] == 812
    text = (tmp_path / "studio-generations.jsonl").read_text()
    assert "a dog on the beach" not in text
    assert "/Users/liam" not in text
    assert "prompt" not in text and "detail" not in text
    assert "liam-private-style" not in text and "safetensors" not in text
    assert row["lora_count"] == 2 and row["lora_base"] == "minimax-h3"
    # A row without an id or with an unknown status is not a row.
    assert ledger.record(status="failed") == {}
    assert ledger.record(telemetry_id="x", status="exploded") == {}
    assert [r["telemetry_id"] for r in ledger.rows()] == ["gen_abc"]


def test_a_loras_base_comes_from_the_workflow_it_rides_on() -> None:
    assert lora_base_for_workflow("minimax-h3-turbo") == "minimax-h3"
    assert lora_base_for_workflow("ltx23-eros-fast") == "ltx-2.3"
    assert lora_base_for_workflow("krea2-identity") == "krea2"
    assert lora_base_for_workflow("zimage-turbo") == "zimage"
    assert lora_base_for_workflow("somefamily-variant") == "somefamily"
    assert lora_base_for_workflow("") == ""


def test_the_ledger_folds_itself_past_its_ceiling(tmp_path: Path, monkeypatch) -> None:
    from hivemind_content_studio import studio_telemetry

    monkeypatch.setattr(studio_telemetry, "MAX_RECORDS", 6)
    monkeypatch.setattr(studio_telemetry, "KEEP_RECORDS", 4)
    ledger = StudioGenerationLedger(tmp_path / "ledger.jsonl")
    for index in range(7):
        ledger.record(telemetry_id=f"gen_{index}", status="started", kind="video")
    kept = [row["telemetry_id"] for row in ledger.rows()]
    assert kept == ["gen_3", "gen_4", "gen_5", "gen_6"]


# ── the snapshot shows studio attempts next to run attempts ───────────────


def test_snapshot_merges_studio_attempts_with_their_hint(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    store = RunStore(tmp_path / "state.sqlite3")
    ledger = StudioGenerationLedger.beside(store.path)
    ledger.record(telemetry_id="gen_s1", status="started", kind="video", surface="studio",
                  provider="Media Studio", workflow_id="minimax-h3-turbo", model="minimax-h3-turbo")
    ledger.record(telemetry_id="gen_s1", status="failed", stage="start", kind="video", surface="studio",
                  provider="Media Studio", workflow_id="minimax-h3-turbo", model="minimax-h3-turbo",
                  duration_ms=900, error_type="MediaStudioStartError",
                  failure_code="missing_node_type", failure_node_class="SpectrumApplyMiniMaxH3")
    ledger.record(telemetry_id="gen_s2", status="started", kind="video", surface="studio", provider="Media Studio")
    ledger.record(telemetry_id="gen_s2", status="completed", stage="render", kind="video", surface="studio",
                  provider="Media Studio", duration_ms=61000, artifact_count=1)

    # The ledger is found from the store alone (the CLI and the MCP resource
    # pass nothing else), and an explicit ledger is honoured too.
    for snapshot in (
        generation_telemetry_snapshot(store, limit=20),
        generation_telemetry_snapshot(store, limit=20, studio_ledger=ledger),
    ):
        assert snapshot["summary"]["attempts"] == 2
        assert snapshot["summary"]["failed"] == 1
        assert snapshot["summary"]["completed"] == 1
        [failure_row] = snapshot["by_failure"]
        assert failure_row["failure_code"] == "missing_node_type"
        assert failure_row["attempts"] == 1 and failure_row["failed"] == 1
        by_id = {item["telemetry_id"]: item for item in snapshot["recent_attempts"]}
        refused = by_id["gen_s1"]
        assert refused["status"] == "failed"
        assert refused["surface"] == "studio"
        assert refused["workflow_id"] == "minimax-h3-turbo"
        assert refused["failure_code"] == "missing_node_type"
        assert refused["failure_node_class"] == "SpectrumApplyMiniMaxH3"
        assert "Install that node pack" in refused["failure_hint"]
        assert refused["run_id"] == ""
        assert by_id["gen_s2"]["status"] == "completed"
        assert by_id["gen_s2"]["duration_ms"] == 61000
        assert "prompt" not in json.dumps(snapshot).lower().replace("prompts_", "").replace("prompts,", "")


# ── the studio route records every start, refused or not ──────────────────


def _client(tmp_path: Path, monkeypatch) -> tuple[TestClient, ContentOrchestrator]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    owner_access = OwnerAccess.for_testing(password="test-owner-password", cipher=cipher)
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=owner_access,
        private_cipher=cipher,
    )
    client = TestClient(app)
    response = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "test-owner-password"})
    assert response.status_code == 200
    return client, orchestrator


def _png_data_url() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def test_a_refused_start_is_recorded_with_its_code_and_answered_with_the_fix(tmp_path: Path, monkeypatch) -> None:
    def refusing_start(**kwargs):
        raise MediaStudioStartError(failure_hint(safe_failure(MISSING_NODE)), failure=MISSING_NODE)

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", refusing_start)
    client, orchestrator = _client(tmp_path, monkeypatch)

    response = client.post("/api/media-studio/video/start", json={
        "prompt": "a red fox trotting through snow",
        "workflow_id": "minimax-h3-turbo",
        "run_on": "vast:48352597",
        "image_base64": _png_data_url(),
        "duration_seconds": 2,
        "loras": [{"id": "liam-secret-look-v2.safetensors", "strength": 0.9}],
    })
    assert response.status_code == 503
    assert "SpectrumApplyMiniMaxH3" in response.json()["detail"]
    assert "Install that node pack" in response.json()["detail"]
    assert "redacted" not in response.json()["detail"]

    telemetry = client.get("/api/telemetry/generations").json()
    assert telemetry["summary"] == {**telemetry["summary"], "attempts": 1, "failed": 1}
    [attempt] = telemetry["recent_attempts"]
    assert attempt["status"] == "failed"
    assert attempt["stage"] == "start"
    assert attempt["surface"] == "studio"
    assert attempt["workflow_id"] == "minimax-h3-turbo"
    assert attempt["run_on"] == "vast:48352597"
    assert attempt["failure_code"] == "missing_node_type"
    assert attempt["failure_node_class"] == "SpectrumApplyMiniMaxH3"
    assert attempt["error_type"] == "MediaStudioStartError"
    # LoRAs: how many and for what — never which.
    assert attempt["lora_count"] == 1
    assert attempt["lora_base"] == "minimax-h3"
    assert "liam-secret-look" not in json.dumps(telemetry)
    assert "red fox" not in json.dumps(telemetry)

    ledger_text = (Path(orchestrator.store.path).parent / "studio-generations.jsonl").read_text()
    assert "red fox" not in ledger_text
    assert "liam-secret-look" not in ledger_text and "safetensors" not in ledger_text
    assert "missing_node_type" in ledger_text


def test_a_generation_that_runs_is_recorded_started_then_completed(tmp_path: Path, monkeypatch) -> None:
    import time

    def fake_start(**kwargs):
        return {"job_id": "job-t-1", "uploaded_names": [], "provider": "Managed Media Studio MCP"}

    def fake_finish(job_id, *, uploaded_names=None, output_dir=None, **_):
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        out = Path(output_dir) / "t.mp4"
        out.write_bytes(b"mock-video")
        return {"job_id": job_id, "provider": "Managed Media Studio MCP", "output": str(out), "qa": {"ok": True}}

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_start", fake_start)
    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_finish", fake_finish)
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_check",
        lambda job_id, **_: {"status": "completed", "failed": False, "error": "", "video_url": "http://g/v.mp4", "progress": 1.0},
    )
    client, _ = _client(tmp_path, monkeypatch)
    queued = client.post("/api/media-studio/video/start", json={
        "prompt": "slow push in", "workflow_id": "ltx23-eros-fast", "image_base64": _png_data_url(), "duration_seconds": 2,
    })
    assert queued.status_code == 200
    for _ in range(100):
        if client.get("/api/media-studio/video/job/job-t-1").json().get("status") != "running":
            break
        time.sleep(0.05)

    telemetry = client.get("/api/telemetry/generations").json()
    [attempt] = telemetry["recent_attempts"]
    assert attempt["status"] == "completed"
    assert attempt["provider"] == "Managed Media Studio MCP"
    assert attempt["workflow_id"] == "ltx23-eros-fast"
    assert attempt["artifact_count"] == 1
    # The size of the clip — measured before it was sealed — and never its
    # name or its bytes: enough to tell a real output from an empty one.
    assert attempt["artifact_bytes"] == len(b"mock-video")
    assert "t.mp4" not in json.dumps(telemetry)
    assert attempt["duration_ms"] >= 0
    assert "failure_code" not in attempt
    assert "slow push in" not in json.dumps(telemetry)


def test_a_render_failure_is_recorded_with_a_shape_code(tmp_path: Path, monkeypatch) -> None:
    import time

    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_start",
        lambda **_: {"job_id": "job-oom", "uploaded_names": [], "provider": "Media Studio"},
    )

    def oom_finish(job_id, **_):
        raise RuntimeError("Media Studio job failed: CUDA out of memory. Tried to allocate 4.00 GiB at /Users/liam/x")

    monkeypatch.setattr("hivemind_content_studio.control_api.run_media_studio_video_finish", oom_finish)
    client, _ = _client(tmp_path, monkeypatch)
    assert client.post("/api/media-studio/video/start", json={
        "prompt": "p", "workflow_id": "ltx23-eros-fast", "image_base64": _png_data_url(), "duration_seconds": 2,
    }).status_code == 200
    for _ in range(100):
        if client.get("/api/media-studio/video/job/job-oom").json().get("status") != "running":
            break
        time.sleep(0.05)
    [attempt] = client.get("/api/telemetry/generations").json()["recent_attempts"]
    assert attempt["status"] == "failed"
    assert attempt["stage"] == "render"
    assert attempt["failure_code"] == "out_of_memory"
    assert "/Users/liam" not in json.dumps(attempt)


# ── the MCP receipt decodes into the same classification ──────────────────


def test_start_video_turns_a_classified_receipt_into_the_hint(monkeypatch, tmp_path: Path) -> None:
    from hivemind_content_studio import media_studio

    class FakeClient:
        def __init__(self, *_a, **_k):
            pass

        def call_tool(self, tool, arguments, timeout=None):
            # Exactly what the machine-private MCP now answers for the H3 refusal:
            # no message beyond the machine-safe one, the classification beside it.
            payload = {
                "ok": False, "privacy": "machine-redacted", "status": 400, "error_type": "MediaStudioError",
                "error": "The ComfyUI lane that took this job does not have the custom node SpectrumApplyMiniMaxH3 installed, "
                         "so the graph was refused before rendering.",
                "failure": {"code": "missing_node_type", "node_class": "SpectrumApplyMiniMaxH3", "node_id": "30"},
                "prompts_redacted": True, "media_redacted": True,
            }
            return {"isError": True, "content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload}

    descriptor = media_studio.MediaStudioDescriptor(
        app_id="test", app_name="Test Media Studio", mcp_url="http://127.0.0.1:1/mcp", upload_base="http://127.0.0.1:1",
        auth_env_key=None, tool="media_generate_video", job_tool="media_get_job", workflow_id=None,
    )
    monkeypatch.setattr(media_studio, "_required_descriptor", lambda: descriptor)
    monkeypatch.setattr(media_studio, "_client", lambda *_a, **_k: FakeClient())
    monkeypatch.setattr(media_studio, "_video_frame_grid_for", lambda *_a, **_k: None, raising=False)

    try:
        media_studio.start_video(prompt="a red fox", workflow_id="minimax-h3-turbo", duration_seconds=2)
    except MediaStudioStartError as exc:
        assert exc.failure == {"code": "missing_node_type", "node_class": "SpectrumApplyMiniMaxH3", "node_id": "30"}
        assert "SpectrumApplyMiniMaxH3" in str(exc)
        assert "Install that node pack" in str(exc)
        assert "redacted" not in str(exc)
    else:
        raise AssertionError("start_video accepted a refusal")


def test_an_unclassified_redacted_receipt_still_says_where_the_reason_is(monkeypatch) -> None:
    from hivemind_content_studio import media_studio

    class FakeClient:
        def call_tool(self, tool, arguments, timeout=None):
            payload = {"ok": False, "privacy": "machine-redacted", "error_type": "MediaStudioError"}
            return {"isError": True, "content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload}

    descriptor = media_studio.MediaStudioDescriptor(
        app_id="test", app_name="Test Media Studio", mcp_url="http://127.0.0.1:1/mcp", upload_base="http://127.0.0.1:1",
        auth_env_key=None, tool="media_generate_video", job_tool="media_get_job", workflow_id=None,
    )
    monkeypatch.setattr(media_studio, "_required_descriptor", lambda: descriptor)
    monkeypatch.setattr(media_studio, "_client", lambda *_a, **_k: FakeClient())
    try:
        media_studio.start_video(prompt="x", workflow_id="minimax-h3-turbo", duration_seconds=2)
    except MediaStudioStartError as exc:
        assert exc.failure is None
        assert "redacted the reason" in str(exc)
    else:
        raise AssertionError("start_video accepted a refusal")
