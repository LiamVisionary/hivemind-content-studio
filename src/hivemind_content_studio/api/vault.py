"""The workspace vault: its identity, its wraps and its opaque blobs.

Nothing here can read what it stores. Moved out of control_api.py unchanged
(2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .models import VaultBlobBody, VaultIdentityBody, VaultPrfWrapBody, VaultRecoveryWrapBody


def register(app, ctx) -> None:
    """Register the vault identity, wrap and blob routes."""
    router = APIRouter()
    account_store = ctx.account_store
    require_owner = ctx.require_owner
    scoped_account_id = ctx.scoped_account_id
    vault = ctx.vault

    # ── owner vault (client-side E2E; server stores only ciphertext/wrapped keys) ──
    @router.get("/api/vault/identity", dependencies=[Depends(require_owner)])
    def get_vault_identity() -> dict:
        identity = vault().get_identity()
        return {"ok": True, "exists": identity is not None, "identity": identity}

    @router.put("/api/vault/identity", dependencies=[Depends(require_owner)])
    def put_vault_identity(body: VaultIdentityBody) -> dict:
        try:
            vault().put_identity(body.identity, allow_replace=body.allow_replace)
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @router.put("/api/vault/recovery", dependencies=[Depends(require_owner)])
    def put_vault_recovery_wrap(body: VaultRecoveryWrapBody) -> dict:
        """Swap in the copy of the master key held by a NEW recovery key.

        Separate from put_identity for the same reason the PRF route is: that
        call refuses to overwrite an existing vault because rotating an identity
        re-encrypts everything, whereas minting a new recovery key adds one more
        wrap of the SAME master key. Nothing already sealed is touched, and the
        previous recovery key stops working the moment this lands.
        """
        store = vault()
        identity = store.get_identity()
        if not identity:
            raise HTTPException(
                status_code=409,
                detail="This workspace has no vault yet. Reload the studio so it can create one, "
                       "then ask for a recovery key.",
            )
        merged = dict(identity)
        merged["wrapped_mk_recovery"] = body.wrapped_mk_recovery
        try:
            store.put_identity(merged, allow_replace=True)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @router.put("/api/vault/prf/{credential_id:path}", dependencies=[Depends(require_owner)])
    def put_vault_prf_wrap(credential_id: str, body: VaultPrfWrapBody) -> dict:
        """Enrol a passkey as a way to UNWRAP this workspace's master key.

        The browser derives a key from the authenticator's PRF secret, wraps the
        master key with it, and sends the result. This server sees only that
        ciphertext — it has never held the PRF secret, so this route adds an
        unlock path without adding a decryption capability here.
        """
        if not account_store.get_passkey(credential_id):
            raise HTTPException(status_code=404, detail="No such passkey")
        if int(account_store.get_passkey(credential_id)["account_id"]) != scoped_account_id():
            raise HTTPException(status_code=403, detail="That passkey belongs to another workspace")
        try:
            vault().set_prf_wrap(credential_id, body.wrapped_mk)
        except LookupError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        account_store.set_passkey_prf(credential_id, body.wrapped_mk is not None)
        return {"ok": True}

    @router.get("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def get_vault_blob(namespace: str, blob_key: str) -> dict:
        try:
            ciphertext = vault().get_blob(namespace, blob_key)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True, "ciphertext": ciphertext}

    @router.put("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def put_vault_blob(namespace: str, blob_key: str, body: VaultBlobBody) -> dict:
        try:
            vault().put_blob(namespace, blob_key, body.ciphertext)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @router.delete("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def delete_vault_blob(namespace: str, blob_key: str) -> dict:
        try:
            return {"ok": True, "removed": vault().delete_blob(namespace, blob_key)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    app.include_router(router)
