"""Video restoration through the local media gateway, and what it costs.

The restore itself lives in the gateway (packages/media-gateway/video_restore.py
and its runner): chunk planning, SeedVR2, resume, assembly, finishing. This
module is the studio's side of the wire — the proxy the browser talks to, plus
the one thing the gateway deliberately does not decide.

THE ONE THING: which machine, and therefore whether this render is the free one
or the paid one. The gateway reports a lane as `paid` when it is remote, which
is true but thin. A rented GPU bills by the hour the whole time it thinks, so
"paid" here also means: an estimate before the render starts, in the same
dollars the Machines page shows, and the two facts that follow from renting —
that the chunks come back sealed to the owner's vault (the gateway cannot read
them) and that the master is therefore joined in the browser.

None of that is a second billing rail. A rented machine is already metered by
GPU rentals against the shared HivemindOS credit balance; a restoration is one
more thing to run on a box that is already rented, priced with the same number.
There is nothing new to top up, and nothing here charges anything by itself.

WHERE THE PRICE ARITHMETIC LIVES: in the browser, beside the button that shows
it (packages/open-generative-ai/src/lib/videoRestore.js). It is an hourly rate
times a measured duration, and the rate is already on screen on the Machines
page — doing it here would mean this proxy calling the marketplace APIs on every
capability poll, which is a billable third-party request nobody can afford to
poll.
"""

from __future__ import annotations

import json
import os
import queue
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .settings import settings

# Long enough for a source upload to cross the loopback; the render itself is a
# background job on the gateway, so no request here waits on diffusion.
UPLOAD_TIMEOUT_SECONDS = 600.0
READ_TIMEOUT_SECONDS = 30.0
# A gigabyte source crossing this process must never exist in it. The request
# body is handed to the gateway one block at a time through StreamedBody, and
# this is how many blocks may be in flight before the reader has to wait for
# the writer — a few hundred kilobytes of ASGI chunks, not a film.
STREAM_QUEUE_DEPTH = 8


class StreamedBody:
    """A read-only body one thread fills while another sends it.

    urllib will read a `data` object that has `.read(size)` in blocks, provided
    the caller sets Content-Length itself (otherwise it falls back to chunked
    transfer-encoding, which the gateway's plain HTTP server does not decode).
    That is the whole trick: the async side feeds ASGI chunks in, the blocking
    urllib call in a worker thread pulls them out, and no copy of the clip is
    ever assembled anywhere.

    `stop()` is what keeps a failed upload from hanging: when the sender dies
    (a 413 from the gateway, a dropped socket) the feeder's next `feed` raises
    instead of blocking forever on a queue nobody is draining.
    """

    class Stopped(RuntimeError):
        """The far end stopped reading. The real reason is on the send call."""

    def __init__(self, depth: int = STREAM_QUEUE_DEPTH):
        self._queue: queue.Queue = queue.Queue(maxsize=max(1, depth))
        self._buffer = b""
        self._finished = False
        self._stopped = False

    # --- the feeding side (the request handler) ---
    def offer(self, block: bytes) -> bool:
        """Hand over a block without ever waiting. False when the queue is full.

        The caller is an event loop and the queue is almost never full, so this
        is the path a whole upload normally takes — no thread hop per 64KB ASGI
        chunk. Only backpressure sends the caller to `feed` in a worker.
        """
        if not block:
            return True
        if self._stopped:
            raise StreamedBody.Stopped("the upload was not accepted")
        try:
            self._queue.put_nowait(block)
            return True
        except queue.Full:
            return False

    def feed(self, block: bytes) -> None:
        if not block:
            return
        while True:
            if self._stopped:
                raise StreamedBody.Stopped("the upload was not accepted")
            try:
                self._queue.put(block, timeout=0.25)
                return
            except queue.Full:
                continue

    def finish(self) -> None:
        try:
            self._queue.put(None, timeout=5.0)
        except queue.Full:
            self._stopped = True

    def stop(self) -> None:
        self._stopped = True
        # Unblock a reader parked on an empty queue.
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    # --- the reading side (urllib, in a worker thread) ---
    def read(self, size: int = -1) -> bytes:
        while not self._finished and (size < 0 or len(self._buffer) < size):
            block = self._queue.get()
            if block is None:
                self._finished = True
                break
            self._buffer += block
        if size < 0 or size >= len(self._buffer):
            out, self._buffer = self._buffer, b""
        else:
            out, self._buffer = self._buffer[:size], self._buffer[size:]
        return out


