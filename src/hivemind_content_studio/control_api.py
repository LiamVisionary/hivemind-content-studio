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
import secrets
import subprocess
import sys
import statistics
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

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
from . import comfy_lanes, local_llm, media_posters, prompt_profiles
from .manifest import load_manifest, write_manifest
from .machine_privacy import machine_operation_receipt, machine_run_receipt
from .media_catalog import media_catalog
from .media_studio import (
    normalized_requester_pub,
    cancel_video as run_media_studio_video_cancel,
    check_video as run_media_studio_video_check,
    finish_video as run_media_studio_video_finish,
    generate_video as run_media_studio_video,
    start_video as run_media_studio_video_start,
    video_dimensions_for_request,
)
from .hivemindos_oauth import oauth_provider_status, start_oauth_login
from .orchestrator import ContentOrchestrator
from .prompt_history import PromptHistoryStore
from .providers import provider_report, providers_for
from .account_gate import account_gate_html
from .account_scope import AccountWorkspaces, NoAccountInScope, bootstrap_accounts
from .accounts import (
    ACCOUNT_COOKIE,
    SESSION_SECONDS,
    Account,
    AccountAccess,
    AccountStore,
    LoginThrottle,
    RelyingParty,
    WebAuthnError,
    authentication_options,
    is_legacy_password_hash,
    registration_options,
    verify_assertion,
    verify_password,
    verify_registration,
)
from .private_access import (
    OWNER_SESSION_SECONDS,
    OwnerAccess,
    PrivateFieldCipher,
    configure_private_cipher,
    e2e_media_exists,
    e2e_media_sidecar,
    encrypt_private_media,
    is_private_text_file,
    private_media_exists,
    private_media_sidecar,
    read_e2e_envelope,
    read_private_media,
    read_private_text,
    seal_private_media_e2e,
    write_private_text,
)
from .run_privacy import migrate_private_runs
from .gpu_rentals import register_gpu_rental_routes
from .shared_env import apply_shared_hive_env
from .studio_drafts import StudioRunDraft
from .studio_state import StudioStateStore
from .vault_store import VaultStore
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


class AccountUnlockBody(BaseModel):
    account_id: int
    password: str


class AccountCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    password: str = ""


class AccountRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class PasskeyChallengeBody(BaseModel):
    # Absent for a discoverable sign-in, where the passkey itself names the
    # workspace and the browser picks which one to offer.
    account_id: int | None = None


class PasskeyRegisterBody(BaseModel):
    credential_id: str = Field(max_length=1024)
    # SPKI DER from the browser's own PublicKeyCredential.getPublicKey(), which
    # is why this server needs no CBOR/COSE parser (see accounts.py).
    public_key: str = Field(max_length=4096)
    algorithm: int
    client_data_json: str = Field(max_length=8192)
    label: str = Field(default="", max_length=60)
    # Whether this credential can produce a PRF secret, i.e. whether it is able
    # to unlock the vault itself rather than only prove who is at the keyboard.
    prf: bool = False


class VaultPrfWrapBody(BaseModel):
    # None removes the enrolment (the passkey still signs you in, it just no
    # longer carries a copy of the wrapped master key).
    wrapped_mk: str | None = Field(default=None, max_length=4096)


class PasskeyAssertionBody(BaseModel):
    credential_id: str = Field(max_length=1024)
    client_data_json: str = Field(max_length=8192)
    authenticator_data: str = Field(max_length=8192)
    signature: str = Field(max_length=4096)


class ConfirmDeleteBody(BaseModel):
    confirm: bool = False


class CanvasProvenanceBody(BaseModel):
    models: list[str] = []
    seeds: list[dict[str, Any]] = []


class StudioStateBody(BaseModel):
    state: dict[str, Any]


class VaultIdentityBody(BaseModel):
    identity: dict[str, Any]
    allow_replace: bool = False


class VaultBlobBody(BaseModel):
    ciphertext: str


class PromptHelperLoadBody(BaseModel):
    modelId: str
    unloadOthers: bool = True


class PromptHelperUnloadBody(BaseModel):
    modelId: str


class LaneFreeBody(BaseModel):
    lane: str


class PromptHelperGenerateBody(BaseModel):
    modelId: str
    idea: str
    targetModel: str = ""
    mediaType: Literal["video", "image"] = "video"
    # A start image is a different documented task for MiniMax H3 (I2VA vs
    # T2VA), which opens with an anchor line the model was trained on.
    hasFirstFrame: bool = False
    # A last frame turns the same request into FL2VA (with a start frame) or
    # L2VA (without) — each has its own anchor line.
    hasLastFrame: bool = False
    # A scene chain is armed: this prompt is the next shot of a running scene,
    # not a new one. Without it the helper answers a line of new dialogue by
    # inventing a fresh scene, which makes the chained render cut away.
    isContinuation: bool = False
    # How the shot being continued was written. The clause above says to keep
    # the established scene; this is what says WHAT it is. Local-only, like
    # every other prompt here — it goes to a llama-server on this machine.
    previousPrompt: str | None = None
    # What reference mode will condition on: how many pictures, which motion
    # clips carry their own soundtrack, how many voice clips. The profile
    # explains the label SCHEME; this says how many of each label exist, so the
    # helper writes the ones the graph will actually carry.
    references: dict | None = None
    # UGC mode is armed in the composer. It layers onto whichever profile the
    # target model selects rather than replacing it — the format stays, the
    # judgements inside it invert (speech becomes required, polish becomes the
    # failure mode).
    ugc: bool = False
    # The clip length the studio is set to, so the written timeline fits inside it.
    durationSeconds: float | None = None
    # The start frame itself, as a data URL, for models with a projector: an
    # I2VA prompt describes the first frame, and describing one it has never
    # seen is guesswork.
    imageBase64: str | None = None
    # Verified character facts (name / casting / work / year) the client's H3
    # character catalog matched in the idea, one line per character.
    characterNotes: list[str] | None = None
    # Revise an existing prompt instead of writing a new one: the prompt to
    # change, and what the owner wants different about it.
    currentPrompt: str | None = None
    revision: str | None = None


class MediaStudioLoraBody(BaseModel):
    id: str
    strength: float = 1.0


class MediaStudioIngredientImageBody(BaseModel):
    image_base64: str | None = None
    image_reference: str | None = None
    description: str = ""


@dataclass(slots=True)
class _StagedVideoInputs:
    """Every media file a video request decoded onto disk. Named rather than a
    positional tuple: staging grew from one image to nine kinds of input, and
    each has to be handed to the runner AND deleted afterwards."""

    image: Path | None = None
    middle: Path | None = None
    end: Path | None = None
    video: Path | None = None
    motion_context: Path | None = None
    ingredient_images: list[dict[str, Any]] = field(default_factory=list)
    reference_images: list[Path] = field(default_factory=list)
    reference_audios: list[Path] = field(default_factory=list)
    reference_videos: list[dict[str, Any]] = field(default_factory=list)

    def paths(self) -> list[Path]:
        return [
            source
            for source in [
                self.image, self.middle, self.end, self.video, self.motion_context,
                *(item["image_path"] for item in self.ingredient_images),
                *self.reference_images,
                *self.reference_audios,
                *(item["video_path"] for item in self.reference_videos),
            ]
            if source is not None
        ]


class MediaStudioReferenceAudioBody(BaseModel):
    audio_base64: str | None = None
    audio_reference: str | None = None


class MediaStudioReferenceVideoBody(BaseModel):
    video_base64: str | None = None
    video_reference: str | None = None
    # Condition on the clip's own soundtrack too. Off by default: a downloaded
    # motion reference usually carries audio nobody wants in the shot, and an
    # unwanted soundtrack silently spends one of the model's <Audio N> labels.
    use_audio: bool = False


class MediaStudioVideoBody(BaseModel):
    prompt: str = ""
    workflow_id: str = ""
    studio_lane: str = Field(default="", max_length=512)
    reference_description: str = ""
    ingredient_images: list[MediaStudioIngredientImageBody] = []
    # MiniMax H3 Reference mode: discrete character/subject pictures carried into
    # the clip in order (reference N is the prompt's <Picture N>). Distinct from
    # ingredient_images, which LTX composes into one conditioning sheet.
    reference_images: list[MediaStudioIngredientImageBody] = []
    # Voice/timbre clips (<Audio N>) and motion references (<Video N>) for the
    # same H3 Reference mode. All three reference kinds are optional and mix
    # freely; only audio may never be the sole reference.
    reference_audios: list[MediaStudioReferenceAudioBody] = []
    reference_videos: list[MediaStudioReferenceVideoBody] = []
    image_base64: str | None = None
    image_reference: str | None = None
    middle_image_base64: str | None = None
    end_image_base64: str | None = None
    video_base64: str | None = None
    video_reference: str | None = None
    # Scene chaining (MiniMax H3): the PREVIOUS clip, decrypted in-browser and
    # sent inline; its last ~22 frames + audio tail seed the new shot.
    motion_context_base64: str | None = None
    video_mode: Literal["extend"] = "extend"
    # THE task. Decided once in the studio (src/lib/videoTasks.js) and forwarded
    # verbatim; nothing downstream re-derives the job from which media arrived.
    task: Literal["generate", "extend", "head-swap"] = "generate"
    duration_seconds: float = 4
    aspect_ratio: str = ""
    # "max" is the ~1.0MP native-canvas tier (MiniMax H3's trained 768px short
    # edge); the studio only offers it for minimax-family workflows.
    resolution: Literal["", "standard", "high", "max"] = ""
    # -1 (or omitted) lets the runner pick a random seed; >= 0 is a fixed seed.
    seed: int | None = None
    # Optional post-generation grain cleanup on the native MLX LTX path.
    denoise: Literal["", "light", "strong"] = ""
    # Negative prompt. On the distilled local lanes this is applied through NAG
    # (guidance inside cross-attention); those run cfg=1, where a CFG-style
    # negative prompt does nothing at all.
    negative_prompt: str = ""
    # NAG strength. Omitted uses the runner default; <=1 disables guidance.
    nag_scale: float | None = None
    head_swap_lora_strength: float | None = None
    head_swap_backend: str | None = None
    head_swap_face_enhancer: bool = False
    # None = leave the workflow's own default alone; only an explicit choice
    # overrides the registered graph.
    spectrum: bool | None = None
    # Sampling-steps override for workflows whose registry maps a steps slot
    # (MiniMax H3's refinement setting). None keeps the workflow default.
    steps: int | None = Field(default=None, ge=1, le=100)
    loras: list[MediaStudioLoraBody] = []


class MediaStudioIngredientPreviewBody(BaseModel):
    ingredient_images: list[MediaStudioIngredientImageBody] = []
    aspect_ratio: str = "16:9"


# First-run fallback before any real duration is recorded, expressed per WORK
# UNIT (one frame-megapixel) so an unmeasured run still scales with its length
# and resolution: ~4.5 puts a 4-second 16:9 standard clip (97 frames at 0.34MP)
# near 150s, and the same clip at the high tier — 2.5x the pixels — near 375s.
_DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT = 4.5


