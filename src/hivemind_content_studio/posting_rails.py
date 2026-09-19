"""Where a finished post goes: one resolver, three rails.

A render can leave this studio three ways, tried in this order:

* ``hivemindos`` — HivemindOS is installed and running on this machine. The
  render is handed to its Socials queue as a review suggestion; HivemindOS owns
  approval, scheduling, delivery, fleet sync and post analytics.
* ``managed-socials`` — no HivemindOS, but a HivemindOS account. The hosted
  service publishes and schedules, so nothing local has to stay awake or run
  Postiz. Charged in credits by the hosted service, never by this file.
* ``upload-post`` / ``postiz`` — the owner's own keys, from this machine. Free.

The studio works with none of HivemindOS present: the resolver simply lands on
the owner's keys, exactly as ``publishing.py`` did before this module existed.

One thing here is unlike the rest of the studio and is deliberate. Run media is
encrypted at rest and plaintext never touches disk — except at
``export_for_handoff``. HivemindOS uploads a file by path, possibly hours later,
so handing a render to its queue means writing an unencrypted copy. That copy is
the owner publishing the file: it is only ever made for a run that is approved,
or whose persona was explicitly set to be reviewed in HivemindOS; it lives in
one private directory; and ``forget_handoff`` removes it once the post resolves.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .config import StudioConfig, load_config
from .private_access import private_media_exists, read_private_media

RAIL_ORDER = ("hivemindos", "managed-socials", "upload-post", "postiz")

MANAGED_SOCIALS_URL = "https://hivemindos-socials.hivemindos.workers.dev"

#: Platforms the hosted service and the HivemindOS Postiz rows deliver media to.
MEDIA_PLATFORMS = frozenset({"tiktok", "instagram", "threads", "youtube", "pinterest", "bluesky", "mastodon", "discord"})

_SAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")


class PostingRailError(RuntimeError):
    """A rail failure in words the owner can act on."""


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _json_request(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 20,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> tuple[int, dict[str, Any]]:
    from .hivemindos_models import USER_AGENT

    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/json",
            # Cloudflare 403s urllib's default agent; the local app does not care.
            "User-Agent": USER_AGENT,
            **({"Content-Type": "application/json"} if body is not None else {}),
            **(headers or {}),
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200))
            raw = response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        parsed = {}
    return status, parsed if isinstance(parsed, dict) else {}


# ---------------------------------------------------------------------------
# Rail: a local HivemindOS
# ---------------------------------------------------------------------------

def _hivemindos_headers() -> dict[str, str]:
    from .hivemindos_hosted_media import _dashboard_token

    token = _dashboard_token()
    if not token:
        raise PostingRailError(
            "HivemindOS is running but this studio has no dashboard device token for it. "
            "Open HivemindOS once on this machine so the shared credential is written, then try again."
        )
    return {"x-hivemindos-device-token": token}


def hivemindos_socials(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any] | None:
    """The local HivemindOS Socials feed, or None when no HivemindOS answers.

    Tries each candidate address rather than trusting a cached probe: a studio
    started before the app was opened must still find it.
    """
    from .hivemindos_models import candidate_urls

    try:
        headers = _hivemindos_headers()
    except PostingRailError:
        headers = {}
    for base in candidate_urls():
        try:
            status, body = _json_request(f"{base}/api/socials/queue?view=feed", headers=headers, timeout=4, opener=opener)
        except (urllib.error.URLError, OSError, TimeoutError):
            continue
        if status == 200 and body.get("ok"):
            return {"base_url": base, **body}
        if status in {401, 403}:
            return {"base_url": base, "ok": False, "unauthorised": True}
    return None


def hivemindos_account_for(feed: dict[str, Any], platform: str, account_id: str | None = None) -> dict[str, Any]:
    """The connected HivemindOS account a post to ``platform`` goes to."""
    accounts = [item for item in feed.get("accounts") or [] if isinstance(item, dict)]
    if account_id:
        match = next((item for item in accounts if item.get("id") == account_id), None)
        if not match:
            raise PostingRailError(f"HivemindOS has no Socials account {account_id}. Connect it in HivemindOS → Socials.")
        return match
    connected = [item for item in accounts if item.get("platform") == platform and item.get("status") == "connected"]
    if not connected:
        raise PostingRailError(f"No connected {platform} account in HivemindOS. Connect one in HivemindOS → Socials, then hand this post off again.")
    if len(connected) > 1:
        names = ", ".join(str(item.get("id")) for item in connected)
        raise PostingRailError(f"HivemindOS has several {platform} accounts ({names}). Name the one to post from.")
    return connected[0]


def hivemindos_accepts_media(feed: dict[str, Any], platform: str, kind: str) -> bool:
    row = next((item for item in feed.get("platforms") or [] if isinstance(item, dict) and item.get("platform") == platform), None)
    media = row.get("media") if isinstance(row, dict) else None
    return isinstance(media, dict) and kind in (media.get("kinds") or [])


def suggest_to_hivemindos(
    feed: dict[str, Any],
    *,
    account_id: str,
    text: str,
    media: list[Path],
    suggested_for: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Create a review suggestion. HivemindOS never publishes from this call."""
    status, body = _json_request(
        f"{feed['base_url']}/api/socials/queue",
        method="POST",
        payload={
            "action": "suggest",
            "accountId": account_id,
            "text": text,
            **({"suggestedFor": suggested_for} if suggested_for else {}),
            **({"media": [{"path": str(path)} for path in media]} if media else {}),
        },
        headers=_hivemindos_headers(),
        timeout=120,  # HivemindOS hashes the file before it answers
        opener=opener,
    )
    item = body.get("item")
    if status != 200 or not body.get("ok") or not isinstance(item, dict) or not item.get("id"):
        raise PostingRailError(f"HivemindOS did not queue the post: {body.get('error') or f'HTTP {status}'}")
    return item


