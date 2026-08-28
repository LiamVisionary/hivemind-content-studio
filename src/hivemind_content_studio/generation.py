"""Executable paid-media adapters with one shared side-effect gate."""

from __future__ import annotations

import base64
import json
import ipaddress
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, is_private_text_file, read_private_json


PAID_GENERATION_CONFIRMATION = "PAID_GENERATE"
ROOT = Path(__file__).resolve().parents[2]
MUAPI_HELPER = ROOT / "skills" / "shared" / "muapi-generative-media" / "scripts" / "muapi_general.py"
OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations"
XAI_API_BASE_URL = "https://api.x.ai/v1"
TERMINAL_XAI_VIDEO_FAILURES = {"failed", "expired", "cancelled", "canceled"}

# The two ways a provider proves who it is. Named, because the strings used to
# be spelled inline at both the call site and the check: image_router asked for
# "api" while the check accepted only "api-key", so every xAI API-key render
# failed on its own argument before reaching the network — and the provider
# advertised itself as ready the whole time. Import these instead of retyping.
AUTH_MODE_API_KEY = "api-key"
AUTH_MODE_OAUTH = "oauth"
AUTH_MODES = frozenset({AUTH_MODE_API_KEY, AUTH_MODE_OAUTH})

# What this studio calls itself when fetching a provider's finished media.
DOWNLOAD_USER_AGENT = "hivemind-content-studio/1.0"


def provider_credential(name: str) -> str:
    """One provider key, resolved the way every credential in this studio is.

    The shared hive env at ~/.hivemindos/.env is the fleet-wide default and the
    process environment overrides it, so a key set for the project wins and an
    unset one is inherited. `apply_shared_hive_env` only fills what is missing,
    which makes this safe to call on every read — and calling it here is what
    lets a bare CLI or MCP process (which never went through `load_config`)
    resolve the same credential the running API does.
    """
    from .shared_env import apply_shared_hive_env, request_credential

    apply_shared_hive_env()
    # Ask for this one key by name. The value is identical to reading the
    # environment, but the request is scoped and recorded — which is what lets a
    # broker later answer "no" without any call site here changing.
    scoped = request_credential(name, reason="provider credential")
    return scoped or os.environ.get(name, "").strip()


def record_generated_asset(manifest_path: str | Path, result: dict[str, Any], *, role: str, scene: int | None = None) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    output = Path(str(result.get("output") or "")).expanduser().resolve()
    if not output.is_file() or output.stat().st_size == 0:
        raise ValueError("Generated asset output is missing or empty")
    manifest = load_manifest(manifest_file)
    add_artifact(manifest, role=role, path=output, provider=str(result.get("provider") or "unknown"))
    artifact = manifest["artifacts"][-1]
    if scene is not None:
        artifact["scene"] = int(scene)
    if result.get("model"):
        artifact["model"] = str(result["model"])
    job_id = result.get("request_id") or result.get("job_id")
    if job_id:
        artifact["job_id"] = str(job_id)
    if result.get("source_url"):
        artifact["source_url"] = str(result["source_url"])
    write_manifest(manifest_file, manifest)
    if output.is_relative_to(manifest_file.parent):
        encrypt_private_media(output)
    return artifact


def require_paid_generation(confirm: str) -> None:
    if confirm != PAID_GENERATION_CONFIRMATION:
        raise ValueError(f"Paid generation requires confirm={PAID_GENERATION_CONFIRMATION}")


def _image_size(aspect_ratio: str) -> str:
    return {
        "9:16": "1024x1536",
        "4:5": "1024x1536",
        "1:1": "1024x1024",
        "16:9": "1536x1024",
    }.get(aspect_ratio, "1024x1024")


