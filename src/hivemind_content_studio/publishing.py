"""Canonical approval-gated Postiz and Upload-Post publishing."""

from __future__ import annotations

import json
import mimetypes
import os
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import StudioConfig, load_config
from .manifest import load_manifest, utc_now, write_manifest
from .qa import qa_asset


LIVE_CONFIRMATION = "LIVE_PUBLISH"


class PublishError(RuntimeError):
    """A sanitized publish failure."""


def integration_id_for(platform: str) -> str | None:
    key = f"POSTIZ_INTEGRATION_{platform.upper().replace('-', '_')}"
    return os.environ.get(key) or None


def build_postiz_payload(*, platform: str, integration_id: str | None, caption: str, media: list[dict[str, Any]], scheduled_at: str) -> dict[str, Any]:
    return {
        "type": "schedule",
        "date": scheduled_at,
        "shortLink": False,
        "tags": [],
        "posts": [
            {
                "integration": {"id": integration_id},
                "value": [{"content": caption[:2200], "image": media}],
                "settings": {"__type": platform},
            }
        ],
    }


def write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


class PostizPublisher:
    def __init__(self, base_url: str, api_key: str | None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    def list_integrations(self) -> Any:
        return self._json("GET", "/public/v1/integrations", None)

    def upload_media(self, path: Path) -> dict[str, Any]:
        body, content_type = encode_multipart({}, [("file", path)])
        result = self._request("POST", "/public/v1/upload", body, content_type)
        if not isinstance(result, dict) or not result.get("id") or not result.get("path"):
            raise PublishError("Postiz upload response did not include media id/path")
        return result

    def create_post(self, payload: dict[str, Any]) -> Any:
        return self._json("POST", "/public/v1/posts", payload)

    def _json(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        return self._request(method, path, body, "application/json")

    def _request(self, method: str, path: str, body: bytes | None, content_type: str) -> Any:
        if not self.configured:
            raise PublishError("Postiz is not configured")
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={"Authorization": str(self.api_key), "Content-Type": content_type},
        )
        return _read_json_response(request, "Postiz")


class UploadPostPublisher:
    def __init__(self, endpoint: str, api_key: str | None, username: str | None):
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.username = username

    @property
    def configured(self) -> bool:
        return bool(self.endpoint and self.api_key and self.username)

    def upload_video(self, *, video: Path, title: str, caption: str, platforms: list[str], idempotency_key: str) -> Any:
        return self._upload(kind="video", media=[video], title=title, caption=caption, platforms=platforms, idempotency_key=idempotency_key)

    def upload_photos(self, *, photos: list[Path], title: str, caption: str, platforms: list[str], idempotency_key: str) -> Any:
        return self._upload(kind="image", media=photos, title=title, caption=caption, platforms=platforms, idempotency_key=idempotency_key)

    def upload_text(self, *, title: str, caption: str, platforms: list[str], idempotency_key: str) -> Any:
        return self._upload(kind="text", media=[], title=title, caption=caption, platforms=platforms, idempotency_key=idempotency_key)

    def _upload(self, *, kind: str, media: list[Path], title: str, caption: str, platforms: list[str], idempotency_key: str) -> Any:
        if not self.configured:
            raise PublishError("Upload-Post is not configured")
        fields: list[tuple[str, str]] = [("user", str(self.username)), ("title", title), ("description", caption)]
        fields.extend(("platform[]", platform) for platform in platforms)
        file_field = "video" if kind == "video" else "photos[]"
        files = [(file_field, path) for path in media]
        body, content_type = encode_multipart(fields, files)
        endpoint = self._endpoint_for(kind)
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Apikey {self.api_key}",
                "Content-Type": content_type,
                "Idempotency-Key": idempotency_key,
            },
        )
        return _read_json_response(request, "Upload-Post")

    def _endpoint_for(self, kind: str) -> str:
        base = self.endpoint
        for suffix in ("/upload_photos", "/upload_text", "/upload"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        suffix = {"video": "/upload", "image": "/upload_photos", "text": "/upload_text"}[kind]
        return base + suffix


def encode_multipart(fields: dict[str, str] | list[tuple[str, str]], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = f"content-studio-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    field_items = list(fields.items()) if isinstance(fields, dict) else fields
    for name, value in field_items:
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    for name, path in files:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{path.name}\"\r\nContent-Type: {content_type}\r\n\r\n".encode()
        )
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def prepare_publish(
    manifest_path: str | Path,
    *,
    title: str,
    caption: str,
    platforms: list[str],
    provider: str,
    video: str | Path | None = None,
    media: list[str | Path] | None = None,
    text_only: bool = False,
    scheduled_at: str | None = None,
) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    media_values: list[str | Path] = list(media or [])
    if video is not None:
        media_values.insert(0, video)
    media_paths = [Path(value).expanduser().resolve() for value in media_values]
    if text_only and media_paths:
        raise ValueError("text_only cannot be combined with media files")
    if not text_only and not media_paths:
        raise ValueError("At least one media file is required unless text_only is true")
    for media_path in media_paths:
        if not media_path.is_file():
            raise FileNotFoundError(f"Publish media not found: {media_path}")
    normalized_platforms = sorted({platform.strip().lower() for platform in platforms if platform.strip()})
    if not normalized_platforms:
        raise ValueError("At least one platform is required")
    if provider not in {"postiz", "upload-post"}:
        raise ValueError("Provider must be postiz or upload-post")
    qa_results = [qa_asset(path, output_dir=Path(manifest_path).expanduser().resolve().parent / "qa") for path in media_paths]
    failures = [failure for qa in qa_results for failure in qa.get("failures", [])]
    if failures:
        raise PublishError("Media QA failed: " + "; ".join(failures))
    kinds = {qa["kind"] for qa in qa_results}
    if len(kinds) > 1:
        raise PublishError("Mixed image/video drafts are not supported by the current publisher APIs")
    media_kind = "text" if text_only else next(iter(kinds))
    if media_kind == "video" and len(media_paths) != 1:
        raise PublishError("Video drafts require exactly one video file")
    draft = {
        "id": uuid.uuid4().hex,
        "provider": provider,
        "media": [str(path) for path in media_paths],
        "video": str(media_paths[0]) if media_kind == "video" else None,
        "media_kind": media_kind,
        "title": title.strip(),
        "caption": caption.strip(),
        "platforms": normalized_platforms,
        "scheduled_at": scheduled_at,
        "status": "prepared",
        "qa": qa_results,
        "created_at": utc_now(),
    }
    manifest["publish"]["drafts"].append(draft)
    manifest["status"] = "publish-prepared"
    write_manifest(manifest_path, manifest)
    return draft


def dry_run(manifest_path: str | Path) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    failures: list[str] = []
    drafts = manifest.get("publish", {}).get("drafts", [])
    if not drafts:
        failures.append("no publish drafts")
    for draft in drafts:
        if draft.get("media_kind") != "text":
            for media_path in draft.get("media", []):
                if not Path(str(media_path)).is_file():
                    failures.append(f"missing media for draft {draft.get('id')}: {media_path}")
        if not draft.get("platforms"):
            failures.append(f"missing platforms for draft {draft.get('id')}")
        if not draft.get("title"):
            failures.append(f"missing title for draft {draft.get('id')}")
        if any(not qa.get("ok") for qa in draft.get("qa", [])):
            failures.append(f"media QA missing or failed for draft {draft.get('id')}")
    return {
        "ok": not failures,
        "would_publish": False,
        "approval_status": manifest.get("approval", {}).get("status"),
        "drafts": drafts,
        "failures": failures,
    }


def execute_publish(manifest_path: str | Path, *, confirm: str, cfg: StudioConfig | None = None) -> dict[str, Any]:
    cfg = cfg or load_config()
    if confirm != LIVE_CONFIRMATION:
        raise PublishError(f"Refusing live publish without confirmation token {LIVE_CONFIRMATION}")
    if not cfg.live_publish_enabled:
        raise PublishError("Live publishing is disabled; set CONTENT_STUDIO_ENABLE_LIVE_PUBLISH=true for an explicitly approved run")
    manifest = load_manifest(manifest_path)
    if manifest.get("approval", {}).get("status") != "approved":
        raise PublishError("Run is not approved")
    validation = dry_run(manifest_path)
    if not validation["ok"]:
        raise PublishError("Publish dry-run failed: " + "; ".join(validation["failures"]))

    _preflight_live_publish(manifest, cfg)

    receipts: list[dict[str, Any]] = []
    for draft in manifest["publish"]["drafts"]:
        if draft.get("status") == "published":
            continue
        media_paths = [Path(value) for value in draft.get("media", [])]
        if draft["provider"] == "upload-post":
            publisher = UploadPostPublisher(cfg.upload_post_api_url, cfg.upload_post_api_key, cfg.upload_post_username)
            common = {"title": draft["title"], "caption": draft["caption"], "platforms": draft["platforms"], "idempotency_key": f"{manifest['run_id']}:{draft['id']}"}
            if draft["media_kind"] == "video":
                response = publisher.upload_video(video=media_paths[0], **common)
            elif draft["media_kind"] == "image":
                response = publisher.upload_photos(photos=media_paths, **common)
            else:
                response = publisher.upload_text(**common)
            receipts.append({"draft_id": draft["id"], "provider": "upload-post", "response": response, "created_at": utc_now()})
        else:
            publisher = PostizPublisher(cfg.postiz_url, cfg.postiz_api_key)
            uploaded_media = [publisher.upload_media(path) for path in media_paths]
            for platform in draft["platforms"]:
                integration_id = integration_id_for(platform)
                if not integration_id:
                    raise PublishError(f"Missing Postiz integration id for {platform}")
                scheduled_at = draft.get("scheduled_at") or utc_now()
                media_payload = [{"id": item["id"], "path": item["path"]} for item in uploaded_media]
                payload = build_postiz_payload(platform=platform, integration_id=integration_id, caption=draft["caption"] or draft["title"], media=media_payload, scheduled_at=scheduled_at)
                response = publisher.create_post(payload)
                receipts.append({"draft_id": draft["id"], "provider": "postiz", "platform": platform, "response": response, "created_at": utc_now()})
        draft["status"] = "published"
    manifest["publish"]["receipts"].extend(receipts)
    manifest["status"] = "published"
    write_manifest(manifest_path, manifest)
    return {"ok": True, "published": True, "receipts": receipts}


def _preflight_live_publish(manifest: dict[str, Any], cfg: StudioConfig) -> None:
    for draft in manifest["publish"]["drafts"]:
        if draft.get("status") == "published":
            continue
        if draft["provider"] == "upload-post":
            if not UploadPostPublisher(cfg.upload_post_api_url, cfg.upload_post_api_key, cfg.upload_post_username).configured:
                raise PublishError("Upload-Post is not configured")
            continue
        if not PostizPublisher(cfg.postiz_url, cfg.postiz_api_key).configured:
            raise PublishError("Postiz is not configured")
        missing = [platform for platform in draft["platforms"] if not integration_id_for(platform)]
        if missing:
            raise PublishError("Missing Postiz integration ids for: " + ", ".join(missing))


def _read_json_response(request: urllib.request.Request, provider: str) -> Any:
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise PublishError(f"{provider} HTTP {exc.code}") from None
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc).__class__.__name__
        raise PublishError(f"{provider} connection failed ({reason})") from None
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {"text": raw[:500]}
