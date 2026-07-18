"""Adapter for HivemindOS's configured Media Studio image-to-video MCP."""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlparse, urlunparse

from PIL import Image

from .config import load_config
from .mcp_http import PROTOCOL_VERSION, McpHttpClient
from .publishing import encode_multipart
from .qa import qa_video


@dataclass(frozen=True)
class MediaStudioDescriptor:
    app_id: str
    app_name: str
    mcp_url: str
    upload_base: str
    auth_env_key: str | None
    tool: str
    job_tool: str
    workflow_id: str | None


def discover_media_studio() -> MediaStudioDescriptor | None:
    direct_url = os.environ.get("MEDIA_STUDIO_MCP_URL", "").strip()
    direct_upload = os.environ.get("MEDIA_STUDIO_UPLOAD_BASE", "").strip() or _local_upload_base()
    if direct_url:
        return MediaStudioDescriptor(
            app_id="env:media-studio",
            app_name="Media Studio",
            mcp_url=_http_url(direct_url, "MEDIA_STUDIO_MCP_URL"),
            upload_base=_http_url(direct_upload, "MEDIA_STUDIO_UPLOAD_BASE").rstrip("/"),
            auth_env_key=os.environ.get("MEDIA_STUDIO_AUTH_ENV_KEY", "MEDIA_STUDIO_TOKEN").strip() or None,
            tool=os.environ.get("MEDIA_STUDIO_VIDEO_TOOL", "media_generate_video").strip(),
            job_tool=os.environ.get("MEDIA_STUDIO_JOB_TOOL", "media_get_job").strip(),
            workflow_id=os.environ.get("MEDIA_STUDIO_WORKFLOW_ID", "").strip() or None,
        )

    preferences = Path(os.environ.get("HIVEMINDOS_APP_PREFERENCES", Path.home() / ".hivemindos" / "app-preferences.json")).expanduser()
    try:
        data = json.loads(preferences.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _local_managed_descriptor()
    for preference in data.get("preferences", []):
        if not isinstance(preference, dict):
            continue
        mcp = preference.get("mcpVideo")
        if not isinstance(mcp, dict) or not mcp.get("url") or not mcp.get("uploadBase"):
            continue
        name = str(preference.get("appName") or "")
        capabilities = {str(value).lower() for value in preference.get("capabilities", [])}
        if "media studio" not in name.lower() and not ({"video", "image-to-video"} & capabilities):
            continue
        return MediaStudioDescriptor(
            app_id=str(preference.get("appId") or "media-studio"),
            app_name=name or "Media Studio",
            mcp_url=_http_url(str(mcp["url"]), "mcpVideo.url"),
            upload_base=_http_url(str(mcp["uploadBase"]), "mcpVideo.uploadBase").rstrip("/"),
            auth_env_key=str(mcp.get("authEnvKey") or "").strip() or None,
            tool=str(mcp.get("tool") or "media_generate_video").strip(),
            job_tool=str(mcp.get("jobTool") or "media_get_job").strip(),
            workflow_id=str(mcp.get("workflowId") or "").strip() or None,
        )
    return _local_managed_descriptor()


def media_studio_status() -> dict[str, Any]:
    descriptor = discover_media_studio()
    if not descriptor:
        return {"configured": False, "auth_present": False, "reachable": False, "detail": "No Media Studio mcpVideo preference or environment override was found."}
    token = _token(descriptor)
    reachable = _reachable(descriptor.mcp_url, token)
    return {
        "configured": True,
        "auth_present": not descriptor.auth_env_key or bool(token),
        "reachable": reachable,
        "app_name": descriptor.app_name,
        "tool": descriptor.tool,
        "job_tool": descriptor.job_tool,
        "workflow_configured": bool(descriptor.workflow_id),
        "detail": "Media Studio MCP is reachable." if reachable else "Media Studio is configured but its MCP endpoint did not answer.",
    }


def list_media_studio_tools() -> list[dict[str, Any]]:
    descriptor = _required_descriptor()
    return _client(descriptor).list_tools()


def list_media_studio_workflows(media_type: str = "video") -> list[dict[str, Any]]:
    descriptor = _required_descriptor()
    payload = _result_json(_client(descriptor).call_tool("media_list_workflows", {"media_type": media_type}))
    workflows = payload.get("workflows", [])
    return [item for item in workflows if isinstance(item, dict)]


def generate_video(
    *,
    image_path: str | Path | None = None,
    video_path: str | Path | None = None,
    video_mode: str = "extend",
    prompt: str,
    duration_seconds: float = 4,
    workflow_id: str | None = None,
    output_dir: str | Path | None = None,
    poll_interval_seconds: float = 6,
    max_polls: int = 90,
) -> dict[str, Any]:
    descriptor = _required_descriptor()
    video = Path(video_path).expanduser().resolve() if video_path else None
    image = Path(image_path).expanduser().resolve() if image_path else None
    if video is not None and not video.is_file():
        raise FileNotFoundError(f"Input video not found: {video}")
    if video is None and (image is None or not image.is_file()):
        raise FileNotFoundError(f"Input image not found: {image}")
    if video is not None and video_mode != "extend":
        raise ValueError("video_mode must be extend")
    uploaded_name = _upload_video(descriptor, video) if video is not None else _upload_image(descriptor, image)
    try:
        duration = max(1 / 24, min(30.0, float(duration_seconds)))
        frame_rate = 24
        frames = max(9, min(721, round(duration * frame_rate) + 1))
        client = _client(descriptor)
        arguments: dict[str, Any] = {
            **({"workflow_id": workflow_id or descriptor.workflow_id} if workflow_id or descriptor.workflow_id else {}),
            **({"video_path": uploaded_name, "video_mode": video_mode} if video is not None else {"image_path": uploaded_name}),
            "frames": frames,
            "frame_rate": frame_rate,
            "duration_seconds": duration,
            "wait": False,
            "include_urls": True,
        }
        if image is not None:
            width, height = _video_dimensions(image)
            arguments.update({"width": width, "height": height})
        if prompt.strip():
            arguments["prompt"] = prompt.strip()
        queued = _result_json(
            client.call_tool(
                descriptor.tool,
                arguments,
            )
        )
        job_id = _job_id(queued)
        if not job_id:
            raise RuntimeError("Media Studio did not return a job id")
        payload = queued
        video_url = _first_video_url(payload)
        status = _generation_status(payload)
        if not video_url and re.search(r"\b(success|succeeded|complete|completed)\b", status):
            video_url = _private_video_url(descriptor, job_id)
        for _ in range(max_polls):
            if video_url:
                break
            time.sleep(max(0.1, poll_interval_seconds))
            payload = _result_json(client.call_tool(descriptor.job_tool, {"id": job_id, "include_urls": True}))
            video_url = _first_video_url(payload)
            status = _generation_status(payload)
            if re.search(r"\b(error|failed|cancelled|canceled)\b", status):
                raise RuntimeError(_generation_error(payload) or "Media Studio reported a failed generation")
            if not video_url and re.search(r"\b(success|succeeded|complete|completed)\b", status):
                video_url = _private_video_url(descriptor, job_id)
        if not video_url:
            raise TimeoutError("Media Studio did not return a finished video before the poll limit")

        reachable_url = _rewrite_local_url(video_url, descriptor.upload_base)
        destination_root = Path(output_dir).expanduser().resolve() if output_dir else load_config().data_dir / "generated" / "media-studio"
        destination_root.mkdir(parents=True, exist_ok=True)
        destination = destination_root / f"media-studio-{job_id}-{int(time.time())}.mp4"
        local_token = _token(descriptor) if _same_origin(reachable_url, descriptor.upload_base) else ""
        _download(reachable_url, destination, token=local_token)
        qa = qa_video(destination, output_dir=destination_root / "qa", require_audio=False)
        qa = _remove_qa_frame(qa, destination_root)
        if not qa["ok"]:
            raise RuntimeError("Media Studio output failed technical QA: " + "; ".join(qa["failures"]))
        return {"job_id": job_id, "output": str(destination), "qa": qa, "provider": descriptor.app_name}
    finally:
        with contextlib.suppress(Exception):
            _delete_uploaded_image(descriptor, uploaded_name)


def _remove_qa_frame(qa: dict[str, Any], destination_root: Path) -> dict[str, Any]:
    sanitized = dict(qa)
    raw = sanitized.get("representative_frame")
    if raw:
        frame = Path(str(raw)).expanduser().resolve()
        qa_root = (destination_root / "qa").resolve()
        if frame.is_relative_to(qa_root):
            with contextlib.suppress(FileNotFoundError):
                frame.unlink()
            with contextlib.suppress(OSError):
                frame.parent.rmdir()
    sanitized["representative_frame"] = None
    return sanitized


def _delete_uploaded_image(descriptor: MediaStudioDescriptor, name: str) -> None:
    body = json.dumps({"filename": Path(name).name}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = _token(descriptor)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{descriptor.upload_base}/api/delete-input",
        data=body,
        method="POST",
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status >= 400:
            raise RuntimeError(f"Media Studio private input cleanup failed with HTTP {response.status}")


def _client(descriptor: MediaStudioDescriptor) -> McpHttpClient:
    token = _token(descriptor)
    if descriptor.auth_env_key and not token:
        raise RuntimeError(f"Missing {descriptor.auth_env_key} for Media Studio")
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return McpHttpClient(descriptor.mcp_url, headers=headers)


def _required_descriptor() -> MediaStudioDescriptor:
    descriptor = discover_media_studio()
    if not descriptor:
        raise RuntimeError("Media Studio is not configured in HivemindOS app preferences or environment")
    return descriptor


def _token(descriptor: MediaStudioDescriptor) -> str:
    if not descriptor.auth_env_key:
        return ""
    direct = os.environ.get(descriptor.auth_env_key, "").strip()
    if direct:
        return direct
    if descriptor.auth_env_key in {"MEDIA_STUDIO_TOKEN", "ZIMG_TOKEN"}:
        for path in _token_paths():
            try:
                value = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if value:
                return value
    return ""


def _reachable(url: str, token: str) -> bool:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if token:
        headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
        })
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "hivemind-content-studio", "version": "0.1.0"},
            },
        }).encode("utf-8")
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    else:
        request = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500 and exc.code not in {401, 403}
    except OSError:
        return False


