"""SQLite state and policy helpers.

The migration runner is adapted from MaximSinyaev/obsidian-trading-tracker's
small SQLite module: row factory, WAL mode, foreign keys, and versioned SQL.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA: list[tuple[int, str]] = [
    (
        1,
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_ref TEXT NOT NULL,
            source_type TEXT NOT NULL CHECK (source_type IN ('url', 'file')),
            creator TEXT NOT NULL,
            title TEXT,
            duration_seconds REAL,
            rights_status TEXT NOT NULL DEFAULT 'research'
                CHECK (rights_status IN ('research', 'approved', 'rejected')),
            local_path TEXT,
            metadata_path TEXT,
            thumbnail_path TEXT,
            transcript_path TEXT,
            provenance_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'render_requested',
            top_n INTEGER NOT NULL,
            style TEXT NOT NULL,
            output_dir TEXT,
            podcli_command TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS clips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            slug TEXT NOT NULL,
            start_seconds REAL,
            end_seconds REAL,
            score REAL,
            rationale TEXT,
            transcript_excerpt TEXT,
            output_path TEXT,
            caption_path TEXT,
            status TEXT NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate', 'rendered', 'approved', 'rejected', 'scheduled')),
            created_at TEXT NOT NULL,
            UNIQUE (run_id, slug)
        );

        CREATE TABLE IF NOT EXISTS approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            clip_ids_json TEXT NOT NULL,
            reviewer TEXT NOT NULL,
            rights_note TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS post_drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            platform TEXT NOT NULL,
            scheduled_at TEXT NOT NULL,
            timezone TEXT NOT NULL,
            postiz_integration_id TEXT,
            postiz_status TEXT NOT NULL,
            postiz_post_id TEXT,
            payload_path TEXT,
            error TEXT,
            created_at TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        """
        CREATE TABLE IF NOT EXISTS monetization_opportunities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'closed')),
            source TEXT,
            url TEXT,
            payout_model TEXT,
            payout_range TEXT,
            platforms_json TEXT NOT NULL DEFAULT '[]',
            niches_json TEXT NOT NULL DEFAULT '[]',
            rights_requirement TEXT NOT NULL,
            content_source TEXT NOT NULL,
            stability TEXT NOT NULL,
            notes TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS opportunity_clip_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opportunity_id INTEGER NOT NULL REFERENCES monetization_opportunities(id) ON DELETE CASCADE,
            run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
            fit_score INTEGER NOT NULL,
            reasons_json TEXT NOT NULL DEFAULT '[]',
            warnings_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            UNIQUE (opportunity_id, run_id, clip_id)
        );
        """,
    ),
]


class PolicyError(RuntimeError):
    """Raised when the approval gate blocks an unsafe operation."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: str | Path) -> sqlite3.Connection:
    conn = connect(db_path)
    current = schema_version(conn)
    for version, sql in SCHEMA:
        if version <= current:
            continue
        conn.executescript(sql)
        conn.execute(
            "INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES (?, ?)",
            (version, utc_now()),
        )
    conn.commit()
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    try:
        row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    except sqlite3.OperationalError:
        return 0
    return int(row[0] or 0)


