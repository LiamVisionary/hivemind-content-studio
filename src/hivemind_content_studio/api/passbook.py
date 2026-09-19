"""The machine's shared credential store, seen through the studio.

Reading is open to any signed-in workspace (which keys exist, never a value);
writing is the owner's, because this reaches past the studio into every Hive
app on the machine. Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import provider_models
from ..accounts import verify_assertion, WebAuthnError
from ..media_studio import sanitize_error_detail
from ..observability import remedy_text
from ..shared_env import (
    access_ledger,
    access_state,
    apply_shared_hive_env,
    broker_status,
    close_unlock,
    ContainerisedHomeError,
    hive_env_status,
    machine_links,
    open_unlock,
    resolve_request,
    revoke_machine_link,
    seal_store,
    sealing_status,
    set_access_mode,
    set_hive_env_values,
)
from .models import (
    PassBookBody,
    PassBookModeBody,
    PassBookResolveBody,
    PassBookRevokeBody,
    PassBookUnlockBody,
)

log = logging.getLogger("hivemind.studio.control")


def register(app, ctx) -> None:
    """Register the PassBook routes."""
    router = APIRouter()
    _relying_party = ctx._relying_party
    account_store = ctx.account_store
    require_owner = ctx.require_owner
    require_owner_account = ctx.require_owner_account

    # The credential keys this studio can actually use. A first-run screen offers
    # these and nothing else: an allow-list keeps a write route from becoming a
    # way to set arbitrary environment variables for every Hive app on the box.
    SETTABLE_CREDENTIALS: dict[str, str] = {
        "OPENAI_API_KEY": "OpenAI — GPT Image and the planner brain",
        "XAI_API_KEY": "xAI — Grok Imagine image and video",
        # The producer's own accounts. Same names HivemindOS's provider catalog
        # uses, into the same shared store, so a key added in either app is a
        # key added for both — see `provider_models.PROVIDERS`.
        "ANTHROPIC_API_KEY": "Anthropic — Claude, for the producer",
        "OPENROUTER_API_KEY": "OpenRouter — hundreds of models on one account",
        "GEMINI_API_KEY": "Google Gemini — for the producer",
        "GROQ_API_KEY": "Groq — for the producer",
        "VENICE_API_KEY": "Venice AI — for the producer",
        "ELEVENLABS_API_KEY": "ElevenLabs — cloud voice",
        "PEXELS_API_KEY": "Pexels — stock footage for the faceless lane",
        "PIXABAY_API_KEY": "Pixabay — stock footage for the faceless lane",
        "MUAPI_API_KEY": "MUAPI — hosted image, video and lip sync",
        "HIGGSFIELD_API_KEY_ID": "Higgsfield — key id",
        "HIGGSFIELD_API_KEY_SECRET": "Higgsfield — key secret",
        "UPLOAD_POST_API_KEY": "Upload-Post — publishing",
        "UPLOAD_POST_USERNAME": "Upload-Post — account name",
        "CIVITAI_API_KEY": "Civitai — model downloads",
    }

    @router.get("/api/passbook", dependencies=[Depends(require_owner)])
    def passbook_state() -> dict:
        """What the shared store holds, by NAME, and what this studio can set.

        Never returns a value. `configured` is what a first-run screen ticks off;
        `detail` explains a store this build cannot reach at all.
        """
        state = hive_env_status()
        held = set(state["keys"])
        return {
            "ok": True,
            **{key: state[key] for key in ("path", "exists", "workspace", "workspaces", "apps", "home_is_container", "detail")},
            "settable": [
                {"key": key, "label": label, "configured": key in held}
                for key, label in SETTABLE_CREDENTIALS.items()
            ],
            "keys": sorted(held),
            "sealing": sealing_status(),
        }

    @router.get("/api/passbook/access", dependencies=[Depends(require_owner)])
    def passbook_access(limit: int = 100) -> dict:
        """Who read which credential, and whether the record has been altered.

        Key names only. `intact` is the load-bearing field: false means a row
        was edited, removed or reordered since it was written.
        """
        return {"ok": True, **access_ledger(limit=max(1, min(1000, limit)))}

    @router.get("/api/passbook/policy", dependencies=[Depends(require_owner)])
    def passbook_access_state() -> dict:
        """The rules, the open unlocks, and anything waiting on the owner."""
        return {"ok": True, **access_state()}

    @router.post("/api/passbook/policy/mode", dependencies=[Depends(require_owner_account)])
    def passbook_set_mode(body: PassBookModeBody) -> dict:
        result = set_access_mode(app=body.app, key=body.key, mode=body.mode, window=body.window)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail={
                "message": result.get("detail") or "That mode could not be set.",
                "remedy": "Pick always, ask, window or never; a window needs a start and an end.",
            })
        return result

    @router.post("/api/passbook/policy/unlock", dependencies=[Depends(require_owner_account)])
    def passbook_unlock(body: PassBookUnlockBody) -> dict:
        """Open access for a stated period, then let it shut by itself."""
        result = open_unlock(duration=body.duration, keys=body.keys,
                             app=body.app, reason=body.reason)
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail={
                "message": result.get("detail") or "That unlock could not be opened.",
                "remedy": "Use a duration like 30m, 1h or 4h, up to 7 days.",
            })
        return result

    @router.post("/api/passbook/policy/lock", dependencies=[Depends(require_owner_account)])
    def passbook_lock(body: PassBookRevokeBody | None = None) -> dict:
        return {"ok": True, **close_unlock("")}

    @router.post("/api/passbook/policy/resolve", dependencies=[Depends(require_owner_account)])
    def passbook_resolve(body: PassBookResolveBody, request: Request) -> dict:
        """Approve or decline a waiting request, with a passkey when one exists.

        Being signed in already got the owner this far. A release of credentials
        to a process is a second decision, so where a passkey is enrolled it has
        to be exercised — otherwise the passkey protects the session and not the
        thing the session is for.
        """
        account = getattr(request.state, "account", None)
        enrolled = account_store.list_passkeys(account.id) if account else []
        approver = "owner"

        if enrolled and body.approve:
            if not body.credential_id:
                raise HTTPException(status_code=401, detail={
                    "message": "This approval needs your passkey.",
                    "remedy": "Confirm with the passkey enrolled on this machine.",
                })
            try:
                verify_assertion(
                    store=account_store, party=_relying_party(request),
                    credential_id=body.credential_id, client_data_json=body.client_data_json,
                    authenticator_data=body.authenticator_data, signature=body.signature,
                )
            except WebAuthnError as exc:
                raise HTTPException(status_code=401, detail={
                    "message": "That passkey did not verify.",
                    "remedy": "Try again with the passkey enrolled on this machine.",
                }) from exc
            approver = f"passkey:{body.credential_id[:12]}"

        result = resolve_request(body.id, approve=body.approve,
                                 remember=body.remember, approved_by=approver)
        if not result.get("ok"):
            raise HTTPException(status_code=404, detail={
                "message": result.get("detail") or "That request is no longer waiting.",
                "remedy": "Refresh; it may have been answered or timed out.",
            })
        return {"ok": True, **result, "approved_by": approver}

    @router.get("/api/passbook/broker", dependencies=[Depends(require_owner)])
    def passbook_broker_state() -> dict:
        """Whether credential reads go through the broker, and its limits.

        Read-only. Starting and stopping a background service from a web request
        is a different kind of decision from pasting a key, and it belongs on the
        command line where the person doing it sees what it does.
        """
        return {"ok": True, **broker_status()}

    @router.get("/api/passbook/links", dependencies=[Depends(require_owner)])
    def passbook_links() -> dict:
        """Machines this one lends keys to, or borrows them from. Key names only.

        Read plus revoke, deliberately. Approving and accepting need a
        fingerprint compared against a second machine's screen, which no panel
        on one machine can do — a button that appeared to do it would be worse
        than no button.
        """
        return {"ok": True, **machine_links()}

    @router.post("/api/passbook/links/revoke", dependencies=[Depends(require_owner_account)])
    def passbook_revoke_link(body: PassBookRevokeBody) -> dict:
        """Stop lending to a machine, and say what must still be rotated.

        Revoking cannot unsend a value that has already been delivered. The
        `rotate` list is the real remediation, so it is returned rather than
        buried.
        """
        result = revoke_machine_link(body.did)
        if not result.get("ok"):
            raise HTTPException(status_code=404, detail={
                "message": result.get("detail") or "No active grant to that machine.",
                "remedy": "Refresh the list; it may already have been revoked.",
            })
        return {"ok": True, **result}

    @router.post("/api/passbook/seal", dependencies=[Depends(require_owner_account)])
    def passbook_seal_store() -> dict:
        """Encrypt every plaintext value in the shared store, in place.

        Protects the store at rest — a stolen laptop, a backup, a synced home
        directory. It does not protect against code running as this user; that
        needs a broker, not a cipher.
        """
        result = seal_store()
        if not result.get("ok"):
            # The store's own sentence names a Python package and an
            # environment variable; it belongs in the log, not the panel.
            log.warning("passbook seal refused: %s", sanitize_error_detail(result.get("detail") or ""))
            raise HTTPException(status_code=409, detail={
                "message": remedy_text("passbook-seal"),
                "remedy": "open-passbook",
            })
        return {"ok": True, **result}

    @router.post("/api/passbook", dependencies=[Depends(require_owner_account)])
    def passbook_set(body: PassBookBody) -> dict:
        """Add credentials to the machine's shared store.

        Additive by default: an existing key is kept unless the owner explicitly
        replaces it, so adding a key here can never quietly break another app
        that is already using the store.
        """
        unknown = sorted(set(body.values) - set(SETTABLE_CREDENTIALS))
        if unknown:
            raise HTTPException(status_code=400, detail={
                "message": f"This studio does not use {', '.join(unknown)}.",
                "remedy": "Add it with the HivemindOS app, or edit the shared env directly.",
            })
        blank = sorted(key for key, value in body.values.items() if not str(value).strip())
        if blank:
            raise HTTPException(status_code=400, detail={
                "message": f"No value given for {', '.join(blank)}.",
                "remedy": "Paste the key, or leave the field out to keep what is already stored.",
            })
        try:
            written = set_hive_env_values(body.values, overwrite=body.overwrite)
        except ContainerisedHomeError as exc:
            log.warning("passbook write refused: %s", sanitize_error_detail(str(exc)))
            raise HTTPException(status_code=409, detail={
                "message": remedy_text("passbook-write"),
                "remedy": "open-passbook",
            }) from None
        # The new keys have to reach THIS process too, or the provider the owner
        # just configured stays unavailable until a restart.
        apply_shared_hive_env()
        # And the account catalog has to be re-asked, or a provider connected
        # here keeps reporting "not connected" for the rest of the cache TTL —
        # which reads as a key that was rejected.
        provider_models.forget_cache()
        return {"ok": True, **{key: written[key] for key in ("added", "updated", "kept")}, "path": written["path"]}

    app.include_router(router)