def _upload_image(descriptor: MediaStudioDescriptor, image: Path) -> str:
    return _upload_input(descriptor, image, "image")


def _upload_video(descriptor: MediaStudioDescriptor, video: Path) -> str:
    return _upload_input(descriptor, video, "video")


def _upload_input(descriptor: MediaStudioDescriptor, media: Path, label: str) -> str:
    token = _token(descriptor)
    body, content_type = encode_multipart([("overwrite", "true")], [("image", media)])
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{descriptor.upload_base}/upload/image", data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media Studio {label} upload failed with HTTP {exc.code}") from None
    name = str(payload.get("name") or "").strip()
    if not name:
        raise RuntimeError(f"Media Studio {label} upload returned no input filename")
    return name


def _video_dimensions(image: Path) -> tuple[int, int]:
    with Image.open(image) as opened:
        width, height = opened.size
    clamp = lambda value: max(384, min(1024, round(value / 32) * 32))
    return clamp(width), clamp(height)


def _result_json(result: dict[str, Any]) -> dict[str, Any]:
    for part in result.get("content", []):
        if part.get("type") != "text":
            continue
        try:
            parsed = json.loads(part.get("text") or "")
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    structured = result.get("structuredContent")
    return structured if isinstance(structured, dict) else result


def _job_id(payload: dict[str, Any]) -> str:
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    submission = payload.get("submission") if isinstance(payload.get("submission"), dict) else {}
    for value in (job.get("id"), payload.get("id"), payload.get("job_id"), payload.get("jobId"), submission.get("prompt_id"), payload.get("prompt_id")):
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
    return ""


