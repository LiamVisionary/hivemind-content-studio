"""Decrypted inputs that never become a file.

ComfyUI's `LoadImage` reads from the input directory, so every reference the
owner sends has been written there as a plaintext PNG and left for a sweeper to
expire. That is the window another process on this machine used: it listed the
input directory, found the owner's upscale source, and copied it.

The bytes live here instead — in this process, under a 256-bit handle, for as
long as a job could still need them. The graph carries the handle in place of a
filename and `HivemindLoadPrivateImage` (packages/comfyui-custom-nodes/
hivemind-private-media) fetches it back over loopback with the gateway's own
token. Nothing lands in the input directory, so there is nothing to list, copy,
or forget to delete.

What this is not: protection from a debugger. The bytes are in RAM in this
process, and a process running as this user can read another's memory on a Mac
where DevToolsSecurity allows it. The claim is narrower and it is the one that
failed: the owner's media is no longer a file sitting in a directory anyone can
open with `cp`.
"""

from __future__ import annotations

import os
import secrets
import threading
import time

# A handle outlives staging by long enough for a queued graph to reach the
# loader on a busy lane, and no longer. A job still waiting after this fails
# loudly on a missing handle rather than quietly reading someone else's bytes.
HANDLE_TTL_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_TTL", "3600"))
# Bounded so a run of staged references can never grow into the machine's
# memory. Oldest goes first; the cap is far above any real graph's fan-in.
MAX_STAGED = int(os.environ.get("ZIMG_PRIVATE_INPUT_MAX", "64"))

_staged: "dict[str, dict]" = {}
_lock = threading.Lock()


def _expire_locked(now: float) -> None:
    for handle in [h for h, entry in _staged.items() if entry["expires"] <= now]:
        _staged.pop(handle, None)


def stage(payload: bytes, media_type: str = "image/png", *, ttl_seconds: int | None = None) -> str:
    """Hold these bytes in memory and return the handle that fetches them."""
    if not isinstance(payload, (bytes, bytearray)) or not payload:
        raise ValueError("private input payload is empty")
    now = time.time()
    handle = secrets.token_hex(32)
    entry = {
        "payload": bytes(payload),
        "media_type": str(media_type or "application/octet-stream"),
        "expires": now + (HANDLE_TTL_SECONDS if ttl_seconds is None else int(ttl_seconds)),
    }
    with _lock:
        _expire_locked(now)
        while len(_staged) >= MAX_STAGED:
            _staged.pop(next(iter(_staged)), None)
        _staged[handle] = entry
    return handle


def fetch(handle: str) -> "tuple[bytes, str] | None":
    """The bytes for a handle, or None once it has expired or never existed.

    Deliberately readable more than once: ComfyUI may re-execute a node when a
    prompt is re-queued or a cached branch is invalidated, and a single-use
    handle would turn that into a failed generation.
    """
    key = str(handle or "").strip()
    if not key:
        return None
    now = time.time()
    with _lock:
        _expire_locked(now)
        entry = _staged.get(key)
        if entry is None:
            return None
        return entry["payload"], entry["media_type"]


def release(handle: str) -> bool:
    """Drop a handle the moment its job is done with it."""
    key = str(handle or "").strip()
    if not key:
        return False
    with _lock:
        return _staged.pop(key, None) is not None


def staged_count() -> int:
    with _lock:
        _expire_locked(time.time())
        return len(_staged)
