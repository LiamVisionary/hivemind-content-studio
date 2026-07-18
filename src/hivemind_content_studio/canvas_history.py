"""Opaque, non-destructive index of encrypted Canvas output history."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .private_access import PrivateFieldCipher


CANVAS_MEDIA_SUFFIXES = {
    ".gif",
    ".jpeg",
    ".jpg",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".png",
    ".webm",
    ".webp",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _history_metadata(record: dict[str, Any], *, timestamp_source: str) -> dict[str, Any]:
    outputs = record.get("outputs") if isinstance(record.get("outputs"), list) else []
    return {
        "id": str(record.get("id") or ""),
        "status": str(record.get("status") or "unknown"),
        "created_at": str(record.get("created_at") or ""),
        "finished_at": str(record.get("finished_at") or ""),
        "outputs": [str(output) for output in outputs],
        "source": str(record.get("source") or "history"),
        "timestamp_source": timestamp_source,
    }


class CanvasHistoryStore:
    def __init__(self, path: str | Path, *, cipher: PrivateFieldCipher):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.cipher = cipher
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS canvas_history (
                    history_id TEXT PRIMARY KEY,
                    source_digest TEXT NOT NULL,
                    output_digest TEXT NOT NULL UNIQUE,
                    output_name TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    encrypted_at_rest INTEGER NOT NULL DEFAULT 0,
                    timestamp_source TEXT NOT NULL DEFAULT 'filesystem',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_canvas_history_created ON canvas_history(created_at DESC);
                """
            )
            schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if schema_version < 1:
                # This is a derived index. Rebuild v0 rows so same-named files
                # in different private roots keep distinct opaque identities.
                connection.execute("DELETE FROM canvas_history")
                connection.execute("PRAGMA user_version = 1")
            columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(canvas_history)")}
            if "timestamp_source" not in columns:
                connection.execute(
                    "ALTER TABLE canvas_history ADD COLUMN timestamp_source TEXT NOT NULL DEFAULT 'filesystem'"
                )
            if "provenance" not in columns:
                connection.execute("ALTER TABLE canvas_history ADD COLUMN provenance TEXT")
            if schema_version < 2:
                connection.execute("PRAGMA user_version = 2")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    def sync(self, records: list[dict[str, Any]]) -> int:
        changed = 0
        now = _now()
        with self._connect() as connection:
            for record in records:
                if not isinstance(record, dict):
                    continue
                source_id = str(record.get("id") or "")
                timestamp = str(record.get("finished_at") or record.get("created_at") or now)
                timestamp_source = str(record.get("timestamp_source") or "filesystem")[:40]
                status = str(record.get("status") or "unknown")[:40]
                outputs = record.get("outputs") if isinstance(record.get("outputs"), list) else []
                for output in outputs:
                    stored = Path(str(output)).expanduser()
                    logical = stored.with_name(stored.name.removesuffix(".zenc")) if stored.name.endswith(".zenc") else stored
                    logical = logical.resolve()
                    output_name = logical.name
                    if not output_name:
                        continue
                    encrypted_path = Path(str(logical) + ".zenc")
                    if not logical.is_file() and not encrypted_path.is_file():
                        continue
                    output_locator = str(logical)
                    output_digest = self.cipher.digest(output_locator)
                    history_id = "canvas_" + hashlib.sha256(f"{source_id}\0{output_locator}".encode("utf-8")).hexdigest()[:20]
                    media_type = mimetypes.guess_type(output_name)[0] or "application/octet-stream"
                    encrypted = stored.name.endswith(".zenc") or encrypted_path.is_file()
                    before = connection.total_changes
                    connection.execute(
                        """
                        INSERT INTO canvas_history(history_id, source_digest, output_digest, output_name, media_type, status, encrypted_at_rest, timestamp_source, created_at, updated_at)
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(output_digest) DO UPDATE SET
                          status=excluded.status,
                          encrypted_at_rest=MAX(canvas_history.encrypted_at_rest, excluded.encrypted_at_rest),
                          timestamp_source=CASE
                            WHEN excluded.timestamp_source='gateway-history' THEN excluded.timestamp_source
                            ELSE canvas_history.timestamp_source
                          END,
                          created_at=CASE
                            WHEN excluded.timestamp_source='gateway-history' THEN excluded.created_at
                            ELSE canvas_history.created_at
                          END,
                          updated_at=excluded.updated_at
                        """,
                        (
                            history_id,
                            self.cipher.digest(source_id or history_id),
                            output_digest,
                            self.cipher.encrypt(output_locator),
                            media_type,
                            status,
                            1 if encrypted else 0,
                            timestamp_source,
                            timestamp,
                            now,
                        ),
                    )
                    changed += connection.total_changes - before
        return changed

    def list(self, *, limit: int = 300) -> list[dict[str, Any]]:
        return self.page(page=1, page_size=limit)["items"]

    def page(
        self,
        *,
        page: int = 1,
        page_size: int = 48,
        file_format: str = "",
        model: str = "",
    ) -> dict[str, Any]:
        bounded_page = max(1, int(page))
        bounded_page_size = max(1, min(100, int(page_size)))
        requested_format = file_format.strip().lower().lstrip(".")[:20]
        requested_model = model.strip().casefold()[:512]
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM canvas_history
                ORDER BY CASE WHEN timestamp_source='imported' THEN 1 ELSE 0 END, created_at DESC
                LIMIT 5000
                """,
            ).fetchall()
        visible: list[dict[str, Any]] = []
        seen_names: set[str] = set()
        formats: set[str] = set()
        models: set[str] = set()
        for row in rows:
            locator = self.cipher.decrypt(str(row["output_name"]))
            output_name = Path(locator).name
            name_digest = self.cipher.digest(output_name)
            if name_digest in seen_names:
                continue
            seen_names.add(name_digest)
            suffix = Path(output_name).suffix.lower().lstrip(".") or "unknown"
            formats.add(suffix)
            provenance = self._provenance(row)
            row_models = provenance.get("models") if isinstance(provenance.get("models"), list) else []
            models.update(str(value) for value in row_models if isinstance(value, str) and value)
            if requested_format and suffix != requested_format:
                continue
            if requested_model and not any(str(value).casefold() == requested_model for value in row_models):
                continue
            visible.append(self._public(row, file_format=suffix, provenance=provenance))

        total = len(visible)
        start = (bounded_page - 1) * bounded_page_size
        items = visible[start:start + bounded_page_size]
        return {
            "items": items,
            "page": bounded_page,
            "page_size": bounded_page_size,
            "total": total,
            "has_more": start + len(items) < total,
            "filters": {
                "formats": sorted(formats),
                "models": sorted(models, key=str.casefold),
            },
        }

    def output_name(self, history_id: str) -> str:
        with self._connect() as connection:
            row = connection.execute("SELECT output_name FROM canvas_history WHERE history_id = ?", (history_id,)).fetchone()
        if row is None:
            raise KeyError(history_id)
        return self.cipher.decrypt(str(row["output_name"]))

    def remember_provenance(
        self,
        history_id: str,
        *,
        models: list[str],
        seeds: list[dict[str, Any]],
    ) -> dict[str, Any]:
        output_name = Path(self.output_name(history_id)).name
        clean_models = list(dict.fromkeys(
            value.strip()[:512]
            for value in models[:64]
            if isinstance(value, str) and value.strip()
        ))
        clean_seeds: list[dict[str, Any]] = []
        for seed in seeds[:64]:
            if not isinstance(seed, dict):
                continue
            mode = str(seed.get("mode") or "fixed").lower()
            if mode not in {"fixed", "randomize", "increment", "decrement"}:
                mode = "fixed"
            value = seed.get("value")
            if not isinstance(value, (int, float)):
                continue
            clean_seeds.append({"value": value, "mode": mode})
        encrypted = self.cipher.encrypt(json.dumps({"models": clean_models, "seeds": clean_seeds}, separators=(",", ":")))
        changed = 0
        now = _now()
        with self._connect() as connection:
            rows = connection.execute("SELECT history_id, output_name FROM canvas_history").fetchall()
            matching_ids = [
                str(row["history_id"])
                for row in rows
                if Path(self.cipher.decrypt(str(row["output_name"]))).name == output_name
            ]
            for matching_id in matching_ids:
                changed += connection.execute(
                    "UPDATE canvas_history SET provenance = ?, updated_at = ? WHERE history_id = ?",
                    (encrypted, now, matching_id),
                ).rowcount
        return {"models": clean_models, "seeds": clean_seeds, "updated": changed}

    def delete(self, history_id: str) -> int:
        output_name = Path(self.output_name(history_id)).name
        with self._connect() as connection:
            rows = connection.execute("SELECT history_id, output_name FROM canvas_history").fetchall()
            matching_ids = [
                str(row["history_id"])
                for row in rows
                if Path(self.cipher.decrypt(str(row["output_name"]))).name == output_name
            ]
            if not matching_ids:
                return 0
            placeholders = ",".join("?" for _ in matching_ids)
            return connection.execute(
                f"DELETE FROM canvas_history WHERE history_id IN ({placeholders})",
                matching_ids,
            ).rowcount

    def _provenance(self, row: sqlite3.Row) -> dict[str, Any]:
        value = row["provenance"] if "provenance" in row.keys() else None
        if not value:
            return {}
        try:
            payload = json.loads(self.cipher.decrypt(str(value)))
        except (ValueError, TypeError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _public(row: sqlite3.Row, *, file_format: str, provenance: dict[str, Any]) -> dict[str, Any]:
        history_id = str(row["history_id"])
        models = provenance.get("models") if isinstance(provenance.get("models"), list) else []
        seeds = provenance.get("seeds") if isinstance(provenance.get("seeds"), list) else []
        return {
            "history_id": history_id,
            "source": "canvas",
            "status": row["status"],
            "media_type": row["media_type"],
            "file_format": file_format,
            "encrypted_at_rest": bool(row["encrypted_at_rest"]),
            "created_at": row["created_at"],
            **({"models": models} if models else {}),
            **({"seeds": seeds} if seeds else {}),
            **({"time_label": "Imported from Canvas"} if row["timestamp_source"] == "imported" else {}),
            "media_url": f"/api/canvas/history/{urllib.parse.quote(history_id)}/media",
        }


class CanvasGatewayClient:
    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:8787",
        token_file: str | Path | None = None,
        output_roots: list[str | Path] | None = None,
        history_file: str | Path | None = None,
    ):
        state_root = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", Path.home() / ".hivemindos/media-studio"))
        self.base_url = base_url.rstrip("/")
        self.token_file = Path(token_file or os.environ.get("ZIMG_TOKEN_FILE", state_root / "secure/zimg-token")).expanduser().resolve()
        self.history_file = Path(history_file or state_root / "state/media-gateway/history.jsonl").expanduser().resolve()
        private_root = Path(os.environ.get("COMFY_PRIVATE_ROOT", Path.home() / ".comfy-private.noindex"))
        roots = output_roots or [
            os.environ.get("COMFY_OUTPUT_DIR", private_root / "output"),
            os.environ.get("ZIMG_OUTPUT_DIR", private_root / "z_image_outputs"),
        ]
        self.output_roots = [Path(root).expanduser().resolve() for root in roots]

    def _token(self) -> str:
        try:
            token = self.token_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError("Canvas gateway token is unavailable") from exc
        if len(token) < 12:
            raise RuntimeError("Canvas gateway token is unavailable")
        return token

    def history(self) -> list[dict[str, Any]]:
        records = self.durable_history_metadata()
        try:
            request = urllib.request.Request(
                f"{self.base_url}/api/history",
                headers={"Authorization": f"Bearer {self._token()}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
            gateway_records = payload.get("history") if isinstance(payload, dict) else None
            if isinstance(gateway_records, list):
                records.extend(
                    _history_metadata(
                        record,
                        timestamp_source="filesystem" if record.get("source") == "files" else "gateway-history",
                    )
                    for record in gateway_records
                    if isinstance(record, dict)
                )
        except (OSError, RuntimeError, urllib.error.URLError, json.JSONDecodeError):
            pass
        records.extend(self.filesystem_history())
        return records

    def durable_history_metadata(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        try:
            with self.history_file.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(record, dict):
                        records.append(_history_metadata(record, timestamp_source="gateway-history"))
        except OSError:
            pass
        return records

    def filesystem_history(self) -> list[dict[str, Any]]:
        """Index output metadata without reading output file contents."""
        records: list[dict[str, Any]] = []
        seen: set[Path] = set()
        for root in self.output_roots:
            if not root.is_dir():
                continue
            try:
                candidates = root.rglob("*")
                for stored_path in candidates:
                    if not stored_path.is_file() or stored_path.name.startswith("."):
                        continue
                    logical_path = (
                        stored_path.with_name(stored_path.name.removesuffix(".zenc"))
                        if stored_path.name.endswith(".zenc")
                        else stored_path
                    )
                    if logical_path.suffix.lower() not in CANVAS_MEDIA_SUFFIXES:
                        continue
                    logical_path = logical_path.resolve()
                    if logical_path in seen:
                        continue
                    seen.add(logical_path)
                    stat = stored_path.stat()
                    timestamp = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
                    source_id = "file-" + hashlib.sha256(str(logical_path).encode("utf-8")).hexdigest()[:20]
                    records.append(
                        {
                            "id": source_id,
                            "status": "success",
                            "created_at": timestamp,
                            "finished_at": timestamp,
                            "outputs": [str(logical_path)],
                            "source": "files",
                            "timestamp_source": "filesystem",
                        }
                    )
            except OSError:
                continue
        return records

    def media(self, output_name: str) -> tuple[bytes, str]:
        logical_path = Path(output_name).expanduser().resolve()
        exact_output = any(
            logical_path == root or root in logical_path.parents
            for root in self.output_roots
        )
        route = (
            f"/output?path={urllib.parse.quote(str(logical_path), safe='')}"
            if exact_output
            else f"/image/{urllib.parse.quote(logical_path.name)}"
        )
        request = urllib.request.Request(
            f"{self.base_url}{route}",
            headers={"Authorization": f"Bearer {self._token()}", "Accept": "image/*,video/*,audio/*"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read(), response.headers.get_content_type()
        except (OSError, urllib.error.URLError) as exc:
            raise RuntimeError("Canvas media is unavailable") from exc

    def workflow(self, output_name: str) -> dict[str, Any]:
        name = Path(output_name).name
        request = urllib.request.Request(
            f"{self.base_url}/workflow-for-output?filename={urllib.parse.quote(name)}",
            headers={"Authorization": f"Bearer {self._token()}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError("Exact Canvas workflow is unavailable for this output") from exc
        workflow = payload.get("workflow") if isinstance(payload, dict) else None
        if not isinstance(workflow, dict):
            raise RuntimeError("Exact Canvas workflow is unavailable for this output")
        return workflow

    def delete(self, output_name: str) -> dict[str, Any]:
        name = Path(output_name).name
        request = urllib.request.Request(
            f"{self.base_url}/api/delete-output",
            data=json.dumps({"filename": name, "confirm": True}).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token()}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            raise RuntimeError("Canvas output could not be completely deleted") from exc
        if not isinstance(payload, dict) or not payload.get("ok"):
            raise RuntimeError("Canvas output could not be completely deleted")
        return payload


CanvasHistoryFetcher = Callable[[], list[dict[str, Any]]]
CanvasMediaFetcher = Callable[[str], tuple[bytes, str]]
CanvasWorkflowFetcher = Callable[[str], dict[str, Any]]
CanvasDeleteFetcher = Callable[[str], dict[str, Any]]
