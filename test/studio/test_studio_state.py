"""Composer/studio state persists encrypted at rest and only for the owner."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import ENCRYPTED_PREFIX, OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.studio_state import StudioStateStore


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    return client


def test_studio_state_roundtrip_is_owner_only_and_encrypted_at_rest(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    draft = {"image": {"prompt": "a private composer draft", "references": ["/api/media-studio/references/a.png"]}}

    assert client.put("/api/studio-state/opengen-composer", json={"state": draft}).status_code == 200
    assert client.get("/api/studio-state/opengen-composer").json()["state"] == draft
    assert client.get("/api/studio-state/absent-key").json()["state"] == {}

    with sqlite3.connect(tmp_path / "studio-state.sqlite3") as connection:
        stored = [row[0] for row in connection.execute("SELECT value FROM studio_state")]
    assert stored and all(value.startswith(ENCRYPTED_PREFIX) for value in stored)
    assert all("private composer draft" not in value for value in stored)

    # Locked sessions and machine callers get nothing.
    assert client.post("/api/owner/lock").status_code == 200
    assert client.get("/api/studio-state/opengen-composer").status_code == 401
    assert client.put("/api/studio-state/opengen-composer", json={"state": {}}).status_code == 401


def test_studio_state_validates_keys_and_size(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    assert client.put("/api/studio-state/Bad_Key!", json={"state": {}}).status_code == 400
    oversized = {"blob": "x" * (513 * 1024)}
    assert client.put("/api/studio-state/opengen-composer", json={"state": oversized}).status_code == 400

    store = StudioStateStore(tmp_path / "direct.sqlite3", cipher=PrivateFieldCipher.from_secret(b"test-private-state-secret"))
    with pytest.raises(ValueError):
        store.put("UPPER", {})
    store.put("ok-key", {"a": 1})
    assert store.get("ok-key") == {"a": 1}
    assert store.delete("ok-key") is True
    assert store.delete("ok-key") is False
