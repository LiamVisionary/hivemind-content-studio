"""The hosted, pay-per-render restoration lane, from the gateway's side.

WHAT IT IS. A third place a restoration can run, beside this computer's own
ComfyUI and a GPU the owner rented by the hour. Nothing is running between
renders: a chunk is uploaded, a serverless worker wakes, restores it, and scales
back to zero. It is billed per chunk in HivemindOS credits — the same balance
the studio already spends on hosted models, rentals and hosted masking, so there
is no second account and nothing new to top up.

WHY IT IS BILLED PER CHUNK. A restoration is already chunked for reasons that
have nothing to do with money: the model holds a window of frames, and a chunk
boundary is the checkpoint an interrupted render resumes from. The billing
follows that seam rather than cutting across it. A render stopped halfway has
paid for the chunks it got and nothing else, and the studio never has to hold a
reservation against work it may not do.

WHY THE CREDIT TOKEN IS PASSED IN RATHER THAN READ. This process cannot reach
the owner's HivemindOS account: the token lives in the control API's encrypted
store (src/hivemind_content_studio/hivemindos_models.py) and this gateway has no
business holding a copy. So the control API attaches it to the start request
that asks for this lane, and the runner keeps it in memory for the life of the
render — never in the project manifest, never in a job record, never in a log.
A resume asks for it again, which it gets for free, because a resume is a fresh
start request through the same proxy.

WHAT LEAVES THE MACHINE. Footage. One chunk at a time, to the service and back.
That is the honest difference from the other two lanes and the studio says it
beside the button rather than in a policy. It is not sealed in transit the way a
rented lane's output is — that seal exists because a rented box holds the
plaintext anyway, whereas here the whole point is that the gateway gets readable
bytes back so it can assemble, dissolve the seams, and re-finish without
re-rendering.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

DEFAULT_GATEWAY_URL = "https://hivemindos-restore-gateway.hivemindos.workers.dev"
GATEWAY_URL_ENV = "HIVEMINDOS_RESTORE_GATEWAY_URL"

# NOT optional, and not politeness. MEASURED against the deployed worker on
# 2026-09-01: Cloudflare answers 403 to the literal `Python-urllib/3.11` User-
# Agent urllib sends by default — in front of our OWN worker, before the request
# reaches any of its code. Without this header the hosted lane is permanently
# "could not be reached" in production and every other test passes.
# Matches src/hivemind_content_studio/hivemindos_models.py, which is the client
# that is already live and therefore already had to know this.
USER_AGENT = "HivemindContentStudio/1.0 (+https://hivemindos.com)"

# Polling. There are no callbacks — a step is the only completion signal — and a
# cold worker spends its first half-minute loading weights, so the first several
# polls are expected to say "queued".
POLL_INTERVAL_SECONDS = 4.0
# Long enough for a big chunk on a cold worker; the per-chunk timeout the
# service itself enforces is shorter, so this is the backstop rather than the
# limit that matters.
MAX_POLL_SECONDS = 3600.0

UPLOAD_TIMEOUT_SECONDS = 900.0
DOWNLOAD_TIMEOUT_SECONDS = 900.0


class CloudRestoreError(RuntimeError):
    """Something the owner can act on. Carries a remedy when one exists.

    The remedy matters more here than in most places: "payment required" with
    nothing to press is a dead end, and this is the one lane where running out
    of money is an ordinary, expected thing to happen halfway through.
    """

    def __init__(self, message: str, *, remedy: str = ""):
        super().__init__(message)
        self.remedy = remedy


def gateway_url() -> str:
    return (os.environ.get(GATEWAY_URL_ENV) or DEFAULT_GATEWAY_URL).strip().rstrip("/")


def _readable_error(status: int, detail: str) -> CloudRestoreError:
    if status == 402:
        return CloudRestoreError(
            detail or "Your HivemindOS credit balance will not cover the next chunk of this render.",
            remedy="top-up",
        )
    if status == 401:
        return CloudRestoreError(
            "Connect your HivemindOS account to restore on the hosted service.",
            remedy="connect",
        )
    if status == 503:
        return CloudRestoreError(
            detail or "Hosted restoration is not available right now — this computer or a rented machine can still run it.",
            remedy="retry",
        )
    return CloudRestoreError(detail or "The hosted restoration service refused that request.")


def _request(
    path: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    token: str = "",
    headers: dict[str, str] | None = None,
    timeout: float = 60.0,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    request_headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
    if token:
        request_headers["X-HivemindOS-Credit-Token"] = token
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        f"{gateway_url()}{path}", data=data, headers=request_headers, method=method)
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
        raise CloudRestoreError(
            "The hosted restoration service could not be reached.", remedy="retry") from None
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise CloudRestoreError(str((payload or {}).get("error") or "The hosted service refused that request."))
    return payload


def status(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """Whether the hosted lane is reachable and switched on. Never raises.

    Asked when the studio lists machines, so an unreachable service shows as one
    unavailable lane rather than taking the whole picker down.
    """
    try:
        payload = _request("/health", opener=opener, timeout=8.0)
    except CloudRestoreError:
        return {"available": False, "configured": False, "reason": "the hosted service could not be reached"}
    enabled = bool(payload.get("enabled"))
    configured = bool(payload.get("configured"))
    return {
        "available": enabled and configured,
        "configured": configured,
        "reason": "" if (enabled and configured) else (
            "hosted restoration is switched off on this deployment" if not enabled
            else "hosted restoration is not finished being set up"
        ),
    }


def quote(plan_request: dict[str, Any], *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    """What a whole render would cost, before a byte is uploaded.

    Unauthenticated on purpose: somebody deciding whether to use this at all
    should not have to have connected an account to find out what it costs.
    """
    payload = _request("/v1/quote", method="POST", body=plan_request, opener=opener, timeout=20.0)
    return dict(payload.get("quote") or {})


def upload_chunk(
    path: str | Path,
    *,
    token: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> str:
    """Stream one chunk of source footage up, and get an id back.

    Separate from the submit that spends money, and that is the point: an upload
    is the part that fails on a bad line halfway through forty megabytes, and a
    retry of it must not be able to place a second reservation.
    """
    source = Path(path)
    if not source.is_file():
        raise CloudRestoreError("the chunk to restore could not be read")
    size = source.stat().st_size
    with source.open("rb") as handle:
        request = urllib.request.Request(
            f"{gateway_url()}/v1/uploads",
            data=handle,
            method="POST",
            headers={
                "Content-Type": "video/mp4",
                "Content-Length": str(size),
                "X-HivemindOS-Credit-Token": token,
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with opener(request, timeout=UPLOAD_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8") or "{}").get("error") or ""
            except Exception:
                detail = ""
            raise _readable_error(exc.code, detail) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise CloudRestoreError(
                "The chunk could not be uploaded to the hosted service.", remedy="retry") from None
    upload_id = str((payload or {}).get("uploadId") or "").strip()
    if not upload_id:
        raise CloudRestoreError("the hosted service accepted the chunk but named no upload")
    return upload_id


def restore_chunk(
    *,
    source: str | Path,
    request_body: dict[str, Any],
    token: str,
    maximum_debit_usd: float,
    destination: str | Path,
    idempotency_key: str = "",
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Upload one chunk, restore it on the hosted service, and fetch it back.

    Returns ``{"file", "frames", "charged_usd"}``. Raises CloudRestoreError with
    a remedy on anything the owner can act on — running out of credits, most of
    all, which is an ordinary thing to happen in the middle of a long render and
    should read like a bill rather than a crash.

    `maximum_debit_usd` is what the STUDIO approved for this chunk. The service
    refuses rather than charges when its own price exceeds it, which is what
    makes the number the panel showed binding.
    """
    if not token:
        raise CloudRestoreError(
            "Connect your HivemindOS account to restore on the hosted service.", remedy="connect")
    approved = round(float(maximum_debit_usd), 6)
    if approved <= 0:
        raise ValueError("maximum_debit_usd must be greater than 0")

    upload_id = upload_chunk(source, token=token, opener=opener)
    # Derived per call rather than per chunk index: two deliberate renders of
    # the same chunk are two jobs, and the service treats one key as one
    # reservation.
    key = (idempotency_key or f"restore-{uuid.uuid4().hex}").strip()[:128]
    submitted = _request(
        "/v1/chunks",
        method="POST",
        token=token,
        timeout=120.0,
        opener=opener,
        headers={"Idempotency-Key": key},
        body={**request_body, "upload_id": upload_id, "maximum_debit_usd": approved, "idempotency_key": key},
    )
    chunk_id = str((submitted.get("chunk") or {}).get("id") or "").strip()
    if not chunk_id:
        raise CloudRestoreError("the hosted service accepted the chunk but named no job")

    deadline = monotonic() + MAX_POLL_SECONDS
    while monotonic() < deadline:
        if should_cancel is not None and should_cancel():
            _cancel(chunk_id, token=token, opener=opener)
            raise CloudRestoreError("stopped")
        payload = _request(
            f"/v1/chunks/{urllib.parse.quote(chunk_id)}/step",
            method="POST", token=token, timeout=60.0, opener=opener,
        )
        record = payload.get("chunk") or {}
        state = str(record.get("status") or "")
        if state == "complete":
            written = _download(chunk_id, destination, token=token, opener=opener)
            # Deleted as soon as we hold the bytes. The service sweeps what
            # nobody collected, but a clip that sat in a bucket because the
            # studio never said "got it" is footage kept for no reason.
            _forget(chunk_id, token=token, opener=opener)
            return {
                "file": str(written),
                "frames": int(record.get("frames") or 0),
                "charged_usd": float(record.get("chargedUsd") or 0.0),
            }
        if state == "failed":
            raise CloudRestoreError(
                f"{record.get('error') or 'the hosted service could not restore this chunk'} — nothing was charged.",
                remedy="retry",
            )
        sleeper(POLL_INTERVAL_SECONDS)
    raise CloudRestoreError(
        "This chunk is taking longer than the hosted service allows. Resume the render to try it again.",
        remedy="retry",
    )


