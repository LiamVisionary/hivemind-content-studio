"""The MUAPI proxy: status, catalog and the forwarded call.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from .. import muapi_catalog, muapi_proxy
from ..media_studio import sanitize_error_detail


def register(app, ctx) -> None:
    """Register the MUAPI status, catalog and forwarding routes."""
    router = APIRouter()
    require_owner = ctx.require_owner

    @router.get("/api/muapi/status", dependencies=[Depends(require_owner)])
    def muapi_status() -> dict:
        """Does this machine hold the MUAPI key?

        Presence only — never the value. The browser asks this to decide whether
        to route through here or fall back to a key of its own, which is what
        lets a machine that already has the key stop asking for one.
        """
        return {"ok": True, "server_key": muapi_proxy.has_server_key()}

    # Registered BEFORE the {path:path} forwarder below, which would otherwise
    # swallow this and try to reach `api/v1/…/catalog` upstream.
    @router.get("/api/muapi/catalog", dependencies=[Depends(require_owner)])
    def muapi_catalog_route() -> dict:
        """The cloud model catalog the Image, Video and Lip sync studios render.

        One catalog, not two: this is the same list the producer's MUAPI rows are
        built from, so the client and the server can no longer name different
        models for the same provider. Answers from the shipped rows immediately
        and folds in live provider schemas once a background read has landed —
        see muapi_catalog for why that read may only update inputs a row already
        declares.
        """
        try:
            return muapi_catalog.catalog_payload()
        except muapi_catalog.MuapiCatalogError as exc:
            raise HTTPException(status_code=500, detail=sanitize_error_detail(str(exc))) from exc

    @router.api_route(
        "/api/muapi/{path:path}",
        methods=["GET", "POST", "PUT", "DELETE"],
        dependencies=[Depends(require_owner)],
    )
    async def muapi_forward(path: str, request: Request) -> Response:
        """Forward the studio's MUAPI calls with this machine's key attached.

        A proxy rather than a re-implementation: the browser client owns the
        poll cadence, the request-id contract a reload resumes from, and MUAPI's
        detail-envelope failures. Rewriting that server-side would be a second
        copy to keep in step.
        """
        body = await request.body()
        try:
            status, payload, headers = await asyncio.to_thread(
                muapi_proxy.forward,
                method=request.method,
                path=path,
                query=str(request.url.query or ""),
                body=body or None,
                headers=dict(request.headers),
            )
        except muapi_proxy.MuapiProxyError as exc:
            # 400, not 502: every one of these is something the owner can act on
            # — add the key, or ask for a path that exists.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        media_type = headers.pop("Content-Type", None) or headers.pop("content-type", None) or "application/json"
        return Response(content=payload, status_code=status, media_type=media_type, headers=headers)

    app.include_router(router)
