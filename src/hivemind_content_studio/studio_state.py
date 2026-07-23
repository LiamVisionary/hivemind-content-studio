"""Encrypted, owner-only persistence for browser studio composer state.

Stores small opaque JSON blobs (prompt drafts, reference selections, section
preferences) so studio views survive tab switches and reloads. Values are
AES-GCM encrypted at rest with the private studio cipher; the API surface is
owner-session gated, so only an unlocked client can read or write them.
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .private_access import PrivateFieldCipher

STATE_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_STATE_BYTES = 512 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class StudioStateStore:
    def __init__(self, path: str | Path, *, cipher: PrivateFieldCipher):
        self.path = Path(path).expanduser().resolve()
        self.cipher = cipher
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS studio_state (
                    state_key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    @staticmethod
    def validate_key(state_key: str) -> str:
        key = str(state_key or "").strip()
        if not STATE_KEY_PATTERN.fullmatch(key):
            raise ValueError("State key must be 1-64 chars of lowercase letters, digits, or dashes")
        return key

    def get(self, state_key: str) -> dict[str, Any]:
        key = self.validate_key(state_key)
        with self._connect() as connection:
            row = connection.execute("SELECT value FROM studio_state WHERE state_key = ?", (key,)).fetchone()
        if row is None:
            return {}
        value = json.loads(self.cipher.decrypt(str(row["value"])))
        return value if isinstance(value, dict) else {}

    def put(self, state_key: str, state: dict[str, Any]) -> dict[str, Any]:
        key = self.validate_key(state_key)
        if not isinstance(state, dict):
            raise ValueError("State must be a JSON object")
        serialized = json.dumps(state, separators=(",", ":"), sort_keys=True)
        if len(serialized.encode("utf-8")) > MAX_STATE_BYTES:
            raise ValueError(f"State exceeds the {MAX_STATE_BYTES // 1024} KB limit")
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO studio_state(state_key, value, updated_at) VALUES(?, ?, ?)"
                " ON CONFLICT(state_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (key, self.cipher.encrypt(serialized), _now()),
            )
        return state

    def delete(self, state_key: str) -> bool:
        key = self.validate_key(state_key)
        with self._connect() as connection:
            removed = connection.execute("DELETE FROM studio_state WHERE state_key = ?", (key,))
        return removed.rowcount > 0
