"""One-time privacy migration for legacy plaintext run directories.

Older runs embedded the brief title (prompt text) in the run id/directory name
and stored prompt-bearing sidecar files in plaintext. This sweep renames those
directories to opaque lane-based ids, rewrites every stored reference (run
store, approvals ledger, prompt history, manifest, sidecars), and encrypts the
prompt-bearing files with the same private cipher used for new writes.
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from .config import load_config
from .manifest import load_manifest, slugify, write_manifest
from .private_access import (
    PRIVATE_MEDIA_SUFFIX,
    encrypt_private_media,
    is_private_text_file,
    write_private_text,
)


_RUN_DIR_RE = re.compile(r"^(?P<stamp>\d{8}T\d{6,12}Z)-(?P<slug>.+)$")

# Exactly the prompt-bearing files the writers now encrypt.
_PRIVATE_FILE_NAMES = {
    "brief.yaml",
    "script.md",
    "agent-script.md",
    "script-request.json",
    "script-receipt.json",
    "scene_manifest.csv",
    "image-prompts.md",
    "motion-prompts.md",
    "voice-lines.md",
    "music-brief.md",
    "publish-metadata.json",
    "keyframe-requests.json",
    "motion-requests.json",
    "editor-handoff.json",
    "stickman-scenes.json",
    "static-text-scenes.json",
    "faceless-params.json",
    "clip-plan.json",
    "evaluation-request.json",
    "semantic-evaluation.json",
}
# Explicit operator exports and external helper state stay readable in place.
_SKIP_DIR_NAMES = {"capcut-handoff"}

_MEDIA_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".gif",
    ".mp4", ".mov", ".webm", ".mkv", ".m4v",
    ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac",
}


def _is_private_file(path: Path) -> bool:
    return path.name in _PRIVATE_FILE_NAMES or path.name.endswith(".payload.json")


def _raw_lane(run_dir: Path) -> str:
    try:
        data = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return str(data.get("lane") or "")


def _opaque_slug(slug: str, lane: str) -> bool:
    expected = re.escape(slugify(lane or "run"))
    return bool(re.fullmatch(rf"{expected}(-[0-9a-f]{{6}})?", slug))


def _replace_in_sqlite(db_path: Path, statements: list[tuple[str, tuple[Any, ...]]]) -> None:
    if not db_path.is_file():
        return
    connection = sqlite3.connect(db_path, timeout=30)
    try:
        connection.execute("PRAGMA busy_timeout = 30000")
        for statement, parameters in statements:
            try:
                connection.execute(statement, parameters)
            except sqlite3.OperationalError:
                continue  # table absent in this database
        connection.commit()
    finally:
        connection.close()


def _rewrite_references(run_dir: Path, replacements: list[tuple[str, str]]) -> None:
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file() or path.suffix in {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".m4a", ".wav", ".zenc", ".lock"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        updated = text
        for old, new in replacements:
            updated = updated.replace(old, new)
        if updated != text:
            path.write_text(updated, encoding="utf-8")


def _encrypt_run_files(run_dir: Path) -> int:
    encrypted = 0
    for path in sorted(run_dir.rglob("*")):
        if not path.is_file() or not _is_private_file(path):
            continue
        if any(parent.name in _SKIP_DIR_NAMES for parent in path.parents):
            continue
        if is_private_text_file(path):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        write_private_text(path, text)
        encrypted += 1
    return encrypted


def _encrypt_run_media(run_dir: Path) -> int:
    encrypted = 0
    for path in sorted(run_dir.rglob("*")):
        if (
            not path.is_file()
            or path.name.startswith(".")
            or path.name.endswith(PRIVATE_MEDIA_SUFFIX)
            or path.suffix.lower() not in _MEDIA_SUFFIXES
        ):
            continue
        if any(parent.name in _SKIP_DIR_NAMES for parent in path.parents):
            continue
        if encrypt_private_media(path):
            encrypted += 1
    return encrypted


def migrate_private_runs(
    *,
    runs_dir: Path | None = None,
    store_path: Path | None = None,
) -> dict[str, int]:
    """Idempotent sweep; safe to run at every control-app start."""
    cfg = load_config()
    runs_root = (runs_dir or cfg.runs_dir).expanduser().resolve()
    database = (store_path or cfg.data_dir / "content-studio.sqlite3").expanduser().resolve()
    approvals = database.parent / "content-studio-approvals.sqlite3"
    prompt_history = database.parent / "prompt-history.sqlite3"
    counts = {"renamed": 0, "files_encrypted": 0, "manifests_sealed": 0, "media_encrypted": 0}
    if not runs_root.is_dir():
        return counts

    for run_dir in sorted(runs_root.iterdir()):
        if not run_dir.is_dir():
            continue
        match = _RUN_DIR_RE.match(run_dir.name)
        lane = _raw_lane(run_dir)
        old_run_id = run_dir.name
        target_dir = run_dir
        if match and not _opaque_slug(match.group("slug"), lane):
            new_run_id = f"{match.group('stamp')}-{slugify(lane or 'run')}-{uuid.uuid4().hex[:6]}"
            target_dir = runs_root / new_run_id
            run_dir.rename(target_dir)
            replacements = [(str(run_dir), str(target_dir)), (old_run_id, new_run_id)]
            _rewrite_references(target_dir, replacements)
            for old, new in replacements:
                like = f"%{old}%"
                _replace_in_sqlite(database, [
                    ("UPDATE runs SET run_id = REPLACE(run_id, ?, ?), manifest_path = REPLACE(manifest_path, ?, ?)", (old, new, old, new)),
                    ("UPDATE steps SET run_id = REPLACE(run_id, ?, ?), next_actions_json = REPLACE(next_actions_json, ?, ?)", (old, new, old, new)),
                    ("UPDATE events SET run_id = REPLACE(run_id, ?, ?), payload_json = REPLACE(payload_json, ?, ?) WHERE run_id LIKE ? OR payload_json LIKE ?", (old, new, old, new, like, like)),
                ])
                _replace_in_sqlite(approvals, [
                    ("UPDATE approvals SET run_id = REPLACE(run_id, ?, ?), target = REPLACE(target, ?, ?)", (old, new, old, new)),
                ])
                _replace_in_sqlite(prompt_history, [
                    ("UPDATE prompts SET run_id = REPLACE(run_id, ?, ?)", (old, new)),
                ])
            counts["renamed"] += 1

        manifest_path = target_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                raw = json.loads(manifest_path.read_text(encoding="utf-8"))
                plaintext_sections = any(isinstance(raw.get(key), dict) for key in ("brief", "studio", "publish"))
                if plaintext_sections:
                    # Round-trip through the canonical writer to seal sections.
                    write_manifest(manifest_path, load_manifest(manifest_path))
                    counts["manifests_sealed"] += 1
            except (OSError, ValueError, json.JSONDecodeError):
                pass
        counts["files_encrypted"] += _encrypt_run_files(target_dir)
        counts["media_encrypted"] += _encrypt_run_media(target_dir)
    return counts
