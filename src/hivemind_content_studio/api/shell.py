"""The studio shell itself, and what the app can do on this machine.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import logging
from html import escape

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, Response

from ..observability import remedy_text
from ..remote_access import remote_access_status, RemoteAccessError
from .models import RemoteAccessBody

log = logging.getLogger("hivemind.studio.control")


def register(app, ctx) -> None:
    """Register the shell, the capability matrix, remote access and the surface list."""
    router = APIRouter()
    cp = ctx.control_api
    open_gen_dist = ctx.open_gen_dist
    require_owner = ctx.require_owner
    require_owner_account = ctx.require_owner_account

    def _studio_shell() -> Response:
        """The React shell, served signed-in or not.

        The workspace picker and the passkey sign-in card are part of the same
        bundle, so the shell has to load before anyone has a session; it shows
        the gate and calls /api/accounts for the tiles. No account-scoped data
        is in the shell itself — only the app that will go and ask for it.
        """
        unified_index = open_gen_dist / "index.html"
        if unified_index.is_file():
            # Inject the studio marker so the frontend knows it is running as
            # the integrated studio (enables local workflows, run history via
            # the studio API, and the Hivemind dock) without URL params.
            html = unified_index.read_text(encoding="utf-8").replace(
                "<head>",
                "<head><script>window.__HIVEMIND_STUDIO__=1</script>",
                1,
            )
            # Never cache the shell. Vite fingerprints every asset, so a browser
            # holding a stale index.html keeps requesting the OLD hashed bundle
            # and the UI silently never updates after a rebuild — which looks
            # exactly like the new feature was never shipped.
            return HTMLResponse(
                html,
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )
        # The build command is a correct instruction for whoever built this and
        # a dead end for whoever installed it; remedy_text keeps the developer
        # sentence behind CONTENT_STUDIO_DEV=1. The reassurance matters as much
        # as the fix: "reinstall" reads like "lose your work" unless it says
        # otherwise, and nothing here touches the data directory.
        log.error("frontend build missing at %s", open_gen_dist.name)
        return HTMLResponse(
            "<h1>Hivemind Content Studio</h1>"
            f"<p>{escape(remedy_text('dist-missing'))}</p>"
            "<p>Your workspaces, history and settings stay where they are.</p>"
            '<p><a href="/">Try again</a></p>',
            status_code=503,
        )

    @router.get("/", include_in_schema=False)
    def index() -> Response:
        return _studio_shell()

    # Opening the studio on the owner's other devices. Off until someone asks:
    # the stack used to publish a hand-rolled HTTPS proxy (and a SELF-SIGNED
    # certificate) over the tailnet at every boot, fronting the Canvas port,
    # which authenticated nothing. `tailscale serve` carries a real certificate
    # and publishes only the port this API listens on.
    @router.get("/api/remote-access", dependencies=[Depends(require_owner)])
    def remote_access() -> dict:
        return {"ok": True, **remote_access_status()}

    @router.post("/api/remote-access", dependencies=[Depends(require_owner_account)])
    def set_remote_access_route(body: RemoteAccessBody) -> dict:
        # The owner's workspace, not merely a signed-in one: this reaches past
        # the studio and changes what a whole tailnet can open, the same reason
        # the shared credential store is owner-only.
        try:
            return {"ok": True, **cp.set_remote_access(bool(body.enabled))}
        except RemoteAccessError as exc:
            raise HTTPException(status_code=503, detail={
                "message": exc.message,
                "remedy": exc.remedy,
            }) from exc

    @router.get("/api/surfaces")
    def surfaces() -> dict:
        open_gen_index = open_gen_dist / "index.html"
        open_gen_version = str(open_gen_index.stat().st_mtime_ns) if open_gen_index.is_file() else "missing"
        return {
            "ok": True,
            "surfaces": {
                "explore": {"path": f"/open-gen/?build={open_gen_version}", "available": open_gen_index.is_file()},
                "canvas": {"gateway_path": "/mobile/", "available": True},
                # No "models" surface: the model manager is a native view now, served
                # by this app and talking to the /local-ai bridge below.
                "gateway": {"gateway_path": "/", "available": True},
            },
        }

    app.include_router(router)
