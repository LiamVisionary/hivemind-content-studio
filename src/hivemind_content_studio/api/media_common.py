"""Media the control API reads, writes and serves, on the way in and out.

Moved out of control_api.py unchanged (2026-09-04). The three inline-media
wrappers stayed behind in control_api because the size ceilings they read are
patched there by name; everything they lean on is here.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import Response

from ..media_studio import normalized_requester_pub
from ..private_access import (
    PrivateFieldCipher,
    encrypt_private_media,
    private_media_exists,
    private_media_sidecar,
    read_private_media,
)


_INLINE_IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}


_INLINE_VIDEO_SUFFIXES = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/x-m4v": ".m4v",
}


_INLINE_AUDIO_SUFFIXES = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    # What real recorders actually label AAC-in-MP4: Android's media framework
    # and anything that went through it say "mp4a-latm" (2026-08-12, a voice
    # reference rejected on the label alone while the bytes were ordinary m4a).
    "audio/mp4a-latm": ".m4a",
    "audio/aacp": ".aac",
    "audio/x-hx-aac-adts": ".aac",
    # A browser MediaRecorder produces webm/opus by default, and phone voice
    # memos arrive as 3gpp/amr or Apple's caf.
    "audio/webm": ".webm",
    "audio/opus": ".opus",
    "audio/3gpp": ".3gp",
    "audio/amr": ".amr",
    "audio/x-caf": ".caf",
}


# Container signatures, for when the LABEL is unknown but the bytes are not.
# An allow-list of media types is a guess about what clients call things; these
# are what the file actually is. Checked only after the label misses, so a
# correctly-labelled file never depends on sniffing.
_MEDIA_MAGIC = (
    (b"RIFF", 8, b"WAVE", ".wav"),
    (b"fLaC", None, None, ".flac"),
    (b"OggS", None, None, ".ogg"),
    (b"ID3", None, None, ".mp3"),
    (b"\x1a\x45\xdf\xa3", None, None, ".webm"),  # EBML: webm/mkv
    (b"RIFF", 8, b"AVI ", ".avi"),
    (b"RIFF", 8, b"WEBP", ".webp"),
    (b"\x89PNG\r\n\x1a\n", None, None, ".png"),
    (b"\xff\xd8\xff", None, None, ".jpg"),
)


def _sniffed_media_suffix(data: bytes, *, audio: bool) -> str:
    """The container a blob actually is, or "" when nothing matches."""
    for prefix, offset, marker, suffix in _MEDIA_MAGIC:
        if not data.startswith(prefix):
            continue
        if marker is not None and data[offset:offset + len(marker)] != marker:
            continue
        return suffix
    # ISO-BMFF (mp4/m4a/mov/3gp) puts its brand at byte 4, so the family is
    # only distinguishable by intent: the same box carries audio and video.
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return ".m4a" if audio else ".mp4"
    # A bare MPEG audio frame has no header at all, only a sync word.
    if audio and len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return ".mp3"
    return ""


_PRIVATE_MEDIA_SUFFIX = ".zenc"


def _private_media_sidecar(path: Path) -> Path:
    return private_media_sidecar(path)


def _encrypt_private_media(
    path: Path,
    cipher: PrivateFieldCipher,
    *,
    scope: str = "media-studio-output",
) -> bool:
    return encrypt_private_media(path, scope=scope, cipher=cipher)


def _private_media_exists(path: Path) -> bool:
    return private_media_exists(path)


def _read_private_media(
    path: Path,
    cipher: PrivateFieldCipher,
    *,
    scope: str = "media-studio-output",
) -> bytes:
    return read_private_media(path, scope=scope, cipher=cipher)


E2E_REQUESTER_HEADER = "X-E2E-Requester-Pub"


def _requester_pub(request: Request) -> str:
    """The caller's own E2E public key, if it presented one.

    A browser that holds a device key sends it here, and this server does
    nothing with it but pass it on: generated media is sealed to that key by
    the gateway, so a clip belongs to the device that asked for it rather than
    to whichever process happened to relay the request. Absent header means the
    caller has no key of its own and the owner vault is the only recipient."""
    return normalized_requester_pub(request.headers.get(E2E_REQUESTER_HEADER))


def _e2e_envelope_response(envelope: bytes) -> Response:
    """Serve a client-only E2E envelope verbatim. The browser detects it via
    X-E2E-Media/Content-Type and decrypts with the vault private key; the server
    holds no key. Mirrors the media-gateway send_output_file headers."""
    return Response(
        content=envelope,
        media_type="application/vnd.hivemind.e2e+json",
        headers={
            "X-E2E-Media": "1",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _private_media_response(body: bytes, *, media_type: str, range_header: str = "") -> Response:
    total = len(body)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": str(total),
        "X-Content-Type-Options": "nosniff",
    }
    if range_header:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if match:
            start_text, end_text = match.groups()
            if start_text or end_text:
                if not start_text:
                    suffix_length = int(end_text)
                    start = max(total - suffix_length, 0)
                    end = total - 1
                else:
                    start = int(start_text)
                    end = min(int(end_text), total - 1) if end_text else total - 1
                if start >= total or start > end:
                    return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
                body = body[start:end + 1]
                headers["Content-Range"] = f"bytes {start}-{end}/{total}"
                headers["Content-Length"] = str(len(body))
                return Response(content=body, status_code=206, media_type=media_type, headers=headers)
    return Response(content=body, media_type=media_type, headers=headers)


def _public_media_studio_qa(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    allowed = {
        "ok",
        "size_bytes",
        "duration_seconds",
        "width",
        "height",
        "video_codec",
        "audio_codecs",
        "visual_inspection_required",
        "failures",
    }
    return {key: value[key] for key in allowed if key in value}


def _remove_media_studio_qa_artifacts(value: object, output_root: Path) -> None:
    if not isinstance(value, dict) or not value.get("representative_frame"):
        return
    frame = Path(str(value["representative_frame"])).expanduser().resolve()
    qa_root = (output_root / "qa").resolve()
    if not frame.is_relative_to(qa_root):
        return
    with contextlib.suppress(FileNotFoundError):
        frame.unlink()
    with contextlib.suppress(OSError):
        frame.parent.rmdir()


def _public_media_studio_result(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    payload: dict[str, Any] = {}
    job_id = str(value.get("job_id") or value.get("id") or "").strip()
    if job_id:
        payload["job_id"] = job_id
        payload["id"] = job_id
    provider = str(value.get("provider") or "Media Studio").strip()
    if provider:
        payload["provider"] = provider[:160]
    return payload


def _write_inline_media(
    value: str,
    destination_dir: Path,
    *,
    field_name: str,
    mime_suffixes: dict[str, str],
    default_suffix: str,
    max_bytes: int,
    label: str = "",
) -> Path:
    # ``label`` is what the owner sees ("Picture 2", "Motion clip 1"); the
    # field name is the wire name and only stands in when no label was given.
    what = label or field_name
    raw = value.strip()
    if not raw:
        raise ValueError(f"{what} is required")
    suffix = default_suffix
    encoded = raw
    mime = ""
    if raw.startswith("data:"):
        header, separator, body = raw.partition(",")
        if not separator:
            raise ValueError(f"{what} is not a valid data URL (missing its comma separator)")
        mime = header.removeprefix("data:").split(";", 1)[0].lower()
        suffix = mime_suffixes.get(mime, "")
        encoded = body
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{what} is not valid base64") from exc
    if not suffix:
        # The label is one we do not know. Ask the bytes before refusing: a
        # media type is what the client CALLS the file, and recorders invent
        # spellings ("audio/mp4a-latm" for ordinary AAC). Rejecting on the
        # label alone throws away a perfectly decodable clip.
        suffix = _sniffed_media_suffix(data, audio=field_name.startswith("audio"))
    if not suffix:
        raise ValueError(
            f"{what} has an unsupported media type ({mime or 'unknown'}) "
            f"and its contents are not a recognised media container"
        )
    if not data:
        raise ValueError(f"{what} decoded to an empty file")
    if len(data) > max_bytes:
        raise ValueError(f"{what} is too large; max {max_bytes // 1024 // 1024} MB")
    destination_dir.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix="media-studio-input-", suffix=suffix, dir=destination_dir)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    return Path(filename)
