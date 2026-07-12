"""Durable prompt history and favorites for the browser studio."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class PromptHistoryStore:
    """Records the final prompt each production was generated from.

    An entry keeps both the prompt that ultimately drove generation (post
    AI-edit when the prompt helper ran) and the user's original wording, so
    either can be reused from the composer.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS prompts (
                    prompt_id TEXT PRIMARY KEY,
                    prompt TEXT NOT NULL,
                    user_prompt TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    lane TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL DEFAULT 'simple',
                    run_id TEXT NOT NULL DEFAULT '',
                    composer_json TEXT NOT NULL DEFAULT '{}',
                    favorite INTEGER NOT NULL DEFAULT 0,
                    use_count INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_prompts_updated ON prompts(updated_at DESC);
                """
            )
            columns = {str(row["name"]) for row in connection.execute("PRAGMA table_info(prompts)").fetchall()}
            if "composer_json" not in columns:
                connection.execute("ALTER TABLE prompts ADD COLUMN composer_json TEXT NOT NULL DEFAULT '{}'")

    def record(
        self,
        *,
        prompt: str,
        user_prompt: str = "",
        title: str = "",
        lane: str = "",
        source: str = "simple",
        run_id: str = "",
        composer: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        text = prompt.strip()[:20_000]
        if not text:
            raise ValueError("A history entry requires a prompt")
        now = _now()
        composer_json = json.dumps(composer or {}, separators=(",", ":"), sort_keys=True)
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT prompt_id FROM prompts WHERE prompt = ? LIMIT 1", (text,)
            ).fetchone()
            if existing:
                connection.execute(
                    "UPDATE prompts SET use_count = use_count + 1, updated_at = ?, run_id = ?, composer_json = ? WHERE prompt_id = ?",
                    (now, run_id, composer_json, existing["prompt_id"]),
                )
                return self.get(existing["prompt_id"])
            prompt_id = f"ph_{uuid.uuid4().hex[:12]}"
            connection.execute(
                "INSERT INTO prompts (prompt_id, prompt, user_prompt, title, lane, source, run_id, composer_json, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    prompt_id,
                    text,
                    user_prompt.strip()[:20_000],
                    title.strip()[:180],
                    lane.strip()[:80],
                    source.strip()[:40] or "simple",
                    run_id,
                    composer_json,
                    now,
                    now,
                ),
            )
        return self.get(prompt_id)

    def get(self, prompt_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM prompts WHERE prompt_id = ?", (prompt_id,)).fetchone()
        if row is None:
            raise KeyError(f"Unknown prompt {prompt_id!r}")
        return self._entry(row)

    def list(self, *, favorites_only: bool = False, limit: int = 200) -> list[dict[str, Any]]:
        query = "SELECT * FROM prompts"
        if favorites_only:
            query += " WHERE favorite = 1"
        query += " ORDER BY updated_at DESC LIMIT ?"
        with self._connect() as connection:
            rows = connection.execute(query, (max(1, min(limit, 500)),)).fetchall()
        return [self._entry(row) for row in rows]

    def set_favorite(self, prompt_id: str, favorite: bool) -> dict[str, Any]:
        with self._connect() as connection:
            updated = connection.execute(
                "UPDATE prompts SET favorite = ?, updated_at = updated_at WHERE prompt_id = ?",
                (1 if favorite else 0, prompt_id),
            )
            if updated.rowcount == 0:
                raise KeyError(f"Unknown prompt {prompt_id!r}")
        return self.get(prompt_id)

    def delete(self, prompt_id: str) -> None:
        with self._connect() as connection:
            deleted = connection.execute("DELETE FROM prompts WHERE prompt_id = ?", (prompt_id,))
            if deleted.rowcount == 0:
                raise KeyError(f"Unknown prompt {prompt_id!r}")

    @staticmethod
    def _entry(row: sqlite3.Row) -> dict[str, Any]:
        try:
            composer = json.loads(row["composer_json"])
        except (json.JSONDecodeError, TypeError):
            composer = {}
        return {
            "prompt_id": row["prompt_id"],
            "prompt": row["prompt"],
            "user_prompt": row["user_prompt"],
            "title": row["title"],
            "lane": row["lane"],
            "source": row["source"],
            "run_id": row["run_id"],
            "composer": composer if isinstance(composer, dict) else {},
            "favorite": bool(row["favorite"]),
            "use_count": row["use_count"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
