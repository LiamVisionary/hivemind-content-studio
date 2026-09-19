"""Forgetting a password, and coming back from it.

The recovery-key modal has always told people their key is the only way back
into an encrypted library. It was true, and until now there was nowhere to type
one: a forgotten password lost every image and prompt. These tests drive the
flow the way a browser does — real AES-GCM, real RSA-OAEP, real PBKDF2 — because
the whole claim rests on the server never seeing a key it could use.

Two properties are load-bearing here and each has its own test:

  * The pre-auth exchange NEVER hands out `wrapped_mk_pass`. That value is the
    master key sealed under a passphrase, so an unauthenticated route returning
    it would be an offline password-cracking oracle for anyone who can reach
    the port.
  * The reset is atomic across two databases. Half of it — a new password that
    cannot open the library, or a library wrapped under a passphrase the account
    will not accept — is worse than none.
"""

from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from hivemind_content_studio.accounts import AccountStore, hash_password, verify_password
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore
from hivemind_content_studio.vault_store import VaultStore

OWNER_PASSWORD = "owner-passphrase"
PBKDF2_ITERATIONS = 600_000


# ── the browser half, in the same wire formats e2eVault.js produces ──────────

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _seal(key: bytes, plaintext: bytes) -> str:
    iv = os.urandom(12)
    return f"{_b64url(iv)}.{_b64url(AESGCM(key).encrypt(iv, plaintext, None))}"


def _open(key: bytes, blob: str) -> bytes:
    iv_part, ct_part = blob.split(".")
    return AESGCM(key).decrypt(_unb64url(iv_part), _unb64url(ct_part), None)


def _pass_key(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, PBKDF2_ITERATIONS, 32)


class Browser:
    """A vault identity, and the two things its owner can still do without a password."""

    def __init__(self, passphrase: str):
        self.master_key = os.urandom(32)
        self.recovery_bytes = os.urandom(20)
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_key = private
        salt = os.urandom(16)
        pkcs8 = private.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        self.identity = {
            "kdf": f"PBKDF2-SHA256-{PBKDF2_ITERATIONS}",
            "salt": _b64url(salt),
            "wrapped_mk_pass": _seal(_pass_key(passphrase, salt), self.master_key),
            "wrapped_mk_recovery": _seal(hashlib.sha256(self.recovery_bytes).digest(), self.master_key),
            "public_key": _b64url(private.public_key().public_bytes(
                encoding=serialization.Encoding.DER,
                format=serialization.PublicFormat.SubjectPublicKeyInfo,
            )),
            "wrapped_private_key": _seal(self.master_key, pkcs8),
        }

    def open_challenge(self, payload: dict, recovery_bytes: bytes | None = None) -> str | None:
        """Unwrap with the recovery key, then DECRYPT the nonce with the private key.

        Not sign it: the vault keypair is RSA-OAEP with encrypt/decrypt usages
        only, which is why the whole proof is shaped this way.
        """
        wrapping = hashlib.sha256(recovery_bytes or self.recovery_bytes).digest()
        try:
            master = _open(wrapping, payload["wrapped_mk_recovery"])
        except Exception:
            return None
        pkcs8 = _open(master, payload["wrapped_private_key"])
        private = serialization.load_der_private_key(pkcs8, password=None)
        nonce = private.decrypt(
            _unb64url(payload["nonce"]),
            padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None),
        )
        return _b64url(nonce)

    def rewrap(self, passphrase: str) -> dict:
        salt = os.urandom(16)
        return {
            "kdf": f"PBKDF2-SHA256-{PBKDF2_ITERATIONS}",
            "salt": _b64url(salt),
            "wrapped_mk_pass": _seal(_pass_key(passphrase, salt), self.master_key),
        }


def _opens_with(identity: dict, passphrase: str) -> bool:
    try:
        return _open(_pass_key(passphrase, _unb64url(identity["salt"])), identity["wrapped_mk_pass"]) is not None
    except Exception:
        return False


