"""Which local ComfyUI lane is sitting on the machine's memory, and the one call
that hands it back.

A lane being UP costs almost nothing: measured 2026-08-14 on this Mac, an idle
ComfyUI lane holds ~0.9 GB RSS with no models loaded. What costs is a lane still
holding the weights from a job that finished — tens of GB of unified memory that
the next native Klein 9B edit needs before the media gateway will even admit it
(``_klein_memory_limits`` waits for ~48 GB available and can time out with
"timed out waiting for safe unified-memory headroom"). That is the state worth
telling the user about: an image edit queued behind a video model nobody is
using any more.

ComfyUI's own ``/free`` drops the models without touching the queue, the loaded
workflow, or cached node results, so the lane stays up and reloads on next use.
That is why this module offers "free" and never "quit" — quitting a lane would
buy the ~0.9 GB of idle overhead and cost a stack restart to get video back.

The same endpoint already backs the prompt helper's "free ComfyUI" action
(``local_llm.free_comfy_memory``); this generalises it from the default lane to
whichever lane is actually holding something.

Which lane that is, in practice: measured 2026-08-14, the default lane released
16 GB back to 1.2 GB within ~18s of a Z-Image job finishing, entirely on its own.
The LTX lane is the one launched ``--gpu-only`` (see scripts/hivemind-studio-stack,
and the LTX-priority comment about it keeping "a very large MPS working set"), so
it is the lane expected to still be holding after its job — which is why the
panel keys off measured residency per lane rather than naming a lane up front.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

from . import local_llm
from .settings import settings

# Idle lanes measured at ~0.9 GB. A lane with any real model resident is several
# GB up, so this separates "running" from "holding" without a per-model table.
LANE_HOLDING_THRESHOLD_BYTES = 3 * 1024**3

# What the media gateway insists on before it will start a native Klein 9B edit
# (headroom + per-job reservation in packages/media-gateway/app.py). Reported so
# the panel can say why a lane's memory matters instead of just how big it is.
KLEIN_ADMISSION_BYTES = 48 * 1024**3

LANE_LABELS = {
    "default": "Image lane",
    "anima": "Anima lane",
    "ltx": "LTX video lane",
}


class LaneError(RuntimeError):
    """A lane could not be reached or is not one this machine runs."""


def parse_lane_env(raw: str | None, *, default_url: str | None = None) -> dict[str, str]:
    """Parse COMFY_LANES ("default=http://…,ltx=http://…").

    Deliberately the same shape the media gateway parses, so the two services
    read one env var rather than drifting apart.
    """
    lanes: dict[str, str] = {}
    if default_url:
        lanes["default"] = default_url.rstrip("/")
    for part in (raw or "").split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, url = part.split("=", 1)
        name = re.sub(r"[^a-z0-9_-]", "", name.strip().lower())
        url = url.strip().rstrip("/")
        if name and url:
            lanes[name] = url
    return lanes


def configured_lanes() -> dict[str, str]:
    # The default lane's address is a setting (network.comfy_url), which reads
    # COMFY_HTTP_DEFAULT/COMFY_HTTP first — so a machine that already exports
    # one is unchanged, and a person with ComfyUI on another port can now say so
    # in the app instead of in a shell profile.
    return parse_lane_env(os.environ.get("COMFY_LANES"), default_url=settings().network.comfy_url)


def _port_of(url: str) -> int | None:
    try:
        return urlparse(url).port
    except ValueError:
        return None


def _is_local(url: str) -> bool:
    """Only this machine's own lanes have a process to weigh — a rental lane is
    someone else's RAM and its memory is not ours to reclaim."""
    host = (urlparse(url).hostname or "").lower()
    return host in {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


def _rss_bytes_for_port(port: int) -> int | None:
    """Resident size of whatever listens on `port`, or None if nothing does.

    psutil is not a dependency here, and the listener is not our child, so this
    goes through lsof/ps the way the rest of the stack's process probes do.
    """
    try:
        listeners = subprocess.run(
            ["lsof", "-ti", f":{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    pids = [line.strip() for line in listeners.stdout.splitlines() if line.strip()]
    if not pids:
        return None
    try:
        sizes = subprocess.run(
            ["ps", "-o", "rss=", "-p", pids[0]],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    raw = sizes.stdout.strip().splitlines()
    if not raw:
        return None
    try:
        return int(raw[0].strip()) * 1024  # ps reports KiB
    except ValueError:
        return None


def _is_busy(url: str, timeout: float = 3.0) -> bool | None:
    """Whether the lane has work in flight. None when it cannot be asked.

    Load-bearing, not decoration: a lane's memory crosses the "holding" line
    DURING a generation too (measured: 16 GB mid-job), and unloading models out
    from under a running prompt is not a speed-up, it is a broken job.
    """
    try:
        with urllib.request.urlopen(f"{url}/queue", timeout=timeout) as response:
            queue = json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, TimeoutError, ValueError):
        return None
    return bool(queue.get("queue_running")) or bool(queue.get("queue_pending"))


def lane_state(lane_id: str, url: str) -> dict[str, Any]:
    port = _port_of(url)
    local = _is_local(url)
    rss = _rss_bytes_for_port(port) if (local and port) else None
    running = rss is not None
    busy = _is_busy(url) if running else None
    # "Holding" is the actionable state; "running" on its own is not worth a
    # word in the UI, which is the whole point of the threshold.
    holding = bool(running and rss >= LANE_HOLDING_THRESHOLD_BYTES)
    return {
        "id": lane_id,
        "label": LANE_LABELS.get(lane_id, f"{lane_id.title()} lane"),
        "url": url,
        "port": port,
        "local": local,
        "running": running,
        "rssBytes": rss,
        "holding": holding,
        "busy": busy,
        # The only state that earns a button: memory worth reclaiming, and
        # nothing running that would be destroyed by reclaiming it. An unknown
        # queue counts as busy — refusing a free is recoverable, interrupting
        # someone's video is not.
        "reclaimable": bool(holding and busy is False),
    }


def snapshot() -> dict[str, Any]:
    lanes = [lane_state(lane_id, url) for lane_id, url in sorted(configured_lanes().items())]
    return {
        "lanes": lanes,
        "availableBytes": local_llm._available_memory_bytes(),
        "holdingThresholdBytes": LANE_HOLDING_THRESHOLD_BYTES,
        "kleinAdmissionBytes": KLEIN_ADMISSION_BYTES,
    }


def free_lane(lane_id: str, timeout: float = 20.0) -> dict[str, Any]:
    """Drop one lane's models. Returns what it actually freed."""
    lanes = configured_lanes()
    url = lanes.get(lane_id)
    if not url:
        raise LaneError(f"unknown lane: {lane_id}")
    if not _is_local(url):
        raise LaneError(f"lane {lane_id} is remote; its memory is not ours to free")
    # Server-side guard, because a UI-only check is a race: the lane can pick up
    # a job between the panel's poll and the click.
    if _is_busy(url) is not False:
        raise LaneError(
            f"the {LANE_LABELS.get(lane_id, lane_id)} is working (or did not answer); "
            "freeing it now would break the running job"
        )
    before = local_llm._available_memory_bytes()
    request = urllib.request.Request(
        f"{url}/free",
        data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise LaneError(f"Could not reach the {LANE_LABELS.get(lane_id, lane_id)} at {url}: {exc}") from None
    # Comfy frees asynchronously; the same 1.5s wait the prompt helper uses is
    # what makes the reported number the one the user will see.
    time.sleep(1.5)
    after = local_llm._available_memory_bytes()
    return {
        "lane": lane_id,
        "freedBytes": max(0, after - before),
        **snapshot(),
    }
