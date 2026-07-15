"""Same-origin browser studio and authenticated controls over canonical services."""

from __future__ import annotations

import contextlib
import hmac
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import yaml

from .approval_config import load_approval_ledger
from .agent_runtime import attach_script
from .approval_ledger import ApprovalLedger
from .asset_store import AssetStore
from .hivemindos_brain import brain_catalog, plan_with_brain
from .generation_telemetry import generation_telemetry_snapshot, record_hivemind_generation_metric
from .lanes import LANE_MATRIX
from .manifest import load_manifest, write_manifest
from .media_catalog import media_catalog
from .hivemindos_oauth import oauth_provider_status, start_oauth_login
from .orchestrator import ContentOrchestrator
from .prompt_history import PromptHistoryStore
from .providers import provider_report
from .shared_env import apply_shared_hive_env
from .studio_drafts import StudioRunDraft
from .template_catalog import template_report
from .unified_runtime import unified_runtime_snapshot


class CancelBody(BaseModel):
    reason: str


class RetryBody(BaseModel):
    step_id: str


class DecisionBody(BaseModel):
    decided_by: str = "owner"


class FavoriteBody(BaseModel):
    favorite: bool


class SimplePlanBody(BaseModel):
    prompt: str
    provider: str
    model: str
    auth: str | None = None
    promptHelper: bool = True
    walkthrough: bool = False
    confirmed: bool = False
    history: list[dict[str, Any]] = []
    attachments: list[dict[str, Any]] = []
    imageSelection: dict[str, str] = {}
    videoSelection: dict[str, str] = {}
    studioMode: Literal["create", "edit", "animate", "workflow"] = "create"


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
    return {
        "studioMode": str(value.get("studioMode") or "create"),
        "brain": _route_snapshot(value.get("brain")),
        "imageSelection": _route_snapshot(value.get("imageSelection")),
        "videoSelection": _route_snapshot(value.get("videoSelection")),
        "promptHelper": bool(value.get("promptHelper", True)),
        "walkthrough": bool(value.get("walkthrough", False)),
    }


