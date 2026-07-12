"""Canonical run manifest and approval state."""

from __future__ import annotations

import json
import hashlib
import mimetypes
import os
import re
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MANIFEST_VERSION = 2


class ManifestConflictError(RuntimeError):
    """Raised when a stale writer would overwrite a newer manifest revision."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "run"


def create_manifest(*, lane: str, brief: dict[str, Any], runs_dir: Path, providers: dict[str, str]) -> tuple[Path, dict[str, Any]]:
    identity = str(brief.get("id") or brief.get("title") or brief.get("subject") or lane)
    run_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{slugify(identity)}"
    run_dir = runs_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    manifest = {
        "schema_version": MANIFEST_VERSION,
        "revision": 0,
        "run_id": run_id,
        "lane": lane,
        "status": "planned",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "brief": brief,
        "providers": providers,
        "artifacts": [],
        "approval": {"status": "pending", "reviewer": None, "rights_note": None, "approved_at": None},
        "publish": {"drafts": [], "receipts": []},
    }
    manifest_path = run_dir / "manifest.json"
    write_manifest(manifest_path, manifest)
    return manifest_path, manifest


def load_manifest(path: str | Path) -> dict[str, Any]:
    manifest_path = Path(path).expanduser().resolve()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = data.get("schema_version")
    if version == 1:
        data = _migrate_v1(data)
    elif version != MANIFEST_VERSION:
        raise ValueError(f"Unsupported manifest schema in {manifest_path}")
    return data


def write_manifest(path: str | Path, manifest: dict[str, Any]) -> Path:
    manifest_path = Path(path).expanduser().resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with _manifest_lock(manifest_path):
        base_revision = int(manifest.get("revision") or 0)
        if manifest_path.exists():
            current = json.loads(manifest_path.read_text(encoding="utf-8"))
            current_revision = int(current.get("revision") or (1 if current.get("schema_version") == 1 else 0))
            if current_revision != base_revision:
                raise ManifestConflictError(
                    f"Manifest revision conflict: writer has {base_revision}, current file is {current_revision}"
                )
        manifest["schema_version"] = MANIFEST_VERSION
        manifest["revision"] = base_revision + 1
        manifest["updated_at"] = utc_now()
        fd, temp_name = tempfile.mkstemp(prefix=".manifest-", suffix=".json", dir=manifest_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(manifest, handle, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(temp_name, manifest_path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return manifest_path


@contextmanager
def _manifest_lock(manifest_path: Path):
    lock_path = manifest_path.with_suffix(manifest_path.suffix + ".lock")
    with lock_path.open("a+b") as handle:
        if os.name == "nt":  # pragma: no cover - exercised on Windows CI/installations
            import msvcrt

            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def add_artifact(
    manifest: dict[str, Any],
    *,
    role: str,
    path: Path,
    provider: str | None = None,
    scene: int | None = None,
    model: str | None = None,
    job_id: str | None = None,
    source_url: str | None = None,
    depends_on: list[str] | None = None,
) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    sha256, size_bytes = _file_identity(resolved)
    identity = f"{role}\0{resolved}\0{sha256}"
    artifact: dict[str, Any] = {
        "id": "art_" + uuid.uuid5(uuid.NAMESPACE_URL, identity).hex[:20],
        "role": role,
        "path": str(resolved),
        "provider": provider,
        "sha256": sha256,
        "size_bytes": size_bytes,
        "mime_type": mimetypes.guess_type(resolved.name)[0] or "application/octet-stream",
        "created_at": utc_now(),
        "depends_on": list(depends_on or []),
    }
    if scene is not None:
        artifact["scene"] = int(scene)
    if model:
        artifact["model"] = model
    if job_id:
        artifact["job_id"] = job_id
    if source_url:
        artifact["source_url"] = source_url
    manifest.setdefault("artifacts", []).append(artifact)
    return artifact


def _file_identity(path: Path) -> tuple[str, int]:
    if not path.is_file():
        return "", 0
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def _migrate_v1(data: dict[str, Any]) -> dict[str, Any]:
    migrated = dict(data)
    migrated["schema_version"] = MANIFEST_VERSION
    migrated["revision"] = max(1, int(migrated.get("revision") or 1))
    artifacts: list[dict[str, Any]] = []
    for raw in migrated.get("artifacts", []):
        if not isinstance(raw, dict):
            continue
        path = Path(str(raw.get("path") or "")).expanduser().resolve()
        sha256, size_bytes = _file_identity(path)
        identity = f"{raw.get('role', 'artifact')}\0{path}\0{sha256}"
        artifacts.append(
            {
                **raw,
                "id": raw.get("id") or "art_" + uuid.uuid5(uuid.NAMESPACE_URL, identity).hex[:20],
                "sha256": raw.get("sha256") or sha256,
                "size_bytes": raw.get("size_bytes", size_bytes),
                "mime_type": raw.get("mime_type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "created_at": raw.get("created_at") or migrated.get("created_at") or utc_now(),
                "depends_on": list(raw.get("depends_on") or []),
            }
        )
    migrated["artifacts"] = artifacts
    return migrated


def approve_manifest(path: str | Path, *, reviewer: str, rights_note: str) -> dict[str, Any]:
    if not reviewer.strip() or not rights_note.strip():
        raise ValueError("Reviewer and rights note are required")
    manifest = load_manifest(path)
    manifest["approval"] = {
        "status": "approved",
        "reviewer": reviewer.strip(),
        "rights_note": rights_note.strip(),
        "approved_at": utc_now(),
    }
    manifest["status"] = "approved"
    write_manifest(path, manifest)
    return manifest
