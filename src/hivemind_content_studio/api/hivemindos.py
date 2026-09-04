"""Linking this studio to the owner's HivemindOS account and credit.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import hivemindos_models
from .hosts import _host_name, _LOOPBACK_NAMES
from .models import (
    HivemindosConnectBody,
    HivemindosLinkCallbackBody,
    HivemindosMergeBody,
    HivemindosTopUpBody,
)


def register(app, ctx) -> None:
    """Register the HivemindOS link, merge and top-up routes."""
    router = APIRouter()
    _from_proxy = ctx._from_proxy
    require_owner = ctx.require_owner
    require_owner_account = ctx.require_owner_account

    @router.post("/api/hivemindos/models/connect", dependencies=[Depends(require_owner_account)])
    def hivemindos_models_connect(body: HivemindosConnectBody) -> dict:
        """Point this studio at the owner's HivemindOS account.

        The key is verified against the gateway before it is stored, and stored
        encrypted on this machine — it is a bearer credential for their credit
        balance and never goes near the browser again after this call.
        """
        try:
            if not body.token.strip():
                hivemindos_models.forget_credit_token()
                return {"ok": True, "connected": False}
            return {"ok": True, **hivemindos_models.connect_account(body.token)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
            }) from exc

    def _loopback_host(host: str) -> bool:
        """Is this Host header this machine? A deep link can only reach the app
        on the same computer, so a studio opened over the tailnet or a Hivemind
        Link proxy has to be told that plainly rather than handed a link that
        would resolve on the wrong machine."""
        return _host_name(host) in _LOOPBACK_NAMES

    @router.post("/api/hivemindos/models/link-request", dependencies=[Depends(require_owner)])
    def hivemindos_models_link_request(request: Request) -> dict:
        """Start an app-mediated link and return the deep link that carries it.

        The callback is built from the address this request arrived on, so the
        app answers the studio the owner is actually looking at rather than a
        port guessed here.
        """
        # Behind the tailnet proxy the Host header IS 127.0.0.1 — it was
        # rewritten on the way in — so asking it alone would have offered a deep
        # link to a browser on another machine. The forwarded name is the
        # address bar's, and only the proxy may state it.
        host = (_from_proxy(request, "x-forwarded-host") or request.headers.get("host") or "").strip()
        if not _loopback_host(host):
            raise HTTPException(status_code=400, detail={
                "message": "Linking through the app only works when the studio is open on this machine.",
                "remedy": "connect-account", "provider": "hivemindos",
            })
        return {"ok": True, **hivemindos_models.start_link(f"http://{host}/api/hivemindos/models/link-callback")}

    @router.post("/api/hivemindos/models/link-callback")
    def hivemindos_models_link_callback(request: Request, body: HivemindosLinkCallbackBody) -> dict:
        """Where the HivemindOS app hands the key back.

        NOT owner-gated, because the caller is the desktop app rather than the
        owner's browser — the nonce is what proves this belongs to a link the
        owner started here, and it is single-use and short-lived. Loopback only,
        because a deep link is a local mechanism and nothing off this machine has
        any business completing one.
        """
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "localhost"}:
            raise HTTPException(status_code=403, detail="Local callers only")
        try:
            return {"ok": True, **hivemindos_models.complete_link(body.nonce, body.token)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
            }) from exc

    @router.get("/api/hivemindos/models/link-state", dependencies=[Depends(require_owner)])
    def hivemindos_models_link_state(nonce: str) -> dict:
        """What the browser polls while the owner is over in the app."""
        return {"ok": True, "state": hivemindos_models.link_state(nonce)}

    @router.post("/api/hivemindos/models/merge-credits", dependencies=[Depends(require_owner_account)])
    def hivemindos_models_merge(body: HivemindosMergeBody) -> dict:
        """Fold a second HivemindOS balance into the connected one."""
        try:
            return {"ok": True, **hivemindos_models.merge_accounts(body.tokens)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
            }) from exc

    @router.post("/api/hivemindos/models/top-up", dependencies=[Depends(require_owner_account)])
    def hivemindos_models_top_up(body: HivemindosTopUpBody) -> dict:
        """Start a card checkout for HivemindOS credits, for a studio with no app.

        Nothing is charged here: the gateway returns its own checkout page and
        the owner enters the card there. The credit token that comes back is
        stored on this machine, encrypted, so the next paid ask can spend it.
        With the HivemindOS app running this refuses instead — credits added
        there stay one shared balance, and buying a second one would split it.
        """
        try:
            return {"ok": True, **hivemindos_models.start_top_up(amount_usd=body.amountUsd)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
            }) from exc

    app.include_router(router)
