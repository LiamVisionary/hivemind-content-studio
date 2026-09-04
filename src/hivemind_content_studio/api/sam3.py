"""The hosted SAM3 masking service: what it costs, and one mask.

The one masking path where footage leaves the machine, which the dialog says
beside the button. Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .. import hivemindos_models, hivemindos_sam3
from .models import HostedSam3MaskBody, HostedSam3QuoteBody


def register(app, ctx) -> None:
    """Register the hosted masking routes."""
    router = APIRouter()
    cp = ctx.control_api
    media_studio_input_root = ctx.media_studio_input_root
    require_owner = ctx.require_owner
    _write_inline_video = cp._write_inline_video

    @router.get("/api/media-studio/sam3", dependencies=[Depends(require_owner)])
    async def hosted_sam3_status() -> dict[str, Any]:
        """Whether hosted masking is reachable, switched on, and paid for.

        Asked when the inpaint dialog opens, so it can offer the hosted route or
        say which of the three things is missing. Never raises: an unreachable
        service must not take the dialog down with it."""
        return {"ok": True, **await asyncio.to_thread(hivemindos_sam3.status)}

    @router.post("/api/media-studio/sam3/quote", dependencies=[Depends(require_owner)])
    async def hosted_sam3_quote(body: HostedSam3QuoteBody) -> dict[str, Any]:
        """The price, before a single frame is uploaded."""
        try:
            quote = await asyncio.to_thread(
                hivemindos_sam3.quote, frames=body.frames, width=body.width, height=body.height,
            )
        except hivemindos_models.HivemindosModelsError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from None
        return {"ok": True, "quote": quote}

    @router.post("/api/media-studio/sam3/mask", dependencies=[Depends(require_owner)])
    async def hosted_sam3_mask(body: HostedSam3MaskBody) -> dict[str, Any]:
        """Track the subject through the clip and hand back the mask clip.

        Returns the mask as BYTES rather than a URL: the graph loads bytes, and a
        URL would make the render lane fetch from a third party mid-job."""
        staged: Path | None = None
        try:
            staged = _write_inline_video(
                body.video_base64, media_studio_input_root, label="The clip to mask")
            result = await asyncio.to_thread(
                hivemindos_sam3.mask_video,
                video=staged,
                frames=body.frames,
                width=body.width,
                height=body.height,
                prompt=body.prompt,
                detection_threshold=body.detection_threshold,
                max_objects=body.max_objects,
                detect_interval=body.detect_interval,
                maximum_debit_usd=body.maximum_debit_usd,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except hivemindos_models.HivemindosModelsError as exc:
            # The remedy rides along so the studio can put the ACTION next to the
            # sentence — a "top up" message with nothing to press is a dead end.
            raise HTTPException(
                status_code=402 if exc.remedy == "top-up" else 502,
                detail={"error": str(exc), "remedy": exc.remedy},
            ) from None
        finally:
            # The footage was uploaded for one purpose and is not ours to keep.
            if staged is not None:
                with contextlib.suppress(OSError):
                    staged.unlink()
        return {
            "ok": True,
            "mask_video_base64": result["mask_base64"],
            "charged_usd": result.get("charged_usd"),
        }

    app.include_router(router)
