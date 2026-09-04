"""One extracted frame, matted.

Nothing is written down: the mask goes back in the same response. Moved out
of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from ..media_studio import sanitize_error_detail
from .media_common import _requester_pub
from .models import SpriteMatteBody


def register(app, ctx) -> None:
    """Register the sprite matte route."""
    router = APIRouter()
    cp = ctx.control_api
    require_owner = ctx.require_owner

    @router.post("/api/sprite/matte", dependencies=[Depends(require_owner)])
    async def sprite_matte(body: SpriteMatteBody, request: Request) -> dict:
        """Cut one animation frame out of its background with SAM3.

        Named rather than salient-object matting on purpose: a sprite clip
        routinely has something else moving in it (the butterfly the dragon is
        watching), and a matting net keeps whatever is most conspicuous. Text
        grounding keeps the thing you asked for and drops the rest.

        One frame per call. A warm run is ~20s and the first loads a 3.45 GB
        checkpoint, so the caller shows per-frame progress instead of hiding a
        multi-minute wait behind a single request.
        """
        points = [
            {"x": point.x, "y": point.y, "include": point.include}
            for point in body.points
        ]
        try:
            result = await asyncio.to_thread(
                cp.run_smart_mask,
                body.image_base64,
                subject=body.subject,
                points=points,
                confidence=body.confidence,
                requester_pub=_requester_pub(request),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail=sanitize_error_detail(str(exc))) from None
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=sanitize_error_detail(str(exc))) from None
        return {"ok": True, **result}

    app.include_router(router)