def _validate_openai_image_args(
    prompt: str,
    model: str,
    quality: str,
    *,
    allowed_models: set[str],
    allowed_qualities: set[str],
) -> str:
    bounded_prompt = prompt.strip()
    if not bounded_prompt or len(bounded_prompt) > 20_000:
        raise ValueError("OpenAI image prompt must contain 1 to 20,000 characters")
    if model not in allowed_models:
        raise ValueError("Unsupported GPT Image model")
    if quality not in allowed_qualities:
        raise ValueError(f"GPT Image quality must be {', '.join(sorted(allowed_qualities))}")
    return bounded_prompt


def _read_provider_json(
    request: urllib.request.Request,
    *,
    provider: str,
    opener: Callable[..., Any],
    timeout: int = 180,
) -> dict[str, Any]:
    try:
        with opener(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            error = payload.get("error")
            detail = error.get("message") if isinstance(error, dict) else error
        except (json.JSONDecodeError, AttributeError):
            detail = None
        raise RuntimeError(str(detail or f"{provider} returned HTTP {exc.code}")) from None
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{provider} request failed") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{provider} returned invalid JSON")
    return value


def _write_generated_image(payload: dict[str, Any], destination: Path, *, downloader: Callable[[str, Path], None]) -> str | None:
    candidates = payload.get("data") if isinstance(payload.get("data"), list) else []
    item = candidates[0] if candidates and isinstance(candidates[0], dict) else payload
    encoded = str(item.get("b64_json") or item.get("base64") or "").strip()
    source_url = str(item.get("url") or "").strip()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if encoded:
        try:
            destination.write_bytes(base64.b64decode(encoded, validate=True))
        except (ValueError, OSError) as exc:
            destination.unlink(missing_ok=True)
            raise RuntimeError("Generated image returned invalid base64 data") from exc
    elif source_url:
        downloader(source_url, destination)
    else:
        raise RuntimeError("Image provider returned no image data or URL")
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("Generated image output is empty")
    return source_url or None


# What the first bytes of a file say it really is. Callers name the destination
# before the provider has answered, so a provider that returns JPEG (xAI does)
# landed as "…png" and was then SERVED as image/png next to `nosniff` — which
# makes a browser refuse to render a perfectly good image.
_IMAGE_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
)


def correct_media_suffix(path: Path) -> Path:
    """Rename `path` to match the bytes in it, and give back where it landed."""
    try:
        header = path.open("rb").read(12)
    except OSError:
        return path
    suffix = next((value for magic, value in _IMAGE_MAGIC if header.startswith(magic)), "")
    if header[4:12].startswith(b"ftyp"):
        suffix = ".mp4"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        suffix = ".webp"
    if not suffix or path.suffix.lower() in {suffix, ".jpeg" if suffix == ".jpg" else suffix}:
        return path
    corrected = path.with_suffix(suffix)
    if corrected != path:
        corrected.unlink(missing_ok=True)
        path.rename(corrected)
    return corrected


