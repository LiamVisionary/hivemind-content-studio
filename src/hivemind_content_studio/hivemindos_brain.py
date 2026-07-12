"""Safe model discovery and planning through the authenticated local HivemindOS API."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable

from .hivemindos_hosted_media import _dashboard_token
from .hivemindos_oauth import _hivemindos_base_urls


def brain_catalog(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    return _request("/api/local-apps/content-studio/catalog", method="GET", opener=opener)


def plan_with_brain(payload: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    response = _request("/api/local-apps/content-studio/plan", method="POST", body=payload, opener=opener, timeout=130)
    plan = response.get("plan")
    if not isinstance(plan, dict):
        raise RuntimeError("HivemindOS returned no Content Studio plan")
    return plan


def _request(
    path: str,
    *,
    method: str,
    opener: Callable[..., Any],
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    token = _dashboard_token()
    if not token:
        raise RuntimeError("HivemindOS device authentication is unavailable")
    last_error = "HivemindOS did not answer"
    for base_url in _hivemindos_base_urls():
        request = urllib.request.Request(
            f"{base_url}{path}",
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
                error = json.loads(exc.read().decode("utf-8"))
                last_error = str(error.get("error") or error.get("detail") or f"HTTP {exc.code}")
            except (json.JSONDecodeError, AttributeError):
                last_error = f"HivemindOS returned HTTP {exc.code}"
            continue
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            last_error = "HivemindOS returned an invalid response"
            break
        if value.get("ok") is not True:
            last_error = str(value.get("error") or "HivemindOS request failed")
            break
        return value
    raise RuntimeError(last_error)
