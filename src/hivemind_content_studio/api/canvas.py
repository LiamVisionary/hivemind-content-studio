"""History: what the machine's gateway rendered, listed per workspace.

Moved out of control_api.py unchanged (2026-09-04). Which rows a workspace
may see is ctx.claim_visible and the sync in api/context.py.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import urllib.request
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from ..canvas_history import CanvasWorkflowMissing
from ..private_access import e2e_media_sidecar
from ..settings import load_settings
from .media_common import _private_media_sidecar, _requester_pub
from .models import CanvasProvenanceBody, CanvasResealBody, ConfirmDeleteBody


def register(app, ctx) -> None:
    """Register the canvas history routes."""
    router = APIRouter()
    _forget_canvas_sync = ctx._forget_canvas_sync
    _generated_output_response = ctx._generated_output_response
    _own_generated_output = ctx._own_generated_output
    _sync_canvas_history_cached = ctx._sync_canvas_history_cached
    canvas_store = ctx.canvas_store
    delete_canvas_output = ctx.delete_canvas_output
    fetch_canvas_media = ctx.fetch_canvas_media
    fetch_canvas_workflow = ctx.fetch_canvas_workflow
    require_owner = ctx.require_owner

    @router.get("/api/canvas/history", dependencies=[Depends(require_owner)])
    def canvas_output_history(
        page: int = 1,
        page_size: int = 48,
        format: str = "",
        model: str = "",
        limit: int | None = None,
        refresh: bool = False,
    ) -> dict:
        sync_error = ""
        if page <= 1:
            try:
                _sync_canvas_history_cached(refresh=refresh)
            except RuntimeError as exc:
                sync_error = str(exc)
        result = canvas_store().page(
            page=page,
            page_size=limit if limit is not None else page_size,
            file_format=format,
            model=model,
        )
        return {
            "ok": True,
            "source_preserved": True,
            "privacy": "Prompts, workflow graphs, tokens, filesystem paths, and media bytes are excluded from the paginated history response.",
            "history": result["items"],
            "pagination": {key: result[key] for key in ("page", "page_size", "total", "has_more")},
            "filters": result["filters"],
            **({"sync_error": sync_error} if sync_error else {}),
        }

    @router.get("/api/canvas/history/{history_id}/workflow", dependencies=[Depends(require_owner)])
    def canvas_output_workflow(history_id: str) -> dict:
        # Every detail route below resolves history_id through THIS workspace's
        # store, which holds only rows it may see (sync above) — a sibling's
        # ids are simply unknown here, so hidden and absent read the same.
        try:
            output_name = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            workflow = fetch_canvas_workflow(output_name)
        except CanvasWorkflowMissing as exc:
            # A recorded output with no graph behind it is an answer, not a
            # failure (2026-09-07): History reads this for every card that
            # scrolls into view, and a 404 here was a red console line per
            # imported file on every visit. The 404 below stays for an
            # unreachable gateway, which the client must not cache as "none".
            return {
                "ok": True,
                "workflow": None,
                "unavailable": str(exc),
                "media_url": f"/api/canvas/history/{urllib.parse.quote(history_id)}/media",
            }
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {
            "ok": True,
            "workflow": workflow,
            "media_url": f"/api/canvas/history/{urllib.parse.quote(history_id)}/media",
        }

    @router.post("/api/canvas/history/{history_id}/provenance", dependencies=[Depends(require_owner)])
    def remember_canvas_provenance(history_id: str, body: CanvasProvenanceBody) -> dict:
        try:
            metadata = canvas_store().remember_provenance(history_id, models=body.models, seeds=body.seeds)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        return {"ok": True, **metadata}

    @router.delete("/api/canvas/history/{history_id}", dependencies=[Depends(require_owner)])
    def delete_canvas_history_output(history_id: str, body: ConfirmDeleteBody) -> dict:
        if not body.confirm:
            raise HTTPException(status_code=400, detail="Permanent deletion requires confirm=true")
        try:
            output_name = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        own = _own_generated_output(output_name)
        if own is not None:
            # Ours to remove: the plaintext file, whichever sealed form it took,
            # and the row. Asking the gateway to delete a path it never held
            # would answer 503 and leave the output on this disk.
            removed = 0
            for candidate in (own, _private_media_sidecar(own), e2e_media_sidecar(own)):
                with contextlib.suppress(FileNotFoundError, OSError):
                    candidate.unlink()
                    removed += 1
            canvas_store().delete(history_id)
            _forget_canvas_sync()
            if not removed:
                raise HTTPException(
                    status_code=404,
                    detail="That output was already gone; its History row has been cleared.",
                )
            return {"ok": True, "removed_history_rows": 1, "deleted_files": removed}
        try:
            result = delete_canvas_output(output_name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        removed_rows = canvas_store().delete(history_id)
        _forget_canvas_sync()
        if not int(result.get("deleted_files") or 0) and not int(result.get("history_records") or 0):
            # Nothing on disk and no gateway record: the output was already
            # gone. The stale row is cleared above; say so rather than
            # reporting a deletion that did not happen.
            raise HTTPException(
                status_code=404,
                detail="That output was already gone; its History row has been cleared.",
            )
        return {"ok": True, "removed_history_rows": removed_rows, **result}

    @router.get("/api/canvas/history/{history_id}/media", response_class=Response, dependencies=[Depends(require_owner)])
    def canvas_output_media(history_id: str, request: Request) -> Response:
        try:
            output_name = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        # An adopted cloud result lives in this workspace's own outputs root,
        # which the gateway has never heard of. Serve it from where it is.
        own = _own_generated_output(output_name)
        if own is not None:
            return _generated_output_response(own, request)
        try:
            # Presenting the caller's key is what selects the envelope: a device
            # that generated this clip gets the copy sealed to itself, everyone
            # else gets the owner's. Without it a device-sealed output would
            # only ever come back in a form the browser cannot open.
            # Agent generations are workspace-public: when the browser asks with
            # ?reveal=agent (it does after an envelope it cannot open), serve the
            # agent copy decrypted. require_owner already gates this to the
            # signed-in workspace, and the gateway only reveals a file sealed to
            # its agent key -- never a private clip.
            reveal_agent = request.query_params.get("reveal") == "agent"
            content, media_type = fetch_canvas_media(
                output_name, requester_pub=_requester_pub(request), reveal_agent=reveal_agent)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        headers = {"Cache-Control": "private, no-store"}
        if "hivemind.e2e" in (media_type or ""):
            # Mirror the gateway so the browser's E2E detection works off the
            # header it already looks for, not only the content type.
            headers["X-E2E-Media"] = "1"
        return Response(content=content, media_type=media_type, headers=headers)

    @router.put("/api/canvas/history/{history_id}/reseal", dependencies=[Depends(require_owner)])
    def canvas_output_reseal(history_id: str, body: CanvasResealBody) -> dict:
        """Replace one item's owner envelope with one the browser just sealed
        to the workspace vault.

        The recovery door for media sealed to a key that has since been lost:
        the browser held some other private key (an old agent key, a browser
        key from a backup), opened the clip with it, and re-sealed the bytes to
        the vault. This server never sees plaintext -- only a well-formed
        envelope -- and never deletes: the previous file stays beside the new
        one as <name>.e2e.superseded, so this is reversible by moving it back.

        Off unless developer.recovery_tools is on: it is a repair tool, not a
        feature, and an owner session should not be able to rewrite media
        files by default.
        """
        if not load_settings().developer.recovery_tools:
            raise HTTPException(status_code=404, detail="Recovery tools are off")
        try:
            wrapped = base64.urlsafe_b64decode(body.wrapped_dek + "=" * (-len(body.wrapped_dek) % 4))
        except (ValueError, TypeError):
            raise HTTPException(status_code=422, detail="wrapped_dek is not base64url") from None
        if body.v != 1 or len(wrapped) != 256 or not body.ciphertext or len(body.ciphertext) < 24:
            raise HTTPException(status_code=422, detail="Not a v1 envelope sealed to an RSA-2048 key")
        media_type = str(body.media_type or "application/octet-stream")[:80]
        if "/" not in media_type or any(ch in media_type for ch in " \n\r\t\""):
            raise HTTPException(status_code=422, detail="media_type is not a MIME type")
        try:
            locator = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        base = Path(str(locator)).expanduser()
        target = base.with_name(base.name + ".e2e")
        if not target.parent.is_dir():
            raise HTTPException(status_code=409, detail="This item's media is not on this machine")
        envelope = json.dumps({"v": 1, "media_type": media_type,
                               "wrapped_dek": body.wrapped_dek, "ciphertext": body.ciphertext})
        tmp = target.with_name(target.name + ".partial")
        tmp.write_text(envelope, encoding="utf-8")
        # Re-read what was written before anything is displaced.
        check = json.loads(tmp.read_text(encoding="utf-8"))
        if len(base64.urlsafe_b64decode(check["wrapped_dek"] + "=" * (-len(check["wrapped_dek"]) % 4))) != 256:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail="Envelope did not round-trip")
        superseded = None
        if target.exists():
            superseded = target.with_name(target.name + ".superseded")
            os.replace(target, superseded)          # keep, never delete
        os.replace(tmp, target)
        _forget_canvas_sync()
        return {"ok": True, "resealed": True, "kept_previous": superseded is not None}

    app.include_router(router)
