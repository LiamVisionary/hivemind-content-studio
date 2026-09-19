"""Canonical approval-gated publishing.

Four rails, chosen by ``posting_rails.posting_rails`` when a draft asks for
``auto``: a local HivemindOS (handed off for review there), the hosted
managed-socials service, or the owner's own Upload-Post / Postiz keys.
"""

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
from . import posting_rails
from .private_access import encrypt_private_media, private_media_exists, read_private_media, staged_private_media
from .qa import qa_asset

#: Rails that publish from this process, behind the three live-publish gates.
LIVE_PROVIDERS = {"postiz", "upload-post", "managed-socials"}
#: The rail that does not publish: it hands the draft to HivemindOS for review.
HANDOFF_PROVIDER = "hivemindos"
REVIEW_IN_HIVEMINDOS = "hivemindos"


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
        chunks.append(read_private_media(path))
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
    accounts: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Record one draft. ``provider="auto"`` picks the best rail available now.

    ``accounts`` maps a platform to the HivemindOS Socials account (or hosted
    channel) to post from, for when more than one is connected.
    """
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
        if not private_media_exists(media_path):
            raise FileNotFoundError(f"Publish media not found: {media_path}")
    normalized_platforms = sorted({platform.strip().lower() for platform in platforms if platform.strip()})
    if not normalized_platforms:
        raise ValueError("At least one platform is required")
    if provider == "auto":
        # The rail depends on the post: which platforms, and what kind of file.
        suffixes = {path.suffix.lower() for path in media_paths}
        kind = None if text_only else "video" if suffixes & {".mp4", ".mov", ".m4v", ".webm"} else "image"
        resolved = posting_rails.posting_rails(needs_media=not text_only, platforms=normalized_platforms, media_kind=kind)
        if not resolved["rail"]:
            fixes = " ".join(str(rail.get("fix")) for rail in resolved["rails"] if rail.get("fix"))
            raise PublishError(f"Nothing on this machine can publish yet. {fixes}")
        provider = resolved["rail"]
    if provider not in LIVE_PROVIDERS | {HANDOFF_PROVIDER}:
        raise ValueError("Provider must be auto, hivemindos, managed-socials, postiz or upload-post")
    qa_dir = Path(manifest_path).expanduser().resolve().parent / "qa"
    qa_results = []
    for path in media_paths:
        with staged_private_media(path) as staged:
            qa = qa_asset(staged, output_dir=qa_dir)
        for key in ("path", "video"):
            if qa.get(key):
                qa[key] = str(path)
        if qa.get("representative_frame"):
            frame = Path(str(qa["representative_frame"]))
            encrypt_private_media(frame)
        qa_results.append(qa)
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
        "accounts": {str(key).strip().lower(): str(value).strip() for key, value in (accounts or {}).items() if str(value).strip()},
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
                if not private_media_exists(Path(str(media_path))):
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
        if draft.get("status") == "published" or draft["provider"] == HANDOFF_PROVIDER:
            continue
        media_paths = [Path(value) for value in draft.get("media", [])]
        if draft["provider"] == "managed-socials":
            receipts.extend(_publish_managed_socials(manifest, draft, media_paths))
        elif draft["provider"] == "upload-post":
            publisher = _upload_post_publisher(cfg)
            common = {"title": draft["title"], "caption": draft["caption"], "platforms": draft["platforms"], "idempotency_key": f"{manifest['run_id']}:{draft['id']}"}
            if draft["media_kind"] == "video":
                response = publisher.upload_video(video=media_paths[0], **common)
            elif draft["media_kind"] == "image":
                response = publisher.upload_photos(photos=media_paths, **common)
            else:
                response = publisher.upload_text(**common)
            receipts.append({"draft_id": draft["id"], "provider": "upload-post", "response": response, "created_at": utc_now()})
        else:
            publisher = _postiz_publisher(cfg)
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


def _upload_post_publisher(cfg: StudioConfig) -> UploadPostPublisher:
    # A sealed or guarded key never reaches the environment `cfg` was read from;
    # it is asked for by name here, at the one moment a publish needs it.
    return UploadPostPublisher(
        cfg.upload_post_api_url,
        posting_rails.own_credential(cfg.upload_post_api_key, "UPLOAD_POST_API_KEY") or None,
        posting_rails.own_credential(cfg.upload_post_username, "UPLOAD_POST_USERNAME") or None,
    )


def _postiz_publisher(cfg: StudioConfig) -> PostizPublisher:
    return PostizPublisher(cfg.postiz_url, posting_rails.own_credential(cfg.postiz_api_key, "POSTIZ_API_KEY") or None)


def _preflight_live_publish(manifest: dict[str, Any], cfg: StudioConfig) -> None:
    live = [draft for draft in manifest["publish"]["drafts"] if draft["provider"] != HANDOFF_PROVIDER and draft.get("status") != "published"]
    if not live and any(draft["provider"] == HANDOFF_PROVIDER for draft in manifest["publish"]["drafts"]):
        raise PublishError("These drafts are reviewed and published in HivemindOS; hand them off with handoff_to_hivemindos instead.")
    for draft in live:
        if draft["provider"] == "managed-socials":
            health = posting_rails.managed_socials_health()
            if not health["configured"]:
                raise PublishError("Hosted publishing is not switched on yet; use HivemindOS or your own Upload-Post/Postiz keys.")
            if draft.get("media_kind") != "text" and not health["media"]:
                raise PublishError("Hosted publishing does not take media yet; use HivemindOS or your own Upload-Post/Postiz keys.")
            if not posting_rails._credit_token():
                raise PublishError("Sign in to a HivemindOS account in this studio to use hosted publishing.")
            missing = [platform for platform in draft["platforms"] if not (draft.get("accounts") or {}).get(platform)]
            if missing:
                raise PublishError("Name the hosted channel to post from for: " + ", ".join(missing))
            continue
        if draft["provider"] == "upload-post":
            if not _upload_post_publisher(cfg).configured:
                raise PublishError("Upload-Post is not configured")
            continue
        if not _postiz_publisher(cfg).configured:
            raise PublishError("Postiz is not configured")
        missing = [platform for platform in draft["platforms"] if not integration_id_for(platform)]
        if missing:
            raise PublishError("Missing Postiz integration ids for: " + ", ".join(missing))


def _publish_managed_socials(manifest: dict[str, Any], draft: dict[str, Any], media_paths: list[Path]) -> list[dict[str, Any]]:
    """Publish one draft through the hosted service. It, not this file, charges the credits."""
    token = posting_rails._credit_token()
    base = posting_rails.managed_socials_url()
    media_ids: list[str] = []
    for path in media_paths:
        body, content_type = encode_multipart({}, [("file", path)])
        request = urllib.request.Request(
            f"{base}/v1/media",
            data=body,
            method="POST",
            headers={"X-HivemindOS-Credit-Token": token, "Content-Type": content_type, "Accept": "application/json"},
        )
        uploaded = _read_json_response(request, "Hosted publishing")
        media_id = uploaded.get("media", {}).get("id") if isinstance(uploaded, dict) else None
        if not media_id:
            raise PublishError("Hosted publishing accepted the upload but returned no media id")
        media_ids.append(str(media_id))
    receipts = []
    for platform in draft["platforms"]:
        payload = {
            "platform": platform,
            "channelId": draft["accounts"][platform],
            "content": draft["caption"] or draft["title"],
            **({"mediaIds": media_ids} if media_ids else {}),
            **({"scheduledAt": draft["scheduled_at"]} if draft.get("scheduled_at") else {}),
        }
        request = urllib.request.Request(
            f"{base}/v1/posts",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "X-HivemindOS-Credit-Token": token,
                "Content-Type": "application/json",
                "Accept": "application/json",
                # One key per draft and platform: a retry after a lost response never posts or charges twice.
                "Idempotency-Key": f"{manifest['run_id']}:{draft['id']}:{platform}",
            },
        )
        response = _read_json_response(request, "Hosted publishing")
        receipts.append({"draft_id": draft["id"], "provider": "managed-socials", "platform": platform, "response": response, "created_at": utc_now()})
    return receipts


def handoff_to_hivemindos(manifest_path: str | Path, *, cfg: StudioConfig | None = None) -> dict[str, Any]:
    """Hand this run's HivemindOS drafts to the local Socials queue for review.

    Nothing publishes here: each draft becomes a review suggestion that a person
    approves, schedules or discards in HivemindOS. The gate is therefore not the
    live-publish switch but the question "did the owner ask for this file to
    leave the vault": the run is approved, or its brief set
    ``publish.review_in: hivemindos`` so that HivemindOS is where it is reviewed.
    """
    cfg = cfg or load_config()
    manifest = load_manifest(manifest_path)
    drafts = [draft for draft in manifest.get("publish", {}).get("drafts", []) if draft.get("provider") == HANDOFF_PROVIDER and draft.get("status") == "prepared"]
    if not drafts:
        raise PublishError("No prepared HivemindOS drafts on this run")
    brief_publish = manifest.get("brief", {}).get("publish") if isinstance(manifest.get("brief"), dict) else None
    review_in_hivemindos = isinstance(brief_publish, dict) and brief_publish.get("review_in") == REVIEW_IN_HIVEMINDOS
    if manifest.get("approval", {}).get("status") != "approved" and not review_in_hivemindos:
        raise PublishError("Approve this run first, or set publish.review_in: hivemindos in its brief so it is reviewed in HivemindOS.")
    validation = dry_run(manifest_path)
    if not validation["ok"]:
        raise PublishError("Publish dry-run failed: " + "; ".join(validation["failures"]))

    feed = posting_rails.hivemindos_socials()
    if feed is None:
        raise PublishError("HivemindOS is not running on this machine. Open it, or prepare this draft with your own Upload-Post/Postiz keys instead.")
    if feed.get("unauthorised"):
        raise PublishError("HivemindOS refused this studio's device token. Open HivemindOS once so the shared credential is rewritten.")

    # Resolve every account and check every platform before the first file is
    # exported, so a refusal never leaves an unencrypted copy behind.
    plan: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    try:
        for draft in drafts:
            for platform in draft["platforms"]:
                account = posting_rails.hivemindos_account_for(feed, platform, (draft.get("accounts") or {}).get(platform))
                if draft["media_kind"] != "text" and not posting_rails.hivemindos_accepts_media(feed, str(account.get("platform")), draft["media_kind"]):
                    raise PublishError(f"HivemindOS cannot attach a {draft['media_kind']} to a {account.get('platform')} post yet. Use your own Upload-Post/Postiz keys for this one.")
                plan.append((draft, platform, account))
    except posting_rails.PostingRailError as exc:
        raise PublishError(str(exc)) from exc

    receipts: list[dict[str, Any]] = []
    exported: dict[str, list[Path]] = {}
    try:
        for draft, platform, account in plan:
            if draft["id"] not in exported:
                exported[draft["id"]] = [posting_rails.export_for_handoff(path, run_id=manifest["run_id"], cfg=cfg) for path in draft.get("media", [])]
            item = posting_rails.suggest_to_hivemindos(
                feed,
                account_id=str(account["id"]),
                text=draft["caption"] or draft["title"],
                media=exported[draft["id"]],
                suggested_for=draft.get("scheduled_at"),
            )
            receipts.append({
                "draft_id": draft["id"], "provider": HANDOFF_PROVIDER, "platform": platform,
                "account_id": account["id"], "queue_item_id": item["id"], "state": item.get("state"), "created_at": utc_now(),
            })
    except posting_rails.PostingRailError as exc:
        if not receipts:
            posting_rails.forget_handoff(manifest["run_id"], cfg=cfg)
        raise PublishError(str(exc)) from exc
    for draft in drafts:
        draft["status"] = "handed-off"
    manifest["publish"]["receipts"].extend(receipts)
    manifest["status"] = "publish-handed-off"
    write_manifest(manifest_path, manifest)
    return {"ok": True, "published": False, "handed_off": True, "receipts": receipts}


#: Socials queue states after which HivemindOS will never read the exported file again.
_HIVEMINDOS_TERMINAL = {"posted", "canceled"}


def sync_hivemindos_posts(manifest_path: str | Path, *, refresh: bool = True, cfg: StudioConfig | None = None) -> dict[str, Any]:
    """Pull each handed-off post's state and numbers back from HivemindOS.

    Closes the loop the handoff opened: a posted item marks its draft published
    and lands its metrics on the run, and once every item is posted, canceled or
    deleted the exported plaintext copies are removed.
    """
    from .metrics import upsert_post_metrics

    cfg = cfg or load_config()
    manifest = load_manifest(manifest_path)
    receipts = [item for item in manifest.get("publish", {}).get("receipts", []) if item.get("provider") == HANDOFF_PROVIDER]
    if not receipts:
        return {"ok": True, "synced": 0, "posted": 0, "measured": 0, "cleaned": False}
    feed = posting_rails.hivemindos_socials()
    if feed is None or feed.get("unauthorised"):
        raise PublishError("HivemindOS is not reachable on this machine, so post results could not be read.")
    if refresh:
        # Refreshing can be a metered read, so only accounts with a post that is actually live are asked.
        live = posting_rails.hivemindos_queue_items(feed)
        posted_accounts = {str(item["account_id"]) for item in receipts if (live.get(str(item.get("queue_item_id"))) or {}).get("state") == "posted"}
        for account_id in sorted(posted_accounts):
            try:
                posting_rails.refresh_hivemindos_analytics(feed, account_id)
            except posting_rails.PostingRailError:
                # Numbers are best-effort and may be metered; state still syncs from the last read.
                continue
        feed = posting_rails.hivemindos_socials() or feed
    items = posting_rails.hivemindos_queue_items(feed)
    measured: list[dict[str, Any]] = []
    for receipt in receipts:
        item = items.get(str(receipt.get("queue_item_id")))
        # A suggestion the owner deleted is gone from the queue; that is as final as a cancel.
        receipt["state"] = str(item.get("state")) if item else "deleted"
        result = item.get("result") if item and isinstance(item.get("result"), dict) else None
        if result:
            receipt.update({"external_id": result.get("externalId"), "url": result.get("url"), "posted_at": result.get("postedAt")})
            if isinstance(result.get("metrics"), dict) and result.get("externalId"):
                measured.append({"platform": receipt["platform"], "external_id": str(result["externalId"]), "metrics": result["metrics"]})
    by_draft: dict[str, list[str]] = {}
    for receipt in receipts:
        by_draft.setdefault(str(receipt["draft_id"]), []).append(str(receipt["state"]))
    for draft in manifest["publish"]["drafts"]:
        states = by_draft.get(str(draft.get("id")))
        if states and all(state == "posted" for state in states):
            draft["status"] = "published"
    if all(draft.get("status") == "published" for draft in manifest["publish"]["drafts"]):
        manifest["status"] = "published"
    write_manifest(manifest_path, manifest)
    for entry in measured:
        upsert_post_metrics(manifest_path, platform=entry["platform"], external_id=entry["external_id"], metrics=entry["metrics"], source="hivemindos-socials")
    finished = all(str(receipt["state"]) in _HIVEMINDOS_TERMINAL | {"deleted"} for receipt in receipts)
    cleaned = posting_rails.forget_handoff(manifest["run_id"], cfg=cfg) if finished else False
    return {
        "ok": True,
        "synced": len(receipts),
        "posted": sum(1 for receipt in receipts if receipt["state"] == "posted"),
        "measured": len(measured),
        "cleaned": cleaned,
        "states": {str(receipt["queue_item_id"]): receipt["state"] for receipt in receipts},
    }


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
