"""The shared media-model catalog, served to HivemindOS and to agents.

``GET /api/media-models`` is the sixth read on the machine lane: a caller with
no browser session — HivemindOS chat building its /image-gen picker, an agent
on this machine — reads it to learn which image and video models this studio
can reach, where each runs and what it costs. It is a projection of the media
inventory the simple catalog already caches for the studio's own pickers, in
the vocabulary both apps share (see ``docs/MEDIA_MODEL_CATALOG.md``). No
probe runs for this request: the readiness sweep behind the inventory belongs
to the simple catalog's refresh thread, warmed at boot and re-run past its
TTL, and this route only asks that thread to run when the cache is old.

Before the first sweep has landed the route answers ``pending`` with an empty
(still valid) document and ``Retry-After``, exactly as ``/api/simple/catalog``
does, rather than building inline: a cold sweep takes longer than HivemindOS
waits for a read, and an answer that says "come back" beats a timeout. Every
fresh projection also writes the snapshot HivemindOS reads while the studio is
closed.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..media_models import KINDS, empty_catalog, media_model_catalog, write_snapshot
from ..media_studio import sanitize_error_detail


def register(app, ctx) -> None:
    """Register the media-model catalog route."""
    router = APIRouter()
    simple_catalog_cache = ctx.simple_catalog_cache
    kick_simple_catalog_refresh = ctx.kick_simple_catalog_refresh
    ttl_seconds = ctx.simple_catalog_ttl_seconds

    # The projection of the inventory the simple catalog last built, keyed by
    # that build's stamp so it is redone once per sweep, not once per request.
    projection: dict[str, Any] = {"payload": None, "at": None}
    projecting = threading.Lock()

    def _narrowed(document: dict, kind: str) -> dict:
        if not kind:
            return document
        return {**document, "models": [row for row in document["models"] if row.get("kind") == kind]}

    @router.get("/api/media-models")
    def media_models(response: Response, kind: str = "") -> dict:
        wanted = kind.strip().lower()
        if wanted and wanted not in KINDS:
            raise HTTPException(status_code=400, detail="kind must be image or video")
        cached = simple_catalog_cache["payload"]
        media = cached.get("media") if isinstance(cached, dict) else None
        if not isinstance(media, dict):
            # Nothing built yet. Make sure a build is under way and say when
            # to come back; the empty document is valid so a client that does
            # not read `pending` still gets a catalog, just an empty one.
            kick_simple_catalog_refresh()
            response.headers["Retry-After"] = "2"
            return {"ok": True, "pending": True, "catalog": empty_catalog()}
        if time.time() - simple_catalog_cache["at"] > ttl_seconds:
            kick_simple_catalog_refresh()
        stamp = simple_catalog_cache["at"]
        if projection["at"] != stamp:
            with projecting:
                if projection["at"] != stamp:
                    try:
                        document = media_model_catalog(inventory=media)
                    except Exception as exc:  # noqa: BLE001 — the sentence, not the traceback
                        raise HTTPException(
                            status_code=503,
                            detail=f"The media model catalog could not be built: {sanitize_error_detail(str(exc))}",
                        ) from None
                    write_snapshot(document)
                    projection.update(payload=document, at=stamp)
        return {"ok": True, "catalog": _narrowed(projection["payload"], wanted)}

    app.include_router(router)
