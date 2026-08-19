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
# `wrapped_mk_prf` is a JSON object of {credential_id: wrapped_mk}, one entry per
# passkey whose authenticator can produce a PRF secret. It is still only ever
# ciphertext to this server: the PRF secret never leaves the authenticator and
# the browser, so a stolen copy of this column unwraps nothing.
IDENTITY_FIELDS = ("salt", "wrapped_mk_pass", "wrapped_mk_recovery", "public_key",
                   "wrapped_private_key", "kdf", "wrapped_mk_prf")
# Namespaces that accrue one entry per generation (and, for lookup, several keys
# per entry) would otherwise grow without bound — this store reached 3.27 GB
# before retention existed. The server cannot read these blobs, so retention is
# enforced purely on recency and size: keep the newest entries that fit both
# budgets and drop the rest.
NAMESPACE_RETENTION: dict[str, dict[str, int]] = {
    # Each generation seals ~4-6 keys (its URL plus every filename spelling it could
    # be re-dropped under), so a row cap is really a cap on RESTORABLE GENERATIONS
    # divided by that fan-out. The original 300 left only ~60-100 of them, which
    # silently evicted older outputs' settings and surfaced as "No saved settings
    # found for this file" on drag-to-restore. Rows are ~2 KB now that oversized
    # inline references are stripped before sealing (see generationSetupStore.js
    # compactContextForSeal), so the byte budget is the real bound and the row cap
    # only exists as a backstop.
    # The byte budget deliberately sits ABOVE what the legacy fat rows already
    # occupy (~400 MB as of 2026-07-26): lowering it would make the next write
    # prune real settings by recency to get under budget, which is the very
    # failure being fixed. New rows are ~2 KB, so this allows tens of thousands
    # of generations; the legacy rows only age out if the budget is ever reached.
    "gen-setup": {"max_rows": 20000, "max_bytes": 512 * 1024 * 1024},
    # Named libraries (LoRA groups, saved prompts) are ONE blob each, so these
    # bounds never evict a user's saved entry — they only stop a buggy or hostile
    # writer from turning this namespace into another unbounded store.
    "library": {"max_rows": 16, "max_bytes": 64 * 1024 * 1024},
}


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

    def set_prf_wrap(self, credential_id: str, wrapped_mk: str | None) -> dict[str, str]:
        """Add or drop one passkey's wrapped master key.

        Separate from put_identity because that call refuses to overwrite an
        existing vault — rotating an identity re-encrypts everything, whereas
        enrolling a passkey adds one more way to unwrap the SAME master key and
        must not look like a rotation.
        """
        key = str(credential_id or "").strip()
        if not key or len(key) > 1024:
            raise ValueError("Credential id is missing or too long")
        with self._connect() as connection:
            row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
            if not row:
                raise LookupError("This workspace has no vault yet")
            identity = json.loads(row["identity_json"])
            wraps = json.loads(identity.get("wrapped_mk_prf") or "{}")
            if wrapped_mk is None:
                wraps.pop(key, None)
            else:
                if not isinstance(wrapped_mk, str) or len(wrapped_mk) > 4096:
                    raise ValueError("Wrapped master key must be a short opaque string")
                wraps[key] = wrapped_mk
            identity["wrapped_mk_prf"] = json.dumps(wraps, separators=(",", ":"), sort_keys=True)
            cleaned = self._sanitize_identity(identity)
            connection.execute(
                "UPDATE vault_identity SET identity_json = ?, updated_at = ? WHERE id = 1",
                (json.dumps(cleaned, separators=(",", ":"), sort_keys=True), _now()),
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
        self.prune_namespace(ns)

    def prune_namespace(self, namespace: str, *, max_rows: int | None = None, max_bytes: int | None = None) -> int:
        """Drop the oldest blobs in a namespace beyond its row/byte budget.
        Ordering uses updated_at only — the ciphertext is never inspected."""
        ns, _ = self._validate_ref(namespace, "x")
        policy = NAMESPACE_RETENTION.get(ns, {})
        rows_limit = policy.get("max_rows") if max_rows is None else max_rows
        bytes_limit = policy.get("max_bytes") if max_bytes is None else max_bytes
        if not rows_limit and not bytes_limit:
            return 0
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT blob_key, LENGTH(ciphertext) FROM vault_blobs WHERE namespace = ?"
                " ORDER BY updated_at DESC, blob_key DESC",
                (ns,),
            ).fetchall()
            doomed, kept_bytes = [], 0
            for index, (blob_key, size) in enumerate(rows):
                kept_bytes += int(size or 0)
                over_rows = rows_limit is not None and index >= rows_limit
                over_bytes = bytes_limit is not None and kept_bytes > bytes_limit
                if over_rows or over_bytes:
                    doomed.append((ns, blob_key))
            if doomed:
                connection.executemany("DELETE FROM vault_blobs WHERE namespace = ? AND blob_key = ?", doomed)
        return len(doomed)

    def delete_blob(self, namespace: str, blob_key: str) -> bool:
        ns, key = self._validate_ref(namespace, blob_key)
        with self._connect() as connection:
            removed = connection.execute(
                "DELETE FROM vault_blobs WHERE namespace = ? AND blob_key = ?", (ns, key)
            )
        return removed.rowcount > 0
