"""Zero-provider-key media generation through the local HivemindOS credit broker."""

from __future__ import annotations

import json
import os
import shlex
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .generation import _download


DEFAULT_HIVEMINDOS_URL = "http://127.0.0.1:5020"
HOSTED_MEDIA_PATH = "/api/hivemindos/media"
OFFICIAL_MARKUP_BPS = 2500
TERMINAL_FAILURES = {"failed", "error", "cancelled", "canceled"}


def hosted_media_status() -> dict[str, Any]:
    token = _dashboard_token()
    if not token:
        return {"configured": False, "reachable": False, "detail": "HIVEMINDOS_DASHBOARD_DEVICE_TOKEN is missing"}
    request = urllib.request.Request(_endpoint(), method="GET", headers=_headers(token))
    try:
        payload = _request_json(request, timeout=5, opener=urllib.request.urlopen)
    except RuntimeError:
        return {"configured": True, "reachable": False, "detail": "HivemindOS hosted media route did not answer"}
    return {
        "configured": True,
        "reachable": payload.get("ok") is True,
        "markup_bps": payload.get("markupBps"),
        "detail": "HivemindOS hosted media route answered" if payload.get("ok") is True else "HivemindOS hosted media route is not ready",
    }


def generate_hosted_media_asset(
    *,
    model: str,
    payload: dict[str, Any],
    output: str | Path,
    agent_id: str,
    maximum_debit_usd: float,
    idempotency_key: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    downloader: Callable[[str, Path], None] = _download,
    poll_interval_seconds: float = 5,
    max_polls: int = 180,
) -> dict[str, Any]:
    token = _dashboard_token()
    if not token:
        raise RuntimeError("Missing HIVEMINDOS_DASHBOARD_DEVICE_TOKEN for the local HivemindOS API")
    model_id = model.strip().lower()
    bounded_agent_id = agent_id.strip()
    bounded_key = idempotency_key.strip()
    maximum = round(float(maximum_debit_usd), 6)
    if not model_id or not bounded_agent_id or not bounded_key:
        raise ValueError("Hosted media requires model, agent_id, and idempotency_key")
    if maximum <= 0 or maximum > 25:
        raise ValueError("Hosted media maximum_debit_usd must be greater than 0 and no more than 25")
    if not isinstance(payload, dict) or not payload:
        raise ValueError("Hosted media payload must be a non-empty object")

    quote = _post(
        {"action": "quote", "model": model_id, "input": payload},
        token=token,
        opener=opener,
    ).get("quote")
    if not isinstance(quote, dict):
        raise RuntimeError("HivemindOS hosted media returned no quote")
    retail_usd = _number(quote.get("retailUsd"))
    if retail_usd <= 0:
        raise RuntimeError("HivemindOS hosted media returned an invalid retail quote")
    if int(_number(quote.get("markupBps"))) != OFFICIAL_MARKUP_BPS:
        raise RuntimeError("HivemindOS hosted media quote did not carry the official 25% markup")
    if retail_usd > maximum + 1e-9:
        raise ValueError(f"Hosted media quote ${retail_usd:.6f} exceeds the approved maximum ${maximum:.6f}")

    submitted = _post(
        {
            "action": "generate",
            "model": model_id,
            "input": payload,
            "agentId": bounded_agent_id,
            "maximumDebitUsd": maximum,
            "idempotencyKey": bounded_key,
        },
        token=token,
        opener=opener,
    )
    job = submitted.get("job")
    if not isinstance(job, dict) or not str(job.get("id") or "").strip():
        raise RuntimeError("HivemindOS hosted media returned no job id")
    job_id = str(job["id"]).strip()

    terminal = submitted
    for _ in range(max_polls):
        current = terminal.get("job") if isinstance(terminal.get("job"), dict) else {}
        status = str(current.get("status") or "").lower()
        if status == "finalized":
            break
        if status in TERMINAL_FAILURES:
            raise RuntimeError(f"HivemindOS hosted media job failed with status {status}")
        sleeper(max(0.1, poll_interval_seconds))
        terminal = _post(
            {"action": "job", "jobId": job_id, "agentId": bounded_agent_id},
            token=token,
            opener=opener,
        )
    else:
        raise TimeoutError("HivemindOS hosted media job did not finish before the poll limit")

    finished_job = terminal.get("job") if isinstance(terminal.get("job"), dict) else {}
    outputs = finished_job.get("outputs") if isinstance(finished_job.get("outputs"), list) else []
    source_url = next((str(value) for value in outputs if isinstance(value, str) and value.startswith("https://")), "")
    if not source_url:
        raise RuntimeError("HivemindOS hosted media job returned no public output URL")
    destination = Path(output).expanduser().resolve()
    downloader(source_url, destination)
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("HivemindOS hosted media download was empty")
    billing = finished_job.get("billing") if isinstance(finished_job.get("billing"), dict) else submitted.get("billing")
    return {
        "provider": "hivemindos-hosted-media",
        "model": model_id,
        "job_id": job_id,
        "output": str(destination),
        "source_url": source_url,
        "billing": billing if isinstance(billing, dict) else {},
    }


def _post(payload: dict[str, Any], *, token: str, opener: Callable[..., Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        _endpoint(),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={**_headers(token), "Content-Type": "application/json", "Accept": "application/json"},
    )
    return _request_json(request, timeout=120, opener=opener)


def _request_json(request: urllib.request.Request, *, timeout: int, opener: Callable[..., Any]) -> dict[str, Any]:
    try:
        with opener(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error")
        except (json.JSONDecodeError, AttributeError):
            detail = None
        raise RuntimeError(str(detail or f"HivemindOS hosted media returned HTTP {exc.code}")) from None
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError("HivemindOS hosted media request failed") from exc
    if not isinstance(value, dict):
        raise RuntimeError("HivemindOS hosted media returned an invalid JSON response")
    if value.get("ok") is not True:
        raise RuntimeError(str(value.get("error") or "HivemindOS hosted media request failed"))
    return value


def _endpoint() -> str:
    base = os.environ.get("HIVEMINDOS_URL", DEFAULT_HIVEMINDOS_URL).strip().rstrip("/")
    if not base.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        raise ValueError("HIVEMINDOS_URL must use local HTTP or HTTPS")
    return f"{base}{HOSTED_MEDIA_PATH}"


def _headers(token: str) -> dict[str, str]:
    return {"x-hivemindos-device-token": token}


def _dashboard_token() -> str:
    direct = os.environ.get("HIVEMINDOS_DASHBOARD_DEVICE_TOKEN", "").strip()
    if direct:
        return direct
    root = Path(__file__).resolve().parents[2]
    configured_root = os.environ.get("HIVEMINDOS_PROJECT_ROOT", "").strip()
    candidates = [
        Path(os.environ["HIVEMINDOS_ENV_FILE"]).expanduser() if os.environ.get("HIVEMINDOS_ENV_FILE") else None,
        Path(configured_root).expanduser() / ".env.local" if configured_root else None,
        root.parent / "hivemind-os" / ".env.local",
        Path.home() / ".hivemindos" / ".env",
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        value = _env_file_value(candidate, "HIVEMINDOS_DASHBOARD_DEVICE_TOKEN")
        if value:
            return value
    return ""


def _env_file_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    prefix = f"{key}="
    for line in lines:
        if not line.startswith(prefix):
            continue
        raw = line[len(prefix) :].strip()
        if not raw:
            return ""
        try:
            values = shlex.split(raw, comments=True, posix=True)
        except ValueError:
            return ""
        return values[0].strip() if len(values) == 1 else ""
    return ""


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number
