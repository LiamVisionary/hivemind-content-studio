"""Hold the MUAPI key on this machine instead of in the browser.

Every other cloud provider the studio can reach is authenticated server-side
from the shared Hive environment (`~/.hivemindos/.env`), which is also where
HivemindOS keeps its keys — so a machine that has already been given a MUAPI key
should never ask for it again. Until 2026-08-24 MUAPI was the exception: the
browser held its own copy in localStorage and called api.muapi.ai directly, so a
user whose HivemindOS already had `MUAPI_API_KEY` was still prompted for one.

This forwards the studio's existing MUAPI calls through this server with the
key attached here. It is deliberately a PROXY and not a re-implementation: the
browser client already owns endpoint resolution, the poll cadence, the
detail-envelope unwrapping, cancellation and the request-id contract that lets a
reload reclaim a running job. Re-expressing all of that server-side would be a
second implementation to keep in step, and the failure mode of the two drifting
is a job the browser polls forever.

Narrow on purpose: one upstream host, one path prefix, owner-gated, and no
request without a server-held key. It is a credential shim, not a general relay.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

UPSTREAM = "https://api.muapi.ai"

# The only prefix that may be reached. MUAPI's whole surface lives under it, and
# anything else would make this a relay to an arbitrary path on someone else's
# host.
ALLOWED_PREFIX = "api/v1/"

# Hop-by-hop and identity headers that must not be copied in either direction.
# `x-api-key` especially: the browser has no key any more, and a caller that
# sent one must not be able to spend against it through this route.
_STRIPPED_REQUEST_HEADERS = {
    "host", "connection", "content-length", "x-api-key", "authorization",
    "cookie", "origin", "referer", "accept-encoding",
}
_STRIPPED_RESPONSE_HEADERS = {
    "connection", "content-encoding", "content-length", "transfer-encoding",
    "set-cookie", "strict-transport-security",
}


class MuapiProxyError(RuntimeError):
    """The request cannot be forwarded. The message is shown to the owner."""


def server_key() -> str:
    """The MUAPI key this machine holds, or ''.

    Read per call rather than cached: the shared env is applied at startup, but
    a key added to HivemindOS while the studio is running should work after a
    restart without anyone wondering which layer cached it.
    """
    return os.environ.get("MUAPI_API_KEY", "").strip()


def has_server_key() -> bool:
    return bool(server_key())


def safe_path(path: str) -> str:
    """The upstream path for `path`, or raise.

    Rejects traversal and absolute URLs rather than normalising them: a proxy
    that quietly rewrites where it is pointed is one bug away from pointing
    somewhere else.
    """
    cleaned = str(path or "").lstrip("/")
    if not cleaned.startswith(ALLOWED_PREFIX):
        raise MuapiProxyError(f"Only {ALLOWED_PREFIX}* may be reached through this route")
    if ".." in cleaned or "//" in cleaned or "://" in cleaned or "\\" in cleaned:
        raise MuapiProxyError("Invalid MUAPI path")
    return cleaned


def forward(
    *,
    method: str,
    path: str,
    query: str = "",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 240.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> tuple[int, bytes, dict[str, str]]:
    """Forward one call to MUAPI and return its status, body and headers verbatim.

    Verbatim matters: the browser client already knows how to read a MUAPI
    failure (including the `{detail: {status: 'failed'}}` envelope it returns at
    HTTP 200), and a proxy that reshapes errors would break that reading.
    """
    key = server_key()
    if not key:
        raise MuapiProxyError(
            "MUAPI_API_KEY is not set on this machine. Add it with "
            "`passbook add MUAPI_API_KEY` and restart the studio."
        )
    upstream_path = safe_path(path)
    url = f"{UPSTREAM}/{upstream_path}"
    if query:
        url = f"{url}?{query}"

    outgoing = {
        name: value for name, value in (headers or {}).items()
        if name.lower() not in _STRIPPED_REQUEST_HEADERS
    }
    outgoing["x-api-key"] = key
    outgoing.setdefault("Accept", "application/json")

    request = urllib.request.Request(url, data=body, method=method.upper(), headers=outgoing)
    try:
        with opener(request, timeout=timeout) as response:
            payload = response.read()
            status = int(getattr(response, "status", 200) or 200)
            received = dict(getattr(response, "headers", {}) or {})
    except urllib.error.HTTPError as exc:
        # An upstream 4xx/5xx is an ANSWER, not a transport failure: MUAPI puts
        # the reason in the body and the browser client renders it.
        payload = exc.read()
        status = int(exc.code)
        received = dict(exc.headers or {})
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise MuapiProxyError(f"MUAPI did not answer: {exc}") from exc

    passthrough = {
        name: value for name, value in received.items()
        if name.lower() not in _STRIPPED_RESPONSE_HEADERS
    }
    return status, payload, passthrough
