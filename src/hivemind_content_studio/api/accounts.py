"""Workspaces: sign in, sign out, passkeys and the forgotten-password path.

Moved out of control_api.py unchanged (2026-09-04). The gate route set and the
account boundary that decides which of these are reachable before sign-in stay
in control_api.py, where their order is the security property.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from ..accounts import (
    Account,
    ACCOUNT_COOKIE,
    authentication_options,
    hash_password,
    is_legacy_password_hash,
    registration_options,
    seal_recovery_nonce,
    SESSION_SECONDS,
    verify_assertion,
    verify_password,
    verify_registration,
    WebAuthnError,
)
from ..private_access import OWNER_SESSION_SECONDS
from .models import (
    AccountCreateBody,
    AccountPasswordChangeBody,
    AccountRecoveryChallengeBody,
    AccountRecoveryResetBody,
    AccountRenameBody,
    AccountSetupBody,
    AccountUnlockBody,
    PasskeyAssertionBody,
    PasskeyChallengeBody,
    PasskeyRegisterBody,
)


def register(app, ctx) -> None:
    """Register the workspace and passkey routes."""
    router = APIRouter()
    _commit_password_reset = ctx._commit_password_reset
    _from_proxy = ctx._from_proxy
    _relying_party = ctx._relying_party
    _set_session_cookie = ctx._set_session_cookie
    account_access = ctx.account_access
    account_login_throttle = ctx.account_login_throttle
    account_store = ctx.account_store
    login_throttle = ctx.login_throttle
    owner_account = ctx.owner_account
    workspaces = ctx.workspaces

    # ── accounts: the sign-in gate ────────────────────────────────────────────

    def _sign_in(response: JSONResponse, request: Request, account: Account) -> JSONResponse:
        _set_session_cookie(response, request, account)
        return response

    def _session_remaining_seconds(request: Request) -> int:
        """Seconds the current session has left — the real number, not the
        constant, so a tab can warn before (rather than after) it lapses."""
        remaining = account_access.remaining_seconds(request.cookies.get(ACCOUNT_COOKIE))
        return int(remaining) if remaining is not None else SESSION_SECONDS

    def _throttle_key(request: Request, account_id: int | None) -> str:
        # Behind the tailnet / Hivemind Link proxy every browser shares the
        # proxy's address, so five wrong passwords from ANY device locked the
        # owner tile for everyone. The first hop of x-forwarded-for is the
        # browser — believed only from the proxy itself, or it is the attacker
        # choosing which bucket to spend. The socket address is the fallback.
        forwarded = _from_proxy(request, "x-forwarded-for")
        address = forwarded or (request.client.host if request.client else "unknown")
        return f"{address[:64]}:{account_id if account_id is not None else 'any'}"

    def _account_throttle_key(account_id: int | None) -> str:
        return f"account:{account_id if account_id is not None else 'any'}"

    def _retry_wording(seconds: float) -> str:
        whole = max(1, int(seconds) + 1)
        if whole >= 90:
            minutes = max(1, round(whole / 60))
            return f"{minutes} minute{'s' if minutes != 1 else ''}"
        return f"{whole} second{'s' if whole != 1 else ''}"

    def _guard_throttle(key: str, account_id: int | None = None) -> None:
        wait = max(login_throttle.retry_after(key),
                   account_login_throttle.retry_after(_account_throttle_key(account_id)))
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Too many attempts. Try again in {_retry_wording(wait)}.",
                headers={"Retry-After": str(int(wait) + 1)},
            )

    def _login_failed(key: str, account_id: int | None = None) -> None:
        login_throttle.fail(key)
        account_login_throttle.fail(_account_throttle_key(account_id))

    def _login_succeeded(key: str, account_id: int | None = None) -> None:
        login_throttle.success(key)
        account_login_throttle.success(_account_throttle_key(account_id))

    @router.get("/api/accounts")
    def list_accounts(request: Request) -> dict:
        """The picker's tile grid — reachable before sign-in by design.

        Only what a tile needs: name, colour, and which sign-in methods exist.
        No hashes, no credential ids, nothing that helps an attacker offline.
        """
        account = getattr(request.state, "account", None)
        return {
            "ok": True,
            "accounts": [entry.public() for entry in account_store.list_accounts()],
            "signed_in_as": account.id if account else None,
            "expires_in_seconds": _session_remaining_seconds(request) if account else SESSION_SECONDS,
            # A fresh install: the owner row exists but nobody has claimed it.
            # The gate shows the setup card instead of the picker until then.
            "setup_required": _setup_required(),
        }

    def _setup_required() -> bool:
        owner = account_store.get(owner_account.id)
        return owner is not None and not owner.has_password and owner.passkey_count == 0

    @router.post("/api/accounts/setup")
    def setup_owner(body: AccountSetupBody, request: Request) -> JSONResponse:
        """First run: name the studio and set the owner's passphrase.

        Reachable before sign-in because there is nothing to sign in with yet.
        Three things bound it: it only works from this machine (the person at
        the keyboard is the owner of a fresh install by definition), it is
        throttled like unlock, and it succeeds exactly once — the moment the
        owner holds any credential this answers 409 for good.
        """
        client = request.client.host if request.client else ""
        if client not in {"127.0.0.1", "::1", "localhost"}:
            raise HTTPException(status_code=403, detail="Set up the studio from the machine it runs on")
        key = _throttle_key(request, owner_account.id)
        _guard_throttle(key, owner_account.id)
        if not _setup_required():
            _login_failed(key, owner_account.id)
            raise HTTPException(status_code=409, detail="This studio is already set up")
        # Name first: it can fail validation, and a failure must leave the row
        # exactly as unclaimed as it found it.
        try:
            account_store.rename(owner_account.id, body.name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        account_store.set_password(owner_account.id, body.password)
        _login_succeeded(key, owner_account.id)
        account = account_store.get(owner_account.id)
        assert account is not None
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    @router.post("/api/accounts/unlock")
    def unlock_account(body: AccountUnlockBody, request: Request) -> JSONResponse:
        key = _throttle_key(request, body.account_id)
        _guard_throttle(key, body.account_id)
        account = account_store.get(body.account_id)
        stored = account_store.password_hash(body.account_id) if account else None
        if account is None or not verify_password(stored, body.password):
            _login_failed(key, body.account_id)
            # One message for both cases: which workspaces have which passwords
            # is not something a failed attempt should teach anyone.
            raise HTTPException(status_code=401, detail="Wrong password")
        _login_succeeded(key, body.account_id)
        # An owner still carrying the legacy SHA-256 digest is upgraded to
        # scrypt the moment they prove they know the password.
        if is_legacy_password_hash(stored):
            account_store.set_password(account.id, body.password)
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    # ── forgotten password: recover with the recovery key ─────────────────────
    #
    # Possession is proved by DECRYPTION, not by a signature. The vault keypair
    # is RSA-OAEP with encrypt/decrypt usages only and WebCrypto refuses to sign
    # with it, so the server seals a random nonce to the public half and asks
    # for the plaintext back. Only a browser that unwrapped the master key with
    # the recovery key — and through it the private key — can answer.
    _RECOVERY_UNAVAILABLE = (
        "There is no recovery key on file for that workspace. Sign in with its password, "
        "then use Settings → Privacy & vault to show a new recovery key."
    )

    @router.post("/api/accounts/recovery/challenge")
    def recovery_challenge(body: AccountRecoveryChallengeBody, request: Request) -> dict:
        """Everything a browser needs to open this vault with only the recovery key.

        Deliberately ABSENT from this response: `wrapped_mk_pass`. It is the
        master key sealed under a passphrase, and handing it to an
        unauthenticated caller would turn a forgotten-password screen into an
        offline password-cracking oracle for anyone who can reach the port. The
        recovery copy is a different animal — it is sealed under 160 bits of
        randomness this server has never held, so there is nothing to guess.
        """
        key = _throttle_key(request, body.account_id)
        _guard_throttle(key, body.account_id)
        account = account_store.get(body.account_id)
        identity = workspaces.vault(body.account_id).get_identity() if account else None
        if account is None or not identity:
            _login_failed(key, body.account_id)
            raise HTTPException(status_code=404, detail=_RECOVERY_UNAVAILABLE)
        challenge, nonce = account_store.issue_recovery_challenge(account.id)
        try:
            sealed = seal_recovery_nonce(str(identity.get("public_key") or ""), nonce)
        except Exception as exc:  # noqa: BLE001 — an unreadable key is one answer
            raise HTTPException(status_code=409, detail=_RECOVERY_UNAVAILABLE) from exc
        return {
            "ok": True,
            "challenge": challenge,
            "nonce": sealed,
            "kdf": identity.get("kdf") or "",
            "salt": identity["salt"],
            "wrapped_mk_recovery": identity["wrapped_mk_recovery"],
            "wrapped_private_key": identity["wrapped_private_key"],
        }

    @router.post("/api/accounts/recovery/reset")
    def recovery_reset(body: AccountRecoveryResetBody, request: Request) -> JSONResponse:
        """One call: prove the nonce, set the password, re-wrap the vault.

        Both writes land or neither does (`_commit_password_reset`), because a
        password that opens the account but not the library is the failure this
        whole flow exists to prevent.
        """
        key = _throttle_key(request, body.account_id)
        _guard_throttle(key, body.account_id)
        account = account_store.get(body.account_id)
        proved = account is not None and account_store.consume_recovery_challenge(
            body.challenge, body.nonce, body.account_id
        )
        if not proved:
            _login_failed(key, body.account_id)
            raise HTTPException(
                status_code=401,
                detail="That recovery key does not open this workspace. Check it for a typo — it is "
                       "letters and digits in groups of four — and start the recovery again.",
            )
        assert account is not None
        try:
            _commit_password_reset(account.id, hash_password(body.password), body.wrap.model_dump())
        except LookupError as exc:
            raise HTTPException(status_code=409, detail=_RECOVERY_UNAVAILABLE) from exc
        except Exception as exc:  # noqa: BLE001 — the rollback already ran
            raise HTTPException(
                status_code=500,
                detail="The new password could not be saved, so nothing was changed — your old "
                       "password still works. Start the recovery again.",
            ) from exc
        _login_succeeded(key, account.id)
        account = account_store.get(account.id) or account
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    @router.post("/api/accounts/me/password")
    def change_my_password(body: AccountPasswordChangeBody, request: Request) -> dict:
        """Change the signed-in workspace's password and its vault wrap together.

        The current password is verified here as well as in the browser: the
        browser's check proves it can re-wrap, and this one stops a stolen
        session cookie from changing the password on its own.
        """
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        key = _throttle_key(request, account.id)
        _guard_throttle(key, account.id)
        if not verify_password(account_store.password_hash(account.id), body.current_password):
            _login_failed(key, account.id)
            raise HTTPException(status_code=401, detail="That is not this workspace's current password.")
        _login_succeeded(key, account.id)
        try:
            _commit_password_reset(account.id, hash_password(body.password), body.wrap.model_dump())
        except LookupError as exc:
            raise HTTPException(
                status_code=409,
                detail="This workspace has no vault yet. Reload the studio so it can create one, "
                       "then change the password.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 — the rollback already ran
            raise HTTPException(
                status_code=500,
                detail="The new password could not be saved, so nothing was changed — your current "
                       "password still works. Try again.",
            ) from exc
        return {"ok": True}

    @router.post("/api/accounts/sign-out")
    def sign_out() -> JSONResponse:
        response = JSONResponse({"ok": True})
        response.delete_cookie(ACCOUNT_COOKIE, path="/", samesite="lax")
        return response

    @router.post("/api/accounts", status_code=201)
    def create_account(body: AccountCreateBody, request: Request) -> JSONResponse:
        """Add a workspace.

        Only the owner may do this. A studio that let anyone at the sign-in
        screen add a workspace would hand an intruder a foothold on the machine
        — and the picker is reachable unauthenticated.
        """
        account = getattr(request.state, "account", None)
        if account is None or not account.is_owner:
            raise HTTPException(status_code=403, detail="Only the owner workspace can add workspaces")
        try:
            created = account_store.create(name=body.name, password=body.password or None)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        workspaces.paths(created.id)
        return JSONResponse({"ok": True, "account": created.public()}, status_code=201)

    @router.delete("/api/accounts/{account_id}")
    def delete_account(account_id: int, request: Request) -> dict:
        actor = getattr(request.state, "account", None)
        if actor is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        target = account_store.get(account_id)
        if target is None:
            raise HTTPException(status_code=404, detail="No such workspace")
        # You may delete your own workspace; the owner may delete any other. The
        # owner workspace itself cannot be deleted — it is the recovery path.
        if target.is_owner:
            raise HTTPException(status_code=400, detail="The owner workspace cannot be deleted")
        if actor.id != target.id and not actor.is_owner:
            raise HTTPException(status_code=403, detail="You can only delete your own workspace")
        account_store.delete(target.id)
        workspaces.destroy(target.id)
        return {"ok": True, "deleted": target.id}

    @router.post("/api/accounts/{account_id}/rename")
    def rename_account(account_id: int, body: AccountRenameBody, request: Request) -> dict:
        actor = getattr(request.state, "account", None)
        if actor is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        if actor.id != account_id and not actor.is_owner:
            raise HTTPException(status_code=403, detail="You can only rename your own workspace")
        try:
            return {"ok": True, "account": account_store.rename(account_id, body.name).public()}
        except (ValueError, LookupError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # ── accounts: passkeys ────────────────────────────────────────────────────

    @router.post("/api/accounts/webauthn/register/options")
    def passkey_register_options(request: Request) -> dict:
        """Registration is only ever offered INSIDE a signed-in session, which
        is what lets us accept the client's SPKI without parsing attestation:
        whoever is adding the key has already proved they own the workspace."""
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        return {"ok": True, "publicKey": registration_options(
            store=account_store, account=account, party=_relying_party(request)
        )}

    @router.post("/api/accounts/webauthn/register")
    def passkey_register(body: PasskeyRegisterBody, request: Request) -> dict:
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        try:
            verify_registration(
                store=account_store, account_id=account.id, party=_relying_party(request),
                credential_id=body.credential_id, public_key=body.public_key,
                algorithm=body.algorithm, client_data_json=body.client_data_json,
                label=body.label, prf=body.prf,
            )
        except (WebAuthnError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "passkeys": account_store.list_passkeys(account.id)}

    @router.get("/api/accounts/webauthn/passkeys")
    def list_passkeys(request: Request) -> dict:
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        return {"ok": True, "passkeys": account_store.list_passkeys(account.id)}

    @router.delete("/api/accounts/webauthn/passkeys/{credential_id:path}")
    def delete_passkey(credential_id: str, request: Request) -> dict:
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        if not account_store.delete_passkey(account.id, credential_id):
            raise HTTPException(status_code=404, detail="No such passkey on this workspace")
        return {"ok": True, "passkeys": account_store.list_passkeys(account.id)}

    @router.post("/api/accounts/webauthn/authenticate/options")
    def passkey_authenticate_options(body: PasskeyChallengeBody, request: Request) -> dict:
        """Unauthenticated by necessity — this is the sign-in itself.

        With no account_id the browser offers whichever passkey it holds for
        this site and the assertion names the workspace, which is what makes a
        tile openable with a fingerprint and no password.
        """
        account = account_store.get(body.account_id) if body.account_id else None
        if body.account_id and account is None:
            raise HTTPException(status_code=404, detail="No such workspace")
        return {"ok": True, "publicKey": authentication_options(
            store=account_store, party=_relying_party(request), account=account
        )}

    @router.post("/api/accounts/webauthn/authenticate")
    def passkey_authenticate(body: PasskeyAssertionBody, request: Request) -> JSONResponse:
        key = _throttle_key(request, None)
        _guard_throttle(key)
        try:
            account_id = verify_assertion(
                store=account_store, party=_relying_party(request),
                credential_id=body.credential_id, client_data_json=body.client_data_json,
                authenticator_data=body.authenticator_data, signature=body.signature,
            )
        except WebAuthnError as exc:
            _login_failed(key)
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        account = account_store.get(account_id)
        if account is None:
            raise HTTPException(status_code=401, detail="That passkey's workspace no longer exists")
        _login_succeeded(key)
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    # The in-app session probe and the topbar lock button. Both speak to the
    # signed-in workspace; there is no studio-wide password any more.
    @router.get("/api/owner/session")
    def owner_session(request: Request) -> dict:
        account = getattr(request.state, "account", None)
        return {
            "ok": True,
            "unlocked": account is not None,
            "account": account.public() if account else None,
            "expires_in_seconds": _session_remaining_seconds(request) if account else OWNER_SESSION_SECONDS,
        }

    @router.post("/api/owner/lock")
    def owner_lock() -> JSONResponse:
        response = JSONResponse({"ok": True})
        response.delete_cookie(ACCOUNT_COOKIE, path="/", samesite="lax")
        return response

    app.include_router(router)