# ── fixtures ─────────────────────────────────────────────────────────────────

def _build(tmp_path: Path) -> TestClient:
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )
    return TestClient(app)


@pytest.fixture()
def studio(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    return _build(tmp_path)


def _sign_in(client: TestClient, password: str = OWNER_PASSWORD, account_id: int = 1) -> None:
    response = client.post("/api/accounts/unlock", json={"account_id": account_id, "password": password})
    assert response.status_code == 200, response.text


def _with_vault(client: TestClient, passphrase: str = OWNER_PASSWORD) -> Browser:
    browser = Browser(passphrase)
    _sign_in(client, passphrase)
    stored = client.put("/api/vault/identity", json={"identity": browser.identity})
    assert stored.status_code in {200, 201}, stored.text
    client.post("/api/accounts/sign-out")
    return browser


# ── the pre-auth exchange ────────────────────────────────────────────────────

def test_the_challenge_never_hands_out_the_passphrase_wrapped_key(studio):
    browser = _with_vault(studio)
    response = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "wrapped_mk_pass" not in payload
    assert browser.identity["wrapped_mk_pass"] not in response.text
    # What it DOES return is the recovery half, the sealed private key, the salt
    # and a nonce nobody can read without opening the vault first.
    assert payload["wrapped_mk_recovery"] == browser.identity["wrapped_mk_recovery"]
    assert payload["wrapped_private_key"] == browser.identity["wrapped_private_key"]
    assert payload["salt"] == browser.identity["salt"]
    assert payload["nonce"] and payload["nonce"] != _b64url(b"")
    assert "wrapped_mk_prf" not in payload
    # And the route that DOES carry the passphrase wrap stays behind the gate,
    # which is what makes "absent from every pre-auth response" true rather than
    # true of one route.
    studio.cookies.clear()
    assert studio.get("/api/vault/identity").status_code == 401


def test_a_workspace_with_no_vault_says_what_to_do_instead(studio):
    # The owner has a password but has never opened the studio in a browser, so
    # there is no vault and no recovery key. The answer names the way forward.
    refused = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1})
    assert refused.status_code == 404
    assert "Settings" in refused.json()["detail"]


def test_the_recovery_routes_answer_before_anyone_signs_in(studio):
    _with_vault(studio)
    # No cookie: this is exactly the situation the flow exists for.
    studio.cookies.clear()
    assert studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).status_code == 200


# ── the reset itself ─────────────────────────────────────────────────────────

def test_the_recovery_key_sets_a_new_password_and_keeps_the_library(studio):
    browser = _with_vault(studio)
    # Something sealed under the master key before the password was ever lost.
    _sign_in(studio)
    studio.put("/api/vault/blob/library/saved-prompts", json={"ciphertext": "sealed-before"})
    studio.post("/api/accounts/sign-out")
    studio.cookies.clear()

    payload = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).json()
    nonce = browser.open_challenge(payload)
    assert nonce is not None
    done = studio.post("/api/accounts/recovery/reset", json={
        "account_id": 1, "challenge": payload["challenge"], "nonce": nonce,
        "password": "a-brand-new-password", "wrap": browser.rewrap("a-brand-new-password"),
    })
    assert done.status_code == 200, done.text

    # The new password opens the account; the old one is gone.
    studio.post("/api/accounts/sign-out")
    assert studio.post("/api/accounts/unlock",
                       json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 401
    _sign_in(studio, "a-brand-new-password")

    identity = studio.get("/api/vault/identity").json()["identity"]
    # The master key never changed, so everything else is byte-identical and the
    # blob sealed before the reset is still there, still sealed to the same key.
    assert identity["public_key"] == browser.identity["public_key"]
    assert identity["wrapped_private_key"] == browser.identity["wrapped_private_key"]
    assert identity["wrapped_mk_recovery"] == browser.identity["wrapped_mk_recovery"]
    assert identity["wrapped_mk_pass"] != browser.identity["wrapped_mk_pass"]
    assert _opens_with(identity, "a-brand-new-password")
    assert not _opens_with(identity, OWNER_PASSWORD)
    assert studio.get("/api/vault/blob/library/saved-prompts").json()["ciphertext"] == "sealed-before"


def test_a_wrong_recovery_key_never_reaches_the_reset(studio):
    browser = _with_vault(studio)
    studio.cookies.clear()
    payload = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).json()
    # The GCM tag fails in the browser; there is nothing to send.
    assert browser.open_challenge(payload, recovery_bytes=os.urandom(20)) is None
    # And a caller that invents a nonce anyway is refused.
    refused = studio.post("/api/accounts/recovery/reset", json={
        "account_id": 1, "challenge": payload["challenge"], "nonce": _b64url(os.urandom(32)),
        "password": "not-happening", "wrap": browser.rewrap("not-happening"),
    })
    assert refused.status_code == 401
    _sign_in(studio, OWNER_PASSWORD)


