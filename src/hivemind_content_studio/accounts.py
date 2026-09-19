"""Accounts, sessions and passkeys for the studio.

This replaces the single hard-coded owner password (`private_access.OwnerAccess`)
with one account per person. Two things are deliberately kept apart:

  * AUTHORIZATION — who may call an API and which account's data they reach.
    That is this module: a scrypt password hash, WebAuthn passkeys, and a signed
    session cookie carrying an account id.
  * DECRYPTION — who can read the content. That is NOT here and never can be:
    each account has its own zero-knowledge vault whose master key is derived in
    the browser (see e2eVault.js and account_scope.py). A stolen session cookie
    reaches an account's ciphertext; it does not decrypt a byte of it.

Cross-account isolation therefore rests on two independent legs, and neither
alone is trusted: the filesystem split in account_scope.py means one account's
routes cannot even name another's files, and the per-account vault means that if
they somehow did, the bytes are sealed to a key this server has never held.

## Passkeys without a CBOR dependency

The usual WebAuthn server parses `attestationObject` (CBOR) to extract the COSE
public key. We do not: the browser's own `getPublicKey()` hands back the same key
already in SPKI DER, which `cryptography` loads directly. Registration therefore
trusts the key the client presents — acceptable here because you must ALREADY be
signed in to that account to add a passkey to it, so the registering party is the
account holder. Assertions are verified properly: challenge, origin, RP ID hash,
user-presence flag, signature, and a rollback check on the signature counter.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes as _hashes, serialization as _serialization
from cryptography.hazmat.primitives.asymmetric import ec as _ec, padding as _rsa_padding, rsa as _rsa

ACCOUNT_COOKIE = "hivemind_content_studio_account"
SESSION_SECONDS = 24 * 60 * 60
CHALLENGE_SECONDS = 300
MAX_ACCOUNTS = 24
NAME_PATTERN = re.compile(r"^[^\x00-\x1f]{1,40}$")

# ES256 and RS256 only. Both are universally supported by authenticators AND are
# the two algorithms `getPublicKey()` is guaranteed to be able to express as
# SPKI — an exotic curve would return null there and silently break registration.
ES256 = -7
RS256 = -257
SUPPORTED_ALGORITHMS = (ES256, RS256)

# scrypt at the donor's parameters (lib/profiles.js hashPin), which are also the
# Node defaults: N=2^14 keeps an interactive login well under 100ms.
SCRYPT_N = 1 << 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32

# Tile colours for the picker. Index is stable per account id, so a workspace
# keeps its colour for life rather than shuffling when a sibling is deleted.
# The honey accent and two neutrals: the design system allows one accent and
# "never cyan/violet", and the six-gradient rainbow this used to be was the
# loudest thing in the product. `scripts/generate_gate_css.py` defines the
# matching classes; the gate falls back to amber for a colour stored earlier.
TILE_COLOURS = ("amber", "sand", "stone", "slate")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def unb64url(text: str) -> bytes:
    padded = str(text) + "=" * (-len(str(text)) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def slugify(name: str) -> str:
    """A filesystem-safe stem for the account's state directory.

    Only ever used with the account id prefixed, so a collision between two
    workspaces called the same thing is impossible by construction.
    """
    normalised = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", normalised).strip("-").lower()
    return cleaned[:32] or "workspace"


# ── password hashing ─────────────────────────────────────────────────────────

def hash_password(password: str, *, salt: bytes | None = None) -> str:
    if not isinstance(password, str) or not password:
        raise ValueError("Password must be a non-empty string")
    used = salt if salt is not None else os.urandom(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=used, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64url(used)}${b64url(derived)}"


def verify_password(stored: str | None, password: str) -> bool:
    """Constant-time check against a stored `scrypt$...` string.

    An account with no hash at all (a fresh owner that has not been set up yet,
    or a workspace created without a password) matches nothing, ever. A legacy
    64-char SHA-256 hex digest is still accepted for stores that predate scrypt
    and for the CONTENT_STUDIO_OWNER_PASSWORD_HASH seed; those are upgraded to
    scrypt on the next successful sign-in.
    """
    if stored is None or not stored or not isinstance(password, str) or not password:
        return False
    if re.fullmatch(r"[0-9a-f]{64}", stored):
        supplied = hashlib.sha256(password.encode("utf-8")).hexdigest()
        return hmac.compare_digest(supplied, stored)
    parts = stored.split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return False
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, expected = unb64url(parts[4]), unb64url(parts[5])
        derived = hashlib.scrypt(
            password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=len(expected)
        )
    except (ValueError, TypeError, MemoryError):
        return False
    return hmac.compare_digest(derived, expected)


def is_legacy_password_hash(stored: str | None) -> bool:
    return bool(stored) and bool(re.fullmatch(r"[0-9a-f]{64}", str(stored)))


# ── login throttle (ported from the donor's lib/profiles.js) ─────────────────

class LoginThrottle:
    """Per-caller attempt limiter with a lockout window.

    Keyed on the caller address AND the account being attempted, so hammering
    one workspace cannot lock a different person out of theirs.
    """

    def __init__(self, *, max_attempts: int = 5, window_seconds: float = 300.0,
                 block_seconds: float = 600.0, clock=time.monotonic):
        self.max_attempts = max(2, int(max_attempts))
        self.window_seconds = max(1.0, float(window_seconds))
        self.block_seconds = max(1.0, float(block_seconds))
        self._clock = clock
        self._attempts: dict[str, dict[str, float]] = {}

    def _entry(self, key: str) -> tuple[dict[str, float], float]:
        now = self._clock()
        entry = self._attempts.get(key)
        if entry and entry["blocked_until"] > now:
            return entry, now
        if not entry or now - entry["window_started_at"] >= self.window_seconds:
            entry = {"count": 0.0, "window_started_at": now, "blocked_until": 0.0}
            self._attempts[key] = entry
        return entry, now

    def retry_after(self, key: str) -> float:
        """Seconds the caller must wait, or 0.0 when an attempt is allowed."""
        entry, now = self._entry(key)
        return max(0.0, entry["blocked_until"] - now) if entry["blocked_until"] > now else 0.0

    def fail(self, key: str) -> float:
        entry, now = self._entry(key)
        entry["count"] += 1
        if entry["count"] >= self.max_attempts:
            entry["blocked_until"] = now + self.block_seconds
        return max(0.0, entry["blocked_until"] - now)

    def success(self, key: str) -> None:
        self._attempts.pop(key, None)


# ── account records ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Account:
    id: int
    name: str
    slug: str
    colour: str
    is_owner: bool
    created_at: str
    has_password: bool
    passkey_count: int

    def public(self) -> dict[str, Any]:
        """What the picker is allowed to see BEFORE anyone signs in.

        Names, colours and whether each sign-in method exists — never a hash, a
        salt, a credential id or anything else that helps an attacker offline.
        """
        return {
            "id": self.id,
            "name": self.name,
            "colour": self.colour,
            "is_owner": self.is_owner,
            "created_at": self.created_at,
            "has_password": self.has_password,
            "has_passkey": self.passkey_count > 0,
        }


class AccountStore:
    """SQLite-backed accounts, passkeys and one-shot WebAuthn challenges."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    colour TEXT NOT NULL,
                    password_hash TEXT,
                    is_owner INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS passkeys (
                    credential_id TEXT PRIMARY KEY,
                    account_id INTEGER NOT NULL,
                    public_key TEXT NOT NULL,
                    algorithm INTEGER NOT NULL,
                    sign_count INTEGER NOT NULL DEFAULT 0,
                    label TEXT NOT NULL DEFAULT '',
                    prf INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT,
                    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys(account_id);
                CREATE TABLE IF NOT EXISTS webauthn_challenges (
                    challenge TEXT PRIMARY KEY,
                    account_id INTEGER,
                    purpose TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                -- A recovery attempt in flight. `nonce` is the plaintext the
                -- browser must hand back after decrypting it with the vault
                -- private key; it is issued ONLY sealed to that key's public
                -- half, so holding this row proves nothing on its own.
                CREATE TABLE IF NOT EXISTS recovery_challenges (
                    challenge TEXT PRIMARY KEY,
                    account_id INTEGER NOT NULL,
                    nonce TEXT NOT NULL,
                    expires_at REAL NOT NULL
                );
                -- The write-ahead journal that makes a password reset atomic
                -- across two databases. See begin_password_reset.
                CREATE TABLE IF NOT EXISTS password_resets (
                    account_id INTEGER PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    vault_wrap TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    # ── accounts ──────────────────────────────────────────────────────────────
    @staticmethod
    def _row_to_account(row: sqlite3.Row, passkey_count: int) -> Account:
        return Account(
            id=int(row["id"]),
            name=str(row["name"]),
            slug=str(row["slug"]),
            colour=str(row["colour"]),
            is_owner=bool(row["is_owner"]),
            created_at=str(row["created_at"]),
            has_password=bool(row["password_hash"]),
            passkey_count=passkey_count,
        )

    def list_accounts(self) -> list[Account]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM accounts ORDER BY id").fetchall()
            counts = dict(
                connection.execute("SELECT account_id, COUNT(*) FROM passkeys GROUP BY account_id").fetchall()
            )
        return [self._row_to_account(row, int(counts.get(row["id"], 0))) for row in rows]

    def get(self, account_id: int) -> Account | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM accounts WHERE id = ?", (int(account_id),)).fetchone()
            if not row:
                return None
            count = connection.execute(
                "SELECT COUNT(*) FROM passkeys WHERE account_id = ?", (int(account_id),)
            ).fetchone()[0]
        return self._row_to_account(row, int(count))

    def count(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0])

    def create(self, *, name: str, password: str | None, is_owner: bool = False,
               password_hash: str | None = None) -> Account:
        clean = str(name or "").strip()
        if not NAME_PATTERN.fullmatch(clean):
            raise ValueError("Workspace name must be 1-40 characters")
        if password is not None and password_hash is not None:
            raise ValueError("Pass a password or a hash, not both")
        stored = password_hash if password_hash is not None else (hash_password(password) if password else None)
        now = _now()
        with self._connect() as connection:
            if int(connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]) >= MAX_ACCOUNTS:
                raise ValueError(f"This studio is limited to {MAX_ACCOUNTS} workspaces")
            if connection.execute(
                "SELECT 1 FROM accounts WHERE lower(name) = lower(?)", (clean,)
            ).fetchone():
                raise ValueError("A workspace with that name already exists")
            cursor = connection.execute(
                "INSERT INTO accounts(name, slug, colour, password_hash, is_owner, created_at, updated_at)"
                " VALUES(?, ?, ?, ?, ?, ?, ?)",
                (clean, slugify(clean), "", stored, 1 if is_owner else 0, now, now),
            )
            account_id = int(cursor.lastrowid)
            colour = TILE_COLOURS[(account_id - 1) % len(TILE_COLOURS)]
            connection.execute("UPDATE accounts SET colour = ? WHERE id = ?", (colour, account_id))
        created = self.get(account_id)
        assert created is not None
        return created

    def rename(self, account_id: int, name: str) -> Account:
        clean = str(name or "").strip()
        if not NAME_PATTERN.fullmatch(clean):
            raise ValueError("Workspace name must be 1-40 characters")
        with self._connect() as connection:
            if connection.execute(
                "SELECT 1 FROM accounts WHERE lower(name) = lower(?) AND id <> ?", (clean, int(account_id))
            ).fetchone():
                raise ValueError("A workspace with that name already exists")
            connection.execute(
                "UPDATE accounts SET name = ?, slug = ?, updated_at = ? WHERE id = ?",
                (clean, slugify(clean), _now(), int(account_id)),
            )
        account = self.get(account_id)
        if account is None:
            raise LookupError("No such workspace")
        return account

    def set_password(self, account_id: int, password: str | None) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
                (hash_password(password) if password else None, _now(), int(account_id)),
            )

    def password_hash(self, account_id: int) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT password_hash FROM accounts WHERE id = ?", (int(account_id),)
            ).fetchone()
        return str(row["password_hash"]) if row and row["password_hash"] else None

    def delete(self, account_id: int) -> bool:
        with self._connect() as connection:
            removed = connection.execute("DELETE FROM accounts WHERE id = ?", (int(account_id),))
        return removed.rowcount > 0

    # ── passkeys ──────────────────────────────────────────────────────────────
    def list_passkeys(self, account_id: int) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT credential_id, label, prf, created_at, last_used_at FROM passkeys"
                " WHERE account_id = ? ORDER BY created_at",
                (int(account_id),),
            ).fetchall()
        return [
            {
                "credential_id": str(row["credential_id"]),
                "label": str(row["label"]),
                "prf": bool(row["prf"]),
                "created_at": str(row["created_at"]),
                "last_used_at": str(row["last_used_at"]) if row["last_used_at"] else None,
            }
            for row in rows
        ]

    def credential_ids(self, account_id: int) -> list[str]:
        return [entry["credential_id"] for entry in self.list_passkeys(account_id)]

    def add_passkey(self, *, account_id: int, credential_id: str, public_key: str,
                    algorithm: int, label: str = "", prf: bool = False) -> None:
        if int(algorithm) not in SUPPORTED_ALGORITHMS:
            raise ValueError("Unsupported passkey algorithm")
        try:
            load_spki(public_key)
        except Exception as exc:  # noqa: BLE001 — any parse failure is a bad key
            raise ValueError("Passkey public key is not a readable SPKI key") from exc
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO passkeys(credential_id, account_id, public_key, algorithm, sign_count, label, prf, created_at)"
                " VALUES(?, ?, ?, ?, 0, ?, ?, ?)"
                " ON CONFLICT(credential_id) DO UPDATE SET public_key = excluded.public_key,"
                " algorithm = excluded.algorithm, label = excluded.label, prf = excluded.prf",
                (str(credential_id), int(account_id), str(public_key), int(algorithm),
                 str(label or "")[:60], 1 if prf else 0, _now()),
            )

    def get_passkey(self, credential_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM passkeys WHERE credential_id = ?", (str(credential_id),)
            ).fetchone()
        return dict(row) if row else None

    def record_passkey_use(self, credential_id: str, sign_count: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
                (int(sign_count), _now(), str(credential_id)),
            )

    def set_passkey_prf(self, credential_id: str, prf: bool) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE passkeys SET prf = ? WHERE credential_id = ?", (1 if prf else 0, str(credential_id))
            )

    def delete_passkey(self, account_id: int, credential_id: str) -> bool:
        with self._connect() as connection:
            removed = connection.execute(
                "DELETE FROM passkeys WHERE credential_id = ? AND account_id = ?",
                (str(credential_id), int(account_id)),
            )
        return removed.rowcount > 0

    # ── one-shot challenges ───────────────────────────────────────────────────
    def issue_challenge(self, *, purpose: str, account_id: int | None = None) -> str:
        challenge = b64url(os.urandom(32))
        expiry = time.time() + CHALLENGE_SECONDS
        with self._connect() as connection:
            connection.execute("DELETE FROM webauthn_challenges WHERE expires_at < ?", (time.time(),))
            connection.execute(
                "INSERT INTO webauthn_challenges(challenge, account_id, purpose, expires_at) VALUES(?, ?, ?, ?)",
                (challenge, None if account_id is None else int(account_id), str(purpose), expiry),
            )
        return challenge

    def consume_challenge(self, challenge: str, *, purpose: str) -> dict[str, Any] | None:
        """Claim a challenge exactly once. A replayed assertion finds nothing."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM webauthn_challenges WHERE challenge = ? AND purpose = ?",
                (str(challenge), str(purpose)),
            ).fetchone()
            if not row:
                return None
            connection.execute("DELETE FROM webauthn_challenges WHERE challenge = ?", (str(challenge),))
        if float(row["expires_at"]) < time.time():
            return None
        return dict(row)

    # ── recovery-key challenges ───────────────────────────────────────────────
    #
    # Possession of the vault is proved by DECRYPTION, not by a signature: the
    # vault keypair is RSA-OAEP with encrypt/decrypt usages only, and WebCrypto
    # refuses to sign with it. So the server mints a random nonce, hands it out
    # sealed to the account's vault public key, and believes whoever hands the
    # plaintext back. It never learns the recovery key, and a caller who cannot
    # unwrap the private key cannot answer.
    def issue_recovery_challenge(self, account_id: int) -> tuple[str, bytes]:
        challenge = b64url(os.urandom(32))
        nonce = os.urandom(32)
        with self._connect() as connection:
            connection.execute("DELETE FROM recovery_challenges WHERE expires_at < ?", (time.time(),))
            connection.execute(
                "INSERT INTO recovery_challenges(challenge, account_id, nonce, expires_at) VALUES(?, ?, ?, ?)",
                (challenge, int(account_id), b64url(nonce), time.time() + CHALLENGE_SECONDS),
            )
        return challenge, nonce

    def consume_recovery_challenge(self, challenge: str, nonce: str, account_id: int) -> bool:
        """Claim a recovery challenge exactly once, and only with the right nonce.

        The row goes whether or not the nonce matches: a wrong answer burns the
        attempt rather than letting a caller grind one challenge.
        """
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM recovery_challenges WHERE challenge = ?", (str(challenge),)
            ).fetchone()
            if not row:
                return False
            connection.execute("DELETE FROM recovery_challenges WHERE challenge = ?", (str(challenge),))
        if float(row["expires_at"]) < time.time():
            return False
        if int(row["account_id"]) != int(account_id):
            return False
        return hmac.compare_digest(str(row["nonce"]), str(nonce or ""))

    # ── password resets, journalled ───────────────────────────────────────────
    #
    # A reset changes two things in two different SQLite files: the password
    # hash here, and the passphrase-wrapped master key in that account's vault.
    # SQLite cannot commit across both (they are WAL, so an ATTACHed
    # multi-database transaction is not atomic), so the journal below is the
    # commit point instead. Write the intent, apply the vault wrap, then apply
    # the hash and drop the journal in one transaction. A process killed
    # anywhere after the journal is written is finished on the next boot by
    # `resume_password_resets`; killed before it, nothing has changed and the
    # old password still works.
    def begin_password_reset(self, account_id: int, password_hash: str, vault_wrap: dict[str, str]) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO password_resets(account_id, password_hash, vault_wrap, created_at)"
                " VALUES(?, ?, ?, ?)"
                " ON CONFLICT(account_id) DO UPDATE SET password_hash = excluded.password_hash,"
                " vault_wrap = excluded.vault_wrap, created_at = excluded.created_at",
                (int(account_id), str(password_hash),
                 json.dumps(dict(vault_wrap), separators=(",", ":"), sort_keys=True), _now()),
            )

    def pending_password_resets(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM password_resets ORDER BY account_id").fetchall()
        return [
            {
                "account_id": int(row["account_id"]),
                "password_hash": str(row["password_hash"]),
                "vault_wrap": json.loads(row["vault_wrap"]),
            }
            for row in rows
        ]

    def finish_password_reset(self, account_id: int) -> bool:
        """Apply the journalled hash and clear the journal, in one transaction."""
        with self._connect() as connection:
            row = connection.execute(
                "SELECT password_hash FROM password_resets WHERE account_id = ?", (int(account_id),)
            ).fetchone()
            if not row:
                return False
            connection.execute(
                "UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
                (str(row["password_hash"]), _now(), int(account_id)),
            )
            connection.execute("DELETE FROM password_resets WHERE account_id = ?", (int(account_id),))
        return True

    def cancel_password_reset(self, account_id: int) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM password_resets WHERE account_id = ?", (int(account_id),))


# ── proving possession of a vault ────────────────────────────────────────────

def seal_recovery_nonce(public_key_b64url: str, nonce: bytes) -> str:
    """Seal a challenge nonce to a vault's RSA-OAEP public key.

    Mirrors `crypto.subtle.decrypt({name:'RSA-OAEP'}, ...)` on the browser side,
    which is fixed to the hash the key was generated with (SHA-256).
    """
    key = load_spki(public_key_b64url)
    if not isinstance(key, _rsa.RSAPublicKey):
        raise ValueError("This vault's public key is not an RSA key")
    sealed = key.encrypt(
        nonce,
        _rsa_padding.OAEP(
            mgf=_rsa_padding.MGF1(algorithm=_hashes.SHA256()),
            algorithm=_hashes.SHA256(),
            label=None,
        ),
    )
    return b64url(sealed)


# ── sessions ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AccountAccess:
    """Signed cookie carrying which account a browser is signed into.

    Same construction as the owner cookie it replaces (HMAC over an expiry and a
    nonce) with the account id folded into the signed payload, so a cookie for
    one workspace cannot be edited into a cookie for another.
    """

    signing_secret: bytes
    cookie_name: str = ACCOUNT_COOKIE
    session_seconds: int = SESSION_SECONDS

    def issue(self, account_id: int, *, now: int | None = None) -> str:
        issued = int(time.time()) if now is None else int(now)
        payload = f"{int(account_id)}.{issued + self.session_seconds}.{secrets.token_urlsafe(18)}"
        signature = hmac.new(self.signing_secret, payload.encode("ascii"), hashlib.sha256).digest()
        return f"{payload}.{b64url(signature)}"

    def _verified(self, token: str | None, *, now: int | None = None) -> tuple[int, int] | None:
        """(account id, seconds remaining) for a genuine, unexpired cookie."""
        if not token:
            return None
        try:
            account_text, expires_text, nonce, encoded_signature = str(token).split(".", 3)
            payload = f"{account_text}.{expires_text}.{nonce}"
            expected = hmac.new(self.signing_secret, payload.encode("ascii"), hashlib.sha256).digest()
            if not hmac.compare_digest(unb64url(encoded_signature), expected):
                return None
            current = int(time.time()) if now is None else int(now)
            remaining = int(expires_text) - current
            if remaining <= 0:
                return None
            return int(account_text), remaining
        except (TypeError, ValueError, base64.binascii.Error):
            return None

    def account_id(self, token: str | None, *, now: int | None = None) -> int | None:
        """The account this cookie proves, or None when absent/expired/forged."""
        verified = self._verified(token, now=now)
        return verified[0] if verified else None

    def remaining_seconds(self, token: str | None, *, now: int | None = None) -> int | None:
        """How long this cookie is still good for, or None when it proves
        nothing. What lets a session SLIDE (re-issued once it is past half its
        life) and lets the picker report a real expiry instead of the constant."""
        verified = self._verified(token, now=now)
        return verified[1] if verified else None


# ── WebAuthn verification ────────────────────────────────────────────────────

class WebAuthnError(ValueError):
    """A registration or assertion that failed verification."""


def load_spki(public_key_b64url: str):
    return _serialization.load_der_public_key(unb64url(public_key_b64url))


@dataclass(frozen=True)
class RelyingParty:
    """Which RP ID to claim and which page origins to accept.

    A self-hosted studio is reachable at more than one name — localhost on the
    machine itself, a tailnet hostname from a phone — and WebAuthn binds a
    credential to exactly one RP ID. So both are configurable, and when they are
    not configured we fall back to the origin the request itself arrived on.
    That is sound here because the browser, not the caller, sets
    `clientData.origin`: a hostile page gets its own origin stamped in and fails
    the comparison no matter what Host header it sends.
    """

    rp_id: str
    origins: tuple[str, ...]

    @classmethod
    def for_request(cls, *, host: str, scheme: str) -> "RelyingParty":
        configured_id = os.environ.get("CONTENT_STUDIO_WEBAUTHN_RP_ID", "").strip()
        configured_origins = tuple(
            origin.strip()
            for origin in os.environ.get("CONTENT_STUDIO_WEBAUTHN_ORIGINS", "").split(",")
            if origin.strip()
        )
        hostname = str(host or "").split(":", 1)[0] or "localhost"
        origin = f"{scheme}://{host}" if host else f"{scheme}://localhost"
        return cls(
            rp_id=configured_id or hostname,
            origins=configured_origins or (origin,),
        )

    def accepts(self, origin: str) -> bool:
        return any(hmac.compare_digest(str(origin), allowed) for allowed in self.origins)


def _parse_client_data(client_data_json: str, *, expected_type: str, party: RelyingParty) -> dict[str, Any]:
    try:
        data = json.loads(unb64url(client_data_json).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise WebAuthnError("Client data is not readable JSON") from exc
    if data.get("type") != expected_type:
        raise WebAuthnError(f"Client data is for {data.get('type')!r}, not {expected_type!r}")
    if not party.accepts(str(data.get("origin", ""))):
        raise WebAuthnError("Client data origin is not this studio")
    challenge = str(data.get("challenge", ""))
    if not challenge:
        raise WebAuthnError("Client data carries no challenge")
    return data


@dataclass(frozen=True)
class AuthenticatorData:
    rp_id_hash: bytes
    user_present: bool
    user_verified: bool
    sign_count: int


def parse_authenticator_data(raw: bytes) -> AuthenticatorData:
    if len(raw) < 37:
        raise WebAuthnError("Authenticator data is truncated")
    flags = raw[32]
    return AuthenticatorData(
        rp_id_hash=raw[:32],
        user_present=bool(flags & 0x01),
        user_verified=bool(flags & 0x04),
        sign_count=int.from_bytes(raw[33:37], "big"),
    )


def verify_registration(*, store: AccountStore, account_id: int, party: RelyingParty,
                        credential_id: str, public_key: str, algorithm: int,
                        client_data_json: str, label: str = "", prf: bool = False) -> None:
    """Check the ceremony, then trust the client's SPKI (see module docstring)."""
    data = _parse_client_data(client_data_json, expected_type="webauthn.create", party=party)
    claimed = store.consume_challenge(str(data["challenge"]), purpose="register")
    if not claimed:
        raise WebAuthnError("Registration challenge is unknown or expired")
    if claimed.get("account_id") is not None and int(claimed["account_id"]) != int(account_id):
        raise WebAuthnError("Registration challenge belongs to a different workspace")
    if not str(credential_id):
        raise WebAuthnError("Credential id is missing")
    existing = store.get_passkey(credential_id)
    if existing and int(existing["account_id"]) != int(account_id):
        raise WebAuthnError("That passkey is already registered to another workspace")
    store.add_passkey(
        account_id=account_id, credential_id=credential_id, public_key=public_key,
        algorithm=int(algorithm), label=label, prf=prf,
    )


