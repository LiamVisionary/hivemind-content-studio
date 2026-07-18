"""Same-origin browser studio and authenticated controls over canonical services."""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import hmac
import json
import mimetypes
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import yaml

from .approval_config import load_approval_ledger
from .agent_runtime import attach_script
from .approval_ledger import ApprovalLedger
from .asset_store import AssetStore
from .canvas_history import (
    CanvasDeleteFetcher,
    CanvasGatewayClient,
    CanvasHistoryFetcher,
    CanvasHistoryStore,
    CanvasMediaFetcher,
    CanvasWorkflowFetcher,
)
from .hivemindos_brain import brain_catalog, local_brain_catalog, plan_with_brain, plan_with_local_brain
from .generation_telemetry import generation_telemetry_snapshot, record_hivemind_generation_metric
from .lanes import LANE_MATRIX
from .manifest import load_manifest, write_manifest
from .machine_privacy import machine_operation_receipt, machine_run_receipt
from .media_catalog import media_catalog
from .media_studio import generate_video as run_media_studio_video
from .hivemindos_oauth import oauth_provider_status, start_oauth_login
from .orchestrator import ContentOrchestrator
from .prompt_history import PromptHistoryStore
from .providers import provider_report, providers_for
from .private_access import OWNER_SESSION_SECONDS, OwnerAccess, PrivateFieldCipher, owner_unlock_html
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


class OwnerUnlockBody(BaseModel):
    password: str


class ConfirmDeleteBody(BaseModel):
    confirm: bool = False


class CanvasProvenanceBody(BaseModel):
    models: list[str] = []
    seeds: list[dict[str, Any]] = []


class MediaStudioVideoBody(BaseModel):
    prompt: str = ""
    workflow_id: str = ""
    image_base64: str | None = None
    video_base64: str | None = None
    video_mode: Literal["extend"] = "extend"
    duration_seconds: float = 4
    aspect_ratio: str = ""


_INLINE_IMAGE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}

_INLINE_VIDEO_SUFFIXES = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "video/x-m4v": ".m4v",
}

_PRIVATE_MEDIA_SUFFIX = ".zenc"


def _private_media_context(path: Path) -> str:
    return f"media-studio-output:{path.name}"


def _private_media_sidecar(path: Path) -> Path:
    return path.with_name(path.name + _PRIVATE_MEDIA_SUFFIX)


def _encrypt_private_media(path: Path, cipher: PrivateFieldCipher) -> bool:
    if os.environ.get("ZIMG_OUTPUT_ENCRYPTION", "1") == "0":
        return False
    path = path.expanduser().resolve()
    sidecar = _private_media_sidecar(path)
    if sidecar.is_file() and not path.exists():
        return True
    if not path.is_file():
        return False
    original_stat = path.stat()
    tmp = sidecar.with_name(f"{sidecar.name}.{os.getpid()}.tmp")
    encrypted = cipher.encrypt_bytes(path.read_bytes(), context=_private_media_context(path))
    try:
        tmp.write_bytes(encrypted)
        os.replace(tmp, sidecar)
        os.utime(sidecar, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        path.unlink()
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    return True


def _private_media_exists(path: Path) -> bool:
    return path.is_file() or _private_media_sidecar(path).is_file()


def _read_private_media(path: Path, cipher: PrivateFieldCipher) -> bytes:
    if path.is_file():
        return path.read_bytes()
    sidecar = _private_media_sidecar(path)
    if not sidecar.is_file():
        raise FileNotFoundError(str(path))
    return cipher.decrypt_bytes(sidecar.read_bytes(), context=_private_media_context(path))


def _private_media_response(body: bytes, *, media_type: str, range_header: str = "") -> Response:
    total = len(body)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": str(total),
    }
    if range_header:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if match:
            start_text, end_text = match.groups()
            if start_text or end_text:
                if not start_text:
                    suffix_length = int(end_text)
                    start = max(total - suffix_length, 0)
                    end = total - 1
                else:
                    start = int(start_text)
                    end = min(int(end_text), total - 1) if end_text else total - 1
                if start >= total or start > end:
                    return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
                body = body[start:end + 1]
                headers["Content-Range"] = f"bytes {start}-{end}/{total}"
                headers["Content-Length"] = str(len(body))
                return Response(content=body, status_code=206, media_type=media_type, headers=headers)
    return Response(content=body, media_type=media_type, headers=headers)


