"""One-time, exact-scope approval receipts for consequential actions."""

from __future__ import annotations

import hashlib
import hmac
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ApprovalLedger:
    def __init__(self, path: str | Path, *, signing_secret: str, operator_token: str):
        if len(signing_secret) < 32:
            raise ValueError("Approval signing secret must be at least 32 characters")
        if len(operator_token) < 12:
            raise ValueError("Operator token must be at least 12 characters")
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._secret = signing_secret.encode()
        self._operator_token = operator_token
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    amount_usd REAL NOT NULL,
                    target TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    decided_at TEXT,
                    decided_by TEXT,
                    consumed_at TEXT
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def request(self, *, run_id: str, kind: str, provider: str, amount_usd: float, target: str, reason: str) -> dict[str, Any]:
        if amount_usd < 0:
            raise ValueError("Approval amount cannot be negative")
        now = _now()
        scope = (run_id, kind, provider, round(float(amount_usd), 4), target)
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT * FROM approvals WHERE run_id=? AND kind=? AND provider=? AND amount_usd=? AND target=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1",
                scope,
            ).fetchone()
            if existing:
                return self._row(existing)
            approval_id = "appr_" + uuid.uuid4().hex
            connection.execute(
                "INSERT INTO approvals(id,run_id,kind,provider,amount_usd,target,reason,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)",
                (approval_id, *scope, reason.strip(), now.isoformat(), (now + timedelta(hours=24)).isoformat()),
            )
        return self.get(approval_id)

    def approve(self, approval_id: str, *, operator_token: str, decided_by: str) -> dict[str, Any]:
        if not hmac.compare_digest(operator_token, self._operator_token):
            raise PermissionError("A valid operator token is required to approve this action")
        now = _now()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
            if not row:
                raise KeyError(f"Unknown approval: {approval_id}")
            if row["status"] != "pending":
                raise ValueError(f"Approval is already {row['status']}")
            connection.execute(
                "UPDATE approvals SET status='approved', decided_at=?, decided_by=?, expires_at=? WHERE id=?",
                (now.isoformat(), decided_by.strip() or "operator", (now + timedelta(hours=1)).isoformat(), approval_id),
            )
            connection.commit()
        result = self.get(approval_id)
        result["token"] = self._token(result)
        return result

    def deny(self, approval_id: str, *, operator_token: str, decided_by: str) -> dict[str, Any]:
        if not hmac.compare_digest(operator_token, self._operator_token):
            raise PermissionError("A valid operator token is required to deny this action")
        now = _now().isoformat()
        with self._connect() as connection:
            cursor = connection.execute("UPDATE approvals SET status='denied', decided_at=?, decided_by=? WHERE id=? AND status='pending'", (now, decided_by, approval_id))
            if cursor.rowcount != 1:
                raise ValueError("Approval is missing or is not pending")
        return self.get(approval_id)

    def consume(self, token: str, *, run_id: str, kind: str, provider: str, amount_usd: float, target: str) -> dict[str, Any]:
        approval_id, separator, signature = token.partition(".")
        if not separator or not approval_id.startswith("appr_"):
            raise ValueError("Approval token is malformed")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
            if not row:
                raise ValueError("Approval token is unknown")
            record = self._row(row)
            expected = self._token(record).partition(".")[2]
            if not hmac.compare_digest(signature, expected):
                raise ValueError("Approval token signature is invalid")
            if record["status"] == "consumed":
                raise ValueError("Approval was already consumed")
            if record["status"] != "approved":
                raise ValueError(f"Approval is not usable: {record['status']}")
            if _now() > datetime.fromisoformat(record["expires_at"]):
                connection.execute("UPDATE approvals SET status='expired' WHERE id=?", (approval_id,))
                connection.commit()
                raise ValueError("Approval has expired")
            requested = (run_id, kind, provider, round(float(amount_usd), 4), target)
            actual = (record["run_id"], record["kind"], record["provider"], round(float(record["amount_usd"]), 4), record["target"])
            if requested != actual:
                raise ValueError("Approval token does not match the requested action scope")
            consumed_at = _now().isoformat()
            connection.execute("UPDATE approvals SET status='consumed', consumed_at=? WHERE id=?", (consumed_at, approval_id))
            connection.commit()
        return self.get(approval_id)

    def get(self, approval_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
        if not row:
            raise KeyError(f"Unknown approval: {approval_id}")
        return self._row(row)

    def list(self, *, run_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if run_id:
            clauses.append("run_id=?")
            params.append(run_id)
        if status:
            clauses.append("status=?")
            params.append(status)
        query = "SELECT * FROM approvals" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY created_at DESC"
        with self._connect() as connection:
            rows = connection.execute(query, params).fetchall()
        return [self._row(row) for row in rows]

    def _token(self, record: dict[str, Any]) -> str:
        payload = "\0".join(
            str(record[key]) for key in ("id", "run_id", "kind", "provider", "amount_usd", "target", "expires_at")
        )
        signature = hmac.new(self._secret, payload.encode(), hashlib.sha256).hexdigest()
        return f"{record['id']}.{signature}"

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        return {key: row[key] for key in row.keys()}
