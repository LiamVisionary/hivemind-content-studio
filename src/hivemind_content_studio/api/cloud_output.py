"""Keeping a cloud result.

A provider that renders in its own cloud hands back a URL and nothing else.
The link expires, so an output only this browser remembers is an output the
owner loses on the next relaunch. Everything here turns one of those links
into what a local render already produces: bytes under this workspace's
outputs root, sealed there, and indexed in this workspace's own History.

Moved out of control_api.py unchanged (2026-09-04); ``control_api`` re-exports
both functions and the ``CloudOutputFetcher`` alias its signature names.
"""

from __future__ import annotations

import mimetypes
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

CLOUD_OUTPUT_MAX_BYTES = 256 * 1024 * 1024
CloudOutputFetcher = Callable[[str], tuple[bytes, str]]

# What a provider may hand back, by the kind the studio asked for. A suffix the
# History index does not recognise lists as a row nothing will open.
_CLOUD_OUTPUT_SUFFIXES = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif"},
    "video": {".mp4", ".mov", ".webm", ".m4v", ".mkv"},
    "audio": {".mp3", ".wav", ".m4a"},
}
_CLOUD_OUTPUT_DEFAULT_SUFFIX = {"image": ".png", "video": ".mp4", "audio": ".mp3"}


def cloud_output_suffix(url: str, media_type: str, kind: str) -> str:
    """The extension this result is stored under.

    The URL's own extension when it is one this kind can have, then the served
    content type, then the kind's default. The name is what History reads the
    media type off, so guessing badly here is what makes a finished clip list
    as an octet-stream row with no player.
    """
    allowed = _CLOUD_OUTPUT_SUFFIXES.get(kind, _CLOUD_OUTPUT_SUFFIXES["image"])
    candidate = Path(urllib.parse.urlparse(str(url or "")).path or "").suffix.lower()
    if candidate in allowed:
        return candidate
    guessed = (mimetypes.guess_extension(str(media_type or "").split(";")[0].strip()) or "").lower()
    if guessed == ".jpe":
        guessed = ".jpg"
    if guessed in allowed:
        return guessed
    return _CLOUD_OUTPUT_DEFAULT_SUFFIX.get(kind, ".png")


def fetch_cloud_output(url: str) -> tuple[bytes, str]:
    """Download a finished cloud result, server-side.

    Server-side because the bytes must be sealed with this workspace's key
    before they touch disk, and because the browser cannot write to the outputs
    root at all. A ValueError is something the owner can act on; a RuntimeError
    is the provider not answering.
    """
    parsed = urllib.parse.urlparse(str(url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("That result address is not one this machine can fetch.")
    request = urllib.request.Request(
        parsed.geturl(),
        headers={"Accept": "*/*", "User-Agent": "hivemind-content-studio"},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            declared = response.headers.get("Content-Length") or ""
            if declared.isdigit() and int(declared) > CLOUD_OUTPUT_MAX_BYTES:
                raise ValueError("That result is too large to keep on this machine.")
            payload = response.read(CLOUD_OUTPUT_MAX_BYTES + 1)
            media_type = response.headers.get_content_type() or ""
    except ValueError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeError("The provider's result could not be downloaded.") from exc
    if len(payload) > CLOUD_OUTPUT_MAX_BYTES:
        raise ValueError("That result is too large to keep on this machine.")
    if not payload:
        raise RuntimeError("The provider's result was empty.")
    return payload, media_type