def test_one_challenge_answers_exactly_once(studio):
    browser = _with_vault(studio)
    studio.cookies.clear()
    payload = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).json()
    nonce = browser.open_challenge(payload)
    first = studio.post("/api/accounts/recovery/reset", json={
        "account_id": 1, "challenge": payload["challenge"], "nonce": nonce,
        "password": "first-reset", "wrap": browser.rewrap("first-reset"),
    })
    assert first.status_code == 200
    replayed = studio.post("/api/accounts/recovery/reset", json={
        "account_id": 1, "challenge": payload["challenge"], "nonce": nonce,
        "password": "second-reset", "wrap": browser.rewrap("second-reset"),
    })
    assert replayed.status_code == 401
    studio.post("/api/accounts/sign-out")
    _sign_in(studio, "first-reset")


# ── atomicity ────────────────────────────────────────────────────────────────

def test_an_interrupted_reset_leaves_the_old_password_working(studio, tmp_path, monkeypatch):
    browser = _with_vault(studio)
    studio.cookies.clear()
    payload = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).json()
    nonce = browser.open_challenge(payload)

    def explode(self, identity, *, allow_replace=False):
        raise RuntimeError("the disk went away mid-write")

    monkeypatch.setattr(VaultStore, "put_identity", explode)
    failed = studio.post("/api/accounts/recovery/reset", json={
        "account_id": 1, "challenge": payload["challenge"], "nonce": nonce,
        "password": "never-applied", "wrap": browser.rewrap("never-applied"),
    })
    assert failed.status_code == 500
    # The message says what is still true, because that is the fix.
    assert "old" in failed.json()["detail"] and "still works" in failed.json()["detail"]
    monkeypatch.undo()

    # Nothing moved: the account keeps its password and the vault its wrap.
    assert studio.post("/api/accounts/unlock",
                       json={"account_id": 1, "password": "never-applied"}).status_code == 401
    _sign_in(studio, OWNER_PASSWORD)
    identity = studio.get("/api/vault/identity").json()["identity"]
    assert identity["wrapped_mk_pass"] == browser.identity["wrapped_mk_pass"]
    # …and no half-finished journal is left for the next boot to apply.
    assert AccountStore(tmp_path / "accounts.sqlite3").pending_password_resets() == []