def verify_assertion(*, store: AccountStore, party: RelyingParty, credential_id: str,
                     client_data_json: str, authenticator_data: str, signature: str) -> int:
    """Verify a passkey assertion and return the account id it proves."""
    passkey = store.get_passkey(credential_id)
    if not passkey:
        raise WebAuthnError("Unknown passkey")
    data = _parse_client_data(client_data_json, expected_type="webauthn.get", party=party)
    claimed = store.consume_challenge(str(data["challenge"]), purpose="authenticate")
    if not claimed:
        raise WebAuthnError("Sign-in challenge is unknown or expired")
    if claimed.get("account_id") is not None and int(claimed["account_id"]) != int(passkey["account_id"]):
        raise WebAuthnError("Sign-in challenge belongs to a different workspace")

    raw_authenticator = unb64url(authenticator_data)
    parsed = parse_authenticator_data(raw_authenticator)
    if not hmac.compare_digest(parsed.rp_id_hash, hashlib.sha256(party.rp_id.encode("utf-8")).digest()):
        raise WebAuthnError("Passkey was issued for a different site")
    if not parsed.user_present:
        raise WebAuthnError("Authenticator reported no user presence")
    # A counter that fails to advance is the documented signal of a cloned
    # authenticator. Many platform passkeys pin it at zero and never move, which
    # is legitimate, so only a genuine ROLLBACK is refused.
    stored_count = int(passkey["sign_count"] or 0)
    if stored_count and parsed.sign_count and parsed.sign_count <= stored_count:
        raise WebAuthnError("Passkey signature counter went backwards")

    signed = raw_authenticator + hashlib.sha256(unb64url(client_data_json)).digest()
    public_key = load_spki(str(passkey["public_key"]))
    try:
        if int(passkey["algorithm"]) == ES256:
            if not isinstance(public_key, _ec.EllipticCurvePublicKey):
                raise WebAuthnError("Passkey key type does not match its algorithm")
            public_key.verify(unb64url(signature), signed, _ec.ECDSA(_hashes.SHA256()))
        elif int(passkey["algorithm"]) == RS256:
            if not isinstance(public_key, _rsa.RSAPublicKey):
                raise WebAuthnError("Passkey key type does not match its algorithm")
            public_key.verify(unb64url(signature), signed, _rsa_padding.PKCS1v15(), _hashes.SHA256())
        else:
            raise WebAuthnError("Unsupported passkey algorithm")
    except InvalidSignature as exc:
        raise WebAuthnError("Passkey signature did not verify") from exc

    store.record_passkey_use(credential_id, parsed.sign_count)
    return int(passkey["account_id"])


