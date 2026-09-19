"""Where the studio writes what happened, and what it says when it doesn't.

Three things live here because they are one job — making a failure
recoverable for the person in front of the app:

* **One log file.** Until now no module in the package imported ``logging``
  at all, so the only record of a crash was uvicorn's stderr, which the
  supervisor redirected into a hidden directory and truncated on every
  restart — and the supervisor restarts the stack automatically after a
  crash. The first thing that happens after a failure erased the evidence
  of it. The app now owns its own rotating file, in a place a person can
  reach (``~/Library/Logs/Hivemind Content Studio`` on macOS, which
  Console.app lists), and nothing truncates it.

* **Incident ids.** A 500 answers with a short id that also appears in the
  log, so "it broke" becomes a thing support can look up.

* **One remedy table.** The sentences a person is shown when something is
  missing, with the developer's version of the same sentence kept behind
  ``CONTENT_STUDIO_DEV=1``. "Run npm --prefix … vite:build" is a correct
  instruction for the person who built the app and a dead end for the
  person who installed it.

Privacy (AGENTS.md): every line written here goes through the same
reduction the toasts use — absolute private paths to basenames, tokens
redacted — because an exception message can carry a path or a prompt, and
a log file is read by more people than a toast is. Tracebacks are written
as a frame list built from basenames rather than by ``logging.exception``,
whose formatted text would carry the raw message and the real paths.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import secrets
import sys
import traceback
import zipfile
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

from .media_studio import _PRIVATE_PATH_RE, _private_path_basename, sanitize_error_detail

LOG_FILENAME = "control-api.log"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5
# What the bundle carries of the log. Enough to hold the incident the owner is
# reporting, small enough to attach to a message.
BUNDLE_LOG_MAX_BYTES = 512 * 1024

log = logging.getLogger("hivemind.studio")
access_log = logging.getLogger("hivemind.studio.access")

_configured = False


def dev_mode() -> bool:
    """Is this the machine the studio is BUILT on, rather than run on?"""
    return os.environ.get("CONTENT_STUDIO_DEV", "").strip().lower() in {"1", "true", "yes", "on"}


def log_dir() -> Path:
    """Where the studio writes. Explicit setting first, then the media state
    root the rest of the stack already shares, then the platform's own log
    folder — on macOS the one Console.app shows and Tauri's log plugin uses."""
    configured = os.environ.get("CONTENT_STUDIO_LOG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    state_root = os.environ.get("HIVEMIND_MEDIA_STATE_DIR", "").strip()
    if state_root:
        return Path(state_root).expanduser() / "logs"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Logs" / "Hivemind Content Studio"
    return Path.home() / ".hivemind-content-studio" / "logs"


def log_path() -> Path:
    return log_dir() / LOG_FILENAME


def configure_logging(*, force: bool = False) -> Path | None:
    """Called once from ``main()``. Returns the file it opened, or None when
    the directory could not be created — a studio that cannot write a log is
    still a studio, so this never raises."""
    global _configured
    if _configured and not force:
        return log_path()
    level = os.environ.get("CONTENT_STUDIO_LOG_LEVEL", "").strip().upper() or "INFO"
    root = logging.getLogger()
    root.setLevel(getattr(logging, level, logging.INFO))
    target = log_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            target, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
        )
    except OSError:
        _configured = True
        return None
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    ))
    for existing in list(root.handlers):
        if isinstance(existing, RotatingFileHandler) and getattr(existing, "baseFilename", "") == str(target):
            root.removeHandler(existing)
            existing.close()
    root.addHandler(handler)
    # The handler is on the ROOT logger so a third-party warning is captured
    # too — but httpx and urllib3 write the FULL request URL at INFO, query
    # string included, and that is exactly what the access line above exists
    # to avoid writing. They speak here only when something is wrong.
    for chatty in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(chatty).setLevel(logging.WARNING)
    _configured = True
    return target


# ── what a log line may say ───────────────────────────────────────────────

# Same shape as the media gateway's redact_access_log_message: a token that
# reached a URL is redacted rather than written. Access lines here never carry
# a query string at all; this is the second lock on that door.
_QUERY_TOKEN_RE = re.compile(r"(?i)([?&](?:token|access_token|api_key|key)=)[^&\s\"]*")

# A path segment that names a file. Media routes carry the owner's filenames,
# and a filename is content.
_FILENAME_SEGMENT_RE = re.compile(r"^[^/{}]*\.[A-Za-z0-9]{1,8}$")


def reduce_private_paths(text: str) -> str:
    """Absolute paths under a home, a volume or a temp root reduced to their
    basename — the same reduction ``sanitize_error_detail`` applies to a
    toast, applied to a whole file for the diagnostics bundle."""
    return _PRIVATE_PATH_RE.sub(_private_path_basename, str(text or ""))