def generate_openai_image_asset(
    *,
    prompt: str,
    model: str = "gpt-image-2",
    aspect_ratio: str = "1:1",
    output: str | Path,
    confirm: str,
    quality: str = "medium",
    opener: Callable[..., Any] = urllib.request.urlopen,
    downloader: Callable[[str, Path], None] | None = None,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    api_key = provider_credential("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not set — add it with `passbook add OPENAI_API_KEY`. "
            "ChatGPT/Codex OAuth is a separate credential; pick the GPT Image OAuth provider to use it"
        )
    bounded_prompt = _validate_openai_image_args(
        prompt,
        model,
        quality,
        allowed_models={"gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"},
        allowed_qualities={"low", "medium", "high", "auto"},
    )
    request = urllib.request.Request(
        OPENAI_IMAGE_URL,
        data=json.dumps(
            {
                "model": model,
                "prompt": bounded_prompt,
                "size": _image_size(aspect_ratio),
                "quality": quality,
                "output_format": "png",
                "n": 1,
            }
        ).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    payload = _read_provider_json(request, provider="OpenAI GPT Image", opener=opener)
    destination = Path(output).expanduser().resolve()
    source_url = _write_generated_image(payload, destination, downloader=downloader or _download)
    destination = correct_media_suffix(destination)
    return {
        "provider": "openai-gpt-image",
        "model": model,
        "output": str(destination),
        "source_url": source_url,
        "usage": payload.get("usage") if isinstance(payload.get("usage"), dict) else {},
    }


def generate_openai_oauth_image_asset(
    *,
    prompt: str,
    model: str = "gpt-image-2",
    aspect_ratio: str = "1:1",
    output: str | Path,
    confirm: str,
    quality: str = "medium",
    downloader: Callable[[str, Path], None] | None = None,
    oauth_request: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    bounded_prompt = _validate_openai_image_args(
        prompt,
        model,
        quality,
        allowed_models={"gpt-image-2"},
        allowed_qualities={"low", "medium", "high"},
    )
    if oauth_request is None:
        from .hivemindos_oauth import openai_oauth_media_request

        oauth_request = openai_oauth_media_request
    payload = oauth_request(
        {
            "action": "image-generate",
            "model": model,
            "prompt": bounded_prompt,
            "aspectRatio": aspect_ratio,
            "quality": quality,
        }
    )
    destination = Path(output).expanduser().resolve()
    source_url = _write_generated_image(payload, destination, downloader=downloader or _download)
    destination = correct_media_suffix(destination)
    return {
        "provider": "openai-gpt-image-oauth",
        "model": model,
        "output": str(destination),
        "source_url": source_url,
        "usage": payload.get("usage") if isinstance(payload.get("usage"), dict) else {},
    }


def _inline_image(path: str | Path) -> str:
    source = Path(path).expanduser().resolve()
    maximum = int(os.environ.get("CONTENT_STUDIO_MAX_INLINE_IMAGE_BYTES", str(10 * 1024 * 1024)))
    if not source.is_file() or source.stat().st_size <= 0 or source.stat().st_size > maximum:
        raise ValueError(f"xAI source image must be a non-empty local file no larger than {maximum} bytes")
    suffix = source.suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(suffix)
    if not mime:
        raise ValueError("xAI source image must be PNG, JPEG, or WebP")
    return f"data:{mime};base64,{base64.b64encode(source.read_bytes()).decode('ascii')}"


def generate_xai_imagine_asset(
    *,
    kind: str,
    auth_mode: str,
    prompt: str,
    aspect_ratio: str,
    output: str | Path,
    confirm: str,
    model: str | None = None,
    source: str | Path | None = None,
    duration_seconds: float | None = None,
    resolution: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    downloader: Callable[[str, Path], None] | None = None,
    oauth_request: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    poll_interval_seconds: float = 5,
    max_polls: int = 180,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    if kind not in {"keyframe", "motion"}:
        raise ValueError("xAI Imagine kind must be keyframe or motion")
    if auth_mode not in AUTH_MODES:
        raise ValueError(f"xAI Imagine auth mode must be one of {', '.join(sorted(AUTH_MODES))}")
    bounded_prompt = prompt.strip()
    if not bounded_prompt or len(bounded_prompt) > 20_000:
        raise ValueError("xAI Imagine prompt must contain 1 to 20,000 characters")
    selected_model = model or ("grok-imagine-image-quality" if kind == "keyframe" else "grok-imagine-video")
    action = "image-generate" if kind == "keyframe" else "video-generate"
    body: dict[str, Any] = {
        "action": action,
        "model": selected_model,
        "prompt": bounded_prompt,
        "aspectRatio": aspect_ratio,
        "resolution": resolution or ("1k" if kind == "keyframe" else "720p"),
    }
    if kind == "motion":
        body["duration"] = min(15, max(1, round(float(duration_seconds or 5))))
        if source is not None:
            body["image"] = {"url": _inline_image(source)}

    def request_xai(value: dict[str, Any]) -> dict[str, Any]:
        if auth_mode == AUTH_MODE_OAUTH:
            if oauth_request is None:
                from .hivemindos_oauth import xai_oauth_media_request

                return xai_oauth_media_request(value)
            return oauth_request(value)
        api_key = provider_credential("XAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "XAI_API_KEY is not set — add it with `passbook add XAI_API_KEY` "
                "or connect xAI over OAuth and pick the xAI Imagine OAuth provider instead"
            )
        path = (
            f"/videos/{urllib.parse.quote(str(value['requestId']))}"
            if value["action"] == "video-status"
            else "/images/generations"
            if value["action"] == "image-generate"
            else "/videos/generations"
        )
        outbound = {"model": value.get("model"), "prompt": value.get("prompt"), "aspect_ratio": value.get("aspectRatio"), "resolution": value.get("resolution")}
        if value["action"] == "video-generate":
            outbound.update({"duration": value.get("duration"), **({"image": value["image"]} if value.get("image") else {})})
        request = urllib.request.Request(
            f"{XAI_API_BASE_URL}{path}",
            data=None if value["action"] == "video-status" else json.dumps(outbound).encode("utf-8"),
            method="GET" if value["action"] == "video-status" else "POST",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        return _read_provider_json(request, provider="xAI Imagine", opener=opener)

    payload = request_xai(body)
    destination = Path(output).expanduser().resolve()
    provider_id = "xai-imagine-oauth" if auth_mode == "oauth" else "xai-imagine-api"
    if kind == "keyframe":
        source_url = _write_generated_image(payload, destination, downloader=downloader or _download)
        destination = correct_media_suffix(destination)
        return {"provider": provider_id, "model": selected_model, "output": str(destination), "source_url": source_url, "usage": payload.get("usage") or {}}

    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise RuntimeError("xAI Imagine video generation returned no request id")
    result = payload
    for _ in range(max_polls):
        status = str(result.get("status") or "").lower()
        if status == "done":
            break
        if status in TERMINAL_XAI_VIDEO_FAILURES:
            raise RuntimeError(f"xAI Imagine video generation failed with status {status}")
        sleeper(max(0.1, poll_interval_seconds))
        result = request_xai({"action": "video-status", "requestId": request_id})
    else:
        raise TimeoutError("xAI Imagine video generation did not finish before the poll limit")
    video = result.get("video") if isinstance(result.get("video"), dict) else {}
    source_url = str(video.get("url") or "").strip()
    if not source_url:
        raise RuntimeError("xAI Imagine video generation returned no output URL")
    (downloader or _download)(source_url, destination)
    return {"provider": provider_id, "model": selected_model, "request_id": request_id, "output": str(destination), "source_url": source_url, "usage": result.get("usage") or {}}


def build_higgsfield_consumer_command(
    *,
    kind: str,
    model: str,
    prompt: str,
    aspect_ratio: str,
    source: str | Path | None = None,
    duration_seconds: float | None = None,
) -> list[str]:
    if kind not in {"keyframe", "motion"}:
        raise ValueError("Higgsfield kind must be keyframe or motion")
    command = [
        "higgsfield",
        "generate",
        "create",
        model,
        "--prompt",
        prompt,
        "--aspect_ratio",
        aspect_ratio,
    ]
    if kind == "motion":
        if source is None:
            raise ValueError("Higgsfield motion requires a start image")
        command.extend(["--start-image", str(Path(source).expanduser().resolve())])
        if duration_seconds is not None:
            duration = max(1, round(float(duration_seconds)))
            command.extend(["--duration", str(duration)])
    command.extend(["--wait", "--json"])
    return command


def build_muapi_submit_command(*, endpoint: str, payload: str | Path, output: str | Path, state: str | Path) -> list[str]:
    return [
        sys.executable,
        str(MUAPI_HELPER),
        "--state",
        str(Path(state).expanduser().resolve()),
        "submit",
        "--endpoint",
        endpoint,
        "--payload",
        str(Path(payload).expanduser().resolve()),
        "--wait",
        "--download",
        str(Path(output).expanduser().resolve()),
    ]


def _urls(value: Any) -> list[str]:
    found: list[str] = []
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        found.append(value)
    elif isinstance(value, list):
        for item in value:
            found.extend(_urls(item))
    elif isinstance(value, dict):
        for item in value.values():
            found.extend(_urls(item))
    return list(dict.fromkeys(found))


def _download(url: str, destination: Path) -> None:
    _validate_download_url(url)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Identify the client. urllib's default "Python-urllib/3.x" is filtered at
    # the edge by at least one provider's media CDN (xAI's imgen.x.ai answers
    # 403 to it and 200 to any ordinary agent string), which surfaced as
    # "Generated media download failed" AFTER the image had been generated and
    # paid for. Naming ourselves is both the fix and the courteous thing to do.
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": DOWNLOAD_USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=300) as response, destination.open("wb") as output:
            _validate_download_url(response.geturl())
            declared = int(response.headers.get("Content-Length") or 0)
            maximum = int(os.environ.get("CONTENT_STUDIO_MAX_GENERATION_BYTES", str(500 * 1024 * 1024)))
            if declared > maximum:
                raise ValueError(f"Generated media exceeds the maximum size of {maximum} bytes")
            content_type = str(response.headers.get_content_type() or "application/octet-stream").lower()
            if not content_type.startswith(("image/", "video/", "audio/")) and content_type != "application/octet-stream":
                raise ValueError(f"Generated media returned an unexpected content type: {content_type}")
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > maximum:
                    raise ValueError(f"Generated media exceeds the maximum size of {maximum} bytes")
                output.write(chunk)
    except ValueError:
        destination.unlink(missing_ok=True)
        raise
    except (OSError, urllib.error.URLError) as exc:
        destination.unlink(missing_ok=True)
        raise RuntimeError("Generated media download failed") from exc
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("Generated media download was empty")


def _validate_download_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    allow_private = os.environ.get("CONTENT_STUDIO_ALLOW_PRIVATE_GENERATION_DOWNLOADS", "").strip().lower() in {"1", "true", "yes", "on"}
    if not parsed.hostname or parsed.scheme not in ({"http", "https"} if allow_private else {"https"}):
        raise ValueError("Generated media must use a public HTTPS URL")
    if allow_private:
        return
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)}
    except socket.gaierror as exc:
        raise ValueError("Generated media host could not be resolved") from exc
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("Generated media must use a public HTTPS host")


def generate_higgsfield_consumer_asset(
    *,
    kind: str,
    model: str,
    prompt: str,
    aspect_ratio: str,
    output: str | Path,
    confirm: str,
    source: str | Path | None = None,
    duration_seconds: float | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    command = build_higgsfield_consumer_command(
        kind=kind,
        model=model,
        prompt=prompt,
        aspect_ratio=aspect_ratio,
        source=source,
        duration_seconds=duration_seconds,
    )
    completed = runner(command, text=True, capture_output=True, timeout=1800, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Higgsfield consumer generation failed with exit code {completed.returncode}; verify the CLI session")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Higgsfield consumer generation returned non-JSON output") from exc
    urls = _urls(response)
    if not urls:
        raise RuntimeError("Higgsfield consumer generation returned no media URL")
    destination = Path(output).expanduser().resolve()
    _download(urls[0], destination)
    return {"provider": "higgsfield-consumer", "model": model, "output": str(destination), "source_url": urls[0]}


def generate_muapi_asset(
    *,
    endpoint: str,
    payload: str | Path,
    output: str | Path,
    state: str | Path,
    confirm: str,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    if not MUAPI_HELPER.is_file():
        raise RuntimeError("Bundled MUAPI helper is missing; sync shared skills")
    destination = Path(output).expanduser().resolve()
    payload_path = Path(payload).expanduser().resolve()
    staged_payload: Path | None = None
    if is_private_text_file(payload_path):
        # The MUAPI helper is an external process; stage a plaintext copy and
        # remove it as soon as the submission finishes.
        staged_payload = payload_path.with_name(f".{payload_path.stem}-staged-{os.getpid()}.json")
        staged_payload.write_text(json.dumps(read_private_json(payload_path)) + "\n", encoding="utf-8")
    command = build_muapi_submit_command(
        endpoint=endpoint, payload=staged_payload or payload_path, output=destination, state=state
    )
    try:
        completed = runner(command, text=True, capture_output=True, timeout=1800, check=False)
    finally:
        if staged_payload is not None:
            staged_payload.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(f"MUAPI generation failed with exit code {completed.returncode}; verify endpoint schema and credentials")
    if not destination.is_file() or destination.stat().st_size == 0:
        raise RuntimeError("MUAPI generation completed without a downloaded output")
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError:
        response = {}
    return {
        "provider": "muapi",
        "endpoint": endpoint,
        "request_id": response.get("request_id"),
        "output": str(destination),
    }


def _request_json(request: urllib.request.Request, *, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Higgsfield Cloud request failed with HTTP {exc.code}") from None
    try:
        value = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Higgsfield Cloud returned non-JSON output") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Higgsfield Cloud returned an unexpected response")
    return value


def generate_higgsfield_cloud_asset(
    *,
    model_id: str,
    payload: str | Path,
    output: str | Path,
    confirm: str,
    poll_interval_seconds: float = 5,
    max_polls: int = 180,
) -> dict[str, Any]:
    require_paid_generation(confirm)
    key_id = os.environ.get("HIGGSFIELD_API_KEY_ID", "").strip()
    key_secret = os.environ.get("HIGGSFIELD_API_KEY_SECRET", "").strip()
    if not key_id or not key_secret:
        raise RuntimeError("HIGGSFIELD_API_KEY_ID and HIGGSFIELD_API_KEY_SECRET are required")
    payload_path = Path(payload).expanduser().resolve()
    data = read_private_json(payload_path)
    if not isinstance(data, dict):
        raise ValueError("Higgsfield Cloud payload must be a JSON object")
    base_url = os.environ.get("HIGGSFIELD_CLOUD_BASE_URL", "https://platform.higgsfield.ai").rstrip("/")
    headers = {
        "Authorization": f"Key {key_id}:{key_secret}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    submit = urllib.request.Request(
        f"{base_url}/{model_id.strip().lstrip('/')}",
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    submitted = _request_json(submit, timeout=180)
    request_id = str(submitted.get("request_id") or submitted.get("id") or "").strip()
    if not request_id:
        raise RuntimeError("Higgsfield Cloud returned no request id")
    result = submitted
    media_urls = _urls(result)
    for _ in range(max_polls):
        if media_urls:
            break
        time.sleep(max(0.01, poll_interval_seconds))
        status_request = urllib.request.Request(
            f"{base_url}/requests/{request_id}/status",
            headers={"Authorization": f"Key {key_id}:{key_secret}", "Accept": "application/json"},
            method="GET",
        )
        result = _request_json(status_request, timeout=90)
        status = str(result.get("status") or result.get("state") or "").lower()
        if status in {"failed", "error", "cancelled", "canceled"}:
            raise RuntimeError("Higgsfield Cloud reported a failed generation")
        media_urls = _urls(result)
    if not media_urls:
        raise TimeoutError("Higgsfield Cloud did not return media before the poll limit")
    destination = Path(output).expanduser().resolve()
    _download(media_urls[0], destination)
    return {
        "provider": "higgsfield-cloud",
        "model": model_id,
        "request_id": request_id,
        "output": str(destination),
        "source_url": media_urls[0],
    }