def _generation_status(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    for source in (payload, job):
        value = source.get("status") or source.get("state")
        if value:
            return str(value).lower()
    return ""


def _generation_error(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    job = payload.get("job") if isinstance(payload.get("job"), dict) else {}
    for source in (payload, job):
        value = source.get("error") or source.get("detail") or source.get("message")
        if value:
            return str(value)
    return ""


def _first_video_url(payload: Any) -> str:
    match = re.search(r"https?://[^\"'\s]+\.(?:mp4|m4v|mov|webm)(?:\?[^\"'\s]*)?", json.dumps(payload), re.IGNORECASE)
    return match.group(0) if match else ""


def _private_video_url(descriptor: MediaStudioDescriptor, job_id: str) -> str:
    """Resolve output only inside the trusted server process, never through MCP receipts."""
    job = _private_json(descriptor, f"/api/job/{quote(job_id, safe='')}")
    reference = _first_video_reference(job)
    if reference:
        return urljoin(descriptor.upload_base.rstrip("/") + "/", reference)

    history = _private_json(descriptor, f"/comfy/api/history/{quote(job_id, safe='')}")
    record = history.get(job_id) if isinstance(history.get(job_id), dict) else next(
        (value for value in history.values() if isinstance(value, dict)),
        {},
    )
    for item in _comfy_output_items(record):
        filename = str(item.get("filename") or "").strip()
        if not _is_video_reference(filename):
            continue
        query = urlencode({
            "filename": filename,
            "subfolder": str(item.get("subfolder") or ""),
            "type": str(item.get("type") or "output"),
        })
        return f"{descriptor.upload_base.rstrip('/')}/comfy/view?{query}"
    return ""


def _private_json(descriptor: MediaStudioDescriptor, path: str) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    token = _token(descriptor)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        urljoin(descriptor.upload_base.rstrip("/") + "/", path.lstrip("/")),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {}
        raise RuntimeError(f"Media Studio private output lookup failed with HTTP {exc.code}") from None
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Media Studio private output lookup failed") from exc
    return payload if isinstance(payload, dict) else {}


def _first_video_reference(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("video_urls", "media_urls", "image_urls", "output_urls"):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if isinstance(value, str) and _is_video_reference(value):
                return value
    for key in ("video_url", "media_url", "output_url", "url"):
        value = payload.get(key)
        if isinstance(value, str) and _is_video_reference(value):
            return value
    return ""


def _comfy_output_items(value: object):
    if isinstance(value, dict):
        if value.get("filename"):
            yield value
        for child in value.values():
            yield from _comfy_output_items(child)
    elif isinstance(value, list):
        for child in value:
            yield from _comfy_output_items(child)


def _is_video_reference(value: str) -> bool:
    return Path(urlparse(value).path).suffix.lower() in {".mp4", ".m4v", ".mov", ".webm"}


def _rewrite_local_url(url: str, upload_base: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
        return url
    base = urlparse(upload_base)
    return urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _same_origin(left: str, right: str) -> bool:
    first = urlparse(left)
    second = urlparse(right)
    return first.scheme == second.scheme and first.netloc == second.netloc


def _download(url: str, destination: Path, *, token: str = "") -> None:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media Studio output download failed with HTTP {exc.code}") from None
    if not data:
        raise RuntimeError("Media Studio output download was empty")
    destination.write_bytes(data)


def _http_url(value: str, label: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{label} must be an HTTP(S) URL")
    return value.strip()


def _local_managed_descriptor() -> MediaStudioDescriptor:
    port = os.environ.get("MEDIA_STUDIO_MCP_PORT", "8796").strip() or "8796"
    return MediaStudioDescriptor(
        app_id="managed:media-studio-mcp",
        app_name="Managed Media Studio MCP",
        mcp_url=_http_url(f"http://127.0.0.1:{port}/mcp", "MEDIA_STUDIO_MCP_PORT"),
        upload_base=_http_url(_local_upload_base(), "MEDIA_STUDIO_UPLOAD_BASE").rstrip("/"),
        auth_env_key=os.environ.get("MEDIA_STUDIO_AUTH_ENV_KEY", "ZIMG_TOKEN").strip() or None,
        tool=os.environ.get("MEDIA_STUDIO_VIDEO_TOOL", "media_generate_video").strip(),
        job_tool=os.environ.get("MEDIA_STUDIO_JOB_TOOL", "media_get_job").strip(),
        workflow_id=os.environ.get("MEDIA_STUDIO_WORKFLOW_ID", "").strip() or None,
    )


def _local_upload_base() -> str:
    return (
        os.environ.get("MEDIA_STUDIO_UPLOAD_BASE")
        or os.environ.get("MEDIA_STUDIO_MCP_STUDIO_URL")
        or os.environ.get("MEDIA_STUDIO_STUDIO_URL")
        or os.environ.get("ZIMG_STUDIO_URL")
        or "http://127.0.0.1:8788"
    ).strip()


def _token_paths() -> list[Path]:
    media_state = Path(os.environ.get("HIVEMIND_MEDIA_STATE_DIR", Path.home() / ".hivemindos" / "media-studio")).expanduser()
    candidates = [
        os.environ.get("MEDIA_STUDIO_TOKEN_FILE", ""),
        os.environ.get("ZIMG_TOKEN_FILE", ""),
        str(media_state / "secure" / "zimg-token"),
    ]
    return [Path(value).expanduser() for value in candidates if value.strip()]
