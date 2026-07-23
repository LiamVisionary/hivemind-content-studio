"""Safe model discovery and planning through the authenticated local HivemindOS API."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable

from .hivemindos_hosted_media import _dashboard_token
from .hivemindos_oauth import _hivemindos_base_urls


LOCAL_BRAIN_PROVIDER = {
    "slug": "local-planner",
    "name": "Built-in planner",
    "models": [
        {
            "id": "deterministic-v1",
            "auth": "local",
            "vision": False,
            "recommended": True,
        }
    ],
}


def brain_catalog(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    # Catalog discovery is on the studio's first-paint path — a busy dashboard
    # must degrade to the local planner quickly, not stall the model UI.
    return _request("/api/local-apps/content-studio/catalog", method="GET", opener=opener, timeout=8)


def plan_with_brain(payload: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    response = _request("/api/local-apps/content-studio/plan", method="POST", body=payload, opener=opener, timeout=130)
    plan = response.get("plan")
    if not isinstance(plan, dict):
        raise RuntimeError("HivemindOS returned no Content Studio plan")
    return plan


def local_brain_catalog() -> dict[str, Any]:
    return {"ok": True, "providers": [LOCAL_BRAIN_PROVIDER], "fallback": True}


def plan_with_local_brain(payload: dict[str, Any]) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or "").strip()[:20_000]
    if not prompt:
        raise RuntimeError("A production prompt is required")
    history = payload.get("history") if isinstance(payload.get("history"), list) else []
    if bool(payload.get("walkthrough")) and not history:
        return {
            "mode": "questions",
            "message": "The built-in planner needs one more pass before it creates the draft.",
            "questions": ["What audience, outcome, and visual tone should this production optimize for?"],
            "planner": "local-planner:deterministic-v1",
        }

    studio_mode = str(payload.get("studioMode") or "create")
    lane = {"edit": "static-text-ad", "animate": "animation"}.get(studio_mode, "first-frame-animation-ad")
    runtime = {"edit": 6, "animate": 4}.get(studio_mode, 15)
    title = prompt.splitlines()[0].strip().rstrip(".")[:180] or "Untitled production"
    scene = {
        "title": {"edit": "Image edit", "animate": "Animation", "create": "Opening"}.get(studio_mode, "Opening"),
        "beat": prompt,
        "duration_seconds": runtime,
        "image_prompt": prompt if studio_mode in {"create", "edit"} else "",
        "motion_prompt": prompt if studio_mode in {"create", "animate"} else "",
    }
    return {
        "mode": "confirmation",
        "message": "The built-in local planner prepared a conservative draft. Review it before creating the run.",
        "planner": "local-planner:deterministic-v1",
        "draft": {
            "lane": lane,
            "title": title,
            "concept": prompt,
            "goal": prompt,
            "aspect_ratio": "9:16" if studio_mode != "edit" else "4:5",
            "runtime_seconds": runtime,
            "scenes": [scene],
            "voice": {"enabled": studio_mode != "edit", "provider": "universal-tts"},
            "subtitles": {"enabled": studio_mode != "edit", "position": "bottom", "font_size": 56},
            "privacy": "local-first",
            "max_cost_usd": 0,
        },
    }


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