def access_route(path: str, path_params: dict[str, Any] | None = None) -> str:
    """A request's route TEMPLATE — "/api/media-studio/generated/{filename}",
    never the filename, and never a query string (the caller passes
    ``url.path``, which has none). Path params are substituted back out by
    value; anything still shaped like a file — an unmatched route, a static
    asset — is reduced too, because a 404 for a media path is still a media
    path."""
    template = str(path or "/")
    for name, value in (path_params or {}).items():
        text = str(value)
        if text and text in template:
            template = template.replace(text, "{" + name + "}")
    template = "/".join(
        "…" if _FILENAME_SEGMENT_RE.match(part) else part for part in template.split("/")
    )
    return _QUERY_TOKEN_RE.sub(lambda match: match.group(1) + "%5Bredacted%5D", template)


def record_access(method: str, path: str, status: int, path_params: dict[str, Any] | None = None) -> str:
    line = f"{str(method or '').upper()} {access_route(path, path_params)} {int(status)}"
    access_log.info(line)
    return line


# ── incidents ─────────────────────────────────────────────────────────────

def new_incident() -> str:
    """Short enough to read down a phone, long enough not to collide inside
    one log file."""
    return secrets.token_hex(3)


def frame_list(exc: BaseException, limit: int = 12) -> str:
    """The traceback as "file:line in func" — basenames only, no source lines
    and no locals. Enough to point at the code; nothing of the person."""
    frames = traceback.extract_tb(exc.__traceback__)[-limit:]
    return " <- ".join(f"{Path(frame.filename).name}:{frame.lineno} {frame.name}" for frame in frames)


def record_incident(exc: BaseException, *, method: str = "", route: str = "") -> str:
    """Mint an id, write the failure under it, hand the id back for the reply.

    Deliberately NOT ``logging.exception``: its formatted traceback carries
    the raw exception message (which the 500 handler's own comment says can
    be a path or a prompt) and the absolute path of every frame.
    """
    incident = new_incident()
    where = f"{method} {route}".strip()
    message = sanitize_error_detail(str(exc)) or type(exc).__name__
    log.error(
        "incident=%s %s %s: %s | %s",
        incident,
        where or "-",
        type(exc).__name__,
        message,
        frame_list(exc),
    )
    return incident


# ── the sentences a person is shown ───────────────────────────────────────

# (consumer, developer). The developer half is shown only under
# CONTENT_STUDIO_DEV=1; it is the sentence that names a command, a package or
# an environment variable, and none of those are an answer for someone who
# installed the app rather than built it.
_REMEDIES: dict[str, tuple[str, str]] = {
    "dist-missing": (
        "This copy of the studio is incomplete. Reinstall the app.",
        "The frontend build is missing. Run npm --prefix packages/open-generative-ai run vite:build.",
    ),
    "unexpected": (
        "Something went wrong. Copy the details and send them with your report.",
        "Something went wrong. The traceback is under the incident id in the studio log directory.",
    ),
    "passbook-seal": (
        "This build cannot encrypt the shared credential store.",
        "Sealing needs the cryptography package, or HIVE_ENV_KEY set on this machine.",
    ),
    "passbook-write": (
        "The studio cannot reach the shared credential store.",
        "A sandboxed home has no shared store: ship unsandboxed, or launch with HIVE_HOME set.",
    ),
}


def remedy_text(key: str) -> str:
    consumer, developer = _REMEDIES.get(key, ("Something went wrong.", ""))
    return developer if developer and dev_mode() else consumer


# ── the diagnostics bundle ────────────────────────────────────────────────

def _sanitized_json(value: Any) -> str:
    try:
        rendered = json.dumps(value, indent=2, sort_keys=True, default=str)
    except (TypeError, ValueError):
        rendered = json.dumps({"error": "not serialisable"})
    return reduce_private_paths(rendered)


def _sanitized_log_tail(path: Path, limit: int = BUNDLE_LOG_MAX_BYTES) -> str:
    try:
        raw = path.read_bytes()
    except OSError:
        return "(no log file yet)\n"
    if len(raw) > limit:
        raw = raw[-limit:]
    text = raw.decode("utf-8", errors="replace")
    return reduce_private_paths(text)


def diagnostics_bundle(runtime: Any, health: Any, *, path: Path | None = None) -> bytes:
    """One zip the owner attaches to a report by hand.

    Nothing is sent anywhere: this is a local-first, owner-run app, and a
    "send report" button would be data leaving the machine without being
    asked for. Everything in it is reduced first — the log by the same path
    rule the toasts use, the snapshots by rendering them and reducing the
    rendered text — so the bundle names files, not people.
    """
    target = path or log_path()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(LOG_FILENAME, _sanitized_log_tail(target))
        archive.writestr("runtime.json", _sanitized_json(runtime))
        archive.writestr("healthz.json", _sanitized_json(health))
    return buffer.getvalue()
