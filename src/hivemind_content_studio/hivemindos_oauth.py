"""Safe OAuth status, login, and xAI media calls through local HivemindOS."""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

from .hivemindos_hosted_media import _dashboard_token


SUPPORTED_OAUTH_PROVIDERS = {"openai", "xai"}


def oauth_provider_status(provider: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    provider_id = _provider(provider)
    try:
        payload = _request(provider_id, method="GET", opener=opener)
    except RuntimeError as exc:
        return {
            "provider": provider_id,
            "connected": False,
            "usable": False,
            "needs_reconnect": False,
            "detail": str(exc),
        }
    connected = bool(payload.get("connected"))
    error = str(payload.get("error") or "").strip()
    if provider_id == "xai":
        usable = bool(payload.get("usable"))
        needs_reconnect = bool(payload.get("needsReconnect"))
        detail = str(error or ("xAI OAuth is ready" if usable else "xAI OAuth is not connected"))
    else:
        # `usable = connected` was a lie the user only found out about at
        # generation time: a grant whose refresh token has been revoked still
        # reports connected, and the first sign of it was "Invalid refresh
        # token" in place of an image (reported 2026-08-24). Read the same
        # liveness fields xAI reports when the dashboard sends them, and treat
        # an error beside a connected grant as a grant that needs reconnecting.
        reported_usable = payload.get("usable")
        usable = bool(reported_usable) if reported_usable is not None else (connected and not error)
        needs_reconnect = bool(payload.get("needsReconnect")) or (connected and not usable)
        detail = str(error or (
            "OpenAI OAuth is ready for GPT Image through the beta ChatGPT/Codex Responses image tool"
            if usable
            else "OpenAI OAuth is not connected"
        ))
    return {
        "provider": provider_id,
        "connected": connected,
        "usable": usable,
        "needs_reconnect": needs_reconnect,
        "detail": detail,
    }


def _connects(host: str, port: int, *, family: int = 0, first_only: bool = False, timeout: float = 1.5) -> bool:
    """Can a TCP connection be opened to `host:port`?

    `first_only` models a BROWSER rather than a library. Python's own loop tries
    every address getaddrinfo returns and succeeds if any answers; a browser
    reaches for the first-preference address and, when that is refused, reports
    the refusal — refusal is immediate and definitive, so nothing falls back.
    Probing the forgiving way said `localhost:1455` was fine while Chrome could
    not reach it, which is the failure this whole check exists to catch.
    """
    try:
        infos = socket.getaddrinfo(host, port, family, socket.SOCK_STREAM)
    except OSError:
        return False
    for info_family, socktype, proto, _canon, address in (infos[:1] if first_only else infos):
        connection = socket.socket(info_family, socktype, proto)
        connection.settimeout(timeout)
        try:
            connection.connect(address)
            return True
        except OSError:
            continue
        finally:
            connection.close()
    return False


def callback_reachability(authorize_url: str) -> dict[str, Any]:
    """Will the sign-in be able to come back?

    An authorization page that redirects to a port nothing answers on wastes the
    whole flow AFTER the user has approved it — which is what happened on
    2026-08-24: the callback went to `localhost:1455` and the browser got
    ERR_CONNECTION_REFUSED. The listener was up the entire time, on
    127.0.0.1 only, while macOS resolves `localhost` to ::1 first; a refused
    connection is immediate and definitive, so nothing fell back to IPv4.

    Checked BEFORE the browser is opened, because after it is opened the only
    thing left to show is the failure.
    """
    try:
        target = urllib.parse.parse_qs(urllib.parse.urlparse(authorize_url).query).get("redirect_uri", [""])[0]
        parsed = urllib.parse.urlparse(target)
    except ValueError:
        return {"checked": False, "reachable": True, "target": "", "detail": "", "remedy": ""}
    host, port = parsed.hostname or "", parsed.port or (443 if parsed.scheme == "https" else 80)
    # Only a loopback callback is ours to reason about. A hosted redirect is
    # somebody else's server and probing it says nothing useful.
    if host not in {"localhost", "127.0.0.1", "::1"}:
        return {"checked": False, "reachable": True, "target": f"{host}:{port}", "detail": "", "remedy": ""}

    as_browser = _connects(host, port, first_only=True)
    over_ipv4 = _connects("127.0.0.1", port, family=socket.AF_INET)
    over_ipv6 = _connects("::1", port, family=socket.AF_INET6)
    if as_browser:
        return {"checked": True, "reachable": True, "target": f"{host}:{port}", "detail": "", "remedy": ""}
    if over_ipv4 and not over_ipv6:
        return {
            "checked": True,
            "reachable": False,
            "target": f"{host}:{port}",
            "detail": (
                f"The sign-in would come back to {host}:{port}, which resolves to ::1 on this "
                f"machine — and the listener is bound to 127.0.0.1 only, so the callback is refused."
            ),
            "remedy": (
                f"Start the HivemindOS app listening on both address families (bind :: rather than "
                f"127.0.0.1) so {host}:{port} answers over IPv6 as well."
            ),
        }
    return {
        "checked": True,
        "reachable": False,
        "target": f"{host}:{port}",
        "detail": f"Nothing is listening on {host}:{port}, so the sign-in would have nowhere to come back to.",
        "remedy": "Start the HivemindOS app, then try connecting again.",
    }


def start_oauth_login(provider: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    provider_id = _provider(provider)
    payload = _request(provider_id, method="POST", body={"action": "start"}, opener=opener)
    authorize_url = str(payload.get("authorizeUrl") or "").strip()
    allowed_prefix = "https://auth.x.ai/" if provider_id == "xai" else "https://auth.openai.com/"
    if not authorize_url.startswith(allowed_prefix):
        raise RuntimeError(f"HivemindOS returned an invalid {provider_id} OAuth authorization URL")
    return {
        "provider": provider_id,
        "authorize_url": authorize_url,
        # Whether the round trip can complete, decided before anyone is sent
        # anywhere. The redirect_uri is registered with the provider and must
        # not be rewritten, so this reports rather than repairs.
        "callback": callback_reachability(authorize_url),
    }


def xai_oauth_media_request(payload: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    response = _request("xai", method="POST", path_suffix="/media", body=payload, opener=opener, timeout=210)
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("HivemindOS xAI OAuth media bridge returned no result")
    return result


# Phrases a provider uses when the GRANT is the problem rather than the request.
# Matched so the studio can offer "Reconnect" instead of showing the sentence.
_REAUTH_MARKERS = ("refresh token", "invalid_grant", "unauthorized", "not connected",
                   "expired", "revoked", "re-authenticate", "reauthenticate", "sign in again")


def needs_reauthorization(message: str) -> bool:
    """Is this failure one the user fixes by reconnecting the account?

    The alternative — showing the provider's own words and leaving them to work
    it out — is what happened on 2026-08-24, and "Invalid refresh token" is not
    an instruction.
    """
    lowered = str(message or "").lower()
    return any(marker in lowered for marker in _REAUTH_MARKERS)


def openai_oauth_media_request(payload: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    response = _request("openai", method="POST", path_suffix="/media", body=payload, opener=opener, timeout=210)
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("HivemindOS OpenAI OAuth media bridge returned no result")
    return result


def _request(
    provider: str,
    *,
    method: str,
    path_suffix: str = "",
    body: dict[str, Any] | None = None,
    opener: Callable[..., Any],
    timeout: int = 20,
) -> dict[str, Any]:
    token = _dashboard_token()
    if not token:
        raise RuntimeError("HivemindOS device authentication is unavailable")
    last_error = "HivemindOS did not answer"
    for base_url in _hivemindos_base_urls():
        request = urllib.request.Request(
            f"{base_url}/api/{provider}-oauth{path_suffix}",
            data=json.dumps(body).encode("utf-8") if body is not None else None,
            method=method,
            headers={
                "x-hivemindos-device-token": token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with opener(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                error_payload = json.loads(exc.read().decode("utf-8"))
                last_error = str(error_payload.get("error") or error_payload.get("detail") or f"HTTP {exc.code}")
            except (json.JSONDecodeError, AttributeError):
                last_error = f"HivemindOS returned HTTP {exc.code}"
            break
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            last_error = "HivemindOS returned an invalid OAuth response"
            break
        if value.get("ok") is not True:
            last_error = str(value.get("error") or "HivemindOS OAuth request failed")
            break
        return value
    raise RuntimeError(last_error)


def _hivemindos_base_urls() -> tuple[str, ...]:
    configured = os.environ.get("HIVEMINDOS_URL", "").strip().rstrip("/")
    candidates = [configured] if configured else []
    candidates.extend(["http://127.0.0.1:5020", "http://127.0.0.1:5021"])
    valid: list[str] = []
    for value in candidates:
        if value.startswith(("http://127.0.0.1:", "http://localhost:", "https://")) and value not in valid:
            valid.append(value)
    return tuple(valid)


def _provider(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized not in SUPPORTED_OAUTH_PROVIDERS:
        raise ValueError("OAuth provider must be openai or xai")
    return normalized
