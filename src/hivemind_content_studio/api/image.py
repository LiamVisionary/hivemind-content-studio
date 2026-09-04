"""Stills: generating one, and keeping a cloud result like a local render.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio
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
from .models import CloudOutputAdoptBody, StudioImageBody


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
            result = await asyncio.to_thread(
                image_router.render_image,
                provider=body.provider.strip(),
                model=body.model.strip(),
                prompt=body.prompt.strip(),
                aspect_ratio=body.aspect_ratio.strip() or "1:1",
                output=output,
                quality=body.quality.strip(),
                seed=body.seed,
            )
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