def _video_frame_megapixels(aspect_ratio: str, resolution: str) -> float:
    dims = video_dimensions_for_request(aspect_ratio=aspect_ratio, resolution=resolution)
    if not dims:
        # "Match the start frame" sends no aspect ratio, and the frame itself is
        # already uploaded and unstaged by now. Every bucket within a tier sits
        # within ~12% of the same pixel count, so the 16:9 bucket stands in.
        dims = video_dimensions_for_request(aspect_ratio="16:9", resolution=resolution)
    width, height = dims
    return (width * height) / 1_000_000


def _video_timing_signature(body: "MediaStudioVideoBody") -> tuple[str, str, float]:
    """A canonical key over the params that change the COST PROFILE (workflow,
    mode, adapters, post-pass) plus the run's WORK UNITS — frames x megapixels —
    which are what actually scale the duration. Keeping length and resolution
    out of the key and in the work units is what lets a measured 4-second
    standard run estimate an 8-second or high-resolution one, instead of
    starting over from a flat constant. Metadata only — never prompt text."""
    workflow = (body.workflow_id or "default").strip() or "default"
    duration = max(1.0 / 24, min(30.0, float(body.duration_seconds or 4)))
    frames = max(9, min(721, round(duration * 24) + 1))
    resolution = (body.resolution or "standard").strip().lower() or "standard"
    lora_n = len([item for item in body.loras if str(getattr(item, "id", "") or "").strip()])
    ingredient_n = len(body.ingredient_images)
    task = (getattr(body, "task", None) or "generate").strip().lower()
    if task == "head-swap":
        # Read the task, do not re-infer it from the attachments: a head swap
        # carries a video AND an image, so the attachment test below calls it an
        # extension. It is a different cost profile entirely (an order of
        # magnitude slower here), and averaging the two wrecks both estimates.
        mode = "head-swap"
    elif body.motion_context_base64:
        # Scene chaining samples ~22 extra frames plus a context encode — a
        # different cost profile from a plain generate at the same duration.
        mode = "chain"
    elif body.video_base64 or body.video_reference:
        mode = "extend"
    elif body.image_base64 or body.image_reference or body.middle_image_base64 or body.end_image_base64:
        mode = "i2v"
    elif ingredient_n:
        mode = "ingredients"
    else:
        mode = "t2v"
    # The denoise pass is a real re-encode on top of generation, so it belongs in
    # the key — otherwise filtered runs poison the unfiltered estimate.
    denoise = (body.denoise or "off").strip().lower() or "off"
    # A steps override scales sampling time directly (32 steps is ~2x the work
    # of 15), so runs with different step counts must not share an estimate.
    steps = f"|steps={int(body.steps)}" if isinstance(body.steps, int) and body.steps > 0 else ""
    work = frames * _video_frame_megapixels(body.aspect_ratio, resolution)
    return (
        f"v2|{workflow}|{mode}|loras={lora_n}|ing={ingredient_n}|dn={denoise}{steps}",
        workflow,
        round(work, 3),
    )


def _estimate_seconds_for_work(
    samples: list[tuple[float, float]], work: float
) -> float | None:
    """Duration model: seconds ~= overhead + rate * work. Generation cost is very
    close to linear in both frame count and pixel count, so measured runs scale
    to unmeasured configurations: an exact work match wins outright (it already
    carries every nonlinearity), a single measured work value scales
    proportionally, and two or more separate the fixed per-run overhead (model
    load, VAE decode, upload) from the part that grows with the work.

    Mirrors estimateSecondsForWork() in packages/open-generative-ai/src/lib/
    genProgress.js, which does the same for client-side image timings."""
    target = round(float(work), 3)
    if target <= 0:
        return None
    by_work: dict[float, list[float]] = defaultdict(list)
    for sample_work, seconds in samples:
        if sample_work > 0 and 0 < seconds < 86400:
            by_work[round(float(sample_work), 3)].append(float(seconds))
    if not by_work:
        return None
    if target in by_work:
        return round(statistics.median(by_work[target]), 1)

    points = sorted((w, statistics.median(values)) for w, values in by_work.items())
    if len(points) > 1:
        (low_work, low_seconds), (high_work, high_seconds) = points[0], points[-1]
        rate = (high_seconds - low_seconds) / (high_work - low_work)
        overhead = low_seconds - rate * low_work
        # A flat/negative slope or a negative intercept means these samples are
        # dominated by noise rather than by work — scale off the nearest point.
        if rate > 0 and overhead >= 0:
            return round(overhead + rate * target, 1)
    nearest_work, nearest_seconds = min(points, key=lambda point: abs(point[0] - target))
    return round(nearest_seconds * (target / nearest_work), 1)


class GenerationTimings:
    """Records actual generation durations keyed by a param signature and tagged
    with the run's work units, so a new run can display an elapsed / expected
    estimate that scales with clip length and resolution. Owner-local metadata
    only (durations + opaque signatures), persisted as JSONL — no prompts, no
    media."""

    def __init__(self, path: Path, per_sig: int = 24, per_workflow: int = 120):
        self._path = Path(path)
        self._by_sig: dict[str, deque] = defaultdict(lambda: deque(maxlen=per_sig))
        self._by_workflow: dict[str, deque] = defaultdict(lambda: deque(maxlen=per_workflow))
        self._lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        try:
            with self._path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    sig = str(record.get("sig") or "")
                    seconds = record.get("seconds")
                    work = record.get("work")
                    if not sig or not isinstance(seconds, (int, float)) or not (0 < seconds < 86400):
                        continue
                    # Pre-work-unit records can't be scaled (their signature held
                    # the length and resolution instead), so they are left behind.
                    if not isinstance(work, (int, float)) or work <= 0:
                        continue
                    self._by_sig[sig].append((float(work), float(seconds)))
                    workflow = str(record.get("wf") or "")
                    if workflow:
                        self._by_workflow[workflow].append((float(work), float(seconds)))
        except OSError:
            return

    def record(self, signature: str, workflow: str, work: float, seconds: float) -> None:
        if not signature or not (0 < seconds < 86400) or not work > 0:
            return
        with self._lock:
            self._by_sig[signature].append((float(work), float(seconds)))
            if workflow:
                self._by_workflow[workflow].append((float(work), float(seconds)))
            with contextlib.suppress(OSError):
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({
                        "sig": signature, "wf": workflow, "work": round(float(work), 3),
                        "seconds": round(float(seconds), 2), "at": round(time.time()),
                    }) + "\n")

    def estimate(
        self,
        signature: str,
        workflow: str,
        work: float,
        fallback_rate: float | None = None,
    ) -> float | None:
        with self._lock:
            samples = list(self._by_sig.get(signature) or [])
            workflow_samples = list(self._by_workflow.get(workflow) or [])
        seconds = _estimate_seconds_for_work(samples, work)
        if seconds is None and len(workflow_samples) >= 2:
            seconds = _estimate_seconds_for_work(workflow_samples, work)
        if seconds is None and fallback_rate and work > 0:
            seconds = float(fallback_rate) * float(work)
        return round(seconds, 1) if seconds and seconds > 0 else None


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

_INLINE_AUDIO_SUFFIXES = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    # What real recorders actually label AAC-in-MP4: Android's media framework
    # and anything that went through it say "mp4a-latm" (2026-08-12, a voice
    # reference rejected on the label alone while the bytes were ordinary m4a).
    "audio/mp4a-latm": ".m4a",
    "audio/aacp": ".aac",
    "audio/x-hx-aac-adts": ".aac",
    # A browser MediaRecorder produces webm/opus by default, and phone voice
    # memos arrive as 3gpp/amr or Apple's caf.
    "audio/webm": ".webm",
    "audio/opus": ".opus",
    "audio/3gpp": ".3gp",
    "audio/amr": ".amr",
    "audio/x-caf": ".caf",
}

# Container signatures, for when the LABEL is unknown but the bytes are not.
# An allow-list of media types is a guess about what clients call things; these
# are what the file actually is. Checked only after the label misses, so a
# correctly-labelled file never depends on sniffing.
_MEDIA_MAGIC = (
    (b"RIFF", 8, b"WAVE", ".wav"),
    (b"fLaC", None, None, ".flac"),
    (b"OggS", None, None, ".ogg"),
    (b"ID3", None, None, ".mp3"),
    (b"\x1a\x45\xdf\xa3", None, None, ".webm"),  # EBML: webm/mkv
    (b"RIFF", 8, b"AVI ", ".avi"),
    (b"RIFF", 8, b"WEBP", ".webp"),
    (b"\x89PNG\r\n\x1a\n", None, None, ".png"),
    (b"\xff\xd8\xff", None, None, ".jpg"),
)


def _sniffed_media_suffix(data: bytes, *, audio: bool) -> str:
    """The container a blob actually is, or "" when nothing matches."""
    for prefix, offset, marker, suffix in _MEDIA_MAGIC:
        if not data.startswith(prefix):
            continue
        if marker is not None and data[offset:offset + len(marker)] != marker:
            continue
        return suffix
    # ISO-BMFF (mp4/m4a/mov/3gp) puts its brand at byte 4, so the family is
    # only distinguishable by intent: the same box carries audio and video.
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return ".m4a" if audio else ".mp4"
    # A bare MPEG audio frame has no header at all, only a sync word.
    if audio and len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return ".mp3"
    return ""

_PRIVATE_MEDIA_SUFFIX = ".zenc"
_MAX_PRIVATE_IMAGE_BYTES = 32 * 1024 * 1024
_MAX_PRIVATE_VIDEO_BYTES = 100 * 1024 * 1024


def _private_media_sidecar(path: Path) -> Path:
    return private_media_sidecar(path)


def _encrypt_private_media(
    path: Path,
    cipher: PrivateFieldCipher,
    *,
    scope: str = "media-studio-output",
) -> bool:
    return encrypt_private_media(path, scope=scope, cipher=cipher)


def _private_media_exists(path: Path) -> bool:
    return private_media_exists(path)


def _read_private_media(
    path: Path,
    cipher: PrivateFieldCipher,
    *,
    scope: str = "media-studio-output",
) -> bytes:
    return read_private_media(path, scope=scope, cipher=cipher)


E2E_REQUESTER_HEADER = "X-E2E-Requester-Pub"


def _requester_pub(request: Request) -> str:
    """The caller's own E2E public key, if it presented one.

    A browser that holds a device key sends it here, and this server does
    nothing with it but pass it on: generated media is sealed to that key by
    the gateway, so a clip belongs to the device that asked for it rather than
    to whichever process happened to relay the request. Absent header means the
    caller has no key of its own and the owner vault is the only recipient."""
    return normalized_requester_pub(request.headers.get(E2E_REQUESTER_HEADER))


