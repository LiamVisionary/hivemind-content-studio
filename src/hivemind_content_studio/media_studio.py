"""Adapter for HivemindOS's configured Media Studio image-to-video MCP."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from PIL import Image

from .config import load_config
from .mcp_http import McpHttpClient
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
    direct_upload = os.environ.get("MEDIA_STUDIO_UPLOAD_BASE", "").strip()
    if direct_url and direct_upload:
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
        return None
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
    return None


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


def generate_video(
    *,
    image_path: str | Path,
    prompt: str,
    duration_seconds: float = 4,
    workflow_id: str | None = None,
    output_dir: str | Path | None = None,
    poll_interval_seconds: float = 6,
    max_polls: int = 90,
) -> dict[str, Any]:
    descriptor = _required_descriptor()
    image = Path(image_path).expanduser().resolve()
    if not image.is_file():
        raise FileNotFoundError(f"Input image not found: {image}")
    width, height = _video_dimensions(image)
    uploaded_name = _upload_image(descriptor, image)
    duration = max(1.0, min(30.0, float(duration_seconds)))
    frame_rate = 24
    frames = max(9, min(721, round(duration * frame_rate) + 1))
    client = _client(descriptor)
    queued = _result_json(
        client.call_tool(
            descriptor.tool,
            {
                **({"workflow_id": workflow_id or descriptor.workflow_id} if workflow_id or descriptor.workflow_id else {}),
                "image_path": uploaded_name,
                "prompt": prompt.strip(),
                "width": width,
                "height": height,
                "frames": frames,
                "frame_rate": frame_rate,
                "wait": False,
                "include_urls": True,
            },
        )
    )
    job_id = _job_id(queued)
    if not job_id:
        raise RuntimeError("Media Studio did not return a job id")
    payload = queued
    video_url = _first_video_url(payload)
    for _ in range(max_polls):
        if video_url:
            break
        time.sleep(max(0.1, poll_interval_seconds))
        payload = _result_json(client.call_tool(descriptor.job_tool, {"id": job_id, "include_urls": True}))
        video_url = _first_video_url(payload)
        status = str(payload.get("status") or payload.get("state") or "").lower()
        if re.search(r"\b(error|failed|cancelled|canceled)\b", status):
            raise RuntimeError("Media Studio reported a failed generation")
    if not video_url:
        raise TimeoutError("Media Studio did not return a finished video before the poll limit")

    reachable_url = _rewrite_local_url(video_url, descriptor.upload_base)
    destination_root = Path(output_dir).expanduser().resolve() if output_dir else load_config().data_dir / "generated" / "media-studio"
    destination_root.mkdir(parents=True, exist_ok=True)
    destination = destination_root / f"media-studio-{job_id}-{int(time.time())}.mp4"
    _download(reachable_url, destination)
    qa = qa_video(destination, output_dir=destination_root / "qa")
    if not qa["ok"]:
        raise RuntimeError("Media Studio output failed technical QA: " + "; ".join(qa["failures"]))
    return {"job_id": job_id, "output": str(destination), "qa": qa, "provider": descriptor.app_name}


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
    return os.environ.get(descriptor.auth_env_key, "").strip() if descriptor.auth_env_key else ""


def _reachable(url: str, token: str) -> bool:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status < 500
    except urllib.error.HTTPError as exc:
        return exc.code < 500
    except OSError:
        return False


def _upload_image(descriptor: MediaStudioDescriptor, image: Path) -> str:
    token = _token(descriptor)
    body, content_type = encode_multipart([("overwrite", "true")], [("image", image)])
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(f"{descriptor.upload_base}/upload/image", data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Media Studio image upload failed with HTTP {exc.code}") from None
    name = str(payload.get("name") or "").strip()
    if not name:
        raise RuntimeError("Media Studio image upload returned no input filename")
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


def _first_video_url(payload: Any) -> str:
    match = re.search(r"https?://[^\"'\s]+\.(?:mp4|m4v|mov|webm)(?:\?[^\"'\s]*)?", json.dumps(payload), re.IGNORECASE)
    return match.group(0) if match else ""


def _rewrite_local_url(url: str, upload_base: str) -> str:
    parsed = urlparse(url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
        return url
    base = urlparse(upload_base)
    return urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))


def _download(url: str, destination: Path) -> None:
    try:
        with urllib.request.urlopen(url, timeout=180) as response:
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