def add_source(
    conn: sqlite3.Connection,
    *,
    source_ref: str,
    source_type: str,
    creator: str,
    title: str | None,
    duration_seconds: float | None,
    local_path: str | None,
    metadata_path: str | None,
    thumbnail_path: str | None,
    transcript_path: str | None,
    provenance: dict[str, Any] | None = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO sources
            (source_ref, source_type, creator, title, duration_seconds, local_path,
             metadata_path, thumbnail_path, transcript_path, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            source_ref,
            source_type,
            creator,
            title,
            duration_seconds,
            local_path,
            metadata_path,
            thumbnail_path,
            transcript_path,
            json_dumps(provenance or {}),
            utc_now(),
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def create_run(
    conn: sqlite3.Connection,
    *,
    source_id: int,
    top_n: int,
    style: str,
    output_dir: str,
    podcli_command: str | None,
) -> int:
    now = utc_now()
    cur = conn.execute(
        """
        INSERT INTO runs
            (source_id, top_n, style, output_dir, podcli_command, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (source_id, top_n, style, output_dir, podcli_command, now, now),
    )
    conn.commit()
    return int(cur.lastrowid)


def set_run_status(conn: sqlite3.Connection, run_id: int, status: str) -> None:
    conn.execute(
        "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
        (status, utc_now(), run_id),
    )
    conn.commit()


def add_clip(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    slug: str,
    start_seconds: float | None = None,
    end_seconds: float | None = None,
    score: float | None = None,
    rationale: str | None = None,
    transcript_excerpt: str | None = None,
    output_path: str | None = None,
    caption_path: str | None = None,
    status: str = "candidate",
) -> int:
    cur = conn.execute(
        """
        INSERT INTO clips
            (run_id, slug, start_seconds, end_seconds, score, rationale,
             transcript_excerpt, output_path, caption_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, slug) DO UPDATE SET
            start_seconds = excluded.start_seconds,
            end_seconds = excluded.end_seconds,
            score = excluded.score,
            rationale = excluded.rationale,
            transcript_excerpt = excluded.transcript_excerpt,
            output_path = excluded.output_path,
            caption_path = excluded.caption_path,
            status = excluded.status
        """,
        (
            run_id,
            slug,
            start_seconds,
            end_seconds,
            score,
            rationale,
            transcript_excerpt,
            output_path,
            caption_path,
            status,
            utc_now(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM clips WHERE run_id = ? AND slug = ?", (run_id, slug)).fetchone()
    return int(row["id"] if row else cur.lastrowid)


def resolve_clip_ids(conn: sqlite3.Connection, run_id: int, requested: Iterable[str]) -> list[int]:
    ids: list[int] = []
    for raw in requested:
        value = raw.strip()
        if not value:
            continue
        if value.isdigit():
            row = conn.execute("SELECT id FROM clips WHERE run_id = ? AND id = ?", (run_id, int(value))).fetchone()
        else:
            row = conn.execute("SELECT id FROM clips WHERE run_id = ? AND slug = ?", (run_id, value)).fetchone()
        if row is None:
            raise ValueError(f"Clip {value!r} does not exist for run {run_id}")
        ids.append(int(row["id"]))
    if not ids:
        raise ValueError("At least one clip must be selected")
    return sorted(set(ids))


def approve_run(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    clip_ids: list[int],
    reviewer: str,
    rights_note: str | None,
) -> int:
    row = conn.execute(
        """
        SELECT sources.id AS source_id
        FROM runs JOIN sources ON sources.id = runs.source_id
        WHERE runs.id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"Run {run_id} does not exist")

    conn.execute("UPDATE sources SET rights_status = 'approved' WHERE id = ?", (int(row["source_id"]),))
    conn.execute("UPDATE runs SET status = 'approved', updated_at = ? WHERE id = ?", (utc_now(), run_id))
    conn.execute("UPDATE clips SET status = 'rejected' WHERE run_id = ?", (run_id,))
    for clip_id in clip_ids:
        conn.execute("UPDATE clips SET status = 'approved' WHERE id = ? AND run_id = ?", (clip_id, run_id))
    cur = conn.execute(
        """
        INSERT INTO approvals (run_id, clip_ids_json, reviewer, rights_note, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (run_id, json_dumps(clip_ids), reviewer, rights_note, utc_now()),
    )
    conn.commit()
    return int(cur.lastrowid)


def approved_clip_ids(conn: sqlite3.Connection, run_id: int) -> list[int]:
    rows = conn.execute("SELECT clip_ids_json FROM approvals WHERE run_id = ?", (run_id,)).fetchall()
    ids: set[int] = set()
    for row in rows:
        ids.update(int(v) for v in json.loads(row["clip_ids_json"]))
    return sorted(ids)


def assert_schedule_allowed(conn: sqlite3.Connection, run_id: int) -> list[sqlite3.Row]:
    row = conn.execute(
        """
        SELECT runs.id, runs.status, sources.rights_status
        FROM runs JOIN sources ON sources.id = runs.source_id
        WHERE runs.id = ?
        """,
        (run_id,),
    ).fetchone()
    if row is None:
        raise PolicyError(f"Run {run_id} does not exist")
    if row["rights_status"] != "approved":
        raise PolicyError("Scheduling blocked: source rights_status is not approved")
    ids = approved_clip_ids(conn, run_id)
    if not ids:
        raise PolicyError("Scheduling blocked: run has no approval record")
    clips = conn.execute(
        f"SELECT * FROM clips WHERE run_id = ? AND id IN ({','.join('?' for _ in ids)}) ORDER BY id",
        (run_id, *ids),
    ).fetchall()
    if not clips:
        raise PolicyError("Scheduling blocked: approved clip rows were not found")
    return clips


def add_post_draft(
    conn: sqlite3.Connection,
    *,
    run_id: int,
    clip_id: int,
    platform: str,
    scheduled_at: str,
    tz: str,
    integration_id: str | None,
    status: str,
    post_id: str | None = None,
    payload_path: str | None = None,
    error: str | None = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO post_drafts
            (run_id, clip_id, platform, scheduled_at, timezone, postiz_integration_id,
             postiz_status, postiz_post_id, payload_path, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (run_id, clip_id, platform, scheduled_at, tz, integration_id, status, post_id, payload_path, error, utc_now()),
    )
    conn.commit()
    return int(cur.lastrowid)


def get_run_bundle(conn: sqlite3.Connection, run_id: int) -> dict[str, Any]:
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if run is None:
        raise ValueError(f"Run {run_id} does not exist")
    source = conn.execute("SELECT * FROM sources WHERE id = ?", (run["source_id"],)).fetchone()
    clips = conn.execute("SELECT * FROM clips WHERE run_id = ? ORDER BY id", (run_id,)).fetchall()
    approvals = conn.execute("SELECT * FROM approvals WHERE run_id = ? ORDER BY id", (run_id,)).fetchall()
    drafts = conn.execute("SELECT * FROM post_drafts WHERE run_id = ? ORDER BY id", (run_id,)).fetchall()
    return {
        "run": dict(run),
        "source": dict(source) if source else {},
        "clips": [dict(row) for row in clips],
        "approvals": [dict(row) for row in approvals],
        "drafts": [dict(row) for row in drafts],
    }
