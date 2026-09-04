"""Same-origin browser studio and authenticated controls over canonical services."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os
import re
import sys
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware


from .config import DataFormatTooNew
from .approval_ledger import ApprovalLedger
from .canvas_history import (
    CanvasDeleteFetcher,
    CanvasHistoryFetcher,
    CanvasHistoryStore,
    CanvasMediaFetcher,
    CanvasWorkflowFetcher,
)
from . import (
    local_llm, media_posters,
)
from .orchestrator import ContentOrchestrator
from .account_gate import account_gate_html
from .accounts import (
    ACCOUNT_COOKIE,
)
from .private_access import (
    OwnerAccess,
    PrivateFieldCipher,
)
from .gpu_rentals import register_gpu_rental_routes
from .observability import (
    access_route,
    configure_logging,
    record_access,
    record_incident,
    remedy_text,
)
from .api import accounts as accounts_routes
from .api import approvals as approvals_routes
from .api import bridge as bridge_routes
from .api import canvas as canvas_routes
from .api import catalog as catalog_routes
from .api import hivemindos as hivemindos_routes
from .api import image as image_routes
from .api import ingredients as ingredients_routes
from .api import lanes as lanes_routes
from .api import muapi as muapi_routes
from .api import oauth as oauth_routes
from .api import passbook as passbook_routes
from .api import prompting as prompting_routes
from .api import references as references_routes
from .api import restore as restore_routes
from .api import runs as runs_routes
from .api import sam3 as sam3_routes
from .api import settings as settings_routes
from .api import shell as shell_routes
from .api import sprite as sprite_routes
from .api import system as system_routes
from .api import vault as vault_routes
from .api import video as video_routes
from .api.context import build_context
# ── the other half of this module ─────────────────────────────────────────────
# This file keeps the app object, the middleware chain, the lifespan and
# main(); every subject's routes live in hivemind_content_studio/api/ (see its
# __init__). Names are imported here rather than only where they are used
# because they are re-exported at their old name: tests import them from
# control_api, and several are PATCHED on this module by name — the route
# modules read those back off it at call time, which is what keeps
# `monkeypatch.setattr("…control_api.run_media_studio_video", …)` working
# after the route moved out.
import subprocess  # noqa: E402, F401 — patched here; read through ctx.control_api
import urllib.error  # noqa: E402, F401
import urllib.request  # noqa: E402, F401

from . import (  # noqa: F401 — patched here; read through ctx.control_api
    comfy_lanes,
    hivemindos_models,
    image_router,
    muapi_proxy,
    text_models,
)
from .hivemindos_brain import brain_catalog, plan_with_brain  # noqa: F401
from .hivemindos_oauth import oauth_provider_status, start_oauth_login  # noqa: F401
from .media_catalog import media_catalog  # noqa: F401
from .media_studio import (  # noqa: F401
    cancel_video as run_media_studio_video_cancel,
    check_video as run_media_studio_video_check,
    finish_video as run_media_studio_video_finish,
    generate_video as run_media_studio_video,
    smart_mask as run_smart_mask,
    start_video as run_media_studio_video_start,
    video_job_record as run_media_studio_video_record,
)
from .remote_access import set_remote_access  # noqa: F401
from .unified_runtime import unified_runtime_snapshot  # noqa: F401
from .api.cloud_output import (  # noqa: F401 — re-exported at the old name
    CLOUD_OUTPUT_MAX_BYTES,
    CloudOutputFetcher,
    cloud_output_suffix,
    fetch_cloud_output,
)
from .api.hosts import (  # noqa: F401 — re-exported at the old name
    PROXY_SECRET_ENV,
    PROXY_SECRET_HEADER,
    _LOOPBACK_HOSTS,
    _LOOPBACK_NAMES,
    _SAFE_METHODS,
    _host_name,
)
from .api.media_common import (  # noqa: F401 — re-exported at the old name
    E2E_REQUESTER_HEADER,
    _INLINE_AUDIO_SUFFIXES,
    _INLINE_IMAGE_SUFFIXES,
    _INLINE_VIDEO_SUFFIXES,
    _e2e_envelope_response,
    _encrypt_private_media,
    _private_media_exists,
    _private_media_response,
    _PRIVATE_MEDIA_SUFFIX,
    _private_media_sidecar,
    _public_media_studio_qa,
    _public_media_studio_result,
    _read_private_media,
    _remove_media_studio_qa_artifacts,
    _requester_pub,
    _sniffed_media_suffix,
    _write_inline_media,
)
from .api.models import (  # noqa: F401 — re-exported at the old name
    AccountCreateBody,
    AccountPasswordChangeBody,
    AccountRecoveryChallengeBody,
    AccountRecoveryResetBody,
    AccountRenameBody,
    AccountSetupBody,
    AccountUnlockBody,
    CancelBody,
    CanvasProvenanceBody,
    CloudOutputAdoptBody,
    ComfyAttachBody,
    ComfyDetachBody,
    ConfirmDeleteBody,
    DecisionBody,
    FavoriteBody,
    HivemindosConnectBody,
    HivemindosLinkCallbackBody,
    HivemindosMergeBody,
    HivemindosTopUpBody,
    HostedSam3MaskBody,
    HostedSam3QuoteBody,
    LaneFreeBody,
    MediaStudioIngredientImageBody,
    MediaStudioIngredientPreviewBody,
    MediaStudioInpaintBody,
    MediaStudioLoraBody,
    MediaStudioReferenceAudioBody,
    MediaStudioReferenceVideoBody,
    MediaStudioVideoBody,
    PassBookBody,
    PassBookModeBody,
    PassBookResolveBody,
    PassBookRevokeBody,
    PassBookUnlockBody,
    PasskeyAssertionBody,
    PasskeyChallengeBody,
    PasskeyRegisterBody,
    PromptHelperDescribeLookBody,
    PromptHelperGenerateBody,
    PromptHelperLoadBody,
    PromptHelperUnloadBody,
    RemoteAccessBody,
    RestorePlanBody,
    RetryBody,
    SettingsBody,
    SimplePlanBody,
    SpriteMatteBody,
    SpritePointBody,
    StoryProducerBody,
    StudioImageBody,
    VaultBlobBody,
    VaultIdentityBody,
    VaultPassphraseWrap,
    VaultPrfWrapBody,
    VaultRecoveryWrapBody,
    _MAX_DESCRIPTION_CHARS,
    _MAX_ID_CHARS,
    _MAX_PROMPT_CHARS,
    _StagedVideoInputs,
)
from .api.timings import (  # noqa: F401 — re-exported at the old name
    _DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT,
    _VIDEO_BACKEND_GONE,
    _VIDEO_RECORD_PROBE_SECONDS,
    _VIDEO_UNRESPONSIVE_CHECKS,
    _VIDEO_UNRESPONSIVE_SECONDS,
    GenerationTimings,
    _estimate_seconds_for_work,
    _video_frame_megapixels,
    _video_timing_signature,
)


log = logging.getLogger("hivemind.studio.control")


class AccountLocked(Exception):
    """No session and no bearer: answered as the middleware's sign-in shape.

    Raised by ``require_control`` so the machine-allowed routes (generate,
    poll, runs) refuse an expired browser session with the SAME body the
    owner-gated routes use — ``{"detail": "Sign in to a workspace",
    "privacy": "account-locked"}`` — instead of an operator-token message."""


ACCOUNT_LOCKED_DETAIL = "Sign in to a workspace"
# How long a stop waits for a video finisher to seal its download before giving
# up on it. Long enough for a seal, short enough that launchd's own SIGKILL
# timer never fires.
SHUTDOWN_FINISHER_SECONDS = 20.0


def unexpected_error_detail() -> str:
    """The 500 sentence. Was "Check the control API log", which named a file
    the app did not write, in a directory the stack marked hidden, and emptied
    on the restart a person tries first. What replaces it is an incident id in
    the same reply and a Copy details action beside it."""
    return remedy_text("unexpected")


def _validation_sentence(errors: list[Any]) -> str:
    """FastAPI's 422 array as one sentence: "steps: Input should be less than
    or equal to 100 · duration_seconds: …". Every studio wrapper does
    ``payload.detail || …`` and rendered the array as ``[object Object]``."""
    parts: list[str] = []
    for error in errors or []:
        if not isinstance(error, dict):
            continue
        location = [str(part) for part in (error.get("loc") or []) if str(part) not in {"body", "query", "path", "header"}]
        message = str(error.get("msg") or "is invalid").strip()
        parts.append(f"{'.'.join(location)}: {message}" if location else message)
    return " · ".join(parts) or "The request was not valid"


# The size ceilings, and the three writers that read them. Both halves stayed
# here when the routes moved out: a test shortens a ceiling by patching it on
# THIS module, and these functions resolve it out of this module's globals, so
# separating them would quietly stop the ceiling being enforceable under test.
# api/media_common.py holds everything they lean on.
_MAX_PRIVATE_IMAGE_BYTES = 32 * 1024 * 1024
_MAX_PRIVATE_VIDEO_BYTES = 100 * 1024 * 1024
# One number per kind of file: inline voice clips and uploaded ones share it.
_MAX_PRIVATE_AUDIO_BYTES = 25 * 1024 * 1024


def _write_inline_image(value: str, destination_dir: Path, *, label: str = "") -> Path:
    written = _write_inline_media(
        value,
        destination_dir,
        field_name="image_base64",
        mime_suffixes=_INLINE_IMAGE_SUFFIXES,
        default_suffix=".png",
        max_bytes=_MAX_PRIVATE_IMAGE_BYTES,
        label=label,
    )
    # An iPhone HEIC becomes a JPEG here too. The multipart upload route above
    # has done this since 2026-08-22 because ComfyUI's LoadImage has no HEIC
    # decoder, but this route was missed — and it is the one a SAVED reference
    # comes back through: sealed media can only be decrypted in the browser, so
    # reuse arrives as image_base64 rather than as an upload. A Hive Persona ID
    # built from iPhone photos therefore reached the lane as .heic no matter how
    # many times the pictures were re-attached.
    return media_posters.transcode_opaque_image(written) or written


def _write_inline_video(value: str, destination_dir: Path, *, label: str = "") -> Path:
    return _write_inline_media(
        value,
        destination_dir,
        field_name="video_base64",
        mime_suffixes=_INLINE_VIDEO_SUFFIXES,
        default_suffix=".mp4",
        max_bytes=_MAX_PRIVATE_VIDEO_BYTES,
        label=label,
    )


def _write_inline_audio(value: str, destination_dir: Path, *, label: str = "") -> Path:
    # Reference clips are 15 seconds at most, so even lossless stereo stays
    # small; the cap is here to reject non-audio payloads, not to bound length.
    return _write_inline_media(
        value,
        destination_dir,
        field_name="audio_base64",
        mime_suffixes=_INLINE_AUDIO_SUFFIXES,
        default_suffix=".wav",
        max_bytes=_MAX_PRIVATE_AUDIO_BYTES,
        label=label,
    )


def _machine_route_allowed(path: str, method: str) -> bool:
    # /readyz joins /healthz: the shell that launched this process polls it
    # before anyone has signed in, and it says nothing an unlocked studio does
    # not already say on /healthz.
    if path in {"/api/owner/session", "/api/owner/lock", "/healthz", "/readyz"}:
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
    if path in {"/api/media-studio/video", "/api/media-studio/video/start"} and method == "POST":
        return True
    if method == "GET" and re.fullmatch(r"/api/media-studio/video/job/[^/]+", path):
        return True
    if method == "GET" and re.fullmatch(r"/api/runs/[^/]+", path):
        return True
    return bool(method == "POST" and re.fullmatch(r"/api/runs/[^/]+/(resume|retry|cancel)", path))


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
    cloud_output_fetcher: CloudOutputFetcher | None = None,
) -> FastAPI:
    # Every store this app runs on, opened in the order it always was (see
    # api/context.py). What follows re-binds those as locals under their old
    # names, so the lifespan, the account boundary and the dependencies below
    # read exactly as they did when all of this was one function — and so a
    # route module that takes `ctx` needs no other argument.
    ctx = build_context(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token=control_token,
        operator_token=operator_token,
        owner_access=owner_access,
        private_cipher=private_cipher,
        canvas_history=canvas_history,
        canvas_history_fetcher=canvas_history_fetcher,
        canvas_media_fetcher=canvas_media_fetcher,
        canvas_workflow_fetcher=canvas_workflow_fetcher,
        canvas_delete_fetcher=canvas_delete_fetcher,
        cloud_output_fetcher=cloud_output_fetcher,
    )
    account_store = ctx.account_store
    owner_account = ctx.owner_account
    account_access = ctx.account_access
    current_account = ctx.current_account
    configured_control_token = ctx.configured_control_token
    configured_operator_token = ctx.configured_operator_token
    boot_state = ctx.boot_state
    shutting_down = ctx.shutting_down
    app_version = ctx.app_version
    open_gen_dist = ctx.open_gen_dist
    _from_proxy = ctx._from_proxy
    _set_session_cookie = ctx._set_session_cookie
    media_studio_finishers = ctx.media_studio_finishers

    @contextlib.asynccontextmanager
    async def _lifespan(application: FastAPI):
        # Startup work registers on app.state.startup_hooks (here and in
        # gpu_rentals) instead of the deprecated @app.on_event("startup"),
        # which was the source of ~900 warnings per test run.
        for hook in list(getattr(application.state, "startup_hooks", []) or []):
            hook()
        boot_state["ready"] = True
        try:
            yield
        finally:
            # The shutdown half. Anything that holds plaintext or a child
            # process gets a bounded chance to finish; nothing here may raise,
            # or uvicorn reports a crash on a clean stop.
            boot_state["ready"] = False
            shutting_down.set()
            pending = [task for task in media_studio_finishers if not task.done()]
            if pending:
                # Bounded: a gateway that has stopped answering must not hold
                # the app open. Whatever has not sealed by then is handled by
                # the finisher's own cleanup on the next boot.
                done, unfinished = await asyncio.wait(pending, timeout=SHUTDOWN_FINISHER_SECONDS)
                for task in unfinished:
                    task.cancel()
                if unfinished:
                    print(
                        f"[content-studio] {len(unfinished)} video finisher(s) did not settle in "
                        f"{SHUTDOWN_FINISHER_SECONDS:.0f}s",
                        file=sys.stderr,
                    )
            for hook in reversed(list(getattr(application.state, "shutdown_hooks", []) or [])):
                try:
                    hook()
                except Exception as exc:  # a stuck reaper must not block the rest
                    print(f"[content-studio] shutdown hook failed: {type(exc).__name__}", file=sys.stderr)
            with contextlib.suppress(Exception):
                # The llama-server is a child process; atexit alone leaves it
                # holding the GPU when the parent is killed from launchd.
                started = local_llm.runtime_if_started()
                if started is not None:
                    started.unload_all()

    app = FastAPI(title="Hivemind Content Studio", version=app_version, lifespan=_lifespan)
    app.state.startup_hooks = []
    app.state.shutdown_hooks = []
    # gpu_rentals and the catalog refresher read this off app.state so they do
    # not need a reference to the closure.
    app.state.shutting_down = shutting_down

    @app.exception_handler(AccountLocked)
    async def _account_locked(request: Request, exc: AccountLocked) -> JSONResponse:
        return JSONResponse({"detail": ACCOUNT_LOCKED_DETAIL, "privacy": "account-locked"}, status_code=401)

    @app.exception_handler(RequestValidationError)
    async def _validation_failed(request: Request, exc: RequestValidationError) -> JSONResponse:
        # ``detail`` is a STRING here on purpose (see _validation_sentence);
        # the structured list stays under ``errors`` for developers. No
        # ``input`` echo: a body field can be a prompt or a picture.
        errors = [
            {key: value for key, value in error.items() if key in {"loc", "msg", "type"}}
            for error in exc.errors()
            if isinstance(error, dict)
        ]
        return JSONResponse({"detail": _validation_sentence(errors), "errors": errors}, status_code=422)

    @app.exception_handler(Exception)
    async def _unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        # JSON, not Starlette's plain-text "Internal Server Error", and never
        # str(exc): an exception message can carry a path or a prompt. The
        # incident id is the ONE thing that crosses from the log to the person,
        # so support can look up a failure the toast could not describe.
        incident = record_incident(
            exc,
            method=request.method,
            route=access_route(request.url.path, request.scope.get("path_params")),
        )
        return JSONResponse(
            {"detail": unexpected_error_detail(), "incident": incident}, status_code=500
        )

    # The unified studio frontend (packages/open-generative-ai, Vite build) is
    # the ONLY UI this server ships. /open-gen stays mounted for older links
    # and the desktop shell; /assets serves the same build's hashed bundles.
    app.mount("/assets", StaticFiles(directory=open_gen_dist / "assets", check_dir=False), name="studio-assets")
    app.mount("/open-gen", StaticFiles(directory=open_gen_dist, html=True, check_dir=False), name="open-generative-ai")

    # Routes the sign-in screen itself must reach before anyone is signed in.
    # Deliberately a small, exact set: everything else stays behind the gate.
    # Exactly the alphabet secrets.token_urlsafe produces, and a length no
    # shorter than the 32 bytes civitai_post mints.
    _TOKEN_PATH_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")

    _GATE_ROUTES = frozenset({
        "/api/accounts",
        "/api/accounts/setup",
        "/api/accounts/unlock",
        # Forgotten password. Reachable before sign-in by necessity — that is
        # the whole situation — and safe because neither route hands out the
        # passphrase-wrapped master key, both are throttled exactly like unlock,
        # and the reset one only answers a nonce that had to be decrypted with
        # the vault's own private key.
        "/api/accounts/recovery/challenge",
        "/api/accounts/recovery/reset",
        "/api/accounts/webauthn/authenticate/options",
        "/api/accounts/webauthn/authenticate",
        # The HivemindOS app answering a link the owner started here. It has no
        # studio session and cannot be given one, so this route is reachable
        # without signing in — guarded instead by three things it cannot fake:
        # the caller must be on this machine, it must carry a 32-byte single-use
        # nonce this studio minted in the last five minutes for a link the owner
        # asked for, and the key it hands over is verified against HivemindOS
        # before anything is stored. Nothing here reads studio state; the only
        # thing it can do is complete a hand-over that was already requested.
        "/api/hivemindos/models/link-callback",
    })

    def _civitai_staged_route(path: str, method: str) -> bool:
        """One file, staged for a Civitai post, being read back.

        This has to be reachable without a session, and that is not a gap — it
        is the mechanism. Civitai's post composer fetches the media from the
        BROWSER (confirmed in their `intent/post.tsx`: `await fetch(src)`), and
        that request is cross-origin to civitai.com, so it carries no cookie of
        ours. A gated URL would 401 and the handoff could not work at all.

        What stands in for the session is the same thing the HivemindOS
        link-callback above relies on: an unguessable token this studio minted
        itself, moments ago, because the owner asked to post that exact file.
        It is 32 random bytes, it names one file and nothing else, it expires
        on its own, and the studio drops it as soon as the post is made.
        """
        if method not in {"GET", "HEAD", "OPTIONS"} or not path.startswith("/civitai/staged/"):
            return False
        # "<token>/<filename>" — the filename is cosmetic (Civitai names the
        # attachment after the URL's last segment), so only the token is
        # checked, and only against the alphabet it is minted from.
        rest = path.removeprefix("/civitai/staged/").split("/", 1)
        return bool(rest and _TOKEN_PATH_RE.fullmatch(rest[0]))

    def _machine_token_presented(request: Request) -> bool:
        """A caller holding the control or operator bearer token.

        Agents and the MCP reach the studio this way, with no browser session.
        They act for the person who owns the machine, so they resolve to the
        OWNER workspace — which is what they already reached when there was only
        one. Stated here rather than falling out of a default, because the same
        code path decides whose vault an agent's output gets sealed to.
        """
        header = request.headers.get("authorization", "")
        supplied = header.removeprefix("Bearer ").strip()
        if not supplied:
            return False
        return any(
            len(token) >= 12 and hmac.compare_digest(supplied, token)
            for token in (configured_control_token, configured_operator_token)
        )

    def _same_site_origin(request: Request) -> bool:
        """Is this write coming from a page the studio actually serves?

        A browser sends Origin on every unsafe request. Loopback is the studio
        opened on this machine; the proxy's forwarded host is the studio opened
        over the tailnet, which arrives here with Host already rewritten to
        127.0.0.1 and so cannot be recognised any other way. Anything else is a
        page on somebody else's site talking to this port.
        """
        origin = request.headers.get("origin", "").strip()
        if not origin:
            # Not a browser fetch: agents, the MCP and curl send no Origin, and
            # a same-origin top-level navigation does not either.
            return True
        name = _host_name(origin)
        if name in _LOOPBACK_NAMES:
            return True
        forwarded_host = _host_name(_from_proxy(request, "x-forwarded-host"))
        return bool(forwarded_host) and name == forwarded_host

    # Past this age (half the session) an authenticated request re-issues the
    # cookie, so a tab that stays in use never expires mid-generation. The old
    # fixed 24 h cookie was only ever written at sign-in.
    SESSION_SLIDE_AFTER_SECONDS = account_access.session_seconds // 2

    @app.middleware("http")
    async def enforce_account_boundary(request: Request, call_next):
        # Captured before the router runs: url.path is the ORIGINAL path even
        # after a mount rewrites scope["path"], and it has no query string —
        # which is why uvicorn's own access log (every URL, verbatim, tokens
        # and all) is turned off in main() in favour of this one line.
        request_path = request.url.path
        if request.method not in _SAFE_METHODS and not _same_site_origin(request):
            # Refused before the cookie is even read: a page on another site
            # that has rebound its DNS to 127.0.0.1 sends the session cookie
            # with its POST like any same-origin script would, so the cookie
            # proves nothing here. The Origin header is the browser's own
            # account of who asked, and it is the one thing the page cannot
            # forge.
            return JSONResponse(
                {"detail": "This request came from another site. Open the studio at "
                           "http://127.0.0.1:8765 or at its tailnet address.",
                 "privacy": "cross-site-blocked"},
                status_code=400,
            )
        session_cookie = request.cookies.get(ACCOUNT_COOKIE)
        signed_in = account_access.account_id(session_cookie)
        # A cookie for a workspace that has since been deleted proves nothing.
        account = account_store.get(signed_in) if signed_in else None
        request.state.account = account
        request.state.is_owner = account is not None
        # Machine callers get the owner workspace for STORAGE scope only; they
        # are still not `request.state.account`, so every owner-gated route goes
        # on refusing them exactly as before.
        scope = account or (account_store.get(owner_account.id) if _machine_token_presented(request) else None)
        token = current_account.set(scope)
        try:
            allowed = (
                account is not None
                or request.url.path in _GATE_ROUTES
                or _civitai_staged_route(request.url.path, request.method)
                or _machine_route_allowed(request.url.path, request.method)
            )
            if not allowed:
                if request.method in {"GET", "HEAD"} and (
                    request.url.path == "/" or "text/html" in request.headers.get("accept", "")
                ):
                    # A STANDALONE page, deliberately not the React shell: the
                    # app bundle lives under /assets, which is gated, so a shell
                    # served here would load a script that 401s and render
                    # nothing. Keeping the gate self-contained also means an
                    # unauthenticated visitor is never handed the application.
                    response = HTMLResponse(account_gate_html(), status_code=200)
                else:
                    response = JSONResponse(
                        {"detail": "Sign in to a workspace", "privacy": "account-locked"},
                        status_code=401,
                    )
            else:
                response = await call_next(request)
                if account is not None:
                    remaining = account_access.remaining_seconds(session_cookie)
                    if remaining is not None and remaining < SESSION_SLIDE_AFTER_SECONDS:
                        _set_session_cookie(response, request, account)
        finally:
            current_account.reset(token)
        if request.url.path.startswith("/assets/"):
            # Vite fingerprints every bundle under /assets, so these are
            # immutable; no-store here re-downloaded the whole app on every
            # page load over the tailnet.
            response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        # Route template and status, never the path's leaves: the media routes
        # end in the owner's own filenames.
        record_access(request.method, request_path, response.status_code, request.scope.get("path_params"))
        return response

    # Added last, so it wraps the account gate above and answers first: a
    # request for a name this studio does not answer to never reaches the
    # sign-in routes at all. Starlette compares the name up to the first colon,
    # so every port passes and no entry needs one — and a BRACKETED literal
    # (`[::1]:8765`) is refused by the same rule, which is right for a studio
    # that binds 127.0.0.1 and never answers on ::1. Safe behind the tailnet
    # proxy, which rewrites Host to 127.0.0.1:8765 before forwarding
    # (packages/media-gateway/tailscale-https-proxy.js) and carries the address
    # bar's name in x-forwarded-host instead.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(_LOOPBACK_HOSTS), www_redirect=False)

    def require_control(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
        supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
        if not supplied and getattr(request.state, "account", None) is None:
            # No bearer and no session: a browser whose cookie expired, or the
            # dev server with none. That is "sign in", in the same shape the
            # middleware answers everywhere else — not an operator-token
            # lecture (and not a 503 about an unconfigured token).
            raise AccountLocked()
        if len(configured_control_token) < 12:
            # A build with no operator token configured. Nothing the person at
            # the browser can do about an environment variable, and the name of
            # it means nothing to them — so this is the same sign-in answer the
            # middleware gives everywhere else, with the variable named in the
            # log instead of the toast.
            log.warning("operator mutation refused: no control token configured")
            raise AccountLocked()
        if not hmac.compare_digest(supplied, configured_control_token):
            raise HTTPException(status_code=401, detail="Valid operator bearer token required")

    def require_owner_or_control(request: Request, authorization: Annotated[str | None, Header()] = None) -> None:
        if bool(getattr(request.state, "is_owner", False)):
            return
        require_control(request, authorization)

    def require_owner(request: Request) -> None:
        """Any signed-in workspace. Named for the 60-odd routes that already
        depend on it; what it now proves is "some account", and WHICH account is
        what the scoped resolvers above answer."""
        if getattr(request.state, "account", None) is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")

    def require_owner_account(request: Request) -> None:
        """The OWNER workspace, not merely a signed-in one.

        Deliberate (2026-09-03), and the counterpart to the rentals decision
        below. `require_owner` means "some account", which is right for the
        studio's own work: a workspace exists because the owner approved it,
        and that approval carries generating, renting and publishing. It is
        wrong for the two things that reach PAST the studio — the machine's
        shared credential store, which every Hive app on this Mac reads, and
        the owner's HivemindOS balance, which is money. Overwriting
        OPENAI_API_KEY there breaks apps a collaborator has never heard of, and
        a top-up spends the owner's card. Reading stays open on
        `require_owner`: a collaborator may see WHICH keys are configured (never
        a value) so they can say what is missing. Writing is the owner's.
        """
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        if not account.is_owner:
            raise HTTPException(status_code=403, detail={
                "message": "Only the owner's workspace can change this machine's credentials and credit.",
                "remedy": "Sign in to the owner workspace, or ask its owner to make the change.",
            })

    # GPU rentals are open to EVERY signed-in workspace, not just the owner.
    # Deliberate (2026-08-21): a workspace only exists because the owner
    # approved its creation, and that approval carries the whole studio —
    # including renting on the machine-wide provider keys. The gate that
    # matters is workspace creation itself, which stays owner-approved.
    register_gpu_rental_routes(app, require_owner)

    @app.get("/healthz")
    def healthz() -> dict:
        # Unauthenticated and proxied to the tailnet, so it stays minimal: is
        # the process up, has it finished booting, and which build is it. What
        # the engines are doing is /api/runtime's job.
        return {
            "ok": True,
            "ready": bool(boot_state["ready"]),
            "version": app_version,
            "service": "hivemind-content-studio",
            "owner_lock": True,
        }

    @app.get("/readyz")
    def readyz(response: Response) -> dict:
        """True only once the accounts bootstrap and the catalog warm have run.

        The shell polls this instead of /healthz so it never opens the studio
        onto a model list that is still being built.
        """
        ready = bool(boot_state["ready"]) and bool(boot_state.get("catalog_warm"))
        response.status_code = 200 if ready else 503
        return {"ok": ready, "ready": ready, "version": app_version}

    # ── the routes, one module per subject ────────────────────────────────────
    #
    # Each `register` builds an APIRouter out of the same route functions this
    # file used to hold inline and includes it here, so registration order —
    # and therefore which route a path matches — is the order below. The four
    # dependencies and this module itself go onto the context first: a route
    # that reads a name PATCHED on control_api (the media-studio entry points,
    # the video ceilings) reads it through `ctx.control_api` at call time.
    ctx.control_api = sys.modules[__name__]
    ctx.require_control = require_control
    ctx.require_owner = require_owner
    ctx.require_owner_or_control = require_owner_or_control
    ctx.require_owner_account = require_owner_account
    for routes in (
        accounts_routes,
        shell_routes,
        catalog_routes,
        bridge_routes,
        prompting_routes,
        hivemindos_routes,
        lanes_routes,
        runs_routes,
        system_routes,
        settings_routes,
        vault_routes,
        video_routes,
        muapi_routes,
        image_routes,
        sam3_routes,
        restore_routes,
        ingredients_routes,
        sprite_routes,
        references_routes,
        canvas_routes,
        passbook_routes,
        oauth_routes,
        approvals_routes,
    ):
        routes.register(app, ctx)

    # Registered last so every API route above wins; serves root-level build
    # files the unified frontend references absolutely (/hosted-local-ai.js,
    # /vite.svg, …).
    app.mount("/", StaticFiles(directory=open_gen_dist, html=True, check_dir=False), name="unified-frontend")

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("CONTENT_STUDIO_CONTROL_HOST", "127.0.0.1")
    # 8765 stays the preferred, stable port. A shell that has to fall back
    # because a foreign process holds it passes the replacement in here rather
    # than killing whatever is listening.
    port = int(os.environ.get("CONTENT_STUDIO_CONTROL_PORT", "8765"))
    target = configure_logging()
    if target is not None:
        log.info("control API listening on %s:%s (log %s)", host, port, target.name)
    try:
        app = build_control_app()
    except DataFormatTooNew as exc:
        # One sentence and a distinct exit code, not a traceback: the launcher
        # renders this and offers Retry, and there is nothing to retry into
        # until the person acts on it. Logged as well as printed, so the
        # incident is in the file a bug report carries.
        log.error("refusing to open a newer data format: %s", exc)
        print(f"[content-studio] {exc}", file=sys.stderr, flush=True)
        raise SystemExit(3) from None
    # uvicorn's access log writes the full URL, query string included; the
    # boundary middleware writes a redacted line instead.
    uvicorn.run(app, host=host, port=port, access_log=False)


if __name__ == "__main__":
    main()