def build_control_app(
    *,
    orchestrator: ContentOrchestrator | None = None,
    approvals: ApprovalLedger | None = None,
    control_token: str | None = None,
    operator_token: str | None = None,
) -> FastAPI:
    apply_shared_hive_env()
    runs = orchestrator or ContentOrchestrator(generation_metric_sink=record_hivemind_generation_metric)
    prompt_history = PromptHistoryStore(Path(runs.store.path).parent / "prompt-history.sqlite3")
    configured_control_token = control_token if control_token is not None else os.environ.get("CONTENT_STUDIO_CONTROL_TOKEN", "")
    configured_operator_token = operator_token if operator_token is not None else os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if approvals is None:
        approvals = load_approval_ledger(required=False)

    app = FastAPI(title="Hivemind Content Studio", version="0.2.0")
    ui_root = Path(__file__).resolve().parent / "ui"
    app.mount("/assets", StaticFiles(directory=ui_root), name="studio-assets")

    def record_prompt(
        draft: StudioRunDraft,
        *,
        source: str,
        run_id: str,
        user_prompt: str = "",
        composer: dict[str, Any] | None = None,
    ) -> None:
        """History capture never blocks or fails a production run."""
        with contextlib.suppress(Exception):
            prompt_history.record(
                prompt=(draft.concept or "").strip() or user_prompt or draft.title,
                user_prompt=user_prompt,
                title=draft.title,
                lane=draft.lane,
                source=source,
                run_id=run_id,
                composer=composer,
            )

    def execute_draft(body: StudioRunDraft) -> dict:
        draft_root = Path(runs.store.path).parent / "ui-drafts"
        draft_root.mkdir(parents=True, exist_ok=True)
        descriptor, draft_name = tempfile.mkstemp(prefix="studio-draft-", suffix=".yaml", dir=draft_root)
        draft_path = Path(draft_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                yaml.safe_dump(body.to_brief(), handle, sort_keys=False)
            return runs.execute_content_run(
                draft_path,
                policy={"privacy": body.privacy},
                budget={"max_cost_usd": body.max_cost_usd},
            )
        finally:
            draft_path.unlink(missing_ok=True)

    def require_control(authorization: Annotated[str | None, Header()] = None) -> None:
        if len(configured_control_token) < 12:
            raise HTTPException(status_code=503, detail="Operator mutations are disabled until CONTENT_STUDIO_CONTROL_TOKEN is configured")
        supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
        if not hmac.compare_digest(supplied, configured_control_token):
            raise HTTPException(status_code=401, detail="Valid operator bearer token required")

    @app.get("/", response_class=FileResponse, include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(ui_root / "index.html")

    @app.get("/api/catalog")
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

    @app.get("/api/simple/catalog")
    def simple_catalog() -> dict:
        brains: list[dict] = []
        brain_error = ""
        try:
            value = brain_catalog()
            brains = value.get("providers") if isinstance(value.get("providers"), list) else []
        except RuntimeError as exc:
            brain_error = str(exc)
        return {
            "ok": True,
            "brains": brains,
            "brain_error": brain_error,
            "media": media_catalog(),
            "templates": template_report(),
            "attachment_intake_limit": 30,
            "attachment_note": "The studio can retain up to 30 ordered references. Each selected provider/model receives only roles allowed by its capability schema.",
        }

    @app.get("/api/templates")
    def templates() -> dict:
        return {"ok": True, "templates": template_report()}

    @app.post("/api/simple/plan")
    def simple_plan(body: SimplePlanBody) -> dict:
        try:
            plan = plan_with_brain(body.model_dump())
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from None
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
        }
        return {"ok": True, "plan": plan}

    @app.post("/api/simple/runs", status_code=201)
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
            try:
                source_run = runs.get_run(str(reference.get("run_id") or ""))
            except KeyError:
                raise HTTPException(status_code=400, detail="A saved reference image belongs to an unknown run") from None
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
            if not source_path.is_file() or not source_path.is_relative_to(manifest_root):
                raise HTTPException(status_code=400, detail="The saved reference image is unavailable")
            size = source_path.stat().st_size
            if size > 50 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="A saved reference image exceeds 50 MB")
            total_bytes += size
            if total_bytes > 500 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Reference images exceed the 500 MB production limit")
            payloads.append((source_path.name or f"saved-reference-{index}.png", source_path.read_bytes()))
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
        script_path.write_text(draft.to_script_markdown(), encoding="utf-8")
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

    @app.get("/api/runs")
    def list_runs(status: str = "", limit: int = 100) -> dict:
        return {"ok": True, "runs": runs.list_runs(status=status or None, limit=limit)}

    @app.get("/api/telemetry/generations")
    def generation_telemetry(limit: int = 100) -> dict:
        return generation_telemetry_snapshot(runs.store, limit=limit)

    @app.get("/api/runtime")
    def runtime() -> dict:
        return unified_runtime_snapshot()

    @app.post("/api/runs", status_code=201)
    def create_run(body: StudioRunDraft) -> dict:
        run = execute_draft(body)
        record_prompt(body, source="advanced", run_id=run["run_id"])
        return run

    @app.get("/api/simple/prompts")
    def list_prompts(favorites: bool = False, limit: int = 200) -> dict:
        return {"ok": True, "prompts": prompt_history.list(favorites_only=favorites, limit=limit)}

    @app.post("/api/simple/prompts/{prompt_id}/favorite")
    def favorite_prompt(prompt_id: str, body: FavoriteBody) -> dict:
        try:
            return {"ok": True, "prompt": prompt_history.set_favorite(prompt_id, body.favorite)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.delete("/api/simple/prompts/{prompt_id}")
    def delete_prompt(prompt_id: str) -> dict:
        try:
            prompt_history.delete(prompt_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {"ok": True}

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str) -> dict:
        try:
            return runs.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.get("/api/runs/{run_id}/artifacts/{artifact_id}", response_class=FileResponse)
    def artifact(run_id: str, artifact_id: str) -> FileResponse:
        try:
            run = runs.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        record = next((item for item in run["artifact_records"] if item.get("id") == artifact_id), None)
        if not record:
            raise HTTPException(status_code=404, detail="Artifact not found")
        manifest_root = Path(run["manifest_path"]).expanduser().resolve().parent
        artifact_path = Path(str(record.get("path") or "")).expanduser().resolve()
        if not artifact_path.is_file() or not artifact_path.is_relative_to(manifest_root):
            raise HTTPException(status_code=404, detail="Artifact is unavailable")
        return FileResponse(artifact_path, media_type=record.get("mime_type"), filename=artifact_path.name)

    @app.get("/api/providers")
    def providers() -> dict:
        return {"ok": True, "providers": provider_report()}

    @app.get("/api/oauth")
    def oauth_status() -> dict:
        return {
            "ok": True,
            "providers": {
                provider: oauth_provider_status(provider)
                for provider in ("openai", "xai")
            },
        }

    @app.post("/api/oauth/{provider}/start")
    def oauth_start(provider: str) -> dict:
        try:
            return {"ok": True, **start_oauth_login(provider)}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.post("/api/runs/{run_id}/resume", dependencies=[Depends(require_control)])
    def resume(run_id: str) -> dict:
        return runs.resume_run(run_id)

    @app.post("/api/runs/{run_id}/retry", dependencies=[Depends(require_control)])
    def retry(run_id: str, body: RetryBody) -> dict:
        return runs.retry_step(run_id, body.step_id)

    @app.post("/api/runs/{run_id}/cancel", dependencies=[Depends(require_control)])
    def cancel(run_id: str, body: CancelBody) -> dict:
        return runs.cancel_run(run_id, body.reason)

    @app.get("/api/approvals", dependencies=[Depends(require_control)])
    def list_approvals(run_id: str = "", status: str = "") -> dict:
        if approvals is None:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approvals": approvals.list(run_id=run_id or None, status=status or None)}

    @app.post("/api/approvals/{approval_id}/approve", dependencies=[Depends(require_control)])
    def approve(approval_id: str, body: DecisionBody) -> dict:
        if approvals is None or len(configured_operator_token) < 12:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approval": approvals.approve(approval_id, operator_token=configured_operator_token, decided_by=body.decided_by)}

    @app.post("/api/approvals/{approval_id}/deny", dependencies=[Depends(require_control)])
    def deny(approval_id: str, body: DecisionBody) -> dict:
        if approvals is None or len(configured_operator_token) < 12:
            raise HTTPException(status_code=503, detail="Approval ledger is not configured")
        return {"ok": True, "approval": approvals.deny(approval_id, operator_token=configured_operator_token, decided_by=body.decided_by)}

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("CONTENT_STUDIO_CONTROL_HOST", "127.0.0.1")
    port = int(os.environ.get("CONTENT_STUDIO_CONTROL_PORT", "8765"))
    uvicorn.run(build_control_app(), host=host, port=port)


if __name__ == "__main__":
    main()
