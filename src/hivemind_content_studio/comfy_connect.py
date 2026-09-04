"""ComfyUI is optional: find it, attach it by URL, or say where to get it.

The stack used to refuse to boot until an external ComfyUI checkout answered on
:8188, which meant a machine without one never saw the studio at all. The
control API and the gateway now come up on their own and a lane is an *engine
you attach*, exactly like a rented machine — so this module is the attach half.

Three rules it exists to keep:

* **It never modifies a checkout the app did not create.** Everything here is
  ``stat()`` and one HTTP GET. No symlinking custom nodes into somebody's
  ComfyUI Desktop install, no writes of any kind inside a detected directory.
  Custom nodes a workflow needs are *named* to the user; installing them is
  their call, in their own ComfyUI.
* **There is no installer.** v1 detects, attaches, or links to ComfyUI's own
  instructions. A guided install would have to pick a Python, a torch build and
  a node set on a machine we have not measured.
* **The lane map is never emptied.** ~30 read sites in the media gateway assume
  a ``default`` lane exists; attaching rewrites its URL and detaching restores
  the configured one. "No ComfyUI" is a lane that does not answer, not a
  missing lane.

The attachment registry is a sibling of ``rental-lanes.json`` in the media
state root and is read live by the gateway's ``refresh_comfy_lanes()``, so
attaching a URL lights the lane without restarting anything.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from . import comfy_lanes
from .config import media_state_root

#: Where ComfyUI's own install instructions live. Linked, never scraped.
COMFY_INSTALL_URL = "https://docs.comfy.org/installation/comfyui_desktop/macos"
COMFY_SOURCE_URL = "https://github.com/comfyanonymous/ComfyUI"

#: Ports worth knocking on when nothing is configured: 8188 is ComfyUI's own
#: default and what every lane in this repo assumes; 8000 is what the ComfyUI
#: Desktop application serves on.
CANDIDATE_PORTS = (8188, 8000)

ATTACHABLE_LANES = ("default", "anima", "ltx")


class ConnectError(RuntimeError):
    """A URL could not be attached, with a sentence saying what to do."""


def attachments_path() -> Path:
    return media_state_root() / "comfy-attachments.json"


def _candidate_dirs() -> list[tuple[str, Path]]:
    """(source, path) pairs to stat, in the order a user would expect.

    Env first because an owner who set ``COMFY_DIR`` has already answered the
    question; then the checkout path this repo's stack has always defaulted to;
    then the two places ComfyUI Desktop puts things on macOS.
    """
    seen: set[Path] = set()
    pairs: list[tuple[str, Path]] = []

    def add(source: str, raw: str | Path | None) -> None:
        if not raw:
            return
        path = Path(raw).expanduser()
        if path in seen:
            return
        seen.add(path)
        pairs.append((source, path))

    add("COMFY_DIR", os.environ.get("COMFY_DIR"))
    add("COMFY", os.environ.get("COMFY"))
    home = Path.home()
    add("checkout", home / "comfy" / "ComfyUI")
    add("checkout", home / "ComfyUI")
    add("desktop", home / "Documents" / "ComfyUI")
    add("desktop", home / "Library" / "Application Support" / "ComfyUI")
    add("desktop-app", Path("/Applications/ComfyUI.app"))
    return pairs


def _describe_dir(source: str, path: Path) -> dict[str, Any] | None:
    """What this path is, read-only. None when there is nothing there."""
    if source == "desktop-app":
        if not path.is_dir():
            return None
        return {
            "kind": "desktop-app",
            "path": str(path),
            "label": "ComfyUI Desktop",
            "detail": "The ComfyUI Desktop application is installed. Start it, then attach the URL it serves.",
        }
    if (path / "main.py").is_file():
        return {
            "kind": "checkout",
            "path": str(path),
            "label": path.name,
            "detail": f"A ComfyUI checkout is on disk at {path}. Start it yourself, then attach its URL here.",
        }
    # ComfyUI Desktop keeps the runtime one level down in some layouts.
    nested = path / "ComfyUI"
    if (nested / "main.py").is_file():
        return {
            "kind": "checkout",
            "path": str(nested),
            "label": nested.name,
            "detail": f"A ComfyUI install is on disk at {nested}. Start it yourself, then attach its URL here.",
        }
    return None


def detect_installs() -> list[dict[str, Any]]:
    """Every ComfyUI this machine appears to have, without touching any of them.

    Detection is deliberately toothless: it reports what it saw and the user
    decides. Starting somebody's ComfyUI for them, or writing into it, is the
    behaviour this whole item exists to remove.
    """
    found: list[dict[str, Any]] = []
    for source, path in _candidate_dirs():
        try:
            described = _describe_dir(source, path)
        except OSError:
            described = None
        if described:
            described["source"] = source
            found.append(described)
    return found


def normalize_url(raw: str) -> str:
    """A lane URL from whatever the user pasted, or a refusal that says why."""
    value = (raw or "").strip().rstrip("/")
    if not value:
        raise ConnectError("Paste the address ComfyUI is serving on, for example http://127.0.0.1:8188")
    if "://" not in value:
        value = f"http://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise ConnectError(
            f"'{raw}' is not an http address. ComfyUI serves over http — try http://127.0.0.1:8188"
        )
    if not parsed.hostname:
        raise ConnectError(
            f"'{raw}' has no host in it. Use the address from ComfyUI's own window, e.g. http://127.0.0.1:8188"
        )
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))


def probe_url(url: str, timeout: float = 3.0) -> dict[str, Any]:
    """One /system_stats knock. Never raises; the detail is the fix's evidence."""
    target = f"{url.rstrip('/')}/system_stats"
    try:
        with urllib.request.urlopen(target, timeout=timeout) as response:
            if response.status >= 400:
                return {"reachable": False, "detail": f"it answered HTTP {response.status}"}
            try:
                stats = json.loads(response.read().decode("utf-8") or "{}")
            except ValueError:
                stats = {}
    except urllib.error.HTTPError as exc:
        return {"reachable": False, "detail": f"it answered HTTP {exc.code}"}
    except (OSError, urllib.error.URLError, TimeoutError, ValueError):
        return {"reachable": False, "detail": "nothing answered there"}
    system = stats.get("system") if isinstance(stats, dict) else None
    version = str((system or {}).get("comfyui_version") or "").strip()
    return {"reachable": True, "detail": "ComfyUI answered", "version": version or None}


