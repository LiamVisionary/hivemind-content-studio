"""What every route in this package used to close over.

``build_control_app`` held all of it as locals of one 4,700-line function, and
that is why the routes had to live inside it. The stores, the per-account
resolvers and the shared helpers are built here instead and handed to each
route module as ``ctx``; control_api.py re-binds the names it needs so the
middleware, the lifespan and the account boundary read exactly as before.

Nothing here changed while it moved (2026-09-04). The four dependencies
(``require_owner`` and friends) are filled in by control_api.py after it has
defined them, because they close over the app's own request state.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import mimetypes
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response

from .. import __version__
from ..account_scope import (
    AccountWorkspaces,
    GatewayOutputClaims,
    NoAccountInScope,
    RunClaims,
    bootstrap_accounts,
)
from ..accounts import (
    ACCOUNT_COOKIE,
    Account,
    AccountAccess,
    AccountStore,
    LoginThrottle,
    RelyingParty,
)
from ..approval_config import load_approval_ledger
from ..approval_ledger import ApprovalLedger
from ..canvas_history import (
    CanvasDeleteFetcher,
    CanvasGatewayClient,
    CanvasHistoryFetcher,
    CanvasHistoryStore,
    CanvasMediaFetcher,
    CanvasWorkflowFetcher,
)
from ..config import ensure_data_format
from ..generation_telemetry import record_hivemind_generation_metric
from ..machine_privacy import machine_run_receipt
from ..media_studio import sanitize_error_detail
from ..orchestrator import ContentOrchestrator
from ..private_access import (
    OwnerAccess,
    PrivateFieldCipher,
    configure_private_cipher,
    e2e_media_exists,
    read_e2e_envelope,
    resolve_private_cipher,
    write_private_text,
)
from ..prompt_history import PromptHistoryStore
from ..run_privacy import migrate_private_runs
from ..shared_env import apply_shared_hive_env, enable_access_stamps, join_hive_env
from ..studio_drafts import StudioRunDraft
from ..vault_store import VaultStore
from .cloud_output import CloudOutputFetcher, fetch_cloud_output
from .hosts import PROXY_SECRET_ENV, PROXY_SECRET_HEADER
from .media_common import (
    _e2e_envelope_response,
    _private_media_exists,
    _private_media_response,
    _read_private_media,
)
from .timings import GenerationTimings

# The same logger control_api.py writes to, by name, so a line from a route
# module is indistinguishable from the line it replaced.
log = logging.getLogger("hivemind.studio.control")


@dataclass
class StudioContext:
    """The state one running control app is built on.

    A field here is a local ``build_control_app`` used to hold. Nothing is
    global: two apps in the same process (which every test fixture builds) get
    two of these, with their own stores, their own ``current_account`` and
    their own job registry.
    """

    # ── stores and identity ──────────────────────────────────────────────────
    runs: ContentOrchestrator
    cipher: PrivateFieldCipher
    access: OwnerAccess
    state_dir: Path
    account_store: AccountStore
    run_claims: RunClaims
    gateway_claims: GatewayOutputClaims
    workspaces: AccountWorkspaces
    owner_account: Account
    account_access: AccountAccess
    login_throttle: LoginThrottle
    account_login_throttle: LoginThrottle
    current_account: ContextVar[Account | None]

    # ── per-account resolvers: an unset scope raises rather than serving
    #    account 1's library to whoever asked ─────────────────────────────────
    scoped_account: Any
    scoped_account_id: Any
    vault: Any
    prompt_history: Any
    canvas_store: Any
    references_root: Any
    outputs_root: Any
    _vault_public_key: Any
    _commit_password_reset: Any

    # ── the Canvas gateway, and the cloud fetcher a test can replace ─────────
    fetch_canvas_history: Any
    fetch_canvas_media: Any
    fetch_canvas_workflow: Any
    delete_canvas_output: Any
    fetch_cloud_result: CloudOutputFetcher

    # ── configuration and the boot contract ──────────────────────────────────
    configured_control_token: str
    configured_operator_token: str
    configured_proxy_secret: str
    approvals: ApprovalLedger | None
    boot_state: dict[str, Any]
    shutting_down: threading.Event
    app_version: str
    repository_root: Path
    open_gen_dist: Path
    media_studio_input_root: Path
    generation_timings: GenerationTimings
    ingredients_sheet_compositor: Path

    # ── shared helpers ───────────────────────────────────────────────────────
    record_prompt: Any
    execute_draft: Any
    _from_proxy: Any
    _set_session_cookie: Any
    _relying_party: Any
    owner_visible: Any
    claim_visible: Any
    require_visible_run: Any
    stage_media_studio_reference: Any
    media_studio_video_jobs: dict[str, dict[str, Any]]
    media_studio_finishers: set
    _generated_output_response: Any
    _own_generated_output: Any
    _sync_canvas_history_for_scope: Any
    _forget_canvas_sync: Any
    _sync_canvas_history_cached: Any

    # ── filled in by control_api.build_control_app ───────────────────────────
    # The module itself, so a route module can read a name that is PATCHED on
    # control_api (the media-studio entry points, the video ceilings) at call
    # time rather than binding it once at import.
    control_api: Any = None
    require_control: Any = None
    require_owner: Any = None
    require_owner_or_control: Any = None
    require_owner_account: Any = None


def build_context(
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
) -> StudioContext:
    """Open every store one control app runs on, in the order it did before."""
    # Join the machine's shared credential store before anything asks for a key.
    # On a machine that already has HivemindOS this adopts the existing store; on
    # a bare machine it creates the canonical one at the same path, so a later
    # HivemindOS install finds this and does not start a second.
    join_hive_env()
    # Every credential read from here on leaves a hash-chained receipt naming
    # the key. Optional and silent when the companion module is absent.
    enable_access_stamps()
    apply_shared_hive_env()
    runs = orchestrator or ContentOrchestrator(generation_metric_sink=record_hivemind_generation_metric)
    cipher = private_cipher or resolve_private_cipher()
    configure_private_cipher(cipher)
    access = owner_access or OwnerAccess.from_runtime(cipher)
    state_dir = Path(runs.store.path).parent
    # Refuse a folder a NEWER build wrote before opening a single store out of
    # it. DataFormatTooNew carries the sentence; nothing below it runs.
    ensure_data_format(state_dir)

    # ── accounts ──────────────────────────────────────────────────────────────
    # Every account's data lives in its own subtree with its own zero-knowledge
    # vault (account_scope.py). Nothing below may reach a store without first
    # naming an account, which is why the resolvers are functions rather than
    # the module-level singletons they replaced: an unset scope raises instead
    # of quietly serving account 1's library to whoever asked.
    account_store = AccountStore(state_dir / "accounts.sqlite3")
    run_claims = RunClaims(state_dir / "run-claims.sqlite3")
    # The media gateway's outputs are the other machine-wide store: claimed per
    # workspace at start/finish so each History lists only its own clips.
    gateway_claims = GatewayOutputClaims(state_dir / "gateway-output-claims.sqlite3")
    workspaces = AccountWorkspaces(state_dir, cipher=cipher)
    # The owner account inherits whatever seed the studio was given — the env
    # hash on a headless box, an injected hash under test, nothing at all on a
    # fresh install — so `access` stays the single source of truth for it rather
    # than this module reading the environment a second time and drifting from
    # it. With no seed the owner row has no credentials and the gate asks for
    # them (see setup_owner below).
    owner_account = bootstrap_accounts(
        store=account_store, state_dir=state_dir, legacy_password_hash=access.password_hash,
        # An injected canvas store is already open on a path its owner chose;
        # migrating that file would leave the connection pointing at nothing.
        skip_migration=("canvas-history.sqlite3",) if canvas_history is not None else (),
    )
    account_access = AccountAccess(signing_secret=cipher.derive("account-session-v1"))
    login_throttle = LoginThrottle()
    # The per-address key above can be moved by whoever is asking — a page that
    # rotates x-forwarded-for gets a fresh bucket on every try, and the
    # five-attempt lock never fires for the one caller it most needs to stop.
    # This second key names the WORKSPACE, which no header can change: twenty
    # failures in fifteen minutes and that workspace stops answering for
    # fifteen, whoever is asking. Looser than the per-address limit on purpose,
    # so a household sharing one proxy is not locked out by someone else's
    # typo, and tight enough that a password cannot be guessed at speed.
    account_login_throttle = LoginThrottle(max_attempts=20, window_seconds=900.0, block_seconds=900.0)
    # Set per request by the middleware below; never defaulted.
    current_account: ContextVar[Account | None] = ContextVar("current_account", default=None)

    def scoped_account() -> Account:
        account = current_account.get()
        if account is None:
            raise NoAccountInScope("This state is account-scoped and nobody is signed in")
        return account

    def scoped_account_id() -> int:
        return scoped_account().id

    def vault() -> VaultStore:
        return workspaces.vault(scoped_account_id())

    def prompt_history() -> PromptHistoryStore:
        return workspaces.prompt_history(scoped_account_id())

    def canvas_store() -> CanvasHistoryStore:
        return canvas_history or workspaces.canvas_history(scoped_account_id())

    def references_root() -> Path:
        return workspaces.paths(scoped_account_id()).references_root

    def outputs_root() -> Path:
        return workspaces.paths(scoped_account_id()).outputs_root

    # ── password resets, atomic across two databases ──────────────────────────
    #
    # Changing a workspace password moves two things that do not share a
    # transaction: the scrypt hash in accounts.sqlite3, and the
    # passphrase-wrapped master key in THAT account's vault. Half of it is worse
    # than none — a new password that cannot open the library, or a library
    # wrapped under a passphrase the account will not accept.
    def _apply_vault_wrap(account_id: int, wrap: dict[str, str]) -> None:
        """Merge a new passphrase wrap into an account's vault identity.

        Only the passphrase half moves. The recovery copy, the public key, the
        sealed private key and every passkey's PRF wrap are read back and
        written out untouched — which is exactly why passkeys and device wraps
        survive a password change: all of them wrap the SAME master key, and
        the master key is not what changes here.
        """
        store = workspaces.vault(int(account_id))
        identity = store.get_identity()
        if not identity:
            raise LookupError("This workspace has no vault to re-wrap")
        merged = dict(identity)
        merged["salt"] = wrap["salt"]
        merged["wrapped_mk_pass"] = wrap["wrapped_mk_pass"]
        if wrap.get("kdf"):
            merged["kdf"] = wrap["kdf"]
        store.put_identity(merged, allow_replace=True)

    def _commit_password_reset(account_id: int, password_hash: str, wrap: dict[str, str]) -> None:
        """Set the password AND the vault wrap, or neither.

        The journal row is the commit point. Before it, nothing has changed and
        the old password still works. After it, every later instant is
        recoverable: a process killed mid-write is finished by
        `_resume_password_resets` on the next boot, because the row carries both
        halves. An in-process failure rolls the vault back to the identity
        snapshotted here and drops the journal, so the caller's 500 is the truth.
        """
        before = workspaces.vault(int(account_id)).get_identity()
        account_store.begin_password_reset(int(account_id), password_hash, wrap)
        try:
            _apply_vault_wrap(account_id, wrap)
            account_store.finish_password_reset(int(account_id))
        except Exception:
            if before is not None:
                with contextlib.suppress(Exception):
                    workspaces.vault(int(account_id)).put_identity(before, allow_replace=True)
            account_store.cancel_password_reset(int(account_id))
            raise

    def _resume_password_resets() -> None:
        for pending in account_store.pending_password_resets():
            account_id = int(pending["account_id"])
            try:
                _apply_vault_wrap(account_id, pending["vault_wrap"])
            except Exception:
                log.warning("Could not finish the password reset for workspace %s", account_id)
                continue
            account_store.finish_password_reset(account_id)
            log.info("Finished an interrupted password reset for workspace %s", account_id)

    _resume_password_resets()

    def _vault_public_key() -> str | None:
        """The SIGNED-IN account's vault public key for server-side sealing, or
        None until they have created a vault in-browser. Resolving this per
        request is what stops one person's output being sealed to another
        person's key — the seal target follows the session, not the process."""
        return workspaces.vault_public_key(scoped_account_id())
    canvas_gateway = CanvasGatewayClient()
    fetch_canvas_history = canvas_history_fetcher or canvas_gateway.history
    fetch_canvas_media = canvas_media_fetcher or canvas_gateway.media
    fetch_canvas_workflow = canvas_workflow_fetcher or canvas_gateway.workflow
    delete_canvas_output = canvas_delete_fetcher or canvas_gateway.delete
    fetch_cloud_result = cloud_output_fetcher or fetch_cloud_output
    configured_control_token = control_token if control_token is not None else os.environ.get("CONTENT_STUDIO_CONTROL_TOKEN", "")
    configured_operator_token = operator_token if operator_token is not None else os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if approvals is None:
        approvals = load_approval_ledger(required=False)
    try:
        migrate_private_runs(store_path=Path(runs.store.path))
    except Exception as exc:  # startup must survive a partial legacy layout
        print(f"[content-studio] run privacy migration warning: {exc}", file=sys.stderr)

    # The boot contract, in two flags. `ready` only turns on once the accounts
    # bootstrap above and the catalog warm hook have both run, so a shell that
    # polls /readyz never opens the studio onto an empty model list.
    boot_state: dict[str, Any] = {"ready": False}
    # Every long-lived background thread this app starts checks this instead of
    # `while True`, so SIGTERM ends them rather than the interpreter killing
    # them mid-loop. Set once, never cleared: an app that shut down stays down.
    shutting_down = threading.Event()
    app_version = __version__

    # parents[3], not the [2] this line carried in control_api.py: the same
    # checkout root, counted from one directory deeper.
    repository_root = Path(__file__).resolve().parents[3]
    # A packaged build has no checkout to point at, so the shell hands these
    # over; the checkout paths stay the fallback so a dev machine needs nothing.
    open_gen_dist = Path(
        os.environ.get("CONTENT_STUDIO_FRONTEND_DIST")
        or repository_root / "packages/open-generative-ai/dist"
    ).expanduser()
    # Staging for external tools (ComfyUI reads plaintext from here and the
    # sweeper removes it). Deliberately NOT per-account: nothing durable lives
    # here, and the files are named by mkstemp rather than being addressable.
    media_studio_input_root = Path(runs.store.path).parent / "uploads" / "media-studio"
    generation_timings = GenerationTimings(Path(runs.store.path).parent / "generation-timings.jsonl")
    ingredients_sheet_compositor = Path(
        os.environ.get("CONTENT_STUDIO_INGREDIENTS_COMPOSITOR")
        or repository_root / "packages/media-gateway/bin/compose-ingredients-sheet.py"
    ).expanduser()

    def record_prompt(
        draft: StudioRunDraft,
        *,
        source: str,
        run_id: str,
        user_prompt: str = "",
        composer: dict[str, Any] | None = None,
    ) -> None:
        """History capture never blocks or fails a production run.

        The suppression also covers NoAccountInScope: a run reaching here from a
        machine route has no workspace to file the prompt under, and dropping
        the history entry is the correct outcome — far better than writing one
        person's prompt into whichever library happened to be first.
        """
        try:
            prompt_history().record(
                prompt=(draft.concept or "").strip() or user_prompt or draft.title,
                user_prompt=user_prompt,
                title=draft.title,
                lane=draft.lane,
                source=source,
                run_id=run_id,
                composer=composer,
            )
        except Exception as exc:  # noqa: BLE001 — history never fails a run
            # Silent until now, and "my prompts stopped being saved" is a real
            # support call. The prompt itself is never written here — only why
            # the store refused it.
            log.warning("prompt history not recorded for %s: %s", source, sanitize_error_detail(str(exc)))

    def execute_draft(body: StudioRunDraft) -> dict:
        draft_root = Path(runs.store.path).parent / "ui-drafts"
        draft_root.mkdir(parents=True, exist_ok=True)
        descriptor, draft_name = tempfile.mkstemp(prefix="studio-draft-", suffix=".yaml", dir=draft_root)
        draft_path = Path(draft_name)
        try:
            os.close(descriptor)
            write_private_text(draft_path, yaml.safe_dump(body.to_brief(), sort_keys=False))
            run = runs.execute_content_run(
                draft_path,
                policy={"privacy": body.privacy},
                budget={"max_cost_usd": body.max_cost_usd},
            )
            # Stamp whose run this is at the only moment anyone knows: machine
            # callers are in owner scope here, so agent runs file to the owner.
            scope = current_account.get()
            if scope is not None:
                run_claims.claim(run["run_id"], scope.id)
            return run
        finally:
            draft_path.unlink(missing_ok=True)

    configured_proxy_secret = (os.environ.get(PROXY_SECRET_ENV) or "").strip()

    def _from_proxy(request: Request, header: str) -> str:
        """The first hop of an x-forwarded-* header — but only from the proxy.

        The tailnet HTTPS proxy rewrites Host to 127.0.0.1 and puts the address
        bar's name, scheme and client address in x-forwarded-*. Three answers
        were derived from those: whether the session cookie is `secure`, which
        relying-party id a passkey is bound to, and which bucket a failed
        password counts against. Any caller can write those headers, so any
        caller could choose its own throttle bucket. Now they count only when
        the request also carries the secret the stack hands the proxy — and
        with no secret configured there is no proxy to believe, so the studio
        reads what it can see itself.
        """
        if not configured_proxy_secret:
            return ""
        supplied = request.headers.get(PROXY_SECRET_HEADER, "")
        if not hmac.compare_digest(supplied, configured_proxy_secret):
            return ""
        return request.headers.get(header, "").split(",", 1)[0].strip()

    def _set_session_cookie(response: Response, request: Request, account: Account) -> None:
        forwarded = _from_proxy(request, "x-forwarded-proto").lower()
        response.set_cookie(
            ACCOUNT_COOKIE,
            account_access.issue(account.id),
            max_age=account_access.session_seconds,
            httponly=True,
            secure=request.url.scheme == "https" or forwarded == "https",
            # Lax, not Strict: a studio link opened from Slack or Notes is a
            # top-level navigation from another site, and Strict drops the
            # cookie on it — so a signed-in person landed on the gate and had
            # to reload. Lax still withholds the cookie from cross-site POSTs.
            samesite="lax",
            path="/",
        )

    def _relying_party(request: Request) -> RelyingParty:
        forwarded = _from_proxy(request, "x-forwarded-proto").lower()
        # Behind the tailnet proxy the Host header is the upstream target, not
        # the name in the browser's address bar — and the RP id must match what
        # the browser sees, or every passkey ceremony is refused client-side.
        # Only the proxy may say so: a caller that could name its own relying
        # party could ask a passkey to sign for a domain of its choosing.
        forwarded_host = _from_proxy(request, "x-forwarded-host")
        return RelyingParty.for_request(
            host=forwarded_host or request.headers.get("host", ""),
            scheme=forwarded or request.url.scheme,
        )

    def owner_visible(request: Request, value: dict[str, Any]) -> dict[str, Any]:
        return value if bool(getattr(request.state, "is_owner", False)) else machine_run_receipt(value)

    def claim_visible(claimed: int | None) -> bool:
        """May the current scope see an entry of a machine-wide store that
        `claimed` (an account id, or None) asked for? Runs and gateway outputs
        both answer this way.

        Every workspace enumerates only its own generations — in both
        directions, so the owner does not see a sibling's either. What the
        owner does hold is everything UNCLAIMED: entries that predate accounts,
        ones started by agents holding a machine token (they resolve to owner
        scope, so their claims already say owner), and ones whose workspace
        has since been deleted — falling back beats stranding them invisibly.
        """
        scope = current_account.get()
        if scope is None:
            # No session and no machine token: the pre-auth machine surface,
            # which only ever serves machine_run_receipt redactions — run id
            # and status, no prompts, no paths. Agents and monitors watch the
            # whole machine through it, so it stays whole-machine.
            return True
        if claimed == scope.id:
            return True
        return scope.is_owner and (claimed is None or account_store.get(claimed) is None)

    def require_visible_run(run_id: str) -> dict[str, Any]:
        """The run, or a 404 that is indistinguishable from it never existing —
        which runs exist in other workspaces is exactly what this hides."""
        try:
            run = runs.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        if not claim_visible(run_claims.account_for(run_id)):
            # Byte-identical to the KeyError detail above (str() of a KeyError
            # keeps its quotes), so absent and hidden cannot be told apart.
            raise HTTPException(status_code=404, detail=str(KeyError(f"Unknown run: {run_id}")))
        return run

    def stage_media_studio_reference(value: str) -> Path:
        prefix = "/api/media-studio/references/"
        if not value.startswith(prefix):
            raise ValueError("Media reference is not a private Studio reference")
        encoded_name = value.removeprefix(prefix)
        if not encoded_name or "/" in encoded_name or "?" in encoded_name or "#" in encoded_name:
            raise ValueError("Media reference is invalid")
        name = urllib.parse.unquote(encoded_name)
        reference = (references_root() / name).resolve()
        reference_root = references_root().resolve()
        # A sealed (.e2e) reference cannot be staged server-side — this host holds
        # no key. The client decrypts it in-browser and re-sends it as base64.
        if reference.is_relative_to(reference_root) and e2e_media_exists(reference):
            raise ValueError("Sealed reference must be sent as inline base64 (decrypted in-browser)")
        if name != Path(name).name or not reference.is_relative_to(reference_root) or not _private_media_exists(reference):
            raise ValueError("Media reference is unavailable")
        decrypted = _read_private_media(reference, cipher, scope="media-studio-reference")
        media_studio_input_root.mkdir(parents=True, exist_ok=True)
        descriptor, staged_name = tempfile.mkstemp(
            prefix="media-studio-reference-",
            suffix=reference.suffix,
            dir=media_studio_input_root,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(decrypted)
        return Path(staged_name)

    # Job-based variant: high-resolution runs take tens of minutes, far beyond
    # what one browser HTTP request survives. start returns a gateway job id
    # immediately; a background task finishes (download, QA, sealing) while the
    # browser polls the job route. The registry below is process memory, but a
    # restart no longer strands the run: the claim ledger remembers whose job it
    # is, the browser keeps presenting the device key the job was started with,
    # and the gateway still holds the record — so the first poll after a restart
    # re-adopts the job and re-arms the finisher (see _readopt_media_studio_video_job).
    media_studio_video_jobs: dict[str, dict[str, Any]] = {}
    # In-flight finishers, awaited on shutdown. A finisher killed between the
    # download and the seal leaves a plaintext mp4 in the outputs root, which is
    # the one thing this app must never do — so a stop waits for them.
    media_studio_finishers: set[asyncio.Task] = set()

    def _generated_output_response(output: Path, request: Request) -> Response:
        """Serve one output out of THIS workspace's outputs root.

        Split out of the route below because History reaches the same files by
        a different door: a cloud result adopted into this root is listed by
        history_id, not by filename, and both doors must hand back the same
        envelope or the browser's decryption sees two different things.
        """
        # Client-only E2E envelope: serve verbatim, the browser decrypts.
        envelope = read_e2e_envelope(output)
        if envelope is not None:
            return _e2e_envelope_response(envelope)
        if not _private_media_exists(output):
            raise HTTPException(status_code=404, detail="Generated video not found")
        media_type = mimetypes.guess_type(output.name)[0] or "video/mp4"
        if output.is_file():
            return FileResponse(output, media_type=media_type, filename=output.name)
        try:
            body = _read_private_media(output, cipher)
        except ValueError as exc:
            raise HTTPException(status_code=503, detail="Generated video could not be decrypted") from exc
        return _private_media_response(body, media_type=media_type, range_header=request.headers.get("range", ""))

    def _own_generated_output(locator: str) -> Path | None:
        """The path under this workspace's outputs root that `locator` names, or
        None when it names something else (a gateway clip, a Canvas render)."""
        try:
            candidate = Path(str(locator)).expanduser().resolve()
            root = outputs_root().resolve()
        except (OSError, RuntimeError):
            return None
        return candidate if candidate.is_relative_to(root) else None

    def _sync_canvas_history_for_scope() -> None:
        """Index the machine-wide gateway history for the signed-in workspace.

        The canvas store reads MACHINE-wide sources — ComfyUI's output roots
        and the media gateway's job log — where every workspace's video-studio
        clips land side by side: each sealed to the browser that asked for it,
        but all listed together, and the gateway cannot tell whose is whose.
        The studio can: every gateway job it starts and every output it
        finishes is claimed for the workspace in scope (GatewayOutputClaims),
        and a listing adopts only what that scope may see — its own claims,
        plus, for the owner, everything unclaimed (pre-accounts outputs, agents
        on the machine token, the passphrase-gated Canvas itself) or orphaned
        by a deleted workspace. Records the scope may NOT see are purged from
        its store as well, so a row adopted in the seconds before its claim was
        written does not linger in the wrong History."""
        records = fetch_canvas_history()
        claimants = gateway_claims.claimants_for_records(records)
        mine = [record for record, claimed in zip(records, claimants) if claim_visible(claimed)]
        foreign = [record for record, claimed in zip(records, claimants) if not claim_visible(claimed)]
        store = canvas_store()
        store.sync(mine)
        if foreign:
            store.forget(foreign)

    # A sync reads the gateway's history, walks both output roots and writes
    # sqlite; a History poll repeated all of it every tick. Remembered per
    # workspace for a few seconds, dropped the moment a job finishes in this
    # process (see _finalize_media_studio_video) and skippable with ?refresh=1.
    CANVAS_SYNC_TTL_SECONDS = 10.0
    canvas_sync_at: dict[int | None, float] = {}

    def _scope_key() -> int | None:
        scope = current_account.get()
        return scope.id if scope is not None else None

    def _forget_canvas_sync(scope_id: int | None = None) -> None:
        canvas_sync_at.pop(scope_id if scope_id is not None else _scope_key(), None)

    def _sync_canvas_history_cached(*, refresh: bool = False) -> None:
        key = _scope_key()
        if not refresh and time.monotonic() - canvas_sync_at.get(key, 0.0) < CANVAS_SYNC_TTL_SECONDS:
            return
        _sync_canvas_history_for_scope()
        canvas_sync_at[key] = time.monotonic()


    return StudioContext(
        runs=runs,
        cipher=cipher,
        access=access,
        state_dir=state_dir,
        account_store=account_store,
        run_claims=run_claims,
        gateway_claims=gateway_claims,
        workspaces=workspaces,
        owner_account=owner_account,
        account_access=account_access,
        login_throttle=login_throttle,
        account_login_throttle=account_login_throttle,
        current_account=current_account,
        scoped_account=scoped_account,
        scoped_account_id=scoped_account_id,
        vault=vault,
        prompt_history=prompt_history,
        canvas_store=canvas_store,
        references_root=references_root,
        outputs_root=outputs_root,
        _vault_public_key=_vault_public_key,
        _commit_password_reset=_commit_password_reset,
        fetch_canvas_history=fetch_canvas_history,
        fetch_canvas_media=fetch_canvas_media,
        fetch_canvas_workflow=fetch_canvas_workflow,
        delete_canvas_output=delete_canvas_output,
        fetch_cloud_result=fetch_cloud_result,
        configured_control_token=configured_control_token,
        configured_operator_token=configured_operator_token,
        configured_proxy_secret=configured_proxy_secret,
        approvals=approvals,
        boot_state=boot_state,
        shutting_down=shutting_down,
        app_version=app_version,
        repository_root=repository_root,
        open_gen_dist=open_gen_dist,
        media_studio_input_root=media_studio_input_root,
        generation_timings=generation_timings,
        ingredients_sheet_compositor=ingredients_sheet_compositor,
        record_prompt=record_prompt,
        execute_draft=execute_draft,
        _from_proxy=_from_proxy,
        _set_session_cookie=_set_session_cookie,
        _relying_party=_relying_party,
        owner_visible=owner_visible,
        claim_visible=claim_visible,
        require_visible_run=require_visible_run,
        stage_media_studio_reference=stage_media_studio_reference,
        media_studio_video_jobs=media_studio_video_jobs,
        media_studio_finishers=media_studio_finishers,
        _generated_output_response=_generated_output_response,
        _own_generated_output=_own_generated_output,
        _sync_canvas_history_for_scope=_sync_canvas_history_for_scope,
        _forget_canvas_sync=_forget_canvas_sync,
        _sync_canvas_history_cached=_sync_canvas_history_cached,
    )
