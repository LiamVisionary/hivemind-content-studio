"""The ingredients sheet preview.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from ..media_studio import sanitize_error_detail, video_dimensions_for_request
from .models import MediaStudioIngredientPreviewBody


def register(app, ctx) -> None:
    """Register the ingredients preview route."""
    router = APIRouter()
    cp = ctx.control_api
    ingredients_sheet_compositor = ctx.ingredients_sheet_compositor
    media_studio_input_root = ctx.media_studio_input_root
    require_owner = ctx.require_owner
    stage_media_studio_reference = ctx.stage_media_studio_reference
    _write_inline_image = cp._write_inline_image

    @router.post("/api/media-studio/ingredients/preview", dependencies=[Depends(require_owner)])
    async def preview_media_studio_ingredients(body: MediaStudioIngredientPreviewBody) -> Response:
        if not 1 <= len(body.ingredient_images) <= 12:
            raise HTTPException(status_code=400, detail="Between 1 and 12 ingredient reference images are required")
        sources: list[Path] = []
        output: Path | None = None

        def _stage_all() -> list[Path]:
            """Decode, transcode and decrypt twelve references — off the loop.

            Every step in here is synchronous and slow on purpose: base64 of a
            full-size photo, HEIC transcoding, and the keychain cipher on a
            saved reference. Run inline on an async route it froze every other
            request in the process — job polls, the session middleware, the
            catalog — for as long as it took. The sibling routes already stage
            in a thread (start_media_studio_video); this is the same move.
            """
            staged: list[Path] = []
            try:
                for index, item in enumerate(body.ingredient_images):
                    if item.image_base64:
                        staged.append(_write_inline_image(item.image_base64, media_studio_input_root))
                    elif item.image_reference:
                        staged.append(stage_media_studio_reference(item.image_reference))
                    else:
                        raise ValueError(f"Ingredient reference {index + 1} has no image")
            except BaseException:
                # Whatever landed before the failure is still a file on disk.
                for path in staged:
                    path.unlink(missing_ok=True)
                raise
            return staged

        try:
            sources = await asyncio.to_thread(_stage_all)
            if not ingredients_sheet_compositor.is_file():
                raise RuntimeError("Ingredients sheet compositor is unavailable")
            media_studio_input_root.mkdir(parents=True, exist_ok=True)
            descriptor, output_name = tempfile.mkstemp(
                prefix="media-studio-ingredients-preview-",
                suffix=".png",
                dir=media_studio_input_root,
            )
            os.close(descriptor)
            output = Path(output_name)
            dimensions = video_dimensions_for_request(aspect_ratio=body.aspect_ratio)
            geometry_args = (
                ["--width", str(dimensions[0]), "--height", str(dimensions[1])]
                if dimensions else []
            )
            completed = await asyncio.to_thread(
                subprocess.run,
                [
                    sys.executable,
                    str(ingredients_sheet_compositor),
                    "--output",
                    str(output),
                    *geometry_args,
                    *(str(source) for source in sources),
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if completed.returncode != 0 or not output.is_file():
                raise RuntimeError("Ingredients sheet preview could not be composed")
            try:
                layout = json.loads(completed.stdout)
            except (json.JSONDecodeError, TypeError):
                layout = {}
            return Response(
                # A composed sheet is megabytes; reading it is one more thing
                # the loop has no business doing.
                content=await asyncio.to_thread(output.read_bytes),
                media_type="image/png",
                headers={
                    "Cache-Control": "private, no-store",
                    "X-Ingredients-Columns": str(layout.get("columns", "")),
                    "X-Ingredients-Rows": str(layout.get("rows", "")),
                    "X-Ingredients-Sources": str(len(sources)),
                    "X-Ingredients-Width": str(layout.get("width", "")),
                    "X-Ingredients-Height": str(layout.get("height", "")),
                },
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            # An OSError's text is "[Errno 2] No such file or directory:
            # /Users/<name>/…" — the owner's home directory, in a toast.
            raise HTTPException(
                status_code=503,
                detail=sanitize_error_detail(str(exc)) or "The ingredients sheet could not be composed.",
            ) from None
        finally:
            for source in sources:
                source.unlink(missing_ok=True)
            if output is not None:
                output.unlink(missing_ok=True)

    app.include_router(router)