def registration_options(*, store: AccountStore, account: Account, party: RelyingParty) -> dict[str, Any]:
    """The `publicKey` object for navigator.credentials.create()."""
    return {
        "challenge": store.issue_challenge(purpose="register", account_id=account.id),
        "rp": {"id": party.rp_id, "name": "Hivemind Content Studio"},
        "user": {
            # The user handle must not be guessable-from-nothing PII, and must be
            # stable so re-registering replaces rather than duplicates.
            "id": b64url(hashlib.sha256(f"hivemind-account-{account.id}".encode("utf-8")).digest()[:16]),
            "name": account.name,
            "displayName": account.name,
        },
        "pubKeyCredParams": [{"type": "public-key", "alg": alg} for alg in SUPPORTED_ALGORITHMS],
        "authenticatorSelection": {
            "residentKey": "preferred",
            "userVerification": "preferred",
        },
        "excludeCredentials": [
            {"type": "public-key", "id": credential_id} for credential_id in store.credential_ids(account.id)
        ],
        "timeout": CHALLENGE_SECONDS * 1000,
        "attestation": "none",
    }


def authentication_options(*, store: AccountStore, party: RelyingParty,
                           account: Account | None = None) -> dict[str, Any]:
    """The `publicKey` object for navigator.credentials.get().

    With no account named this is a discoverable-credential sign-in: the browser
    offers whichever passkey it holds for this site and the assertion tells us
    which workspace was chosen.
    """
    allow: Iterable[str] = store.credential_ids(account.id) if account else ()
    return {
        "challenge": store.issue_challenge(purpose="authenticate", account_id=account.id if account else None),
        "rpId": party.rp_id,
        "allowCredentials": [{"type": "public-key", "id": credential_id} for credential_id in allow],
        "userVerification": "preferred",
        "timeout": CHALLENGE_SECONDS * 1000,
    }
