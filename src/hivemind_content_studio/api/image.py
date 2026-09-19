"""Stills: generating one, and keeping a cloud result like a local render.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import math
import mimetypes
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from .. import image_router
from ..private_access import e2e_media_exists, seal_private_media_e2e
from .cloud_output import cloud_output_suffix
from .media_common import _encrypt_private_media, _private_media_exists
from .models import CloudOutputAdoptBody, HostedMediaInputBody, HostedMediaQuoteBody, StudioImageBody


# What a hosted model can be handed as a starting picture. Mirrors the
# gateway's own list; refusing here means the refusal names the file rather
# than arriving as an HTTP 415 from a Worker.
_REFERENCE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_REFERENCE_MAX_BYTES = 64 * 1024 * 1024


class _Reference:
    """The two fields _decode_reference reads, for a caller that has its own
    field names."""

    def __init__(self, reference_base64: str, reference_type: str) -> None:
        self.reference_base64 = reference_base64
        self.reference_type = reference_type


def _decode_reference(body) -> tuple[bytes, str] | None:
    """The attached picture, as bytes and a type the provider can read."""
    encoded = (getattr(body, "reference_base64", "") or "").strip()
    if not encoded:
        return None
    kind = (getattr(body, "reference_type", "") or "").split(";")[0].strip().lower()
    # A data: URL is what a browser has to hand; take either shape.
    if encoded.startswith("data:"):
        header, _, tail = encoded.partition(",")
        kind = kind or header[5:].split(";")[0].strip().lower()
        encoded = tail
    if kind not in _REFERENCE_TYPES:
        raise ValueError(f"{kind or 'That file type'} cannot be sent to a hosted model")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("The attached reference could not be read") from exc
    if not raw:
        raise ValueError("The attached reference is empty")
    if len(raw) > _REFERENCE_MAX_BYTES:
        raise ValueError(f"A hosted reference must be {_REFERENCE_MAX_BYTES // (1024 * 1024)} MB or smaller")
    return raw, kind


def register(app, ctx) -> None:
    """Register the image, adopt and gateway-media routes."""
    router = APIRouter()
    _forget_canvas_sync = ctx._forget_canvas_sync
    _vault_public_key = ctx._vault_public_key
    canvas_store = ctx.canvas_store
    cipher = ctx.cipher
    current_account = ctx.current_account
    fetch_canvas_media = ctx.fetch_canvas_media
    fetch_cloud_result = ctx.fetch_cloud_result
    gateway_claims = ctx.gateway_claims
    outputs_root = ctx.outputs_root
    require_owner = ctx.require_owner

    @router.post("/api/media-studio/image", dependencies=[Depends(require_owner)])
    async def generate_studio_image(body: StudioImageBody, request: Request) -> dict:
        """Render one still through whichever provider the studio picked.

        The dispatch itself lives in image_router, so this route holds no
        opinion about which credential belongs to which provider — the failure
        being designed out is a studio that treats "not local" as "MUAPI" and
        bills the wrong account for a model of the same name.
        """
        name = f"studio-{uuid.uuid4().hex[:12]}.png"
        output = outputs_root() / name
        started = time.perf_counter()
        try:
            reference = _decode_reference(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"message": str(exc), "remedy": "", "provider": ""}) from exc
        try:
            result = await asyncio.to_thread(
                image_router.render_image,
                provider=body.provider.strip(),
                model=body.model.strip(),
                prompt=body.prompt.strip(),
                aspect_ratio=body.aspect_ratio.strip() or "1:1",
                output=output,
                quality=body.quality.strip(),
                seed=body.seed,
                reference=reference,
                reference_url=body.reference_url.strip(),
                maximum_debit_usd=float(body.maximum_debit_usd or 1.0),
            )
        except ValueError as exc:
            # A model that cannot start from what is attached, an oversized
            # reference, a quote above the approved ceiling: all of them are
            # sentences the person can act on, not 500s.
            raise HTTPException(status_code=400, detail={"message": str(exc), "remedy": "", "provider": ""}) from exc
        except image_router.ImageRouterError as exc:
            # The remedy travels WITH the failure so the studio can offer the
            # button instead of printing the provider's sentence.
            raise HTTPException(status_code=400, detail={
                "message": str(exc),
                "remedy": getattr(exc, "remedy", ""),
                "provider": getattr(exc, "provider", ""),
            }) from exc
        # The MCP names its own file; everything else wrote to `output`.
        landed = Path(str(result.get("output") or output)).resolve()
        root = outputs_root().resolve()
        if not landed.is_relative_to(root) or not landed.is_file():
            raise HTTPException(status_code=502, detail="The provider returned no image")
        # Same sealing as every other generated output: client-only E2E when the
        # signed-in account has a vault, the legacy cipher when it does not.
        spki = _vault_public_key()
        if spki:
            seal_private_media_e2e(landed, spki, media_type=mimetypes.guess_type(landed.name)[0] or "image/png")
        else:
            _encrypt_private_media(landed, cipher)
        return {
            "ok": True,
            "provider": result.get("provider") or body.provider,
            "model": result.get("model") or body.model,
            "output": landed.name,
            "url": f"/api/media-studio/generated/{urllib.parse.quote(landed.name)}",
            "seconds": round(time.perf_counter() - started, 3),
        }

    @router.post("/api/media-studio/hosted-input", dependencies=[Depends(require_owner)])
    async def store_hosted_input(body: HostedMediaInputBody) -> dict:
        """Put one local picture where a hosted provider can fetch it.

        The browser holds its references sealed and a provider fetches by URL,
        so the bytes are decrypted in the page, sent here, and forwarded to
        the gateway's input store — which holds them under an unguessable
        name for a day. The page uploads once per picture and caches the URL,
        so a second press on the same reference sends nothing.
        """
        from ..hivemindos_hosted_media import upload_input

        try:
            raw, kind = _decode_reference(_Reference(body.data_base64, body.content_type))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
        try:
            url = await asyncio.to_thread(upload_input, raw, content_type=kind)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail={"message": str(exc)}) from exc
        return {"ok": True, "url": url}

    @router.post("/api/media-studio/hosted-quote", dependencies=[Depends(require_owner)])
    async def quote_hosted_media(body: HostedMediaQuoteBody) -> dict:
        """What the press about to be made would cost, in USD and in credits.

        Read-only and free: the gateway's quote route takes no credential and
        reserves nothing. It exists because the studio has no honest number
        without it — the catalogue prices ten of 538 endpoints, and even those
        move with duration and resolution.
        """
        from ..hivemindos_hosted_media import hosted_media_quote, hosted_route_for

        payload: dict = {"prompt": body.prompt.strip() or "a photograph", "aspect_ratio": body.aspect_ratio.strip() or "1:1"}
        if body.duration_seconds:
            payload["duration"] = body.duration_seconds
        if body.resolution.strip():
            payload["resolution"] = body.resolution.strip()
        # An image-to-* endpoint prices the same whatever the picture is, and
        # the quote route does not fetch it, so a placeholder keeps a price
        # visible before anything is attached or uploaded.
        if body.attached != "none":
            payload[f"{body.attached}_url"] = "https://hivemindos.app/placeholder"
        try:
            endpoint, capability = await asyncio.to_thread(
                hosted_route_for, body.model.strip(), kind=body.kind, attached=body.attached)
            quote = await asyncio.to_thread(hosted_media_quote, model=endpoint, payload=payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"message": str(exc)}) from exc
        except RuntimeError as exc:
            # No price is not a failed press; the button says "price unknown"
            # and the run still quotes itself before it spends.
            raise HTTPException(status_code=503, detail={"message": str(exc)}) from exc
        usd = float(quote.get("priceUsd") or quote.get("retailUsd") or 0)
        return {
            "ok": True,
            "model": endpoint,
            "capability": capability,
            "usd": usd,
            # The ONE conversion both apps use (media-model-catalog.v1).
            "credits": math.ceil(usd * 500) if usd > 0 else 0,
            "category": str(quote.get("category") or ""),
        }

    @router.post("/api/media-studio/adopt", dependencies=[Depends(require_owner)])
    async def adopt_cloud_output(body: CloudOutputAdoptBody) -> dict:
        """Keep a finished cloud result the way a local render is kept.

        A provider that renders in its own cloud returns a URL that expires, so
        until this route existed a lip sync, a Cinema shot and every cloud image
        lived in one browser tab and nowhere else: close the window and minutes
        of paid work were gone with no warning that they would be. The bytes are
        fetched here, sealed with the SAME key path as generate_studio_image
        (client-only E2E when this account has a vault, the legacy cipher when
        it does not), written under this workspace's outputs root, and indexed
        in this workspace's History — so the result is listed in the Library
        beside every local one instead of being remembered by the tab.

        Not /api/media-studio/references: that store is the reference PICKER's,
        and an output filed there would be offered as an input and never listed
        as work. The output is claimed for the account in scope, so the boundary
        AGENTS.md draws around one workspace's media holds here too.
        """
        # Checked before the fetcher, not inside it: an address this machine
        # will not open should be refused whoever is doing the downloading.
        if urllib.parse.urlparse(body.url.strip()).scheme not in ("http", "https"):
            raise HTTPException(status_code=400, detail="That result address is not one this machine can fetch.")
        try:
            payload, served_type = await asyncio.to_thread(fetch_cloud_result, body.url.strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        name = f"cloud-{uuid.uuid4().hex[:12]}{cloud_output_suffix(body.url, served_type, body.kind)}"
        output = (outputs_root() / name).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(payload)
        spki = _vault_public_key()
        if spki:
            media_type = mimetypes.guess_type(name)[0] or served_type or "application/octet-stream"
            seal_private_media_e2e(output, spki, media_type=media_type)
        else:
            _encrypt_private_media(output, cipher)
        if not (_private_media_exists(output) or e2e_media_exists(output)):
            raise HTTPException(status_code=500, detail="That result could not be secured on this machine.")
        # Indexed directly rather than waiting for a sync: the gateway walks its
        # own output roots and has never heard of this one, so a result adopted
        # here would otherwise never appear in the Library it was saved for.
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        canvas_store().sync([{
            "id": f"cloud-{name}",
            "status": "success",
            "created_at": stamp,
            "finished_at": stamp,
            "outputs": [str(output)],
            "timestamp_source": "gateway-history",
        }])
        scope = current_account.get()
        if scope is not None:
            gateway_claims.claim_output(name, scope.id)
        _forget_canvas_sync()
        return {
            "ok": True,
            "output": name,
            "url": f"/api/media-studio/generated/{urllib.parse.quote(name)}",
            "encrypted_at_rest": True,
            "kind": body.kind,
            **({"model": body.model} if body.model else {}),
            **({"provider": body.provider} if body.provider else {}),
        }

    @router.get("/api/media-studio/gateway/{output_name}", response_class=Response, dependencies=[Depends(require_owner)])
    def media_studio_gateway_media(output_name: str) -> Response:
        name = Path(output_name).name
        if not name or name != output_name:
            raise HTTPException(status_code=400, detail="A bare output filename is required")
        try:
            content, media_type = fetch_canvas_media(name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        return Response(content=content, media_type=media_type, headers={"Cache-Control": "private, no-store"})

    app.include_router(router)