def _download(
    chunk_id: str,
    destination: str | Path,
    *,
    token: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Path:
    """The restored chunk, streamed to disk rather than held in memory.

    A chunk is tens of megabytes and there are as many of them as the film is
    long; reading one into a bytes object would be the cheapest way to turn a
    long render into an out-of-memory kill an hour in.
    """
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        f"{gateway_url()}/v1/chunks/{urllib.parse.quote(chunk_id)}/output",
        headers={"X-HivemindOS-Credit-Token": token, "User-Agent": USER_AGENT},
        method="GET",
    )
    staged = target.with_name(target.name + ".part")
    try:
        with opener(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with staged.open("wb") as handle:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    handle.write(block)
    except urllib.error.HTTPError as exc:
        staged.unlink(missing_ok=True)
        raise _readable_error(exc.code, "") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        staged.unlink(missing_ok=True)
        raise CloudRestoreError(
            "The restored chunk could not be downloaded. Resume the render to fetch it again.",
            remedy="retry",
        ) from None
    if staged.stat().st_size < 512:
        staged.unlink(missing_ok=True)
        raise CloudRestoreError("the restored chunk arrived empty", remedy="retry")
    # Renamed only once it is whole, so a checkpoint can never point at a
    # half-downloaded chunk.
    staged.replace(target)
    return target


def _forget(chunk_id: str, *, token: str, opener: Callable[..., Any] = urllib.request.urlopen) -> None:
    try:
        _request(
            f"/v1/chunks/{urllib.parse.quote(chunk_id)}/output",
            method="DELETE", token=token, timeout=30.0, opener=opener,
        )
    except CloudRestoreError:
        # Housekeeping. Failing a finished, paid-for chunk because the tidy-up
        # call did not land would be the wrong trade every time.
        pass


def _cancel(chunk_id: str, *, token: str, opener: Callable[..., Any] = urllib.request.urlopen) -> None:
    try:
        _request(
            f"/v1/chunks/{urllib.parse.quote(chunk_id)}/cancel",
            method="POST", token=token, timeout=30.0, opener=opener,
        )
    except CloudRestoreError:
        # A cancel that does not land is not worth failing a stop over: the
        # chunk either finishes and settles normally, or times out and refunds.
        pass
