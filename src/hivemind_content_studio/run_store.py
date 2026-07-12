"""Concurrency-safe durable run, step, and event state."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class RunStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    manifest_path TEXT NOT NULL,
                    lane TEXT NOT NULL,
                    status TEXT NOT NULL,
                    current_step TEXT,
                    revision INTEGER NOT NULL DEFAULT 1,
                    policy_json TEXT NOT NULL,
                    budget_json TEXT NOT NULL,
                    cancellation_reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS steps (
                    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
                    step_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    provider TEXT,
                    job_id TEXT,
                    idempotency_key TEXT NOT NULL,
                    error TEXT,
                    next_actions_json TEXT NOT NULL DEFAULT '[]',
                    started_at TEXT,
                    completed_at TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, step_id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
                """
            )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def create_run(
        self,
        *,
        run_id: str,
        manifest_path: str | Path,
        lane: str,
        steps: list[str],
        policy: dict[str, Any],
        budget: dict[str, Any],
    ) -> dict[str, Any]:
        if not steps:
            raise ValueError("A run requires at least one step")
        now = _now()
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO runs(run_id, manifest_path, lane, status, current_step, policy_json, budget_json, created_at, updated_at) VALUES(?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
                (run_id, str(Path(manifest_path).expanduser().resolve()), lane, steps[0], json.dumps(policy), json.dumps(budget), now, now),
            )
            connection.executemany(
                "INSERT INTO steps(run_id, step_id, position, status, idempotency_key, updated_at) VALUES(?, ?, ?, 'pending', ?, ?)",
                [(run_id, step, position, f"{run_id}:{step}", now) for position, step in enumerate(steps)],
            )
            connection.execute(
                "INSERT INTO events(run_id, kind, payload_json, created_at) VALUES(?, 'run.created', ?, ?)",
                (run_id, json.dumps({"lane": lane, "steps": steps}), now),
            )
        return self.get_run(run_id)

    def set_step_status(
        self,
        run_id: str,
        step_id: str,
        status: str,
        *,
        error: str | None = None,
        next_actions: list[dict[str, Any]] | None = None,
        provider: str | None = None,
        job_id: str | None = None,
    ) -> dict[str, Any]:
        now = _now()
        started_at = now if status == "running" else None
        completed_at = now if status in {"completed", "skipped"} else None
        with self._transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE steps SET status=?, error=?, next_actions_json=?, provider=COALESCE(?, provider),
                  job_id=COALESCE(?, job_id), started_at=COALESCE(started_at, ?),
                  completed_at=COALESCE(?, completed_at), updated_at=?
                WHERE run_id=? AND step_id=?
                """,
                (status, error, json.dumps(next_actions or []), provider, job_id, started_at, completed_at, now, run_id, step_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"Unknown run step: {run_id}/{step_id}")
            run_status = status if status not in {"pending", "running", "completed", "skipped"} else ("running" if status == "running" else "queued")
            connection.execute(
                "UPDATE runs SET status=?, current_step=?, revision=revision+1, updated_at=? WHERE run_id=?",
                (run_status, step_id, now, run_id),
            )
        return self.get_step(run_id, step_id)

    def complete_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        now = _now()
        with self._transaction() as connection:
            row = connection.execute("SELECT position FROM steps WHERE run_id=? AND step_id=?", (run_id, step_id)).fetchone()
            if not row:
                raise KeyError(f"Unknown run step: {run_id}/{step_id}")
            connection.execute(
                "UPDATE steps SET status='completed', completed_at=?, next_actions_json='[]', error=NULL, updated_at=? WHERE run_id=? AND step_id=?",
                (now, now, run_id, step_id),
            )
            next_row = connection.execute(
                "SELECT step_id FROM steps WHERE run_id=? AND position>? AND status NOT IN ('completed','skipped') ORDER BY position LIMIT 1",
                (run_id, row["position"]),
            ).fetchone()
            status = "queued" if next_row else "completed"
            current = next_row["step_id"] if next_row else None
            connection.execute(
                "UPDATE runs SET status=?, current_step=?, revision=revision+1, updated_at=? WHERE run_id=?",
                (status, current, now, run_id),
            )
        return self.get_run(run_id)

    def append_event(self, run_id: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = _now()
        with self._transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO events(run_id, kind, payload_json, created_at) VALUES(?, ?, ?, ?)",
                (run_id, kind, json.dumps(payload), now),
            )
        return {"id": cursor.lastrowid, "kind": kind, "payload": payload, "created_at": now}

    def list_events(
        self,
        *,
        kind_prefix: str = "",
        run_id: str = "",
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        query = "SELECT events.*, runs.lane FROM events JOIN runs ON runs.run_id = events.run_id"
        clauses: list[str] = []
        params: list[Any] = []
        if kind_prefix:
            clauses.append("events.kind LIKE ?")
            params.append(f"{kind_prefix}%")
        if run_id:
            clauses.append("events.run_id = ?")
            params.append(run_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY events.id DESC LIMIT ?"
        params.append(max(1, min(10_000, int(limit))))
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [
            {
                "id": row["id"],
                "run_id": row["run_id"],
                "lane": row["lane"],
                "kind": row["kind"],
                "payload": json.loads(row["payload_json"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def record_spend(self, run_id: str, amount_usd: float, *, provider: str, intent: str) -> dict[str, Any]:
        amount = round(float(amount_usd), 4)
        if amount < 0:
            raise ValueError("Spend cannot be negative")
        now = _now()
        with self._transaction() as connection:
            row = connection.execute("SELECT budget_json FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not row:
                raise KeyError(f"Unknown run: {run_id}")
            budget = json.loads(row["budget_json"])
            maximum = float(budget.get("max_cost_usd") or 0)
            spent = float(budget.get("spent_usd") or 0)
            next_spent = round(spent + amount, 4)
            if next_spent > maximum:
                raise ValueError(f"Spend would exceed run budget (${next_spent:.4f} > ${maximum:.4f})")
            budget["spent_usd"] = next_spent
            connection.execute(
                "UPDATE runs SET budget_json=?, revision=revision+1, updated_at=? WHERE run_id=?",
                (json.dumps(budget), now, run_id),
            )
            connection.execute(
                "INSERT INTO events(run_id, kind, payload_json, created_at) VALUES(?, 'budget.spent', ?, ?)",
                (run_id, json.dumps({"amount_usd": amount, "provider": provider, "intent": intent, "spent_usd": next_spent}), now),
            )
        return budget

    def get_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM steps WHERE run_id=? AND step_id=?", (run_id, step_id)).fetchone()
        if not row:
            raise KeyError(f"Unknown run step: {run_id}/{step_id}")
        return self._step(row)

    def get_run(self, run_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            run = connection.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run:
                raise KeyError(f"Unknown run: {run_id}")
            steps = connection.execute("SELECT * FROM steps WHERE run_id=? ORDER BY position", (run_id,)).fetchall()
            events = connection.execute("SELECT * FROM events WHERE run_id=? ORDER BY id", (run_id,)).fetchall()
        return {
            "run_id": run["run_id"],
            "manifest_path": run["manifest_path"],
            "lane": run["lane"],
            "status": run["status"],
            "current_step": run["current_step"],
            "revision": run["revision"],
            "policy": json.loads(run["policy_json"]),
            "budget": json.loads(run["budget_json"]),
            "cancellation_reason": run["cancellation_reason"],
            "created_at": run["created_at"],
            "updated_at": run["updated_at"],
            "steps": [self._step(row) for row in steps],
            "events": [
                {"id": row["id"], "kind": row["kind"], "payload": json.loads(row["payload_json"]), "created_at": row["created_at"]}
                for row in events
            ],
        }

    def list_runs(self, *, status: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        query = "SELECT run_id FROM runs"
        params: list[Any] = []
        if status:
            query += " WHERE status=?"
            params.append(status)
        query += " ORDER BY updated_at DESC LIMIT ?"
        params.append(max(1, min(1000, limit)))
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self.get_run(row["run_id"]) for row in rows]

    def retry_step(self, run_id: str, step_id: str) -> dict[str, Any]:
        now = _now()
        with self._transaction() as connection:
            cursor = connection.execute(
                "UPDATE steps SET status='pending', attempts=attempts+1, error=NULL, next_actions_json='[]', updated_at=? WHERE run_id=? AND step_id=? AND attempts<max_attempts",
                (now, run_id, step_id),
            )
            if cursor.rowcount != 1:
                raise ValueError("Step cannot be retried or has exhausted its attempts")
            connection.execute("UPDATE runs SET status='queued', current_step=?, revision=revision+1, updated_at=? WHERE run_id=?", (step_id, now, run_id))
        return self.get_step(run_id, step_id)

    def cancel_run(self, run_id: str, reason: str) -> dict[str, Any]:
        now = _now()
        with self._transaction() as connection:
            cursor = connection.execute(
                "UPDATE runs SET status='cancelled', cancellation_reason=?, revision=revision+1, updated_at=? WHERE run_id=?",
                (reason.strip() or "cancelled", now, run_id),
            )
            if cursor.rowcount != 1:
                raise KeyError(f"Unknown run: {run_id}")
            connection.execute("UPDATE steps SET status='cancelled', updated_at=? WHERE run_id=? AND status IN ('pending','running')", (now, run_id))
        self.append_event(run_id, "run.cancelled", {"reason": reason})
        return self.get_run(run_id)

    def resume_run(self, run_id: str) -> dict[str, Any]:
        now = _now()
        with self._transaction() as connection:
            run = connection.execute("SELECT status FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not run:
                raise KeyError(f"Unknown run: {run_id}")
            connection.execute("UPDATE steps SET status='pending', updated_at=? WHERE run_id=? AND status='cancelled'", (now, run_id))
            current = connection.execute("SELECT step_id FROM steps WHERE run_id=? AND status NOT IN ('completed','skipped') ORDER BY position LIMIT 1", (run_id,)).fetchone()
            connection.execute(
                "UPDATE runs SET status='queued', current_step=?, cancellation_reason=NULL, revision=revision+1, updated_at=? WHERE run_id=?",
                (current["step_id"] if current else None, now, run_id),
            )
        self.append_event(run_id, "run.resumed", {})
        return self.get_run(run_id)

    @staticmethod
    def _step(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "step_id": row["step_id"],
            "position": row["position"],
            "status": row["status"],
            "attempts": row["attempts"],
            "max_attempts": row["max_attempts"],
            "provider": row["provider"],
            "job_id": row["job_id"],
            "idempotency_key": row["idempotency_key"],
            "error": row["error"],
            "next_actions": json.loads(row["next_actions_json"]),
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
            "updated_at": row["updated_at"],
        }
