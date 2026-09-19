"""What the local lanes are holding, and the ComfyUI a lane is attached to.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .. import comfy_connect, comfy_lanes
from ..media_studio import sanitize_error_detail
from .models import ComfyAttachBody, ComfyDetachBody, LaneFreeBody

log = logging.getLogger("hivemind.studio.control")


def register(app, ctx) -> None:
    """Register the lane memory and ComfyUI attachment routes."""
    router = APIRouter()
    require_owner = ctx.require_owner
    shutting_down = ctx.shutting_down

    # A lane holding a finished job's models is the thing that makes the next
    # local generation wait (or, at the gateway's admission check, time out), so
    # the studios surface it and offer Comfy's own /free. Owner-gated: this
    # reaches into the machine's running services.
    # Every open studio polls this every 20s, and a build is not cheap: per lane
    # an `lsof -ti :port` and a `ps`, an HTTP /queue with a 3s ceiling, and then
    # a `vm_stat`. One snapshot serves every poller for ten seconds, and the
    # rebuild happens on a background thread so no request waits for the process
    # spawning — the same serve-stale-and-refresh shape as the catalog above.
    # Deliberately kicked BY a request rather than run on a timer: a machine
    # nobody is watching should be spawning nothing at all.
    lanes_memory_cache: dict[str, Any] = {"payload": None, "at": 0.0}
    lanes_memory_refreshing = threading.Event()
    LANES_MEMORY_TTL_SECONDS = 10.0

    def _build_lanes_memory() -> dict:
        return {"ok": True, **comfy_lanes.snapshot()}

    def _refresh_lanes_memory() -> None:
        try:
            lanes_memory_cache.update(payload=_build_lanes_memory(), at=time.time())
        except Exception as exc:  # noqa: BLE001 — a hint is not worth a 500
            log.warning("lane memory refresh failed: %s", sanitize_error_detail(str(exc)))
            lanes_memory_cache["at"] = time.time()
        finally:
            lanes_memory_refreshing.clear()

    def _kick_lanes_memory_refresh() -> None:
        if lanes_memory_refreshing.is_set() or shutting_down.is_set():
            return
        lanes_memory_refreshing.set()
        threading.Thread(target=_refresh_lanes_memory, name="lane-memory-refresh", daemon=True).start()

    @router.get("/api/lanes/memory", dependencies=[Depends(require_owner)])
    def lanes_memory() -> dict:
        cached = lanes_memory_cache["payload"]
        if cached is None:
            payload = _build_lanes_memory()
            lanes_memory_cache.update(payload=payload, at=time.time())
            return payload
        if time.time() - lanes_memory_cache["at"] > LANES_MEMORY_TTL_SECONDS:
            _kick_lanes_memory_refresh()
        return lanes_memory_cache["payload"] or cached

    @router.post("/api/lanes/free", dependencies=[Depends(require_owner)])
    def lanes_free(body: LaneFreeBody) -> dict:
        try:
            freed = comfy_lanes.free_lane(body.lane)
        except comfy_lanes.LaneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # free_lane already carries a fresh snapshot; stamping it here stops the
        # next poll from reporting the memory this call just gave back.
        lanes_memory_cache.update(
            payload={"ok": True, **{k: v for k, v in freed.items() if k not in ("lane", "freedBytes")}},
            at=time.time(),
        )
        return freed

    # ComfyUI is an OPTIONAL engine, attached like a rented machine rather than
    # required at boot. These three answer the Connect card: what is on this
    # disk, what is answering, and "use the one I am already running". Nothing
    # here writes inside a ComfyUI install — detection is stat() and one GET,
    # and the attachment lives in this app's own state root.
    @router.get("/api/comfy/connect", dependencies=[Depends(require_owner)])
    def comfy_connect_state() -> dict:
        return {"ok": True, **comfy_connect.snapshot()}

    @router.post("/api/comfy/connect", dependencies=[Depends(require_owner)])
    def comfy_connect_attach(body: ComfyAttachBody) -> dict:
        try:
            state = comfy_connect.attach(body.url, body.lane)
        except comfy_connect.ConnectError as exc:
            # 400 with the sentence the card shows: the refusal already names
            # the fix, so it must not be flattened into a status code.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, **state}

    @router.post("/api/comfy/disconnect", dependencies=[Depends(require_owner)])
    def comfy_connect_detach(body: ComfyDetachBody) -> dict:
        return {"ok": True, **comfy_connect.detach(body.lane)}

    app.include_router(router)