def _e2e_envelope_response(envelope: bytes) -> Response:
    """Serve a client-only E2E envelope verbatim. The browser detects it via
    X-E2E-Media/Content-Type and decrypts with the vault private key; the server
    holds no key. Mirrors the media-gateway send_output_file headers."""
    return Response(
        content=envelope,
        media_type="application/vnd.hivemind.e2e+json",
        headers={
            "X-E2E-Media": "1",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


def _private_media_response(body: bytes, *, media_type: str, range_header: str = "") -> Response:
    total = len(body)
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Length": str(total),
        "X-Content-Type-Options": "nosniff",
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
    mime = ""
    if raw.startswith("data:"):
        header, separator, body = raw.partition(",")
        if not separator:
            raise ValueError(f"{field_name} data URL is missing its comma separator")
        mime = header.removeprefix("data:").split(";", 1)[0].lower()
        suffix = mime_suffixes.get(mime, "")
        encoded = body
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} is not valid base64") from exc
    if not suffix:
        # The label is one we do not know. Ask the bytes before refusing: a
        # media type is what the client CALLS the file, and recorders invent
        # spellings ("audio/mp4a-latm" for ordinary AAC). Rejecting on the
        # label alone throws away a perfectly decodable clip.
        suffix = _sniffed_media_suffix(data, audio=field_name.startswith("audio"))
    if not suffix:
        raise ValueError(
            f"{field_name} data URL has unsupported media type {mime or 'unknown'} "
            f"and its contents are not a recognised media container"
        )
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
        max_bytes=_MAX_PRIVATE_IMAGE_BYTES,
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


def _write_inline_audio(value: str, destination_dir: Path) -> Path:
    # Reference clips are 15 seconds at most, so even lossless stereo stays
    # small; the cap is here to reject non-audio payloads, not to bound length.
    return _write_inline_media(
        value,
        destination_dir,
        field_name="audio_base64",
        mime_suffixes=_INLINE_AUDIO_SUFFIXES,
        default_suffix=".wav",
        max_bytes=25 * 1024 * 1024,
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
    if path in {"/api/media-studio/video", "/api/media-studio/video/start"} and method == "POST":
        return True
    if method == "GET" and re.fullmatch(r"/api/media-studio/video/job/[^/]+", path):
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
    configure_private_cipher(cipher)
    access = owner_access or OwnerAccess.from_runtime(cipher)
    state_dir = Path(runs.store.path).parent

    # ── accounts ──────────────────────────────────────────────────────────────
    # Every account's data lives in its own subtree with its own zero-knowledge
    # vault (account_scope.py). Nothing below may reach a store without first
    # naming an account, which is why the resolvers are functions rather than
    # the module-level singletons they replaced: an unset scope raises instead
    # of quietly serving account 1's library to whoever asked.
    account_store = AccountStore(state_dir / "accounts.sqlite3")
    workspaces = AccountWorkspaces(state_dir, cipher=cipher)
    # The owner account inherits whatever password the studio was already
    # configured with — env hash in production, injected hash under test — so
    # `access` stays the single source of truth for it rather than this module
    # reading the environment a second time and drifting from it.
    owner_account = bootstrap_accounts(
        store=account_store, state_dir=state_dir, legacy_password_hash=access.password_hash,
        # An injected canvas store is already open on a path its owner chose;
        # migrating that file would leave the connection pointing at nothing.
        skip_migration=("canvas-history.sqlite3",) if canvas_history is not None else (),
    )
    account_access = AccountAccess(signing_secret=cipher.derive("account-session-v1"))
    login_throttle = LoginThrottle()
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

    def studio_state() -> StudioStateStore:
        return workspaces.studio_state(scoped_account_id())

    def canvas_store() -> CanvasHistoryStore:
        return canvas_history or workspaces.canvas_history(scoped_account_id())

    def references_root() -> Path:
        return workspaces.paths(scoped_account_id()).references_root

    def outputs_root() -> Path:
        return workspaces.paths(scoped_account_id()).outputs_root

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
    configured_control_token = control_token if control_token is not None else os.environ.get("CONTENT_STUDIO_CONTROL_TOKEN", "")
    configured_operator_token = operator_token if operator_token is not None else os.environ.get("CONTENT_STUDIO_OPERATOR_TOKEN", "")
    if approvals is None:
        approvals = load_approval_ledger(required=False)
    try:
        migrate_private_runs(store_path=Path(runs.store.path))
    except Exception as exc:  # startup must survive a partial legacy layout
        print(f"[content-studio] run privacy migration warning: {exc}", file=sys.stderr)

    app = FastAPI(title="Hivemind Content Studio", version="0.2.0")
    unlock_failures: dict[str, deque[float]] = defaultdict(deque)
    repository_root = Path(__file__).resolve().parents[2]
    open_gen_dist = repository_root / "packages/open-generative-ai/dist"
    # Staging for external tools (ComfyUI reads plaintext from here and the
    # sweeper removes it). Deliberately NOT per-account: nothing durable lives
    # here, and the files are named by mkstemp rather than being addressable.
    media_studio_input_root = Path(runs.store.path).parent / "uploads" / "media-studio"
    generation_timings = GenerationTimings(Path(runs.store.path).parent / "generation-timings.jsonl")
    ingredients_sheet_compositor = repository_root / "packages/media-gateway/bin/compose-ingredients-sheet.py"
    # The unified studio frontend (packages/open-generative-ai, Vite build) is
    # the ONLY UI this server ships. /open-gen stays mounted for older links
    # and the desktop shell; /assets serves the same build's hashed bundles.
    app.mount("/assets", StaticFiles(directory=open_gen_dist / "assets", check_dir=False), name="studio-assets")
    app.mount("/open-gen", StaticFiles(directory=open_gen_dist, html=True, check_dir=False), name="open-generative-ai")

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
        with contextlib.suppress(Exception):
            prompt_history().record(
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
            os.close(descriptor)
            write_private_text(draft_path, yaml.safe_dump(body.to_brief(), sort_keys=False))
            return runs.execute_content_run(
                draft_path,
                policy={"privacy": body.privacy},
                budget={"max_cost_usd": body.max_cost_usd},
            )
        finally:
            draft_path.unlink(missing_ok=True)

    # Routes the sign-in screen itself must reach before anyone is signed in.
    # Deliberately a small, exact set: everything else stays behind the gate.
    _GATE_ROUTES = frozenset({
        "/api/accounts",
        "/api/accounts/unlock",
        "/api/accounts/webauthn/authenticate/options",
        "/api/accounts/webauthn/authenticate",
    })

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

    @app.middleware("http")
    async def enforce_account_boundary(request: Request, call_next):
        signed_in = account_access.account_id(request.cookies.get(ACCOUNT_COOKIE))
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
        finally:
            current_account.reset(token)
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
        """Any signed-in workspace. Named for the 60-odd routes that already
        depend on it; what it now proves is "some account", and WHICH account is
        what the scoped resolvers above answer."""
        if getattr(request.state, "account", None) is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")

    def require_owner_account(request: Request) -> None:
        """The owner workspace specifically.

        GPU rentals spend real money against machine-wide provider keys and
        attach lanes the whole studio shares, so they are not per-workspace
        state — a second workspace must not be able to rent on the owner's card.
        """
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        if not account.is_owner:
            raise HTTPException(status_code=403, detail="Only the owner workspace can manage GPU rentals")

    register_gpu_rental_routes(app, require_owner_account)

    def owner_visible(request: Request, value: dict[str, Any]) -> dict[str, Any]:
        return value if bool(getattr(request.state, "is_owner", False)) else machine_run_receipt(value)

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

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "service": "hivemind-content-studio", "owner_lock": True}

    # ── accounts: the sign-in gate ────────────────────────────────────────────

    def _sign_in(response: JSONResponse, request: Request, account: Account) -> JSONResponse:
        forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
        response.set_cookie(
            ACCOUNT_COOKIE,
            account_access.issue(account.id),
            max_age=account_access.session_seconds,
            httponly=True,
            secure=request.url.scheme == "https" or forwarded == "https",
            samesite="strict",
            path="/",
        )
        return response

    def _relying_party(request: Request) -> RelyingParty:
        forwarded = request.headers.get("x-forwarded-proto", "").split(",", 1)[0].strip().lower()
        return RelyingParty.for_request(
            host=request.headers.get("host", ""),
            scheme=forwarded or request.url.scheme,
        )

    def _throttle_key(request: Request, account_id: int | None) -> str:
        address = request.client.host if request.client else "unknown"
        return f"{address}:{account_id if account_id is not None else 'any'}"

    def _guard_throttle(key: str) -> None:
        wait = login_throttle.retry_after(key)
        if wait > 0:
            raise HTTPException(
                status_code=429,
                detail=f"Too many attempts. Try again in {int(wait) + 1}s.",
                headers={"Retry-After": str(int(wait) + 1)},
            )

    @app.get("/api/accounts")
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
            "expires_in_seconds": SESSION_SECONDS,
        }

    @app.post("/api/accounts/unlock")
    def unlock_account(body: AccountUnlockBody, request: Request) -> JSONResponse:
        key = _throttle_key(request, body.account_id)
        _guard_throttle(key)
        account = account_store.get(body.account_id)
        stored = account_store.password_hash(body.account_id) if account else None
        if account is None or not verify_password(stored, body.password):
            login_throttle.fail(key)
            # One message for both cases: which workspaces have which passwords
            # is not something a failed attempt should teach anyone.
            raise HTTPException(status_code=401, detail="Wrong password")
        login_throttle.success(key)
        # An owner still carrying the legacy SHA-256 digest is upgraded to
        # scrypt the moment they prove they know the password.
        if is_legacy_password_hash(stored):
            account_store.set_password(account.id, body.password)
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    @app.post("/api/accounts/sign-out")
    def sign_out() -> JSONResponse:
        response = JSONResponse({"ok": True})
        response.delete_cookie(ACCOUNT_COOKIE, path="/", samesite="strict")
        return response

    @app.post("/api/accounts", status_code=201)
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

    @app.delete("/api/accounts/{account_id}")
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

    @app.post("/api/accounts/{account_id}/rename")
    def rename_account(account_id: int, body: AccountRenameBody, request: Request) -> dict:
        actor = getattr(request.state, "account", None)
        if actor is None or (actor.id != account_id and not actor.is_owner):
            raise HTTPException(status_code=403, detail="You can only rename your own workspace")
        try:
            return {"ok": True, "account": account_store.rename(account_id, body.name).public()}
        except (ValueError, LookupError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    # ── accounts: passkeys ────────────────────────────────────────────────────

    @app.post("/api/accounts/webauthn/register/options")
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

    @app.post("/api/accounts/webauthn/register")
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

    @app.get("/api/accounts/webauthn/passkeys")
    def list_passkeys(request: Request) -> dict:
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        return {"ok": True, "passkeys": account_store.list_passkeys(account.id)}

    @app.delete("/api/accounts/webauthn/passkeys/{credential_id:path}")
    def delete_passkey(credential_id: str, request: Request) -> dict:
        account = getattr(request.state, "account", None)
        if account is None:
            raise HTTPException(status_code=401, detail="Sign in to a workspace")
        if not account_store.delete_passkey(account.id, credential_id):
            raise HTTPException(status_code=404, detail="No such passkey on this workspace")
        return {"ok": True, "passkeys": account_store.list_passkeys(account.id)}

    @app.post("/api/accounts/webauthn/authenticate/options")
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

    @app.post("/api/accounts/webauthn/authenticate")
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
            login_throttle.fail(key)
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        account = account_store.get(account_id)
        if account is None:
            raise HTTPException(status_code=401, detail="That passkey's workspace no longer exists")
        login_throttle.success(key)
        return _sign_in(
            JSONResponse({"ok": True, "account": account.public(),
                          "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    # Kept so an old tab, a bookmark or the fallback lock page still works; both
    # now speak to the owner workspace rather than a studio-wide password.
    @app.get("/api/owner/session")
    def owner_session(request: Request) -> dict:
        account = getattr(request.state, "account", None)
        return {
            "ok": True,
            "unlocked": account is not None,
            "account": account.public() if account else None,
            "expires_in_seconds": OWNER_SESSION_SECONDS,
        }

    @app.post("/api/owner/unlock")
    def owner_unlock(body: OwnerUnlockBody, request: Request) -> JSONResponse:
        key = _throttle_key(request, owner_account.id)
        _guard_throttle(key)
        account = account_store.get(owner_account.id)
        stored = account_store.password_hash(owner_account.id) if account else None
        if account is None or not verify_password(stored, body.password):
            login_throttle.fail(key)
            raise HTTPException(status_code=401, detail="Wrong password")
        login_throttle.success(key)
        if is_legacy_password_hash(stored):
            account_store.set_password(account.id, body.password)
        return _sign_in(
            JSONResponse({"ok": True, "expires_in_seconds": account_access.session_seconds}),
            request, account,
        )

    @app.post("/api/owner/lock")
    def owner_lock() -> JSONResponse:
        response = JSONResponse({"ok": True})
        response.delete_cookie(ACCOUNT_COOKIE, path="/", samesite="strict")
        response.delete_cookie(access.cookie_name, path="/", samesite="strict")
        return response

    def _studio_shell() -> Response:
        """The React shell, served signed-in or not.

        The workspace picker and the passkey sign-in card are part of the same
        bundle, so the shell has to load before anyone has a session; it shows
        the gate and calls /api/accounts for the tiles. No account-scoped data
        is in the shell itself — only the app that will go and ask for it.
        """
        unified_index = open_gen_dist / "index.html"
        if unified_index.is_file():
            # Inject the studio marker so the frontend knows it is running as
            # the integrated studio (enables local workflows, run history via
            # the studio API, and the Hivemind dock) without URL params.
            html = unified_index.read_text(encoding="utf-8").replace(
                "<head>",
                "<head><script>window.__HIVEMIND_STUDIO__=1</script>",
                1,
            )
            # Never cache the shell. Vite fingerprints every asset, so a browser
            # holding a stale index.html keeps requesting the OLD hashed bundle
            # and the UI silently never updates after a rebuild — which looks
            # exactly like the new feature was never shipped.
            return HTMLResponse(
                html,
                headers={
                    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                    "Pragma": "no-cache",
                    "Expires": "0",
                },
            )
        return HTMLResponse(
            "<h1>Hivemind Content Studio</h1><p>The frontend build is missing. "
            "Run <code>npm --prefix packages/open-generative-ai run vite:build</code>.</p>",
            status_code=503,
        )

    @app.get("/", include_in_schema=False)
    def index() -> Response:
        return _studio_shell()

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
        open_gen_index = open_gen_dist / "index.html"
        open_gen_version = str(open_gen_index.stat().st_mtime_ns) if open_gen_index.is_file() else "missing"
        return {
            "ok": True,
            "surfaces": {
                "explore": {"path": f"/open-gen/?build={open_gen_version}", "available": open_gen_index.is_file()},
                "canvas": {"gateway_path": "/mobile/", "available": True},
                # No "models" surface: the model manager is a native view now, served
                # by this app and talking to the /local-ai bridge below.
                "gateway": {"gateway_path": "/", "available": True},
            },
        }

    # /local-ai/* is the same bridge without the prefix — the unified frontend
    # served at "/" calls it same-origin (hosted-local-ai.js apiBase = '').
    # DELETE is here for one route only — cancelling a Civitai download — but the
    # allowlist below still decides which paths exist at all.
    @app.api_route("/local-ai/{subpath:path}", methods=["GET", "POST", "DELETE"], dependencies=[Depends(require_owner)])
    async def local_ai_bridge(subpath: str, request: Request) -> Response:
        return await open_gen_api(f"local-ai/{subpath}", request)

    @app.api_route("/open-gen-api/{path:path}", methods=["GET", "POST", "DELETE"], dependencies=[Depends(require_owner)])
    async def open_gen_api(path: str, request: Request) -> Response:
        allowed = {
            "health",
            "healthz",
            "local-ai/binary-status",
            "local-ai/models",
            "local-ai/generate",
            "local-ai/upscale",
            "local-ai/interpolate",
            "local-ai/episode",
            "local-ai/smart-mask",
            "local-ai/ltx-director",
            "local-ai/prompt-helper",
            "local-ai/civitai-download",
            "local-ai/lora-updates",
            # Model manager: the installed library, Civitai browse, and its filter
            # vocabulary. All read-only; downloads still go through civitai-download.
            "local-ai/library",
            "local-ai/civitai-search",
            "local-ai/civitai-base-models",
        }
        dynamic_local_ai_route = any(
            path.startswith(prefix)
            and path.removeprefix(prefix).replace("-", "").replace("_", "").replace("%", "").isalnum()
            for prefix in (
                "local-ai/job/",
                "local-ai/loras/",
                "local-ai/lora-preview/",
                "local-ai/model-preview/",
                "local-ai/civitai-download/",
            )
        )
        if path not in allowed and not dynamic_local_ai_route:
            raise HTTPException(status_code=404, detail="OpenGen bridge route not found")
        body = await request.body()
        # Forward the query string too. The route allowlist above is matched on the
        # PATH only, so this cannot widen it — but dropping the query silently broke
        # callers that pass parameters (e.g. /local-ai/loras/<id>?baseModels=…, which
        # is how workflows the bridge cannot see in its own registry get resolved).
        query = str(request.url.query or "")[:2048]
        upstream_url = f"http://127.0.0.1:8794/{path}" + (f"?{query}" if query else "")

        def forward() -> tuple[bytes, int, str]:
            proxy_request = urllib.request.Request(
                upstream_url,
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

    def _build_simple_catalog() -> dict:
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

    # The catalog aggregates provider probes (the HivemindOS brains call can
    # take many seconds when that app is busy), and every model UI in the
    # studio waits on it. Serve the last-built catalog immediately and refresh
    # in the background instead of stalling each studio open on live probes.
    simple_catalog_cache: dict[str, Any] = {"payload": None, "at": 0.0}
    simple_catalog_refreshing = threading.Event()
    SIMPLE_CATALOG_TTL_SECONDS = 30.0
    # A build whose Media Studio workflow registry did not answer is not merely
    # stale, it is wrong: it describes MiniMax H3 without reference mode, so the
    # studio renders the pre-reference toolbar for it. Hold one for seconds, not
    # for the full TTL — the window this covers (a stack restart where the
    # gateway is still coming up, or a probe lost to a busy gateway) is short.
    SIMPLE_CATALOG_DEGRADED_TTL_SECONDS = 3.0

    def _catalog_registry_degraded(payload: dict | None) -> bool:
        video = ((payload or {}).get("media") or {}).get("video") or []
        return any(
            row.get("id") == "media-studio-mcp" and row.get("registry_live") is False
            for row in video
            if isinstance(row, dict)
        )

    def _refresh_simple_catalog() -> None:
        try:
            payload = _build_simple_catalog()
            simple_catalog_cache.update(payload=payload, at=time.time())
        except Exception:
            # Keep serving the previous catalog, but stamp the attempt: a build
            # that keeps throwing would otherwise leave a degraded payload
            # permanently past its short TTL, and rebuild inside every single
            # request instead of backing off.
            simple_catalog_cache["at"] = time.time()
        finally:
            simple_catalog_refreshing.clear()

    def _kick_simple_catalog_refresh() -> None:
        if simple_catalog_refreshing.is_set():
            return
        simple_catalog_refreshing.set()
        threading.Thread(target=_refresh_simple_catalog, name="simple-catalog-refresh", daemon=True).start()

    @app.get("/api/simple/catalog")
    def simple_catalog() -> dict:
        cached = simple_catalog_cache["payload"]
        if cached is None:
            payload = _build_simple_catalog()
            simple_catalog_cache.update(payload=payload, at=time.time())
            return payload
        age = time.time() - simple_catalog_cache["at"]
        if _catalog_registry_degraded(cached) and age > SIMPLE_CATALOG_DEGRADED_TTL_SECONDS:
            # Rebuild in the request rather than serving this page load the bad
            # capability list and refreshing behind its back — that pattern is
            # exactly why a reload used to be needed several times over before
            # the studio came back with its References and Frames controls.
            if not simple_catalog_refreshing.is_set():
                simple_catalog_refreshing.set()
                _refresh_simple_catalog()
            return simple_catalog_cache["payload"] or cached
        if age > SIMPLE_CATALOG_TTL_SECONDS:
            _kick_simple_catalog_refresh()
        return simple_catalog_cache["payload"] or cached

    @app.on_event("startup")
    def _warm_simple_catalog() -> None:
        # Build the catalog once at boot so even the first studio open after a
        # stack restart gets an instant model list.
        _kick_simple_catalog_refresh()

    # ---- prompt helper -------------------------------------------------
    #
    # An app-native replacement for the ComfyUI prompt_assistant node: the owner
    # picks any GGUF on this machine and the studio runs it in a llama-server it
    # owns, so loading and unloading are things the UI can actually do. Owner
    # gated like the rest, and the idea text never leaves this machine.

    @app.get("/api/prompt-helper/runtime", dependencies=[Depends(require_owner)])
    def prompt_helper_runtime() -> dict:
        return local_llm.runtime().snapshot()

    @app.post("/api/prompt-helper/load", dependencies=[Depends(require_owner)])
    def prompt_helper_load(body: PromptHelperLoadBody) -> dict:
        try:
            return local_llm.runtime().load(body.modelId, unload_others=body.unloadOthers)
        except local_llm.LocalLlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/prompt-helper/free-comfy", dependencies=[Depends(require_owner)])
    def prompt_helper_free_comfy() -> dict:
        try:
            freed = local_llm.free_comfy_memory()
        except local_llm.LocalLlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {**freed, **local_llm.runtime().snapshot()}

    # A lane holding a finished job's models is the thing that makes the next
    # local generation wait (or, at the gateway's admission check, time out), so
    # the studios surface it and offer Comfy's own /free. Owner-gated: this
    # reaches into the machine's running services.
    @app.get("/api/lanes/memory", dependencies=[Depends(require_owner)])
    def lanes_memory() -> dict:
        return comfy_lanes.snapshot()

    @app.post("/api/lanes/free", dependencies=[Depends(require_owner)])
    def lanes_free(body: LaneFreeBody) -> dict:
        try:
            return comfy_lanes.free_lane(body.lane)
        except comfy_lanes.LaneError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/prompt-helper/unload", dependencies=[Depends(require_owner)])
    def prompt_helper_unload(body: PromptHelperUnloadBody) -> dict:
        return local_llm.runtime().unload(body.modelId)

    @app.post("/api/prompt-helper/generate", dependencies=[Depends(require_owner)])
    def prompt_helper_generate(body: PromptHelperGenerateBody) -> dict:
        idea = body.idea.strip()
        if not idea:
            raise HTTPException(status_code=400, detail="Enter an idea before using the prompt helper")
        profile = prompt_profiles.profile_for(
            body.targetModel, media_type=body.mediaType,
            first_frame=body.hasFirstFrame, last_frame=body.hasLastFrame,
        )
        runtime = local_llm.runtime()
        warnings: list[str] = []
        image = (body.imageBase64 or "").strip() or None
        if image and not runtime.model_sees_images(body.modelId):
            # Say so rather than quietly writing a prompt about an image the
            # model was never shown.
            warnings.append(
                "This model has no vision projector beside it, so the start frame was not read — "
                "the opening shot describes the idea, not the image."
            )
            image = None
        # Client-computed from the composer's character catalog; bounded here
        # because the system prompt is a token budget, not a dumping ground.
        notes = [note.strip()[:200] for note in (body.characterNotes or []) if note.strip()][:12]
        messages = [
            {"role": "system", "content": prompt_profiles.system_prompt(
                profile, duration_seconds=body.durationSeconds, character_notes=notes,
                continuation=body.isContinuation, previous_prompt=body.previousPrompt,
                ugc=body.ugc, references=body.references)},
            {"role": "user", "content": idea},
        ]
        # Revising is the same conversation with the current draft in it, so
        # the format rules, the clip length and the start frame all still
        # apply — a note like "make it night" must not quietly cost the
        # <d> tags or push a beat past the end of the clip.
        revision = (body.revision or "").strip()
        current = (body.currentPrompt or "").strip()
        if revision and current:
            messages += [
                {"role": "assistant", "content": current},
                {"role": "user", "content":
                    f"Change the prompt: {revision}\n\nRewrite it in full, keeping everything else "
                    "as it is and the format identical."},
            ]
        elif revision:
            raise HTTPException(
                status_code=400, detail="Write a prompt before asking for changes to it")

        def _write(history: list[dict]) -> str:
            try:
                return runtime.chat(model_id=body.modelId, messages=history, image=image)
            except local_llm.LocalLlmError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        prompt = prompt_profiles.normalize(profile, _write(messages))
        edited = None
        if revision and current:
            # A revision that comes back byte-identical is the model ignoring
            # the note, and it is indistinguishable on screen from a correct
            # edit of three words inside twenty lines. Push once, firmly, then
            # say which of the two happened.
            edited = prompt_profiles.changed_lines(current, prompt)
            if edited == 0:
                harder = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        f"That is the same prompt — you did not apply the change. Apply it now: "
                        f"{revision}. Output the full prompt with that change made."},
                ]
                second = prompt_profiles.normalize(profile, _write(harder))
                edited = prompt_profiles.changed_lines(current, second)
                if edited:
                    prompt = second
                else:
                    warnings.append(
                        "The model handed back the same prompt — it did not apply that change. "
                        "Try naming the line to change, or edit the text directly."
                    )
        late = prompt_profiles.timeline_overruns(prompt, body.durationSeconds)
        if late:
            # One corrective pass. Small models overshoot the clip often enough
            # that handing back a timeline whose last beat never renders is the
            # common case, not the edge one — and the fix is mechanical to ask
            # for but not safe to apply by hand (moving a beat rewrites intent).
            retry = messages + [
                {"role": "assistant", "content": prompt},
                {"role": "user", "content":
                    f"Shot(s) starting at {', '.join(f'{t:g}s' for t in late)} fall outside the "
                    f"{body.durationSeconds:g}s clip, so they would never render. Rewrite the whole "
                    "prompt with the same story compressed to fit, keeping the format identical."},
            ]
            second = prompt_profiles.normalize(profile, _write(retry))
            if not prompt_profiles.timeline_overruns(second, body.durationSeconds):
                prompt = second
            else:
                prompt = second if len(prompt_profiles.timeline_overruns(second, body.durationSeconds)) < len(late) else prompt
                warnings.append(
                    f"The timeline still runs past the {body.durationSeconds:g}s clip — trim it or "
                    "regenerate before using it."
                )
        if body.isContinuation and prompt_profiles.continuation_opens_on_speech(prompt):
            # Same shape as the timeline repair above, and for the same reason:
            # the instruction says to hold the carried-over framing before
            # anything is said, and small helpers still open [Shot 1] on
            # dialogue. Asked once, then reported rather than silently shipped.
            retry = messages + [
                {"role": "assistant", "content": prompt},
                {"role": "user", "content":
                    "The clip opens on dialogue, but its first ~0.9s is the previous shot's "
                    "carried-over frames — those words would be spoken over the old picture. "
                    "Rewrite the whole prompt so [Shot 1] is a silent hold on the previous "
                    "framing with only small motion, and the first spoken line starts at 1s or "
                    "later with an explicit timestamp. Keep the scene and the format identical."},
            ]
            second = prompt_profiles.normalize(profile, _write(retry))
            if not prompt_profiles.continuation_opens_on_speech(second) \
                    and not prompt_profiles.timeline_overruns(second, body.durationSeconds):
                prompt = second
            else:
                warnings.append(
                    "This continuation starts speaking over the frames carried from the previous "
                    "shot. Move the first line a second in, or the join will read as a cut."
                )
        if body.ugc:
            # Polish and silence are the two ways a UGC prompt fails, and both
            # are things a helper does by habit rather than by choice — the
            # production vocabulary is what a video prompt normally wants, and
            # every H3 profile tells it speech is off by default. Checked in one
            # pass and repaired once, same shape as the timeline fix above:
            # naming the offending words is safe to ask for, but deleting them
            # by hand would leave the sentences around them broken.
            def _ugc_faults(text: str) -> list[str]:
                found = []
                tells = prompt_profiles.ugc_polish_tells(text)
                if tells:
                    found.append(
                        "it uses production words that give the clip away as an ad — "
                        + ", ".join(f'"{tell}"' for tell in tells)
                    )
                if prompt_profiles.ugc_missing_speech(profile, text):
                    found.append("nobody speaks in it, and a UGC clip is someone talking to camera")
                if profile.startswith("minimax-h3") and prompt_profiles.ugc_has_music(text):
                    found.append("it scores the clip, and UGC has no music — non_diegetic_music must be N/A")
                return found

            faults = _ugc_faults(prompt)
            if faults:
                retry = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        "That prompt would not pass as something a real person filmed: "
                        + "; ".join(faults)
                        + ". Rewrite the whole prompt fixing every one of those, keeping the same "
                        "story, the same beats and the format identical."},
                ]
                second = prompt_profiles.normalize(profile, _write(retry))
                remaining = _ugc_faults(second)
                if len(remaining) < len(faults) and not prompt_profiles.timeline_overruns(
                        second, body.durationSeconds):
                    prompt, faults = second, remaining
                for fault in faults:
                    warnings.append(f"Reads as produced rather than filmed: {fault}.")
        return {
            "prompt": prompt,
            "profile": profile,
            # Say when the continuation rules were in force, so a prompt written
            # for a chained shot is visibly a different job from a fresh one.
            "profileLabel": prompt_profiles.profile_label(
                profile, continuation=body.isContinuation, ugc=body.ugc),
            "warnings": warnings,
            "sawImage": bool(image),
            # None for a fresh write; a line count for a revision, so the UI can
            # show that something happened even when the change is three words.
            "changedLines": edited,
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

    @app.get("/api/studio-state/{state_key}", dependencies=[Depends(require_owner)])
    def get_studio_state(state_key: str) -> dict:
        try:
            return {"ok": True, "state": studio_state().get(state_key)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @app.put("/api/studio-state/{state_key}", dependencies=[Depends(require_owner)])
    def put_studio_state(state_key: str, body: StudioStateBody) -> dict:
        try:
            studio_state().put(state_key, body.state)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @app.delete("/api/studio-state/{state_key}", dependencies=[Depends(require_owner)])
    def delete_studio_state(state_key: str) -> dict:
        try:
            return {"ok": True, "removed": studio_state().delete(state_key)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    # ── owner vault (client-side E2E; server stores only ciphertext/wrapped keys) ──
    @app.get("/api/vault/identity", dependencies=[Depends(require_owner)])
    def get_vault_identity() -> dict:
        identity = vault().get_identity()
        return {"ok": True, "exists": identity is not None, "identity": identity}

    @app.put("/api/vault/identity", dependencies=[Depends(require_owner)])
    def put_vault_identity(body: VaultIdentityBody) -> dict:
        try:
            vault().put_identity(body.identity, allow_replace=body.allow_replace)
        except PermissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @app.put("/api/vault/prf/{credential_id:path}", dependencies=[Depends(require_owner)])
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

    @app.get("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def get_vault_blob(namespace: str, blob_key: str) -> dict:
        try:
            ciphertext = vault().get_blob(namespace, blob_key)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True, "ciphertext": ciphertext}

    @app.put("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def put_vault_blob(namespace: str, blob_key: str, body: VaultBlobBody) -> dict:
        try:
            vault().put_blob(namespace, blob_key, body.ciphertext)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return {"ok": True}

    @app.delete("/api/vault/blob/{namespace}/{blob_key}", dependencies=[Depends(require_owner)])
    def delete_vault_blob(namespace: str, blob_key: str) -> dict:
        try:
            return {"ok": True, "removed": vault().delete_blob(namespace, blob_key)}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @app.get("/api/simple/prompts", dependencies=[Depends(require_owner)])
    def list_prompts(favorites: bool = False, limit: int = 200) -> dict:
        return {"ok": True, "prompts": prompt_history().list(favorites_only=favorites, limit=limit)}

    @app.post("/api/simple/prompts/{prompt_id}/favorite", dependencies=[Depends(require_owner)])
    def favorite_prompt(prompt_id: str, body: FavoriteBody) -> dict:
        try:
            return {"ok": True, "prompt": prompt_history().set_favorite(prompt_id, body.favorite)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.delete("/api/simple/prompts/{prompt_id}", dependencies=[Depends(require_owner)])
    def delete_prompt(prompt_id: str) -> dict:
        try:
            prompt_history().delete(prompt_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {"ok": True}

    def _staged_media_studio_video_inputs(
        body: MediaStudioVideoBody, request: Request
    ) -> _StagedVideoInputs:
        image: Path | None = None
        middle: Path | None = None
        end: Path | None = None
        video: Path | None = None
        motion_context: Path | None = None
        ingredient_images: list[dict[str, Any]] = []
        reference_images: list[Path] = []
        reference_audios: list[Path] = []
        reference_videos: list[dict[str, Any]] = []
        has_private_reference = body.image_reference or body.video_reference or any(
            item.image_reference for item in [*body.ingredient_images, *body.reference_images]
        ) or any(item.audio_reference for item in body.reference_audios) or any(
            item.video_reference for item in body.reference_videos
        )
        if has_private_reference and not bool(getattr(request.state, "is_owner", False)):
            raise HTTPException(status_code=403, detail="Private media references require an owner session")
        try:
            if len(body.ingredient_images) > 12:
                raise ValueError("At most 12 ingredient reference images are supported")
            for index, item in enumerate(body.ingredient_images):
                if item.image_base64:
                    source = _write_inline_image(item.image_base64, media_studio_input_root)
                elif item.image_reference:
                    source = stage_media_studio_reference(item.image_reference)
                else:
                    raise ValueError(f"Ingredient reference {index + 1} has no image")
                ingredient_images.append({
                    "image_path": source,
                    "description": item.description.strip()[:1000],
                })
            # Reference-mode pictures: order is load-bearing (<Picture N> in the
            # prompt is the Nth entry), so stage them in the order received.
            if len(body.reference_images) > 9:
                raise ValueError("At most 9 reference images are supported")
            for index, item in enumerate(body.reference_images):
                if item.image_base64:
                    reference_images.append(_write_inline_image(item.image_base64, media_studio_input_root))
                elif item.image_reference:
                    reference_images.append(stage_media_studio_reference(item.image_reference))
                else:
                    raise ValueError(f"Reference image {index + 1} has no image")
            # Voice clips and motion references ride the same order-is-load-bearing
            # contract as the pictures: clip N is the prompt's <Audio N>, video N
            # its <Video N>.
            if len(body.reference_audios) > 3:
                raise ValueError("At most 3 reference audio clips are supported")
            for index, audio_item in enumerate(body.reference_audios):
                if audio_item.audio_base64:
                    reference_audios.append(_write_inline_audio(audio_item.audio_base64, media_studio_input_root))
                elif audio_item.audio_reference:
                    reference_audios.append(stage_media_studio_reference(audio_item.audio_reference))
                else:
                    raise ValueError(f"Reference audio {index + 1} has no clip")
            if len(body.reference_videos) > 3:
                raise ValueError("At most 3 reference videos are supported")
            for index, video_item in enumerate(body.reference_videos):
                if video_item.video_base64:
                    staged_reference = _write_inline_video(video_item.video_base64, media_studio_input_root)
                elif video_item.video_reference:
                    staged_reference = stage_media_studio_reference(video_item.video_reference)
                else:
                    raise ValueError(f"Reference video {index + 1} has no clip")
                reference_videos.append({
                    "video_path": staged_reference,
                    "use_audio": bool(video_item.use_audio),
                })
            # Video and image are decoded INDEPENDENTLY. They used to share one
            # if/elif chain, so a request carrying both — the only kind head swap
            # can make — silently lost the image and failed downstream claiming
            # the face was never supplied.
            if body.video_reference:
                video = stage_media_studio_reference(body.video_reference)
            elif body.video_base64:
                video = _write_inline_video(body.video_base64, media_studio_input_root)
            if body.motion_context_base64:
                if video is not None:
                    raise ValueError("A motion-context clip seeds a new shot and cannot be combined with a source video")
                motion_context = _write_inline_video(body.motion_context_base64, media_studio_input_root)
            if body.image_base64:
                image = _write_inline_image(body.image_base64, media_studio_input_root)
            elif body.image_reference:
                image = stage_media_studio_reference(body.image_reference)
            if video is None and image is None and not ingredient_images and not body.prompt.strip():
                # LTX 2.3 supports text-to-video, so a prompt alone is a valid
                # request; only reject a truly empty submission.
                raise ValueError("An image, video, or prompt is required")
            # First/middle/end keyframes are image anchors that only apply to
            # image-driven generation. The client sends them inline (any E2E
            # reference is decrypted in-browser before upload), so there is no
            # server-side reference path to stage here.
            if video is None:
                if body.middle_image_base64:
                    middle = _write_inline_image(body.middle_image_base64, media_studio_input_root)
                if body.end_image_base64:
                    end = _write_inline_image(body.end_image_base64, media_studio_input_root)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        return _StagedVideoInputs(
            image=image,
            middle=middle,
            end=end,
            video=video,
            motion_context=motion_context,
            ingredient_images=ingredient_images,
            reference_images=reference_images,
            reference_audios=reference_audios,
            reference_videos=reference_videos,
        )

    def _validated_media_studio_loras(body: MediaStudioVideoBody) -> list[dict[str, Any]]:
        loras: list[dict[str, Any]] = []
        for item in body.loras:
            lora_id = item.id.strip()
            if not lora_id or len(lora_id) > 512 or "\0" in lora_id:
                raise HTTPException(status_code=400, detail="LoRA id is invalid")
            if item.strength < -10 or item.strength > 10:
                raise HTTPException(status_code=400, detail=f"LoRA strength for {lora_id} must be between -10 and 10")
            loras.append({"id": lora_id, "strength": item.strength})
        return loras

    def _unlink_staged_media_studio_sources(staged: _StagedVideoInputs) -> None:
        for source in staged.paths():
            with contextlib.suppress(FileNotFoundError):
                source.unlink()

    def _finalize_media_studio_video(result: dict[str, Any], started: float) -> dict[str, Any]:
        gateway_output = Path(str(result.get("gateway_output") or "")).name
        if gateway_output:
            # Client-only E2E output: the gateway holds the sealed envelope and
            # no server can decrypt it. Serve it through the owner-gated proxy;
            # the browser's vault does the decryption (same as the History tab).
            url = f"/api/media-studio/gateway/{urllib.parse.quote(gateway_output)}"
            return {
                "ok": True,
                **_public_media_studio_result(result),
                "output": gateway_output,
                "qa": _public_media_studio_qa(result.get("qa")),
                "encrypted_at_rest": True,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "url": url,
                "media_url": url,
            }
        _remove_media_studio_qa_artifacts(result.get("qa"), outputs_root())
        output = Path(str(result.get("output") or "")).expanduser().resolve()
        root = outputs_root().resolve()
        if not output.is_relative_to(root) or not _private_media_exists(output):
            raise RuntimeError("Media Studio returned an unavailable output")
        # Prefer client-only E2E sealing (vault public key) so this host holds no
        # decrypt key; fall back to the legacy Keychain .zenc only with no vault.
        spki = _vault_public_key()
        if spki and output.is_file():
            media_type = mimetypes.guess_type(output.name)[0] or "video/mp4"
            seal_private_media_e2e(output, spki, media_type=media_type)
            encrypted_at_rest = True
        else:
            encrypted_at_rest = _encrypt_private_media(output, cipher)
        if not (_private_media_exists(output) or e2e_media_exists(output)):
            raise RuntimeError("Media Studio output could not be secured")
        elapsed = round(time.perf_counter() - started, 3)
        url = f"/api/media-studio/generated/{urllib.parse.quote(output.name)}"
        return {
            "ok": True,
            **_public_media_studio_result(result),
            "output": output.name,
            "qa": _public_media_studio_qa(result.get("qa")),
            "encrypted_at_rest": encrypted_at_rest,
            "elapsed_seconds": elapsed,
            "url": url,
            "media_url": url,
        }

    @app.post("/api/media-studio/video", dependencies=[Depends(require_owner_or_control)])
    async def generate_media_studio_video(body: MediaStudioVideoBody, request: Request) -> dict:
        staged = _staged_media_studio_video_inputs(body, request)
        loras = _validated_media_studio_loras(body)
        started = time.perf_counter()
        try:
            result = await asyncio.to_thread(
                run_media_studio_video,
                image_path=staged.image,
                middle_image_path=staged.middle,
                end_image_path=staged.end,
                video_path=staged.video,
                motion_context_path=staged.motion_context,
                video_mode=body.video_mode,
                task=body.task,
                prompt=body.prompt.strip(),
                reference_description=body.reference_description.strip(),
                ingredient_images=staged.ingredient_images,
                reference_images=staged.reference_images,
                reference_audios=staged.reference_audios,
                reference_videos=staged.reference_videos,
                duration_seconds=body.duration_seconds,
                aspect_ratio=body.aspect_ratio,
                resolution=body.resolution,
                workflow_id=body.workflow_id.strip() or None,
                studio_lane=body.studio_lane.strip(),
                loras=loras,
                output_dir=outputs_root(),
                requester_pub=_requester_pub(request),
            )
        except (FileNotFoundError, RuntimeError, TimeoutError, ValueError) as exc:
            detail = str(exc) if bool(getattr(request.state, "is_owner", False)) else "Media generation failed"
            raise HTTPException(status_code=503, detail=detail) from None
        finally:
            _unlink_staged_media_studio_sources(staged)
        try:
            response = _finalize_media_studio_video(result, started)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from None
        return response if bool(getattr(request.state, "is_owner", False)) else machine_operation_receipt(response)

    # Job-based variant: high-resolution runs take tens of minutes, far beyond
    # what one browser HTTP request survives. start returns a gateway job id
    # immediately; a background task finishes (download, QA, sealing) while the
    # browser polls the job route. If the studio restarts mid-run the registry
    # entry is lost but the gateway job still completes into History.
    media_studio_video_jobs: dict[str, dict[str, Any]] = {}

    def _prune_media_studio_video_jobs() -> None:
        cutoff = time.time() - 6 * 3600
        for key in [key for key, entry in media_studio_video_jobs.items() if entry.get("created", 0.0) < cutoff]:
            media_studio_video_jobs.pop(key, None)

    async def _finish_media_studio_video_job(job_id: str) -> None:
        """Drive a running job to its terminal state. Kicked off as a background
        task at start and re-entered (idempotently, via the finalizing flag) by
        the poll route, so a lost event loop can never strand a finished job."""
        entry = media_studio_video_jobs.get(job_id)
        if entry is None or entry.get("status") != "running":
            return
        # The finalizing flag is scoped to the event loop that set it: if that
        # loop died mid-finalize (its tasks are cancelled but the flag would
        # stay set), a caller on a NEW loop may reclaim the job.
        loop_id = id(asyncio.get_running_loop())
        if entry.get("finalizing") and entry.get("finalizing_loop") == loop_id:
            return
        entry["finalizing"] = True
        entry["finalizing_loop"] = loop_id
        try:
            result = await asyncio.to_thread(
                run_media_studio_video_finish,
                job_id,
                uploaded_names=list(entry.get("uploaded_names") or []),
                output_dir=outputs_root(),
                # Poll as the browser that started it: a keyed job is readable
                # only by its own requester, so the key is part of the job's
                # identity here, not a per-request detail.
                requester_pub=str(entry.get("requester_pub") or ""),
            )
            # A cancel that landed while the finisher was blocked in the thread
            # is terminal — don't resurrect the entry as done or error.
            if entry.get("status") == "cancelled":
                return
            entry.update(status="done", response=_finalize_media_studio_video(result, float(entry.get("started") or time.perf_counter())))
            # Record the real duration so future runs of the same shape get a
            # sharper elapsed/expected estimate.
            with contextlib.suppress(Exception):
                duration = time.perf_counter() - float(entry.get("started") or time.perf_counter())
                if entry.get("signature") and duration > 0:
                    generation_timings.record(
                        entry["signature"],
                        entry.get("workflow") or "",
                        float(entry.get("work_units") or 0),
                        duration,
                    )
        except Exception as exc:
            if entry.get("status") != "cancelled":
                entry.update(status="error", detail=str(exc) or "Media generation failed")

    @app.post("/api/media-studio/video/start", dependencies=[Depends(require_owner_or_control)])
    async def start_media_studio_video(body: MediaStudioVideoBody, request: Request) -> dict:
        staged = _staged_media_studio_video_inputs(body, request)
        loras = _validated_media_studio_loras(body)
        started = time.perf_counter()
        try:
            queued = await asyncio.to_thread(
                run_media_studio_video_start,
                image_path=staged.image,
                middle_image_path=staged.middle,
                end_image_path=staged.end,
                video_path=staged.video,
                motion_context_path=staged.motion_context,
                video_mode=body.video_mode,
                task=body.task,
                prompt=body.prompt.strip(),
                reference_description=body.reference_description.strip(),
                ingredient_images=staged.ingredient_images,
                reference_images=staged.reference_images,
                reference_audios=staged.reference_audios,
                reference_videos=staged.reference_videos,
                duration_seconds=body.duration_seconds,
                aspect_ratio=body.aspect_ratio,
                resolution=body.resolution,
                workflow_id=body.workflow_id.strip() or None,
                studio_lane=body.studio_lane.strip(),
                seed=body.seed,
                denoise=body.denoise,
                negative_prompt=body.negative_prompt,
                nag_scale=body.nag_scale,
                head_swap_lora_strength=body.head_swap_lora_strength,
                head_swap_backend=body.head_swap_backend,
                head_swap_face_enhancer=body.head_swap_face_enhancer,
                spectrum=body.spectrum,
                steps=body.steps,
                loras=loras,
                requester_pub=_requester_pub(request),
            )
        except (FileNotFoundError, RuntimeError, TimeoutError, ValueError) as exc:
            detail = str(exc) if bool(getattr(request.state, "is_owner", False)) else "Media generation failed"
            raise HTTPException(status_code=503, detail=detail) from None
        finally:
            # start_video uploads the inputs to the gateway before returning,
            # so the staged control-api copies are no longer needed either way.
            _unlink_staged_media_studio_sources(staged)
        job_id = str(queued["job_id"])
        _prune_media_studio_video_jobs()
        signature, workflow, work_units = _video_timing_signature(body)
        estimate_seconds = generation_timings.estimate(
            signature, workflow, work_units, fallback_rate=_DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT
        )
        media_studio_video_jobs[job_id] = {
            "status": "running",
            "created": time.time(),
            "started": started,
            "signature": signature,
            "workflow": workflow,
            "work_units": work_units,
            "estimate_seconds": estimate_seconds,
            "uploaded_names": list(queued.get("uploaded_names") or []),
            # Held for the life of the job: the background finisher polls long
            # after this request is gone, and a keyed job only answers to the
            # requester that started it.
            "requester_pub": _requester_pub(request),
        }
        asyncio.get_running_loop().create_task(_finish_media_studio_video_job(job_id))
        return {
            "ok": True,
            "job_id": job_id,
            "status": "running",
            **({"estimate_seconds": estimate_seconds} if estimate_seconds else {}),
        }

    @app.get("/api/media-studio/video/job/{job_id}", dependencies=[Depends(require_owner_or_control)])
    async def media_studio_video_job(job_id: str, request: Request) -> dict:
        entry = media_studio_video_jobs.get(job_id)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail="Unknown media job. If the studio restarted mid-generation, the finished video still appears in History.",
            )
        progress = None
        steps: dict[str, int] = {}
        if entry["status"] == "running":
            state = None
            with contextlib.suppress(Exception):
                # Progress for a keyed job is readable only by its requester —
                # taken from the registry, not this request, so a poll from a
                # second tab still reports the job it started.
                state = await asyncio.to_thread(
                    run_media_studio_video_check, job_id,
                    requester_pub=str(entry.get("requester_pub") or ""),
                )
            if state:
                progress = state.get("progress")
                if state.get("progress_total"):
                    steps = {
                        "progress_step": int(state.get("progress_step") or 0),
                        "progress_total": int(state["progress_total"]),
                    }
                # The background finisher normally lands the job; if its event
                # loop was lost, adopt the finished (or failed) job right here.
                if state.get("failed") or state.get("video_url"):
                    await _finish_media_studio_video_job(job_id)
        if entry["status"] == "done":
            response = entry["response"]
            return response if bool(getattr(request.state, "is_owner", False)) else machine_operation_receipt(response)
        if entry["status"] in ("error", "cancelled"):
            detail = entry.get("detail") if bool(getattr(request.state, "is_owner", False)) else "Media generation failed"
            return {"ok": False, "status": entry["status"], "detail": detail or "Generation cancelled"}
        elapsed_seconds = round(max(0.0, time.perf_counter() - float(entry.get("started") or time.perf_counter())), 1)
        return {
            "ok": True,
            "status": "running",
            "elapsed_seconds": elapsed_seconds,
            **({"progress": progress} if progress is not None else {}),
            **steps,
            **({"estimate_seconds": entry["estimate_seconds"]} if entry.get("estimate_seconds") else {}),
        }

    @app.post("/api/media-studio/video/job/{job_id}/cancel", dependencies=[Depends(require_owner_or_control)])
    def cancel_media_studio_video_job(job_id: str) -> dict:
        """Cancel/reset a video job. Marks the tracked job terminal so its finalizer
        stops and further polls return a cancelled state, and forwards a best-effort
        interrupt to the backend. Always succeeds (even for an unknown or already-
        finished job) so the studio can unblock the UI regardless — this is also the
        escape hatch for a job whose output never resolved a URL and hung 'running'."""
        entry = media_studio_video_jobs.get(job_id)
        outcome: dict[str, Any] = {"interrupted": False, "stopped": False, "backend_state": None}
        with contextlib.suppress(Exception):
            # Cancel as the job's own requester — the gateway will not act on a
            # keyed job for anyone else.
            result = run_media_studio_video_cancel(
                job_id, requester_pub=str((entry or {}).get("requester_pub") or ""),
            )
            # A bool is what older builds of cancel_video returned.
            outcome = result if isinstance(result, dict) else {
                "interrupted": bool(result), "stopped": bool(result), "backend_state": None,
            }
        if entry is not None:
            entry["status"] = "cancelled"
            entry["detail"] = "Cancelled by the owner."
        stopped = bool(outcome.get("stopped"))
        return {
            "ok": True,
            "status": "cancelled",
            "known": entry is not None,
            "interrupted": bool(outcome.get("interrupted")),
            # The job is off the UI either way, but the BACKEND may still be
            # winding down — and while it is, the next generation queues behind
            # it. Saying so is the difference between "cancelled" and a studio
            # that looks like it ignored the cancel.
            "stopped": stopped,
            **({"backend_state": outcome["backend_state"]} if outcome.get("backend_state") else {}),
            **({} if stopped else {
                "detail": "Still stopping: the backend finishes its current step before it can let go. "
                          "A new generation will queue behind it until then.",
            }),
        }

    @app.get("/api/media-studio/gateway/{output_name}", response_class=Response, dependencies=[Depends(require_owner)])
    def media_studio_gateway_media(output_name: str) -> Response:
        name = Path(output_name).name
        if not name or name != output_name:
            raise HTTPException(status_code=400, detail="A bare output filename is required")
        try:
            content, media_type = fetch_canvas_media(name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        return Response(content=content, media_type=media_type, headers={"Cache-Control": "private, no-store"})

    @app.post("/api/media-studio/ingredients/preview", dependencies=[Depends(require_owner)])
    async def preview_media_studio_ingredients(body: MediaStudioIngredientPreviewBody) -> Response:
        if not 1 <= len(body.ingredient_images) <= 12:
            raise HTTPException(status_code=400, detail="Between 1 and 12 ingredient reference images are required")
        sources: list[Path] = []
        output: Path | None = None
        try:
            for index, item in enumerate(body.ingredient_images):
                if item.image_base64:
                    source = _write_inline_image(item.image_base64, media_studio_input_root)
                elif item.image_reference:
                    source = stage_media_studio_reference(item.image_reference)
                else:
                    raise ValueError(f"Ingredient reference {index + 1} has no image")
                sources.append(source)
            if not ingredients_sheet_compositor.is_file():
                raise RuntimeError("Ingredients sheet compositor is unavailable")
            media_studio_input_root.mkdir(parents=True, exist_ok=True)
            descriptor, output_name = tempfile.mkstemp(
                prefix="media-studio-ingredients-preview-",
                suffix=".png",
                dir=media_studio_input_root,
            )
            os.close(descriptor)
            output = Path(output_name)
            dimensions = video_dimensions_for_request(aspect_ratio=body.aspect_ratio)
            geometry_args = (
                ["--width", str(dimensions[0]), "--height", str(dimensions[1])]
                if dimensions else []
            )
            completed = await asyncio.to_thread(
                subprocess.run,
                [
                    sys.executable,
                    str(ingredients_sheet_compositor),
                    "--output",
                    str(output),
                    *geometry_args,
                    *(str(source) for source in sources),
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            if completed.returncode != 0 or not output.is_file():
                raise RuntimeError("Ingredients sheet preview could not be composed")
            try:
                layout = json.loads(completed.stdout)
            except (json.JSONDecodeError, TypeError):
                layout = {}
            return Response(
                content=output.read_bytes(),
                media_type="image/png",
                headers={
                    "Cache-Control": "private, no-store",
                    "X-Ingredients-Columns": str(layout.get("columns", "")),
                    "X-Ingredients-Rows": str(layout.get("rows", "")),
                    "X-Ingredients-Sources": str(len(sources)),
                    "X-Ingredients-Width": str(layout.get("width", "")),
                    "X-Ingredients-Height": str(layout.get("height", "")),
                },
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        finally:
            for source in sources:
                source.unlink(missing_ok=True)
            if output is not None:
                output.unlink(missing_ok=True)

    def _reference_kind_for_suffix(suffix: str) -> str:
        """image / video / audio from the stored extension. The listing route
        classifies the same way; both read the same MIME tables."""
        value = str(suffix).lower()
        if value in set(_INLINE_VIDEO_SUFFIXES.values()):
            return "video"
        if value in set(_INLINE_AUDIO_SUFFIXES.values()):
            return "audio"
        return "image"

    def _build_reference_poster(reference: Path, *, kind: str) -> Path | None:
        # Never let a thumbnail failure fail an upload: the reference is the
        # point, the poster is a nicety, and the browser can still decode one.
        try:
            return media_posters.build_reference_poster(reference, kind=kind)
        except Exception:
            return None

    def _seal_reference_poster(poster: Path, spki: str | None) -> None:
        if not poster.is_file():
            return
        if spki:
            seal_private_media_e2e(poster, spki, media_type=media_posters.POSTER_MEDIA_TYPE)
        else:
            _encrypt_private_media(poster, cipher, scope="media-studio-reference")

    def _remove_reference_poster(poster: Path) -> None:
        for candidate in (poster, e2e_media_sidecar(poster), _private_media_sidecar(poster)):
            with contextlib.suppress(FileNotFoundError, OSError):
                candidate.unlink()

    def _reference_poster_url(reference: Path) -> str | None:
        poster = media_posters.poster_path_for(reference)
        if not (_private_media_exists(poster) or e2e_media_exists(poster)):
            return None
        return f"/api/media-studio/references/{urllib.parse.quote(poster.name)}"

    @app.post("/api/media-studio/references", dependencies=[Depends(require_owner)])
    async def upload_media_studio_reference(file: UploadFile = File(...)) -> dict:
        content_type = str(file.content_type or "").split(";", 1)[0].strip().lower()
        # Voice clips join pictures and clips here: H3 Reference mode conditions
        # on all three, and each is sealed to the owner vault the same way.
        mime_suffixes = {**_INLINE_IMAGE_SUFFIXES, **_INLINE_VIDEO_SUFFIXES, **_INLINE_AUDIO_SUFFIXES}
        suffix = mime_suffixes.get(content_type)
        if not suffix:
            candidate = Path(str(file.filename or "")).suffix.lower()
            if candidate in set(mime_suffixes.values()):
                suffix = candidate
        if not suffix:
            raise HTTPException(status_code=415, detail="Reference must be a supported image, video, or audio clip")
        is_video = content_type in _INLINE_VIDEO_SUFFIXES or suffix in set(_INLINE_VIDEO_SUFFIXES.values())
        max_bytes = _MAX_PRIVATE_VIDEO_BYTES if is_video else _MAX_PRIVATE_IMAGE_BYTES
        body = await file.read(max_bytes + 1)
        await file.close()
        if not body:
            raise HTTPException(status_code=400, detail="Media reference is empty")
        if len(body) > max_bytes:
            raise HTTPException(status_code=413, detail=f"Media reference is too large; max {max_bytes // 1024 // 1024} MB")

        references_root().mkdir(parents=True, exist_ok=True)
        name = f"reference-{secrets.token_hex(16)}{suffix}"
        reference = (references_root() / name).resolve()
        reference.write_bytes(body)
        # Build the thumbnail NOW, while the plaintext is still here. Once sealed
        # the host can never read this file again, so this is the only moment a
        # poster can be made server-side — and without one, drawing a 32px tile
        # costs the browser the whole asset.
        poster = _build_reference_poster(reference, kind=_reference_kind_for_suffix(suffix))
        # Seal to the owner vault (client-only E2E) so this host holds no decrypt
        # key. Reuse is client-side: the browser decrypts and re-sends base64 (the
        # server can no longer stage a sealed reference). Legacy Keychain .zenc is
        # only a no-vault fallback.
        spki = _vault_public_key()
        try:
            if spki:
                media_type = mimetypes.guess_type(reference.name)[0] or "image/png"
                seal_private_media_e2e(reference, spki, media_type=media_type)
            else:
                _encrypt_private_media(reference, cipher, scope="media-studio-reference")
            # The poster is sealed the same way, so the privacy contract is
            # unchanged: the host keeps no readable copy of either.
            if poster is not None:
                _seal_reference_poster(poster, spki)
        except Exception as exc:
            with contextlib.suppress(FileNotFoundError):
                reference.unlink()
            with contextlib.suppress(FileNotFoundError):
                e2e_media_sidecar(reference).unlink()
            if poster is not None:
                _remove_reference_poster(poster)
            raise HTTPException(status_code=503, detail="Reference image could not be secured") from exc
        if not (_private_media_exists(reference) or e2e_media_exists(reference)):
            raise HTTPException(status_code=503, detail="Reference image could not be secured")
        url = f"/api/media-studio/references/{urllib.parse.quote(name)}"
        return {
            "ok": True,
            "url": url,
            "encrypted_at_rest": True,
            "poster_url": _reference_poster_url(reference),
        }

    @app.post("/api/media-studio/references/{filename}/poster", dependencies=[Depends(require_owner)])
    async def upload_media_studio_reference_poster(filename: str, file: UploadFile = File(...)) -> dict:
        """Browser-supplied poster for a reference sealed before posters existed.

        The host cannot build one itself for those — it has no vault key, so it
        cannot read them. The browser already decrypts the clip to display it,
        so it is the only party that can, and it sends back the one frame it
        decoded. Sealed here like any other reference; still owner-gated, still
        never readable by this host afterwards.
        """
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root) or media_posters.is_poster_name(name):
            raise HTTPException(status_code=404, detail="Reference not found")
        if not (_private_media_exists(reference) or e2e_media_exists(reference)):
            raise HTTPException(status_code=404, detail="Reference not found")
        poster = media_posters.poster_path_for(reference)
        if _private_media_exists(poster) or e2e_media_exists(poster):
            return {"ok": True, "poster_url": _reference_poster_url(reference), "existed": True}
        body = await file.read(media_posters.MAX_POSTER_BYTES + 1)
        await file.close()
        if not body:
            raise HTTPException(status_code=400, detail="Poster is empty")
        if len(body) > media_posters.MAX_POSTER_BYTES:
            raise HTTPException(status_code=413, detail="Poster is too large to be a thumbnail")
        # A poster is a JPEG and nothing else — this route must not become a way
        # to park arbitrary bytes in the reference store under a chosen name.
        if not body.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=415, detail="Poster must be a JPEG")
        poster.write_bytes(body)
        try:
            _seal_reference_poster(poster, _vault_public_key())
        except Exception as exc:
            _remove_reference_poster(poster)
            raise HTTPException(status_code=503, detail="Poster could not be secured") from exc
        return {"ok": True, "poster_url": _reference_poster_url(reference), "existed": False}

    @app.get("/api/media-studio/references/{filename}", dependencies=[Depends(require_owner)])
    def media_studio_reference(filename: str, request: Request) -> Response:
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Reference image not found")
        # Client-only E2E envelope (re-sealed reference): serve verbatim for the
        # browser to decrypt for display.
        envelope = read_e2e_envelope(reference)
        if envelope is not None:
            return _e2e_envelope_response(envelope)
        if not _private_media_exists(reference):
            raise HTTPException(status_code=404, detail="Reference image not found")
        try:
            body = _read_private_media(reference, cipher, scope="media-studio-reference")
        except ValueError as exc:
            raise HTTPException(status_code=503, detail="Reference image could not be decrypted") from exc
        media_type = mimetypes.guess_type(reference.name)[0] or "image/png"
        return _private_media_response(body, media_type=media_type, range_header=request.headers.get("range", ""))

    @app.delete("/api/media-studio/references/{filename}", dependencies=[Depends(require_owner)])
    def delete_media_studio_reference(filename: str) -> dict:
        name = Path(filename).name
        reference = (references_root() / name).resolve()
        root = references_root().resolve()
        if name != filename or not reference.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Reference image not found")
        removed = False
        for candidate in (reference, _private_media_sidecar(reference), e2e_media_sidecar(reference)):
            if candidate.is_file():
                candidate.unlink()
                removed = True
        # The poster goes with it — an orphan would linger in the store forever,
        # since nothing else knows the reference it belonged to is gone.
        _remove_reference_poster(media_posters.poster_path_for(reference))
        if not removed:
            raise HTTPException(status_code=404, detail="Reference image not found")
        return {"ok": True}

    @app.get("/api/media-studio/references", dependencies=[Depends(require_owner)])
    def list_media_studio_references() -> dict:
        # Enumerate the owner's saved reference uploads so past uploads reappear in
        # the picker even when the browser's composer state is empty (fresh browser,
        # cleared state). Each stays E2E: the URL points at the .e2e envelope route,
        # which the browser decrypts for display — this host never decrypts them.
        root = references_root()
        newest: dict[str, float] = {}
        # Posters live beside their reference and are NOT references themselves —
        # listing one would offer the user a thumbnail as if it were a picture
        # they could condition on. Indexed by stem so each attaches to its owner.
        posters: dict[str, str] = {}
        if root.is_dir():
            for path in root.iterdir():
                if not path.is_file():
                    continue
                base = path.name
                for suffix in (".e2e", _PRIVATE_MEDIA_SUFFIX):
                    if base.endswith(suffix):
                        base = base[: -len(suffix)]
                        break
                if not base.startswith("reference-"):
                    continue
                owner_stem = media_posters.poster_owner_stem(base)
                if owner_stem is not None:
                    posters[owner_stem] = base
                    continue
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if base not in newest or mtime > newest[base]:
                    newest[base] = mtime
        def reference_kind(name: str) -> str:
            suffix = Path(name).suffix.lower()
            if suffix in set(_INLINE_VIDEO_SUFFIXES.values()):
                return "video"
            if suffix in set(_INLINE_AUDIO_SUFFIXES.values()):
                return "audio"
            return "image"

        def poster_url_for(base: str) -> str | None:
            poster = posters.get(Path(base).stem)
            return f"/api/media-studio/references/{urllib.parse.quote(poster)}" if poster else None

        references = [
            {
                "name": base,
                "url": f"/api/media-studio/references/{urllib.parse.quote(base)}",
                "timestamp": mtime,
                # Pickers filter on this: a saved voice clip has no business in
                # the picture grid, and its thumbnail would never resolve.
                "kind": reference_kind(base),
                # A few KB to draw a tile with, instead of the whole sealed
                # asset. None for references sealed before posters existed (the
                # host cannot read those) and for voice clips (nothing to show);
                # the browser falls back to decrypting, and backfills a poster.
                "poster_url": poster_url_for(base),
            }
            for base, mtime in sorted(newest.items(), key=lambda item: item[1], reverse=True)
        ]
        return {"ok": True, "references": references}

    @app.get("/api/media-studio/generated/{filename}", dependencies=[Depends(require_owner)])
    def media_studio_generated_video(filename: str, request: Request) -> Response:
        name = Path(filename).name
        output = (outputs_root() / name).resolve()
        root = outputs_root().resolve()
        if name != filename or not output.is_relative_to(root):
            raise HTTPException(status_code=404, detail="Generated video not found")
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
                canvas_store().sync(fetch_canvas_history())
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

    @app.get("/api/canvas/history/{history_id}/workflow", dependencies=[Depends(require_owner)])
    def canvas_output_workflow(history_id: str) -> dict:
        try:
            output_name = canvas_store().output_name(history_id)
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
            metadata = canvas_store().remember_provenance(history_id, models=body.models, seeds=body.seeds)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        return {"ok": True, **metadata}

    @app.delete("/api/canvas/history/{history_id}", dependencies=[Depends(require_owner)])
    def delete_canvas_history_output(history_id: str, body: ConfirmDeleteBody) -> dict:
        if not body.confirm:
            raise HTTPException(status_code=400, detail="Permanent deletion requires confirm=true")
        try:
            output_name = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            result = delete_canvas_output(output_name)
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        removed_rows = canvas_store().delete(history_id)
        return {"ok": True, "removed_history_rows": removed_rows, **result}

    @app.get("/api/canvas/history/{history_id}/media", response_class=Response, dependencies=[Depends(require_owner)])
    def canvas_output_media(history_id: str, request: Request) -> Response:
        try:
            output_name = canvas_store().output_name(history_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Canvas output not found") from None
        try:
            # Presenting the caller's key is what selects the envelope: a device
            # that generated this clip gets the copy sealed to itself, everyone
            # else gets the owner's. Without it a device-sealed output would
            # only ever come back in a form the browser cannot open.
            content, media_type = fetch_canvas_media(output_name, requester_pub=_requester_pub(request))
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        headers = {"Cache-Control": "private, no-store"}
        if "hivemind.e2e" in (media_type or ""):
            # Mirror the gateway so the browser's E2E detection works off the
            # header it already looks for, not only the content type.
            headers["X-E2E-Media"] = "1"
        return Response(content=content, media_type=media_type, headers=headers)

    @app.get(
        "/api/runs/{run_id}/artifacts/{artifact_id}",
        response_class=Response,
        dependencies=[Depends(require_owner)],
    )
    def artifact(run_id: str, artifact_id: str, request: Request) -> Response:
        try:
            run = runs.get_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
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

    # Registered last so every API route above wins; serves root-level build
    # files the unified frontend references absolutely (/hosted-local-ai.js,
    # /vite.svg, …).
    app.mount("/", StaticFiles(directory=open_gen_dist, html=True, check_dir=False), name="unified-frontend")

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("CONTENT_STUDIO_CONTROL_HOST", "127.0.0.1")
    port = int(os.environ.get("CONTENT_STUDIO_CONTROL_PORT", "8765"))
    uvicorn.run(build_control_app(), host=host, port=port)


if __name__ == "__main__":
    main()
