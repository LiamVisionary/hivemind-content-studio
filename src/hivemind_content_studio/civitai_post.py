"""Handing a finished generation to Civitai, without a Civitai upload API.

Civitai's public REST API is read-only: there is no endpoint that accepts an
image or a video. The one supported route for a third-party tool is the Post
Intent System — you send the person to

    https://civitai.com/intent/post?mediaUrl=...&title=...&description=...&tags=...

and their post composer opens with the media already attached. Confirmed
against civitai's own source (`src/pages/intent/post.tsx`, read 2026-08-28),
that page does `const response = await fetch(src)` and then `.blob()` — the
media is fetched **client-side, by the browser that is signed in to Civitai**,
not by Civitai's servers.

That single fact is what this module is built on, and it is worth stating
plainly because it decides everything else:

  * The bytes never need to be public. A URL this machine serves is enough,
    because the only thing that has to reach it is the owner's own browser.
    Nothing is uploaded to a bucket, a CDN, or any third party — the file goes
    from here, to the browser, to Civitai, and that is the whole path.
  * The URL cannot be behind the studio's sign-in gate. That fetch is
    cross-origin from civitai.com and carries no cookie, so a gated URL would
    401. The token in the path IS the credential: 32 random bytes, minted only
    when the owner asks to post something, and expiring on its own.
  * It has to survive being read several times. The intent page fetches it once
    to validate, again to preview, and the post editor fetches it a third time
    after the post is created. So this is a short-lived staging area, not a
    one-shot handoff.

The bytes staged here are PLAINTEXT — deliberately. Everything the studio keeps
is sealed, and the point of this feature is to publish, which sealed bytes
cannot do. Staging is the moment that stops being true, so it happens only on
an explicit request, holds only the one file, and cleans itself up.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

# Long enough for the whole intent flow (validate -> preview -> create post ->
# the editor re-fetching the file), short enough that a forgotten staging does
# not sit on disk. The flow itself takes well under a minute; the slack is for
# a person who opens the tab and goes to make coffee.
STAGE_TTL_SECONDS = 30 * 60

# Civitai's own ceilings, read from `src/server/common/constants.ts`
# (`constants.mediaUpload`) on 2026-08-28. Checked here so an oversized clip is
# refused in the studio, with a number, instead of failing inside somebody
# else's uploader. Their published wiki quotes smaller numbers (500 MB / 120 s
# / 4k) than the code enforces; the code is what actually runs.
MAX_IMAGE_BYTES = 50 * 1024**2
MAX_VIDEO_BYTES = 750 * 1024**2
MAX_VIDEO_SECONDS = 245
MAX_VIDEO_DIMENSION = 3840
POST_TAG_LIMIT = 5

# What Civitai's post composer accepts. Anything else is refused before it is
# staged rather than after it is handed over.
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
}
VIDEO_TYPES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}

# The only origins the staged bytes are readable from. The intent page runs on
# civitai.com; civitai.red is the same application on its mirror domain.
ALLOWED_ORIGINS = ("https://civitai.com", "https://civitai.red")

INTENT_POST_URL = "https://civitai.com/intent/post"

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class CivitaiPostError(RuntimeError):
    """A refusal the studio should show verbatim — it always names a limit."""


@dataclass(frozen=True)
class StagedMedia:
    token: str
    path: Path
    content_type: str
    filename: str
    expires_at: float

    @property
    def kind(self) -> str:
        return "video" if self.content_type in VIDEO_TYPES else "image"


def staging_root() -> Path:
    """Where staged plaintext lives. Kept out of the media state tree on
    purpose: nothing here is studio state, it is a handoff buffer, and a sweeper
    that walks the outputs tree must never confuse the two."""
    root = Path(
        os.environ.get("CIVITAI_STAGE_ROOT")
        or (Path.home() / ".hivemindos" / "media-studio" / "civitai-outbox")
    )
    root.mkdir(parents=True, exist_ok=True)
    # Owner-only: the records inside name the tokens, and a token is the whole
    # credential for reading a staged file.
    try:
        root.chmod(0o700)
    except OSError:
        pass
    return root


def _record_path(root: Path, token: str) -> Path:
    return root / f"{token}.json"


def sweep(now: float | None = None) -> int:
    """Drop everything past its expiry. Called on every stage and every read, so
    the buffer stays empty without a background task to keep alive."""
    root = staging_root()
    moment = now if now is not None else time.time()
    dropped = 0
    for record in root.glob("*.json"):
        payload: dict[str, Any] = {}
        try:
            loaded = json.loads(record.read_text())
            payload = loaded if isinstance(loaded, dict) else {}
            expires = float(payload.get("expires_at") or 0)
        except Exception:
            # An unreadable record is not something to keep: it can never be
            # served, and leaving it means it is never cleaned up either. Note
            # `payload` is bound BEFORE the try — this sweep runs on every stage
            # and every read, so a single corrupt file must not be able to
            # throw and take the whole feature down with it.
            expires = 0
        if expires > moment:
            continue
        media = payload.get("path")
        if media:
            Path(str(media)).unlink(missing_ok=True)
        record.unlink(missing_ok=True)
        dropped += 1
    return dropped


# --- generation metadata written INTO the file ------------------------------
# Civitai reads generation parameters out of the uploaded file itself. For
# images that is the A1111 `parameters` string, which its parser understands.
# For video there is no native support yet — Civitai's own PR for MP4/WebM
# detection is still open — so the tags written here are what the community
# extension reads today and what native support will read when it lands.


def a1111_parameters(meta: dict[str, Any]) -> str:
    """Generation settings in the format Civitai's metadata parser reads.

    The shape is A1111's: the prompt, then an optional negative on its own
    labelled line, then one comma-separated line of settings.
    """
    prompt = str(meta.get("prompt") or "").strip()
    lines = [prompt] if prompt else []
    negative = str(meta.get("negativePrompt") or "").strip()
    if negative:
        lines.append(f"Negative prompt: {negative}")
    settings: list[str] = []
    for label, key in (
        ("Steps", "steps"),
        ("Sampler", "sampler"),
        ("Schedule type", "scheduler"),
        ("CFG scale", "cfgScale"),
        ("Seed", "seed"),
        ("Size", "size"),
        ("Model", "model"),
    ):
        value = meta.get(key)
        if value is None or value == "":
            continue
        settings.append(f"{label}: {value}")
    details = ", ".join(settings)

    # Resource linking. Civitai's A1111 parser pulls resources out of the
    # settings line with /, Civitai resources:\s*(\[\{.*?\}\])/ and keeps
    # `type`, `modelVersionId` and `weight` (automatic.metadata.ts). Emitting it
    # is what turns "Model: some name" from a caption into a LINKED resource on
    # the post.
    #
    # We can do this exactly, where the community extension has to guess: it
    # only has file hashes from ComfyUI metadata and must resolve them through
    # Civitai's API (ambiguous matches wait for the person to pick). Every LoRA
    # installed through this studio carries its Civitai sidecar, so the version
    # id is already known — no lookup, no ambiguity.
    #
    # The regex needs the LEADING COMMA, so this is never the first item on the
    # line; when there is nothing else to say, the resources are dropped rather
    # than written in a shape Civitai cannot read.
    resources = _clean_resources(meta.get("civitaiResources"))
    if resources and details:
        details = f"{details}, Civitai resources: {json.dumps(resources, separators=(',', ':'))}"
    if details:
        lines.append(details)
    return "\n".join(lines).strip()


def _clean_resources(value: Any) -> list[dict[str, Any]]:
    """Civitai resource entries, reduced to the fields their parser keeps.

    `modelName`/`versionName` are deleted on their side and `air` is expanded
    into type+version, so sending anything else is noise inside a string that
    also has to stay parseable — the match is non-greedy up to `}]`.
    """
    cleaned: list[dict[str, Any]] = []
    for entry in value if isinstance(value, list) else []:
        if not isinstance(entry, dict):
            continue
        try:
            version_id = int(entry.get("modelVersionId") or 0)
        except (TypeError, ValueError):
            continue
        if version_id <= 0:
            continue
        resource: dict[str, Any] = {
            "type": str(entry.get("type") or "lora").strip().lower() or "lora",
            "modelVersionId": version_id,
        }
        weight = entry.get("weight")
        if isinstance(weight, (int, float)) and not isinstance(weight, bool):
            resource["weight"] = round(float(weight), 4)
        if resource not in cleaned:
            cleaned.append(resource)
    return cleaned


def _stamp_image(path: Path, content_type: str, parameters: str) -> bool:
    """Write `parameters` into an image, in the place Civitai looks for it.

    PNG carries it as a tEXt chunk; JPEG and WebP carry it as EXIF
    UserComment. Returns False when the file could not be rewritten — a
    stamping failure must never cost the person their upload, so the caller
    keeps the original bytes and says the metadata did not travel.
    """
    if not parameters:
        return False
    try:
        from PIL import Image, PngImagePlugin
    except ImportError:
        return False
    try:
        with Image.open(path) as image:
            image.load()
            if content_type == "image/png":
                info = PngImagePlugin.PngInfo()
                info.add_text("parameters", parameters)
                image.save(path, format="PNG", pnginfo=info)
                return True
            exif = image.getexif()
            # 0x9286 is EXIF UserComment. The leading 8-byte character-set code
            # ("UNICODE\0" / "ASCII\0\0\0") is part of the field's definition,
            # and parsers that skip it show eight bytes of garbage.
            exif[0x9286] = b"UNICODE\0" + parameters.encode("utf-16-be")
            if content_type == "image/webp":
                image.save(path, format="WEBP", exif=exif, quality=95)
            else:
                image.save(path, format="JPEG", exif=exif, quality=95)
            return True
    except Exception:
        return False


def _stamp_video(path: Path, content_type: str, parameters: str, meta: dict[str, Any]) -> bool:
    """Write generation tags into an MP4 or WebM container.

    Civitai does not read these yet (their MP4/WebM detection PR is open), so
    this is deliberately forward-looking: the same keys the community extension
    reads today. Remuxed with `-c copy`, so no frame is re-encoded and the file
    is byte-identical apart from its tags.
    """
    if not parameters:
        return False
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    target = path.with_name(f"{path.stem}.tagged{path.suffix}")
    command = [ffmpeg, "-y", "-loglevel", "error", "-i", str(path), "-c", "copy"]
    if content_type == "video/mp4":
        # Arbitrary keys only survive in an MP4 as `mdta` atoms, which is what
        # this flag switches on; without it ffmpeg silently drops every tag it
        # does not recognise as a standard QuickTime one.
        command += ["-movflags", "use_metadata_tags"]
    command += ["-metadata", f"parameters={parameters}"]
    prompt = str(meta.get("prompt") or "").strip()
    if prompt:
        command += ["-metadata", f"prompt={prompt}"]
    command += [str(target)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=600)
        if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
            target.unlink(missing_ok=True)
            return False
        target.replace(path)
        return True
    except Exception:
        target.unlink(missing_ok=True)
        return False


def stamp(path: Path, content_type: str, meta: dict[str, Any]) -> bool:
    parameters = a1111_parameters(meta or {})
    if not parameters:
        return False
    if content_type in VIDEO_TYPES:
        return _stamp_video(path, content_type, parameters, meta or {})
    return _stamp_image(path, content_type, parameters)


# --- staging ----------------------------------------------------------------


def check_limits(content_type: str, size: int, meta: dict[str, Any] | None = None) -> None:
    """Refuse what Civitai would refuse, while it can still be explained here."""
    meta = meta or {}
    if content_type not in IMAGE_TYPES and content_type not in VIDEO_TYPES:
        accepted = ", ".join(sorted(set(IMAGE_TYPES) | set(VIDEO_TYPES)))
        raise CivitaiPostError(f"Civitai does not accept {content_type or 'that file type'}. It takes {accepted}.")
    if content_type in VIDEO_TYPES:
        if size > MAX_VIDEO_BYTES:
            # Leads with the limit rather than comparing two rounded sizes: a
            # file a byte over renders identically to the limit itself.
            raise CivitaiPostError(
                f"This clip is over Civitai's {MAX_VIDEO_BYTES // 1024**2} MB limit for video "
                f"(it is {size / 1024**2:.0f} MB)."
            )
        duration = float(meta.get("duration") or 0)
        if duration and duration > MAX_VIDEO_SECONDS:
            raise CivitaiPostError(
                f"This clip runs {duration:.0f}s and Civitai's limit is {MAX_VIDEO_SECONDS}s."
            )
        for side in ("width", "height"):
            value = int(meta.get(side) or 0)
            if value > MAX_VIDEO_DIMENSION:
                raise CivitaiPostError(
                    f"This clip is {value}px on its {side[0].upper()}{side[1:]} and Civitai's limit is {MAX_VIDEO_DIMENSION}px."
                )
        return
    if size > MAX_IMAGE_BYTES:
        raise CivitaiPostError(
            f"This image is over Civitai's {MAX_IMAGE_BYTES // 1024**2} MB limit "
            f"(it is {size / 1024**2:.0f} MB)."
        )


def stage(
    *,
    data: bytes,
    content_type: str,
    filename: str = "",
    meta: dict[str, Any] | None = None,
    now: float | None = None,
) -> tuple[StagedMedia, bool]:
    """Park one plaintext file for the handoff. Returns the record and whether
    the generation metadata could be written into it."""
    sweep(now)
    content_type = str(content_type or "").split(";", 1)[0].strip().lower()
    check_limits(content_type, len(data), meta)
    extension = IMAGE_TYPES.get(content_type) or VIDEO_TYPES.get(content_type) or ".bin"
    token = secrets.token_urlsafe(32)
    root = staging_root()
    path = root / f"{token}{extension}"
    path.write_bytes(data)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    stamped = stamp(path, content_type, meta or {})
    # The name Civitai's editor shows comes from the URL's last segment, so the
    # served filename is the studio's own download name where there is one.
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", str(filename or "")).strip("._-")
    if not safe_name or not safe_name.lower().endswith(extension):
        safe_name = f"hivemind-{token[:8]}{extension}"
    expires_at = (now if now is not None else time.time()) + STAGE_TTL_SECONDS
    record = {
        "token": token,
        "path": str(path),
        "content_type": content_type,
        "filename": safe_name,
        "expires_at": expires_at,
        "bytes": path.stat().st_size,
        "stamped": stamped,
    }
    record_file = _record_path(root, token)
    record_file.write_text(json.dumps(record))
    # The record holds the token, so it is as sensitive as the media itself.
    try:
        record_file.chmod(0o600)
    except OSError:
        pass
    return (
        StagedMedia(
            token=token,
            path=path,
            content_type=content_type,
            filename=safe_name,
            expires_at=expires_at,
        ),
        stamped,
    )


def read_staged(token: str, now: float | None = None) -> StagedMedia | None:
    """The staged file for a token, or None when it never existed or expired."""
    if not _TOKEN_RE.match(str(token or "")):
        return None
    sweep(now)
    record_file = _record_path(staging_root(), token)
    if not record_file.exists():
        return None
    try:
        payload = json.loads(record_file.read_text())
    except Exception:
        return None
    path = Path(str(payload.get("path") or ""))
    if not path.exists():
        return None
    return StagedMedia(
        token=token,
        path=path,
        content_type=str(payload.get("content_type") or "application/octet-stream"),
        filename=str(payload.get("filename") or path.name),
        expires_at=float(payload.get("expires_at") or 0),
    )


def drop_staged(token: str) -> bool:
    """Remove a staging early — what the studio calls when a post is finished
    or abandoned, so the plaintext does not wait out its TTL."""
    if not _TOKEN_RE.match(str(token or "")):
        return False
    root = staging_root()
    record_file = _record_path(root, token)
    if not record_file.exists():
        return False
    try:
        payload = json.loads(record_file.read_text())
        Path(str(payload.get("path") or "")).unlink(missing_ok=True)
    except Exception:
        pass
    record_file.unlink(missing_ok=True)
    return True


def cors_origin(origin: str | None) -> str | None:
    """Echo the request's origin when it is one Civitai serves the intent page
    from. An allowlist rather than `*` because these bytes are plaintext and
    unauthenticated for as long as they are staged."""
    candidate = str(origin or "").strip().rstrip("/")
    return candidate if candidate in ALLOWED_ORIGINS else None


def intent_url(media_url: str, *, title: str = "", description: str = "", tags: list[str] | None = None) -> str:
    """The Civitai post composer, pre-filled.

    `mediaUrl` must be absolute — Civitai validates it as a URL before it will
    fetch it — which is why the caller passes the browser's own origin in
    rather than this side guessing at a hostname it is reachable under.
    """
    if not str(media_url or "").startswith(("http://", "https://")):
        raise CivitaiPostError("Civitai needs an absolute URL for the media.")
    params: dict[str, str] = {"mediaUrl": media_url}
    if title:
        params["title"] = str(title)[:255]
    if description:
        params["description"] = str(description)[:1000]
    clean_tags = [str(tag).strip() for tag in (tags or []) if str(tag).strip()][:POST_TAG_LIMIT]
    if clean_tags:
        params["tags"] = ",".join(clean_tags)
    return f"{INTENT_POST_URL}?{urlencode(params)}"
