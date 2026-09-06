"""Automatic, privacy-safe telemetry for studio-initiated generations.

``generation_telemetry`` records the attempts a *content run* makes, keyed to
the run's own event log. A generation started from the studio's own video
tab has no run to hang an event on, so until now it left no record at all:
a refused start was one hidden stderr line inside the gateway's supervisor
log (and only while machine-private redaction was on), and the toast said
"the backend redacted the reason". This ledger closes that gap.

What is written, automatically, for every studio generation:

* the attempt's id, kind, provider, registered workflow id, the "Run on"
  pin, and the terminal status with its duration;
* on failure, a *machine-safe classification*: a code (``missing_node_type``,
  ``out_of_memory``, ``lane_unreachable`` …) and, where the backend named
  one, the ComfyUI node class that refused the graph. Node classes are code
  identifiers of installed packages; they say what the machine lacks and
  nothing about the work.

What is never written: prompts, negative prompts, reference or output
names, staged paths, free-text error messages, tokens. Every string field is
either an allow-listed identifier or a short type name, so the file can be
read by anyone who can read the rest of the studio's local state, and its
rows can be shown in the Activity page and to a control-token caller.

The hint sentences live here (``failure_hint``) rather than in the ledger so
the file stays free of prose and the wording can change without a migration.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

LEDGER_FILENAME = "studio-generations.jsonl"
# The ledger is append-only; past this many rows it is folded down to the
# newest KEEP_RECORDS so a busy studio never grows an unbounded file.
MAX_RECORDS = 4000
KEEP_RECORDS = 2000

_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_.:+/-]{1,120}$")
_STATUSES = {"started", "completed", "failed", "cancelled"}
# Codes for which a hint is written; anything else is shown as its code.
# lora_base is the model family the attempt's LoRAs were made for (the
# workflow's own family — a LoRA rides on the model that renders it), and
# lora_count how many. A LoRA's name or description is never a column: a
# name is a download the owner chose, and that is theirs.
_IDENTIFIER_FIELDS = ("workflow_id", "run_on", "failure_code", "failure_node_class", "failure_node_id", "lora_base")
_TEXT_FIELDS = ("telemetry_id", "status", "stage", "kind", "surface", "provider", "model", "error_type")
# artifact_bytes is the size of what came back and nothing more: it tells an
# empty or missing output from a real clip without the studio ever writing the
# clip's name or bytes here.
_INT_FIELDS = ("duration_ms", "artifact_count", "artifact_bytes", "lora_count")
_BOOL_FIELDS = ("machine_private",)


_LORA_BASE_PREFIXES = (
    ("minimax", "minimax-h3"),
    ("ltx23", "ltx-2.3"),
    ("ltx2", "ltx-2"),
    ("ltx", "ltx"),
    ("krea2", "krea2"),
    ("krea", "krea2"),
    ("zimage", "zimage"),
    ("z-image", "zimage"),
    ("anima", "anima"),
    ("klein", "flux2-klein"),
    ("flux2", "flux2"),
    ("flux", "flux"),
    ("seedvr", "seedvr2"),
    ("wan", "wan"),
)


def lora_base_for_workflow(workflow_id: object) -> str:
    """The model family a workflow's LoRAs target, read from the workflow id
    alone (a LoRA is applied to the model that renders the job). Nothing about
    the LoRA itself is consulted, so nothing about it can leak."""
    text = _identifier(workflow_id).lower()
    if not text:
        return ""
    for prefix, base in _LORA_BASE_PREFIXES:
        if text.startswith(prefix):
            return base
    return text.split("-", 1)[0]


def new_telemetry_id() -> str:
    return f"gen_{uuid.uuid4().hex[:16]}"


def _identifier(value: object) -> str:
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (int, float)):
        value = str(int(value))
    text = str(value).strip()
    return text if _IDENTIFIER_RE.match(text) else ""


def safe_failure(value: object) -> dict[str, Any] | None:
    """The allow-listed shape of a backend failure classification.

    Accepts what the MCP puts under ``failure`` in a receipt (or what a caller
    built by hand) and keeps only identifiers: a code, a node class, a node
    id, up to five node classes. A message, a value, a path — dropped."""
    if not isinstance(value, dict):
        return None
    code = _identifier(value.get("code")).lower()
    if not code:
        return None
    failure: dict[str, Any] = {"code": code}
    node_class = _identifier(value.get("node_class"))
    if node_class:
        failure["node_class"] = node_class
    node_id = _identifier(value.get("node_id"))
    if node_id:
        failure["node_id"] = node_id
    classes = value.get("node_classes")
    if isinstance(classes, (list, tuple)):
        kept = []
        for item in classes:
            name = _identifier(item)
            if name and name not in kept:
                kept.append(name)
            if len(kept) >= 5:
                break
        if kept:
            failure["node_classes"] = kept
    return failure


def failure_hint(failure: dict[str, Any] | None) -> str:
    """One sentence the owner can act on, made only of the code and the node
    identifiers. Worded the same as the MCP's own machine-safe message so a
    toast and the Activity page agree."""
    if not failure:
        return ""
    code = str(failure.get("code") or "")
    nodes = str(failure.get("node_class") or "") or ", ".join(failure.get("node_classes") or [])
    if code == "missing_node_type":
        return (
            f"The ComfyUI lane that took this job does not have the custom node {nodes or '(unnamed)'} installed, "
            "so the graph was refused before rendering. Install that node pack on the lane, or run the job on a "
            "machine that has it (the Rented source's \"Run on\" pin), and try again."
        )
    if code in {"prompt_outputs_failed_validation", "invalid_prompt", "prompt_no_outputs"}:
        where = f" ({nodes})" if nodes else ""
        return (
            f"ComfyUI refused the graph before rendering{where}: usually a model file this lane does not have. "
            "Check the lane's models for this workflow and try again."
        )
    if code == "out_of_memory":
        return "The lane ran out of memory mid-render. Lower the resolution or the clip length, or run it on a bigger card."
    if code == "lane_unreachable":
        return "The machine behind this lane stopped answering. Re-attach it (or pick another) and try again."
    if code == "timeout":
        return "The backend did not answer in time. Try again; a render behind another job queues rather than fails."
    if code == "unauthorized":
        return "The gateway refused the studio's token. Restart the stack so the token is read again."
    if code == "operational":
        return "The backend refused for a machine reason (a lane, a tunnel or a rental); the studio log names it."
    if code == "invalid_request":
        return "The request could not be built as sent (a missing input or an impossible combination)."
    if code == "cancelled":
        return ""
    return ""


def classify_exception(exc: BaseException, *, default: str = "render_failed") -> dict[str, Any]:
    """A machine-safe classification for a failure that arrived as an
    exception: the backend's own (carried on the exception by
    ``MediaStudioStartError``) when it gave one, otherwise a code read from the
    *shape* of the message — never the message itself."""
    carried = safe_failure(getattr(exc, "failure", None))
    if carried:
        return carried
    text = str(exc or "")
    lowered = text.lower()
    # Lazy: media_studio imports this module for the start-failure shape.
    from .media_studio import _lane_unreachable_advice, _out_of_memory_advice

    if _out_of_memory_advice(text):
        return {"code": "out_of_memory"}
    if _lane_unreachable_advice(text):
        return {"code": "lane_unreachable"}
    if isinstance(exc, TimeoutError) or "timed out" in lowered:
        return {"code": "timeout"}
    if "cancel" in lowered:
        return {"code": "cancelled"}
    return {"code": _identifier(default).lower() or "render_failed"}


def failure_fields(failure: dict[str, Any] | None) -> dict[str, Any]:
    """The ledger columns a classification becomes."""
    safe = safe_failure(failure)
    if not safe:
        return {}
    fields: dict[str, Any] = {"failure_code": safe["code"]}
    node_class = safe.get("node_class") or (safe.get("node_classes") or [""])[0]
    if node_class:
        fields["failure_node_class"] = node_class
    if safe.get("node_id"):
        fields["failure_node_id"] = safe["node_id"]
    return fields


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def sanitize_record(fields: dict[str, Any]) -> dict[str, Any]:
    """Only the allow-listed columns, each in its allow-listed shape."""
    record: dict[str, Any] = {}
    for key in _TEXT_FIELDS:
        value = fields.get(key)
        if value is None or value == "":
            continue
        text = " ".join(str(value).split())[:240]
        if key == "status" and text not in _STATUSES:
            continue
        record[key] = text
    for key in _IDENTIFIER_FIELDS:
        value = _identifier(fields.get(key))
        if value:
            record[key] = value
    for key in _INT_FIELDS:
        value = fields.get(key)
        if value is None:
            continue
        try:
            record[key] = max(0, int(float(value)))
        except (TypeError, ValueError):
            continue
    for key in _BOOL_FIELDS:
        if fields.get(key) is not None:
            record[key] = bool(fields[key])
    return record


class StudioGenerationLedger:
    """Append-only JSONL of studio generation attempts, one row per status
    change, folded by ``telemetry_id`` when read. Owner-local metadata only."""

    def __init__(self, path: Path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._count = self._count_rows()

    @property
    def path(self) -> Path:
        return self._path

    @classmethod
    def beside(cls, store_path: Path | str) -> "StudioGenerationLedger":
        """The ledger that belongs to a run store: same directory, so the
        snapshot, the CLI and the MCP resource all find it from the store."""
        return cls(Path(store_path).expanduser().parent / LEDGER_FILENAME)

    def _count_rows(self) -> int:
        try:
            with self._path.open("r", encoding="utf-8") as handle:
                return sum(1 for line in handle if line.strip())
        except OSError:
            return 0

    def record(self, **fields: Any) -> dict[str, Any]:
        """Write one row. Never raises: a generation must not fail because its
        telemetry could not be written."""
        record = sanitize_record(fields)
        if not record.get("telemetry_id") or not record.get("status"):
            return {}
        record = {"at": _now_iso(), **record}
        line = json.dumps(record, sort_keys=True)
        try:
            with self._lock:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
                self._count += 1
                if self._count > MAX_RECORDS:
                    self._compact_locked()
        except OSError:
            return record
        return record

    def _compact_locked(self) -> None:
        rows = self._read_rows()[-KEEP_RECORDS:]
        tmp = self._path.with_suffix(".jsonl.tmp")
        tmp.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows), encoding="utf-8")
        tmp.replace(self._path)
        self._count = len(rows)

    def _read_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        try:
            with self._path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(row, dict) and row.get("telemetry_id"):
                        rows.append(row)
        except OSError:
            return []
        return rows

    def rows(self, limit: int = 10_000) -> list[dict[str, Any]]:
        """Raw rows, oldest first, re-sanitized on the way out so a hand-edited
        file cannot smuggle a column in."""
        with self._lock:
            rows = self._read_rows()
        rows = rows[-max(1, int(limit)):]
        return [{"at": str(row.get("at") or ""), **sanitize_record(row)} for row in rows]