def hivemindos_queue_items(feed: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["id"]): item for item in feed.get("queue") or [] if isinstance(item, dict) and item.get("id")}


def refresh_hivemindos_analytics(feed: dict[str, Any], account_id: str, *, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    status, body = _json_request(
        f"{feed['base_url']}/api/socials/queue",
        method="POST",
        payload={"action": "refresh-analytics", "accountId": account_id},
        headers=_hivemindos_headers(),
        timeout=60,
        opener=opener,
    )
    if status != 200 or not body.get("ok"):
        raise PostingRailError(f"HivemindOS could not refresh analytics for {account_id}: {body.get('error') or f'HTTP {status}'}")
    return body.get("analytics") if isinstance(body.get("analytics"), dict) else {}


# ---------------------------------------------------------------------------
# The one place plaintext is written
# ---------------------------------------------------------------------------

def handoff_root(cfg: StudioConfig | None = None) -> Path:
    return (cfg or load_config()).data_dir / "publish-handoff"


def export_for_handoff(media_path: str | Path, *, run_id: str, cfg: StudioConfig | None = None) -> Path:
    """Write an unencrypted copy of one run media file for HivemindOS to upload.

    See the module docstring: callers must have established that the owner
    asked for this file to be published before calling.
    """
    source = Path(media_path).expanduser()
    if not private_media_exists(source):
        raise FileNotFoundError(f"Publish media not found: {source}")
    directory = handoff_root(cfg) / (_SAFE_SEGMENT.sub("-", run_id).strip("-") or "run")
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(handoff_root(cfg), 0o700)
    os.chmod(directory, 0o700)
    target = directory / (_SAFE_SEGMENT.sub("-", source.name).strip("-") or "media")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(read_private_media(source))
    return target.resolve()


def forget_handoff(run_id: str, *, cfg: StudioConfig | None = None) -> bool:
    directory = handoff_root(cfg) / (_SAFE_SEGMENT.sub("-", run_id).strip("-") or "run")
    if not directory.is_dir():
        return False
    shutil.rmtree(directory)
    return True


# ---------------------------------------------------------------------------
# Rail: the hosted service
# ---------------------------------------------------------------------------

def managed_socials_url() -> str:
    return os.environ.get("HIVEMINDOS_MANAGED_SOCIALS_URL", MANAGED_SOCIALS_URL).strip().rstrip("/")


def managed_socials_health(*, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    try:
        status, body = _json_request(f"{managed_socials_url()}/health", timeout=6, opener=opener)
    except (urllib.error.URLError, OSError, TimeoutError):
        return {"reachable": False, "configured": False, "media": False}
    return {
        "reachable": status == 200 and bool(body.get("ok")),
        # The service answers /health before it has a Postiz behind it; only
        # `configured` means a publish can succeed.
        "configured": bool(body.get("configured")),
        "media": bool(body.get("media")),
    }


def _credit_token() -> str:
    from .hivemindos_hosted_media import _credit_token as token

    return token()


# ---------------------------------------------------------------------------
# The owner's own keys
# ---------------------------------------------------------------------------

def own_credential(configured: str | None, name: str) -> str:
    """A publishing key: from the process if it is there, else through PassBook.

    ``load_config`` reads the environment, and a sealed or guarded key is never
    placed in the environment, so a configured value of None does not mean the
    key is missing. Asked for by name at the moment it is needed, it leaves a
    receipt and is never held longer than the call.
    """
    if configured:
        return configured
    from .shared_env import request_credential

    return request_credential(name, reason="social publishing")


def own_key_state(configured: str | None, name: str) -> str:
    """``ready``, ``locked`` (stored here but unreadable right now) or ``absent``.

    The three need different repairs — nothing, ``passbook signin``, and adding
    the key — so the resolver must not report a locked key as a missing one.
    """
    if configured:
        return "ready"
    from .shared_env import stored_key_names

    if name not in stored_key_names():
        return "absent"
    return "ready" if own_credential(None, name) else "locked"


def _own_rail(rail_id: str, label: str, keys: list[tuple[str | None, str]]) -> dict[str, Any]:
    states = {name: own_key_state(value, name) for value, name in keys}
    if all(state == "ready" for state in states.values()):
        return {"id": rail_id, "available": True}
    locked = [name for name, state in states.items() if state == "locked"]
    absent = [name for name, state in states.items() if state == "absent"]
    fix = (
        f"{', '.join(locked)} {'is' if len(locked) == 1 else 'are'} stored in PassBook but locked. Run `passbook signin`, then try again."
        if locked and not absent
        else f"Add {' and '.join(absent)} to use your own {label} account."
    )
    return {"id": rail_id, "available": False, "fix": fix}


# ---------------------------------------------------------------------------
# The resolver
# ---------------------------------------------------------------------------

def posting_rails(
    cfg: StudioConfig | None = None,
    *,
    needs_media: bool = True,
    platforms: list[str] | None = None,
    media_kind: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Every rail with whether it can take a post now, and the first that can.

    With ``platforms`` (and ``media_kind``) the answer is about THIS post: a
    HivemindOS with only a Facebook account connected is not a rail for a TikTok
    video. Each unavailable rail says what would make it available, so the
    answer to "why not" is never just "no".
    """
    cfg = cfg or load_config()
    rails: list[dict[str, Any]] = []

    feed = hivemindos_socials(opener=opener)
    if feed is None:
        rails.append({"id": "hivemindos", "available": False, "fix": "Install and open HivemindOS on this machine to review, schedule and measure posts there."})
    elif feed.get("unauthorised"):
        rails.append({"id": "hivemindos", "available": False, "fix": "HivemindOS is running but refused this studio's device token. Open HivemindOS once so the shared credential is rewritten."})
    else:
        # Connected is not enough: HivemindOS connects some platforms read-only (Facebook), and those can never take a post.
        can_post = {
            str(row.get("platform")) for row in feed.get("platforms") or []
            if isinstance(row, dict) and (row.get("capabilities") or {}).get("post") not in {None, "unsupported"}
        }
        connected = [
            item for item in feed.get("accounts") or []
            if isinstance(item, dict) and item.get("status") == "connected" and str(item.get("platform")) in can_post
        ]
        have = {str(item.get("platform")) for item in connected}
        unconnected = [name for name in platforms or [] if name not in have]
        no_media = [name for name in platforms or [] if name in have and media_kind in {"image", "video"} and not hivemindos_accepts_media(feed, name, media_kind)]
        fix = (
            "Connect an account HivemindOS can post from (HivemindOS → Socials)." if not connected
            else f"Connect a {', '.join(unconnected)} account in HivemindOS → Socials." if unconnected
            else f"HivemindOS cannot attach a {media_kind} to a {', '.join(no_media)} post yet." if no_media
            else ""
        )
        rails.append({
            "id": "hivemindos",
            "available": not fix,
            "accounts": [{"id": item.get("id"), "platform": item.get("platform"), "handle": item.get("handle")} for item in connected],
            **({"fix": fix} if fix else {}),
        })

    health = managed_socials_health(opener=opener)
    has_credits = bool(_credit_token())
    hosted_ready = health["configured"] and has_credits and (health["media"] or not needs_media)
    rails.append({
        "id": "managed-socials",
        "available": hosted_ready,
        **({} if hosted_ready else {"fix": (
            "Sign in to a HivemindOS account in this studio to use hosted publishing." if not has_credits
            else "Hosted publishing is not switched on yet." if not health["configured"]
            else "Hosted publishing does not take media yet."
        )}),
    })

    rails.append(_own_rail("upload-post", "Upload-Post", [(cfg.upload_post_api_key, "UPLOAD_POST_API_KEY"), (cfg.upload_post_username, "UPLOAD_POST_USERNAME")]))
    rails.append(_own_rail("postiz", "Postiz", [(cfg.postiz_api_key, "POSTIZ_API_KEY")]))

    chosen = next((rail["id"] for rail in sorted(rails, key=lambda rail: RAIL_ORDER.index(rail["id"])) if rail["available"]), None)
    return {"rail": chosen, "rails": rails}
