"""Saved references and finished outputs, sealed at rest.

Moved out of control_api.py unchanged (2026-09-04). The three inline-media
writers stay in control_api.py because the size ceilings they read are
patched there by name; this module binds them off it.
"""

from __future__ import annotations

import asyncio
import contextlib
import mimetypes
import secrets
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from .. import media_posters
from ..private_access import (
    e2e_media_exists,
    e2e_media_sidecar,
    read_e2e_envelope,
    seal_private_media_e2e,
)
from .media_common import (
    _e2e_envelope_response,
    _encrypt_private_media,
    _INLINE_AUDIO_SUFFIXES,
    _INLINE_IMAGE_SUFFIXES,
    _INLINE_VIDEO_SUFFIXES,
    _private_media_exists,
    _private_media_response,
    _private_media_sidecar,
    _PRIVATE_MEDIA_SUFFIX,
    _read_private_media,
)


def register(app, ctx) -> None:
    """Register the reference library and generated-output routes."""
    router = APIRouter()
    cp = ctx.control_api
    _generated_output_response = ctx._generated_output_response
    _vault_public_key = ctx._vault_public_key
    cipher = ctx.cipher
    outputs_root = ctx.outputs_root
    references_root = ctx.references_root
    require_owner = ctx.require_owner

    def _reference_kind_for_suffix(suffix: str) -> str:
        """image / video / audio from the stored extension. The listing route
        classifies the same way; both read the same MIME tables."""
        value = str(suffix).lower()
        if value in set(_INLINE_VIDEO_SUFFIXES.values()):
            return "video"
        if value in set(_INLINE_AUDIO_SUFFIXES.values()):
            return "audio"
        return "image"

    def _build_reference_poster(reference: Path, *, kind: str) -> Path | None:
        # Never let a thumbnail failure fail an upload: the reference is the
        # point, the poster is a nicety, and the browser can still decode one.
        try:
            return media_posters.build_reference_poster(reference, kind=kind)
        except Exception:
            return None

    def _seal_reference_poster(poster: Path, spki: str | None) -> None:
        if not poster.is_file():
            return
        if spki:
            seal_private_media_e2e(poster, spki, media_type=media_posters.POSTER_MEDIA_TYPE)
        else:
            _encrypt_private_media(poster, cipher, scope="media-studio-reference")

    def _remove_reference_poster(poster: Path) -> None:
        for candidate in (poster, e2e_media_sidecar(poster), _private_media_sidecar(poster)):
            with contextlib.suppress(FileNotFoundError, OSError):
                candidate.unlink()

    def _reference_poster_url(reference: Path) -> str | None:
        poster = media_posters.poster_path_for(reference)
        if not (_private_media_exists(poster) or e2e_media_exists(poster)):
            return None
        return f"/api/media-studio/references/{urllib.parse.quote(poster.name)}"

    @router.post("/api/media-studio/references", dependencies=[Depends(require_owner)])
    async def upload_media_studio_reference(file: UploadFile = File(...)) -> dict:
        content_type = str(file.content_type or "").split(";", 1)[0].strip().lower()
        # Voice clips join pictures and clips here: H3 Reference mode conditions
        # on all three, and each is sealed to the owner vault the same way.
        mime_suffixes = {**_INLINE_IMAGE_SUFFIXES, **_INLINE_VIDEO_SUFFIXES, **_INLINE_AUDIO_SUFFIXES}
        suffix = mime_suffixes.get(content_type)
        if not suffix:
            candidate = Path(str(file.filename or "")).suffix.lower()
            if candidate in set(mime_suffixes.values()):
                suffix = candidate
        if not suffix:
            raise HTTPException(status_code=415, detail="Reference must be a supported image, video, or audio clip")
        is_video = content_type in _INLINE_VIDEO_SUFFIXES or suffix in set(_INLINE_VIDEO_SUFFIXES.values())
        is_audio = content_type in _INLINE_AUDIO_SUFFIXES or suffix in set(_INLINE_AUDIO_SUFFIXES.values())
        max_bytes = (
            cp._MAX_PRIVATE_VIDEO_BYTES if is_video
            else cp._MAX_PRIVATE_AUDIO_BYTES if is_audio
            else cp._MAX_PRIVATE_IMAGE_BYTES
        )
        body = await file.read(max_bytes + 1)
        await file.close()
        if not body:
            raise HTTPException(status_code=400, detail="Media reference is empty")
        if len(body) > max_bytes:
            raise HTTPException(status_code=413, detail=f"Media reference is too large; max {max_bytes // 1024 // 1024} MB")

        def _store(suffix: str) -> dict[str, Any]:
            """Write, transcode, poster and seal — in a worker thread. A 100 MB
            clip's HEIC decode, ffmpeg poster and sealing used to run on the
            event loop, where every other tab's job poll queued behind it."""
            references_root().mkdir(parents=True, exist_ok=True)
            name = f"reference-{secrets.token_hex(16)}{suffix}"
            reference = (references_root() / name).resolve()
            reference.write_bytes(body)
            # An iPhone HEIC is stored as a JPEG: the browser has no HEIC decoder
            # (so the tile drew broken) and neither does the lane's ComfyUI (so the
            # run would have failed at LoadImage). Like the poster below, this can
            # only happen NOW, while the plaintext is still here. A HEIC that will
            # not decode is kept as uploaded — today's behaviour, never a lost upload.
            transcoded = media_posters.transcode_opaque_image(reference)
            if transcoded is not None:
                reference = transcoded
                name = reference.name
                suffix = reference.suffix
            # Build the thumbnail NOW, while the plaintext is still here. Once sealed
            # the host can never read this file again, so this is the only moment a
            # poster can be made server-side — and without one, drawing a 32px tile
            # costs the browser the whole asset.
            poster = _build_reference_poster(reference, kind=_reference_kind_for_suffix(suffix))
            # Seal to the owner vault (client-only E2E) so this host holds no decrypt
            # key. Reuse is client-side: the browser decrypts and re-sends base64 (the
            # server can no longer stage a sealed reference). Legacy Keychain .zenc is
            # only a no-vault fallback.
            spki = _vault_public_key()
            try:
                if spki:
                    media_type = mimetypes.guess_type(reference.name)[0] or "image/png"
                    seal_private_media_e2e(reference, spki, media_type=media_type)
                else:
                    _encrypt_private_media(reference, cipher, scope="media-studio-reference")
                # The poster is sealed the same way, so the privacy contract is
                # unchanged: the host keeps no readable copy of either.
                if poster is not None:
                    _seal_reference_poster(poster, spki)
            except Exception as exc:
                with contextlib.suppress(FileNotFoundError):
                    reference.unlink()
                with contextlib.suppress(FileNotFoundError):
                    e2e_media_sidecar(reference).unlink()
                if poster is not None:
                    _remove_reference_poster(poster)
                raise HTTPException(status_code=503, detail="Reference image could not be secured") from exc
            if not (_private_media_exists(reference) or e2e_media_exists(reference)):
                raise HTTPException(status_code=503, detail="Reference image could not be secured")
            url = f"/api/media-studio/references/{urllib.parse.quote(name)}"
            return {
                "ok": True,
                "url": url,
                "encrypted_at_rest": True,
                "poster_url": _reference_poster_url(reference),
            }

        # to_thread copies the request's context, so the account-scoped roots
        # and the vault key resolve to the same workspace inside the worker.
        return await asyncio.to_thread(_store, suffix)

    @router.post("/api/media-studio/references/{filename}/poster", dependencies=[Depends(require_owner)])
    async def upload_media_studio_reference_poster(filename: str, file: UploadFile = File(...)) -> dict:
        """Browser-supplied poster for a reference sealed before posters existed.

        The host cannot build one itself for those — it has no vault key, so it
        cannot read them. The browser already decrypts the clip to display it,
        so it is the only party that can, and it sends back the one frame it
        decoded. Sealed here like any other reference; still owner-gated, still
        never readable by this host afterwards.
        """
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root) or media_posters.is_poster_name(name):
            raise HTTPException(status_code=404, detail="Reference not found")
        if not (_private_media_exists(reference) or e2e_media_exists(reference)):
            raise HTTPException(status_code=404, detail="Reference not found")
        poster = media_posters.poster_path_for(reference)
        if _private_media_exists(poster) or e2e_media_exists(poster):
            return {"ok": True, "poster_url": _reference_poster_url(reference), "existed": True}
        body = await file.read(media_posters.MAX_POSTER_BYTES + 1)
        await file.close()
        if not body:
            raise HTTPException(status_code=400, detail="Poster is empty")
        if len(body) > media_posters.MAX_POSTER_BYTES:
            raise HTTPException(status_code=413, detail="Poster is too large to be a thumbnail")
        # A poster is a JPEG and nothing else — this route must not become a way
        # to park arbitrary bytes in the reference store under a chosen name.
        if not body.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=415, detail="Poster must be a JPEG")
        poster.write_bytes(body)
        try:
            _seal_reference_poster(poster, _vault_public_key())
        except Exception as exc:
            _remove_reference_poster(poster)
            raise HTTPException(status_code=503, detail="Poster could not be secured") from exc
        return {"ok": True, "poster_url": _reference_poster_url(reference), "existed": False}

    @router.get("/api/media-studio/references/{filename}", dependencies=[Depends(require_owner)])
    def media_studio_reference(filename: str, request: Request) -> Response:
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Reference image not found")
        # Client-only E2E envelope (re-sealed reference): serve verbatim for the
        # browser to decrypt for display.
        envelope = read_e2e_envelope(reference)
        if envelope is not None:
            return _e2e_envelope_response(envelope)
        if not _private_media_exists(reference):
            raise HTTPException(status_code=404, detail="Reference image not found")
        try:
            body = _read_private_media(reference, cipher, scope="media-studio-reference")
        except ValueError as exc:
            raise HTTPException(status_code=503, detail="Reference image could not be decrypted") from exc
        media_type = mimetypes.guess_type(reference.name)[0] or "image/png"
        return _private_media_response(body, media_type=media_type, range_header=request.headers.get("range", ""))

    @router.delete("/api/media-studio/references/{filename}", dependencies=[Depends(require_owner)])
    def delete_media_studio_reference(filename: str) -> dict:
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Reference image not found")
        removed = False
        for candidate in (reference, _private_media_sidecar(reference), e2e_media_sidecar(reference)):
            if candidate.is_file():
                candidate.unlink()
                removed = True
        # The poster goes with it — an orphan would linger in the store forever,
        # since nothing else knows the reference it belonged to is gone.
        _remove_reference_poster(media_posters.poster_path_for(reference))
        if not removed:
            raise HTTPException(status_code=404, detail="Reference image not found")
        return {"ok": True}

    @router.get("/api/media-studio/references", dependencies=[Depends(require_owner)])
    def list_media_studio_references() -> dict:
        # Enumerate the owner's saved reference uploads so past uploads reappear in
        # the picker even when the browser's composer state is empty (fresh browser,
        # cleared state). Each stays E2E: the URL points at the .e2e envelope route,
        # which the browser decrypts for display — this host never decrypts them.
        root = references_root()
        newest: dict[str, float] = {}
        # Posters live beside their reference and are NOT references themselves —
        # listing one would offer the user a thumbnail as if it were a picture
        # they could condition on. Indexed by stem so each attaches to its owner.
        posters: dict[str, str] = {}
        if root.is_dir():
            for path in root.iterdir():
                if not path.is_file():
                    continue
                base = path.name
                for suffix in (".e2e", _PRIVATE_MEDIA_SUFFIX):
                    if base.endswith(suffix):
                        base = base[: -len(suffix)]
                        break
                if not base.startswith("reference-"):
                    continue
                owner_stem = media_posters.poster_owner_stem(base)
                if owner_stem is not None:
                    posters[owner_stem] = base
                    continue
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if base not in newest or mtime > newest[base]:
                    newest[base] = mtime
        def reference_kind(name: str) -> str:
            suffix = Path(name).suffix.lower()
            if suffix in set(_INLINE_VIDEO_SUFFIXES.values()):
                return "video"
            if suffix in set(_INLINE_AUDIO_SUFFIXES.values()):
                return "audio"
            return "image"

        def poster_url_for(base: str) -> str | None:
            poster = posters.get(Path(base).stem)
            return f"/api/media-studio/references/{urllib.parse.quote(poster)}" if poster else None

        references = [
            {
                "name": base,
                "url": f"/api/media-studio/references/{urllib.parse.quote(base)}",
                "timestamp": mtime,
                # Pickers filter on this: a saved voice clip has no business in
                # the picture grid, and its thumbnail would never resolve.
                "kind": reference_kind(base),
                # A few KB to draw a tile with, instead of the whole sealed
                # asset. None for references sealed before posters existed (the
                # host cannot read those) and for voice clips (nothing to show);
                # the browser falls back to decrypting, and backfills a poster.
                "poster_url": poster_url_for(base),
            }
            for base, mtime in sorted(newest.items(), key=lambda item: item[1], reverse=True)
        ]
        return {"ok": True, "references": references}

    @router.get("/api/media-studio/generated/{filename}", dependencies=[Depends(require_owner)])
    def media_studio_generated_video(filename: str, request: Request) -> Response:
        name = Path(filename).name
        output = (outputs_root() / name).resolve()
        root = outputs_root().resolve()
        if name != filename or not output.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Generated video not found")
        return _generated_output_response(output, request)

    app.include_router(router)