def _public_media_studio_qa(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    allowed = {
        "ok",
        "size_bytes",
        "duration_seconds",
        "width",
        "height",
        "video_codec",
        "audio_codecs",
        "visual_inspection_required",
        "failures",
    }
    return {key: value[key] for key in allowed if key in value}


def _remove_media_studio_qa_artifacts(value: object, output_root: Path) -> None:
    if not isinstance(value, dict) or not value.get("representative_frame"):
        return
    frame = Path(str(value["representative_frame"])).expanduser().resolve()
    qa_root = (output_root / "qa").resolve()
    if not frame.is_relative_to(qa_root):
        return
    with contextlib.suppress(FileNotFoundError):
        frame.unlink()
    with contextlib.suppress(OSError):
        frame.parent.rmdir()


def _public_media_studio_result(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    payload: dict[str, Any] = {}
    job_id = str(value.get("job_id") or value.get("id") or "").strip()
    if job_id:
        payload["job_id"] = job_id
        payload["id"] = job_id
    provider = str(value.get("provider") or "Media Studio").strip()
    if provider:
        payload["provider"] = provider[:160]
    return payload


def _write_inline_media(
    value: str,
    destination_dir: Path,
    *,
    field_name: str,
    mime_suffixes: dict[str, str],
    default_suffix: str,
    max_bytes: int,
) -> Path:
    raw = value.strip()
    if not raw:
        raise ValueError(f"{field_name} is required")
    suffix = default_suffix
    encoded = raw
    if raw.startswith("data:"):
        header, separator, body = raw.partition(",")
        if not separator:
            raise ValueError(f"{field_name} data URL is missing its comma separator")
        mime = header.removeprefix("data:").split(";", 1)[0].lower()
        if mime not in mime_suffixes:
            raise ValueError(f"{field_name} data URL has unsupported media type {mime or 'unknown'}")
        suffix = mime_suffixes[mime]
        encoded = body
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} is not valid base64") from exc
    if not data:
        raise ValueError(f"{field_name} decoded to an empty file")
    if len(data) > max_bytes:
        raise ValueError(f"{field_name} is too large; max {max_bytes // 1024 // 1024} MB")
    destination_dir.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix="media-studio-input-", suffix=suffix, dir=destination_dir)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    return Path(filename)


def _write_inline_image(value: str, destination_dir: Path) -> Path:
    return _write_inline_media(
        value,
        destination_dir,
        field_name="image_base64",
        mime_suffixes=_INLINE_IMAGE_SUFFIXES,
        default_suffix=".png",
        max_bytes=32 * 1024 * 1024,
    )


def _write_inline_video(value: str, destination_dir: Path) -> Path:
    return _write_inline_media(
        value,
        destination_dir,
        field_name="video_base64",
        mime_suffixes=_INLINE_VIDEO_SUFFIXES,
        default_suffix=".mp4",
        max_bytes=100 * 1024 * 1024,
    )


def _machine_route_allowed(path: str, method: str) -> bool:
    if path.startswith("/api/owner/") or path == "/healthz":
        return True
    if method == "GET" and path in {
        "/api/catalog",
        "/api/providers",
        "/api/runtime",
        "/api/telemetry/generations",
    }:
        return True
    if path == "/api/runs" and method in {"GET", "POST"}:
        return True
    if path == "/api/media-studio/video" and method == "POST":
        return True
    if method == "GET" and re.fullmatch(r"/api/runs/[^/]+", path):
        return True
    return bool(method == "POST" and re.fullmatch(r"/api/runs/[^/]+/(resume|retry|cancel)", path))


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
    seed: int | None = None
    seedMode: Literal["fixed", "randomize", "increment", "decrement"] | None = None
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


