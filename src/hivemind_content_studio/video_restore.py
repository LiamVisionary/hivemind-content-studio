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
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787"
# Long enough for a source upload to cross the loopback; the render itself is a
# background job on the gateway, so no request here waits on diffusion.
UPLOAD_TIMEOUT_SECONDS = 600.0
READ_TIMEOUT_SECONDS = 30.0


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
        self.base_url = (base_url or os.environ.get("ZIMG_GATEWAY_URL") or DEFAULT_GATEWAY_URL).rstrip("/")
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
