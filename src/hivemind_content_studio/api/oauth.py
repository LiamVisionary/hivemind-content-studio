"""Provider sign-ins the owner holds through OAuth.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException


def register(app, ctx) -> None:
    """Register the OAuth status and start routes."""
    router = APIRouter()
    cp = ctx.control_api

    @router.get("/api/oauth")
    def oauth_status() -> dict:
        return {
            "ok": True,
            "providers": {
                provider: cp.oauth_provider_status(provider)
                for provider in ("openai", "xai")
            },
        }

    @router.post("/api/oauth/{provider}/start")
    def oauth_start(provider: str) -> dict:
        """Begin a sign-in, and say up front whether it can come back.

        The authorize URL's redirect_uri is registered with the provider and
        must not be rewritten, so an unreachable callback is REPORTED rather
        than repaired — but it is reported before anyone is sent to a page that
        will strand them after they approve it.
        """
        try:
            result = cp.start_oauth_login(provider)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        callback = result.get("callback") or {}
        if callback.get("checked") and not callback.get("reachable"):
            raise HTTPException(status_code=409, detail={
                "message": callback.get("detail") or "The sign-in has nowhere to come back to.",
                "remedy": "fix-callback",
                "instruction": callback.get("remedy") or "",
                "target": callback.get("target") or "",
            })
        return {"ok": True, **result}

    app.include_router(router)
