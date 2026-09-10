"""Linking this studio to the owner's HivemindOS account and credit.

Moved out of control_api.py unchanged (2026-09-04). Extended 2026-09-10 with
the account row's own routes — who this person is, what is left of the free
allowance, and the four ways credits get onto the balance (card, USDC, a
monthly plan, and the HivemindOS app's wallet).

The gate on each one is the difference between reading and spending.
``require_owner`` — any signed-in workspace — reads: a collaborator may see the
name, the balance and the meter, because those are what the sidebar shows on
every page. ``require_owner_account`` — the OWNER workspace — is on everything
that moves money or moves the account: checkout, deposit, subscription, email
link, the recovery key. That is the same line ``hivemindos_models`` already
draws, and for the same reason: a workspace exists because the owner approved
it, and that approval covers generating, not the owner's card.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import hivemindos_account, hivemindos_models
from .hosts import _host_name, _LOOPBACK_NAMES
from .models import (
    AccountDepositQuoteBody,
    AccountDepositSettleBody,
    AccountEmailStartBody,
    AccountEmailVerifyBody,
    AccountHandleBody,
    AccountSubscriptionBody,
    AccountSubscriptionCancelBody,
    AccountWalletClaimBody,
    AccountWalletPayBody,
    AccountWalletResultBody,
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

    # ------------------------------------------------------------ the account row

    def _fail(exc: hivemindos_models.HivemindosModelsError, status: int = 400) -> HTTPException:
        """One shape for every refusal on these routes, so the browser's failure
        toast can find the repair button without a per-route special case."""
        return HTTPException(status_code=status, detail={
            "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
        })

    @router.get("/api/hivemindos/account", dependencies=[Depends(require_owner)])
    def hivemindos_account_overview() -> dict:
        """Everything the sidebar's account row shows, in one read.

        Never fails: this is the row that is on screen on every page, and a
        gateway that cannot be reached has to leave a name and an unknown meter
        rather than an empty rectangle.
        """
        return {"ok": True, **hivemindos_account.overview()}

    @router.post("/api/hivemindos/account/handle", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_handle(body: AccountHandleBody) -> dict:
        """Rename this account on this machine, or clear the name back to the
        derived one."""
        try:
            return {"ok": True, "identity": hivemindos_account.set_handle(body.handle)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/email/link/start", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_email_link_start(body: AccountEmailStartBody) -> dict:
        """Send a code that attaches this address to the account held here."""
        try:
            return {"ok": True, **hivemindos_account.email_link_start(body.email)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/email/link/verify", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_email_link_verify(body: AccountEmailVerifyBody) -> dict:
        """Finish attaching it. The account is recoverable from here on."""
        try:
            return {"ok": True, **hivemindos_account.email_link_verify(body.challengeId, body.code)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/email/signin/start", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_email_signin_start(body: AccountEmailStartBody) -> dict:
        """Send a code to an address that already has an account."""
        try:
            return {"ok": True, **hivemindos_account.email_signin_start(body.email)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/email/signin/verify", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_email_signin_verify(body: AccountEmailVerifyBody) -> dict:
        """Take that account back on this machine, folding in what was here."""
        try:
            return {"ok": True, **hivemindos_account.email_signin_verify(body.challengeId, body.code)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/recovery-key", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_recovery_key() -> dict:
        """Hand back the account key, once, for someone who wants no email on file.

        A POST rather than a GET on purpose: this is an act with a consequence
        (a bearer credential for money reaches the browser), not a page to be
        prefetched, linked, logged in a history or replayed by a refresh.
        """
        try:
            return {"ok": True, **hivemindos_account.recovery_key()}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.get("/api/hivemindos/account/subscription", dependencies=[Depends(require_owner)])
    def hivemindos_account_subscription() -> dict:
        """The monthly plans, and which one is running."""
        return {"ok": True, **hivemindos_account.subscription()}

    @router.post("/api/hivemindos/account/subscription", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_subscribe(request: Request, body: AccountSubscriptionBody) -> dict:
        """Start a plan. The card is entered on the gateway's own page."""
        try:
            return {"ok": True, **hivemindos_account.subscription_checkout(
                body.tier, return_url=_return_url(request),
            )}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/subscription/cancel", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_unsubscribe(body: AccountSubscriptionCancelBody) -> dict:
        """Stop it. Credits already granted stay."""
        try:
            return {"ok": True, **hivemindos_account.subscription_cancel(body.confirmation)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    def _return_url(request: Request) -> str:
        """Where a hosted checkout sends the browser back to.

        The address this request arrived on, for the same reason the deep link
        uses it: a port guessed here lands the owner on someone else's studio,
        or on nothing.
        """
        host = (_from_proxy(request, "x-forwarded-host") or request.headers.get("host") or "").strip()
        scheme = (_from_proxy(request, "x-forwarded-proto") or request.url.scheme or "http").strip()
        return f"{scheme}://{host}/" if host else ""

    @router.get("/api/hivemindos/account/deposit", dependencies=[Depends(require_owner)])
    def hivemindos_account_deposit_config() -> dict:
        """Which chain and which token a USDC deposit uses."""
        return {"ok": True, **hivemindos_account.deposit_config()}

    @router.post("/api/hivemindos/account/deposit/quote", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_deposit_quote(body: AccountDepositQuoteBody) -> dict:
        """Reserve an address and an exact amount for one transfer."""
        try:
            return {"ok": True, **hivemindos_account.deposit_quote(body.payer, body.amountUsd)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/deposit/settle", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_deposit_settle(body: AccountDepositSettleBody) -> dict:
        """Claim a transfer that has landed, by its hash."""
        try:
            return {"ok": True, **hivemindos_account.deposit_settle(body.paymentId, body.transactionHash)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    # ------------------------------------- paying from the HivemindOS wallet
    #
    # The same three-part handshake the account link above uses, for the same
    # reason: the thing being asked for lives in the desktop app, behind the
    # owner's own unlock, and this studio must not be able to help itself to it.
    # What differs is that this one carries an AMOUNT, and that the app has to
    # be told which account to credit — see `claim_wallet_payment`.

    @router.post("/api/hivemindos/account/wallet-pay", dependencies=[Depends(require_owner_account)])
    def hivemindos_account_wallet_pay(request: Request, body: AccountWalletPayBody) -> dict:
        """Start a wallet payment and return the deep link that asks for it."""
        host = (_from_proxy(request, "x-forwarded-host") or request.headers.get("host") or "").strip()
        if not _loopback_host(host):
            raise HTTPException(status_code=400, detail={
                "message": "Paying from the HivemindOS wallet only works when the studio is open on this machine.",
                "remedy": "connect-account", "provider": "hivemindos",
            })
        try:
            return {"ok": True, **hivemindos_account.start_wallet_payment(
                body.amountUsd, f"http://{host}/api/hivemindos/account/wallet-pay/callback",
            )}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/wallet-pay/claim")
    def hivemindos_account_wallet_claim(request: Request, body: AccountWalletClaimBody) -> dict:
        """Where the app asks which account its payment should credit.

        NOT owner-gated, and for the same reason the link callback is not: the
        caller is the desktop app, not the owner's browser. The nonce is the
        proof — single-use, five minutes, minted here for a payment the owner
        started here — and loopback is enforced because a deep link is a
        same-machine mechanism and nothing off this box may answer one.
        """
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "localhost"}:
            raise HTTPException(status_code=403, detail="Local callers only")
        try:
            return {"ok": True, **hivemindos_account.claim_wallet_payment(body.nonce)}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.post("/api/hivemindos/account/wallet-pay/callback")
    def hivemindos_account_wallet_callback(request: Request, body: AccountWalletResultBody) -> dict:
        """The app's verdict on a payment the owner approved or refused."""
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "localhost"}:
            raise HTTPException(status_code=403, detail="Local callers only")
        try:
            return {"ok": True, **hivemindos_account.complete_wallet_payment(
                body.nonce, settled=body.settled, detail=body.detail,
            )}
        except hivemindos_models.HivemindosModelsError as exc:
            raise _fail(exc) from exc

    @router.get("/api/hivemindos/account/wallet-pay/state", dependencies=[Depends(require_owner)])
    def hivemindos_account_wallet_state(nonce: str) -> dict:
        """What the browser polls while the owner is over in the app."""
        return {"ok": True, **hivemindos_account.wallet_payment_state(nonce)}

    app.include_router(router)
