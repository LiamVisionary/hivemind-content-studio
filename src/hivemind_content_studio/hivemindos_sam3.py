"""Hosted SAM3 subject masking, for lanes that cannot track one themselves.

The head-replacement workflow (``minimax-h3-inpaint``) can track a subject with
comfy-core's native SAM3 nodes — but only on a lane that HAS
``checkpoints/sam3.1_multiplex_fp16.safetensors``. A local ComfyUI on a laptop,
a box provisioned before that checkpoint shipped, anything not CUDA: none of
them can. This module is the other way to get the same mask.

Send the clip and a phrase, get back a white-on-black mask CLIP — one frame per
source frame — which the graph loads through its ``mask_source="sequence"``
branch. So the studio offers SAM3 masking everywhere, and only the place it runs
changes.

**It costs credits, and it is the same balance.** The gateway debits the shared
HivemindOS credit account the studio already spends on hosted models and GPU
rentals (``hivemindos_models.credit_token``), so this needs no second account
and no second top-up. Price is quoted before anything is sent, and the studio
shows it: a mask that silently costs money is a mask nobody would have asked for.

Privacy: this is the one masking path where the footage leaves the machine. The
dialog says so beside the button, and this module never sends a clip that was
not passed to it for exactly that purpose.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from .hivemindos_models import USER_AGENT, HivemindosModelsError, credit_token

DEFAULT_GATEWAY_URL = "https://hivemindos-sam3-gateway.hivemindos.workers.dev"
GATEWAY_URL_ENV = "HIVEMINDOS_SAM3_GATEWAY_URL"

# What the caller has to have approved before a single byte is uploaded. The
# gateway enforces its own per-job ceiling too; this one exists so a studio bug
# cannot spend more than a mask is ever worth.
MAX_APPROVED_USD = 2.0

# Polling. The gateway has no callbacks — a step is the only completion signal —
# and a cold RunPod worker takes ~30s to load the checkpoint, so the first few
# polls are expected to say "queued".
POLL_INTERVAL_SECONDS = 3.0
MAX_POLLS = 120


def gateway_url() -> str:
    return (os.environ.get(GATEWAY_URL_ENV) or DEFAULT_GATEWAY_URL).strip().rstrip("/")


def _request(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    token: str = "",
    timeout: float = 60.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    # The User-Agent is load-bearing: Cloudflare answers 403 to urllib's default
    # `Python-urllib/*` in front of a workers.dev deployment, before the request
    # reaches the worker at all. Measured 2026-09-01 against the sibling
    # restore-gateway; this client has never been deployed and so has never hit
    # it. `hivemindos_models` — the one that IS live — already sends this.
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["X-HivemindOS-Credit-Token"] = token
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{gateway_url()}{path}", data=data, headers=headers, method=method)
    try:
        with opener(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8") or "{}").get("error") or ""
        except Exception:
            detail = ""
        raise _readable_error(exc.code, detail) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise HivemindosModelsError(
            "The HivemindOS masking service could not be reached.",
            remedy="retry",
        ) from None
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise HivemindosModelsError(
            str((payload or {}).get("error") or "The masking service refused that request."),
        )
    return payload


def _readable_error(status: int, detail: str) -> HivemindosModelsError:
    """A message with an action beside it, never a bare status.

    402 in particular is the one a person can actually fix, and "payment
    required" is not the sentence that tells them how."""
    if status == 402:
        return HivemindosModelsError(
            detail or "Your HivemindOS credit balance is too low for this mask.",
            remedy="top-up",
        )
    if status == 401:
        return HivemindosModelsError(
            "Connect your HivemindOS account to use hosted masking.",
            remedy="connect",
        )
    if status == 503:
        return HivemindosModelsError(
            "Hosted masking is not available right now — track on your own lane, or paint the mask by hand.",
            remedy="retry",
        )
    return HivemindosModelsError(detail or "The masking service refused that request.")


