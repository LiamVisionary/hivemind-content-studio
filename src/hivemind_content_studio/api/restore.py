"""Video restoration (SeedVR2).

A straight proxy onto the media gateway's restore routes, path for path, so
the studio has one set of URLs whether it is talking to a local render or a
rented one. Every decision — the chunk plan, which machine, resume, assembly
— belongs to the gateway; what belongs here is the owner gate and the gateway
token, which must never reach the browser. Moved out of control_api.py
unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio
import urllib.request
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from .. import hivemindos_models, video_restore
from ..media_studio import sanitize_error_detail
from .models import RestorePlanBody


def register(app, ctx) -> None:
    """Register the restore proxy routes."""
    router = APIRouter()
    require_owner = ctx.require_owner

    # --- Video restoration (SeedVR2) -----------------------------------------
    #
    # A straight proxy onto the media gateway's restore routes, path for path,
    # so the studio has one set of URLs whether it is talking to a local render
    # or a rented one. Every decision — the chunk plan, which machine, resume,
    # assembly — belongs to the gateway; what belongs here is the owner gate and
    # the gateway token, which must never reach the browser.

    def _restore_error(exc: video_restore.RestoreError) -> HTTPException:
        # RestoreError carries whatever the gateway said, which on a lane
        # failure is the runner's stderr with an absolute path in it.
        said = sanitize_error_detail(str(exc)) or "That restoration could not be started."
        return HTTPException(
            status_code=exc.status_code,
            detail={"error": said, "message": said, **({"remedy": exc.remedy} if exc.remedy else {})},
        )

    @router.get("/api/restore/capabilities", dependencies=[Depends(require_owner)])
    async def restore_capabilities() -> dict[str, Any]:
        """Which machines can restore, and which of them costs money.

        Never raises. The Restore studio opens on this, and a gateway that is
        down should show "no machine can restore right now" rather than an
        empty screen with a stack trace behind it."""
        try:
            payload = await asyncio.to_thread(video_restore.client().request, "/api/restore/capabilities")
        except video_restore.RestoreError as exc:
            return {"ok": False, "lanes": [], "any": False, "error": str(exc), "remedy": exc.remedy}
        # The gateway can see whether the hosted service is switched on. It
        # cannot see whether this owner has an account to spend on it — that
        # token lives here, encrypted, and never goes over to the gateway except
        # on a start request that asks for the hosted lane. So the answer is
        # completed on the way past, rather than leaving the studio to offer a
        # lane whose only failure mode is a 401 three seconds later.
        connected = bool(await asyncio.to_thread(hivemindos_models.credit_token))
        for lane in payload.get("lanes") or []:
            if lane.get("lane") == "cloud":
                lane["connected"] = connected
                if not connected and lane.get("available"):
                    lane["available"] = False
                    lane["reason"] = "connect your HivemindOS account to restore on the hosted service"
                    lane["remedy"] = "connect"
        return {"ok": True, **payload}

    @router.post("/api/restore/plan", dependencies=[Depends(require_owner)])
    async def restore_plan(body: RestorePlanBody) -> dict[str, Any]:
        """The plan the gateway WOULD run, before anything is uploaded."""
        try:
            return await asyncio.to_thread(
                video_restore.client().request, "/api/restore/plan",
                method="POST",
                body={
                    "frames": body.frames, "fps": body.fps,
                    "width": body.width, "height": body.height,
                    "options": body.options or {},
                },
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.post("/api/restore/upload", dependencies=[Depends(require_owner)])
    async def upload_restore_source(request: Request) -> dict[str, Any]:
        """The source clip, streamed through to the gateway and never held.

        Nothing about this request is buffered: the ASGI body arrives in
        chunks, each chunk is handed to a StreamedBody that the blocking
        urllib POST is reading from in a worker thread, and the gateway writes
        them to disk as they land. A two-gigabyte source therefore costs this
        process a few hundred kilobytes at a time — where the old inline-base64
        body cost a full copy in the browser, a second one in this process, and
        a third on the way out.

        Returns the staged id `/api/restore` then references."""
        length = int(request.headers.get("content-length") or 0)
        if length <= 0:
            raise HTTPException(status_code=411, detail={
                "error": "That upload arrived without a length, so it cannot be streamed.",
                "message": "That upload arrived without a length, so it cannot be streamed.",
            })
        body = video_restore.StreamedBody()
        sending = asyncio.create_task(
            asyncio.to_thread(video_restore.client().upload_source, body, length)
        )
        try:
            async for chunk in request.stream():
                if sending.done():
                    # The gateway already refused (too large, no disk). Stop
                    # reading and let the await below report its own words.
                    break
                if not body.offer(chunk):
                    # Only under backpressure — the sender is behind, so wait
                    # for it in a worker rather than on the loop.
                    await asyncio.to_thread(body.feed, chunk)
            else:
                await asyncio.to_thread(body.finish)
        except video_restore.StreamedBody.Stopped:
            pass
        except BaseException:
            body.stop()
            sending.cancel()
            raise
        try:
            return await sending
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None
        finally:
            body.stop()

    @router.post("/api/restore", dependencies=[Depends(require_owner)])
    async def start_restore(body: dict[str, Any]) -> dict[str, Any]:
        """Start a restoration, or resume one.

        The body is passed through rather than re-modelled: the gateway
        validates and clamps every dial already, and a second schema here would
        be a second place for the defaults to drift."""
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="A restore request object is required")
        if str(body.get("run_on") or "") == "cloud":
            # The one thing the gateway cannot get for itself. It runs the chunk
            # loop, so it is the side that has to hold the token while a render
            # is in flight; it keeps it in memory for that render only and never
            # writes it to the project. If there is no account connected, say so
            # HERE — before a chunk is cut and uploaded to a service that will
            # refuse it.
            token = await asyncio.to_thread(hivemindos_models.credit_token)
            if not token:
                raise HTTPException(status_code=402, detail={
                    "error": "Connect your HivemindOS account to restore on the hosted service.",
                    "remedy": "connect",
                })
            body = {**body, "credit_token": token}
        try:
            return await asyncio.to_thread(
                video_restore.client().request, "/api/restore",
                method="POST", body=body, timeout=video_restore.UPLOAD_TIMEOUT_SECONDS,
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.post("/api/restore/finish", dependencies=[Depends(require_owner)])
    async def finish_restore(body: dict[str, Any]) -> dict[str, Any]:
        """Re-finish from the saved chunks, or from a clip the studio joined."""
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="A finish request object is required")
        try:
            return await asyncio.to_thread(
                video_restore.client().request, "/api/restore/finish",
                method="POST", body=body, timeout=video_restore.UPLOAD_TIMEOUT_SECONDS,
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.get("/api/restore/projects", dependencies=[Depends(require_owner)])
    async def restore_projects() -> dict[str, Any]:
        try:
            return await asyncio.to_thread(video_restore.client().request, "/api/restore/projects")
        except video_restore.RestoreError as exc:
            return {"ok": False, "projects": [], "error": str(exc), "remedy": exc.remedy}

    @router.get("/api/restore/project/{project_id}", dependencies=[Depends(require_owner)])
    async def restore_project(project_id: str) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(
                video_restore.client().request,
                f"/api/restore/project/{urllib.parse.quote(project_id)}",
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.post("/api/restore/cancel/{project_id}", dependencies=[Depends(require_owner)])
    async def cancel_restore(project_id: str) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(
                video_restore.client().request,
                f"/api/restore/cancel/{urllib.parse.quote(project_id)}", method="POST",
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.post("/api/restore/delete/{project_id}", dependencies=[Depends(require_owner)])
    async def delete_restore(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        # confirm=true is required by the gateway too; forwarded rather than
        # assumed, so a mis-wired client cannot delete a project by accident.
        try:
            return await asyncio.to_thread(
                video_restore.client().request,
                f"/api/restore/delete/{urllib.parse.quote(project_id)}",
                method="POST", body={"confirm": bool((body or {}).get("confirm"))},
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None

    @router.get("/api/restore/source/{project_id}", response_class=Response, dependencies=[Depends(require_owner)])
    async def restore_source(project_id: str) -> Response:
        """The original clip, for the compare view of a REOPENED project.

        The browser holds the file it first picked; a project opened days later
        has to get the original from somewhere, and this is the only copy."""
        try:
            content, media_type = await asyncio.to_thread(
                video_restore.client().media,
                f"/api/restore/source/{urllib.parse.quote(project_id)}",
            )
        except video_restore.RestoreError as exc:
            raise _restore_error(exc) from None
        return Response(content=content, media_type=media_type, headers={"Cache-Control": "private, no-store"})

    app.include_router(router)
