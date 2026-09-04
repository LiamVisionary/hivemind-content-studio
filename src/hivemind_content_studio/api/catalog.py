"""The model catalog the studios open onto.

Served stale and refreshed on a background thread, because a first open used
to wait tens of seconds on a warm build. Moved out of control_api.py
unchanged (2026-09-04).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..capability_matrix import capability_matrix
from ..hivemindos_brain import local_brain_catalog
from ..lanes import LANE_MATRIX
from ..media_studio import sanitize_error_detail
from ..providers import provider_report
from ..template_catalog import template_report

log = logging.getLogger("hivemind.studio.control")


def register(app, ctx) -> None:
    """Register the catalog routes and the warm-on-boot hook."""
    router = APIRouter()
    cp = ctx.control_api
    boot_state = ctx.boot_state
    require_owner = ctx.require_owner
    shutting_down = ctx.shutting_down

    @router.get("/api/catalog")
    def catalog() -> dict:
        provider_rows = provider_report()
        providers_by_role: dict[str, list[dict]] = {}
        for provider in provider_rows:
            for role in provider["roles"]:
                providers_by_role.setdefault(role, []).append(provider)
        return {
            "ok": True,
            "lanes": [lane.as_dict() for lane in LANE_MATRIX],
            "providers_by_role": providers_by_role,
            "platforms": ["instagram", "tiktok", "youtube", "facebook", "x", "linkedin"],
            "aspect_ratios": ["9:16", "4:5", "1:1", "16:9"],
            "privacy_modes": ["local-only", "local-first", "cloud-allowed"],
        }

    @router.get("/api/capabilities/matrix", dependencies=[Depends(require_owner)])
    def capabilities_matrix() -> dict:
        """Which models are FIT for a studio feature, not merely capable of it.

        The registry's `accepts` list already says what a graph CAN take, and
        the studio reads it in one place. This adds the other half — whether
        the model is any good at the thing — with the provenance of each
        verdict attached, so the UI can tell a measured run from an inference.
        """
        # Built against the CACHED media catalog when there is one. Left to build
        # its own, this route ran the full provider readiness sweep — including a
        # subprocess (`higgsfield account status`) and a 5s hosted-media call —
        # on every Story and Sprite mount, which is exactly what the sibling
        # /api/simple/catalog cache exists to stop.
        cached = simple_catalog_cache["payload"]
        media = (cached or {}).get("media") if isinstance(cached, dict) else None
        if cached is not None and time.time() - simple_catalog_cache["at"] > SIMPLE_CATALOG_TTL_SECONDS:
            _kick_simple_catalog_refresh()
        return {"ok": True, **capability_matrix(catalog=media if isinstance(media, dict) else None)}

    def _build_simple_catalog() -> dict:
        brains: list[dict] = []
        brain_error = ""
        try:
            value = cp.brain_catalog()
            brains = value.get("providers") if isinstance(value.get("providers"), list) else []
        except RuntimeError as exc:
            brain_error = str(exc)
            brains = local_brain_catalog()["providers"]
        return {
            "ok": True,
            "brains": brains,
            "brain_error": brain_error,
            "media": cp.media_catalog(),
            "templates": template_report(),
            "attachment_intake_limit": 30,
            "attachment_note": "The studio can retain up to 30 ordered references. Each selected provider/model receives only roles allowed by its capability schema.",
        }

    # The catalog aggregates provider probes (the HivemindOS brains call can
    # take many seconds when that app is busy), and every model UI in the
    # studio waits on it. Serve the last-built catalog immediately and refresh
    # in the background instead of stalling each studio open on live probes.
    simple_catalog_cache: dict[str, Any] = {"payload": None, "at": 0.0}
    simple_catalog_refreshing = threading.Event()
    SIMPLE_CATALOG_TTL_SECONDS = 30.0
    # A build whose Media Studio workflow registry did not answer is not merely
    # stale, it is wrong: it describes MiniMax H3 without reference mode, so the
    # studio renders the pre-reference toolbar for it. Hold one for seconds, not
    # for the full TTL — the window this covers (a stack restart where the
    # gateway is still coming up, or a probe lost to a busy gateway) is short.
    SIMPLE_CATALOG_DEGRADED_TTL_SECONDS = 3.0

    def _catalog_registry_degraded(payload: dict | None) -> bool:
        video = ((payload or {}).get("media") or {}).get("video") or []
        return any(
            row.get("id") == "media-studio-mcp" and row.get("registry_live") is False
            for row in video
            if isinstance(row, dict)
        )

    def _refresh_simple_catalog() -> None:
        try:
            payload = _build_simple_catalog()
            simple_catalog_cache.update(payload=payload, at=time.time())
        except Exception as exc:  # noqa: BLE001 — a stale catalog beats no studio
            # Keep serving the previous catalog, but stamp the attempt: a build
            # that keeps throwing would otherwise leave a degraded payload
            # permanently past its short TTL, and rebuild inside every single
            # request instead of backing off. Stamped AND logged: a catalog
            # stuck on the previous answer is what "the studio shows the wrong
            # controls for this model" looks like from the outside.
            log.warning("catalog refresh failed: %s", sanitize_error_detail(str(exc)))
            simple_catalog_cache["at"] = time.time()
        finally:
            simple_catalog_refreshing.clear()

    def _kick_simple_catalog_refresh() -> None:
        if simple_catalog_refreshing.is_set() or shutting_down.is_set():
            return
        simple_catalog_refreshing.set()
        threading.Thread(target=_refresh_simple_catalog, name="simple-catalog-refresh", daemon=True).start()

    def _pending_simple_catalog() -> dict:
        """The catalog while the boot build is still running.

        Building inline here duplicated work the warm thread had already
        started and made the very first model picker of a session wait on it —
        an 8s HivemindOS call plus a 3s probe and a 30s registry read. The
        brains list is the local one (free, no network), the media block is
        empty and `pending` says so, so a client can retry rather than treat an
        empty list as the answer. Media Studio's registry-live flag is the
        client's existing retry signal and it reads `pending` the same way.
        """
        return {
            "ok": True,
            "pending": True,
            "brains": local_brain_catalog()["providers"],
            "brain_error": "",
            "media": {"image": [], "video": []},
            # Local files behind an lru_cache — free, and a client that lost its
            # template list would degrade for no reason.
            "templates": template_report(),
            "attachment_intake_limit": 30,
            "attachment_note": "The studio can retain up to 30 ordered references. Each selected provider/model receives only roles allowed by its capability schema.",
        }

    @router.get("/api/simple/catalog")
    def simple_catalog(response: Response) -> dict:
        cached = simple_catalog_cache["payload"]
        if cached is None:
            if simple_catalog_refreshing.is_set():
                # The boot warm-up owns this build already. Answer now and say
                # when to come back rather than joining a call that can take
                # tens of seconds — the model picker is the first thing a new
                # session looks at, and a hang there reads as a broken app.
                response.headers["Retry-After"] = "2"
                return _pending_simple_catalog()
            payload = _build_simple_catalog()
            simple_catalog_cache.update(payload=payload, at=time.time())
            return payload
        age = time.time() - simple_catalog_cache["at"]
        if _catalog_registry_degraded(cached) and age > SIMPLE_CATALOG_DEGRADED_TTL_SECONDS:
            # Rebuild in the request rather than serving this page load the bad
            # capability list and refreshing behind its back — that pattern is
            # exactly why a reload used to be needed several times over before
            # the studio came back with its References and Frames controls.
            if not simple_catalog_refreshing.is_set():
                simple_catalog_refreshing.set()
                _refresh_simple_catalog()
            return simple_catalog_cache["payload"] or cached
        if age > SIMPLE_CATALOG_TTL_SECONDS:
            _kick_simple_catalog_refresh()
        return simple_catalog_cache["payload"] or cached

    def _warm_simple_catalog() -> None:
        # Build the catalog once at boot so even the first studio open after a
        # stack restart gets an instant model list. Readiness is stamped here
        # rather than when the background build lands: a provider that never
        # answers must not hold /readyz false forever.
        _kick_simple_catalog_refresh()
        boot_state["catalog_warm"] = True

    app.state.startup_hooks.append(_warm_simple_catalog)

    app.include_router(router)