def build_control_app(
    *,
    orchestrator: ContentOrchestrator | None = None,
    approvals: ApprovalLedger | None = None,
    control_token: str | None = None,
    operator_token: str | None = None,
    owner_access: OwnerAccess | None = None,
    private_cipher: PrivateFieldCipher | None = None,
    canvas_history: CanvasHistoryStore | None = None,
    canvas_history_fetcher: CanvasHistoryFetcher | None = None,
    canvas_media_fetcher: CanvasMediaFetcher | None = None,
    canvas_workflow_fetcher: CanvasWorkflowFetcher | None = None,
    canvas_delete_fetcher: CanvasDeleteFetcher | None = None,
) -> FastAPI:
    apply_shared_hive_env()
    runs = orchestrator or ContentOrchestrator(generation_metric_sink=record_hivemind_generation_metric)
    cipher = private_cipher or PrivateFieldCipher.from_keychain(
        service=os.environ.get("ZIMG_OUTPUT_KEYCHAIN_SERVICE", "zimage-output-encryption")
    )
    access = owner_access or OwnerAccess.from_runtime(cipher)
    prompt_history = PromptHistoryStore(Path(runs.store.path).parent / "prompt-history.sqlite3", cipher=cipher)
    canvas_store = canvas_history or CanvasHistoryStore(Path(runs.store.path).parent / "canvas-history.sqlite3", cipher=cipher)
    canvas_gateway = CanvasGatewayClient()
    fetch_canvas_history = canvas_history_fetcher or canvas_gateway.history
    fetch_canvas_media = canvas_media_fetcher or canvas_gateway.media
    fetch_canvas_workflow = canvas_workflow_fetcher or canvas_gateway.workflow
    delete_canvas_output = canvas_delete_fetcher or canvas_gateway.delete
    configured_control_token = control_token if control_token is not None else os.environ.get("CONTENT_STUDIO_CONTROL_TOKEN", "")
    configured_operator_token = operator_token if operator_token is not None else os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if approvals is None:
        approvals = load_approval_ledger(required=False)

    app = FastAPI(title="Hivemind Content Studio", version="0.2.0")
    unlock_failures: dict[str, deque[float]] = defaultdict(deque)
    ui_root = Path(__file__).resolve().parent / "ui"
    repository_root = Path(__file__).resolve().parents[2]
    open_gen_dist = repository_root / "packages/open-generative-ai/dist"
    media_studio_input_root = Path(runs.store.path).parent / "uploads" / "media-studio"
    media_studio_output_root = Path(runs.store.path).parent / "generated" / "media-studio"
    app.mount("/assets", StaticFiles(directory=ui_root), name="studio-assets")
    app.mount("/open-gen", StaticFiles(directory=open_gen_dist, html=True, check_dir=False), name="open-generative-ai")

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

    @app.middleware("http")
    async def enforce_owner_boundary(request: Request, call_next):
        is_owner = access.valid(request.cookies.get(access.cookie_name))
        request.state.is_owner = is_owner
        if not is_owner and not _machine_route_allowed(request.url.path, request.method):
            if request.method in {"GET", "HEAD"} and (
                request.url.path == "/" or "text/html" in request.headers.get("accept", "")
            ):
                response = HTMLResponse(owner_unlock_html(), status_code=200)
            else:
                response = JSONResponse(
                    {"detail": "Owner password required", "privacy": "owner-locked"},
                    status_code=401,
                )
        else:
            response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        return response

    def require_control(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
        if len(configured_control_token) < 12:
            raise HTTPException(status_code=503, detail="Operator mutations are disabled until CONTENT_STUDIO_CONTROL_TOKEN is configured")
        supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
        if not hmac.compare_digest(supplied, configured_control_token):
            raise HTTPException(status_code=401, detail="Valid operator bearer token required")

    def require_owner_or_control(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
        if bool(getattr(request.state, "is_owner", False)):
            return
        require_control(request, authorization)

    def require_owner(request: Request) -> None:
        if not bool(getattr(request.state, "is_owner", False)):
            raise HTTPException(status_code=401, detail="Owner password required")

    def owner_visible(request: Request, value: dict[str, Any]) -> dict[str, Any]:
        return value if bool(getattr(request.state, "is_owner", False)) else machine_run_receipt(value)

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "service": "hivemind-content-studio", "owner_lock": True}

    @app.get("/api/owner/session")
    def owner_session(request: Request) -> dict:
        return {
            "ok": True,
            "unlocked": bool(getattr(request.state, "is_owner", False)),
            "expires_in_seconds": OWNER_SESSION_SECONDS,
        }

    @app.post("/api/owner/unlock")
    def owner_unlock(body: OwnerUnlockBody, request: Request) -> JSONResponse:
        address = request.client.host if request.client else "unknown"
        now = time.monotonic()
        failures = unlock_failures[address]
        while failures and now - failures[0] > 60:
            failures.popleft()
        if len(failures) >= 8:
            raise HTTPException(status_code=429, detail="Too many unlock attempts")
        if not access.password_matches(body.password):
            failures.append(now)
            raise HTTPException(status_code=401, detail="Wrong password")
        failures.clear()
        response = JSONResponse({"ok": True, "expires_in_seconds": access.session_seconds})
        forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
        response.set_cookie(
            access.cookie_name,
            access.issue(),
            max_age=access.session_seconds,
            httponly=True,
            secure=request.url.scheme == "https" or forwarded == "https",
            samesite="strict",
            path="/",
        )
        return response

    @app.post("/api/owner/lock")
    def owner_lock() -> JSONResponse:
        response = JSONResponse({"ok": True})
        response.delete_cookie(access.cookie_name, path="/", samesite="strict")
        return response

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

    @app.get("/api/surfaces")
    def surfaces() -> dict:
        return {
            "ok": True,
            "surfaces": {
                "explore": {"path": "/open-gen/", "available": (open_gen_dist / "index.html").is_file()},
                "canvas": {"gateway_path": "/mobile/", "available": True},
                "models": {"gateway_path": "/models", "available": True},
                "gateway": {"gateway_path": "/", "available": True},
            },
        }

    @app.api_route("/open-gen-api/{path:path}", methods=["GET", "POST"], dependencies=[Depends(require_owner)])
    async def open_gen_api(path: str, request: Request) -> Response:
        allowed = {
            "health",
            "healthz",
            "local-ai/binary-status",
            "local-ai/models",
            "local-ai/generate",
        }
        if path not in allowed and not (path.startswith("local-ai/job/") and path.removeprefix("local-ai/job/").replace("-", "").replace("_", "").isalnum()):
            raise HTTPException(status_code=404, detail="OpenGen bridge route not found")
        body = await request.body()

        def forward() -> tuple[bytes, int, str]:
            proxy_request = urllib.request.Request(
                f"http://127.0.0.1:8794/{path}",
                data=body or None,
                method=request.method,
                headers={"Content-Type": request.headers.get("content-type", "application/json")},
            )
            try:
                with urllib.request.urlopen(proxy_request, timeout=190) as upstream:
                    return upstream.read(), upstream.status, upstream.headers.get("content-type", "application/json")
            except urllib.error.HTTPError as exc:
                return exc.read(), exc.code, exc.headers.get("content-type", "application/json")
            except (OSError, urllib.error.URLError) as exc:
                raise RuntimeError("OpenGen local inference bridge is unavailable") from exc

        try:
            content, status, content_type = await asyncio.to_thread(forward)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        return Response(content=content, status_code=status, media_type=content_type.split(";", 1)[0])

    @app.get("/api/simple/catalog")
    def simple_catalog() -> dict:
        brains: list[dict] = []
        brain_error = ""
        try:
            value = brain_catalog()
            brains = value.get("providers") if isinstance(value.get("providers"), list) else []
        except RuntimeError as exc:
            brain_error = str(exc)
            brains = local_brain_catalog()["providers"]
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

    @app.post("/api/simple/plan", dependencies=[Depends(require_owner)])
    def simple_plan(body: SimplePlanBody) -> dict:
        if body.provider == "local-planner":
            plan = plan_with_local_brain(body.model_dump())
        else:
            try:
                plan = plan_with_brain(body.model_dump())
            except RuntimeError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from None
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

    @app.post("/api/simple/runs", status_code=201, dependencies=[Depends(require_owner)])
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
    def list_runs(request: Request, status: str = "", limit: int = 100) -> dict:
        values = runs.list_runs(status=status or None, limit=limit)
        return {"ok": True, "runs": values if request.state.is_owner else [machine_run_receipt(value) for value in values]}

    @app.get("/api/telemetry/generations")
    def generation_telemetry(limit: int = 100) -> dict:
        return generation_telemetry_snapshot(runs.store, limit=limit)

    @app.get("/api/runtime")
    def runtime() -> dict:
        return unified_runtime_snapshot()

    @app.post("/api/runs", status_code=201, dependencies=[Depends(require_owner_or_control)])
    def create_run(body: StudioRunDraft, request: Request) -> dict:
        run = execute_draft(body)
        record_prompt(body, source="advanced", run_id=run["run_id"])
        return owner_visible(request, run)

    @app.get("/api/simple/prompts", dependencies=[Depends(require_owner)])
    def list_prompts(favorites: bool = False, limit: int = 200) -> dict:
        return {"ok": True, "prompts": prompt_history.list(favorites_only=favorites, limit=limit)}

    @app.post("/api/simple/prompts/{prompt_id}/favorite", dependencies=[Depends(require_owner)])
    def favorite_prompt(prompt_id: str, body: FavoriteBody) -> dict:
        try:
            return {"ok": True, "prompt": prompt_history.set_favorite(prompt_id, body.favorite)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.delete("/api/simple/prompts/{prompt_id}", dependencies=[Depends(require_owner)])
    def delete_prompt(prompt_id: str) -> dict:
        try:
            prompt_history.delete(prompt_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {"ok": True}

    @app.post("/api/media-studio/video", dependencies=[Depends(require_owner_or_control)])
    async def generate_media_studio_video(body: MediaStudioVideoBody, request: Request) -> dict:
        image: Path | None = None
        video: Path | None = None
        try:
            if body.video_base64:
                video = _write_inline_video(body.video_base64, media_studio_input_root)
            elif body.image_base64:
                image = _write_inline_image(body.image_base64, media_studio_input_root)
            else:
                raise ValueError("image_base64 or video_base64 is required")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        started = time.perf_counter()
        try:
            result = await asyncio.to_thread(
                run_media_studio_video,
                image_path=image,
                video_path=video,
                video_mode=body.video_mode,
                prompt=body.prompt.strip(),
                duration_seconds=body.duration_seconds,
                workflow_id=body.workflow_id.strip() or None,
                output_dir=media_studio_output_root,
            )
        except (FileNotFoundError, RuntimeError, TimeoutError, ValueError) as exc:
            detail = str(exc) if bool(getattr(request.state, "is_owner", False)) else "Media generation failed"
            raise HTTPException(status_code=503, detail=detail) from None
        finally:
            for source in (image, video):
                if source is not None:
                    with contextlib.suppress(FileNotFoundError):
                        source.unlink()
        _remove_media_studio_qa_artifacts(result.get("qa"), media_studio_output_root)
        output = Path(str(result.get("output") or "")).expanduser().resolve()
        root = media_studio_output_root.resolve()
        if not output.is_relative_to(root) or not _private_media_exists(output):
            raise HTTPException(status_code=502, detail="Media Studio returned an unavailable output")
        encrypted_at_rest = _encrypt_private_media(output, cipher)
        if not _private_media_exists(output):
            raise HTTPException(status_code=502, detail="Media Studio output could not be secured")
        elapsed = round(time.perf_counter() - started, 3)
        url = f"/api/media-studio/generated/{urllib.parse.quote(output.name)}"
        response = {
            "ok": True,
            **_public_media_studio_result(result),
            "output": output.name,
            "qa": _public_media_studio_qa(result.get("qa")),
            "encrypted_at_rest": encrypted_at_rest,
            "elapsed_seconds": elapsed,
            "url": url,
            "media_url": url,
        }
        return response if bool(getattr(request.state, "is_owner", False)) else machine_operation_receipt(response)

    @app.get("/api/media-studio/generated/{filename}", dependencies=[Depends(require_owner)])
    def media_studio_generated_video(filename: str, request: Request) -> Response:
        name = Path(filename).name
        output = (media_studio_output_root / name).resolve()
        root = media_studio_output_root.resolve()
        if name != filename or not output.is_relative_to(root) or not _private_media_exists(output):
            raise HTTPException(status_code=404, detail="Generated video not found")
        media_type = mimetypes.guess_type(output.name)[0] or "video/mp4"
        if output.is_file():
            return FileResponse(output, media_type=media_type, filename=output.name)
        try:
            body = _read_private_media(output, cipher)
        except ValueError as exc:
            raise HTTPException(status_code=503, detail="Generated video could not be decrypted") from exc
        return _private_media_response(body, media_type=media_type, range_header=request.headers.get("range", ""))

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str, request: Request) -> dict:
        try:
            return owner_visible(request, runs.get_run(run_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.get("/api/canvas/history", dependencies=[Depends(require_owner)])
    def canvas_output_history(
        page: int = 1,
        page_size: int = 48,
        format: str = "",
        model: str = "",
        limit: int | None = None,
    ) -> dict:
        sync_error = ""
        if page <= 1:
            try:
                canvas_store.sync(fetch_canvas_history())
            except RuntimeError as exc:
                sync_error = str(exc)
        result = canvas_store.page(
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

    @app.get("/api/canvas/history/{history_id}/workflow", dependencies=[Depends(require_owner)])
    def canvas_output_workflow(history_id: str) -> dict:
        try:
            output_name = canvas_store.output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            workflow = fetch_canvas_workflow(output_name)
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {
            "ok": True,
            "workflow": workflow,
            "media_url": f"/api/canvas/history/{urllib.parse.quote(history_id)}/media",
        }

    @app.post("/api/canvas/history/{history_id}/provenance", dependencies=[Depends(require_owner)])
    def remember_canvas_provenance(history_id: str, body: CanvasProvenanceBody) -> dict:
        try:
            metadata = canvas_store.remember_provenance(history_id, models=body.models, seeds=body.seeds)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        return {"ok": True, **metadata}

    @app.delete("/api/canvas/history/{history_id}", dependencies=[Depends(require_owner)])
    def delete_canvas_history_output(history_id: str, body: ConfirmDeleteBody) -> dict:
        if not body.confirm:
            raise HTTPException(status_code=400, detail="Permanent deletion requires confirm=true")
        try:
            output_name = canvas_store.output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            result = delete_canvas_output(output_name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        removed_rows = canvas_store.delete(history_id)
        return {"ok": True, "removed_history_rows": removed_rows, **result}

    @app.get("/api/canvas/history/{history_id}/media", response_class=Response, dependencies=[Depends(require_owner)])
    def canvas_output_media(history_id: str) -> Response:
        try:
            output_name = canvas_store.output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            content, media_type = fetch_canvas_media(output_name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        return Response(content=content, media_type=media_type, headers={"Cache-Control": "private, no-store"})

    @app.get(
        "/api/runs/{run_id}/artifacts/{artifact_id}",
        response_class=FileResponse,
        dependencies=[Depends(require_owner)],
    )
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

    @app.post("/api/runs/{run_id}/resume", dependencies=[Depends(require_owner_or_control)])
    def resume(run_id: str, request: Request) -> dict:
        return owner_visible(request, runs.resume_run(run_id))

    @app.post("/api/runs/{run_id}/retry", dependencies=[Depends(require_owner_or_control)])
    def retry(run_id: str, body: RetryBody, request: Request) -> dict:
        return owner_visible(request, runs.retry_step(run_id, body.step_id))

    @app.post("/api/runs/{run_id}/cancel", dependencies=[Depends(require_owner_or_control)])
    def cancel(run_id: str, body: CancelBody, request: Request) -> dict:
        return owner_visible(request, runs.cancel_run(run_id, body.reason))

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
