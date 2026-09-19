"""Runs: planning one, starting one, listing them and acting on one.

Moved out of control_api.py unchanged (2026-09-04). Which runs a workspace
may see is ctx.require_visible_run and ctx.claim_visible, which is where it
was before.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from ..agent_runtime import attach_script
from ..asset_store import AssetStore
from ..hivemindos_brain import plan_with_local_brain
from ..machine_privacy import machine_run_receipt
from ..manifest import load_manifest, write_manifest
from ..orchestrator import RunRecordUnavailable
from ..private_access import (
    is_private_text_file,
    private_media_exists,
    read_private_media,
    read_private_text,
    write_private_text,
)
from ..providers import providers_for
from ..studio_drafts import StudioRunDraft
from ..template_catalog import template_report
from .media_common import _private_media_response
from .models import CancelBody, RetryBody, SimplePlanBody


def _route_snapshot(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {"provider": "automatic", "model": "automatic"}
    provider = str(value.get("provider") or "automatic")[:160]
    model = str(value.get("model") or "automatic")[:240]
    auth = str(value.get("auth") or "")[:40]
    return {"provider": provider, "model": model, **({"auth": auth} if auth else {})}


def _composer_snapshot(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    snapshot = {
        "studioMode": str(value.get("studioMode") or "create"),
        "brain": _route_snapshot(value.get("brain")),
        "imageSelection": _route_snapshot(value.get("imageSelection")),
        "videoSelection": _route_snapshot(value.get("videoSelection")),
        "promptHelper": bool(value.get("promptHelper", True)),
        "walkthrough": bool(value.get("walkthrough", False)),
    }
    if value.get("seedMode") in {"fixed", "randomize", "increment", "decrement"}:
        snapshot["seedMode"] = str(value["seedMode"])
    if isinstance(value.get("seed"), int):
        snapshot["seed"] = int(value["seed"])
    return snapshot


def register(app, ctx) -> None:
    """Register the plan, run and artifact routes."""
    router = APIRouter()
    cp = ctx.control_api
    claim_visible = ctx.claim_visible
    execute_draft = ctx.execute_draft
    owner_visible = ctx.owner_visible
    record_prompt = ctx.record_prompt
    require_owner = ctx.require_owner
    require_owner_or_control = ctx.require_owner_or_control
    require_visible_run = ctx.require_visible_run
    run_claims = ctx.run_claims
    runs = ctx.runs

    @router.get("/api/templates")
    def templates() -> dict:
        return {"ok": True, "templates": template_report()}

    @router.post("/api/simple/plan", dependencies=[Depends(require_owner)])
    def simple_plan(body: SimplePlanBody) -> dict:
        if body.provider == "local-planner":
            plan = plan_with_local_brain(body.model_dump())
        else:
            try:
                plan = cp.plan_with_brain(body.model_dump())
            except RuntimeError as exc:
                # HivemindOS's own error body — another product's prose, or a
                # bare "HivemindOS returned HTTP 502" — is not something to put
                # in a person's thread. One sentence with the repair beside it;
                # the original goes to the log, where it is useful.
                print(f"[content-studio] planner brain failed: {exc}", file=sys.stderr)
                raise HTTPException(status_code=502, detail={
                    "message": "The planner could not reach HivemindOS.",
                    "remedy": "connect-account",
                    "provider": "hivemindos",
                }) from None
        draft = plan.get("draft")
        if isinstance(draft, dict):
            selections = (("keyframe", body.imageSelection), ("motion", body.videoSelection))
            for role, selection in selections:
                if not isinstance(selection, dict):
                    continue
                provider = str(selection.get("provider") or "automatic")
                model = str(selection.get("model") or "automatic")
                if provider == "automatic" or provider not in {item.id for item in providers_for(role)}:
                    continue
                draft.setdefault("providers", {})[role] = provider
                if model != "automatic":
                    draft.setdefault("provider_options", {}).setdefault(provider, {})[role] = {"model": model}
            if body.seed is not None or body.seedMode is not None:
                draft.setdefault("provider_options", {})["_studio_generation"] = {
                    **({"seed": body.seed} if body.seed is not None else {}),
                    **({"seed_mode": body.seedMode} if body.seedMode is not None else {}),
                }
        plan["selections"] = {
            "image": body.imageSelection or {"provider": "automatic", "model": "automatic"},
            "video": body.videoSelection or {"provider": "automatic", "model": "automatic"},
        }
        plan["composer"] = {
            "studioMode": body.studioMode,
            "brain": _route_snapshot({"provider": body.provider, "model": body.model, "auth": body.auth}),
            "imageSelection": _route_snapshot(body.imageSelection),
            "videoSelection": _route_snapshot(body.videoSelection),
            "promptHelper": body.promptHelper,
            "walkthrough": body.walkthrough,
            **({"seed": body.seed} if body.seed is not None else {}),
            **({"seedMode": body.seedMode} if body.seedMode is not None else {}),
        }
        return {"ok": True, "plan": plan}

    @router.post("/api/simple/runs", status_code=201, dependencies=[Depends(require_owner)])
    async def create_simple_run(
        plan_json: Annotated[str, Form()],
        images: Annotated[list[UploadFile] | None, File()] = None,
    ) -> dict:
        try:
            plan = json.loads(plan_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Production plan is not valid JSON") from exc
        if not isinstance(plan, dict) or not isinstance(plan.get("draft"), dict):
            raise HTTPException(status_code=400, detail="Production plan has no validated draft")
        uploads = images or []
        reused = plan.get("reference_artifacts", [])
        if not isinstance(reused, list) or any(not isinstance(item, dict) for item in reused):
            raise HTTPException(status_code=400, detail="Saved reference images are not valid")
        if len(uploads) + len(reused) > 30:
            raise HTTPException(status_code=400, detail="A production can retain at most 30 reference images")
        payloads: list[tuple[str, bytes]] = []
        total_bytes = 0
        for index, reference in enumerate(reused, start=1):
            source_run_id = str(reference.get("run_id") or "")
            try:
                source_run = runs.get_run(source_run_id)
            except KeyError:
                raise HTTPException(status_code=400, detail="A saved reference image belongs to an unknown run") from None
            # Another workspace's run is "unknown" here too — reusing its
            # artifacts would read that workspace's media into this one.
            if not claim_visible(run_claims.account_for(source_run_id)):
                raise HTTPException(status_code=400, detail="A saved reference image belongs to an unknown run")
            record = next(
                (item for item in source_run["artifact_records"] if item.get("id") == reference.get("artifact_id")),
                None,
            )
            if not record or not str(record.get("role") or "").startswith("reference-"):
                raise HTTPException(status_code=400, detail="Only a run's reference image artifacts can be reused")
            if not str(record.get("mime_type") or "").startswith("image/"):
                raise HTTPException(status_code=400, detail="The saved reference image is not an image")
            manifest_root = Path(source_run["manifest_path"]).expanduser().resolve().parent
            source_path = Path(str(record.get("path") or "")).expanduser().resolve()
            if not private_media_exists(source_path) or not source_path.is_relative_to(manifest_root):
                raise HTTPException(status_code=400, detail="The saved reference image is unavailable")
            try:
                data = read_private_media(source_path)
            except ValueError:
                raise HTTPException(status_code=400, detail="The saved reference image could not be decrypted") from None
            if len(data) > 50 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="A saved reference image exceeds 50 MB")
            total_bytes += len(data)
            if total_bytes > 500 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Reference images exceed the 500 MB production limit")
            payloads.append((source_path.name or f"saved-reference-{index}.png", data))
        for upload in uploads:
            if not (upload.content_type or "").startswith("image/"):
                raise HTTPException(status_code=400, detail=f"{upload.filename or 'Attachment'} is not an image")
            data = await upload.read()
            if len(data) > 50 * 1024 * 1024:
                raise HTTPException(status_code=400, detail=f"{upload.filename or 'Attachment'} exceeds 50 MB")
            total_bytes += len(data)
            if total_bytes > 500 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Reference images exceed the 500 MB production limit")
            payloads.append((upload.filename or f"reference-{len(payloads) + 1}.png", data))
        try:
            draft = StudioRunDraft.model_validate(plan["draft"])
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"The brain returned an invalid production draft: {exc}") from None
        run = execute_draft(draft)
        if payloads:
            store = AssetStore()
            try:
                for index, (file_name, data) in enumerate(payloads, start=1):
                    role = "reference-image"
                    if len(payloads) > 1 and index == 1:
                        role = "reference-start-frame"
                    elif len(payloads) > 1 and index == len(payloads):
                        role = "reference-end-frame"
                    store.ingest_bytes(
                        run["manifest_path"],
                        file_name=file_name,
                        data=data,
                        role=role,
                        provider="studio-upload",
                        scene=index,
                    )
            except ValueError as exc:
                runs.cancel_run(run["run_id"], f"Reference image validation failed: {exc}")
                raise HTTPException(status_code=400, detail=str(exc)) from None
        composer = _composer_snapshot(plan.get("composer"))
        manifest_path = Path(run["manifest_path"])
        manifest = load_manifest(manifest_path)
        manifest["studio"] = {
            "composer": composer,
            "user_prompt": str(plan.get("user_prompt") or "").strip()[:20_000],
        }
        write_manifest(manifest_path, manifest)
        script_path = manifest_path.parent / "script.md"
        write_private_text(script_path, draft.to_script_markdown())
        brain = composer.get("brain") if isinstance(composer.get("brain"), dict) else {}
        runtime = f"{brain.get('provider', 'agent-brain')}:{brain.get('model', 'automatic')}"
        attach_script(manifest_path, script_path, runtime=runtime, copy=False)
        run = runs.resume_run(run["run_id"])
        record_prompt(
            draft,
            source="simple",
            run_id=run["run_id"],
            user_prompt=str(plan.get("user_prompt") or ""),
            composer=composer,
        )
        return {**run, "plan": plan}

    @router.get("/api/runs")
    def list_runs(request: Request, status: str = "", limit: int = 100) -> dict:
        values = runs.list_runs(status=status or None, limit=limit)
        claims = run_claims.accounts_for([str(value.get("run_id") or "") for value in values])
        values = [
            value for value in values
            if claim_visible(claims.get(str(value.get("run_id") or "")))
        ]
        return {"ok": True, "runs": values if request.state.is_owner else [machine_run_receipt(value) for value in values]}

    @router.post("/api/runs", status_code=201, dependencies=[Depends(require_owner_or_control)])
    def create_run(body: StudioRunDraft, request: Request) -> dict:
        try:
            run = execute_draft(body)
        except ValueError as exc:
            # "A run requires at least one step" and its siblings: the
            # caller's brief, not the server.
            raise HTTPException(status_code=400, detail=str(exc)) from None
        record_prompt(body, source="advanced", run_id=run["run_id"])
        return owner_visible(request, run)

    @router.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict:
        return owner_visible(request, require_visible_run(run_id))

    @router.get(
        "/api/runs/{run_id}/artifacts/{artifact_id}",
        response_class=Response,
        dependencies=[Depends(require_owner)],
    )
    def artifact(run_id: str, artifact_id: str, request: Request) -> Response:
        run = require_visible_run(run_id)
        record = next((item for item in run["artifact_records"] if item.get("id") == artifact_id), None)
        if not record:
            raise HTTPException(status_code=404, detail="Artifact not found")
        manifest_root = Path(run["manifest_path"]).expanduser().resolve().parent
        artifact_path = Path(str(record.get("path") or "")).expanduser().resolve()
        if not private_media_exists(artifact_path) or not artifact_path.is_relative_to(manifest_root):
            raise HTTPException(status_code=404, detail="Artifact is unavailable")
        if artifact_path.is_file() and is_private_text_file(artifact_path):
            try:
                body = read_private_text(artifact_path).encode("utf-8")
            except Exception:
                raise HTTPException(status_code=503, detail="Artifact could not be decrypted") from None
            return Response(
                content=body,
                media_type=record.get("mime_type") or "text/plain",
                headers={
                    "Cache-Control": "private, no-store",
                    "Content-Disposition": f'inline; filename="{artifact_path.name}"',
                },
            )
        if artifact_path.is_file():
            return FileResponse(artifact_path, media_type=record.get("mime_type"), filename=artifact_path.name)
        try:
            body = read_private_media(artifact_path)
        except ValueError:
            raise HTTPException(status_code=503, detail="Artifact could not be decrypted") from None
        return _private_media_response(
            body,
            media_type=record.get("mime_type") or "application/octet-stream",
            range_header=request.headers.get("range", ""),
        )

    @router.post("/api/runs/{run_id}/resume", dependencies=[Depends(require_owner_or_control)])
    def resume(run_id: str, request: Request) -> dict:
        require_visible_run(run_id)
        try:
            return owner_visible(request, runs.resume_run(run_id))
        except RunRecordUnavailable as exc:
            # The row lists (degraded) but cannot be driven. A sentence, not an
            # incident id an agent can do nothing with.
            raise HTTPException(status_code=409, detail=str(exc)) from None

    @router.post("/api/runs/{run_id}/retry", dependencies=[Depends(require_owner_or_control)])
    def retry(run_id: str, body: RetryBody, request: Request) -> dict:
        require_visible_run(run_id)
        try:
            return owner_visible(request, runs.retry_step(run_id, body.step_id))
        except RunRecordUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except KeyError as exc:
            # An unknown step id. str() of a KeyError keeps its quotes; the
            # message inside is the store's own sentence.
            raise HTTPException(status_code=404, detail=str(exc.args[0] if exc.args else exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @router.post("/api/runs/{run_id}/cancel", dependencies=[Depends(require_owner_or_control)])
    def cancel(run_id: str, body: CancelBody, request: Request) -> dict:
        require_visible_run(run_id)
        return owner_visible(request, runs.cancel_run(run_id, body.reason))

    app.include_router(router)