class RestoreError(RuntimeError):
    """Something the owner can act on. Carries a remedy when one exists."""

    def __init__(self, message: str, *, remedy: str = "", status_code: int = 502):
        super().__init__(message)
        self.remedy = remedy
        self.status_code = status_code


class RestoreGatewayClient:
    """Thin proxy. The gateway owns every decision; this owns the token."""

    def __init__(self, *, base_url: str = "", token_file: str | Path | None = None):
        state_root = Path(
            os.environ.get("HIVEMIND_MEDIA_STATE_DIR", Path.home() / ".hivemindos/media-studio")
        )
        self.base_url = (base_url or settings().network.gateway_url).rstrip("/")
        self.token_file = Path(
            token_file or os.environ.get("ZIMG_TOKEN_FILE", state_root / "secure/zimg-token")
        ).expanduser().resolve()

    def _token(self) -> str:
        try:
            token = self.token_file.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RestoreError(
                "The media gateway is not set up on this machine.",
                remedy="start-stack", status_code=503,
            ) from exc
        if len(token) < 12:
            raise RestoreError(
                "The media gateway is not set up on this machine.",
                remedy="start-stack", status_code=503,
            )
        return token

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        timeout: float = READ_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self._token()}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            operational = False
            try:
                payload = json.loads(exc.read().decode("utf-8") or "{}")
                detail = str(payload.get("error") or "")
                operational = bool(payload.get("operational"))
            except Exception:
                detail = ""
            # A stale "Run on" pin and an unequipped lane are both things the
            # owner fixes in one click, so they keep their own words rather
            # than becoming "the gateway said no".
            raise RestoreError(
                detail or "The restore service refused that request.",
                remedy="pick-machine" if operational else "",
                status_code=exc.code if exc.code in (400, 404, 409) else 502,
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RestoreError(
                "The media gateway is not answering.",
                remedy="start-stack", status_code=503,
            ) from exc

    def upload_source(
        self,
        body: Any,
        length: int,
        *,
        path: str = "/api/restore/upload",
        timeout: float = UPLOAD_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        """Stream a source clip to the gateway and return its staged id.

        `body` is anything with `.read(size)` — a StreamedBody fed by the
        request handler, or an open file. Content-Length is set from `length`
        because urllib would otherwise use chunked transfer-encoding, which the
        gateway's http.server does not decode.
        """
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={
                "Authorization": f"Bearer {self._token()}",
                "Accept": "application/json",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(int(length)),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8") or "{}")
                detail = str(payload.get("error") or "")
            except Exception:
                detail = ""
            # A clip past the ceiling is the one refusal here worth its own
            # words: it names both numbers and what to do, and it must reach
            # the studio as 413 so the picker can say it beside the file.
            raise RestoreError(
                detail or "The restore service would not take that clip.",
                status_code=exc.code if exc.code in (400, 404, 409, 413, 507) else 502,
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RestoreError(
                "The media gateway is not answering.",
                remedy="start-stack", status_code=503,
            ) from exc

    def media(self, path: str, *, timeout: float = 300.0) -> tuple[bytes, str]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            headers={"Authorization": f"Bearer {self._token()}", "Accept": "video/*"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), response.headers.get_content_type()
        except urllib.error.HTTPError as exc:
            raise RestoreError(
                "That restoration's source clip is no longer on this machine.",
                status_code=404 if exc.code == 404 else 502,
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise RestoreError("The media gateway is not answering.", remedy="start-stack", status_code=503) from exc


_client: RestoreGatewayClient | None = None


def client() -> RestoreGatewayClient:
    global _client
    if _client is None:
        _client = RestoreGatewayClient()
    return _client
