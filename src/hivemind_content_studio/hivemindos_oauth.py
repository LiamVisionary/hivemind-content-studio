"""Safe OAuth status, login, and xAI media calls through local HivemindOS."""

from __future__ import annotations

import json
import os
import urllib.error
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
    if provider_id == "xai":
        usable = bool(payload.get("usable"))
        needs_reconnect = bool(payload.get("needsReconnect"))
        detail = str(payload.get("error") or ("xAI OAuth is ready" if usable else "xAI OAuth is not connected"))
    else:
        usable = connected
        needs_reconnect = False
        detail = (
            "OpenAI OAuth is ready for GPT Image through the beta ChatGPT/Codex Responses image tool"
            if connected
            else "OpenAI OAuth is not connected"
        )
    return {
        "provider": provider_id,
        "connected": connected,
        "usable": usable,
        "needs_reconnect": needs_reconnect,
        "detail": detail,
    }


def start_oauth_login(provider: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    provider_id = _provider(provider)
    payload = _request(provider_id, method="POST", body={"action": "start"}, opener=opener)
    authorize_url = str(payload.get("authorizeUrl") or "").strip()
    allowed_prefix = "https://auth.x.ai/" if provider_id == "xai" else "https://auth.openai.com/"
    if not authorize_url.startswith(allowed_prefix):
        raise RuntimeError(f"HivemindOS returned an invalid {provider_id} OAuth authorization URL")
    return {"provider": provider_id, "authorize_url": authorize_url}


def xai_oauth_media_request(payload: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    response = _request("xai", method="POST", path_suffix="/media", body=payload, opener=opener, timeout=210)
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("HivemindOS xAI OAuth media bridge returned no result")
    return result


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