def discover_running(timeout: float = 1.0) -> list[dict[str, Any]]:
    """Loopback ports that answer /system_stats right now.

    This is the half of auto-detect that matters: a checkout on disk is only a
    hint, but a port that answers can be attached with one press.
    """
    running: list[dict[str, Any]] = []
    for port in CANDIDATE_PORTS:
        url = f"http://127.0.0.1:{port}"
        probe = probe_url(url, timeout=timeout)
        if probe["reachable"]:
            running.append({"url": url, "version": probe.get("version")})
    return running


def read_attachments() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(attachments_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    clean: dict[str, dict[str, Any]] = {}
    for lane, entry in data.items():
        if not isinstance(entry, dict):
            continue
        name = re.sub(r"[^a-z0-9_-]", "", str(lane).strip().lower())
        url = str(entry.get("url") or "").strip().rstrip("/")
        if name and url:
            clean[name] = {"url": url, "attached_at": str(entry.get("attached_at") or "")}
    return clean


def _write_attachments(attachments: dict[str, dict[str, Any]]) -> None:
    path = attachments_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(attachments, indent=1, sort_keys=True), encoding="utf-8")


def attach(url: str, lane: str = "default") -> dict[str, Any]:
    """Point one lane at a running ComfyUI. Refuses one that is not answering.

    Refusing an unreachable URL is the point: an attachment that silently does
    not work reappears later as "Generate failed" with no cause, which is the
    failure mode this item was opened for.
    """
    name = re.sub(r"[^a-z0-9_-]", "", str(lane or "default").strip().lower()) or "default"
    if name not in ATTACHABLE_LANES:
        raise ConnectError(
            f"'{lane}' is not a lane this studio routes to. Pick one of: {', '.join(ATTACHABLE_LANES)}"
        )
    target = normalize_url(url)
    probe = probe_url(target)
    if not probe["reachable"]:
        raise ConnectError(
            f"Nothing is serving ComfyUI at {target} — {probe['detail']}. Start ComfyUI first, "
            f"then attach it; the address is the one in ComfyUI's own window."
        )
    attachments = read_attachments()
    attachments[name] = {"url": target, "attached_at": datetime.now(timezone.utc).isoformat()}
    _write_attachments(attachments)
    return snapshot()


def detach(lane: str = "default") -> dict[str, Any]:
    """Forget an attachment. The lane falls back to its configured URL."""
    name = re.sub(r"[^a-z0-9_-]", "", str(lane or "default").strip().lower()) or "default"
    attachments = read_attachments()
    if name in attachments:
        attachments.pop(name)
        _write_attachments(attachments)
    return snapshot()


def lane_urls() -> dict[str, str]:
    """The configured lanes with any attachment folded over the top.

    Same shape the gateway builds; kept here so the control API can answer
    "which lane is where" without importing the gateway.
    """
    lanes = dict(comfy_lanes.configured_lanes())
    for lane, entry in read_attachments().items():
        lanes[lane] = entry["url"]
    return lanes


def snapshot(*, probe: bool = True, timeout: float = 2.0) -> dict[str, Any]:
    """Everything the Connect card renders, in one answer."""
    attachments = read_attachments()
    lanes: list[dict[str, Any]] = []
    for lane, url in sorted(lane_urls().items()):
        state = probe_url(url, timeout=timeout) if probe else {"reachable": False, "detail": "not checked"}
        lanes.append({
            "id": lane,
            "label": comfy_lanes.LANE_LABELS.get(lane, f"{lane.title()} lane"),
            "url": url,
            "attached": lane in attachments,
            "reachable": bool(state["reachable"]),
            "detail": str(state["detail"]),
            "version": state.get("version"),
        })
    return {
        "lanes": lanes,
        "connected": any(lane["reachable"] for lane in lanes),
        "detected": detect_installs(),
        "running": discover_running() if probe else [],
        "attachableLanes": list(ATTACHABLE_LANES),
        "installUrl": COMFY_INSTALL_URL,
        "sourceUrl": COMFY_SOURCE_URL,
        # Said out loud in the payload because the card says it out loud too:
        # detection reads, and nothing else.
        "readOnly": True,
    }
