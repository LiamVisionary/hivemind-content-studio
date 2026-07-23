"""The owner vault is zero-knowledge: the server stores only opaque ciphertext
and wrapped keys, is owner-gated, and can never decrypt content."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.vault_store import VaultStore


def _identity() -> dict[str, str]:
    return {
        "kdf": "PBKDF2-SHA256-600000",
        "salt": "c2FsdA",
        "wrapped_mk_pass": "aXY.Y2lwaGVy",
        "wrapped_mk_recovery": "aXY.cmVjb3Zlcg",
        "public_key": "cHVibGljLWtleS1zcGtp",
        "wrapped_private_key": "aXY.cHJpdmF0ZQ",
    }


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/owner/unlock", json={"password": "test-owner-password"}).status_code == 200
    return client


def test_vault_identity_and_blobs_roundtrip_and_are_owner_gated(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/vault/identity").json() == {"ok": True, "exists": False, "identity": None}

    assert client.put("/api/vault/identity", json={"identity": _identity()}).status_code == 200
    fetched = client.get("/api/vault/identity").json()
    assert fetched["exists"] is True
    assert fetched["identity"]["public_key"] == "cHVibGljLWtleS1zcGtp"

    # A second create without allow_replace is refused (would orphan existing content).
    assert client.put("/api/vault/identity", json={"identity": _identity()}).status_code == 409

    blob = "v1.aXYtYnl0ZXM.Y2lwaGVydGV4dC1ieXRlcw"
    assert client.put("/api/vault/blob/composer/state", json={"ciphertext": blob}).status_code == 200
    assert client.get("/api/vault/blob/composer/state").json()["ciphertext"] == blob
    assert client.get("/api/vault/blob/composer/absent").json()["ciphertext"] is None
    assert client.delete("/api/vault/blob/composer/state").json()["removed"] is True

    # Locked session gets nothing.
    assert client.post("/api/owner/lock").status_code == 200
    assert client.get("/api/vault/identity").status_code == 401
    assert client.put("/api/vault/blob/composer/state", json={"ciphertext": blob}).status_code == 401


def test_vault_store_holds_no_key_material_and_rejects_bare_secrets(tmp_path: Path) -> None:
    store = VaultStore(tmp_path / "vault.sqlite3")
    store.put_identity(_identity())

    # The persisted identity is exactly the opaque wrapped fields — nothing else.
    persisted = store.get_identity()
    assert set(persisted) == {"kdf", "salt", "wrapped_mk_pass", "wrapped_mk_recovery", "public_key", "wrapped_private_key"}

    # Handing the server a bare master key / passphrase is a hard error.
    for poisoned in ({**_identity(), "master_key": "x"}, {**_identity(), "passphrase": "x"}, {**_identity(), "private_key": "x"}):
        with pytest.raises(ValueError):
            VaultStore(tmp_path / "poison.sqlite3").put_identity(poisoned)

    # An identity missing a wrapped field is rejected (no partial vaults).
    incomplete = _identity()
    del incomplete["wrapped_private_key"]
    with pytest.raises(ValueError):
        VaultStore(tmp_path / "incomplete.sqlite3").put_identity(incomplete)

    # Blob key/namespace validation.
    with pytest.raises(ValueError):
        store.put_blob("BAD NS", "k", "ct")
    store.put_blob("media", "run_abc.mp4", "v1.iv.ct")
    assert store.get_blob("media", "run_abc.mp4") == "v1.iv.ct"
