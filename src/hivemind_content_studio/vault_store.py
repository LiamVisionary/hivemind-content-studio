"""Zero-knowledge owner vault: server holds only ciphertext and wrapped keys.

The server persists the vault *identity* (a salt plus key material that is sealed
under keys which never leave the browser) and opaque encrypted *blobs*. It has no
way to derive the master key, the recovery key, or the RSA private key, so it
cannot decrypt any blob. Owner-session auth gates the API for authorization only;
it is not the decryption key.

All values below are opaque base64url strings produced by the browser. This
module never interprets them beyond storage, and deliberately holds no cipher.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

NAMESPACE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
KEY_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$")
MAX_BLOB_BYTES = 200 * 1024 * 1024  # generous; media DEK-sealed ciphertext lives here in phase 2
# Only these opaque fields are accepted for the identity record. Anything that
# could let the server decrypt (a bare master key, passphrase, recovery key) is
# structurally absent from the schema.
IDENTITY_FIELDS = ("salt", "wrapped_mk_pass", "wrapped_mk_recovery", "public_key", "wrapped_private_key", "kdf")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class VaultStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS vault_identity (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    identity_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS vault_blobs (
                    namespace TEXT NOT NULL,
                    blob_key TEXT NOT NULL,
                    ciphertext TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (namespace, blob_key)
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    # ── vault identity ────────────────────────────────────────────────────────
    def get_identity(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
        return json.loads(row["identity_json"]) if row else None

    def has_identity(self) -> bool:
        return self.get_identity() is not None

    @staticmethod
    def _sanitize_identity(identity: dict[str, Any]) -> dict[str, str]:
        if not isinstance(identity, dict):
            raise ValueError("Vault identity must be an object")
        cleaned: dict[str, str] = {}
        for field in IDENTITY_FIELDS:
            value = identity.get(field)
            if value is None:
                continue
            if not isinstance(value, str) or len(value) > 8192:
                raise ValueError(f"Vault identity field {field!r} must be a short opaque string")
            cleaned[field] = value
        for required in ("salt", "wrapped_mk_pass", "wrapped_mk_recovery", "public_key", "wrapped_private_key"):
            if not cleaned.get(required):
                raise ValueError(f"Vault identity is missing {required!r}")
        # Reject anything that looks like a bare secret being handed to the server.
        forbidden = {"master_key", "mk", "passphrase", "password", "recovery_key", "private_key", "priv"}
        if forbidden & set(identity):
            raise ValueError("Vault identity must never contain unwrapped key material")
        return cleaned

    def put_identity(self, identity: dict[str, Any], *, allow_replace: bool = False) -> dict[str, str]:
        cleaned = self._sanitize_identity(identity)
        now = _now()
        with self._connect() as connection:
            existing = connection.execute("SELECT created_at FROM vault_identity WHERE id = 1").fetchone()
            if existing and not allow_replace:
                raise PermissionError("A vault already exists; rotating it re-encrypts all content")
            created = existing["created_at"] if existing else now
            connection.execute(
                "INSERT INTO vault_identity(id, identity_json, created_at, updated_at) VALUES(1, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET identity_json = excluded.identity_json, updated_at = excluded.updated_at",
                (json.dumps(cleaned, separators=(",", ":"), sort_keys=True), created, now),
            )
        return cleaned

    # ── opaque encrypted blobs ─────────────────────────────────────────────────
    @staticmethod
    def _validate_ref(namespace: str, blob_key: str) -> tuple[str, str]:
        ns = str(namespace or "").strip()
        key = str(blob_key or "").strip()
        if not NAMESPACE_PATTERN.fullmatch(ns):
            raise ValueError("Namespace must be 1-64 chars of lowercase letters, digits, or dashes")
        if not KEY_PATTERN.fullmatch(key):
            raise ValueError("Blob key must be 1-128 chars of letters, digits, dot, dash, or underscore")
        return ns, key

    def get_blob(self, namespace: str, blob_key: str) -> str | None:
        ns, key = self._validate_ref(namespace, blob_key)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT ciphertext FROM vault_blobs WHERE namespace = ? AND blob_key = ?", (ns, key)
            ).fetchone()
        return str(row["ciphertext"]) if row else None

    def put_blob(self, namespace: str, blob_key: str, ciphertext: str) -> None:
        ns, key = self._validate_ref(namespace, blob_key)
        if not isinstance(ciphertext, str) or not ciphertext:
            raise ValueError("Ciphertext must be a non-empty opaque string")
        if len(ciphertext.encode("utf-8")) > MAX_BLOB_BYTES:
            raise ValueError(f"Ciphertext exceeds the {MAX_BLOB_BYTES // 1024 // 1024} MB limit")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO vault_blobs(namespace, blob_key, ciphertext, updated_at) VALUES(?, ?, ?, ?)"
                " ON CONFLICT(namespace, blob_key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
                (ns, key, ciphertext, _now()),
            )

    def delete_blob(self, namespace: str, blob_key: str) -> bool:
        ns, key = self._validate_ref(namespace, blob_key)
        with self._connect() as connection:
            removed = connection.execute(
                "DELETE FROM vault_blobs WHERE namespace = ? AND blob_key = ?", (ns, key)
            )
        return removed.rowcount > 0
