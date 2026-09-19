"""Music recipes: the library the composer browses, and the opt-in pick.

Two routes, deliberately unalike. The library is local data and answers with no
network at all. The suggestion is the ONE thing in the Music studio that leaves
this machine, so it is a POST a person presses, it carries the style line and
nothing else, and every refusal says the list is still there to pick from.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import music_recipes


class MusicSuggestBody(BaseModel):
    # The style line only. There is no `lyrics` field to send by accident.
    style: str = Field(default="", max_length=4000)


def register(app, ctx) -> None:
    """Register the recipe library and the structure suggestion."""
    router = APIRouter()
    require_owner = ctx.require_owner

    @router.get("/api/music/recipes", dependencies=[Depends(require_owner)])
    def music_recipes_route() -> dict:
        """The recipe library, and whether Suggest can run. No network."""
        return music_recipes.catalog_payload()

    @router.post("/api/music/suggest", dependencies=[Depends(require_owner)])
    async def music_suggest_route(body: MusicSuggestBody) -> dict:
        """Which recipe fits this style line, by the hosted decision model."""
        try:
            return await asyncio.to_thread(music_recipes.suggest, body.style)
        except music_recipes.MusicRecipeError as exc:
            raise HTTPException(status_code=exc.status, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "openrouter",
            }) from exc

    app.include_router(router)