def status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Whether hosted masking is reachable and switched on, without spending."""
    try:
        payload = _request("/health", opener=opener, timeout=8.0)
    except HivemindosModelsError:
        return {"available": False, "configured": False, "connected": bool(credit_token())}
    return {
        "available": bool(payload.get("enabled")) and bool(payload.get("configured")),
        "configured": bool(payload.get("configured")),
        "connected": bool(credit_token()),
    }


def quote(
    *,
    frames: int,
    width: int,
    height: int,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """What one mask would cost, before anything is uploaded."""
    payload = _request(
        "/v1/quote",
        method="POST",
        body={"frames": int(frames), "width": int(width), "height": int(height)},
        opener=opener,
        timeout=15.0,
    )
    return dict(payload.get("quote") or {})


def mask_video(
    *,
    video: str | Path,
    frames: int,
    width: int,
    height: int,
    prompt: str = "head",
    detection_threshold: float = 0.5,
    max_objects: int = 1,
    detect_interval: int = 1,
    maximum_debit_usd: float = MAX_APPROVED_USD,
    idempotency_key: str = "",
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Track a subject through a clip and return the mask clip's bytes.

    Returns ``{"mask_base64", "charged_usd", "frames"}``. Raises
    HivemindosModelsError with a ``remedy`` on anything the owner can act on.
    """
    source = Path(video).expanduser().resolve()
    if not source.is_file():
        raise HivemindosModelsError("The clip to mask could not be read.")
    token = credit_token()
    if not token:
        raise HivemindosModelsError(
            "Connect your HivemindOS account to use hosted masking.",
            remedy="connect",
        )
    approved = round(float(maximum_debit_usd), 6)
    if approved <= 0 or approved > MAX_APPROVED_USD:
        raise ValueError(f"maximum_debit_usd must be greater than 0 and no more than {MAX_APPROVED_USD}")

    # The key is REQUIRED by the gateway: without one, a retry of this call is a
    # second reservation against the same intent. Derived per call rather than
    # per clip, because two deliberate masks of one clip are two jobs.
    key = (idempotency_key or f"sam3-{uuid.uuid4().hex}").strip()[:128]
    submitted = _request(
        "/v1/masks",
        method="POST",
        token=token,
        timeout=300.0,
        opener=opener,
        body={
            "video_base64": base64.b64encode(source.read_bytes()).decode("ascii"),
            "frames": int(frames),
            "width": int(width),
            "height": int(height),
            "prompt": str(prompt or "head")[:200],
            "detection_threshold": float(detection_threshold),
            "max_objects": int(max_objects),
            "detect_interval": int(detect_interval),
            "maximum_debit_usd": approved,
            "idempotency_key": key,
        },
    )
    mask_id = str((submitted.get("mask") or {}).get("id") or "").strip()
    if not mask_id:
        raise HivemindosModelsError("The masking service accepted the clip but named no job.")

    for _ in range(MAX_POLLS):
        payload = _request(
            f"/v1/masks/{urllib.parse.quote(mask_id)}/step",
            method="POST",
            token=token,
            timeout=60.0,
            opener=opener,
        )
        record = payload.get("mask") or {}
        state = str(record.get("status") or "")
        if state == "complete":
            url = str(record.get("maskVideoUrl") or "")
            if not url.startswith("data:"):
                # An https mask is fetched rather than trusted as a URL: the
                # graph is handed BYTES, and a URL the lane would have to fetch
                # is a lane reaching out to a third party mid-render.
                url = _fetch_as_data_url(url, opener=opener)
            return {
                "mask_base64": url.split(",", 1)[-1],
                "charged_usd": record.get("chargedUsd"),
                "frames": record.get("frames"),
            }
        if state == "failed":
            raise HivemindosModelsError(
                str(record.get("error") or "Masking failed.") + " Nothing was charged.",
                remedy="retry",
            )
        sleeper(POLL_INTERVAL_SECONDS)
    raise HivemindosModelsError(
        "Masking is taking longer than expected — it may still finish; try again in a moment.",
        remedy="retry",
    )


def _fetch_as_data_url(url: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> str:
    if not url.lower().startswith("https://"):
        raise HivemindosModelsError("The masking service returned an unusable mask.")
    try:
        request = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
        with opener(request, timeout=120.0) as response:
            body = response.read()
    except Exception:
        raise HivemindosModelsError("The finished mask could not be downloaded.", remedy="retry") from None
    return "data:video/mp4;base64," + base64.b64encode(body).decode("ascii")