def test_a_process_killed_between_the_two_writes_is_finished_on_the_next_boot(studio, tmp_path):
    """The journal is the commit point, so a crash after it converges forward.

    Written directly here because that is exactly what a `kill -9` leaves behind:
    an intent recorded, and neither of the two writes it describes applied yet.
    """
    browser = _with_vault(studio)
    store = AccountStore(tmp_path / "accounts.sqlite3")
    wrap = browser.rewrap("survived-the-crash")
    store.begin_password_reset(1, hash_password("survived-the-crash"), wrap)
    assert len(store.pending_password_resets()) == 1
    # The old password is still the one on the account at this instant.
    assert verify_password(store.password_hash(1), OWNER_PASSWORD)

    rebooted = _build(tmp_path)
    assert store.pending_password_resets() == [], "the journal is drained at boot"
    assert rebooted.post("/api/accounts/unlock",
                         json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 401
    _sign_in(rebooted, "survived-the-crash")
    identity = rebooted.get("/api/vault/identity").json()["identity"]
    assert identity["wrapped_mk_pass"] == wrap["wrapped_mk_pass"]
    assert identity["wrapped_mk_recovery"] == browser.identity["wrapped_mk_recovery"]


# ── the signed-in equivalents ────────────────────────────────────────────────

def test_changing_the_password_keeps_passkeys_and_the_recovery_key(studio, tmp_path):
    browser = _with_vault(studio)
    # A passkey's PRF wrap, and its row in the accounts store.
    store = AccountStore(tmp_path / "accounts.sqlite3")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    store.add_passkey(
        account_id=1, credential_id="cred-1", algorithm=-257, prf=True,
        public_key=_b64url(key.public_key().public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )),
    )
    _sign_in(studio)
    assert studio.put("/api/vault/prf/cred-1", json={"wrapped_mk": "prf-wrapped-mk"}).status_code == 200

    changed = studio.post("/api/accounts/me/password", json={
        "current_password": OWNER_PASSWORD, "password": "second-password",
        "wrap": browser.rewrap("second-password"),
    })
    assert changed.status_code == 200, changed.text

    identity = studio.get("/api/vault/identity").json()["identity"]
    assert "prf-wrapped-mk" in identity["wrapped_mk_prf"], "the passkey still unwraps the same master key"
    assert identity["wrapped_mk_recovery"] == browser.identity["wrapped_mk_recovery"]
    assert _opens_with(identity, "second-password")
    assert [entry["credential_id"] for entry in store.list_passkeys(1)] == ["cred-1"]

    studio.post("/api/accounts/sign-out")
    assert studio.post("/api/accounts/unlock",
                       json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 401
    _sign_in(studio, "second-password")


def test_a_wrong_current_password_changes_nothing(studio):
    browser = _with_vault(studio)
    _sign_in(studio)
    refused = studio.post("/api/accounts/me/password", json={
        "current_password": "not-it", "password": "hopeful",
        "wrap": browser.rewrap("hopeful"),
    })
    assert refused.status_code == 401
    assert studio.get("/api/vault/identity").json()["identity"]["wrapped_mk_pass"] == browser.identity["wrapped_mk_pass"]
    studio.post("/api/accounts/sign-out")
    _sign_in(studio, OWNER_PASSWORD)


def test_changing_the_password_needs_a_session(studio):
    browser = _with_vault(studio)
    studio.cookies.clear()
    refused = studio.post("/api/accounts/me/password", json={
        "current_password": OWNER_PASSWORD, "password": "hopeful",
        "wrap": browser.rewrap("hopeful"),
    })
    assert refused.status_code == 401


def test_a_new_recovery_key_replaces_only_the_recovery_wrap(studio):
    browser = _with_vault(studio)
    _sign_in(studio)
    minted = _seal(hashlib.sha256(b"a-different-recovery-key").digest(), browser.master_key)
    assert studio.put("/api/vault/recovery", json={"wrapped_mk_recovery": minted}).status_code == 200

    identity = studio.get("/api/vault/identity").json()["identity"]
    assert identity["wrapped_mk_recovery"] == minted
    assert identity["wrapped_mk_pass"] == browser.identity["wrapped_mk_pass"]
    assert identity["public_key"] == browser.identity["public_key"]
    # The old recovery key no longer opens anything; the new one does.
    payload = dict(identity)
    studio.post("/api/accounts/sign-out")
    studio.cookies.clear()
    challenge = studio.post("/api/accounts/recovery/challenge", json={"account_id": 1}).json()
    assert challenge["wrapped_mk_recovery"] == minted
    assert browser.open_challenge(challenge) is None
    assert _open(hashlib.sha256(b"a-different-recovery-key").digest(),
                 payload["wrapped_mk_recovery"]) == browser.master_key
