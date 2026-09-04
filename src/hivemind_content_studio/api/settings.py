"""The typed settings document.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..settings import (
    apply as apply_settings,
    describe as describe_settings,
    settings as studio_settings,
    SettingsError,
)
from .models import SettingsBody


def register(app, ctx) -> None:
    """Register the settings routes."""
    router = APIRouter()
    require_owner = ctx.require_owner

    # ── this machine's settings (never a secret: settings.py refuses one) ──
    @router.get("/api/settings", dependencies=[Depends(require_owner)])
    def get_settings() -> dict:
        return {"ok": True, **describe_settings()}

    @router.put("/api/settings", dependencies=[Depends(require_owner)])
    def put_settings(body: SettingsBody) -> dict:
        try:
            result = apply_settings(body.values, reset=tuple(body.reset))
        except SettingsError as exc:
            # The message names the value and what would have been acceptable,
            # so it is shown as written rather than translated into "invalid".
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail={
                    "message": "The studio could not save that setting.",
                    "remedy": f"Check that {studio_settings().paths.data_dir} is writable.",
                },
            ) from exc
        return {"ok": True, **result}

    app.include_router(router)
