from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.canvas_history import CanvasGatewayClient, CanvasHistoryStore
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


def _locked_client(
    tmp_path: Path,
    monkeypatch,
    *,
    canvas_records: list[dict] | None = None,
    canvas_workflow_fetcher=None,
    canvas_delete_fetcher=None,
) -> tuple[TestClient, ContentOrchestrator]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    owner_access = OwnerAccess.for_testing(password="owner-passphrase", cipher=cipher)
    canvas_history = CanvasHistoryStore(tmp_path / "canvas-history.sqlite3", cipher=cipher)
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=owner_access,
        private_cipher=cipher,
        canvas_history=canvas_history,
        canvas_history_fetcher=lambda: list(canvas_records or []),
        canvas_media_fetcher=lambda _name: (b"synthetic-private-media", "image/png"),
        canvas_workflow_fetcher=canvas_workflow_fetcher,
        canvas_delete_fetcher=canvas_delete_fetcher,
    )
    return TestClient(app), orchestrator


def test_outer_lock_hides_shell_assets_prompt_tools_and_artifacts(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator = _locked_client(tmp_path, monkeypatch)
    brief = tmp_path / "private-brief.yaml"
    brief.write_text("id: private\nlane: static-text-ad\nconcept: never expose this phrase\nscenes:\n  - overlay: Private\n", encoding="utf-8")
    run = orchestrator.execute_content_run(brief)

    page = client.get("/")
    assert page.status_code == 200
    assert "Hivemind Content Studio is locked" in page.text
    assert 'id="studio-shell"' not in page.text
    assert client.get("/assets/studio.js").status_code == 401
    assert client.get("/api/simple/prompts").status_code == 401
    assert client.post("/api/simple/plan", json={}).status_code == 401
    assert client.get(f"/api/runs/{run['run_id']}/artifacts/missing").status_code == 401


def test_machine_routes_keep_telemetry_and_redacted_run_receipts_available(tmp_path: Path, monkeypatch) -> None:
    client, orchestrator = _locked_client(tmp_path, monkeypatch)
    brief = tmp_path / "machine-brief.yaml"
    brief.write_text("id: machine\nlane: static-text-ad\nconcept: hidden machine prompt\nscenes:\n  - overlay: Hidden\n", encoding="utf-8")
    run = orchestrator.execute_content_run(brief)

    assert client.get("/api/runtime").status_code == 200
    assert client.get("/api/catalog").status_code == 200
    assert client.get("/api/providers").status_code == 200
    assert client.get("/api/telemetry/generations").status_code == 200

    response = client.get(f"/api/runs/{run['run_id']}")
    assert response.status_code == 200
    payload = response.json()
    assert payload["run_id"] == run["run_id"]
    assert payload["privacy"] == "machine-redacted"
    assert payload["artifact_count"] >= 0
    serialized = response.text.lower()
    for forbidden in ("hidden machine prompt", "manifest_path", "artifact_records", "user_prompt", '"brief":{'):
        assert forbidden not in serialized


def test_owner_unlock_uses_same_password_and_24_hour_browser_session(tmp_path: Path, monkeypatch) -> None:
    client, _ = _locked_client(tmp_path, monkeypatch)

    assert client.post("/api/owner/unlock", json={"password": "wrong"}).status_code == 401
    unlocked = client.post("/api/owner/unlock", json={"password": "owner-passphrase"})
    assert unlocked.status_code == 200
    assert unlocked.json()["expires_in_seconds"] == 24 * 60 * 60
    assert "HttpOnly" in unlocked.headers["set-cookie"]
    assert "SameSite=strict" in unlocked.headers["set-cookie"]
    assert 'id="studio-shell"' in client.get("/").text
    assert client.get("/assets/studio.js").status_code == 200
    assert client.get("/api/simple/prompts").status_code == 200

    assert client.post("/api/owner/lock").status_code == 200
    assert "Hivemind Content Studio is locked" in client.get("/").text


def test_canvas_history_import_is_owner_only_metadata_only_and_source_preserving(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "private-output.png.zenc").write_bytes(b"opaque-encrypted-payload")
    records = [{
        "id": "canvas-job-1",
        "status": "success",
        "created_at": "2026-07-15T12:00:00+00:00",
        "finished_at": "2026-07-15T12:00:05+00:00",
        "prompt": "[private prompt hidden]",
        "outputs": [str(tmp_path / "private-output.png")],
        "image_urls": ["/image/private-output.png?token=must-not-persist"],
    }]
    client, _ = _locked_client(tmp_path, monkeypatch, canvas_records=records)

    assert client.get("/api/canvas/history").status_code == 401
    assert client.post("/api/owner/unlock", json={"password": "owner-passphrase"}).status_code == 200

    response = client.get("/api/canvas/history")
    assert response.status_code == 200
    payload = response.json()
    assert payload["source_preserved"] is True
    assert payload["history"][0]["source"] == "canvas"
    assert payload["history"][0]["media_url"].startswith("/api/canvas/history/")
    assert "prompt" not in payload["history"][0]
    assert "must-not-persist" not in response.text
    assert str(tmp_path) not in response.text

    media_url = payload["history"][0]["media_url"]
    media = client.get(media_url)
    assert media.status_code == 200
    assert media.content == b"synthetic-private-media"


def test_canvas_filesystem_history_indexes_every_media_type_without_reading_contents(tmp_path: Path) -> None:
    output_root = tmp_path / "output"
    output_root.mkdir()
    (output_root / "older.png.zenc").write_bytes(b"opaque-encrypted-payload")
    (output_root / "animation.mp4").write_bytes(b"opaque-video-payload")
    (output_root / "model.safetensors").write_bytes(b"not-media")

    records = CanvasGatewayClient(output_roots=[output_root]).filesystem_history()

    output_names = {Path(record["outputs"][0]).name for record in records}
    assert output_names == {"older.png", "animation.mp4"}
    assert all("prompt" not in record for record in records)


def test_canvas_history_still_indexes_files_when_gateway_token_is_unavailable(tmp_path: Path) -> None:
    output_root = tmp_path / "output"
    output_root.mkdir()
    (output_root / "preserved.webp.zenc").write_bytes(b"opaque-encrypted-payload")
    client = CanvasGatewayClient(
        token_file=tmp_path / "missing-token",
        output_roots=[output_root],
        history_file=tmp_path / "missing-history.jsonl",
    )

    records = client.history()

    assert [Path(record["outputs"][0]).name for record in records] == ["preserved.webp"]


def test_canvas_gateway_history_distinguishes_file_fallback_from_durable_jobs(tmp_path: Path, monkeypatch) -> None:
    token_file = tmp_path / "token"
    token_file.write_text("t" * 32, encoding="utf-8")
    empty_root = tmp_path / "output"
    empty_root.mkdir()
    payload = {
        "history": [
            {"id": "fallback", "source": "files", "prompt": "must-not-escape", "outputs": [], "created_at": "2026-07-15T16:51:19+00:00"},
            {"id": "durable", "prompt": "must-not-escape", "outputs": [], "created_at": "2026-06-01T10:00:00+00:00"},
        ]
    }

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(payload).encode("utf-8")

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    client = CanvasGatewayClient(
        token_file=token_file,
        output_roots=[empty_root],
        history_file=tmp_path / "missing-history.jsonl",
    )

    records = {record["id"]: record for record in client.history()}

    assert records["fallback"]["timestamp_source"] == "filesystem"
    assert records["durable"]["timestamp_source"] == "gateway-history"
    assert all("prompt" not in record for record in records.values())


def test_canvas_history_keeps_same_named_outputs_from_distinct_roots(tmp_path: Path) -> None:
    roots = [tmp_path / "comfy", tmp_path / "zimage"]
    for root in roots:
        root.mkdir()
        (root / "shared-name.png.zenc").write_bytes(b"opaque-encrypted-payload")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    store = CanvasHistoryStore(tmp_path / "canvas.sqlite3", cipher=cipher)
    records = CanvasGatewayClient(output_roots=roots).filesystem_history()

    store.sync(records)

    with sqlite3.connect(tmp_path / "canvas.sqlite3") as connection:
        assert connection.execute("SELECT COUNT(*) FROM canvas_history").fetchone()[0] == 2
    assert len(store.list()) == 1


def test_canvas_history_pages_deduplicated_outputs_and_filters_by_file_format(tmp_path: Path) -> None:
    output_root = tmp_path / "output"
    output_root.mkdir()
    for index, suffix in enumerate(("png", "mp4", "webp", "png"), start=1):
        path = output_root / f"item-{index}.{suffix}.zenc"
        path.write_bytes(b"opaque-encrypted-payload")
        timestamp = 1_700_000_000 + index
        os.utime(path, (timestamp, timestamp))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    store = CanvasHistoryStore(tmp_path / "canvas.sqlite3", cipher=cipher)
    store.sync(CanvasGatewayClient(output_roots=[output_root]).filesystem_history())

    first = store.page(page=1, page_size=2)
    second = store.page(page=2, page_size=2)
    pngs = store.page(page=1, page_size=10, file_format="png")

    assert first["total"] == 4
    assert first["has_more"] is True
    assert len(first["items"]) == 2
    assert len(second["items"]) == 2
    assert second["has_more"] is False
    assert {item["file_format"] for item in pngs["items"]} == {"png"}
    assert pngs["total"] == 2
    assert set(first["filters"]["formats"]) == {"mp4", "png", "webp"}


def test_canvas_history_model_filter_uses_encrypted_owner_metadata(tmp_path: Path) -> None:
    output_root = tmp_path / "output"
    output_root.mkdir()
    first_output = output_root / "first.png.zenc"
    second_output = output_root / "second.png.zenc"
    first_output.write_bytes(b"opaque-encrypted-payload")
    second_output.write_bytes(b"opaque-encrypted-payload")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    store = CanvasHistoryStore(tmp_path / "canvas.sqlite3", cipher=cipher)
    store.sync(CanvasGatewayClient(output_roots=[output_root]).filesystem_history())
    items = store.list()

    store.remember_provenance(items[0]["history_id"], models=["model-a.safetensors"], seeds=[{"value": 42, "mode": "fixed"}])
    store.remember_provenance(items[1]["history_id"], models=["model-b.safetensors"], seeds=[])

    page = store.page(page=1, page_size=10, model="model-a.safetensors")
    assert page["total"] == 1
    assert page["items"][0]["models"] == ["model-a.safetensors"]
    raw = (tmp_path / "canvas.sqlite3").read_bytes()
    assert b"model-a.safetensors" not in raw


def test_owner_can_fetch_ciphertext_workflow_and_confirm_complete_canvas_purge(tmp_path: Path, monkeypatch) -> None:
    output = tmp_path / "purge-me.png.zenc"
    output.write_bytes(b"opaque-encrypted-payload")
    records = [{
        "id": "canvas-job-delete",
        "status": "success",
        "created_at": "2026-07-15T12:00:00+00:00",
        "finished_at": "2026-07-15T12:00:05+00:00",
        "outputs": [str(output.with_name("purge-me.png"))],
    }]
    envelope = {
        "encrypted": True,
        "format": "comfyui-mobile-encrypted-workflow",
        "version": 1,
        "salt": "ciphertext-only",
        "iv": "ciphertext-only",
        "data": "ciphertext-only",
    }
    deleted_names: list[str] = []
    def delete_output(name: str) -> dict:
        deleted_names.append(Path(name).name)
        output.unlink(missing_ok=True)
        return {"ok": True, "deleted_files": 1}

    client, _ = _locked_client(
        tmp_path,
        monkeypatch,
        canvas_records=records,
        canvas_workflow_fetcher=lambda _name: envelope,
        canvas_delete_fetcher=delete_output,
    )
    assert client.post("/api/owner/unlock", json={"password": "owner-passphrase"}).status_code == 200
    item = client.get("/api/canvas/history?page=1&page_size=10").json()["history"][0]

    workflow = client.get(f"/api/canvas/history/{item['history_id']}/workflow")
    assert workflow.status_code == 200
    assert workflow.json()["workflow"] == envelope
    assert str(tmp_path) not in workflow.text

    refused = client.request("DELETE", f"/api/canvas/history/{item['history_id']}", json={"confirm": False})
    assert refused.status_code == 400
    deleted = client.request("DELETE", f"/api/canvas/history/{item['history_id']}", json={"confirm": True})
    assert deleted.status_code == 200
    assert deleted_names == ["purge-me.png"]
    assert client.get("/api/canvas/history?page=1&page_size=10").json()["history"] == []


def test_canvas_history_prefers_authoritative_gateway_time_and_labels_uncertain_imports(tmp_path: Path) -> None:
    output = tmp_path / "history-video.mp4.zenc"
    output.write_bytes(b"opaque-encrypted-payload")
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    store = CanvasHistoryStore(tmp_path / "canvas.sqlite3", cipher=cipher)

    store.sync([{
        "id": "file-record",
        "status": "success",
        "created_at": "2026-07-15T16:51:19+00:00",
        "finished_at": "2026-07-15T16:51:19+00:00",
        "outputs": [str(output)],
        "timestamp_source": "imported",
    }])
    assert store.list()[0]["time_label"] == "Imported from Canvas"

    store.sync([{
        "id": "gateway-record",
        "status": "success",
        "created_at": "2026-06-10T09:00:00+00:00",
        "finished_at": "2026-06-10T09:01:00+00:00",
        "outputs": [str(output)],
        "timestamp_source": "gateway-history",
    }])

    item = store.list()[0]
    assert item["created_at"] == "2026-06-10T09:01:00+00:00"
    assert "time_label" not in item


def test_prompt_history_fields_are_ciphertext_at_rest(tmp_path: Path) -> None:
    from hivemind_content_studio.prompt_history import PromptHistoryStore

    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    store = PromptHistoryStore(tmp_path / "prompts.sqlite3", cipher=cipher)
    stored = store.record(prompt="private final prompt", user_prompt="private original", title="private title")

    assert stored["prompt"] == "private final prompt"
    raw = (tmp_path / "prompts.sqlite3").read_bytes()
    assert b"private final prompt" not in raw
    assert b"private original" not in raw
    assert b"private title" not in raw
