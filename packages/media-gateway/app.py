#!/usr/bin/env python3
import base64
import binascii
import hashlib
import html
import json
import math
import mimetypes
import os
import re
import select
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import tempfile
import email.parser
import email.policy
import io
import uuid
import zlib
import shutil
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = Path(__file__).resolve().parent
STUDIO_ROOT = Path(os.environ.get("HIVEMIND_STUDIO_ROOT", str(BASE.parents[1]))).expanduser().resolve()
MEDIA_STATE_ROOT = Path(
    os.environ.get("HIVEMIND_MEDIA_STATE_DIR", str(Path.home() / ".hivemindos/media-studio"))
).expanduser().resolve()
GATEWAY_STATE_DIR = Path(
    os.environ.get("MEDIA_GATEWAY_STATE_DIR", str(MEDIA_STATE_ROOT / "state/media-gateway"))
).expanduser().resolve()
GATEWAY_STATE_DIR.mkdir(parents=True, exist_ok=True)
COMFY = Path(os.environ.get("COMFY_DIR", str(Path.home() / "comfy/ComfyUI")))
RUNNER = COMFY / "run_z_image_turbo.py"
OUT_DIR = Path(os.environ.get("ZIMG_OUTPUT_DIR", str(Path.home() / ".comfy-private.noindex/z_image_outputs")))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", str(Path.home() / ".comfy-private.noindex/output")))
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", str(Path.home() / ".comfy-private.noindex/input")))
DEBUG_OUTPUT_DIR = Path(os.environ.get("ZIMG_DEBUG_OUTPUT_DIR", str(Path.home() / ".comfy-private.noindex/debug_outputs")))
MFLUX_DIR = Path(os.environ.get("MFLUX_BIGLOVE_DIR", str(Path.home() / "comfy/mflux-biglove")))
MFLUX_BIN = MFLUX_DIR / ".venv/bin/mflux-generate-flux2-edit"
MFLUX_KLEIN3_MODEL = MFLUX_DIR / "models/flux2-klein-base-9b-BigLoveKlein3"
SWIFT_FLUX2_BIN = Path(os.environ.get("SWIFT_FLUX2_BIN", str(STUDIO_ROOT / "engines/flux-2-swift-mlx/.build/arm64-apple-macosx/release/Flux2CLI")))
SWIFT_MLX_METALLIB = Path(os.environ.get("SWIFT_MLX_METALLIB", str(Path.home() / "comfy/Flux2CLI-v2.1.0/mlx.metallib")))
SWIFT_FLUX2_SERVER_URL = os.environ.get("SWIFT_FLUX2_SERVER_URL", "http://127.0.0.1:8791")
SWIFT_MODELS_CACHE = Path(os.environ.get("SWIFT_MODELS_CACHE", str(Path.home() / "Library/Caches/models")))


def resolve_ltx2_mlx_dir(*, env=None, studio_root=None, home=None, temp_root=None):
    """Find the persistent optimized MLX runtime; /tmp is legacy fallback only."""
    env = os.environ if env is None else env
    explicit = str(env.get("LTX2_MLX_DIR") or "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()

    root = Path(studio_root or STUDIO_ROOT).expanduser().resolve()
    home = Path(home or Path.home()).expanduser().resolve()
    temp_root = Path(temp_root or tempfile.gettempdir()).expanduser().resolve()
    persistent = root.parent / "ltx-2-mlx-opt"
    candidates = (
        persistent,
        home / "comfy" / "ltx-2-mlx-opt",
        temp_root / "ltx-2-mlx-opt",
    )
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "pyproject.toml").is_file():
            return candidate
    return persistent


LTX2_MLX_DIR = resolve_ltx2_mlx_dir()
LTX2_MLX_GEMMA = os.environ.get("LTX2_MLX_GEMMA", "mlx-community/gemma-3-12b-it-4bit")
# Normalized Attention Guidance. Guides inside cross-attention instead of via a
# second model pass, so the distilled lanes (cfg=1, where CFG does nothing and a
# negative prompt is inert) get real negative guidance for ~8% more time.
# Values match the LTX 2.3 community workflows.
LTX_NAG_DEFAULTS = {"scale": 11.0, "alpha": 0.25, "tau": 2.5}

MLX_MODELS_ROOT = Path(os.environ.get("MLX_MODELS_ROOT", str(Path.home() / "comfy/mlx-models")))
LTX2_MLX_VARIANTS = {
    # v1.3 + DMD. Two reasons this exists: upstream v1.3 "substantially reduced
    # ghost anatomy and subtitle artifacts" over v1.2, and the DMD deltas are
    # merged into the base instead of fused as a distilled LoRA at runtime —
    # which the build's own card says avoids the resampling-to-base drift and
    # conditioning loss the LoRA introduces during the stage-2 upscale refine
    # (the step that leaves the crawling grain on the v1.2 route).
    # v1.2 + DMD. The control for the adherence question: v1.3-DMD lost prompt
    # steering versus v1.2-fast, but those differ in BOTH the fine-tune (v1.2 ->
    # v1.3) and the distillation (LoRA -> merged DMD). This holds the DMD merge
    # constant at the v1.2 fine-tune, so a v1.2-fast/v1.2-DMD/v1.3-DMD triangle
    # attributes the regression to one of them instead of guessing.
    "dmd-q8-v12": {
        "title": "MLXBits 10Eros v1.2 DMD q8 distilled",
        "model": str(MLX_MODELS_ROOT / "ltx-2.3-10eros-v1.2-dmd-mlx-q8"),
        "video_model": str(MLX_MODELS_ROOT / "ltx-2.3-10eros-v1.2-dmd-mlx-q8"),
        "video_distilled": True,
        "output_prefix": "mlx_10eros_v12_dmd_q8_distilled_mobile",
        "benchmark_seconds": 193.11,
    },
    "regular-q8-distilled": {
        "title": "LTX 2.3 regular q8 distilled",
        "model": str(MLX_MODELS_ROOT / "ltx-2.3-mlx-q8-distilled-subset"),
        "video_model": str(MLX_MODELS_ROOT / "ltx-2.3-mlx-q8-distilled-subset"),
        "video_distilled": True,
        "output_prefix": "mlx_ltx23_regular_q8_distilled_mobile",
        "benchmark_seconds": None,
        "backend_prefix": "mlx-ltx-regular",
        "output_subdir": "LTX23",
    },
    "regular-q8-dev-ic": {
        "title": "LTX 2.3 regular q8 dev IC-LoRA",
        "model": str(MLX_MODELS_ROOT / "ltx-2.3-mlx-q8-dev"),
        "video_model": str(MLX_MODELS_ROOT / "ltx-2.3-mlx-q8-dev"),
        "video_distilled": False,
        "output_prefix": "mlx_ltx23_regular_q8_dev_ic_mobile",
        "benchmark_seconds": 270.75,
        "backend_prefix": "mlx-ltx-regular",
        "output_subdir": "LTX23",
    },
    # Ingredients IC-LoRA on the v1.3 DMD build. The dev lane above fuses the
    # generic distilled LoRA at 0.5 alongside the IC-LoRA (the Comfy recipe);
    # a DMD build ships no dev transformer because the distillation is already
    # merged, so this runs ic-lora's plain distilled mode with the IC-LoRA as
    # the only adapter. Sibling lane on purpose — the dev one stays the default
    # until an A/B says otherwise.
    # v1.4, converted locally from TenStrip's bf16 with mlx-forge (int8, group 64)
    # because no MLX v1.4 build is published. This is a DEV package: the fast
    # --distilled two-stage path needs a distilled transformer this does not
    # have, so v1.4 is wired to the dev/Ingredients lane, matching eros-q8-dev-ic.
    # v1.2 rebuilt through OUR merge path, as a control. eros-fast is the same
    # base and the same cond-safe LoRA, but MLXBits merged in bf16 and quantized
    # afterwards, where we merge into already-int8 weights. Comparing this to
    # eros-fast isolates that arithmetic; comparing it to v1.4 Fast isolates the
    # fine-tune. Without it the two variables are tangled.
    # v1.4 Fast: eros-fast's recipe on the v1.4 fine-tune. eros-fast merges the
    # *cond-safe* rank-384 distilled LoRA (Frobenius-clipped, built to preserve
    # conditioning) rather than the stock one, which is the likeliest reason it
    # follows prompts better than the Lite build. Same LoRA at the same strength
    # here, so this and eros-fast differ only in base model.
    # v1.4 DMD: the build the author actually intends. The v1.4 model card says
    # the release "is also fully designed for use with the DMD lora I attached",
    # so eros-v14-q8-fast above — which merges v1.2's cond-safe rank-384 LoRA —
    # is running v1.4 with the wrong adapter. This merges the attached LoRA
    # (ltx23DMDFro99.GKDv, Frobenius-resized to 99%) at 1.0 instead. It is
    # Frobenius-resized so rank varies per module and every module ships an
    # .alpha; ltx-core-mlx's apply_loras ignores .alpha, which is only safe here
    # because alpha/rank == 1.0 for all 1660 modules (the build script asserts
    # it). Distilled because DMD *is* the distillation — hence the fast lane.
    "eros-v14-q8-dmd": {
        "title": "LTX 2.3 10Eros v1.4 DMD q8 distilled",
        "model": str(MLX_MODELS_ROOT / "ltx-2.3-10eros-v1.4-dmd-mlx-q8"),
        "video_model": str(MLX_MODELS_ROOT / "ltx-2.3-10eros-v1.4-dmd-mlx-q8"),
        "video_distilled": True,
        "output_prefix": "mlx_ltx23_10eros_v14_dmd_q8_distilled_mobile",
        "benchmark_seconds": 193.11,
        "backend_prefix": "mlx-ltx-eros",
        "output_subdir": "Eros",
    },
    # Plain image-to-video on the same v1.4 dev package. Separate from the -ic
    # variant below only so outputs are named for the lane that made them; both
    # point at one model directory. Runs --two-stage (see the runner), so it is
    # slower than the distilled Eros lanes — that is the cost of a dev build.
}
LTX2_MLX_VARIANT_ALIASES = {
    "fast": "eros-v14-q8-dmd",
    "q8": "eros-v14-q8-dmd",
    "q8-v12": "eros-v14-q8-dmd",
    "fast-q8": "eros-v14-q8-dmd",
    "fast_q8_v12": "eros-v14-q8-dmd",
    "mlx-bits-v12": "eros-v14-q8-dmd",
    "regular": "regular-q8-distilled",
    "regular-q8": "regular-q8-distilled",
    "regular-fast": "regular-q8-distilled",
    "ltx23-regular": "regular-q8-distilled",
    "ltx-2.3-regular": "regular-q8-distilled",
    "eros-ingredients": "regular-q8-dev-ic",
    "eros-ic": "regular-q8-dev-ic",
    "eros-dev-ic": "regular-q8-dev-ic",
}
HISTORY_FILE = GATEWAY_STATE_DIR / "history.jsonl"
PREVIEW_CACHE_ROOTS = [
    Path.home() / ".comfy-private.noindex/preview-cache",
    Path(os.environ.get("COMFY_TEMP_DIR", str(Path.home() / ".comfy-private.noindex/temp"))) / "mobile_video_thumbs",
]
QUEUE_METADATA_FILES = [STUDIO_ROOT / "packages/comfyui-mobile/.cache/queue_metadata_cache.json"]
TOKEN_FILE = Path(
    os.environ.get("ZIMG_TOKEN_FILE", str(MEDIA_STATE_ROOT / "secure/zimg-token"))
).expanduser().resolve()
HOST = os.environ.get("ZIMG_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZIMG_PORT", "8787"))
FRONTEND_HTTP = os.environ.get("ZIMG_FRONTEND_HTTP", "http://127.0.0.1:8788")
TOKEN = os.environ.get("ZIMG_TOKEN") or (TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else "")
COMFY_HTTP_DEFAULT = os.environ.get("COMFY_HTTP_DEFAULT") or os.environ.get("COMFY_HTTP", "http://127.0.0.1:8188")

# Drop-in auto-detected workflows: any API-format ComfyUI graph placed in one
# of these folders is exposed as a local image model (see hosted-server's
# auto-workflow-discovery) and executed by run_comfy_api_image.
AUTO_WORKFLOW_DIRS = [
    Path(entry).expanduser()
    for entry in (os.environ.get("ZIMG_AUTO_WORKFLOW_DIRS", "").split(os.pathsep) if os.environ.get("ZIMG_AUTO_WORKFLOW_DIRS") else [])
    if entry.strip()
] or [COMFY / "workflows" / "auto"]
# Registry-shipped API graphs (workflow-registry.json `workflow_file`). Same
# executor as a drop-in, different provenance: these ride in the repo.
REGISTRY_WORKFLOW_DIR = BASE / "workflows"
COMFY_HTTP = COMFY_HTTP_DEFAULT
MAX_JSON_BODY_BYTES = int(os.environ.get("MEDIA_GATEWAY_MAX_JSON_BODY_BYTES", str(25 * 1024 * 1024)))

if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

from krea2_identity_workflow import (
    KREA2_IDENTITY_BACKENDS,
    KREA2_IDENTITY_CONVROT_MODEL,
    KREA2_SAMPLERS,
    KREA2_SCHEDULERS,
    KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
    build_krea2_turbo_outpaint_prompt,
    build_krea2_turbo_identity_prompt as compile_krea2_turbo_identity_prompt,
    build_krea2_turbo_inpaint_prompt as compile_krea2_turbo_inpaint_prompt,
    krea2_sampler_defaults,
    resolve_seed_option,
)
from strength_hunt import (
    build_strength_hunt_plan,
    merge_strength_hunt_graphs,
    strength_hunt_output_index,
)
from klein_character_sheet import (
    character_sheet_grid,
    character_sheet_view_prompt,
    resolve_character_sheet_views,
)
from smart_mask import build_sam3_mask_prompt
from ltx_director_graph import build_ltx_director_prompt, missing_ltx_director_assets
from ltx_director_timeline import DirectorProjectError, director_missing_assets

try:
    from hardware_profile import capabilities_for_profile, detect_profile
except Exception:
    def detect_profile(env=None):
        env = env if env is not None else os.environ
        requested = str(env.get("ZIMG_ACCELERATOR_PROFILE") or env.get("ZIMG_HARDWARE_PROFILE") or "auto").strip().lower().replace("_", "-")
        aliases = {"apple": "apple-silicon", "mac": "apple-silicon", "macos": "apple-silicon", "mps": "apple-silicon", "mlx": "apple-silicon", "metal": "apple-silicon", "nvidia": "cuda", "amd": "rocm"}
        requested = aliases.get(requested, requested)
        if requested in {"apple-silicon", "apple-intel", "cuda", "rocm", "cpu"}:
            return requested
        return "apple-silicon" if sys.platform == "darwin" and os.uname().machine == "arm64" else "cpu"

    def capabilities_for_profile(profile=None):
        profile = profile or detect_profile()
        apple_silicon = profile == "apple-silicon"
        return {
            "profile": profile,
            "apple_silicon": apple_silicon,
            "apple_silicon_optimizations": apple_silicon,
            "native_mlx": apple_silicon,
            "swift_flux2": apple_silicon,
            "asfp8_int8_ext": apple_silicon,
            "asfp8_fp8_ext": apple_silicon,
        }


def accelerator_profile():
    return detect_profile()


def optimization_capabilities():
    return capabilities_for_profile(accelerator_profile())


def supports_apple_silicon_optimizations():
    return bool(optimization_capabilities().get("apple_silicon_optimizations"))


def supports_native_mlx_biglove_route():
    return bool(optimization_capabilities().get("native_mlx")) and _env_enabled("ZIMG_ENABLE_MLX_BIGLOVE_ROUTE", "1")


def supports_native_mlx_ltx_route():
    return bool(optimization_capabilities().get("native_mlx")) and _env_enabled("ZIMG_ENABLE_MLX_LTX_ROUTE", "1")


def use_swift_flux2_server():
    return supports_native_mlx_biglove_route() and _env_enabled("ZIMG_USE_FLUX2_SERVER", "0")


def parse_comfy_lanes():
    raw = os.environ.get("COMFY_LANES", "")
    lanes = {"default": COMFY_HTTP_DEFAULT}
    for part in raw.split(','):
        part = part.strip()
        if not part or '=' not in part:
            continue
        name, url = part.split('=', 1)
        name = re.sub(r"[^a-z0-9_-]", "", name.strip().lower())
        url = url.strip().rstrip('/')
        if name and url:
            lanes[name] = url
    return lanes


def parse_comfy_lane_rules():
    raw = os.environ.get("COMFY_LANE_RULES", "anima=anima,qwen35,qwen3.5")
    rules = []
    for spec in raw.split(';'):
        spec = spec.strip()
        if not spec or '=' not in spec:
            continue
        lane, terms = spec.split('=', 1)
        lane = re.sub(r"[^a-z0-9_-]", "", lane.strip().lower())
        needles = [t.strip().lower() for t in terms.split(',') if t.strip()]
        if lane and needles:
            rules.append((lane, needles))
    return rules


def parse_comfy_lane_tokens():
    """Per-lane auth tokens, e.g. COMFY_LANE_TOKENS="h3=abc123,krea=def".

    Sent as `Authorization: Bearer <token>` on every request the gateway makes
    to that lane (the rented-instance auth proxy in front of :8188 checks it).
    Kept out of COMFY_LANES so lane URLs never carry credentials into logs."""
    raw = os.environ.get("COMFY_LANE_TOKENS", "")
    tokens = {}
    for part in raw.split(','):
        part = part.strip()
        if not part or '=' not in part:
            continue
        name, value = part.split('=', 1)
        name = re.sub(r"[^a-z0-9_-]", "", name.strip().lower())
        value = value.strip()
        if name and value:
            tokens[name] = value
    return tokens


def parse_remote_comfy_lanes():
    """Lanes whose Comfy runs on a machine that is NOT this gateway host, e.g.
    COMFY_REMOTE_LANES="h3". Remote lanes get the requester-sealed fetch-back
    flow (outputs never resolve on local disk). An SSH-tunneled lane LOOKS like
    loopback, so remoteness must be declarable, not only inferred."""
    raw = os.environ.get("COMFY_REMOTE_LANES", "")
    return {re.sub(r"[^a-z0-9_-]", "", part.strip().lower()) for part in raw.split(',') if part.strip()}


COMFY_LANES = parse_comfy_lanes()
COMFY_LANE_RULES = parse_comfy_lane_rules()
COMFY_LANE_TOKENS = parse_comfy_lane_tokens()
COMFY_REMOTE_LANES = parse_remote_comfy_lanes()

# Rented machines attach and detach while this process runs. Their lanes used to
# arrive only through the launcher's env overlay, which meant every attach had to
# RESTART THE WHOLE STACK to take effect — killing in-flight generations to add a
# routing rule. The attachment registry is read live instead: gpu_rentals writes
# the file, the next request here picks it up. The env overlay is still written,
# but only so an attachment survives a restart, never to cause one.
RENTAL_LANES_FILE = MEDIA_STATE_ROOT / "rental-lanes.json"
_rental_lanes_lock = threading.Lock()
_rental_lanes_state = {"mtime": None, "lanes": {}}


def _read_rental_attachments():
    try:
        stamp = RENTAL_LANES_FILE.stat().st_mtime_ns
    except OSError:
        return {}
    with _rental_lanes_lock:
        if _rental_lanes_state["mtime"] == stamp:
            return _rental_lanes_state["lanes"]
        try:
            data = json.loads(RENTAL_LANES_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[comfy-lanes] rental attachment registry unreadable: {exc}", file=sys.stderr)
            return _rental_lanes_state["lanes"]
        lanes = {}
        # Highest priority first: lane rules are first-match, so this ordering
        # is what makes "run generations on THAT machine" work when two
        # attached machines serve the same models. gpu_rentals writes the file
        # in this order too; sorting here means a hand-edited or older
        # registry still routes deterministically.
        entries = sorted(
            ((k, e) for k, e in (data or {}).items() if isinstance(e, dict)),
            key=lambda item: -(item[1].get("priority") or 0),
        )
        for rental_id, entry in entries:
            if not isinstance(entry, dict):
                continue
            lane = re.sub(r"[^a-z0-9_-]", "", str(entry.get("lane") or "").strip().lower())
            port = entry.get("local_port")
            if not lane or not isinstance(port, int):
                continue
            lanes[lane] = {
                "url": f"http://127.0.0.1:{port}",
                "needles": [str(n).strip().lower() for n in entry.get("needles") or [] if str(n).strip()],
                # The registry key is the rental id the studio shows (e.g.
                # "vast:48352597") — what a per-tab "Run on" pin names.
                "rental_id": str(rental_id),
            }
        _rental_lanes_state.update(mtime=stamp, lanes=lanes)
        return lanes


def refresh_comfy_lanes():
    """Fold the live rental attachments into the lane maps, in place.

    In place so the ~15 module-level read sites (routing, the proxy, the queue
    sweepers) keep seeing one source of truth without threading a config object
    through all of them. Cheap: one stat() unless the registry actually changed.

    Scoped to the lanes this function itself added: it adds and retires rental
    entries and touches nothing else, so env-configured lanes (and anything a
    test or operator injects) survive a refresh untouched."""
    rentals = _read_rental_attachments()
    previous = set(_rental_lanes_state.get("applied") or ())
    current = set(rentals)

    for lane in previous - current:
        COMFY_LANES.pop(lane, None)
        COMFY_REMOTE_LANES.discard(lane)
    for lane, spec in rentals.items():
        COMFY_LANES[lane] = spec["url"]
        COMFY_REMOTE_LANES.add(lane)

    retired = previous - current
    if retired or current:
        kept = [rule for rule in COMFY_LANE_RULES if rule[0] not in previous | current]
        # Rental rules go FIRST, matching what the stack launcher does when it
        # builds COMFY_LANE_RULES at boot. Appending them instead made an
        # attach a no-op for any model a local lane also claims: routing is
        # first-match, so the local `ltx` lane kept every LTX generation on
        # this machine and the rented video box sat idle. That failed loudly
        # only because the local lane lacks the eros checkpoint; on a workload
        # both lanes can serve it would have silently ignored the rental the
        # user is paying for.
        rented = [(lane, spec["needles"]) for lane, spec in rentals.items() if spec["needles"]]
        COMFY_LANE_RULES[:] = rented + kept
    _rental_lanes_state["applied"] = current
    return COMFY_LANES
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def comfy_lane_is_remote(lane):
    """A lane is remote when declared in COMFY_REMOTE_LANES or when its URL
    points off-host. Remote means: output files do not exist on this gateway's
    disk, and results must be fetched back and sealed to the requester."""
    if lane in COMFY_REMOTE_LANES:
        return True
    base = COMFY_LANES.get(lane)
    if not base:
        return False
    host = (urlparse(base).hostname or "").lower()
    return bool(host) and host not in _LOOPBACK_HOSTS


def comfy_lane_token(lane):
    return COMFY_LANE_TOKENS.get(lane)


def comfy_lane_transport_error(lane):
    """The security contract for remote lanes: reachable only through an
    authenticated channel. Loopback URLs declared remote are SSH tunnels (the
    tunnel is the auth). Anything off-host needs a per-lane token for the
    instance's auth proxy. Returns an error string, or None when acceptable."""
    if not comfy_lane_is_remote(lane):
        return None
    base = COMFY_LANES.get(lane) or ""
    host = (urlparse(base).hostname or "").lower()
    if host in _LOOPBACK_HOSTS:
        return None  # declared-remote loopback = SSH tunnel; the tunnel authenticates
    if comfy_lane_token(lane):
        return None
    return (
        f"remote Comfy lane '{lane}' has no authenticated transport: front :8188 with the "
        f"per-instance token proxy and set COMFY_LANE_TOKENS={lane}=<token>, or reach it "
        f"over an SSH tunnel and declare it in COMFY_REMOTE_LANES"
    )


def comfy_lane_liveness_error(lane, timeout=4.0):
    """Is the lane ANSWERING, right now, before we commit work to it?

    comfy_lane_transport_error() above settles whether the lane is allowed to be
    reached; it cannot tell whether anything is still there. A tunnelled lane
    always passes it - "the tunnel is the auth" - so a rental that has been
    destroyed, preempted, or has simply lost its tunnel still reads as healthy.
    Submits then went ahead and staged references into a dead socket: uploads
    hung, ComfyUI logged a lost connection for a client that had gone away, and
    two minutes later the caller reported a timeout for a machine that no longer
    existed (2026-08-11, rental 47471037 - destroyed mid-session while the lane
    stayed attached, and every attempt hung instead of saying so).

    One cheap probe before staging turns that into an immediate, true sentence.
    """
    if not comfy_lane_is_remote(lane):
        return None
    try:
        with urlopen(comfy_lane_request(lane, "/system_stats"), timeout=timeout) as response:
            if response.status < 400:
                return None
            detail = f"answered HTTP {response.status}"
    except Exception as exc:
        detail = f"{exc.__class__.__name__}: {exc}"
    return (
        f"the machine behind lane '{lane}' is not answering ({detail}). Its tunnel has "
        f"dropped or the instance is gone - re-attach it in Machines, and detach it if the "
        f"rental has ended."
    )


# ---- Lane launch flags ------------------------------------------------------
#
# The MiniMax H3 motion-reference budget (workflow-registry.json,
# motion_reference_budget.max_packed_rows) was measured on a lane launched with
# `--vram-headroom 12`. Comfy's planner is blind to every reference row —
# comfy/model_base.py's MiniMaxH3 sets no memory_usage_factor_conds — so WITHOUT
# the flag the loader keeps the whole int8 DiT resident and the same card holds
# roughly half the rows: a 142,366-row job that samples with the flag died in
# block 0's qkv_proj without it (2026-08-21, job 34a722c2, 26.47GiB + 6.21GiB on
# a 31.36GiB 5090). The rental provisioning passes the flag, but a lane attached
# by hand, or whose ComfyUI was relaunched on the box, may not carry it, and the
# budget must not be granted on a promise. ComfyUI publishes its own argv on
# /system_stats (`system.argv`), so the lane itself is the source of truth: the
# MCP guard asks POST /api/lanes/resolve below before pricing a reference job
# and holds a lane without the flag to the registry's smaller ceiling.
_LANE_LAUNCH_ARGS_TTL_S = 60.0
_lane_launch_args_cache = {}
_lane_launch_args_lock = threading.Lock()


def vram_headroom_gb_from_argv(argv):
    """`--vram-headroom N` (or `--vram-headroom=N`) from a ComfyUI argv, in GB.

    0.0 when the flag is absent — ComfyUI's own default — and None when argv is
    not a list. The two must stay distinct: "launched without" is a fact that
    shrinks the budget, "unknown" is not. The last occurrence wins, as argparse
    would have it."""
    if not isinstance(argv, (list, tuple)):
        return None
    items = [str(item) for item in argv]
    value = 0.0
    for index, item in enumerate(items):
        raw = None
        if item == "--vram-headroom" and index + 1 < len(items):
            raw = items[index + 1]
        elif item.startswith("--vram-headroom="):
            raw = item.split("=", 1)[1]
        if raw is None:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
    return max(0.0, value)


def _comfy_lane_system_probe(lane, timeout=4.0):
    """One cached read of a lane's /system_stats: (argv, vram_total_gb).

    Cached per lane for a minute: a lane's flags and its card change only when
    its ComfyUI is relaunched or the lane is re-attached, and a reference job
    asks twice (pre-flight, then the check on the staged files). Raises when the
    lane does not answer or does not publish its argv — the caller decides what
    an unknown is worth. vram_total_gb is the first device's total VRAM in GiB
    (None when the lane publishes no device)."""
    base = COMFY_LANES.get(lane, COMFY_HTTP_DEFAULT).rstrip('/')
    now = time.monotonic()
    with _lane_launch_args_lock:
        cached = _lane_launch_args_cache.get(lane)
        if cached and cached[0] == base and cached[1] > now:
            return list(cached[2]), (cached[3] if len(cached) > 3 else None)
    with urlopen(comfy_lane_request(lane, "/system_stats"), timeout=timeout) as response:
        if response.status >= 400:
            raise RuntimeError(f"answered HTTP {response.status}")
        payload = json.loads(response.read().decode("utf-8"))
    payload = payload if isinstance(payload, dict) else {}
    argv = (payload.get("system") or {}).get("argv")
    if not isinstance(argv, list):
        raise RuntimeError("/system_stats carries no system.argv")
    argv = [str(item) for item in argv]
    vram_total_gb = None
    devices = payload.get("devices")
    if isinstance(devices, list) and devices and isinstance(devices[0], dict):
        try:
            total = float(devices[0].get("vram_total"))
        except (TypeError, ValueError):
            total = 0.0
        if total > 0:
            vram_total_gb = round(total / (1024 ** 3), 2)
    with _lane_launch_args_lock:
        _lane_launch_args_cache[lane] = (base, now + _LANE_LAUNCH_ARGS_TTL_S, list(argv), vram_total_gb)
    return argv, vram_total_gb


def comfy_lane_launch_args(lane, timeout=4.0):
    """The argv ComfyUI on `lane` was launched with, read from its /system_stats."""
    return _comfy_lane_system_probe(lane, timeout=timeout)[0]


def comfy_lane_vram_headroom(lane, timeout=4.0):
    """What the lane's ComfyUI was launched with, and on what card, in the terms
    the motion-reference budget needs.

    Returns {"lane", "remote", "vram_headroom_gb", "vram_total_gb", "probed",
    "error"}: vram_headroom_gb is the flag's value (0.0 = launched without it)
    once probed, vram_total_gb the lane's card in GiB (None when it publishes
    no device), and both None with an error string when the lane could not be
    asked. Never raises — a lane that will not answer is the liveness probe's
    problem to name at submit, not this one's."""
    record = {
        "lane": lane,
        "remote": comfy_lane_is_remote(lane),
        "vram_headroom_gb": None,
        "vram_total_gb": None,
        "row_observations": None,
        "probed": False,
        "error": None,
    }
    try:
        argv, vram_total_gb = _comfy_lane_system_probe(lane, timeout=timeout)
    except Exception as exc:
        record["error"] = f"{exc.__class__.__name__}: {exc}"
        return record
    record["vram_headroom_gb"] = vram_headroom_gb_from_argv(argv)
    record["vram_total_gb"] = vram_total_gb
    # What this card size has actually done, so the guard can bound a predicted
    # budget by observed reality in both directions.
    record["row_observations"] = row_observations_for(vram_total_gb)
    record["probed"] = True
    return record


def comfy_lane_request(lane, path, data=None, method=None, headers=None, content_type=None):
    """Build a urllib Request to a lane, attaching the lane's auth token."""
    base = COMFY_LANES.get(lane, COMFY_HTTP_DEFAULT).rstrip('/')
    all_headers = dict(headers or {})
    if content_type:
        all_headers['Content-Type'] = content_type
    token = comfy_lane_token(lane)
    if token:
        all_headers['Authorization'] = f"Bearer {token}"
    return Request(base + path, data=data, method=method, headers=all_headers)
EQUIPPED_FILE = GATEWAY_STATE_DIR / "equipped_models.json"
SELECTED_LORAS_FILE = GATEWAY_STATE_DIR / "selected_loras.json"
CIVITAI_TOKEN_FILE = Path(
    os.environ.get("CIVITAI_TOKEN_FILE", str(MEDIA_STATE_ROOT / "secure/civitai-token"))
).expanduser().resolve()
CIVITAI_TOKEN_ENV_KEYS = (
    'CIVITAI_TOKEN',
    'CIVITAI_API_TOKEN',
    'CIVITAI_API_KEY',
    'CIVITAI_KEY',
    'CIVITAI_ACCESS_TOKEN',
    'CIVITAI_BEARER_TOKEN',
    'CIVITAI_PAT',
)
CIVITAI_API = "https://civitai.com/api/v1"
DOWNLOAD_JOBS_FILE = GATEWAY_STATE_DIR / "download_jobs.json"
LAST_MOBILE_PROMPT_LORAS_FILE = GATEWAY_STATE_DIR / "last_mobile_prompt_loras.json"
CIVITAI_BASE_MODELS_CACHE = {'at': 0, 'items': None}
CIVITAI_BASE_MODELS_TTL = 6 * 60 * 60
# modelId -> {'at': ts, 'versions': [{'id', 'name', 'baseModel'}]} for update checks.
CIVITAI_MODEL_VERSIONS_CACHE = {}
CIVITAI_MODEL_VERSIONS_TTL = 6 * 60 * 60
CIVITAI_FALLBACK_BASE_MODELS = [
    'ZImageTurbo', 'Z-Image Turbo', 'Z Image',
    'SD 1.5', 'SD 1.4', 'SD 2.0', 'SD 2.1', 'SDXL 1.0', 'SDXL Turbo', 'SDXL Lightning',
    'Pony', 'Illustrious', 'NoobAI', 'Animagine XL', 'Playground v2', 'PixArt a', 'AuraFlow',
    'Flux.1 D', 'Flux.1 Dev', 'Flux.1 Schnell', 'Flux.1 Kontext', 'Flux',
    'Stable Cascade', 'Stable Diffusion 3', 'Stable Diffusion 3.5', 'Stable Diffusion 3.5 Large', 'Stable Diffusion 3.5 Medium',
    'HiDream', 'Lumina', 'HunyuanDiT', 'Kolors', 'Kwai-Kolors', 'Chroma', 'OmniGen',
    'Wan Video', 'Wan Video 1.3B t2v', 'Wan Video 14B t2v', 'Wan Video 14B i2v',
    'Hunyuan Video', 'LTXV', 'Mochi', 'CogVideoX', 'SVD', 'AnimateDiff', 'Allegro',
    'OpenSora', 'SkyReels', 'Qwen-Image', 'Qwen-Image-Edit', 'Hidream-I1',
]
LORA_STRENGTH_MIN = -100000.0
LORA_STRENGTH_MAX = 100000.0
OUTPUT_MEDIA_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm", ".m4v", ".mkv"}
OUTPUT_ENCRYPTION_ENABLED = os.environ.get("ZIMG_OUTPUT_ENCRYPTION", "1") != "0"
OUTPUT_ENCRYPTION_SERVICE = os.environ.get("ZIMG_OUTPUT_KEYCHAIN_SERVICE", "zimage-output-encryption")
OUTPUT_ENCRYPTION_ITER = int(os.environ.get("ZIMG_OUTPUT_ENCRYPTION_ITER", "50000"))
OUTPUT_PLAINTEXT_GRACE_SECONDS = int(os.environ.get("ZIMG_OUTPUT_PLAINTEXT_GRACE", "0"))
OUTPUT_ENCRYPTION_SUFFIX = ".zenc"
# Phase-2 client-side E2E media (off by default; coexists with legacy .zenc).
# When on AND the owner has created a vault (public key present), new output is
# sealed to that public key so the gateway can encrypt but never decrypt — only
# the browser holding the passphrase-derived private key can. See media_seal.py.
E2E_MEDIA_ENABLED = os.environ.get("ZIMG_E2E_MEDIA", "0") == "1"
E2E_MEDIA_SUFFIX = ".e2e"
VAULT_DB = Path(os.environ.get(
    "ZIMG_VAULT_DB",
    str(Path(os.environ.get("CONTENT_STUDIO_DATA_DIR", str(Path(__file__).resolve().parents[2] / "data"))) / "owner-vault.sqlite3"),
)).expanduser()
PRIVATE_INPUT_PREFIXES = (
    "media-studio-inline-",
    "media-studio-input-",
    "media-studio-reference-",
    "mcp_inline_",
    "mcp_ingredients_",
    "mcp_ltx_",
    "mcp_video_",
)
PRIVATE_INPUT_MAX_AGE_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_MAX_AGE", "7200"))
# Uploads that arrive through the generic ComfyUI upload route keep the caller's
# own filename, so they match none of the staging prefixes above and used to sit
# in the input directory as plaintext forever. The local generator has to read
# these pixels, so they cannot be sealed to the owner vault the way outputs are —
# bounded retention is what keeps the exposure window short. Durable references
# live sealed in the owner reference store (data/uploads), never here.
PRIVATE_INPUT_UPLOAD_MAX_AGE_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_UPLOAD_MAX_AGE", "86400"))
jobs = {}
jobs_lock = threading.Lock()
# Native/gateway generation bypasses ComfyUI's own executor, so it needs the
# same queue contract here: one worker at a time in an app-tab lane, with image
# and video kept as independent media domains. Different tabs retain distinct
# lanes and may overlap. Klein adds duplicate coalescing and a memory admission
# check on top of this shared scheduler.
studio_generation_lanes = {}
studio_generation_lanes_lock = threading.Lock()
klein_inflight_jobs = {}
klein_memory_condition = threading.Condition()
klein_reserved_memory_bytes = 0
# Live subprocess handles for native (MLX) generation jobs, so a cancel request
# can terminate the render instead of letting it burn the GPU to completion.
native_job_procs = {}
download_jobs = {}
download_jobs_lock = threading.Lock()
encryption_lock = threading.Lock()
active_output_paths = set()
active_output_paths_lock = threading.Lock()
_output_encryption_password = None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def redact_access_log_message(value):
    return re.sub(
        r"(?i)([?&](?:token|access_token|api_key|key)=)[^&\s\"]*",
        lambda match: match.group(1) + "%5Bredacted%5D",
        str(value),
    )


def delete_private_input(name):
    raw = str(name or "").strip()
    if not raw or Path(raw).name != raw or not raw.startswith(PRIVATE_INPUT_PREFIXES):
        raise ValueError("invalid private input filename")
    root = COMFY_INPUT_DIR.expanduser().resolve()
    candidate = (root / raw).resolve()
    if not _is_under(candidate, root):
        raise ValueError("private input path escaped the input directory")
    if not candidate.exists():
        return False
    if not candidate.is_file():
        raise ValueError("private input is not a file")
    candidate.unlink()
    return True


def cleanup_staged_private_inputs_once(
    max_age_seconds=PRIVATE_INPUT_MAX_AGE_SECONDS,
    upload_max_age_seconds=None,
):
    """Expire plaintext inputs. Pipeline staging (the known prefixes) is short
    lived; anything else — user-named uploads, keyframes, nested reference
    folders — expires on the longer upload budget instead of living forever."""
    upload_age = (
        PRIVATE_INPUT_UPLOAD_MAX_AGE_SECONDS if upload_max_age_seconds is None else upload_max_age_seconds
    )
    root = COMFY_INPUT_DIR.expanduser().resolve()
    if not root.exists():
        return 0
    now = time.time()
    deleted = 0
    for candidate in root.rglob("*"):
        if not candidate.is_file():
            continue
        # Already-sealed envelopes are client-only; nothing to expire for privacy.
        if candidate.suffix in (OUTPUT_ENCRYPTION_SUFFIX, E2E_MEDIA_SUFFIX):
            continue
        limit = max_age_seconds if candidate.name.startswith(PRIVATE_INPUT_PREFIXES) else upload_age
        try:
            if now - candidate.stat().st_mtime < limit:
                continue
            candidate.unlink()
            deleted += 1
        except OSError:
            continue
    return deleted


def private_input_sweeper():
    while True:
        cleanup_staged_private_inputs_once()
        time.sleep(300)


def _is_under(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def output_encryption_password(create=True):
    """Return the output encryption secret from macOS Keychain.

    The secret is intentionally not stored in project files or logs. This is
    encryption-at-rest against filesystem browsing/copying; the running wrapper
    process can still decrypt in order to serve authenticated app requests.
    """
    global _output_encryption_password
    if _output_encryption_password:
        return _output_encryption_password
    if not OUTPUT_ENCRYPTION_ENABLED:
        return None
    account = os.environ.get("USER") or "liam"
    try:
        proc = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", OUTPUT_ENCRYPTION_SERVICE, "-a", account, "-w"],
            text=True,
            capture_output=True,
            timeout=10,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            _output_encryption_password = proc.stdout.strip()
            return _output_encryption_password
    except Exception:
        pass
    if not create:
        return None
    secret = base64.urlsafe_b64encode(os.urandom(48)).decode("ascii")
    proc = subprocess.run(
        ["/usr/bin/security", "add-generic-password", "-U", "-s", OUTPUT_ENCRYPTION_SERVICE, "-a", account, "-w", secret],
        text=True,
        capture_output=True,
        timeout=10,
    )
    if proc.returncode != 0:
        raise RuntimeError("could not create output encryption key in macOS Keychain")
    _output_encryption_password = secret
    return secret


def encrypted_path_for(path):
    path = Path(path)
    return path.with_name(path.name + OUTPUT_ENCRYPTION_SUFFIX)


def logical_path_for_encrypted(path):
    path = Path(path)
    if path.name.endswith(OUTPUT_ENCRYPTION_SUFFIX):
        return path.with_name(path.name[:-len(OUTPUT_ENCRYPTION_SUFFIX)])
    if path.name.endswith(E2E_MEDIA_SUFFIX):
        return path.with_name(path.name[:-len(E2E_MEDIA_SUFFIX)])
    return path


def mark_output_active(path):
    with active_output_paths_lock:
        active_output_paths.add(str(Path(path).resolve()))


def mark_output_inactive(path):
    with active_output_paths_lock:
        active_output_paths.discard(str(Path(path).resolve()))


def output_path_is_active(path):
    with active_output_paths_lock:
        return str(Path(path).resolve()) in active_output_paths


def is_encryptable_output(path):
    path = Path(path)
    if not OUTPUT_ENCRYPTION_ENABLED:
        return False
    if output_path_is_active(path):
        return False
    if path.name.endswith(OUTPUT_ENCRYPTION_SUFFIX) or path.name.endswith(E2E_MEDIA_SUFFIX):
        return False
    if path.suffix.lower() not in OUTPUT_MEDIA_EXTS:
        return False
    if _is_under(path, DEBUG_OUTPUT_DIR):
        return False
    return _is_under(path, OUT_DIR) or _is_under(path, COMFY_OUTPUT_DIR)


_vault_public_key_cache = {"mtime": None, "spki": None}


def e2e_envelope_path_for(path):
    path = Path(path)
    return path.with_name(path.name + E2E_MEDIA_SUFFIX)


def existing_output_path(logical):
    """The physical file for a logical output: plaintext, legacy .zenc, or E2E
    .e2e envelope. Returns None if none exists. Used so history/gallery listing
    finds E2E outputs (whose only on-disk form is the .e2e envelope)."""
    logical = Path(logical)
    for candidate in (logical, encrypted_path_for(logical), e2e_envelope_path_for(logical)):
        try:
            if candidate.exists():
                return candidate
        except OSError:
            continue
    return None


# --- Agent dual-recipient sealing -------------------------------------------
#
# An agent driving the gateway generates the pixels but cannot read them back:
# every output is sealed to the OWNER's vault key and the plaintext is deleted,
# by design. The old workaround was to run a second gateway with
# ZIMG_OUTPUT_ENCRYPTION=0 writing plaintext into a scratch directory — an
# unaudited hole, and the results never reached the owner's studio at all.
#
# Instead, seal the same output twice. The owner's envelope is byte-for-byte
# what it has always been (same helper, same key, same <name>.e2e path), so the
# frontend, history and sweeper are untouched. A second envelope is sealed to
# the requesting agent's PUBLIC key at <name>.agent-<fp>.e2e; the agent holds
# the matching private key and decrypts it itself. No plaintext is written, no
# key is shared, and revoking the agent key ends its access to anything new.
#
# Off unless ZIMG_AGENT_DUAL_SEAL=1. The recipient is per-job: only jobs whose
# submit presented X-E2E-Requester-Pub get a second envelope, so the owner's own
# studio generations stay owner-only.
AGENT_DUAL_SEAL_ENABLED = os.environ.get("ZIMG_AGENT_DUAL_SEAL", "0") == "1"
AGENT_ENVELOPE_PREFIX = ".agent-"
AGENT_SEAL_JOBS_MAX = 256
_agent_seal_jobs = {}
_agent_seal_lock = threading.Lock()


def agent_envelope_path_for(path, fingerprint):
    """<name>.agent-<fp>.e2e — one envelope per recipient, alongside the owner's."""
    path = Path(path)
    return path.with_name(f"{path.name}{AGENT_ENVELOPE_PREFIX}{fingerprint}{E2E_MEDIA_SUFFIX}")


def register_agent_seal_recipient(job_id, spki):
    """Remember that this job's outputs also seal to `spki` (a public SPKI).

    Public material only — safe to hold in memory. Bounded so a long-running
    gateway cannot grow this map without limit."""
    if not AGENT_DUAL_SEAL_ENABLED:
        return None
    job_id = str(job_id or "")
    spki = normalized_requester_spki(spki)
    if not job_id or not spki:
        return None
    with _agent_seal_lock:
        while len(_agent_seal_jobs) >= AGENT_SEAL_JOBS_MAX:
            _agent_seal_jobs.pop(next(iter(_agent_seal_jobs)))
        _agent_seal_jobs[job_id] = spki
    return spki


def agent_seal_recipient_for(job_id):
    if not AGENT_DUAL_SEAL_ENABLED or not job_id:
        return None
    with _agent_seal_lock:
        return _agent_seal_jobs.get(str(job_id))


# The gateway runs under the system python3 (no `cryptography`). Reading the
# public key needs only sqlite, but sealing (RSA-OAEP + AES-GCM) shells out to a
# python that has `cryptography` — the repo venv by default.
E2E_SEAL_PYTHON = os.environ.get("ZIMG_E2E_PYTHON", str(Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python"))
E2E_SEAL_HELPER = str(Path(__file__).resolve().parent / "media_seal.py")


def vault_public_key_spki():
    """The owner vault public key (base64url spki), or None until the browser
    has created a vault. Read directly from sqlite; cached against the DB mtime."""
    try:
        mtime = VAULT_DB.stat().st_mtime_ns if VAULT_DB.is_file() else None
    except OSError:
        return None
    if mtime == _vault_public_key_cache["mtime"]:
        return _vault_public_key_cache["spki"]
    spki = None
    if mtime is not None:
        try:
            connection = sqlite3.connect(VAULT_DB, timeout=10)
            try:
                row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
            finally:
                connection.close()
            if row:
                spki = json.loads(row[0]).get("public_key")
        except Exception as exc:
            print(f"[e2e-media] could not read vault public key: {exc}", file=sys.stderr)
    _vault_public_key_cache.update(mtime=mtime, spki=spki)
    return spki


def vault_identity_json():
    """The owner vault identity as stored — salt, wrapped keys, public key.
    Everything in it is public-or-wrapped material (vault_store rejects bare
    secrets), useless without the owner passphrase or recovery key. Served to
    token-authed clients (the mobile canvas) so they can unlock in-browser."""
    if not VAULT_DB.is_file():
        return None
    try:
        connection = sqlite3.connect(VAULT_DB, timeout=10)
        try:
            row = connection.execute("SELECT identity_json FROM vault_identity WHERE id = 1").fetchone()
        finally:
            connection.close()
        return json.loads(row[0]) if row else None
    except Exception as exc:
        print(f"[e2e-media] could not read vault identity: {exc}", file=sys.stderr)
        return None


def _seal_file_with_helper(spki, source, envelope, media_name):
    """Seal `source` to the public key `spki`, atomically writing the enc:v1
    envelope JSON to `envelope`. `media_name` drives the recorded media_type.
    The caller owns locking and deletion of the plaintext source."""
    source = Path(source)
    envelope = Path(envelope)
    tmp = envelope.with_name(envelope.name + f".{os.getpid()}.tmp")
    pub_tmp = envelope.with_name(envelope.name + f".{os.getpid()}.pub")
    try:
        pub_tmp.write_text(spki, encoding="utf-8")
        proc = subprocess.run(
            [E2E_SEAL_PYTHON, E2E_SEAL_HELPER, "--pub", f"@{pub_tmp}", "--in", str(source), "--out", str(tmp)],
            capture_output=True, text=True, timeout=300,
        )
        if proc.returncode != 0 or not tmp.exists():
            raise RuntimeError(f"seal helper exited {proc.returncode}: {proc.stderr.strip()[:200]}")
        sealed = json.loads(tmp.read_text(encoding="utf-8"))
        sealed["v"] = 1
        sealed["media_type"] = mimetypes.guess_type(media_name)[0] or "application/octet-stream"
        tmp.write_text(json.dumps(sealed), encoding="utf-8")
        os.replace(tmp, envelope)
    finally:
        for leftover in (pub_tmp, tmp):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass


def seal_output_to_e2e(path, agent_spki=None):
    """Seal media to the owner vault public key as <name>.e2e; delete plaintext.

    When `agent_spki` is given, the SAME plaintext is additionally sealed to
    that public key as <name>.agent-<fp>.e2e before the plaintext is removed.
    The owner's envelope is unaffected either way. A failure to seal the agent
    copy is logged and swallowed: the owner's copy must never be lost because a
    secondary recipient failed.

    Returns True when sealed, False to fall back to legacy encryption (e.g. no
    vault exists yet). The gateway can encrypt here but can never decrypt.
    """
    path = Path(path).resolve()
    spki = vault_public_key_spki()
    if not spki:
        return False
    envelope = e2e_envelope_path_for(path)
    if envelope.exists() and not path.exists():
        return True
    if not path.exists() or not path.is_file():
        return False
    with encryption_lock:
        if envelope.exists() and not path.exists():
            return True
        source_stat = path.stat()
        _seal_file_with_helper(spki, path, envelope, path.name)
        os.utime(envelope, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        agent_spki = normalized_requester_spki(agent_spki)
        if agent_spki and agent_spki != spki:
            agent_envelope = agent_envelope_path_for(path, requester_fingerprint(agent_spki))
            try:
                _seal_file_with_helper(agent_spki, path, agent_envelope, path.name)
                os.utime(agent_envelope, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
            except Exception as exc:
                print(f"[agent-seal] second recipient failed for {path.name}: {exc}", file=sys.stderr)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return True


def encrypt_output_file(path, agent_spki=None):
    """Encrypt output media in place as <name>.zenc and remove plaintext.

    `agent_spki` (optional) adds a second sealed envelope for that recipient on
    the E2E path only — the legacy .zenc path is single-key by construction.

    Returns the logical original path (the filename the UI should keep using).
    """
    path = Path(path).resolve()
    if not is_encryptable_output(path):
        return path
    # Prefer client-side E2E sealing when enabled and a vault exists; otherwise
    # fall through to the legacy Keychain-key .zenc path unchanged.
    if E2E_MEDIA_ENABLED or e2e_envelope_path_for(path).exists():
        try:
            if seal_output_to_e2e(path, agent_spki=agent_spki):
                return path
        except Exception as exc:
            print(f"[e2e-media] seal failed for {path.name}; falling back: {exc}", file=sys.stderr)
    enc = encrypted_path_for(path)
    if enc.exists() and not path.exists():
        return path
    if not path.exists() or not path.is_file():
        return path
    password = output_encryption_password(create=True)
    tmp = enc.with_name(enc.name + f".{os.getpid()}.tmp")
    with encryption_lock:
        if enc.exists() and not path.exists():
            return path
        source_stat = path.stat()
        proc = subprocess.run(
            [
                "/usr/bin/openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-iter", str(OUTPUT_ENCRYPTION_ITER),
                "-salt", "-in", str(path), "-out", str(tmp), "-pass", "stdin",
            ],
            input=password + "\n",
            text=True,
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 32:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
            raise RuntimeError(f"failed to encrypt output media {path.name}")
        os.replace(tmp, enc)
        os.utime(enc, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return path


def decrypt_output_bytes(path):
    """Read plaintext image bytes from a plaintext path or encrypted sidecar."""
    path = Path(path).resolve()
    if path.exists() and path.is_file():
        return path.read_bytes(), mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    enc = encrypted_path_for(path)
    if not enc.exists() or not enc.is_file():
        raise FileNotFoundError(str(path))
    password = output_encryption_password(create=False)
    if not password:
        raise RuntimeError("output encryption key unavailable")
    proc = subprocess.run(
        [
            "/usr/bin/openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", str(OUTPUT_ENCRYPTION_ITER),
            "-in", str(enc), "-pass", "stdin",
        ],
        input=(password + "\n").encode("utf-8"),
        text=False,
        capture_output=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError("failed to decrypt output image")
    return proc.stdout, mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def encrypt_outputs(paths, job_id=None):
    """Seal every output of a finished job.

    `job_id` is what ties an output back to the agent that asked for it: when
    that job registered a requester key at submit, each output gets a second
    envelope sealed to it. Without a job id (or without a registered key) this
    behaves exactly as before — owner-only."""
    agent_spki = agent_seal_recipient_for(job_id)
    out = []
    for p in paths or []:
        path = Path(p).expanduser().resolve()
        try:
            out.append(str(encrypt_output_file(path, agent_spki=agent_spki).resolve()))
        except Exception as e:
            if is_encryptable_output(path):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise RuntimeError(f"output encryption failed for {path.name}") from e
    return out


def find_output_logical_path(name):
    name = safe_name(name)
    if not name:
        return None
    for root in [OUT_DIR, COMFY_OUTPUT_DIR, DEBUG_OUTPUT_DIR]:
        root = root.resolve()
        candidates = [root / name, root / f"{name}{OUTPUT_ENCRYPTION_SUFFIX}", root / f"{name}{E2E_MEDIA_SUFFIX}"]
        for candidate in candidates:
            logical = logical_path_for_encrypted(candidate).resolve()
            existing = candidate.resolve()
            if str(logical).startswith(str(root)) and (
                existing.exists() or encrypted_path_for(logical).exists() or e2e_envelope_path_for(logical).exists()
            ):
                return logical
        try:
            matches = []
            for x in root.rglob("*"):
                if not x.is_file():
                    continue
                logical = logical_path_for_encrypted(x).resolve()
                if logical.name == name:
                    matches.append(logical)
            if matches:
                return matches[0]
        except Exception:
            continue
    return None


def find_exact_output_logical_path(value):
    try:
        logical = logical_path_for_encrypted(Path(value).expanduser()).resolve()
    except Exception:
        return None
    if logical.suffix.lower() not in OUTPUT_MEDIA_EXTS:
        return None
    if not any(_is_under(logical, root) for root in [OUT_DIR, COMFY_OUTPUT_DIR]):
        return None
    # plaintext, legacy .zenc, or E2E .e2e — an E2E-only output must still
    # resolve or its history thumbnail 404s.
    if existing_output_path(logical):
        return logical
    return None


def send_output_file(handler, path):
    path = encrypt_output_file(path)
    envelope = e2e_envelope_path_for(Path(path))
    # Same URL, recipient chosen by the key the caller presents: an agent that
    # sends its own X-E2E-Requester-Pub gets the envelope sealed to that key.
    # Serving it leaks nothing — only the matching private key opens it — and
    # the owner's browser, which presents no such header, is unaffected.
    agent_spki = normalized_requester_spki(handler.headers.get(REQUESTER_PUB_HEADER))
    if AGENT_DUAL_SEAL_ENABLED and agent_spki:
        agent_envelope = agent_envelope_path_for(Path(path), requester_fingerprint(agent_spki))
        if agent_envelope.is_file():
            envelope = agent_envelope
    if envelope.is_file():
        # Client-side E2E: the gateway holds no key for this file. Hand the
        # sealed envelope to the browser, which decrypts it with the vault
        # private key. A legacy client that ignores X-E2E-Media simply can't
        # render it — by design, only the owner's browser can.
        data = envelope.read_bytes()
        handler.send_response(200)
        handler.cors_headers()
        handler.send_header("Content-Type", "application/vnd.hivemind.e2e+json")
        handler.send_header("X-E2E-Media", "1")
        handler.send_header("Cache-Control", "private, no-store, max-age=0")
        handler.send_header("Pragma", "no-cache")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
        return
    data, ctype = decrypt_output_bytes(path)
    handler.send_response(200)
    handler.cors_headers()
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "private, no-store, max-age=0")
    handler.send_header("Pragma", "no-cache")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def encrypt_existing_outputs_once(max_age_seconds=3):
    if not OUTPUT_ENCRYPTION_ENABLED:
        return 0
    now = time.time()
    changed = 0
    for root in [OUT_DIR, COMFY_OUTPUT_DIR]:
        try:
            if not root.exists():
                continue
            for p in root.rglob("*"):
                if not p.is_file() or not is_encryptable_output(p):
                    continue
                try:
                    # Avoid racing a writer that is still flushing the file.
                    if now - p.stat().st_mtime < max_age_seconds:
                        continue
                    encrypt_output_file(p)
                    changed += 1
                except Exception as e:
                    print(f"[output-encryption] sweeper skipped {p.name}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[output-encryption] sweeper failed for {root}: {e}", file=sys.stderr)
    return changed


def output_encryption_sweeper():
    while True:
        try:
            encrypt_existing_outputs_once(max_age_seconds=OUTPUT_PLAINTEXT_GRACE_SECONDS)
        except Exception as e:
            print(f"[output-encryption] sweeper error: {e}", file=sys.stderr)
        time.sleep(5)


# --- Persistent output -> encrypted-workflow-envelope index -------------------
#
# ComfyUI runs with --disable-metadata, so output files never contain their
# workflow; "load workflow from image" historically depended on ComfyUI's
# in-memory history, which dies on every restart. This index harvests the
# encrypted workflow envelope + output filenames from each lane's history
# while it is alive and persists the mapping, so workflow recovery survives
# restarts and output encryption. Only encrypted envelopes are stored - the
# same client-side key model as everywhere else; no plaintext workflows.
WORKFLOW_INDEX_FILE = Path.home() / ".comfy-private.noindex" / "output-workflow-index.jsonl"
workflow_index_lock = threading.Lock()
_workflow_index = {}
_workflow_index_records = {}
_workflow_index_prompts = set()


def _is_encrypted_workflow_envelope(value):
    return (
        isinstance(value, dict)
        and value.get("encrypted") is True
        and value.get("format") == "comfyui-mobile-encrypted-workflow"
    )


def _envelope_records_from_history(hist, seen_prompt_ids=None):
    """Extract {prompt_id, filenames, workflow} records from a Comfy /history payload."""
    seen = seen_prompt_ids if seen_prompt_ids is not None else set()
    records = []
    for pid, item in (hist or {}).items():
        if not isinstance(item, dict) or pid in seen:
            continue
        prompt = item.get("prompt")
        extra = prompt[3] if isinstance(prompt, (list, tuple)) and len(prompt) > 3 else None
        workflow = (((extra or {}).get("extra_pnginfo") or {}).get("workflow")) if isinstance(extra, dict) else None
        if not _is_encrypted_workflow_envelope(workflow):
            continue
        filenames = []
        for out in (item.get("outputs") or {}).values():
            if not isinstance(out, dict):
                continue
            for key in ("images", "gifs", "videos"):
                for media in out.get(key) or []:
                    name = media.get("filename") if isinstance(media, dict) else None
                    if isinstance(name, str) and name:
                        filenames.append(name)
        if filenames:
            records.append({"prompt_id": pid, "filenames": filenames, "workflow": workflow})
    return records


def _load_workflow_index():
    try:
        if not WORKFLOW_INDEX_FILE.exists():
            return
        with WORKFLOW_INDEX_FILE.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                workflow = rec.get("workflow")
                if not _is_loadable_workflow_envelope(workflow):
                    continue
                for name in rec.get("filenames") or []:
                    if isinstance(name, str) and name:
                        _workflow_index[name] = workflow
                        _workflow_index_records[name] = {
                            "prompt_id": rec.get("prompt_id"),
                            "lane": rec.get("lane"),
                            "recorded_at": rec.get("recorded_at"),
                        }
                pid = rec.get("prompt_id")
                if pid:
                    _workflow_index_prompts.add(pid)
    except Exception as e:
        print(f"[workflow-index] load failed: {e}", file=sys.stderr)


def _harvest_comfy_workflow_envelopes():
    added = 0
    for lane, base in COMFY_LANES.items():
        try:
            with urlopen(comfy_lane_request(lane, "/history?max_items=128"), timeout=10) as r:
                hist = json.load(r)
        except Exception:
            continue
        with workflow_index_lock:
            seen = set(_workflow_index_prompts)
        for rec in _envelope_records_from_history(hist, seen):
            rec["lane"] = lane
            rec["recorded_at"] = datetime.now(timezone.utc).isoformat()
            with workflow_index_lock:
                if rec["prompt_id"] in _workflow_index_prompts:
                    continue
                _workflow_index_prompts.add(rec["prompt_id"])
                for name in rec["filenames"]:
                    _workflow_index[name] = rec["workflow"]
                    _workflow_index_records[name] = {
                        "prompt_id": rec.get("prompt_id"),
                        "lane": rec.get("lane"),
                        "recorded_at": rec.get("recorded_at"),
                    }
                try:
                    WORKFLOW_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
                    with WORKFLOW_INDEX_FILE.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                except Exception as e:
                    print(f"[workflow-index] append failed: {e}", file=sys.stderr)
            added += 1
    return added


def workflow_index_sweeper():
    _load_workflow_index()
    while True:
        try:
            _harvest_comfy_workflow_envelopes()
        except Exception as e:
            print(f"[workflow-index] sweeper error: {e}", file=sys.stderr)
        time.sleep(15)


def workflow_envelope_for_filename(name):
    with workflow_index_lock:
        return _workflow_index.get(name)


def workflow_index_record_for_filename(name):
    with workflow_index_lock:
        rec = _workflow_index_records.get(name)
        return dict(rec) if isinstance(rec, dict) else None


# --- Remote Comfy lanes: prompt routing, requester-sealed fetch-back, scrub ---
#
# A remote lane (a rented GPU box) is a dumb executor: the prompt goes out over
# the lane's authenticated transport, a server-side watcher polls that SAME
# lane for completion, output bytes come back over the lane's /view and are
# sealed to the REQUESTING client's public key before anything persists, and
# the box is then scrubbed (output + staged input files deleted, prompt dropped
# from its history). Possession of the decrypt key - not machine locality - is
# what grants access to results: nothing colocated with the gateway can read
# another requester's outputs, because no plaintext (and no gateway-decryptable
# form) of a remote result ever lands in a shared directory.
#
# Known limit (documented, not fixable here): while the job RUNS, prompt and
# pixels exist in plaintext on the rented instance. The contract covers
# everything before submit and after harvest - see packages/gpu-rentals/README.md.
COMFY_PROMPT_ROUTES_FILE = GATEWAY_STATE_DIR / "comfy-prompt-routes.json"
COMFY_PROMPT_ROUTES_MAX = 512
REQUESTER_PUB_HEADER = "X-E2E-Requester-Pub"
comfy_prompt_routes_lock = threading.Lock()
_comfy_prompt_routes = {}
_comfy_prompt_routes_loaded = False
# base64url DER SPKI; RSA-2048 keys encode to ~392 chars, leave generous room.
_SPKI_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]{100,4000}$")


def normalized_requester_spki(value):
    value = str(value or "").strip()
    return value if _SPKI_B64URL_RE.match(value) else None


def requester_fingerprint(spki):
    spki = normalized_requester_spki(spki)
    if not spki:
        return None
    return hashlib.sha256(spki.encode("ascii")).hexdigest()[:32]


def _ensure_comfy_prompt_routes_loaded():
    global _comfy_prompt_routes_loaded
    with comfy_prompt_routes_lock:
        if _comfy_prompt_routes_loaded:
            return
        _comfy_prompt_routes_loaded = True
        try:
            if COMFY_PROMPT_ROUTES_FILE.is_file():
                data = json.loads(COMFY_PROMPT_ROUTES_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _comfy_prompt_routes.update({str(k): v for k, v in data.items() if isinstance(v, dict)})
        except Exception as exc:
            print(f"[comfy-routes] load failed: {exc}", file=sys.stderr)


def _persist_comfy_prompt_routes_locked():
    try:
        while len(_comfy_prompt_routes) > COMFY_PROMPT_ROUTES_MAX:
            _comfy_prompt_routes.pop(next(iter(_comfy_prompt_routes)))
        COMFY_PROMPT_ROUTES_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = COMFY_PROMPT_ROUTES_FILE.with_name(f".{COMFY_PROMPT_ROUTES_FILE.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(_comfy_prompt_routes, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, COMFY_PROMPT_ROUTES_FILE)
    except Exception as exc:
        print(f"[comfy-routes] persist failed: {exc}", file=sys.stderr)


def record_comfy_prompt_route(prompt_id, lane, requester_spki=None, pushed_inputs=None, client_id=None):
    """Remember which lane runs a Comfy prompt and who may read it back.

    The requester key is public material (an RSA SPKI) - safe to persist; it is
    what remote outputs get sealed to and what history reads are scoped by.

    The submitter's client_id is kept too, because it is the ONLY handle a
    caller still holds when it never received the prompt id: staging a reference
    job's inputs on a remote lane happens inside this request, so a submit can
    outlive the caller's timeout, and the caller then abandons a job that is
    already queued and watched. comfy_prompt_id_for_client() sells it back."""
    prompt_id = str(prompt_id or "")
    if not prompt_id:
        return None
    _ensure_comfy_prompt_routes_loaded()
    spki = normalized_requester_spki(requester_spki)
    entry = {
        "lane": lane,
        "remote": comfy_lane_is_remote(lane),
        "status": "submitted",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if spki:
        entry["requester_spki"] = spki
        entry["requester_fp"] = requester_fingerprint(spki)
    if pushed_inputs:
        entry["pushed_inputs"] = [str(name) for name in pushed_inputs]
    if client_id:
        entry["client_id"] = str(client_id)
    with comfy_prompt_routes_lock:
        _comfy_prompt_routes[prompt_id] = entry
        _persist_comfy_prompt_routes_locked()
    return dict(entry)


def comfy_prompt_route(prompt_id):
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        entry = _comfy_prompt_routes.get(str(prompt_id or ""))
        return dict(entry) if isinstance(entry, dict) else None


def comfy_prompt_id_for_client(client_id):
    """The prompt a given client_id submitted, newest first.

    A client_id is minted per submission by the caller, so this is a lookup of
    its own job - not a way to enumerate anyone else's. Reads stay scoped by
    requester key at the route layer, exactly as history reads are."""
    wanted = str(client_id or "").strip()
    if not wanted:
        return None, None
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        matches = [
            (pid, dict(entry))
            for pid, entry in _comfy_prompt_routes.items()
            if isinstance(entry, dict) and str(entry.get("client_id") or "") == wanted
        ]
    if not matches:
        return None, None
    matches.sort(key=lambda item: str(item[1].get("created_at") or ""), reverse=True)
    return matches[0]


def update_comfy_prompt_route(prompt_id, **fields):
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        entry = _comfy_prompt_routes.get(str(prompt_id or ""))
        if not isinstance(entry, dict):
            return None
        entry.update(fields)
        _persist_comfy_prompt_routes_locked()
        return dict(entry)


def requester_may_read_prompt(route, presented_spki):
    """Scope history/status reads to the requester that submitted the prompt.

    Prompts recorded with a requester key require the SAME key on reads; legacy
    submissions (no key presented) keep today's token-only behavior. The sealed
    media is safe regardless - this guards status metadata."""
    if not route or not route.get("requester_fp"):
        return True
    presented = normalized_requester_spki(presented_spki)
    return bool(presented) and requester_fingerprint(presented) == route.get("requester_fp")


def sealing_spki_for_route(route):
    """The key remote outputs are sealed to: the requester's, falling back to
    the owner vault key for owner-initiated jobs that present none."""
    return normalized_requester_spki((route or {}).get("requester_spki")) or vault_public_key_spki()


def sealing_recipients_for_route(route):
    """(owner, agent) public keys for a remote job's harvested outputs.

    A harvest used to seal to exactly ONE recipient — the requester — so an
    agent-submitted rental job produced media the owner's own studio could
    never open: History failed to decrypt the tile and Download saved the
    enc:v1 JSON. The local path solved this long ago by sealing twice; this is
    that same split for the remote path. The owner's envelope keeps the plain
    <name>.e2e path every existing reader already looks for, and the agent
    keeps its access through <name>.agent-<fp>.e2e.

    Both halves move together under the one flag the local path and
    send_output_file() already use. With dual seal off there is still exactly
    one envelope and it stays sealed to whoever asked for the job — flipping it
    to the owner alone would take the agent's access away without the read side
    ever offering it a copy it could open. With no owner vault yet, likewise:
    one envelope, to the requester, exactly as before.
    """
    owner = vault_public_key_spki()
    if not AGENT_DUAL_SEAL_ENABLED or not owner:
        return sealing_spki_for_route(route), None
    agent = normalized_requester_spki((route or {}).get("requester_spki"))
    return owner, (agent if agent != owner else None)


def _prompt_input_file_refs(body):
    """Local Comfy input files a prompt graph references (LoadImage-style
    string inputs). These are what must be staged onto a remote lane."""
    refs = []
    try:
        prompt = _prompt_nodes_from_body(body)
    except Exception:
        return refs
    seen = set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for value in inputs.values():
            if not isinstance(value, str) or not value.strip():
                continue
            name = re.sub(r"\s*\[(?:input|output|temp)\]$", "", value.strip()).replace("\\", "/")
            if not name or name.startswith(("/", "~")) or ".." in name:
                continue
            try:
                resolved = (COMFY_INPUT_DIR / name).resolve()
            except OSError:
                continue
            if not _is_under(resolved, COMFY_INPUT_DIR) or not resolved.is_file():
                continue
            if str(resolved) in seen:
                continue
            seen.add(str(resolved))
            refs.append({"name": name, "path": resolved})
    return refs


def _push_file_to_lane_input(lane, name, path):
    subfolder, _, filename = str(name).rpartition("/")
    boundary = uuid.uuid4().hex
    parts = []
    fields = [("overwrite", "true"), ("type", "input")]
    if subfolder:
        fields.append(("subfolder", subfolder))
    for field_name, field_value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field_name}"\r\n\r\n{field_value}\r\n'.encode()
        )
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
        ).encode()
        + Path(path).read_bytes()
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    request = comfy_lane_request(
        lane, "/upload/image", data=b"".join(parts), method="POST",
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    with urlopen(request, timeout=120):
        pass


def push_prompt_inputs_to_lane(body, lane):
    """Stage every local input file the graph references onto the remote lane,
    so image-conditioned workflows (e.g. minimax-h3 image-to-video) run there.
    Returns the staged names for the post-harvest scrub."""
    pushed = []
    for ref in _prompt_input_file_refs(body):
        _push_file_to_lane_input(lane, ref["name"], ref["path"])
        pushed.append(ref["name"])
    return pushed


def _comfy_history_output_refs(history):
    refs = []
    for node_out in ((history or {}).get("outputs") or {}).values():
        if not isinstance(node_out, dict):
            continue
        for values in node_out.values():
            if not isinstance(values, list):
                continue
            for item in values:
                if isinstance(item, dict) and item.get("filename"):
                    refs.append({
                        "filename": str(item.get("filename")),
                        "subfolder": str(item.get("subfolder") or ""),
                        "type": str(item.get("type") or "output"),
                    })
    return refs


def _fetch_lane_history(lane, prompt_id):
    request = comfy_lane_request(lane, f"/history/{prompt_id}")
    with urlopen(request, timeout=15) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
    return data.get(str(prompt_id)) if isinstance(data, dict) else None


def _fetch_lane_view_bytes(lane, ref):
    query = urlencode({
        "filename": ref["filename"],
        "subfolder": ref.get("subfolder") or "",
        "type": ref.get("type") or "output",
    })
    request = comfy_lane_request(lane, f"/view?{query}")
    with urlopen(request, timeout=300) as response:
        return response.read()


def remote_output_logical_name(prompt_id, filename):
    """Remote Comfy instances restart their filename counters per rental, so
    fetched outputs are namespaced by prompt id - a bare z_image_00001_.png
    from a rented box must never collide with (or overwrite) a local output."""
    return f"cmf-{str(prompt_id)[:8]}-{safe_name(Path(str(filename)).name)}"


def harvest_remote_comfy_outputs(prompt_id, history):
    """Fetch a finished remote prompt's outputs and seal each to its recipients
    BEFORE anything persists. Plaintext bytes only ever touch a 0600 staging
    file inside the gateway's private state dir - never a shared output dir.
    Returns the logical output names.

    An agent-submitted job seals twice from that one staging file (owner and
    agent, see sealing_recipients_for_route), so both can read the result and
    neither the plaintext nor a second key ever leaves this function."""
    route = comfy_prompt_route(prompt_id) or {}
    spki, agent_spki = sealing_recipients_for_route(route)
    if not spki:
        raise RuntimeError("no sealing key: the requester presented none and no owner vault exists")
    agent_fp = requester_fingerprint(agent_spki)
    lane = route.get("lane") or "default"
    harvested = []
    for ref in _comfy_history_output_refs(history):
        if Path(ref["filename"]).suffix.lower() not in OUTPUT_MEDIA_EXTS:
            continue
        data = _fetch_lane_view_bytes(lane, ref)
        logical_name = remote_output_logical_name(prompt_id, ref["filename"])
        envelope = e2e_envelope_path_for(COMFY_OUTPUT_DIR / logical_name)
        COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        GATEWAY_STATE_DIR.mkdir(parents=True, exist_ok=True)
        staged = GATEWAY_STATE_DIR / f".remote-harvest-{uuid.uuid4().hex}"
        try:
            descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            _seal_file_with_helper(spki, staged, envelope, logical_name)
            if agent_fp:
                # Secondary recipient: never at the cost of the owner's copy,
                # which is already on disk by here. A failure is logged and the
                # harvest carries on, exactly as the local path does.
                try:
                    _seal_file_with_helper(
                        agent_spki, staged,
                        agent_envelope_path_for(COMFY_OUTPUT_DIR / logical_name, agent_fp),
                        logical_name,
                    )
                except Exception as exc:
                    print(f"[agent-seal] second recipient failed for {logical_name}: {exc}", file=sys.stderr)
        finally:
            try:
                staged.unlink()
            except FileNotFoundError:
                pass
        harvested.append(logical_name)
    update_comfy_prompt_route(
        prompt_id, status="harvested", outputs=harvested,
        harvested_at=datetime.now(timezone.utc).isoformat(),
    )
    return harvested


def scrub_remote_comfy_prompt(prompt_id, history=None, inputs_only=False):
    """After harvest: delete the prompt's output files AND any inputs we staged
    from the rented box, then drop the prompt from that lane's history. File
    deletion uses the provisioned /hivemind/scrub-files route (installed by
    gpu_rentals provisioning, and by
    packages/gpu-rentals/provisioning/comfyui-hivemind.sh for template boots);
    on a lane without it, history is still dropped and the files die with the
    instance's ephemeral disk.

    inputs_only covers the harvest-failed case: the output is the only copy of
    a paid generation and must survive, but the customer's staged reference
    image has no such claim on the box and goes now."""
    route = comfy_prompt_route(prompt_id) or {}
    lane = route.get("lane") or "default"
    files = [] if inputs_only else [
        {"type": ref.get("type") or "output", "subfolder": ref.get("subfolder") or "", "filename": ref["filename"]}
        for ref in _comfy_history_output_refs(history)
    ]
    for name in route.get("pushed_inputs") or []:
        subfolder, _, filename = str(name).replace("\\", "/").rpartition("/")
        files.append({"type": "input", "subfolder": subfolder, "filename": filename})
    files_scrubbed = None
    if files:
        try:
            request = comfy_lane_request(
                lane, "/hivemind/scrub-files",
                data=json.dumps({"files": files}).encode("utf-8"),
                method="POST", content_type="application/json",
            )
            with urlopen(request, timeout=30):
                files_scrubbed = True
        except Exception as exc:
            files_scrubbed = False
            print(
                f"[remote-comfy] lane '{lane}' file scrub unavailable ({exc}); "
                "remote files persist until the instance is destroyed",
                file=sys.stderr,
            )
    if inputs_only:
        # Leave the history entry: it names the output files, and it is the
        # only record of them once this watcher exits.
        update_comfy_prompt_route(prompt_id, inputs_scrubbed=files_scrubbed)
        return {"files_scrubbed": files_scrubbed, "history_dropped": False}
    history_dropped = False
    try:
        request = comfy_lane_request(
            lane, "/history",
            data=json.dumps({"delete": [str(prompt_id)]}).encode("utf-8"),
            method="POST", content_type="application/json",
        )
        with urlopen(request, timeout=10):
            history_dropped = True
    except Exception as exc:
        print(f"[remote-comfy] could not drop prompt {prompt_id} from lane '{lane}' history: {exc}", file=sys.stderr)
    update_comfy_prompt_route(
        prompt_id, scrubbed=bool(history_dropped),
        files_scrubbed=files_scrubbed, history_dropped=history_dropped,
    )
    return {"files_scrubbed": files_scrubbed, "history_dropped": history_dropped}


# Two or more path segments: enough to catch /workspace/ComfyUI/... without
# rewriting ordinary prose that happens to contain a slash.
_REMOTE_ABSOLUTE_PATH_RE = re.compile(r"(?:/[\w.@+-]+){2,}/?")


def _sanitized_remote_error_text(value):
    text = " ".join(str(value or "").split())
    text = _REMOTE_ABSOLUTE_PATH_RE.sub(
        lambda match: os.path.basename(match.group(0).rstrip("/")) or "…", text
    )
    return text[:400]


def remote_comfy_failure_message(history):
    """Why a remote prompt failed, in the words of the node that raised.

    Comfy reports a failure as an execution_error message carrying the node id,
    its class and the exception. Only those fields are lifted: the SAME payload
    also carries current_inputs (the prompt text) and a traceback of the rented
    box's filesystem, and neither may cross back to us. Absolute paths in the
    exception are reduced to basenames, so 'cannot open /workspace/models/x.pt'
    still names the file without mapping the box. Without this the route (and
    every layer above it) recorded the literal string 'error', which is how a
    one-line node validation failure became a 20-minute SSH dig."""
    status = (history or {}).get("status") or {}
    for message in status.get("messages") or []:
        if not (isinstance(message, (list, tuple)) and len(message) >= 2):
            continue
        kind, payload = message[0], message[1]
        if str(kind) != "execution_error" or not isinstance(payload, dict):
            continue
        node_type = str(payload.get("node_type") or "").strip()
        node_id = str(payload.get("node_id") or "").strip()
        exception = _sanitized_remote_error_text(payload.get("exception_message"))
        # Exception types arrive fully qualified from some nodes.
        exception_type = str(payload.get("exception_type") or "").strip().rsplit(".", 1)[-1]
        detail = exception or exception_type or "failed"
        if exception and exception_type and exception_type.lower() not in exception.lower():
            detail = f"{exception_type}: {exception}"
        where = f"{node_type} (node {node_id})" if node_type and node_id else node_type
        if not where and node_id:
            where = f"node {node_id}"
        return f"{where} failed — {detail}" if where else detail
    return _sanitized_remote_error_text(status.get("status_str")) or "remote generation failed"


REMOTE_SAMPLER_PROGRESS_SHARE = 0.9


def _record_lane_progress(prompt_id, lane):
    """Pull the lane's real sampler counters into this prompt's route record.

    A remote lane's /history entry appears only once, at the very end, so
    without this the studio has nothing but a time estimate for the whole
    generation. The rented box exposes /hivemind/progress (hivemind_privacy);
    a lane that predates it simply keeps the estimate. Counters only - the
    payload carries node ids and step numbers, never graph inputs."""
    try:
        request = comfy_lane_request(lane, "/hivemind/progress")
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return None
    if not isinstance(payload, dict) or str(payload.get("prompt_id") or "") != str(prompt_id):
        # Counters from a neighbouring prompt say nothing about this one.
        return None
    try:
        value, maximum = float(payload.get("value") or 0), float(payload.get("max") or 0)
    except (TypeError, ValueError):
        return None
    if maximum <= 0:
        return None
    # Sampling is the measurable phase, not the whole job: VAE decode, audio
    # decode, muxing and the sealed fetch-back follow it and report nothing.
    # Measured on a 5s H3 clip, that tail runs ~75s against ~40s of sampling,
    # so reporting the sampler's own 10/10 as 1.0 would park the bar at "done"
    # for longer than it took to sample. Scale into the share sampling actually
    # owns and let the client's time-based smoothing carry the remainder.
    progress = max(0.0, min(1.0, value / maximum)) * REMOTE_SAMPLER_PROGRESS_SHARE
    # Deliberately NOT touching status: respawn_remote_comfy_watchers re-arms
    # on status == "submitted", so a progress update that promoted the prompt
    # to "running" would orphan it across a gateway restart.
    update_comfy_prompt_route(
        prompt_id, progress=progress,
        progress_step=int(value), progress_total=int(maximum),
    )
    return progress


def watch_remote_comfy_prompt(prompt_id, poll_seconds=5, timeout_seconds=7200):
    """Server-side completion watcher for one remote-lane prompt: poll the
    OWNING lane, then harvest (requester-sealed) and scrub the box. Running
    here - not in the client - means results are captured and the rented box
    cleaned even if the submitting client dies mid-generation."""
    route = comfy_prompt_route(prompt_id) or {}
    lane = route.get("lane") or "default"
    deadline = time.monotonic() + timeout_seconds
    history = None
    while True:
        try:
            history = _fetch_lane_history(lane, prompt_id)
        except Exception:
            history = None
        if isinstance(history, dict):
            break
        # A prompt cancelled while still PENDING is deleted from the queue and
        # never reaches history at all, so waiting for one is waiting forever
        # (or until the 2-hour timeout, which then records a spurious error).
        if str((comfy_prompt_route(prompt_id) or {}).get("status") or "") == "cancelled":
            return comfy_prompt_route(prompt_id)
        _record_lane_progress(prompt_id, lane)
        if time.monotonic() >= deadline:
            update_comfy_prompt_route(
                prompt_id, status="error",
                error=f"remote prompt did not finish within {timeout_seconds}s",
            )
            return comfy_prompt_route(prompt_id)
        time.sleep(poll_seconds)
    status = history.get("status") or {}
    failed = str(status.get("status_str") or "").lower() == "error" or not status.get("completed")
    # An interrupted prompt lands in Comfy's history as "error" like any other
    # failure, so the only thing that tells the two apart is our own record of
    # having asked for it. Without this a deliberate cancel reads as a broken
    # generation everywhere downstream.
    was_cancelled = str((comfy_prompt_route(prompt_id) or {}).get("status") or "") == "cancelled"
    # Let the workflow-envelope index record this prompt's sealed workflow
    # before the history entry disappears from the lane.
    try:
        _harvest_comfy_workflow_envelopes()
    except Exception:
        pass
    harvest_error = None
    if failed and was_cancelled:
        # Keep the cancelled status; the remote's "error" is the interrupt we
        # asked for. Still falls through to the scrub below — a cancelled job's
        # staged inputs and partial outputs need cleaning up like any other.
        pass
    elif failed:
        failure = remote_comfy_failure_message(history)
        # The card just told us where its limit is. Record it against the card
        # size so every later run on a card like this is held under it — this is
        # the difference between a limit that is measured and one that is
        # guessed, and it is why the same OOM does not arrive twice.
        route = comfy_prompt_route(prompt_id) or {}
        if _looks_like_an_out_of_memory(failure) and route.get("packed_rows"):
            record_row_observation(route.get("card_vram_gb"), route.get("packed_rows"),
                                   "oom", lane=route.get("lane"))
        update_comfy_prompt_route(prompt_id, status="error", error=failure)
    else:
        # It finished: this many rows are PROVEN on a card this size, which is
        # the only thing allowed to raise a budget.
        route = comfy_prompt_route(prompt_id) or {}
        if route.get("packed_rows"):
            record_row_observation(route.get("card_vram_gb"), route.get("packed_rows"),
                                   "clean", lane=route.get("lane"))
        try:
            harvest_remote_comfy_outputs(prompt_id, history)
        except Exception as exc:
            harvest_error = exc
            update_comfy_prompt_route(prompt_id, status="error", error=str(exc))
    if harvest_error is None:
        # Scrub only once the sealed envelopes exist locally (or the job
        # failed and there is nothing to recover): a failed harvest must not
        # delete the only copy of a paid generation. Un-scrubbed files still
        # die with the instance's ephemeral disk.
        try:
            scrub_remote_comfy_prompt(prompt_id, history)
        except Exception as exc:
            print(f"[remote-comfy] scrub failed for {prompt_id}: {exc}", file=sys.stderr)
    else:
        # The outputs stay (they are the only copy), but the staged reference
        # image is ours to remove and has no recovery value.
        try:
            scrub_remote_comfy_prompt(prompt_id, history, inputs_only=True)
        except Exception as exc:
            print(f"[remote-comfy] input scrub failed for {prompt_id}: {exc}", file=sys.stderr)
        print(
            f"[remote-comfy] harvest failed for {prompt_id}; leaving remote outputs for instance teardown: {harvest_error}",
            file=sys.stderr,
        )
    return comfy_prompt_route(prompt_id)


def remote_comfy_job_record(prompt_id):
    """A routed remote prompt in /api/job shape, or None if it is not one.

    The studio polls this over its trusted server-side channel, so it is the
    one place a remote generation can report real progress (the lane's sampler
    counters) and, on completion, the sealed output it should fetch. Names the
    output under /image/, which serves the requester-sealed envelope - never a
    /comfy/view path, which only exists for plaintext local files."""
    route = comfy_prompt_route(prompt_id)
    if not route or not route.get("remote"):
        return None
    status = route.get("status")
    outputs = [str(name) for name in route.get("outputs") or []]
    record = {
        "id": str(prompt_id),
        "prompt": PRIVATE_PROMPT_LABEL,
        "backend": "comfy-remote",
        "status": {"submitted": "running", "harvested": "success"}.get(status, status or "running"),
        "created_at": route.get("created_at"),
        "lane": route.get("lane"),
    }
    if isinstance(route.get("progress"), (int, float)):
        record["progress"] = float(route["progress"])
        record["progress_step"] = route.get("progress_step")
        record["progress_total"] = route.get("progress_total")
    if route.get("error"):
        record["error"] = str(route["error"])
    if outputs:
        record["outputs"] = [{"filename": name, "subfolder": "", "type": "output"} for name in outputs]
        record["image_urls"] = [f"/image/{name}" for name in outputs]
    return record


def synthetic_comfy_history_for_route(prompt_id, route):
    """History-shaped response for a routed remote prompt, built from the
    gateway's own route record. The lane's history entry is scrubbed after
    harvest (by design), and while a job runs the proxy must not leak the
    lane's live state to non-requesters - so remote history reads are answered
    from here in every phase. Completion is only reported once the sealed
    envelopes exist locally, so a client that resolves output URLs on
    completion always finds them."""
    status_value = (route or {}).get("status")
    if status_value == "error":
        entry = {
            "status": {
                "status_str": "error", "completed": True,
                "messages": [["hivemind_remote_error", {"error": route.get("error") or "remote generation failed"}]],
            },
            "outputs": {},
        }
    elif status_value == "harvested":
        images = [
            {"filename": name, "subfolder": "", "type": "output"}
            for name in route.get("outputs") or []
        ]
        entry = {
            "status": {"status_str": "success", "completed": True},
            "outputs": {"hivemind_remote": {"images": images}},
        }
    else:
        # submitted / in flight: history has no entry yet, same as live Comfy.
        return {}
    return {str(prompt_id): entry}


def respawn_remote_comfy_watchers():
    """Re-arm watchers for remote prompts that were in flight when the gateway
    last stopped, so harvest+scrub still happen after a restart."""
    _ensure_comfy_prompt_routes_loaded()
    with comfy_prompt_routes_lock:
        pending = [
            pid for pid, entry in _comfy_prompt_routes.items()
            if isinstance(entry, dict) and entry.get("remote") and entry.get("status") == "submitted"
        ]
    for pid in pending:
        threading.Thread(target=watch_remote_comfy_prompt, args=(pid,), daemon=True).start()
    return pending


VAULT_SEALED_SETUP_FORMAT = "hivemind-vault-sealed-setup"


def _is_vault_sealed_setup(value):
    return (
        isinstance(value, dict)
        and value.get("format") == VAULT_SEALED_SETUP_FORMAT
        and isinstance(value.get("ciphertext"), str)
        and isinstance(value.get("wrapped_dek"), str)
    )


def _is_loadable_workflow_envelope(value):
    return _is_encrypted_workflow_envelope(value) or _is_vault_sealed_setup(value)


def seal_json_to_vault(obj):
    """Seal a small JSON object to the owner vault public key (RSA-OAEP + AES-GCM),
    the same wire format as media (frontend `decryptMedia`). Server can encrypt but
    never decrypt. Returns the envelope dict, or None if no vault exists yet."""
    spki = vault_public_key_spki()
    if not spki:
        return None
    stamp = uuid.uuid4().hex[:12]
    tmp_in = GATEWAY_STATE_DIR / f".setup-{stamp}.json"
    tmp_out = GATEWAY_STATE_DIR / f".setup-{stamp}.e2e"
    tmp_pub = GATEWAY_STATE_DIR / f".setup-{stamp}.pub"
    try:
        tmp_in.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        tmp_pub.write_text(spki, encoding="utf-8")
        proc = subprocess.run(
            [E2E_SEAL_PYTHON, E2E_SEAL_HELPER, "--pub", f"@{tmp_pub}", "--in", str(tmp_in), "--out", str(tmp_out)],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0 or not tmp_out.exists():
            raise RuntimeError(f"seal helper exited {proc.returncode}: {proc.stderr.strip()[:200]}")
        sealed = json.loads(tmp_out.read_text(encoding="utf-8"))
        return {
            "format": VAULT_SEALED_SETUP_FORMAT,
            "v": 1,
            "ciphertext": sealed["ciphertext"],
            "wrapped_dek": sealed["wrapped_dek"],
        }
    finally:
        for leftover in (tmp_in, tmp_out, tmp_pub):
            try:
                leftover.unlink()
            except FileNotFoundError:
                pass


def _studio_setup_from_graph(graph):
    """Extract the FULL composer-recoverable setup (prompt, negative, seed, steps,
    cfg, dimensions, model checkpoint, LoRAs) from a resolved auto-workflow API
    graph, so 'Load in Studio' can restore every exact setting."""
    sampler = next((n for n in graph.values() if isinstance(n, dict) and str(n.get("class_type")) in _AUTO_SAMPLER_CLASSES), None)
    prompt_text = ""
    negative_text = ""
    seed_val = steps_val = cfg_val = None
    pos_id = None
    if sampler:
        si = sampler.get("inputs") or {}
        seed_val = si.get("seed", si.get("noise_seed"))
        steps_val = si.get("steps")
        cfg_val = si.get("cfg")
        positive_ref = si.get("positive")
        if isinstance(positive_ref, list) and positive_ref:
            pos_id, pos_key = _auto_find_text_node(graph, positive_ref[0])
            if pos_id is not None:
                prompt_text = str((graph[pos_id].get("inputs") or {}).get(pos_key) or "")
        negative_ref = si.get("negative")
        if isinstance(negative_ref, list) and negative_ref:
            neg_id, neg_key = _auto_find_text_node(graph, negative_ref[0])
            if neg_id is not None and neg_id != pos_id:
                negative_text = str((graph[neg_id].get("inputs") or {}).get(neg_key) or "")
    width = height = None
    for node in graph.values():
        inputs = node.get("inputs") if isinstance(node, dict) else {}
        if isinstance(inputs.get("width"), (int, float)) and isinstance(inputs.get("height"), (int, float)):
            width, height = int(inputs["width"]), int(inputs["height"])
            break
    models = []
    loras = []
    for node in graph.values():
        inputs = node.get("inputs") if isinstance(node, dict) else None
        for key, value in (inputs or {}).items():
            if key in ("unet_name", "ckpt_name") and isinstance(value, str) and value:
                models.append(re.sub(r"\.(safetensors|ckpt|gguf)$", "", value, flags=re.IGNORECASE))
            if key == "lora_name" and isinstance(value, str) and value:
                strength = (inputs or {}).get("strength_model", (inputs or {}).get("strength", 1.0))
                loras.append({"name": value, "strength": float(strength) if isinstance(strength, (int, float)) else 1.0})
    seeds = [{"value": int(seed_val), "mode": "fixed"}] if isinstance(seed_val, (int, float)) else []
    return {
        "primaryPrompt": prompt_text,
        "negativePrompt": negative_text,
        "seeds": seeds,
        "seed": int(seed_val) if isinstance(seed_val, (int, float)) else None,
        "steps": int(steps_val) if isinstance(steps_val, (int, float)) else None,
        "cfg": float(cfg_val) if isinstance(cfg_val, (int, float)) else None,
        "width": width,
        "height": height,
        "models": sorted(set(models)),
        "loras": loras,
    }


def _studio_model_id_from_workflow(workflow_stem):
    """Match auto-workflow-discovery.js slugFromFilename → the studio's model id."""
    if not workflow_stem:
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", str(workflow_stem).lower()).strip("-")
    return f"comfy-auto-{slug}" if slug else None


def record_studio_workflow_setup(filenames, graph, prompt_id=None, workflow_stem=None):
    """Vault-seal the FULL setup (prompt, negative, seed, steps, cfg, dims, model,
    LoRAs, + resolved API graph) for a studio (auto-workflow) generation and index
    it by output filename, so 'Load in Studio' restores every exact setting for
    server-generated outputs (which carry no ComfyUI-mobile workflow envelope).
    The setup stays private: sealed to the vault, server can never read it back."""
    names = [safe_name(Path(p).name) for p in (filenames or []) if str(p).strip()]
    if not names:
        return
    try:
        payload = _studio_setup_from_graph(graph)
        # The studio model id (comfy-auto-<slug>) so the studio re-selects the
        # exact local model, not just the raw checkpoint name.
        payload["modelId"] = _studio_model_id_from_workflow(workflow_stem)
        # Also carry the resolved API graph so "Load in Canvas" can rebuild the
        # exact node graph client-side. Sealed to the vault (never server-readable).
        payload["apiGraph"] = graph
        envelope = seal_json_to_vault(payload)
        if not envelope:
            return
        recorded_at = now_iso()
        rec = {
            "prompt_id": prompt_id or f"studio-{uuid.uuid4().hex[:12]}",
            "filenames": names,
            "workflow": envelope,
            "recorded_at": recorded_at,
            "source": "studio",
        }
        with workflow_index_lock:
            for name in names:
                _workflow_index[name] = envelope
                _workflow_index_records[name] = {"prompt_id": rec["prompt_id"], "lane": "studio", "recorded_at": recorded_at}
            if rec["prompt_id"]:
                _workflow_index_prompts.add(rec["prompt_id"])
            WORKFLOW_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
            with WORKFLOW_INDEX_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[workflow-index] studio setup record failed: {e}", file=sys.stderr)


def _atomic_write_jsonl(path, records):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _record_without_output(record, name):
    if not isinstance(record, dict):
        return record, False
    changed = False
    result = dict(record)
    for key in ("outputs", "image_urls", "video_urls", "files"):
        values = result.get(key)
        if not isinstance(values, list):
            continue
        kept = [value for value in values if Path(urlparse(str(value)).path).name.removesuffix(OUTPUT_ENCRYPTION_SUFFIX) != name]
        if len(kept) != len(values):
            result[key] = kept
            changed = True
    return result, changed


def _rewrite_gateway_history_without_output(name):
    if not HISTORY_FILE.exists():
        return 0
    records = []
    changed = 0
    try:
        with HISTORY_FILE.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cleaned, record_changed = _record_without_output(record, name)
                changed += int(record_changed)
                if isinstance(cleaned, dict):
                    records.append(cleaned)
        if changed:
            _atomic_write_jsonl(HISTORY_FILE, records)
    except OSError as exc:
        raise RuntimeError("failed to purge durable generation history") from exc
    return changed


def _rewrite_workflow_index_without_output(name):
    removed_prompt_ids = set()
    touched_prompt_ids = set()
    records = []
    changed = 0
    with workflow_index_lock:
        if WORKFLOW_INDEX_FILE.exists():
            try:
                with WORKFLOW_INDEX_FILE.open("r", encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        filenames = record.get("filenames") if isinstance(record.get("filenames"), list) else []
                        kept = [value for value in filenames if Path(str(value)).name != name]
                        if len(kept) != len(filenames):
                            changed += 1
                            if record.get("prompt_id"):
                                touched_prompt_ids.add(str(record["prompt_id"]))
                            if not kept and record.get("prompt_id"):
                                removed_prompt_ids.add(str(record["prompt_id"]))
                        if kept:
                            records.append({**record, "filenames": kept})
                if changed:
                    _atomic_write_jsonl(WORKFLOW_INDEX_FILE, records)
            except OSError as exc:
                raise RuntimeError("failed to purge encrypted workflow history") from exc
        _workflow_index.pop(name, None)
        index_record = _workflow_index_records.pop(name, None)
        if isinstance(index_record, dict) and index_record.get("prompt_id"):
            prompt_id = str(index_record["prompt_id"])
            if not any(str(value.get("prompt_id") or "") == prompt_id for value in _workflow_index_records.values()):
                removed_prompt_ids.add(prompt_id)
        for prompt_id in removed_prompt_ids:
            _workflow_index_prompts.discard(prompt_id)
    return changed, touched_prompt_ids


def _purge_queue_metadata(prompt_ids):
    changed = 0
    for cache_file in QUEUE_METADATA_FILES:
        if not cache_file.exists():
            continue
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            prompts = data.get("prompts") if isinstance(data, dict) else None
            if not isinstance(prompts, dict):
                continue
            for prompt_id in prompt_ids:
                if prompts.pop(prompt_id, None) is not None:
                    changed += 1
            if changed:
                temporary = cache_file.with_name(f".{cache_file.name}.{os.getpid()}.tmp")
                temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                os.replace(temporary, cache_file)
        except (OSError, json.JSONDecodeError):
            continue
    return changed


def _delete_prompt_ids_from_comfy(prompt_ids):
    failures = []
    if not prompt_ids:
        return failures
    body = json.dumps({"delete": sorted(prompt_ids)}).encode("utf-8")
    for lane, base in COMFY_LANES.items():
        try:
            request = comfy_lane_request(
                lane, "/history", data=body, method="POST",
                content_type="application/json",
            )
            with urlopen(request, timeout=10):
                pass
        except Exception:
            failures.append(lane)
    return failures


def _queue_entry_ids(entries):
    # Queue entries are [number, prompt_id, prompt, extra, outputs] tuples;
    # only the id is read, so prompt redaction does not matter here.
    return {str(item[1]) for item in (entries or []) if isinstance(item, (list, tuple)) and len(item) > 1}


def _lane_queue_state(lane, prompt_id):
    """Where `prompt_id` sits on one lane: 'pending', 'running', or None."""
    try:
        with urlopen(comfy_lane_request(lane, "/queue"), timeout=10) as response:
            state = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return None
    if prompt_id in _queue_entry_ids(state.get("queue_pending")):
        return "pending"
    if prompt_id in _queue_entry_ids(state.get("queue_running")):
        return "running"
    return None


# How long a cancel waits for the backend to actually let go before answering.
# Kept under the studio's own cancel timeout so the honest verdict gets back
# rather than the caller giving up and inventing one.
CANCEL_VERIFY_SECONDS = float(os.environ.get("ZIMG_CANCEL_VERIFY_SECONDS", "8") or 8)
CANCEL_VERIFY_POLL_SECONDS = 0.5


def interrupt_comfy_prompt(prompt_id, verify_seconds=None):
    """Stop one Comfy prompt across every lane, and report whether it ACTUALLY
    stopped.

    A pending prompt is deleted from the queue and is gone immediately. A
    running one can only be asked: Comfy checks for an interrupt at node and
    sampler-step boundaries, so a prompt still inside a long non-interruptible
    stretch — loading a 17k-step video model, say — keeps the GPU until it
    reaches the next checkpoint. That can be minutes.

    This used to return True the moment a lane ACCEPTED the /interrupt POST,
    which is a receipt, not a death certificate. The studio showed "cancelled"
    instantly, the next generation queued behind a job that was still running,
    and the wait looked like the cancel had done nothing. So after asking, poll
    the lane until the prompt leaves its queue.

    Returns {'acknowledged', 'stopped', 'lane', 'state'} where `stopped` means
    the prompt is verifiably off the queue and `state` is where it was last
    seen ('pending', 'running', or None for never-found).
    """
    pid = str(prompt_id or "")
    result = {"acknowledged": False, "stopped": False, "lane": "", "state": None}
    if not pid:
        return result
    deadline = time.monotonic() + (CANCEL_VERIFY_SECONDS if verify_seconds is None else float(verify_seconds))

    seen_bases = set()
    for lane, base in COMFY_LANES.items():
        if base in seen_bases:
            continue
        seen_bases.add(base)
        state = _lane_queue_state(lane, pid)
        if state is None:
            continue
        result.update(lane=lane, state=state)
        try:
            if state == "pending":
                body = json.dumps({"delete": [pid]}).encode("utf-8")
                with urlopen(comfy_lane_request(lane, "/queue", data=body, method="POST", content_type="application/json"), timeout=10):
                    result["acknowledged"] = True
            else:
                with urlopen(comfy_lane_request(lane, "/interrupt", data=b"{}", method="POST", content_type="application/json"), timeout=10):
                    result["acknowledged"] = True
        except Exception:
            continue
        # Verify: a delete is effective at once, an interrupt may not be.
        while True:
            if _lane_queue_state(lane, pid) is None:
                result["stopped"] = True
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(CANCEL_VERIFY_POLL_SECONDS)
        return result

    # Never found on any lane: nothing of ours is holding a GPU, which is the
    # same end state the caller wanted. Distinguished from a verified stop by
    # `acknowledged` staying False.
    result["stopped"] = True
    return result


def cancel_generation_job(jid):
    """Cancel one generation job wherever it runs. Native (MLX) jobs get their
    live subprocess terminated plus a cancel flag the runner checks between
    stages; Comfy-routed jobs (the job id is the Comfy prompt id) are removed
    from the queue or interrupted mid-execution. Cancelling an unknown or
    already-finished job is a no-op, not an error, so the studio can always
    unblock its UI."""
    jid = str(jid)
    with jobs_lock:
        rec = jobs.get(jid)
        active = rec is not None and rec.get("status") in ("queued", "running")
        if active:
            rec["cancel_requested"] = True
        proc = native_job_procs.get(jid)
        comfy_prompt_id = str((rec or {}).get("comfy_prompt_id") or "")
    interrupted = False
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            interrupted = True
        except Exception:
            pass
    stopped = interrupted
    state = None
    if active and not interrupted and not comfy_prompt_id:
        # A native job between subprocess stages: no live process to kill right
        # now, but the runner aborts at its next cancel-flag checkpoint. Asked,
        # not confirmed — same distinction the Comfy path makes below.
        interrupted = True
        stopped = False
    if not interrupted:
        pid = comfy_prompt_id or jid
        outcome = interrupt_comfy_prompt(pid)
        interrupted = bool(outcome["acknowledged"])
        stopped = bool(outcome["stopped"])
        state = outcome["state"]
        # A deliberate cancel is not a failure. Recording it as one leaves the
        # route (and everything downstream that reads it) claiming the
        # generation broke, which is both wrong and alarming in History.
        # No-ops for an id with no route (a local job), so no guard needed.
        update_comfy_prompt_route(
            pid, status="cancelled", cancelled_at=datetime.now(timezone.utc).isoformat(),
        )
    return {
        "ok": True,
        "id": jid,
        "known": rec is not None,
        # Receipt: the backend accepted the request to stop.
        "interrupted": bool(interrupted),
        # Verdict: the job is verifiably no longer holding the backend. False
        # means it is still winding down and the next job WILL queue behind it.
        "stopped": bool(stopped),
        **({"backend_state": state} if state else {}),
    }


def delete_output_everywhere(value):
    name = safe_name(value)
    if not name or Path(name).suffix.lower() not in OUTPUT_MEDIA_EXTS:
        raise ValueError("valid media filename required")

    history_records = _rewrite_gateway_history_without_output(name)
    workflow_records, prompt_ids = _rewrite_workflow_index_without_output(name)
    queue_metadata = _purge_queue_metadata(prompt_ids)

    with jobs_lock:
        live_records = 0
        for job_id, record in list(jobs.items()):
            cleaned, changed = _record_without_output(record, name)
            if changed:
                jobs[job_id] = cleaned
                live_records += 1

    deleted_files = 0
    for root in (OUT_DIR, COMFY_OUTPUT_DIR):
        try:
            if not root.exists():
                continue
            for candidate in list(root.rglob("*")):
                if not candidate.is_file():
                    continue
                logical = logical_path_for_encrypted(candidate)
                if logical.name != name:
                    continue
                candidate.unlink(missing_ok=True)
                deleted_files += 1
        except OSError as exc:
            raise RuntimeError("failed to remove every private media copy") from exc

    preview_files = 0
    for cache_root in PREVIEW_CACHE_ROOTS:
        try:
            if not cache_root.exists():
                continue
            for candidate in list(cache_root.rglob("*")):
                if candidate.is_file():
                    candidate.unlink(missing_ok=True)
                    preview_files += 1
            for candidate in sorted(cache_root.rglob("*"), reverse=True):
                if candidate.is_dir():
                    candidate.rmdir()
        except OSError:
            continue

    lane_failures = _delete_prompt_ids_from_comfy(prompt_ids)
    return {
        "ok": True,
        "deleted_files": deleted_files,
        "history_records": history_records,
        "workflow_records": workflow_records,
        "live_records": live_records,
        "queue_metadata": queue_metadata,
        "preview_files": preview_files,
        "lane_cleanup_deferred": len(lane_failures),
    }


def mirror_output_to_comfy_output(path, job_id=None):
    src = Path(path).resolve()
    if not src.exists() or not src.is_file():
        return src
    if OUTPUT_ENCRYPTION_ENABLED:
        # Do not duplicate native outputs into a second plaintext directory.
        return encrypt_output_file(src, agent_spki=agent_seal_recipient_for(job_id))
    COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dst = (COMFY_OUTPUT_DIR / safe_name(src.name)).resolve()
    if str(dst).startswith(str(COMFY_OUTPUT_DIR.resolve())) and dst != src:
        try:
            shutil.copy2(src, dst)
            return dst
        except OSError as e:
            print(f"[native-mlx] failed to mirror output to Comfy output dir: {e}", file=sys.stderr)
    return src


def h(value):
    return html.escape(str(value or ""))


def json_safe_text(value, limit=2000):
    text = str(value or "")[-limit:]
    return "".join(ch if ch in "\t\n\r" or ord(ch) >= 32 else "" for ch in text)


def nice_time(value):
    if not value:
        return ""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%b %-d, %-I:%M %p")
    except Exception:
        return str(value)


PRIVATE_PROMPT_LABEL = "[private prompt hidden]"

# Workflow graphs ride along with job records so clients can inspect node
# structure, but a graph also carries the generation prompt — in text widgets
# and in per-runtime defaults (e.g. extra.nativeMlxLtx.defaults.prompt). That
# text must never be persisted or served in the clear. Full-fidelity workflows
# stay available through the E2E-sealed workflow index (/workflow-for-output),
# which only the owner's browser can decrypt.
_PROMPT_TEXT_KEYS = {
    "prompt", "negative_prompt", "negativeprompt", "negative", "positive",
    "text", "text_g", "text_l", "clip_l", "t5xxl", "caption", "description",
    "prompt_text", "user_prompt", "reference_description",
}
# Positional widget values carry no key, so classify by shape: free text is
# long and contains spaces; checkpoints, LoRA files, samplers, and enum values
# do not.
_WIDGET_FREE_TEXT_MIN = 24


def _looks_like_free_text(value):
    return isinstance(value, str) and len(value) >= _WIDGET_FREE_TEXT_MIN and " " in value.strip()


def scrub_workflow_prompt_text(value, _key=None):
    """Blank prompt-bearing text in a workflow graph, keeping structure
    (node types, links, model and sampler settings) intact."""
    if isinstance(value, dict):
        scrubbed = {}
        for key, item in value.items():
            if isinstance(key, str) and key.lower() in _PROMPT_TEXT_KEYS and isinstance(item, str):
                scrubbed[key] = ""
            else:
                scrubbed[key] = scrub_workflow_prompt_text(item, key)
        return scrubbed
    if isinstance(value, list):
        if isinstance(_key, str) and _key.lower() == "widgets_values":
            return ["" if _looks_like_free_text(item) else scrub_workflow_prompt_text(item) for item in value]
        return [scrub_workflow_prompt_text(item, _key) for item in value]
    return value


def scrub_record_workflows(out):
    """Strip prompt text from every workflow graph carried by a job record.
    Applied at the persistence and serving chokepoints so no write path can
    leak prompt text even if it bypasses the tuple builders."""
    tuple_value = out.get("comfy_prompt")
    if isinstance(tuple_value, list):
        out["comfy_prompt"] = [scrub_workflow_prompt_text(item) for item in tuple_value]
    if isinstance(out.get("workflow"), dict):
        out["workflow"] = scrub_workflow_prompt_text(out["workflow"])
    return out


_RUNNER_OUTPUT_TAIL_LINES = 3


def runner_output_tail(text, lines=_RUNNER_OUTPUT_TAIL_LINES):
    """The last few lines of a runner's stderr, paths reduced to basenames.

    Native runners take the prompt on argv, so a traceback or an argparse echo
    in their output can carry it — and the job record used to persist 4 KB of
    stdout AND stderr into history.jsonl and serve both to any token-bearing
    caller. Three scrubbed lines keep "why did it fail" without the dump."""
    kept = [line.strip() for line in str(text or "").splitlines() if line.strip()][-lines:]
    return "\n".join(_sanitized_remote_error_text(line) for line in kept)


def private_rec(rec):
    out = dict(rec or {})
    prompt_text = out.get("prompt") if isinstance(out.get("prompt"), str) else ""
    if "prompt" in out:
        out["prompt"] = PRIVATE_PROMPT_LABEL
    # Applied at the persistence AND serving chokepoint (public_record calls
    # this too), so no runner path can write its console into history.
    out.pop("runner_stdout", None)
    if "runner_stderr" in out:
        tail = runner_output_tail(out.get("runner_stderr"))
        if tail and len(prompt_text.strip()) >= 8 and prompt_text.strip() != PRIVATE_PROMPT_LABEL:
            # The prompt rode on argv; a traceback line can echo it verbatim.
            tail = tail.replace(" ".join(prompt_text.split()), PRIVATE_PROMPT_LABEL)
        if tail:
            out["runner_stderr"] = tail
        else:
            out.pop("runner_stderr", None)
    return scrub_record_workflows(out)


def append_history(rec):
    # Do not persist prompts at rest. ComfyUI receives the prompt for execution,
    # but the wrapper history only keeps status, image paths, timestamps, errors,
    # and selected LoRA metadata.
    with HISTORY_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(private_rec(rec), ensure_ascii=False) + "\n")


def load_history(limit=100):
    if not HISTORY_FILE.exists():
        return []
    lines = HISTORY_FILE.read_text(encoding="utf-8").splitlines()
    recs = []
    for line in lines[-limit:]:
        try:
            recs.append(json.loads(line))
        except Exception:
            pass
    return list(reversed(recs))


def load_download_jobs():
    if not DOWNLOAD_JOBS_FILE.exists():
        return {}
    try:
        data = json.loads(DOWNLOAD_JOBS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_download_jobs_unlocked():
    # Caller must hold download_jobs_lock.
    DOWNLOAD_JOBS_FILE.write_text(json.dumps(download_jobs, indent=2, ensure_ascii=False), encoding="utf-8")


def update_download_job(job_id, **fields):
    with download_jobs_lock:
        cur = download_jobs.get(job_id, {})
        cur.update(fields)
        cur.setdefault('id', job_id)
        download_jobs[job_id] = cur
        save_download_jobs_unlocked()
        return dict(cur)


def public_record(rec):
    # Live in-memory jobs never pass through private_rec, so redact here too:
    # /api/history must not hand prompt text to any token-bearing caller,
    # whatever a current or future queueing path chose to keep in memory.
    out = private_rec(rec)
    if out.get("outputs"):
        out["image_urls"] = [f"/image/{safe_name(Path(p).name)}?token={TOKEN}" for p in out["outputs"]]
    options = out.get("options")
    if isinstance(options, dict):
        out["options"] = {
            key: ("" if key.lower() in _PROMPT_TEXT_KEYS and isinstance(value, str) else value)
            for key, value in options.items()
        }
    return out


LORA_PROMPT_TOKEN_RE = re.compile(r'<lora:([^:>]+):([^>]+)>', re.I)
LORA_MODEL_EXTS = {'.safetensors', '.ckpt', '.pt', '.pth'}


def _scan_lora_tokens(value, out):
    if isinstance(value, str):
        for match in LORA_PROMPT_TOKEN_RE.finditer(value):
            out.append({'name': match.group(1), 'strength': match.group(2)})
    elif isinstance(value, dict):
        for child in value.values():
            _scan_lora_tokens(child, out)
    elif isinstance(value, list):
        for child in value:
            _scan_lora_tokens(child, out)


def _lora_trace_from_prompt_nodes(prompt):
    lora_nodes = []
    lora_tokens = []
    if not isinstance(prompt, dict):
        return lora_nodes, lora_tokens
    for node_id, node in prompt.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get('class_type') or '')
        inputs = node.get('inputs') or {}
        if isinstance(inputs, dict):
            _scan_lora_tokens(inputs, lora_tokens)
        has_lora_input = isinstance(inputs, dict) and any('lora' in str(k).lower() for k in inputs.keys())
        if 'lora' in class_type.lower() or has_lora_input:
            redacted_inputs = {}
            if isinstance(inputs, dict):
                for key in ['lora_name', 'strength', 'strength_model', 'strength_clip', 'lora_stack', 'model', 'clip']:
                    if key in inputs:
                        redacted_inputs[key] = inputs.get(key)
            lora_nodes.append({'id': node_id, 'class_type': class_type, 'inputs': redacted_inputs})
    return lora_nodes, lora_tokens


def _prompt_has_lora_semantics(prompt):
    lora_nodes, lora_tokens = _lora_trace_from_prompt_nodes(prompt)
    return bool(lora_nodes or lora_tokens)


def _env_enabled(name, default='0'):
    return str(os.environ.get(name, default)).strip().lower() in {'1', 'true', 'yes', 'on'}


def _generation_request_has_loras(data):
    if isinstance(data, dict) and data.get('loras') is not None:
        req_loras = data.get('loras')
        if isinstance(req_loras, list):
            return any(isinstance(item, dict) and str(item.get('id', '')).strip() for item in req_loras)
        return bool(req_loras)
    return bool(load_selected_loras())


def _lora_strength(inputs, default=1.0):
    if not isinstance(inputs, dict):
        return default
    for key in ('strength_model', 'strength', 'model_strength'):
        if key in inputs:
            try:
                return float(inputs.get(key))
            except Exception:
                return default
    return default


def _lora_strength_for_input(inputs, input_key, default=1.0):
    if not isinstance(inputs, dict):
        return default
    candidates = ['strength_model', 'strength', 'model_strength']
    key = str(input_key)
    match = re.search(r'(\d+)$', key)
    if match:
        suffix = match.group(1)
        candidates.extend([
            f'strength_{suffix}',
            f'strength_model_{suffix}',
            f'lora_strength_{suffix}',
            f'lora_{suffix}_strength',
        ])
    for candidate in candidates:
        if candidate in inputs:
            try:
                return float(inputs.get(candidate))
            except Exception:
                return default
    return default


def _resolve_lora_path(name):
    value = str(name or '').strip()
    if not value:
        return None
    value = value.replace('\\', '/')
    for prefix in ('models/loras/', 'loras/'):
        if value.lower().startswith(prefix):
            value = value[len(prefix):]
            break
    lora_root = (COMFY / 'models' / 'loras').resolve()
    candidates = []
    raw_path = Path(value)
    if raw_path.is_absolute():
        candidates.append(raw_path)
    else:
        candidates.append(lora_root / value)
        if raw_path.suffix == '':
            candidates.extend(lora_root / f"{value}{ext}" for ext in sorted(LORA_MODEL_EXTS))
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            if resolved.exists() and resolved.is_file() and _is_under(resolved, lora_root):
                return str(resolved)
        except Exception:
            continue
    try:
        stem_or_name = Path(value).name.lower()
        for p in lora_root.rglob('*'):
            if not p.is_file() or p.suffix.lower() not in LORA_MODEL_EXTS:
                continue
            if p.name.lower() == stem_or_name or p.stem.lower() == stem_or_name:
                return str(p.resolve())
    except Exception:
        pass
    return None


def _dedupe_lora_requests(loras):
    out = []
    seen = set()
    for lora in loras or []:
        path = str(lora.get('filePath') or '').strip()
        if not path:
            continue
        try:
            scale = float(lora.get('scale', 1.0))
        except Exception:
            scale = 1.0
        key = (path, round(scale, 6))
        if key in seen:
            continue
        seen.add(key)
        out.append({'filePath': path, 'scale': scale})
    return out


def _extract_lora_stack_requests(stack):
    found = []
    if isinstance(stack, str):
        value = stack.strip()
        if not value or value[0] not in '[{':
            return found
        try:
            return _extract_lora_stack_requests(json.loads(value))
        except Exception:
            return found
    if isinstance(stack, dict):
        name = stack.get('lora_name') or stack.get('name') or stack.get('lora')
        enabled = stack.get('on', stack.get('active', True))
        enabled_ok = enabled is not False and str(enabled).lower() not in {'false', '0', 'off', 'none'}
        if name and enabled_ok:
            path = _resolve_lora_path(name)
            if path:
                found.append({'filePath': path, 'scale': _lora_strength(stack)})
        for value in stack.values():
            found.extend(_extract_lora_stack_requests(value))
    elif isinstance(stack, list):
        if len(stack) >= 2:
            enabled = stack[0]
            enabled_ok = enabled is not False and str(enabled).lower() not in {'false', '0', 'off', 'none'}
            name = next((item for item in stack if isinstance(item, str) and item.lower().endswith(tuple(LORA_MODEL_EXTS))), None)
            if enabled_ok and name:
                strength = 1.0
                for item in stack:
                    if isinstance(item, (int, float)):
                        strength = float(item)
                        break
                path = _resolve_lora_path(name)
                if path:
                    found.append({'filePath': path, 'scale': strength})
        for value in stack:
            if isinstance(value, (dict, list)):
                found.extend(_extract_lora_stack_requests(value))
    return found


def _native_loras_from_prompt_nodes(prompt):
    loras = []
    unresolved = []
    if not isinstance(prompt, dict):
        return loras, unresolved
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get('class_type') or '').lower()
        inputs = _node_inputs(node)
        if 'lora' in class_type or any('lora' in str(k).lower() for k in inputs.keys()):
            for key in ('lora_name', 'lora', 'name'):
                if key in inputs and isinstance(inputs.get(key), str):
                    path = _resolve_lora_path(inputs.get(key))
                    if path:
                        loras.append({'filePath': path, 'scale': _lora_strength(inputs)})
                    else:
                        unresolved.append(str(inputs.get(key)))
            for key, value in inputs.items():
                if 'lora' not in str(key).lower():
                    continue
                if isinstance(value, str):
                    path = _resolve_lora_path(value)
                    if path:
                        loras.append({'filePath': path, 'scale': _lora_strength_for_input(inputs, key)})
                elif isinstance(value, (dict, list)):
                    loras.extend(_extract_lora_stack_requests(value))
            if 'lora_stack' in inputs:
                loras.extend(_extract_lora_stack_requests(inputs.get('lora_stack')))
    _, tokens = _lora_trace_from_prompt_nodes(prompt)
    for token in tokens:
        path = _resolve_lora_path(token.get('name'))
        if path:
            try:
                scale = float(token.get('strength', 1.0))
            except Exception:
                scale = 1.0
            loras.append({'filePath': path, 'scale': scale})
        else:
            unresolved.append(str(token.get('name') or ''))
    return _dedupe_lora_requests(loras), [x for x in unresolved if x]


def _native_loras_from_generation_request(data, base_models=None):
    if isinstance(data, dict) and data.get('loras') is not None:
        selected = resolve_lora_selection(data.get('loras') or [], base_models)
    else:
        selected = load_selected_loras()
        if base_models:
            selected = [item for item in selected if lora_base_matches(item.get('baseModel'), base_models)]
    loras = []
    for item in selected:
        try:
            path = str(Path(item.get('path')).resolve())
        except Exception:
            path = item.get('path')
        loras.append({'filePath': path, 'scale': item.get('strength', 1.0)})
    return _dedupe_lora_requests(loras)


def _strip_lora_prompt_tokens(text):
    return re.sub(r'\s+', ' ', LORA_PROMPT_TOKEN_RE.sub('', str(text or ''))).strip()


def record_mobile_prompt_lora_trace(body):
    """Persist redacted LoRA-only diagnostics for the last proxied Mobile prompt.

    This intentionally does not store prompt text or the full API graph. It keeps
    only class_type, node id, lora filenames, strengths, and <lora:name:...>
    tokens found in string fields.
    """
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        prompt = data.get('prompt') if isinstance(data, dict) else None
        if not isinstance(prompt, dict):
            return
        lora_nodes, lora_tokens = _lora_trace_from_prompt_nodes(prompt)
        LAST_MOBILE_PROMPT_LORAS_FILE.write_text(json.dumps({
            'at': now_iso(),
            'lora_nodes': lora_nodes,
            'lora_tokens': lora_tokens,
        }, indent=2), encoding='utf-8')
    except Exception as e:
        try:
            LAST_MOBILE_PROMPT_LORAS_FILE.write_text(json.dumps({'at': now_iso(), 'error': str(e)}, indent=2), encoding='utf-8')
        except Exception:
            pass



def _prompt_nodes_from_body(body):
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        prompt = data.get('prompt') if isinstance(data, dict) else None
        return prompt if isinstance(prompt, dict) else {}
    except Exception:
        return {}


def _prompt_body_client_id(body):
    """The submitter's own client_id, which Comfy echoes on the queue entry."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
        return str(data.get('client_id') or '') if isinstance(data, dict) else ''
    except Exception:
        return ''


BIGLOVE_KLEIN3_BASE_BUCKET = (1024, 1536)
# A requested canvas is honored as a PIXEL BUDGET around that bucket (the edit
# adopts the reference's aspect afterwards), clamped to the range Klein 9B stays
# coherent and in-memory over: ~0.26MP for a fast draft, ~2MP for a final. The
# ceiling is deliberately below the 24 GB per-job reservation's comfort limit.
BIGLOVE_KLEIN3_MIN_PIXELS = 512 * 512
BIGLOVE_KLEIN3_MAX_PIXELS = 1152 * 1728
# FLUX.2 Klein conditions on up to 4 reference images (the Swift engine's
# Flux2Config.maxReferenceImages for every klein variant, matching BFL's
# editing docs). Every reference cap on this route reads this one number.
BIGLOVE_KLEIN3_MAX_REFERENCES = 4
BIGLOVE_KLEIN3_COMFY_MXFP8_MODEL = "BigLoveKlein3_mxfp8.safetensors"
BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL = "BigLoveKlein3_mxfp8_dequant_bf16.safetensors"
BIGLOVE_KLEIN3_COMFY_BF16_MODEL = "BigLoveKlein3_bf16.safetensors"
BIGLOVE_KLEIN3_MLX_DERIVED_MODELS = {
    "BigLoveKlein3_mxfp8_swift_mapped_mlx.safetensors",
    "BigLoveKlein3_mxfp8_mlx_native.safetensors",
}
BIGLOVE_KLEIN3_COMFY_MPS_UNSUPPORTED_MODELS = BIGLOVE_KLEIN3_MLX_DERIVED_MODELS | {
    BIGLOVE_KLEIN3_COMFY_MXFP8_MODEL,
    BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL,
}
COMFY_MODELISH_INPUT_KEYS = {
    'model', 'model_name', 'ckpt_name', 'unet_name', 'vae_name',
    'clip_name', 'text_encoder', 'text_encoder_name', 'diffusion_model',
    'name',
}


def normalize_biglove_klein3_steps(value):
    """BigLoveKlein3 page recommends exactly 4 steps, or 2 for upscaling."""
    try:
        steps = int(round(float(value)))
    except Exception:
        steps = 4
    return 2 if steps <= 2 else 4


def orient_biglove_klein3_bucket(width, height):
    """The known-good ~1.5MP trained bucket, oriented to a requested shape.

    The reference workflow metadata uses ImageScaleToTotalPixels at 1.5 MP and
    lands near 1024x1504. The model page's closest recommended trained bucket is
    1024x1536, so the native fast path uses that exact bucket instead of
    arbitrary full-resolution workflow sizes. Callers that cannot trust the
    requested size (a Comfy graph whose EmptyLatentImage is still the stock
    512x512 while an ImageScaleToTotalPixels node sets the real canvas) pin
    themselves here rather than treating that size as a budget.
    """
    bucket_w, bucket_h = BIGLOVE_KLEIN3_BASE_BUCKET
    try:
        landscape = float(width) > float(height)
    except (TypeError, ValueError):
        landscape = False
    return (bucket_h, bucket_w) if landscape else (bucket_w, bucket_h)


def snap_biglove_klein3_resolution(width, height):
    """Resolve a BigLoveKlein3 native canvas from a requested pixel budget.

    This used to pin EVERY native run to the trained bucket, which silently
    threw away the caller's resolution — the studio's Resolution control and the
    registry's advertised width/height inputs did nothing on Apple Silicon, so
    an edit could be neither run cheap for a draft nor pushed for a final (the
    portable Comfy lane honored them all along). The bucket is still what an
    unspecified request lands on; a requested size is now honored as a pixel
    BUDGET, scaled off the bucket and clamped to the supported range. Aspect is
    not taken from the request: an edit reshapes this budget onto the
    reference's own aspect afterwards.
    """
    try:
        requested_w = int(round(float(width)))
        requested_h = int(round(float(height)))
    except (TypeError, ValueError):
        requested_w = requested_h = 0
    if requested_w <= 0 or requested_h <= 0:
        return orient_biglove_klein3_bucket(requested_w, requested_h)
    bucket_w, bucket_h = orient_biglove_klein3_bucket(requested_w, requested_h)
    budget = min(BIGLOVE_KLEIN3_MAX_PIXELS, max(BIGLOVE_KLEIN3_MIN_PIXELS, requested_w * requested_h))
    scale = (budget / float(bucket_w * bucket_h)) ** 0.5
    return (
        _round_to_multiple(bucket_w * scale, multiple=32),
        _round_to_multiple(bucket_h * scale, multiple=32),
    )


def _reshape_dims_to_image_aspect(image_path, width, height, *, multiple=32):
    """Reshape a width×height pixel budget to a source image's aspect ratio.

    An edit rescales the reference onto the output canvas, so a canvas whose
    aspect differs from the source distorts it — the fixed 1024x1536 bucket
    stretched square references vertically. Keep the caller's pixel budget,
    adopt the source aspect (clamped to 3:1 either way so a degenerate strip
    cannot blow up one dimension), and stay on the sampling grid. When the
    source cannot be read the caller's dims pass through unchanged.
    """
    dims = _image_dimensions(image_path) if image_path else None
    if not dims or dims[0] <= 0 or dims[1] <= 0:
        return width, height
    try:
        budget = max(1, int(width)) * max(1, int(height))
    except Exception:
        return width, height
    aspect = max(1.0 / 3.0, min(3.0, dims[0] / dims[1]))
    new_width = (budget * aspect) ** 0.5
    return (
        _round_to_multiple(new_width, multiple=multiple),
        _round_to_multiple(new_width / aspect, multiple=multiple),
    )


class ComfyLanePinError(RuntimeError):
    """A "Run on" pin named a rented machine the gateway cannot route to."""


# --- what the card itself has proven ------------------------------------------
# A packed-row budget is a PREDICTION of a physical limit, and predictions have
# been wrong in both directions: 85,000 was interpolated between a clean run and
# a failure, and a job inside that gap died (2026-08-23). So the gateway records
# what actually happens on each card and the guard is bounded by it — never
# above a run that OOM'd, never below one that finished. The card is the
# authority; the registry number is only where it starts.
#
# Keyed by the card's VRAM in whole GiB, because that is what decides capacity
# and it survives a machine being destroyed and re-rented. Free VRAM is NOT read
# for this: under cudaMallocAsync an idle healthy box already reports ~6 GiB
# "used" that belongs to no model, so a live reading would shrink budgets on a
# card that is perfectly empty.
H3_ROW_OBSERVATIONS_FILE = GATEWAY_STATE_DIR / "h3-row-observations.json"
_row_observations_lock = threading.Lock()
# A card that OOM'd at N rows is not asked to do N again: the guard is held a
# little under it, because the failure point is not exactly reproducible (the
# allocator's fragmentation moves it).
OOM_OBSERVATION_SAFETY = 0.95


def _read_row_observations():
    try:
        data = json.loads(H3_ROW_OBSERVATIONS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {k: v for k, v in (data or {}).items() if isinstance(v, dict)}


def _card_key(vram_total_gb):
    try:
        card = int(round(float(vram_total_gb)))
    except (TypeError, ValueError):
        return None
    return str(card) if card > 0 else None


def record_row_observation(vram_total_gb, rows, outcome, *, lane=None):
    """Remember that a run of `rows` packed rows finished, or ran out of memory,
    on a card of this size. Never raises: bookkeeping must not take a generation
    down with it."""
    key = _card_key(vram_total_gb)
    try:
        rows = int(rows)
    except (TypeError, ValueError):
        return None
    if not key or rows <= 0 or outcome not in ("clean", "oom"):
        return None
    try:
        with _row_observations_lock:
            data = _read_row_observations()
            entry = data.get(key) or {}
            if outcome == "clean":
                # The largest run PROVEN to finish. Only ever grows, and only
                # from a run that really completed.
                entry["clean_rows"] = max(int(entry.get("clean_rows") or 0), rows)
            else:
                seen = entry.get("oom_rows")
                entry["oom_rows"] = min(int(seen), rows) if seen else rows
            entry[f"{outcome}_at"] = datetime.now(timezone.utc).isoformat()
            if lane:
                entry[f"{outcome}_lane"] = str(lane)
            entry["samples"] = int(entry.get("samples") or 0) + 1
            data[key] = entry
            H3_ROW_OBSERVATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
            H3_ROW_OBSERVATIONS_FILE.write_text(json.dumps(data, indent=1), encoding="utf-8")
            return dict(entry)
    except Exception as exc:
        print(f"[comfy-lanes] could not record a row observation: {exc}", file=sys.stderr)
        return None


def row_observations_for(vram_total_gb):
    """What this card size has proven, for the guard to bound itself by."""
    key = _card_key(vram_total_gb)
    if not key:
        return None
    entry = _read_row_observations().get(key)
    return dict(entry) if entry else None


def _looks_like_an_out_of_memory(message):
    text = str(message or "").lower()
    return "outofmemory" in text or "out of memory" in text


def _packed_rows_from_comfy_prompt_body(body):
    """The row count the MCP priced this graph at, if it said. Sent alongside
    `run_on` and stripped before the graph reaches ComfyUI — it is our
    bookkeeping, not a node input."""
    try:
        data = json.loads(
            body.decode("utf-8", errors="replace")
            if isinstance(body, (bytes, bytearray)) else body
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        rows = int(data.get("packed_rows"))
    except (TypeError, ValueError):
        return None
    return rows if rows > 0 else None


def _run_on_from_comfy_prompt_body(body):
    """The rented machine a /prompt body asks to run on — the studio's per-tab
    "Run on" pin. Top-level `run_on`, or `extra_data.extra_pnginfo.runOn` for
    callers that carry everything in the PNG info the way studioLane rides."""
    try:
        data = json.loads(
            body.decode('utf-8', errors='replace')
            if isinstance(body, (bytes, bytearray)) else body
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return ''
    if not isinstance(data, dict):
        return ''
    extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
    return str(
        data.get('run_on')
        or extra_pnginfo.get('runOn')
        or extra_pnginfo.get('run_on')
        or ''
    ).strip()[:128]


def comfy_lane_for_pin(run_on):
    """The attached rental lane a "Run on" pin names; None when nothing is pinned.

    The pin is the rental id the studio shows (the attachment registry's key,
    e.g. "vast:48352597"); a lane name is accepted too. A pin naming a machine
    that is no longer attached RAISES instead of falling back: the tab asked
    for that box, and quietly spending another box's hours (or a local lane's
    minutes) is exactly the surprise the pin exists to prevent. The studio
    drops a stale pin on its next machine refresh; an agent gets the reason.
    """
    pin = str(run_on or '').strip()
    if not pin:
        return None
    refresh_comfy_lanes()
    for lane, spec in _read_rental_attachments().items():
        if (spec.get('rental_id') == pin or lane == pin) and lane in COMFY_LANES:
            return lane
    raise ComfyLanePinError(
        f"the rented machine this job is pinned to ({pin}) is no longer attached — "
        "pick another machine under Run on, or send no run_on to follow the default routing"
    )


def comfy_lane_for_prompt_body(body, run_on=None):
    """Pick a configured Comfy lane from graph class/model names only.

    Rules are data-driven via COMFY_LANE_RULES, e.g.
    "anima=anima,qwen35,qwen3.5;sdxl=sdxl,pony". Prompt text is intentionally
    ignored; only class names and model-ish input values are inspected.

    `run_on` is the studio's per-tab "Run on" pin: the pinned machine's rule
    is tried FIRST, ahead of the priority order — the same thing the global
    /select does, scoped to this one request. A pin whose machine does not
    serve the graph falls through to the normal order (the pin settles which
    of several capable boxes runs a job; it never sends a model to a box that
    lacks it), and a pin naming a detached machine raises ComfyLanePinError.
    """
    pinned = comfy_lane_for_pin(run_on)
    # Pick up a machine attached since this process started, so routing a
    # generation to a fresh rental needs no restart.
    refresh_comfy_lanes()
    prompt = _prompt_nodes_from_body(body)
    haystack = []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        haystack.append(str(node.get('class_type') or '').lower())
        inputs = node.get('inputs') or {}
        if not isinstance(inputs, dict):
            continue
        for key, value in inputs.items():
            key_l = str(key).lower()
            if _is_modelish_input_key(key_l):
                if isinstance(value, str):
                    haystack.append(value.lower())
    text = ' '.join(haystack)
    if pinned is not None:
        pinned_needles = next((needles for lane, needles in COMFY_LANE_RULES if lane == pinned), [])
        if any(needle in text for needle in pinned_needles):
            return pinned
    for lane, needles in COMFY_LANE_RULES:
        if lane in COMFY_LANES and any(needle in text for needle in needles):
            return lane
    return 'default'


def comfy_http_for_prompt_body(body, run_on=None):
    return COMFY_LANES.get(comfy_lane_for_prompt_body(body, run_on=run_on), COMFY_HTTP_DEFAULT)


def _is_modelish_input_key(key):
    key_l = str(key).lower()
    return key_l in COMFY_MODELISH_INPUT_KEYS or any(part in key_l for part in ('model', 'ckpt', 'unet', 'vae', 'clip', 'encoder'))


def exact_comfy_biglove_model_name():
    if not supports_apple_silicon_optimizations():
        return None
    override = os.environ.get("ZIMG_EXACT_COMFY_BIGLOVE_MODEL", "").strip()
    model_dir = COMFY / "models" / "diffusion_models"
    candidates = [
        override,
        BIGLOVE_KLEIN3_COMFY_BF16_MODEL,
        BIGLOVE_KLEIN3_COMFY_DEQUANT_BF16_MODEL,
    ]
    for name in candidates:
        if name and (model_dir / name).exists():
            return name
    return None


def exact_comfy_biglove_prompt_body(body):
    """Map BigLove MXFP8 filenames to a Comfy/MPS-compatible exact model.

    The Swift sidecar uses derived safetensors with MLX-specific tensor names,
    PyTorch/MPS cannot execute Float8_e4m3fn tensors, and the local dequant file
    still carries Comfy quant sidecars. When a real Comfy workflow is forwarded
    for fidelity on this Mac, use the clean installed BF16 file instead of any
    MXFP8/MLX/dequant filename.
    """
    target_model = exact_comfy_biglove_model_name()
    if not target_model:
        return body
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return body
    prompt = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt, dict):
        return body
    changed = False
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            continue
        for key, value in list(inputs.items()):
            if not isinstance(value, str) or not _is_modelish_input_key(key):
                continue
            if Path(value).name in BIGLOVE_KLEIN3_COMFY_MPS_UNSUPPORTED_MODELS and value != target_model:
                inputs[key] = target_model
                changed = True
                print(f"[comfy-proxy] rewrote BigLove exact model {Path(value).name} -> {target_model}", flush=True)
    if not changed:
        return body
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


KREA2_TURBO_LEGACY_CONVROT_MODEL = "Krea2_Turbo_convrot_int8mixed.safetensors"


def _api_ref_node_id(value):
    if isinstance(value, list) and value:
        return str(value[0])
    return None


def exact_comfy_krea2_turbo_pre_lora_prompt_body(body):
    """Repair stale Krea2 Turbo ConvRot runtime-LoRA prompts before Comfy runs them.

    Older browser sessions can keep submitting:
      UNETLoader(Krea2_Turbo_convrot_int8mixed) -> MultiLoRAStack -> KSampler

    That applies LoRAs to already-quantized ConvRot INT8 weights and has shown
    blotchy/noisy texture artifacts. The safe Apple Silicon route bakes LoRAs
    into the BF16 Turbo source first, then quantizes ConvRot INT8 on the fly.
    The guard also normalizes stale Krea2 Turbo sampler settings from the old
    er_sde/simple experiment to the current euler_ancestral/beta default.
    """
    if not supports_apple_silicon_optimizations():
        return body
    if not (COMFY / "models" / "diffusion_models" / KREA2_TURBO_PRE_LORA_SOURCE_MODEL).exists():
        return body
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return body
    prompt = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt, dict):
        return body

    changed = False
    def is_krea2_turbo_loader(node):
        if not isinstance(node, dict):
            return False
        inputs = node.get('inputs')
        if not isinstance(inputs, dict):
            return False
        model_name = Path(str(inputs.get('unet_name') or '')).name
        if node.get('class_type') == 'UNETLoader':
            return model_name == KREA2_TURBO_LEGACY_CONVROT_MODEL
        if node.get('class_type') == 'OTUNetLoaderW8A8':
            return model_name == KREA2_TURBO_PRE_LORA_SOURCE_MODEL and inputs.get('model_type') == 'krea2'
        return False

    if any(is_krea2_turbo_loader(node) for node in prompt.values()):
        for node in prompt.values():
            if not isinstance(node, dict) or node.get('class_type') != 'KSampler':
                continue
            inputs = node.get('inputs')
            if not isinstance(inputs, dict):
                continue
            if inputs.get('sampler_name') == 'er_sde' and inputs.get('scheduler') == 'simple':
                inputs['sampler_name'] = 'euler_ancestral'
                inputs['scheduler'] = 'beta'
                changed = True
                print("[comfy-proxy] rewrote stale Krea2 Turbo sampler er_sde/simple -> euler_ancestral/beta", flush=True)

    for lora_id, lora_node in list(prompt.items()):
        if not isinstance(lora_node, dict) or lora_node.get('class_type') != 'MultiLoRAStack':
            continue
        lora_inputs = lora_node.get('inputs')
        if not isinstance(lora_inputs, dict):
            continue
        model_ref = lora_inputs.get('model')
        clip_ref = lora_inputs.get('clip')
        unet_id = _api_ref_node_id(model_ref)
        clip_id = _api_ref_node_id(clip_ref)
        if unet_id is None or unet_id not in prompt:
            continue
        unet_node = prompt.get(unet_id)
        if not isinstance(unet_node, dict) or unet_node.get('class_type') != 'UNETLoader':
            continue
        unet_inputs = unet_node.get('inputs')
        if not isinstance(unet_inputs, dict):
            continue
        if Path(str(unet_inputs.get('unet_name') or '')).name != KREA2_TURBO_LEGACY_CONVROT_MODEL:
            continue

        lora_node['class_type'] = 'MultiLoRAStackToPreLora'
        lora_node['inputs'] = {'lora_stack': lora_inputs.get('lora_stack', '[]')}

        unet_node['class_type'] = 'OTUNetLoaderW8A8'
        unet_node['inputs'] = {
            'pre_lora': [str(lora_id), 0],
            'unet_name': KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
            'weight_dtype': 'default',
            'model_type': 'krea2',
            'on_the_fly_quantization': True,
            'enable_convrot': True,
            'lora_mode': 'None',
        }

        for node in prompt.values():
            if not isinstance(node, dict):
                continue
            if node is unet_node:
                continue
            inputs = node.get('inputs')
            if not isinstance(inputs, dict):
                continue
            for key, value in list(inputs.items()):
                if isinstance(value, list) and len(value) >= 2 and str(value[0]) == str(lora_id):
                    slot = value[1]
                    if slot == 0:
                        inputs[key] = [str(unet_id), 0]
                    elif slot == 1 and clip_id is not None:
                        inputs[key] = [str(clip_id), 0]

        changed = True
        print(
            "[comfy-proxy] rewrote stale Krea2 Turbo ConvRot runtime-LoRA graph to Pre-LoRA BF16->ConvRot route",
            flush=True,
        )

    if not changed:
        return body
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def build_krea2_turbo_identity_prompt(prompt, image_name=None, options=None, profile=None, filename_prefix="krea2_identity"):
    return compile_krea2_turbo_identity_prompt(
        prompt,
        image_name=image_name,
        options=options,
        profile=profile or accelerator_profile(),
        filename_prefix=filename_prefix,
        identity_checkpoint_available=(
            COMFY / "models" / "diffusion_models" / KREA2_IDENTITY_CONVROT_MODEL
        ).is_file(),
    )


def output_file_records(limit=200):
    """Fallback history from image files that exist on disk.

    ComfyUI writes current generations to its private output directory, while
    older wrapper records live in history.jsonl and may point at the wrapper's
    private copy directory.  The UI should still show past generations when the
    prompt history is empty/stale, so synthesize redacted records from files.
    """
    paths = []
    for root in [COMFY_OUTPUT_DIR, OUT_DIR]:
        try:
            if root.exists():
                for p in root.rglob("*"):
                    if not p.is_file():
                        continue
                    logical = logical_path_for_encrypted(p)
                    if logical.name.startswith("."):
                        continue
                    if logical.suffix.lower() in OUTPUT_MEDIA_EXTS:
                        paths.append(logical)
        except Exception:
            continue
    def _mtime(x):
        physical = existing_output_path(x)
        try:
            return physical.stat().st_mtime if physical else 0
        except OSError:
            return 0

    records = []
    for p in sorted(set(paths), key=_mtime, reverse=True)[:limit]:
        physical = existing_output_path(p)
        if physical is None:
            continue
        try:
            st = physical.stat()
        except Exception:
            continue
        indexed = workflow_index_record_for_filename(p.name) or {}
        indexed_prompt_id = indexed.get("prompt_id") if isinstance(indexed.get("prompt_id"), str) else None
        indexed_recorded_at = indexed.get("recorded_at") if isinstance(indexed.get("recorded_at"), str) else None
        timestamp = indexed_recorded_at or datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()
        records.append({
            "id": indexed_prompt_id or f"file-{hashlib.sha1(str(p).encode('utf-8')).hexdigest()[:12]}",
            "prompt": PRIVATE_PROMPT_LABEL,
            "status": "success",
            "created_at": timestamp,
            "finished_at": timestamp,
            "outputs": [str(p.resolve())],
            "source": "files",
            **({"lane": indexed.get("lane")} if indexed.get("lane") else {}),
            **({"indexed_prompt_id": indexed_prompt_id} if indexed_prompt_id else {}),
        })
    return records


def active_jobs():
    with jobs_lock:
        return [public_record(r) for r in jobs.values() if r.get("status") in {"queued", "running"}]


def all_records(limit=200):
    seen = set()
    recs = []
    for r in active_jobs() + [public_record(r) for r in load_history(limit)] + [public_record(r) for r in output_file_records(limit)]:
        rid = r.get("id")
        output_key = tuple(Path(p).name for p in r.get("outputs", []) if p)
        key = output_key or (rid,)
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        recs.append(r)
    recs.sort(key=lambda r: r.get("finished_at") or r.get("created_at") or "", reverse=True)
    return recs[:limit]


def run_generation(job_id, prompt, loras=None, options=None):
    started = now_iso()
    with jobs_lock:
        jobs[job_id].update({"status": "running", "started_at": started})
    safe_options = {k: v for k, v in (options or {}).items() if k in {"width", "height", "steps", "cfg", "cfgScale", "guidance", "seed", "negative_prompt"}}
    rec = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "running", "created_at": started, "outputs": [], "loras": loras or [], "options": {k: v for k, v in safe_options.items() if k != "negative_prompt"}}
    try:
        if not RUNNER.exists():
            raise RuntimeError(f"Runner not found: {RUNNER}")
        seed_arg = str(safe_options.get("seed")) if safe_options.get("seed") not in (None, "", -1) else ""
        proc = subprocess.run(
            [str(RUNNER), prompt, json.dumps(loras or []), seed_arg, json.dumps(safe_options)],
            cwd=str(COMFY),
            text=True,
            capture_output=True,
            timeout=900,
        )
        stdout = proc.stdout.strip()
        stderr = proc.stderr.strip()
        if proc.returncode != 0:
            raise RuntimeError(f"runner exited {proc.returncode}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")

        result = None
        chunks, buf, depth = [], [], 0
        for ch in stdout:
            if ch == "{":
                depth += 1
            if depth:
                buf.append(ch)
            if ch == "}":
                depth -= 1
                if depth == 0 and buf:
                    chunks.append("".join(buf))
                    buf = []
        for c in chunks:
            try:
                result = json.loads(c)
            except Exception:
                pass
        outputs = result.get("outputs", []) if isinstance(result, dict) else []
        outputs = encrypt_outputs(
            (str(Path(p).resolve()) for p in outputs if Path(p).exists()), job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": outputs,
            "runner_stdout": stdout[-4000:],
            "runner_stderr": stderr[-4000:],
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def int_option(options, key, default, lo, hi):
    try:
        value = int(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def int_quality_option(options, key, default):
    try:
        value = int(round(float(options.get(key, default))))
        return value if value > 0 else default
    except Exception:
        return default


def float_quality_option(options, key, default):
    try:
        value = float(options.get(key, default))
        return value if value == value else default
    except Exception:
        return default


def float_option(options, key, default, lo, hi):
    try:
        value = float(options.get(key, default))
    except Exception:
        value = default
    return max(lo, min(hi, value))


def bool_option(options, key, default):
    value = options.get(key, default)
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return bool(value)


def stage_inline_image_base64(value):
    if not isinstance(value, str) or not value.strip():
        return None
    encoded = value.strip()
    extension = ".png"
    if encoded.startswith("data:"):
        match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.*)$", encoded, flags=re.DOTALL)
        if not match:
            raise ValueError("image_base64 must be raw base64 or an image data URL")
        mime, encoded = match.groups()
        extension = {
            "image/jpeg": ".jpg",
            "image/jpg": ".jpg",
            "image/webp": ".webp",
            "image/png": ".png",
        }.get(mime.lower(), ".png")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("image_base64 is not valid base64") from exc
    if not payload:
        raise ValueError("image_base64 decoded to an empty image")
    if len(payload) > 20 * 1024 * 1024:
        raise ValueError("decoded inline image exceeds 20MB")
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = COMFY_INPUT_DIR / f"media-studio-inline-{uuid.uuid4().hex[:16]}{extension}"
    target.write_bytes(payload)
    return target


def _reference_image_path(value):
    """A caller-named reference path; a bare name is ComfyUI-input-relative."""
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else COMFY_INPUT_DIR / str(value)


def collect_reference_image_paths(data, uploaded_image=None):
    """Every reference a generation request attached, in the order it sent them.

    Order is load-bearing for lanes that address references by index (H3 names
    them <Picture 1>..<Picture N>), so this preserves the caller's sequence:
    the inline/multipart image first, then image_path, then the images_base64
    and image_paths lists. Duplicates drop to their first position. Raises
    ValueError when an inline image cannot be decoded.
    """
    paths = [uploaded_image] if uploaded_image is not None else []
    if isinstance(data, dict):
        maybe_image = str(data.get('image_path', '') or '')
        if maybe_image:
            paths.append(_reference_image_path(maybe_image))
        extra_b64 = data.get('images_base64')
        if isinstance(extra_b64, list):
            for value in extra_b64:
                staged = stage_inline_image_base64(value)
                if staged is not None:
                    paths.append(staged)
        extra_paths = data.get('image_paths')
        if isinstance(extra_paths, list):
            for value in extra_paths:
                text = str(value or '').strip()
                if text:
                    paths.append(_reference_image_path(text))
    seen = set()
    deduped = []
    for path in paths:
        resolved = str(Path(path).resolve())
        if resolved not in seen:
            seen.add(resolved)
            deduped.append(Path(resolved))
    return deduped


def run_comfy_klein3_edit(job_id, prompt, image_path, options=None):
    started = now_iso()
    options = options or {}
    steps = int_option(options, 'steps', 4, 1, 12)
    cfg = float_option(options, 'cfg', float_option(options, 'guidance', 1.0, 0.0, 20.0), 0.0, 20.0)
    seed = resolve_seed_option(options)
    denoise = float_option(options, 'denoise', 0.45, 0.0, 1.0)
    width = int_quality_option(options, 'width', 512)
    height = int_quality_option(options, 'height', 768)
    negative = str(options.get('negative_prompt') or 'noise, abstract texture, distorted face, bad anatomy, plastic skin, over-smoothed, blurry, low quality, duplicate face')
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-bigloves-klein3-edit",
        "created_at": started,
        "outputs": [],
        "options": {
            "steps": steps,
            "cfg": cfg,
            "seed": seed,
            "denoise": denoise,
            "width": width,
            "height": height,
            "lora_count": len(options.get('loras') or []),
        },
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        image_path = Path(image_path).resolve()
        allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = safe_name(image_path.name)
        comfy_input = (COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())
        # Node 4b resizes with crop:'disabled', which stretches anything the
        # canvas doesn't match — keep the requested pixel budget but adopt the
        # source image's aspect so the edit never distorts it.
        width, height = _reshape_dims_to_image_aspect(comfy_input, width, height, multiple=16)
        rec["options"].update({"width": width, "height": height})
        filename_prefix = f"biglove_klein3_comfy_edit_{job_id}"
        api_prompt = {
            '1': {'class_type':'UNETLoader','inputs':{'unet_name':'BigLoveKlein3_bf16.safetensors','weight_dtype':'default'}},
            '2': {'class_type':'CLIPLoader','inputs':{'clip_name':'qwen_3_8b_fp8mixed.safetensors','type':'flux2','device':'default'}},
            '3': {'class_type':'VAELoader','inputs':{'vae_name':'flux2-vae.safetensors'}},
            '4': {'class_type':'LoadImage','inputs':{'image':input_name}},
            '4b': {'class_type':'ImageScale','inputs':{'image':['4',0],'upscale_method':'lanczos','width':width,'height':height,'crop':'disabled'}},
            '5': {'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':prompt}},
            '6': {'class_type':'CLIPTextEncode','inputs':{'clip':['2',0],'text':negative}},
            '7': {'class_type':'VAEEncode','inputs':{'pixels':['4b',0], 'vae':['3',0]}},
            '8': {'class_type':'KSampler','inputs':{'model':['1',0],'positive':['5',0],'negative':['6',0],'latent_image':['7',0],'seed':seed,'steps':steps,'cfg':cfg,'sampler_name':'euler','scheduler':'beta','denoise':denoise}},
            '9': {'class_type':'VAEDecode','inputs':{'samples':['8',0], 'vae':['3',0]}},
            '10': {'class_type':'SaveImage','inputs':{'images':['9',0], 'filename_prefix':filename_prefix}},
        }
        model_ref = ['1', 0]
        lora_root = (COMFY / 'models' / 'loras').resolve()
        for index, item in enumerate(options.get('loras') or [], start=11):
            lora_path = Path(str(item.get('filePath') or '')).resolve()
            try:
                lora_name = str(lora_path.relative_to(lora_root))
            except ValueError as exc:
                raise RuntimeError("BigLove LoRA is outside the private Comfy model folder") from exc
            if not lora_path.is_file():
                raise RuntimeError(f"BigLove LoRA is missing: {lora_name}")
            node_id = str(index)
            api_prompt[node_id] = {
                'class_type': 'LoraLoaderModelOnly',
                'inputs': {
                    'model': model_ref,
                    'lora_name': lora_name,
                    'strength_model': float(item.get('scale', 1.0)),
                },
            }
            model_ref = [node_id, 0]
        api_prompt['8']['inputs']['model'] = model_ref
        body = json.dumps({'prompt': api_prompt, 'client_id': f'zimage-klein3-{job_id}'}).encode('utf-8')
        t0 = time.monotonic()
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={'Content-Type':'application/json'})
        queued = json.loads(urlopen(req, timeout=20).read().decode('utf-8'))
        prompt_id = queued.get('prompt_id')
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec['comfy_prompt_id'] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec
        history = None
        for _ in range(300):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode('utf-8')
                data = json.loads(payload or '{}')
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI Klein3 edit timed out waiting for prompt {prompt_id}")
        status = history.get('status') or {}
        if status.get('status_str') != 'success' or not status.get('completed'):
            raise RuntimeError(f"ComfyUI Klein3 edit failed: {status}")
        outputs = []
        for node_out in (history.get('outputs') or {}).values():
            for img in node_out.get('images') or []:
                name = safe_name(img.get('filename') or '')
                subfolder = img.get('subfolder') or ''
                typ = img.get('type') or 'output'
                root = COMFY_OUTPUT_DIR if typ == 'output' else COMFY_INPUT_DIR
                p = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if existing_output_path(p):
                    outputs.append(str(p))
        if not outputs:
            raise RuntimeError("ComfyUI Klein3 edit completed without output images")
        outputs = encrypt_outputs(outputs, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _load_auto_api_workflow(workflow_file):
    """Load + validate an API-format graph from an allowed folder.

    Two roots, both read-only to a client: the user's drop-in folders, and the
    gateway's OWN workflows/ directory — the graphs the registry ships and
    names by `workflow_file` (loadHostedImageModels resolves them to absolute
    paths). Without the second root a registered comfy-api-image lane could
    never load its own graph.
    """
    path = Path(str(workflow_file or "")).expanduser().resolve()
    allowed_roots = [root.resolve() for root in AUTO_WORKFLOW_DIRS + [REGISTRY_WORKFLOW_DIR]]
    if path.suffix.lower() != ".json" or not any(str(path).startswith(f"{root}{os.sep}") for root in allowed_roots):
        raise RuntimeError("workflow file is outside the auto-workflow folders")
    if not path.is_file():
        raise RuntimeError(f"workflow file is missing: {path.name}")
    data = json.loads(path.read_text(encoding="utf-8"))
    graph = data.get("prompt") if isinstance(data, dict) and isinstance(data.get("prompt"), dict) else data
    if not isinstance(graph, dict) or not graph or not all(
        isinstance(node, dict) and node.get("class_type") for node in graph.values()
    ):
        raise RuntimeError(f"{path.name} is not an API-format ComfyUI graph (use ComfyUI's 'Save (API format)')")
    return path, json.loads(json.dumps(graph))


_AUTO_PROMPT_TEXT_KEYS = ("text", "positive_text", "prompt")
_AUTO_SAMPLER_CLASSES = {"KSampler", "KSamplerAdvanced"}


def _auto_find_text_node(graph, start_id, seen=None):
    """Follow a conditioning ref upstream to the first node carrying prompt text."""
    seen = seen or set()
    node_id = str(start_id)
    if node_id in seen or node_id not in graph:
        return None, None
    seen.add(node_id)
    node = graph[node_id]
    inputs = node.get("inputs") or {}
    for key in _AUTO_PROMPT_TEXT_KEYS:
        if isinstance(inputs.get(key), str):
            return node_id, key
    for value in inputs.values():
        if isinstance(value, list) and value:
            found = _auto_find_text_node(graph, value[0], seen)
            if found[0] is not None:
                return found
    return None, None


def _auto_submit_prompt(lane_url, graph, client_id):
    body = json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8")
    req = Request(f"{lane_url}/prompt", data=body, headers={"Content-Type": "application/json"})
    return json.loads(urlopen(req, timeout=30).read().decode("utf-8"))


def _auto_fill_missing_required_inputs(graph, error_payload, lane_url):
    """Self-heal stale API exports: fill inputs a node gained after the export.

    ComfyUI 400s with node_errors listing required_input_missing entries; the
    lane's /object_info declares each input's default. Returns True when at
    least one input was filled (caller retries once).
    """
    try:
        detail = json.loads(error_payload or "{}")
    except Exception:
        return False
    healed = False
    for node_id, node_error in (detail.get("node_errors") or {}).items():
        node = graph.get(str(node_id))
        if not isinstance(node, dict):
            continue
        missing = [
            err.get("extra_info", {}).get("input_name")
            for err in (node_error.get("errors") or [])
            if err.get("type") == "required_input_missing"
        ]
        missing = [name for name in missing if name]
        if not missing:
            continue
        class_type = str(node.get("class_type") or "")
        try:
            payload = urlopen(f"{lane_url}/object_info/{class_type}", timeout=10).read().decode("utf-8")
            spec = (json.loads(payload).get(class_type) or {}).get("input") or {}
        except Exception:
            continue
        declared = {}
        for group in ("required", "optional"):
            declared.update(spec.get(group) or {})
        for input_name in missing:
            entry = declared.get(input_name)
            if not (isinstance(entry, list) and len(entry) >= 2 and isinstance(entry[1], dict) and "default" in entry[1]):
                continue
            node.setdefault("inputs", {})[input_name] = entry[1]["default"]
            healed = True
    return healed


def _auto_fit_regional_prompt(node, prompt_text):
    """Regional-prompt nodes (ForgeCouple style) need one prompt line per region.

    The region count comes from the node's own advanced_mapping; a shorter
    prompt is padded by repeating its last line so a plain one-line prompt
    still renders instead of failing validation.
    """
    inputs = node.get("inputs") or {}
    if "advanced_mapping" not in inputs:
        return str(prompt_text)
    try:
        regions = len(json.loads(inputs.get("advanced_mapping") or "[]"))
    except Exception:
        regions = 0
    if regions < 2:
        return str(prompt_text)
    lines = [line.strip() for line in str(prompt_text).splitlines() if line.strip()] or [str(prompt_text)]
    while len(lines) < regions:
        lines.append(lines[-1])
    return "\n".join(lines)


def _normalize_couple_options(options):
    """Coerce couple_* options to safe primitives — they land in job records."""
    if not isinstance(options, dict):
        return options
    for flag in ("couple_mode", "couple_shared"):
        if flag in options:
            options[flag] = str(options.get(flag)).strip().lower() in ("1", "true", "yes", "on")
    if "couple_split" in options:
        try:
            options["couple_split"] = min(0.9, max(0.1, float(options["couple_split"])))
        except (TypeError, ValueError):
            options["couple_split"] = 0.5
    if "couple_direction" in options:
        vertical = str(options.get("couple_direction") or "").strip().lower() in ("vertical", "stacked", "vert")
        options["couple_direction"] = "vertical" if vertical else "horizontal"
    if "couple_pair" in options:
        pair = str(options.get("couple_pair") or "").strip().lower()
        options["couple_pair"] = pair if pair in ("girls", "mixed", "boys") else "girls"
    return options


_COUPLE_PAIR_ANCHORS = {"girls": "2girls", "mixed": "1boy, 1girl", "boys": "2boys"}
_COUPLE_SOLO_TAG_PREFIX = re.compile(r"^\s*(?:(?:1girl|1boy|2girls|2boys|solo|couple)\s*,\s*)+", re.IGNORECASE)


def _couple_anchor_line(line, anchor):
    """Prefix a character line with the pair's composition anchor.

    Empirically (anima turbo lane, 2026-07-22): regional masks steer per-area
    attributes but only a composition tag on every line makes TWO characters
    appear — without it the regions blend into one subject. Leading solo/pair
    tags are stripped first so user-typed "1girl, ..." doesn't fight the pair.
    """
    return f"{anchor}, {_COUPLE_SOLO_TAG_PREFIX.sub('', str(line)).strip()}"


def _auto_bypass_regional_prompt_node(graph, node_id, prompt, negative):
    """Single-subject default for regional/couple graphs (couple mode off).

    Splices the regional-prompt node out of the graph: the sampler's model is
    rewired to the node's upstream model and its conditioning is replaced by
    full-canvas CLIPTextEncode nodes on the same CLIP — including a real
    negative encode, so cfg behaves normally. Returns False when the node is
    referenced in a way that can't be rewired (caller falls back to padding).
    """
    node = graph.get(str(node_id)) or {}
    inputs = node.get("inputs") or {}
    model_ref = inputs.get("model")
    clip_ref = inputs.get("clip")
    if not (isinstance(model_ref, list) and isinstance(clip_ref, list)):
        return False
    ref_sites = []
    for other_id, other in graph.items():
        if str(other_id) == str(node_id):
            continue
        for key, value in (other.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(node_id):
                if int(value[1]) > 1:
                    return False  # auxiliary output (parsed prompt) we can't substitute
                ref_sites.append((other, key, int(value[1])))
    numeric_ids = [int(k) for k in graph if str(k).isdigit()]
    pos_id = str(max(numeric_ids or [0]) + 1)
    neg_id = str(max(numeric_ids or [0]) + 2)
    for other, key, output_index in ref_sites:
        if output_index == 0:
            other["inputs"][key] = list(model_ref)
        else:
            other["inputs"][key] = [neg_id if key == "negative" else pos_id, 0]
    graph[pos_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(prompt)}}
    graph[neg_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(negative or "")}}
    del graph[str(node_id)]
    return True


def _auto_split_regional_negative(graph, sampler_inputs, node_id, negative):
    """Give a regional-prompt graph a real negative conditioning input.

    Couple templates wire the sampler's negative to the SAME regional output
    as the positive, which turns cfg into a mathematical no-op (uncond ==
    cond). When the regional node stays in the graph, rewire negative to a
    plain CLIPTextEncode on the node's own CLIP — ComfyUI skips it entirely
    at cfg 1.0, and it provides real guidance above that.
    """
    node = graph.get(str(node_id)) or {}
    clip_ref = (node.get("inputs") or {}).get("clip")
    negative_ref = sampler_inputs.get("negative")
    if not isinstance(clip_ref, list):
        return False
    if not (isinstance(negative_ref, list) and negative_ref and str(negative_ref[0]) == str(node_id)):
        return False
    numeric_ids = [int(k) for k in graph if str(k).isdigit()]
    neg_id = str(max(numeric_ids or [0]) + 1)
    graph[neg_id] = {"class_type": "CLIPTextEncode", "inputs": {"clip": list(clip_ref), "text": str(negative or "")}}
    sampler_inputs["negative"] = [neg_id, 0]
    return True


def _auto_apply_model_loras(graph, sampler_inputs, resolved_loras):
    """Chain user LoRAs into an auto-workflow graph (model-only patches).

    Walks the sampler's model conditioning upstream to the edge right above
    the checkpoint/UNET loader and splices LoraLoaderModelOnly nodes there —
    upstream of any regional-prompt or template LoRA nodes, matching the
    established anima pattern. Returns how many LoRAs were applied.
    """
    if not resolved_loras:
        return 0
    holder = sampler_inputs
    for _ in range(len(graph) + 1):
        ref = holder.get("model")
        if not (isinstance(ref, list) and ref and str(ref[0]) in graph):
            return 0
        upstream_inputs = (graph[str(ref[0])].get("inputs") or {})
        if isinstance(upstream_inputs.get("model"), list):
            holder = upstream_inputs
            continue
        break
    lora_root = (COMFY / "models" / "loras").resolve()
    previous = list(holder["model"])
    next_id = max([int(k) for k in graph if str(k).isdigit()] or [0]) + 1
    applied = 0
    for item in resolved_loras:
        try:
            lora_name = str(Path(item["path"]).resolve().relative_to(lora_root))
        except Exception:
            lora_name = str(item.get("id") or "").strip()
        if not lora_name:
            continue
        graph[str(next_id)] = {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": previous, "lora_name": lora_name, "strength_model": float(item.get("strength", 1.0))},
        }
        previous = [str(next_id), 0]
        next_id += 1
        applied += 1
    if applied:
        holder["model"] = previous
    return applied


def _auto_apply_couple_regions(node, pos_key, prompt, options):
    """Couple mode: map prompt lines to explicit regions via Advanced mapping.

    Line order: optional shared full-canvas scene line first (couple_shared),
    then one character line per region. couple_split is the first character's
    share of the canvas along couple_direction (horizontal = side by side,
    vertical = stacked); remaining characters divide the rest evenly.
    """
    inputs = node.setdefault("inputs", {})
    lines = [line.strip() for line in str(prompt).splitlines() if line.strip()] or [str(prompt).strip()]
    shared = bool(options.get("couple_shared")) and len(lines) >= 2
    shared_line = lines[0] if shared else None
    regions = lines[1:] if shared else list(lines)
    while len(regions) < 2:
        regions.append(regions[-1])
    anchor = _COUPLE_PAIR_ANCHORS.get(str(options.get("couple_pair") or "girls"), "2girls")
    regions = [_couple_anchor_line(region, anchor) for region in regions]
    split = options.get("couple_split")
    try:
        split = min(0.9, max(0.1, float(split)))
    except (TypeError, ValueError):
        split = 0.5
    vertical = str(options.get("couple_direction") or "").strip().lower() in ("vertical", "stacked", "vert")
    rows = []
    if shared_line is not None:
        try:
            weight = float(inputs.get("background_weight") or 0.3)
        except (TypeError, ValueError):
            weight = 0.3
        rows.append([0.0, 1.0, 0.0, 1.0, weight])
    bounds = [0.0, split]
    step = (1.0 - split) / max(1, len(regions) - 1)
    while len(bounds) < len(regions) + 1:
        bounds.append(bounds[-1] + step)
    bounds[-1] = 1.0
    for index in range(len(regions)):
        lo, hi = round(bounds[index], 4), round(bounds[index + 1], 4)
        rows.append([0.0, 1.0, lo, hi, 1.0] if vertical else [lo, hi, 0.0, 1.0, 1.0])
    inputs["mode"] = "Advanced"
    inputs["background"] = "None"
    inputs["advanced_mapping"] = json.dumps(rows)
    inputs[pos_key] = "\n".join(([shared_line] if shared_line is not None else []) + regions)


# ---- H3 Studio graphs -------------------------------------------------------
#
# The MiniMax H3 still-image lane is not a KSampler graph: one H3StudioDirector
# node owns prompt, canvas, seed, route and references, and the sampler is a
# SamplerCustomAdvanced fed from it. Everything below patches THAT node.
H3_STUDIO_DIRECTOR_CLASS = "H3StudioDirector"
# h3studio/constants.py MAX_REFERENCE_IMAGES. The Director declares
# media_{1..9}/media_filename_{1..9} optional inputs; collect_images() loads a
# reference from ComfyUI input storage when only the filename is set, so a
# headless graph needs no LoadImage nodes of its own.
H3_STUDIO_MAX_REFERENCES = 9


def _h3_studio_director_id(graph):
    """The Director node's id, or None when this is not an H3 Studio graph."""
    for node_id, node in (graph or {}).items():
        if isinstance(node, dict) and str(node.get("class_type")) == H3_STUDIO_DIRECTOR_CLASS:
            return str(node_id)
    return None


def _h3_studio_reference_names(options):
    """Ordered ComfyUI-input filenames for this run's references.

    Order is load-bearing: the compiler labels them <Picture 1>..<Picture N> by
    the same index the caller sent them in. The Director reads a reference by
    name out of ComfyUI's input storage, so anything staged elsewhere (a
    multipart upload lands in the gateway's own upload dir) is copied in —
    which is also what makes push_prompt_inputs_to_lane find it for a rental.
    """
    values = options.get("reference_image_paths") or []
    if len(values) > H3_STUDIO_MAX_REFERENCES:
        raise RuntimeError(f"H3 Studio accepts at most {H3_STUDIO_MAX_REFERENCES} reference images")
    comfy_input = COMFY_INPUT_DIR.resolve()
    names = []
    for value in values:
        path = Path(str(value)).expanduser().resolve()
        if not path.is_file():
            raise RuntimeError(f"reference image is missing: {path.name}")
        if not _is_under(path, comfy_input):
            comfy_input.mkdir(parents=True, exist_ok=True)
            staged = comfy_input / safe_name(path.name)
            staged.write_bytes(path.read_bytes())
            path = staged
        names.append(path.name)
    return names


def _h3_studio_megapixels(options):
    """Canvas AREA for the Director, which sizes from aspect_ratio + megapixels.

    An explicit width+height is exact and routes through aspect_ratio "custom"
    instead. Otherwise the studio's Resolution tier (`base_size`, the short
    side) is what the user actually chose, so it is converted to the area the
    Director understands — dropping it would silently pin every H3 still to the
    graph's own default.
    """
    explicit = options.get("megapixels")
    if explicit is not None:
        return float_option(options, "megapixels", 1.0, 0.20, 8.50)
    short_side = int_option(options, "base_size", 0, 0, 8192)
    if short_side <= 0:
        return None
    ratio = _h3_studio_aspect_ratio(str(options.get("aspect_ratio") or "1:1"))
    long_side = round(short_side * ratio)
    return max(0.20, min(8.50, (short_side * long_side) / 1_000_000))


def _h3_studio_aspect_ratio(text):
    """Long-side / short-side for an "W:H" label; 1.0 when it cannot be read."""
    left, _, right = str(text or "").partition(":")
    try:
        width, height = float(left), float(right)
    except ValueError:
        return 1.0
    if width <= 0 or height <= 0:
        return 1.0
    return max(width, height) / min(width, height)


def _apply_h3_studio_director(graph, director_id, prompt, options, rec):
    """Drive an H3 Studio graph from a studio generation request.

    Only inputs the Director already declares are touched. Numeric ranges are
    clamped here (ComfyUI does not enforce widget min/max at submit); the enum
    widgets are passed through, because ComfyUI DOES validate combos and its
    rejection names the offending value better than a duplicated table here
    would.
    """
    inputs = graph[director_id].setdefault("inputs", {})

    if str(prompt or "").strip():
        inputs["prompt"] = str(prompt)

    seed = resolve_seed_option(options)
    # The Director owns the seed (RandomNoise reads its noise_seed output), and
    # its widget is unsigned — a negative would be clamped to 0 on the box.
    inputs["seed"] = max(0, int(seed))
    rec["options"]["seed"] = inputs["seed"]

    width = int_option(options, "width", 0, 0, 16384)
    height = int_option(options, "height", 0, 0, 16384)
    if width > 0 and height > 0:
        # plan_resolution() takes the RATIO from aspect_ratio (width/height
        # only when it is literally "custom") and the AREA from megapixels —
        # always, custom included. Both have to be set or the canvas silently
        # drifts: dimensions alone render the graph's 1:1 default, and a
        # "custom" ratio alone keeps the default area (1024x576 came back as
        # 1632x928 in exactly that case).
        inputs["width"] = width
        inputs["height"] = height
        inputs["aspect_ratio"] = "custom"
        inputs["megapixels"] = round(max(0.20, min(8.50, (width * height) / 1_000_000)), 2)
        rec["options"]["width"] = width
        rec["options"]["height"] = height
        rec["options"]["megapixels"] = inputs["megapixels"]
    else:
        requested_ratio = str(options.get("aspect_ratio") or "").strip()
        if requested_ratio:
            inputs["aspect_ratio"] = requested_ratio
            rec["options"]["aspect_ratio"] = requested_ratio
        megapixels = _h3_studio_megapixels(options)
        if megapixels is not None:
            inputs["megapixels"] = round(megapixels, 2)
            rec["options"]["megapixels"] = inputs["megapixels"]

    if options.get("adherence") is not None:
        inputs["adherence"] = float_option(options, "adherence", 0.85, 0.0, 1.0)
        rec["options"]["adherence"] = inputs["adherence"]
    for key in ("route", "sampling_profile", "frame_profile"):
        value = str(options.get(key) or "").strip()
        if value:
            inputs[key] = value
            rec["options"][key] = value

    # References. Every slot is written explicitly — including the empty ones —
    # so a re-used graph cannot carry a previous run's filename, and the
    # ordinals stay dense from 1.
    names = _h3_studio_reference_names(options)
    for ordinal in range(1, H3_STUDIO_MAX_REFERENCES + 1):
        name = names[ordinal - 1] if ordinal <= len(names) else ""
        inputs[f"media_filename_{ordinal}"] = name
        inputs[f"media_type_{ordinal}"] = "image"
    if names:
        rec["reference_images"] = len(names)
        # 1 reference resolves to image_to_image (FL2VA first-frame anchor) and
        # 2+ to reference_edit (REF2VA) unless the caller pinned `route`. That
        # is the node's own auto-routing, recorded so the history says which
        # path a run actually took.
        rec["options"].setdefault("route", str(inputs.get("route") or "auto"))
    return names


def run_comfy_api_image(job_id, prompt, options=None):
    """Generic runner for auto-detected API-format ComfyUI image workflows.

    The template graph keeps its own tuned defaults; only explicitly provided
    options (prompt, negative, seed, steps, cfg, dimensions) are patched in.
    Lane selection reuses the shared checkpoint-name router, so e.g. waiANIMA
    graphs land on the anima lane automatically.
    """
    started = now_iso()
    options = _normalize_couple_options(dict(options or {}))
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-api-image",
        "created_at": started,
        "outputs": [],
        "options": {k: v for k, v in options.items() if k not in ("negative_prompt", "workflow_file", "loras")},
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        workflow_path, graph = _load_auto_api_workflow(options.get("workflow_file"))
        rec["workflow"] = workflow_path.stem

        director_id = _h3_studio_director_id(graph)
        if director_id:
            # An H3 Studio graph: one Director owns prompt/canvas/seed/route
            # and the references, so none of the KSampler patching below
            # applies (its sampler is a SamplerCustomAdvanced with no
            # positive/negative inputs to follow).
            _apply_h3_studio_director(graph, director_id, prompt, options, rec)
        else:
            sampler = next(
                (node for node in graph.values() if str(node.get("class_type")) in _AUTO_SAMPLER_CLASSES),
                None,
            )
            if sampler is None:
                raise RuntimeError(f"{workflow_path.name} has no KSampler node to drive")
            sampler_inputs = sampler.setdefault("inputs", {})

            seed = resolve_seed_option(options)
            for seed_key in ("seed", "noise_seed"):
                if seed_key in sampler_inputs:
                    sampler_inputs[seed_key] = seed
                    rec["options"]["seed"] = seed
                    break
            if options.get("steps"):
                sampler_inputs["steps"] = int_option(options, "steps", int(sampler_inputs.get("steps") or 8), 1, 60)
            if options.get("cfg") is not None or options.get("guidance") is not None:
                default_cfg = float(sampler_inputs.get("cfg") or 1.0)
                sampler_inputs["cfg"] = float_option(options, "cfg", float_option(options, "guidance", default_cfg, 0.0, 20.0), 0.0, 20.0)

            # Positive prompt: follow the sampler's positive conditioning upstream.
            positive_ref = sampler_inputs.get("positive")
            pos_node_id, pos_key = _auto_find_text_node(graph, positive_ref[0]) if isinstance(positive_ref, list) and positive_ref else (None, None)
            if pos_node_id is None:
                raise RuntimeError(f"{workflow_path.name} has no reachable prompt text node")
            negative = str(options.get("negative_prompt") or "").strip()
            regional = "advanced_mapping" in (graph[pos_node_id].get("inputs") or {})
            couple_on = bool(options.get("couple_mode"))
            negative_handled = False
            if regional and couple_on:
                _auto_apply_couple_regions(graph[pos_node_id], pos_key, prompt, options)
                rec["couple_mode"] = True
                if _auto_split_regional_negative(graph, sampler_inputs, pos_node_id, negative):
                    negative_handled = True
            elif regional and str(prompt or "").strip():
                # Couple/regional graphs run single-subject by default: splice the
                # regional node out for full-canvas conditioning; regions only
                # when couple mode is explicitly enabled.
                if _auto_bypass_regional_prompt_node(graph, pos_node_id, prompt, negative):
                    rec["couple_bypassed"] = True
                    negative_handled = True
                else:
                    graph[pos_node_id]["inputs"][pos_key] = _auto_fit_regional_prompt(graph[pos_node_id], prompt)
                    if _auto_split_regional_negative(graph, sampler_inputs, pos_node_id, negative):
                        negative_handled = True
            elif str(prompt or "").strip():
                graph[pos_node_id]["inputs"][pos_key] = str(prompt)

            # Negative prompt: only when it resolves to a DIFFERENT node (regional
            # prompt nodes expose positive+negative from one node — leave those).
            negative_ref = sampler_inputs.get("negative")
            if not negative_handled and negative and isinstance(negative_ref, list) and negative_ref:
                neg_node_id, neg_key = _auto_find_text_node(graph, negative_ref[0])
                if neg_node_id is not None and neg_node_id != pos_node_id:
                    graph[neg_node_id]["inputs"][neg_key] = negative

            # User LoRAs: validated against the local catalog, chained above the
            # model loader. Only the count is recorded — names stay client-side.
            requested_loras = options.get("loras") or []
            if requested_loras:
                resolved = resolve_lora_selection(requested_loras)
                applied = _auto_apply_model_loras(graph, sampler_inputs, resolved)
                if applied:
                    rec["loras_applied"] = applied

            # Dimensions: patch every node that carries a width+height pair so
            # latent size and regional-prompt canvases stay consistent.
            width = int(options.get("width") or 0)
            height = int(options.get("height") or 0)
            if width > 0 and height > 0:
                for node in graph.values():
                    inputs = node.get("inputs") or {}
                    if isinstance(inputs.get("width"), (int, float)) and isinstance(inputs.get("height"), (int, float)):
                        inputs["width"] = width
                        inputs["height"] = height
                rec["options"]["width"] = width
                rec["options"]["height"] = height

        body = json.dumps({"prompt": graph})
        lane_name = comfy_lane_for_prompt_body(body, run_on=options.get('run_on'))
        lane_url = COMFY_LANES.get(lane_name, COMFY_HTTP_DEFAULT)
        rec["lane"] = lane_url
        # A rented lane's outputs never touch this disk, so the local
        # history/collect path below cannot see them. Remote runs go through
        # the same push -> route -> sealed-harvest flow as the /comfy proxy.
        remote = comfy_lane_is_remote(lane_name)
        pushed_inputs = []
        if remote:
            transport_error = comfy_lane_transport_error(lane_name) or comfy_lane_liveness_error(lane_name)
            if transport_error:
                raise RuntimeError(transport_error)
            if not vault_public_key_spki():
                raise RuntimeError(
                    f"lane '{lane_name}' is remote and its outputs must be sealed: create the owner vault first"
                )
            pushed_inputs = push_prompt_inputs_to_lane(body, lane_name)
        t0 = time.monotonic()
        client_id = f"zimage-auto-{job_id}"
        try:
            queued = _auto_submit_prompt(lane_url, graph, client_id)
        except HTTPError as exc:
            error_payload = exc.read().decode("utf-8", errors="replace")
            if exc.code != 400 or not _auto_fill_missing_required_inputs(graph, error_payload, lane_url):
                raise RuntimeError(f"ComfyUI rejected the workflow: {error_payload[:500]}") from exc
            rec["healed_inputs"] = True
            queued = _auto_submit_prompt(lane_url, graph, client_id)
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec
        if remote:
            record_comfy_prompt_route(
                prompt_id, lane_name, pushed_inputs=pushed_inputs, client_id=client_id,
            )
            # Watched inline rather than on a daemon thread: this IS the job's
            # worker, and the watcher already owns harvest, scrub and the
            # failure record.
            route = watch_remote_comfy_prompt(prompt_id) or {}
            if route.get("status") != "harvested":
                raise RuntimeError(route.get("error") or "remote generation did not complete")
            logical_names = [str(name) for name in route.get("outputs") or []]
            outputs = [str(path) for path in map(find_output_logical_path, logical_names) if path]
            if not outputs:
                raise RuntimeError("remote workflow completed without output images")
        else:
            history = None
            for _ in range(300):
                time.sleep(2)
                try:
                    payload = urlopen(f"{lane_url}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                    data = json.loads(payload or "{}")
                    if prompt_id in data:
                        history = data[prompt_id]
                        break
                except Exception:
                    pass
            if history is None:
                raise RuntimeError(f"auto workflow timed out waiting for prompt {prompt_id}")
            status = history.get("status") or {}
            if status.get("status_str") != "success" or not status.get("completed"):
                raise RuntimeError(f"auto workflow failed: {status}")
            outputs = []
            for node_out in (history.get("outputs") or {}).values():
                for img in node_out.get("images") or []:
                    name = safe_name(img.get("filename") or "")
                    subfolder = img.get("subfolder") or ""
                    typ = img.get("type") or "output"
                    root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                    p = (root / subfolder / name).resolve()
                    # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                    # before this check runs — any sealed form counts as existing.
                    if existing_output_path(p):
                        outputs.append(str(p))
            if not outputs:
                raise RuntimeError("auto workflow completed without output images")
            logical_names = [Path(p).name for p in outputs]
        # Record the vault-sealed setup so "Load in Studio" can recover the exact
        # prompt/seed/model for a studio output (which carries no mobile envelope).
        try:
            record_studio_workflow_setup(logical_names, graph, rec.get("comfy_prompt_id"), rec.get("workflow"))
        except Exception as exc:
            print(f"[workflow-index] studio record skipped: {exc}", file=sys.stderr)
        # A harvested remote output is already a sealed envelope; sealing it
        # again would wrap the envelope, not the image.
        if not remote:
            outputs = encrypt_outputs(outputs, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as e:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _krea2_sampler_choice(options):
    """Resolve (sampler, scheduler) exactly like the graph compiler does.

    Kept in sync so the job record shows the pair that actually ran — the
    low-step default swap is otherwise invisible from the history.
    """
    options = options or {}
    steps = int_option(options, "steps", 10, 1, 50)
    sampler, scheduler = krea2_sampler_defaults(steps)
    requested_sampler = str(options.get("sampler_name") or "").strip()
    requested_scheduler = str(options.get("scheduler") or "").strip()
    if requested_sampler in KREA2_SAMPLERS:
        sampler = requested_sampler
    if requested_scheduler in KREA2_SCHEDULERS:
        scheduler = requested_scheduler
    return sampler, scheduler


def run_comfy_krea2_identity(job_id, prompt, image_path=None, options=None):
    started = now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-turbo-identity-edit",
        "created_at": started,
        "outputs": [],
        "mode": "identity-edit" if image_path else "text-to-image",
        "options": {
            "width": int_option(options, "width", 1024, 64, 4096),
            "height": int_option(options, "height", 1024, 64, 4096),
            "steps": int_option(options, "steps", 10, 1, 50),
            "cfg": float_option(options, "cfg", float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0),
            "seed": resolve_seed_option(options),
            "sampler_name": _krea2_sampler_choice(options)[0],
            "scheduler": _krea2_sampler_choice(options)[1],
            "ref_boost": float_option(options, "ref_boost", 4.0, 0.0, 1000.0),
            "identity_strength": float_option(options, "identity_strength", 1.0, -10.0, 10.0),
            "grounding_px": int_option(options, "grounding_px", 768, 0, 4096),
            "cache_static_tokens": bool_option(options, "cache_static_tokens", True),
            "loras": [
                {
                    "id": str(item.get("id") or ""),
                    "strength": float_option(item, "strength", 1.0, LORA_STRENGTH_MIN, LORA_STRENGTH_MAX),
                }
                for item in (options.get("loras") or [])
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        input_name = None
        if image_path:
            image_path = Path(image_path).expanduser().resolve()
            allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
            if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            input_name = safe_name(image_path.name)
            comfy_input = (COMFY_INPUT_DIR / input_name).resolve()
            if comfy_input != image_path:
                comfy_input.write_bytes(image_path.read_bytes())

        filename_prefix = f"krea2_identity_{job_id}"
        api_prompt = build_krea2_turbo_identity_prompt(
            prompt,
            image_name=input_name,
            options=rec["options"],
            filename_prefix=filename_prefix,
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-krea2-{job_id}"}).encode("utf-8")
        t0 = time.monotonic()
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected Krea2 identity graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI Krea2 identity generation timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"ComfyUI Krea2 identity generation failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("ComfyUI Krea2 identity generation completed without output images")
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _compose_labeled_sheet(sheet_path, rows, cols, square, tiles, header_lines, tag="sheet"):
    """Compose a labeled tile sheet from staged plaintext tiles via the venv
    python (PIL lives there, like media_seal.py). Returns the sheet path or
    None — a missing sheet degrades the job, it does not fail it."""
    if not tiles:
        return None
    sheet_path = Path(sheet_path)
    manifest = {
        "output": str(sheet_path),
        "rows": rows,
        "cols": cols,
        "square": square,
        "header_lines": header_lines,
        "tiles": tiles,
    }
    composer = Path(__file__).resolve().parent / "bin" / "compose-strength-hunt-sheet.py"
    try:
        proc = subprocess.run(
            [E2E_SEAL_PYTHON, str(composer)],
            input=json.dumps(manifest),
            text=True,
            capture_output=True,
            timeout=300,
        )
        if proc.returncode == 0 and sheet_path.exists():
            return sheet_path
        print(f"[{tag}] sheet composer failed: {proc.stderr[-1000:]}", file=sys.stderr)
    except Exception as exc:
        print(f"[{tag}] sheet composer error: {exc}", file=sys.stderr)
    return None


def _strength_hunt_compose_sheet(job_id, plan, tiles, header_lines):
    return _compose_labeled_sheet(
        COMFY_OUTPUT_DIR / f"strhunt_{job_id}_sheet.png",
        plan["rows"],
        plan["cols"],
        plan["rows"] == 1 and len(tiles) > 4,
        tiles,
        header_lines,
        tag="strength-hunt",
    )


def run_comfy_krea2_strength_hunt(job_id, prompt, image_path=None, options=None, hunt=None):
    """Sweep 1-2 LoRA strengths over a FIXED prompt+seed (Mix-Studio's Strength
    Hunt, translated). Portable/CUDA profiles pack every variant into ONE merged
    ComfyUI prompt (shared loaders run once); apple-silicon submits variants
    sequentially because its LoRA stack is baked into the quantized loader
    (MultiLoRAStackToPreLora) — a merged graph would load N model instances.
    Outputs: labeled comparison sheet first, then every variant, all sealed."""
    started = now_iso()
    options = options or {}
    hunt = hunt or {}
    normalized = {
        "width": int_option(options, "width", 1024, 64, 4096),
        "height": int_option(options, "height", 1024, 64, 4096),
        "steps": int_option(options, "steps", 10, 1, 50),
        "cfg": float_option(options, "cfg", float_option(options, "guidance", 1.0, 0.0, 20.0), 0.0, 20.0),
        # One resolve up front: every variant must share the exact same seed.
        "seed": resolve_seed_option(options),
        "sampler_name": _krea2_sampler_choice(options)[0],
        "scheduler": _krea2_sampler_choice(options)[1],
        "ref_boost": float_option(options, "ref_boost", 4.0, 0.0, 1000.0),
        "identity_strength": float_option(options, "identity_strength", 1.0, -10.0, 10.0),
        "grounding_px": int_option(options, "grounding_px", 768, 0, 4096),
        "cache_static_tokens": bool_option(options, "cache_static_tokens", True),
        "loras": [
            {
                "id": str(item.get("id") or ""),
                "strength": float_option(item, "strength", 1.0, LORA_STRENGTH_MIN, LORA_STRENGTH_MAX),
            }
            for item in (options.get("loras") or [])
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        ],
    }
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-strength-hunt",
        "created_at": started,
        "outputs": [],
        "mode": "identity-edit" if image_path else "text-to-image",
        "options": normalized,
    }
    with jobs_lock:
        jobs[job_id] = rec
    staging_dir = None
    try:
        plan = build_strength_hunt_plan(normalized["loras"], hunt.get("lora_ids") or [])
        profile = accelerator_profile()
        if profile == "apple-silicon" and len(plan["variants"]) > 36:
            raise RuntimeError(
                f"{len(plan['variants'])} variants would each requantize the Krea2 loader on apple-silicon; "
                "lower the swept strengths to 36 variants or run on a CUDA lane"
            )
        rec["strength_hunt"] = {
            "axes": [{"id": axis["id"], "values": axis["values"]} for axis in plan["axes"]],
            "rows": plan["rows"],
            "cols": plan["cols"],
            "variants": len(plan["variants"]),
            "merged": profile != "apple-silicon",
        }
        with jobs_lock:
            jobs[job_id] = rec

        input_name = None
        if image_path:
            image_path = Path(image_path).expanduser().resolve()
            allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
            if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            input_name = safe_name(image_path.name)
            comfy_input = (COMFY_INPUT_DIR / input_name).resolve()
            if comfy_input != image_path:
                comfy_input.write_bytes(image_path.read_bytes())

        t0 = time.monotonic()
        graphs = []
        for variant in plan["variants"]:
            variant_options = dict(normalized, loras=variant["loras"])
            graphs.append(build_krea2_turbo_identity_prompt(
                prompt,
                image_name=input_name,
                options=variant_options,
                # The filename index is the ordering contract: completion maps
                # arrival order back to grid position through this marker.
                filename_prefix=f"strhunt_{job_id}_strength_hunt_{variant['index']:03d}",
            ))

        def submit_and_wait(api_prompt, label, poll_loops):
            body = json.dumps({"prompt": api_prompt, "client_id": f"media-strhunt-{job_id}"}).encode("utf-8")
            req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
            try:
                queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
            except HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"ComfyUI rejected strength hunt graph ({label}): {detail[:4000]}") from exc
            prompt_id = queued.get("prompt_id")
            if not prompt_id:
                raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
            for _ in range(poll_loops):
                time.sleep(2)
                try:
                    payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                    data = json.loads(payload or "{}")
                    if prompt_id in data:
                        history = data[prompt_id]
                        status = history.get("status") or {}
                        if status.get("status_str") != "success" or not status.get("completed"):
                            raise RuntimeError(f"strength hunt {label} failed: {status}")
                        return history
                except RuntimeError:
                    raise
                except Exception:
                    pass
            raise RuntimeError(f"strength hunt {label} timed out waiting for prompt {prompt_id}")

        histories = []
        if profile == "apple-silicon":
            for i, graph in enumerate(graphs):
                histories.append(submit_and_wait(graph, f"variant {i + 1}/{len(graphs)}", 450))
                rec["strength_hunt"]["completed"] = i + 1
                with jobs_lock:
                    jobs[job_id] = rec
        else:
            merged = merge_strength_hunt_graphs(graphs)
            histories.append(submit_and_wait(merged, f"merged x{len(graphs)}", 450 + 60 * len(graphs)))

        # Collect ordered outputs; capture plaintext bytes NOW — the privacy
        # sweeper may seal (or the E2E sweeper envelope) them at any moment,
        # and .e2e envelopes are unreadable server-side by design.
        indexed = {}
        for history in histories:
            for node_out in (history.get("outputs") or {}).values():
                for image in node_out.get("images") or []:
                    name = safe_name(image.get("filename") or "")
                    index = strength_hunt_output_index(name)
                    if index is None:
                        continue
                    subfolder = image.get("subfolder") or ""
                    typ = image.get("type") or "output"
                    root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                    path = (root / subfolder / name).resolve()
                    if existing_output_path(path):
                        indexed[index] = path
        if not indexed:
            raise RuntimeError("strength hunt completed without any variant outputs")

        staging_dir = Path(tempfile.mkdtemp(prefix=f"strhunt-{job_id}-"))
        tiles = []
        axis_label = {axis["id"]: Path(axis["id"]).stem for axis in plan["axes"]}
        for variant in plan["variants"]:
            path = indexed.get(variant["index"])
            if path is None:
                continue
            label = " · ".join(
                f"{axis_label[axis_id]} {value}" for axis_id, value in variant["coords"].items()
            )
            try:
                data, _mime = decrypt_output_bytes(logical_path_for_encrypted(path))
            except Exception:
                continue  # sealed to .e2e before we got here — skip its tile
            staged = staging_dir / f"tile_{variant['index']:03d}.png"
            staged.write_bytes(data)
            tiles.append({"path": str(staged), "label": label, "index": variant["index"]})

        axis_text = " x ".join(
            f"{axis_label[axis['id']]} (MAX {axis['values'][-1]})" for axis in plan["axes"]
        )
        header_lines = [
            f"STRENGTH HUNT · SEED {normalized['seed']} · CFG {normalized['cfg']} · STEPS {normalized['steps']}",
            f"AXIS {axis_text} · {len(plan['variants'])} variants",
            (prompt or "")[:200],
        ]
        sheet_path = _strength_hunt_compose_sheet(job_id, plan, tiles, header_lines)

        ordered_outputs = [str(indexed[index]) for index in sorted(indexed)]
        final_outputs = ([str(sheet_path)] if sheet_path else []) + ordered_outputs
        rec["strength_hunt"]["sheet"] = bool(sheet_path)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(final_outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def run_comfy_krea2_outpaint(job_id, prompt, image_path, options=None, outpaint=None):
    """User-facing canvas expansion (Mix-Studio port): the source keeps its
    pixels, centered on a larger canvas whose missing border is sampled by the
    shared pixel-preserving Krea2 outpaint graph (the same one the LTX anchor
    pipeline trusts), then the source is composited back over the result."""
    started = now_iso()
    options = options or {}
    outpaint = outpaint or {}
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-outpaint",
        "created_at": started,
        "outputs": [],
        "mode": "outpaint",
        "options": {
            "width": int_option(outpaint, "width", 0, 64, 4096),
            "height": int_option(outpaint, "height", 0, 64, 4096),
            "steps": int_option(options, "steps", 10, 1, 50),
            "seed": resolve_seed_option(options),
            "feathering": int_option(outpaint, "feathering", 48, 0, 256),
            # Placement of the source on the grown canvas: 0=start, 0.5=center,
            # 1=end per axis (Mix-Studio outpaint-plan port).
            "offset_x": float_option(outpaint, "offset_x", 0.5, 0.0, 1.0),
            "offset_y": float_option(outpaint, "offset_y", 0.5, 0.0, 1.0),
        },
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        if not image_path:
            raise RuntimeError("outpaint requires a source image")
        image_path = Path(image_path).expanduser().resolve()
        allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        dimensions = _image_dimensions(image_path)
        if not dimensions:
            raise RuntimeError("could not read the source image dimensions")
        source_width, source_height = dimensions
        COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = safe_name(image_path.name)
        comfy_input = (COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())

        t0 = time.monotonic()
        compiled = build_krea2_turbo_outpaint_prompt(
            prompt or "",
            input_name,
            source_width=source_width,
            source_height=source_height,
            options={
                "width": rec["options"]["width"],
                "height": rec["options"]["height"],
                "seed": rec["options"]["seed"],
                "steps": rec["options"]["steps"],
                "cfg": 1.0,
                "ref_boost": 4.0,
                "identity_strength": 1.0,
                "grounding_px": 768,
                "feathering": rec["options"]["feathering"],
                "offset_x": rec["options"]["offset_x"],
                "offset_y": rec["options"]["offset_y"],
            },
            profile=accelerator_profile(),
            filename_prefix=f"krea2_outpaint_{job_id}",
            identity_checkpoint_available=(
                COMFY / "models" / "diffusion_models" / KREA2_IDENTITY_CONVROT_MODEL
            ).is_file(),
        )
        geometry = compiled["geometry"]
        rec["geometry"] = geometry
        if geometry["mode"] != "outpaint":
            raise RuntimeError(
                "that target does not grow the canvas — it only resizes; use Upscale for more pixels "
                f"(source {source_width}x{source_height}, target {geometry['target_width']}x{geometry['target_height']})"
            )

        body = json.dumps({"prompt": compiled["graph"], "client_id": f"media-outpaint-{job_id}"}).encode("utf-8")
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the outpaint graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"outpaint timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"outpaint failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("outpaint completed without an output image")
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


COMFY_TEMP_DIR = Path(
    os.environ.get("COMFY_TEMP_DIR", str(Path.home() / ".comfy-private.noindex/temp"))
)


def resolve_comfy_temp_file(filename, subfolder=""):
    """Where ComfyUI actually put a temp output.

    ComfyUI appends its own "temp" segment to the directory it is given, so a
    file the history reports as `x.png` lives at `<COMFY_TEMP_DIR>/temp/x.png`
    on this stack — while a plain ComfyUI puts it directly in the root. Both
    layouts are checked rather than assumed; getting this wrong reads as "the
    graph produced nothing" even though it ran perfectly."""
    name = safe_name(str(filename or ""))
    if not name:
        return None
    sub = str(subfolder or "").strip().strip("/")
    root = COMFY_TEMP_DIR.expanduser().resolve()
    for base in (root / "temp", root):
        candidate = (base / sub / name) if sub else (base / name)
        try:
            candidate = candidate.resolve()
        except OSError:
            continue
        if _is_under(candidate, root) and candidate.is_file():
            return candidate
    return None


def run_sam3_smart_mask(job_id, image_path, options=None):
    """Segment an object out of an image and hand the mask straight back.

    This is the selection step of the masked edit: instead of painting the
    region, name it ("the jacket") or tap it, and SAM3 returns the exact
    silhouette for the existing inpaint path to use.

    The mask never becomes an output. It leaves the graph through PreviewImage
    into ComfyUI's temp directory, is read once, returned INLINE as a data URL,
    and deleted — so smart-select leaves nothing sealed in History and nothing
    plaintext on disk. The source image arrives already-decrypted from the
    browser, so this never needs the vault key."""
    started = now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "sam3-smart-mask",
        "created_at": started,
        "outputs": [],
        "mode": "text" if str(options.get("prompt") or "").strip() else "points",
    }
    with jobs_lock:
        jobs[job_id] = rec
    temp_files = []
    try:
        source = Path(image_path).expanduser().resolve()
        if not source.is_file():
            raise RuntimeError("smart-select source image is missing")
        COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        name = safe_name(source.name)
        staged = (COMFY_INPUT_DIR / name).resolve()
        if staged != source:
            staged.write_bytes(source.read_bytes())

        t0 = time.monotonic()
        api_prompt = build_sam3_mask_prompt(
            name,
            prompt=options.get("prompt") or "",
            points=options.get("points"),
            confidence=float_option(options, "confidence", 0.2, 0.05, 0.95),
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-smartmask-{job_id}"}).encode("utf-8")
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the smart-select graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        history = None
        # First run loads a 3.45GB checkpoint; warm runs are ~20s.
        for _ in range(300):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"smart-select timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success":
            raise RuntimeError(f"smart-select failed: {status}")

        mask_bytes = None
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                filename = str(image.get("filename") or "")
                if not filename:
                    continue
                candidate = resolve_comfy_temp_file(filename, image.get("subfolder"))
                if candidate is None:
                    continue
                temp_files.append(candidate)
                if mask_bytes is None:
                    mask_bytes = candidate.read_bytes()
        if not mask_bytes:
            raise RuntimeError("smart-select produced no mask — try naming the object differently")

        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
            # Inline: the browser composites this into the mask canvas straight
            # away, and nothing about the selection is written down anywhere.
            "mask_base64": "data:image/png;base64," + base64.b64encode(mask_bytes).decode("ascii"),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    finally:
        for path in temp_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
    # The mask rides back in memory only. Writing it to history.jsonl would put
    # a plaintext selection on disk forever — the one thing the temp-file dance
    # above exists to avoid — and bloat the log with megabytes of base64.
    append_history({key: value for key, value in rec.items() if key != "mask_base64"})
    with jobs_lock:
        jobs[job_id] = rec


def comfy_combo_options(entry):
    """The choices in a node's combo input, whichever schema it uses.

    V1 nodes put the list in element 0; V3 nodes put the literal string 'COMBO'
    there and move the choices into element 1's 'options'. Reading only element
    0 silently yields nothing for V3 nodes, which reads as "the model is not
    installed" when it is sitting right there on disk.
    """
    if not isinstance(entry, (list, tuple)) or not entry:
        return []
    if isinstance(entry[0], list):
        return entry[0]
    if len(entry) > 1 and isinstance(entry[1], dict):
        options = entry[1].get("options")
        if isinstance(options, list):
            return options
    return []


def comfy_model_catalog():
    """What ComfyUI is actually offering, per model folder.

    Read from a loader node's combo options rather than the filesystem, because
    that is the exact list the graph's names have to match — a file present on
    disk but not in the list (wrong folder, not yet rescanned) would otherwise
    look installed and then fail at validation.
    """
    sources = {
        "checkpoints": ("CheckpointLoaderSimple", "ckpt_name"),
        "loras": ("LoraLoaderModelOnly", "lora_name"),
        "text_encoders": ("LTXAVTextEncoderLoader", "text_encoder"),
        "latent_upscale_models": ("LatentUpscaleModelLoader", "model_name"),
    }
    catalog = {}
    for folder, (class_type, field) in sources.items():
        names = []
        try:
            payload = urlopen(f"{COMFY_HTTP_DEFAULT}/object_info/{class_type}", timeout=10).read()
            spec = json.loads(payload.decode("utf-8")).get(class_type) or {}
            entry = spec.get("input", {}).get("required", {}).get(field) or []
            names = [str(n) for n in comfy_combo_options(entry)]
        except Exception:
            names = []
        catalog[folder] = names
    return catalog


def run_ltx_director(job_id, project, options=None):
    """Render one window of an LTX Director timeline (Mix-Studio port).

    The timeline is validated before anything is queued — a bad segment reaches
    ComfyUI as an opaque node error, so `normalize_director_project` refusing it
    here with a sentence is the whole point of the data model. Referenced media
    and the required weights are both checked up front for the same reason.

    Unlike the studio's other video lanes this graph is built in code rather
    than patched from a workflow JSON, because the node takes a bundle of
    scalars that only make sense derived together (see ltx_director_graph)."""
    started = now_iso()
    options = dict(options or {})
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "ltx-director",
        "created_at": started,
        "outputs": [],
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        t0 = time.monotonic()
        options.setdefault("filename_prefix", f"ltx_director_{job_id}")
        options.setdefault("seed", resolve_seed_option(options))
        graph, meta = build_ltx_director_prompt(project, options)

        missing_media = director_missing_assets(meta["project"], str(COMFY_INPUT_DIR))
        if missing_media:
            raise RuntimeError(
                "these timeline files are not in the input directory: "
                + ", ".join(missing_media[:8])
            )
        missing_weights = missing_ltx_director_assets(comfy_model_catalog())
        if missing_weights:
            raise RuntimeError(
                "LTX Director is missing model files: " + ", ".join(missing_weights)
            )
        # Frames/duration are recorded before the run so a timeout still says
        # what was attempted.
        rec["options"] = {
            "frames": meta["frames"],
            "width": meta["width"],
            "height": meta["height"],
            "seconds": meta["seconds"],
            "seed": options["seed"],
        }

        body = json.dumps({"prompt": graph, "client_id": f"media-ltxdirector-{job_id}"}).encode("utf-8")
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=60).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the Director graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        history = None
        # A cold run loads a 27GB checkpoint plus a 13GB text encoder, so the
        # first render is minutes of loading before a single step.
        for _ in range(1800):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"LTX Director timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success":
            raise RuntimeError(f"LTX Director failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            # SaveVideo reports under "images" on some builds and "videos" on
            # others; take whichever the node actually produced.
            for item in (node_out.get("videos") or []) + (node_out.get("images") or []):
                name = safe_name(item.get("filename") or "")
                if not name:
                    continue
                subfolder = item.get("subfolder") or ""
                root = COMFY_OUTPUT_DIR if (item.get("type") or "output") == "output" else COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("LTX Director completed without producing a video")

        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def run_comfy_krea2_inpaint(job_id, prompt, image_path, mask_path, options=None):
    """Masked edit (Mix-Studio soft-inpaint port): the white-on-black mask PNG
    selects what changes. Flow-model-safe wiring — VAEEncode + SetLatentNoiseMask,
    never VAEEncodeForInpaint — and the untouched source is composited back
    outside the grown mask. Core ComfyUI nodes only."""
    started = now_iso()
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-krea2-inpaint",
        "created_at": started,
        "outputs": [],
        "mode": "inpaint",
        "options": {
            "steps": int_option(options, "steps", 10, 1, 50),
            "seed": resolve_seed_option(options),
            "mask_expand": int_option(options, "mask_expand", 14, 6, 32),
            "mask_influence": int_option(options, "mask_influence", 78, 25, 100),
            "loras": [
                {
                    "id": str(item.get("id") or ""),
                    "strength": float_option(item, "strength", 1.0, LORA_STRENGTH_MIN, LORA_STRENGTH_MAX),
                }
                for item in (options.get("loras") or [])
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ],
        },
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        staged = {}
        for label, source in (("source", image_path), ("mask", mask_path)):
            if not source:
                raise RuntimeError(f"inpaint requires a {label} image")
            source = Path(source).expanduser().resolve()
            allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
            if not any(str(source).startswith(str(root)) for root in allowed) or not source.exists():
                raise RuntimeError(f"{label} image is outside private image storage or does not exist")
            COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            name = safe_name(source.name)
            comfy_input = (COMFY_INPUT_DIR / name).resolve()
            if comfy_input != source:
                comfy_input.write_bytes(source.read_bytes())
            staged[label] = name

        t0 = time.monotonic()
        api_prompt = compile_krea2_turbo_inpaint_prompt(
            prompt,
            staged["source"],
            staged["mask"],
            options=dict(rec["options"], sampler_name=options.get("sampler_name"), scheduler=options.get("scheduler")),
            profile=accelerator_profile(),
            filename_prefix=f"krea2_inpaint_{job_id}",
        )
        body = json.dumps({"prompt": api_prompt, "client_id": f"media-inpaint-{job_id}"}).encode("utf-8")
        req = Request(f"{COMFY_HTTP_DEFAULT}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the inpaint graph: {detail[:4000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec

        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = urlopen(f"{COMFY_HTTP_DEFAULT}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"inpaint timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"inpaint failed: {status}")

        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                name = safe_name(image.get("filename") or "")
                subfolder = image.get("subfolder") or ""
                typ = image.get("type") or "output"
                root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                path = (root / subfolder / name).resolve()
                if existing_output_path(path):
                    outputs.append(str(path))
        if not outputs:
            raise RuntimeError("inpaint completed without an output image")
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


# Interpolation uploads carry whole clips as base64; the JSON cap that guards
# every other route would reject anything past ~18MB of video.
INTERPOLATE_MAX_BODY_BYTES = int(os.environ.get("MEDIA_GATEWAY_INTERPOLATE_MAX_BODY_BYTES", str(512 * 1024 * 1024)))
VIDEO_INLINE_MIMES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}


def stage_inline_video_base64(value):
    """Stage a browser-decrypted clip (data URL or raw base64) for processing."""
    if not isinstance(value, str) or not value.strip():
        return None
    encoded = value.strip()
    extension = ".mp4"
    if encoded.startswith("data:"):
        match = re.match(r"^data:(video/[a-zA-Z0-9.+-]+);base64,(.*)$", encoded, flags=re.DOTALL)
        if not match:
            raise ValueError("video_base64 must be raw base64 or a video data URL")
        mime, encoded = match.groups()
        extension = VIDEO_INLINE_MIMES.get(mime.lower(), ".mp4")
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("video_base64 is not valid base64") from exc
    if not payload:
        raise ValueError("video_base64 decoded to an empty clip")
    if len(payload) > 400 * 1024 * 1024:
        raise ValueError("decoded inline video exceeds 400MB")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f".rife-inline-{uuid.uuid4().hex[:16]}{extension}"
    target.write_bytes(payload)
    return target


def run_video_interpolation(job_id, video_path, options=None):
    """Proper RIFE frame interpolation (Practical-RIFE 4.25, Apple-MLX port —
    vendor/rife-mlx) as a post-process on a finished clip: 2x or 4x the frame
    rate, original audio remuxed untouched (duration is unchanged, only frames
    are inserted BETWEEN existing ones). Runs under the repo venv (MLX), so it
    works for clips from ANY lane — native MLX, local Comfy, or fetched-back
    rentals — and, like upscale, the input arrives already-decrypted from the
    browser, so this never needs the vault key."""
    started = now_iso()
    options = options or {}
    factor = 4 if int_option(options, "factor", 2, 2, 4) >= 4 else 2
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "rife-interpolation",
        "created_at": started,
        "outputs": [],
        "mode": f"{factor}x",
        "options": {"factor": factor},
    }
    with jobs_lock:
        jobs[job_id] = rec
    video_path = Path(video_path)
    output = None
    try:
        if not video_path.is_file():
            raise RuntimeError("interpolation input clip is missing")
        # Pyramid scale 0.5 keeps memory sane on very large frames (upstream's
        # 4K guidance); everything at or below ~1.5K stays full-scale.
        scale = "1.0"
        try:
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video_path)],
                text=True, capture_output=True, timeout=30,
            )
            dims = [int(v) for v in (probe.stdout or "").strip().split(",") if v.strip().isdigit()]
            if len(dims) == 2 and min(dims) >= 1536:
                scale = "0.5"
        except Exception:
            pass

        COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output = COMFY_OUTPUT_DIR / f"rife_{job_id}_{factor}x.mp4"
        t0 = time.monotonic()
        proc = subprocess.run(
            [
                E2E_SEAL_PYTHON, "-m", "rife_mlx.pipeline_mlx",
                "-i", str(video_path),
                "-o", str(output),
                "--multi", str(factor),
                "-s", scale,
            ],
            text=True,
            capture_output=True,
            timeout=int_option(options, "runtime_timeout_seconds", 1800, 120, 7200),
        )
        if proc.returncode != 0 or not output.is_file() or output.stat().st_size < 1000:
            detail = (proc.stderr or proc.stdout or "unknown rife-mlx error").strip()
            raise RuntimeError(f"RIFE interpolation failed: {detail[-1500:]}")
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs([str(output)], job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        if output is not None:
            output.unlink(missing_ok=True)
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    finally:
        video_path.unlink(missing_ok=True)
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def run_episode_save(job_id, video_path, options=None):
    """Store a chained episode the BROWSER assembled as a first-class output.

    The shots are E2E-sealed at rest, so only the client can read them and only
    the client can join them (see clipJoiner.js). That left the finished
    episode as a blob URL living in one tab: gone on reload, invisible to
    History, unreachable from any other surface. This is the missing half —
    the joined file is written into the normal output directory and sealed by
    the normal path, so it appears in History exactly like a generated clip.

    The clip arrives already-decrypted from the browser, the same round trip
    RIFE and upscale already make; nothing here needs the vault key."""
    started = now_iso()
    options = options or {}
    shots = int_option(options, "shots", 0, 0, 512)
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "episode-join",
        "created_at": started,
        "outputs": [],
        "options": {"shots": shots},
    }
    with jobs_lock:
        jobs[job_id] = rec
    video_path = Path(video_path)
    output = None
    try:
        if not video_path.is_file():
            raise RuntimeError("episode clip is missing")
        COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        output = COMFY_OUTPUT_DIR / f"episode_{job_id}.mp4"
        # Move, not copy: the staged input is a plaintext copy of the episode
        # and every extra one is another file the sweeper has to chase.
        shutil.move(str(video_path), str(output))
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs([str(output)], job_id=job_id),
        })
    except Exception as exc:
        if output is not None:
            output.unlink(missing_ok=True)
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    finally:
        video_path.unlink(missing_ok=True)
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def run_comfy_upscale(job_id, image_path, options=None):
    """Upscale an existing image. mode='fast' = R-ESRGAN 4x+ Anime6B only
    (~seconds); mode='max' = R-ESRGAN then a tiled Anima diffusion refine pass
    (adds detail, minutes on MPS). The input arrives already-decrypted from the
    browser (image_base64), so this never needs the vault key."""
    started = now_iso()
    options = options or {}
    mode = "max" if str(options.get("mode") or "fast").lower() == "max" else "fast"
    scale = float_option(options, "scale", 1.5, 1.0, 4.0)
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "comfy-upscale",
        "created_at": started,
        "outputs": [],
        "mode": mode,
        "options": {"scale": scale, "mode": mode},
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        image_path = Path(image_path).resolve()
        allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), COMFY_INPUT_DIR.resolve()]
        if not any(str(image_path).startswith(str(root)) for root in allowed) or not image_path.exists():
            raise RuntimeError("input image is outside private image storage or does not exist")
        COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
        input_name = safe_name(image_path.name)
        comfy_input = (COMFY_INPUT_DIR / input_name).resolve()
        if comfy_input != image_path:
            comfy_input.write_bytes(image_path.read_bytes())
        filename_prefix = f"upscale_{job_id}"
        # R-ESRGAN_x4plus is a 4x model; downscale to hit the requested net factor.
        esrgan_downscale = max(0.05, min(1.0, scale / 4.0))
        graph = {
            "1": {"class_type": "LoadImage", "inputs": {"image": input_name}},
            "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "RealESRGAN_x4plus_anime_6B.pth"}},
            "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]}},
            "4": {"class_type": "ImageScaleBy", "inputs": {"image": ["3", 0], "upscale_method": "bilinear", "scale_by": esrgan_downscale}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": filename_prefix}},
        }
        if mode == "max":
            # Re-encode the upscaled pixels (tiled = MPS-safe: the Anima WanVAE
            # overflows MPSGraph's INT_MAX on a full-frame encode) and run a
            # light Anima refine pass to hallucinate detail at the new size.
            prompt_text = str(options.get("prompt") or "masterpiece, best quality, highly detailed, anime coloring")
            negative = str(options.get("negative_prompt") or "worst quality, low quality, blurry, jpeg artifacts, lowres")
            refine_steps = int_option(options, "refine_steps", 16, 4, 40)
            refine_denoise = float_option(options, "refine_denoise", 0.4, 0.05, 0.8)
            seed = resolve_seed_option(options)
            graph.update({
                "10": {"class_type": "UNETLoader", "inputs": {"unet_name": "waiANIMA_v10Base10.safetensors", "weight_dtype": "default"}},
                "11": {"class_type": "CLIPLoader", "inputs": {"clip_name": "waiANIMA_v10Base10_txt.safetensors", "type": "stable_diffusion", "device": "default"}},
                "12": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
                "13": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 0], "text": prompt_text}},
                "14": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["11", 0], "text": negative}},
                "15": {"class_type": "VAEEncodeTiled", "inputs": {"pixels": ["4", 0], "vae": ["12", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
                "16": {"class_type": "KSampler", "inputs": {"model": ["10", 0], "positive": ["13", 0], "negative": ["14", 0], "latent_image": ["15", 0], "seed": seed, "steps": refine_steps, "cfg": 4.0, "sampler_name": "er_sde", "scheduler": "simple", "denoise": refine_denoise}},
                "17": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["16", 0], "vae": ["12", 0], "tile_size": 512, "overlap": 64, "temporal_size": 64, "temporal_overlap": 8}},
            })
            graph["9"]["inputs"]["images"] = ["17", 0]
        body = json.dumps({"prompt": graph, "client_id": f"media-upscale-{job_id}"}).encode("utf-8")
        lane_url = comfy_http_for_prompt_body(body, run_on=options.get('run_on'))
        rec["lane"] = lane_url
        t0 = time.monotonic()
        req = Request(f"{lane_url}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(urlopen(req, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the upscale graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")
        rec["comfy_prompt_id"] = prompt_id
        with jobs_lock:
            jobs[job_id] = rec
        history = None
        for _ in range(450):
            time.sleep(2)
            try:
                payload = urlopen(f"{lane_url}/history/{prompt_id}", timeout=10).read().decode("utf-8")
                data = json.loads(payload or "{}")
                if prompt_id in data:
                    history = data[prompt_id]
                    break
            except Exception:
                pass
        if history is None:
            raise RuntimeError(f"ComfyUI upscale timed out waiting for prompt {prompt_id}")
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise RuntimeError(f"ComfyUI upscale failed: {status}")
        outputs = []
        for node_out in (history.get("outputs") or {}).values():
            for img in node_out.get("images") or []:
                name = safe_name(img.get("filename") or "")
                subfolder = img.get("subfolder") or ""
                typ = img.get("type") or "output"
                root = COMFY_OUTPUT_DIR if typ == "output" else COMFY_INPUT_DIR
                p = (root / subfolder / name).resolve()
                # The privacy sweeper may seal the plaintext (.zenc or .e2e)
                # before this check runs — any sealed form counts as existing.
                if existing_output_path(p):
                    outputs.append(str(p))
        if not outputs:
            raise RuntimeError("ComfyUI upscale completed without output images")
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": encrypt_outputs(outputs, job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
        })
    except Exception as exc:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(exc)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _node_inputs(node):
    return node.get('inputs') if isinstance(node, dict) and isinstance(node.get('inputs'), dict) else {}


def _linked_node_key(value):
    if isinstance(value, list) and value:
        key = value[0]
        if isinstance(key, (str, int)):
            return str(key)
    return None


def _find_linked_prompt_node(nodes_by_id, start_value, predicate):
    start = _linked_node_key(start_value)
    if not start:
        return None
    queue = [start]
    seen = set()
    while queue:
        key = queue.pop(0)
        if key in seen:
            continue
        seen.add(key)
        node = nodes_by_id.get(key)
        if not isinstance(node, dict):
            continue
        if predicate(node):
            return node
        for value in _node_inputs(node).values():
            nxt = _linked_node_key(value)
            if nxt and nxt not in seen:
                queue.append(nxt)
    return None


def _collect_linked_load_image_names(nodes_by_id, start_value, seen=None):
    key = _linked_node_key(start_value)
    if not key:
        return []
    seen = seen or set()
    if key in seen:
        return []
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return []
    inputs = _node_inputs(node)
    if node.get('class_type') == 'LoadImage':
        image_name = _prompt_string(inputs.get('image'))
        return [image_name] if image_name else []
    names = []
    for value in inputs.values():
        names.extend(_collect_linked_load_image_names(nodes_by_id, value, seen))
    return names


def _native_reference_image_names(nodes_by_id, nodes, sampler_inputs):
    names = []
    # Flux.2 editor workflows often attach reference images through conditioning
    # nodes with a `pixels` input. Preserve those, including intentional repeats.
    for node in nodes:
        inputs = _node_inputs(node)
        if 'pixels' in inputs:
            names.extend(_collect_linked_load_image_names(nodes_by_id, inputs.get('pixels')))
    if not names and sampler_inputs:
        names.extend(_collect_linked_load_image_names(nodes_by_id, sampler_inputs.get('latent_image')))
    if not names:
        for node in nodes:
            if node.get('class_type') == 'LoadImage':
                image_name = _prompt_string(_node_inputs(node).get('image'))
                if image_name:
                    names.append(image_name)
                    break
    return names[:BIGLOVE_KLEIN3_MAX_REFERENCES]


def _prompt_string(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def _prompt_number(value, default=None):
    try:
        if value in (None, ''):
            return default
        n = float(value)
        return n if n == n else default
    except Exception:
        return default


def _resolve_prompt_string(nodes_by_id, value, default=None, seen=None):
    direct = _prompt_string(value)
    if direct is not None:
        return direct
    link = _prompt_link(value)
    if not link:
        return default
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return default
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return default
    inputs = _node_inputs(node)
    class_type = str(node.get('class_type') or '')
    if class_type in {'PrimitiveString', 'PrimitiveStringMultiline', 'StringLiteral'}:
        return _prompt_string(inputs.get('value') if 'value' in inputs else inputs.get('text')) or default
    for name in ('text', 'prompt', 'value'):
        if name in inputs:
            resolved = _resolve_prompt_string(nodes_by_id, inputs.get(name), default=None, seen=seen)
            if resolved:
                return resolved
    return default


def _resolve_prompt_audio_seconds(nodes_by_id, value, seen=None):
    link = _prompt_link(value)
    if not link:
        return None
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return None
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return None
    inputs = _node_inputs(node)
    class_type = str(node.get('class_type') or '')
    if class_type in {'LoadAudio', 'VHS_LoadAudio'}:
        audio_name = _prompt_string(inputs.get('audio') or inputs.get('audio_path'))
        if not audio_name:
            return None
        audio_path = Path(audio_name)
        if not audio_path.is_absolute():
            audio_path = COMFY_INPUT_DIR / audio_name
        if not audio_path.exists():
            return None
        try:
            out = subprocess.check_output(
                [
                    'ffprobe',
                    '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    str(audio_path),
                ],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).strip()
            seconds = float(out)
            return seconds if seconds == seconds and seconds > 0 else None
        except Exception:
            return None
    for candidate in inputs.values():
        seconds = _resolve_prompt_audio_seconds(nodes_by_id, candidate, seen=seen)
        if seconds is not None:
            return seconds
    return None


def _prompt_link(value):
    if isinstance(value, list) and len(value) >= 2:
        key = value[0]
        slot = value[1]
        if isinstance(key, (str, int)):
            try:
                return str(key), int(slot)
            except Exception:
                return str(key), 0
    return None


def _is_biglove_klein3_model_name(name):
    raw = str(name or '').lower()
    compact = re.sub(r'[^a-z0-9]+', '', raw)
    return (
        'biglove' in compact
        and 'klein3' in compact
        and any(marker in raw or marker in compact for marker in ['mxfp8', 'fp8', 'float8', 'e4m3', 'e5m2', 'swift_mapped_mlx', 'mlx_native'])
    )


def _image_dimensions(path):
    p = Path(path)
    if not p.exists():
        return None
    ffprobe = shutil.which('ffprobe')
    if ffprobe:
        try:
            payload = subprocess.check_output(
                [
                    ffprobe, '-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height', '-of', 'json', str(p),
                ],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            stream = (json.loads(payload or '{}').get('streams') or [{}])[0]
            width, height = int(stream.get('width') or 0), int(stream.get('height') or 0)
            if width > 0 and height > 0:
                return width, height
        except Exception:
            pass
    try:
        out = subprocess.check_output(
            ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', str(p)],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        width = height = None
        for line in out.splitlines():
            if 'pixelWidth:' in line:
                width = int(line.rsplit(':', 1)[1].strip())
            elif 'pixelHeight:' in line:
                height = int(line.rsplit(':', 1)[1].strip())
        if width and height:
            return width, height
    except Exception:
        pass
    return None


def _load_image_dimensions(image_name):
    image_path = Path(str(image_name or ''))
    if not image_path.is_absolute():
        image_path = COMFY_INPUT_DIR / str(image_name or '')
    return _image_dimensions(image_path)


def _scale_to_total_pixels_dims(width, height, megapixels):
    if not width or not height or width <= 0 or height <= 0:
        return None
    target_pixels = float(megapixels or 0) * 1_000_000
    if target_pixels <= 0:
        return int(width), int(height)
    scale = (target_pixels / float(width * height)) ** 0.5
    return max(1, int(round(width * scale))), max(1, int(round(height * scale)))


def _resolve_prompt_image_dimensions(nodes_by_id, value, seen=None):
    link = _prompt_link(value)
    if not link:
        return None
    key, _slot = link
    seen = seen or set()
    if key in seen:
        return None
    seen.add(key)
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return None
    class_type = str(node.get('class_type') or '')
    inputs = _node_inputs(node)
    if class_type == 'LoadImage':
        image_name = _prompt_string(inputs.get('image'))
        return _load_image_dimensions(image_name) if image_name else None
    if class_type == 'ImageScaleToTotalPixels':
        dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get('image'), seen)
        if not dims:
            return None
        megapixels = _prompt_number(inputs.get('megapixels'), _prompt_number(inputs.get('total_pixels'), None))
        if megapixels is None:
            # Some editor widgets serialize the megapixel value only in widget
            # metadata; if it is absent from the API prompt, preserve upstream dims.
            return dims
        return _scale_to_total_pixels_dims(dims[0], dims[1], megapixels)
    # Pass-through common image nodes where output dimensions match the image input.
    for name in ('image', 'pixels', 'images'):
        if name in inputs:
            dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get(name), seen)
            if dims:
                return dims
    return None


def _resolve_prompt_number(nodes_by_id, value, default=None):
    direct = _prompt_number(value, None)
    if direct is not None:
        return direct
    link = _prompt_link(value)
    if not link:
        return default
    key, slot = link
    node = nodes_by_id.get(key)
    if not isinstance(node, dict):
        return default
    class_type = str(node.get('class_type') or '')
    inputs = _node_inputs(node)
    if class_type in {'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveNumber'}:
        return _prompt_number(inputs.get('value'), default)
    if class_type == 'ComfyMathExpression':
        values = {}
        for name, raw in inputs.items():
            if not str(name).startswith('values.'):
                continue
            key_name = str(name).split('.', 1)[1]
            values[key_name] = _resolve_prompt_number(nodes_by_id, raw, None)
        expr = _prompt_string(inputs.get('expression')) or ''
        if expr and re.fullmatch(r'[0-9A-Za-z_+\-*/(). \t]+', expr):
            try:
                clean_values = {k: float(v) for k, v in values.items() if v is not None}
                result = eval(expr, {"__builtins__": {}}, clean_values)
                numeric = _prompt_number(result, None)
                if numeric is not None:
                    return numeric
            except Exception:
                pass
    if class_type == 'PainterAudioLength':
        seconds = _resolve_prompt_audio_seconds(nodes_by_id, inputs.get('audio'))
        if seconds is not None:
            return seconds
    if class_type == 'GetImageSize':
        dims = _resolve_prompt_image_dimensions(nodes_by_id, inputs.get('image'))
        if dims:
            return float(dims[0 if slot == 0 else 1 if slot == 1 else 0])
    return default


def _round_to_multiple(value, multiple=64):
    return int(max(multiple, round(value / multiple) * multiple))


def _cap_native_mx_dimensions(width, height):
    """Optionally cap warmed MXFP8 edit sizes to a draft-speed envelope.

    This used to default to 448x672 = 301056 px (the measured sub-10s 2-step
    envelope on this Mac), which silently rendered every BigLove Klein edit at
    ~0.3MP — visibly blurry — regardless of the requested resolution. The cap
    is now off by default so edits run at the model's trained ~1.5MP bucket
    (~20s). Set ZIMAGE_NATIVE_MX_MAX_PIXELS to a positive pixel count
    (e.g. 301056) to restore the draft-speed cap.
    """
    try:
        max_pixels = int(os.environ.get('ZIMAGE_NATIVE_MX_MAX_PIXELS', '0'))
    except Exception:
        max_pixels = 0
    try:
        width = int(width)
        height = int(height)
    except Exception:
        return width, height
    if max_pixels <= 0 or width <= 0 or height <= 0 or width * height <= max_pixels:
        return width, height
    scale = (max_pixels / float(width * height)) ** 0.5
    return _round_to_multiple(width * scale, multiple=32), _round_to_multiple(height * scale, multiple=32)


def _preserve_source_aspect_for_default_square(image_name, width, height):
    """Avoid quality loss from accidental square crop/downscale in Mobile.

    Many Comfy/mobile templates leave EmptyLatentImage at the default 512x512.
    For image-editing, that default square silently crops portrait references and
    makes the native result look blurrier/worse than the earlier 512x768 route.
    Treat an untouched 512x512 latent as "use source aspect"; explicit non-square
    graph dimensions are preserved.
    """
    if width != 512 or height != 512:
        return width, height
    image_path = Path(str(image_name))
    if not image_path.is_absolute():
        image_path = COMFY_INPUT_DIR / str(image_name)
    dims = _image_dimensions(image_path)
    if not dims:
        return width, height
    src_w, src_h = dims
    if src_w <= 0 or src_h <= 0:
        return width, height
    aspect = src_w / src_h
    if 0.92 <= aspect <= 1.08:
        return width, height
    short_edge = 512
    if aspect < 1:
        out_w = short_edge
        out_h = min(1024, max(512, _round_to_multiple(short_edge / aspect)))
    else:
        out_w = min(1024, max(512, _round_to_multiple(short_edge * aspect)))
        out_h = short_edge
    return out_w, out_h


def _has_exact_comfy_features_required(nodes):
    """True when native MLX translation would drop graph semantics.

    Native MLX is only a small, fast image-edit shortcut. If the workflow uses
    Comfy-only behavior (reference-conditioning subgraphs, graph LoRAs, custom
    Flux2 sampler/scheduler/guider, explicit VAE loading), route the original
    prompt to ComfyUI so those nodes execute exactly instead of approximating
    them with width/height/steps/prompt extraction.
    """
    exact_only = {
        'ReferenceLatent',
        'LoraLoader',
        'Power Lora Loader (rgthree)',
        'Power Lora Loader',
        'SamplerCustomAdvanced',
        'CFGGuider',
        'Flux2Scheduler',
        'VAELoader',
    }
    for node in nodes:
        class_type = str(node.get('class_type') or '')
        if class_type in exact_only:
            return True
    return False


def _normalize_ltx_mlx_variant(value):
    raw = str(value or '').strip().lower()
    raw = raw.replace('_', '-')
    raw = re.sub(r'[^a-z0-9.-]+', '-', raw).strip('-')
    if raw in LTX2_MLX_VARIANTS:
        return raw
    return LTX2_MLX_VARIANT_ALIASES.get(raw)


def _ltx_mlx_backend_name(spec, variant):
    prefix = str((spec or {}).get('backend_prefix') or 'mlx-ltx-eros').strip().rstrip('-')
    return f"{prefix}-{variant}"


def _ltx_mlx_output_subdir(spec):
    subdir = str((spec or {}).get('output_subdir') or 'Eros').strip().strip('/')
    return subdir or 'Eros'


def _ltx_mlx_variant_from_text(value):
    text = str(value or '')
    for pattern in (
        r'native_mlx_ltx__([A-Za-z0-9_.-]+)',
        r'native[-_ ]mlx[-_ ]ltx[:=]([A-Za-z0-9_.-]+)',
        r'mlx[-_ ]ltx[:=]([A-Za-z0-9_.-]+)',
    ):
        match = re.search(pattern, text, re.I)
        if match:
            variant = _normalize_ltx_mlx_variant(match.group(1))
            if variant:
                return variant
    return None


def _native_mlx_ltx_metadata_from_workflow(workflow):
    if not isinstance(workflow, dict):
        return None
    extra = workflow.get('extra') if isinstance(workflow.get('extra'), dict) else {}
    native = extra.get('nativeMlxLtx') or extra.get('native_mlx_ltx')
    if not isinstance(native, dict) or native.get('enabled') is False:
        return None
    variant = _normalize_ltx_mlx_variant(native.get('variant') or native.get('id'))
    if not variant:
        return None
    return {
        'variant': variant,
        'pipeline': str(native.get('pipeline') or 'generate').strip().lower(),
        'defaults': native.get('defaults') if isinstance(native.get('defaults'), dict) else {},
        'keyframes': native.get('keyframes') if isinstance(native.get('keyframes'), list) else [],
        'loras': native.get('loras') if isinstance(native.get('loras'), list) else [],
        'video': native.get('video') if isinstance(native.get('video'), dict) else None,
        'ingredient_sheet': (native.get('ingredientSheet') or native.get('ingredient_sheet')) if isinstance(native.get('ingredientSheet') or native.get('ingredient_sheet'), dict) else None,
        'ic_lora': (native.get('icLora') or native.get('ic_lora')) if isinstance(native.get('icLora') or native.get('ic_lora'), dict) else None,
        # This is an ALLOWLIST: a key absent here is silently dropped no matter
        # what the MCP emitted. head_swap arrived alongside pipeline='head-swap'
        # and was discarded here, so the head-swap branch found no face and fell
        # through to the Comfy graph. Any new pipeline needs its payload listed.
        'head_swap': (native.get('headSwap') or native.get('head_swap')) if isinstance(native.get('headSwap') or native.get('head_swap'), dict) else None,
    }


def _native_mlx_ltx_metadata_from_body(data, nodes):
    workflow = None
    if isinstance(data, dict):
        extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
        extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
        direct_native = extra_pnginfo.get('nativeMlxLtx') or extra_pnginfo.get('native_mlx_ltx')
        if isinstance(direct_native, dict):
            workflow = {'extra': {'nativeMlxLtx': direct_native}}
        else:
            workflow = extra_pnginfo.get('workflow') if isinstance(extra_pnginfo.get('workflow'), dict) else None
    meta = _native_mlx_ltx_metadata_from_workflow(workflow)
    if meta:
        return meta
    ic_loader = next((node for node in nodes if str(node.get('class_type') or '') == 'LTXICLoRALoaderModelOnly'), None)
    ic_guide = next((node for node in nodes if str(node.get('class_type') or '') == 'LTXAddVideoICLoRAGuide'), None)
    if ic_loader and ic_guide:
        loader_inputs = _node_inputs(ic_loader)
        guide_inputs = _node_inputs(ic_guide)
        lora_name = _prompt_string(loader_inputs.get('lora_name'))
        try:
            lora_strength = float(loader_inputs.get('strength_model', 1.0))
        except Exception:
            lora_strength = 1.0
        try:
            reference_strength = float(guide_inputs.get('strength', 1.0))
        except Exception:
            reference_strength = 1.0
        return {
            'variant': 'regular-q8-distilled',
            'pipeline': 'ic-lora',
            'defaults': {},
            'keyframes': [],
            'loras': ([{'name': lora_name, 'strength': lora_strength}] if lora_name else []),
            'video': None,
            'ic_lora': {
                'single_stage': True,
                'conditioning_strength': 1.0,
                'reference_strength': reference_strength,
            },
        }
    for node in nodes:
        inputs = _node_inputs(node)
        for value in inputs.values():
            if isinstance(value, str):
                variant = _ltx_mlx_variant_from_text(value)
                if variant:
                    return {'variant': variant, 'defaults': {'frames': 233}, 'keyframes': [], 'loras': [], 'video': None}
        node_meta = node.get('_meta') if isinstance(node.get('_meta'), dict) else {}
        for value in node_meta.values():
            if isinstance(value, str):
                variant = _ltx_mlx_variant_from_text(value)
                if variant:
                    return {'variant': variant, 'defaults': {'frames': 233}, 'keyframes': [], 'loras': [], 'video': None}
    return None


def _first_ltx_prompt_text(nodes_by_id, nodes):
    preferred_ids = ('824', '536', '2483')
    for key in preferred_ids:
        node = nodes_by_id.get(key)
        if not isinstance(node, dict):
            continue
        inputs = _node_inputs(node)
        value = inputs.get('value') if 'value' in inputs else inputs.get('text')
        text = _resolve_prompt_string(nodes_by_id, value)
        if text:
            return text
    negative_terms = re.compile(r'\b(child|minor|underage|cartoon|low quality|watermark|negative|bad anatomy)\b', re.I)
    candidates = []
    for node in nodes:
        inputs = _node_inputs(node)
        class_type = str(node.get('class_type') or '')
        value = inputs.get('value') if 'value' in inputs else inputs.get('text')
        if class_type in {'CLIPTextEncode', 'PrimitiveString', 'PrimitiveStringMultiline', 'StringLiteral'}:
            text = _resolve_prompt_string(nodes_by_id, value)
            if text and not negative_terms.search(text):
                candidates.append(text)
    if not candidates:
        return None
    return max(candidates, key=len)


def _first_ltx_image_name(nodes):
    preferred_ids = {'773', '4'}
    load_images = [node for node in nodes if str(node.get('class_type') or '') == 'LoadImage']
    for node in load_images:
        if str(node.get('id') or '') in preferred_ids:
            image_name = _prompt_string(_node_inputs(node).get('image'))
            if image_name:
                return image_name
    for node in load_images:
        image_name = _prompt_string(_node_inputs(node).get('image'))
        if image_name:
            return image_name
    return None


def _native_ltx_keyframe_image_name(item):
    if not isinstance(item, dict):
        return None
    for key in ('image', 'image_path', 'path', 'filename', 'file'):
        image_name = _prompt_string(item.get(key))
        if image_name:
            return image_name
    return None


def _native_ltx_role_frame(role, frames):
    text = str(role or '').strip().lower()
    if text in {'start', 'first', 'first_frame', 'beginning'}:
        return 0
    if text in {'middle', 'mid', 'center', 'centre'}:
        return max(0, (frames - 1) // 2)
    if text in {'end', 'last', 'last_frame', 'final'}:
        return max(0, frames - 1)
    return None


def _native_ltx_keyframe_frame(item, frames, frame_rate):
    if not isinstance(item, dict):
        return 0
    for key in ('frame', 'frame_idx', 'frame_index'):
        if item.get(key) is not None:
            try:
                return max(0, min(frames - 1, int(round(float(item.get(key))))))
            except Exception:
                break
    for key in ('time_seconds', 'time', 'seconds'):
        if item.get(key) is not None:
            try:
                return max(0, min(frames - 1, int(round(float(item.get(key)) * float(frame_rate or 24.0)))))
            except Exception:
                break
    role_frame = _native_ltx_role_frame(item.get('role'), frames)
    return 0 if role_frame is None else role_frame


def _native_ltx_keyframe_strength(item):
    if not isinstance(item, dict):
        return 1.0
    try:
        strength = float(item.get('strength', 1.0))
    except Exception:
        strength = 1.0
    if not math.isfinite(strength):
        strength = 1.0
    return max(0.0, min(1.0, strength))


def _native_ltx_lora_name(item):
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return None
    for key in ('filePath', 'file_path', 'path', 'name', 'lora_name', 'lora', 'id'):
        value = _prompt_string(item.get(key))
        if value:
            return value
    return None


def _native_ltx_lora_strength(item):
    if isinstance(item, dict):
        for key in ('scale', 'strength', 'strength_model', 'model_strength'):
            if item.get(key) is not None:
                try:
                    value = float(item.get(key))
                    if math.isfinite(value):
                        return value
                except Exception:
                    return 1.0
    return 1.0


def _native_ltx_lora_enabled(item):
    if not isinstance(item, dict):
        return True
    value = item.get('enabled', item.get('on', item.get('active', True)))
    return value is not False and str(value).strip().lower() not in {'0', 'false', 'off', 'no', 'none', 'disabled'}


def _native_ltx_loras(raw_loras):
    out = []
    seen = set()
    if not isinstance(raw_loras, list):
        return out
    for item in raw_loras:
        if not _native_ltx_lora_enabled(item):
            continue
        name = _native_ltx_lora_name(item)
        if not name:
            continue
        path = _resolve_lora_path(name)
        strength = _native_ltx_lora_strength(item)
        key = (str(path or name), round(strength, 6))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            'name': Path(str(name)).name,
            'source': name,
            'scale': strength,
            **({'filePath': path} if path else {}),
        })
    return out


def _native_ltx_keyframes(raw_keyframes, frames, frame_rate, fallback_image=None):
    out = []
    if isinstance(raw_keyframes, list):
        for item in raw_keyframes:
            if not isinstance(item, dict):
                continue
            image_name = _native_ltx_keyframe_image_name(item)
            if not image_name:
                continue
            out.append({
                'image_path': image_name,
                'frame': _native_ltx_keyframe_frame(item, frames, frame_rate),
                'strength': _native_ltx_keyframe_strength(item),
                'role': str(item.get('role') or '').strip() or None,
            })
    if fallback_image and not any(int(k.get('frame', 0)) == 0 for k in out):
        out.insert(0, {'image_path': fallback_image, 'frame': 0, 'strength': 1.0, 'role': 'start'})
    if not out and fallback_image:
        out.append({'image_path': fallback_image, 'frame': 0, 'strength': 1.0, 'role': 'start'})
    deduped = {}
    for item in out:
        frame = int(item.get('frame') or 0)
        deduped[frame] = item
    return [deduped[key] for key in sorted(deduped)]


def _ltx_valid_frame_count(value, default=233):
    try:
        frames = int(round(float(value)))
    except Exception:
        frames = default
    frames = max(9, min(721, frames))
    return max(9, int(round((frames - 1) / 8)) * 8 + 1)


def _ltx_snap_render_dimensions(width, height, *, single_stage=False):
    """Floor a render size to the grid the selected LTX pipeline can honor.

    The two-stage pipelines (distilled generate and the dev --two-stage
    equivalent) run stage 1 at half resolution, so the ltx-2-mlx runtime floors
    any dimension that is not a multiple of 64 (928 -> 896) AFTER the job
    record is written; single-stage paths floor to the VAE's 32. Snapping
    before the record keeps it, the prepared anchors, and the delivered file
    on one agreed size.
    """
    modulus = 32 if single_stage else 64
    snap = lambda value: max(modulus, (int(value) // modulus) * modulus)
    return snap(width), snap(height)


def _ltx_extension_output_frames(duration_seconds, frame_rate=24.0):
    try:
        duration = float(duration_seconds)
        fps = float(frame_rate)
    except Exception:
        duration, fps = 4.0, 24.0
    if not math.isfinite(duration) or duration <= 0:
        duration = 4.0
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    return max(8, min(720, int(math.ceil(duration * fps / 8.0)) * 8))


def _ltx_extension_latent_frames(duration_seconds, frame_rate=24.0):
    return _ltx_extension_output_frames(duration_seconds, frame_rate) // 8


def _call_comfy_free_before_ltx():
    for _lane, base in COMFY_LANES.items():
        try:
            req = Request(base.rstrip('/') + '/free', data=json.dumps({'unload_models': True, 'free_memory': True}).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
            urlopen(req, timeout=5).read()
        except Exception:
            pass


def detect_native_mlx_ltx_prompt(body):
    """Return an explicit native MLX LTX video job from a Mobile Comfy prompt."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    prompt_graph = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt_graph, dict):
        return None
    if not supports_native_mlx_ltx_route():
        return None

    nodes_by_id = {str(k): v for k, v in prompt_graph.items() if isinstance(v, dict)}
    for key, node in nodes_by_id.items():
        node.setdefault('id', key)
    nodes = list(nodes_by_id.values())
    meta = _native_mlx_ltx_metadata_from_body(data, nodes)
    if not meta:
        return None
    variant = meta.get('variant')
    spec = LTX2_MLX_VARIANTS.get(variant)
    if not spec:
        return None

    defaults = meta.get('defaults') or {}
    prompt_text = _first_ltx_prompt_text(nodes_by_id, nodes)
    if not prompt_text:
        return None
    pipeline = str(meta.get('pipeline') or 'generate').strip().lower()
    print(f"[ltx-native] pipeline={pipeline!r} keys={sorted(meta)} head_swap={meta.get('head_swap')}", flush=True)
    if pipeline == 'head-swap':
        # BFS head swap: the face image rides in a reserved strip composed over
        # the source footage, so this needs BOTH inputs and neither is optional.
        head_swap = meta.get('head_swap') if isinstance(meta.get('head_swap'), dict) else {}
        face_name = _prompt_string(head_swap.get('face_image') or defaults.get('image')) or _first_ltx_image_name(nodes)
        video_name = _prompt_string(head_swap.get('source_video') or (meta.get('video') or {}).get('path'))
        if not face_name or not video_name:
            return None
        frame_rate = float_quality_option({'frame_rate': head_swap.get('frame_rate', defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        raw_frames = head_swap.get('frames', defaults.get('frames', 121))
        frames = _ltx_valid_frame_count(raw_frames, 121)
        seed_value = head_swap.get('seed', defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        return {
            'variant': variant,
            'operation': 'head-swap',
            'prompt': prompt_text,
            'video_path': video_name,
            'reference_image_path': face_name,
            'images': [],
            'options': {
                # Width/height are deliberately absent: the render is sized from
                # the SOURCE video, not from the studio's aspect/resolution picker,
                # because a head swap re-times existing footage rather than
                # framing a new shot.
                'frames': frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': str(spec.get('video_model') or spec.get('model') or ''),
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'head_swap_region_px': int_option(head_swap, 'region_px', BFS_HEADSWAP_REGION_PX, 32, 2048),
                # 0 = render at the source's own size. Capping the long side is
                # the main speed lever, since cost scales with rendered pixels.
                'head_swap_max_dimension': int_option(head_swap, 'max_dimension', 0, 0, 4096),
                # 'fast' = half-res generation + upsample + control-aware refine.
                'head_swap_pipeline': _prompt_string(head_swap.get('pipeline')) or 'single-stage',
                'head_swap_refine_steps': int_option(head_swap, 'refine_steps', 3, 1, 8),
                # The author's identity knob: "1.0 -> best motion fidelity;
                # >1.0 -> stronger identity and hair capture, but may distort".
                'head_swap_lora_strength': float_quality_option(head_swap, 'lora_strength', 1.0),
                # Which engine runs the swap. 'bfs' regenerates the frame with
                # the IC-LoRA; 'facefusion' swaps the face onto the original.
                'head_swap_backend': _prompt_string(head_swap.get('backend')) or 'bfs',
                'head_swap_face_enhancer': bool(head_swap.get('face_enhancer')),
                'reference_strength': float_quality_option(head_swap, 'reference_strength', 1.0),
                'conditioning_strength': float_quality_option(head_swap, 'conditioning_strength', 1.0),
                'runtime_timeout_seconds': int_option(head_swap, 'runtime_timeout_seconds', 2400, 60, 14400),
                # LoRAs belong INSIDE options — that is where the runner reads
                # them (options.get('loras')). Returning them at the top level
                # left native_loras empty, so head swap rejected its own request
                # claiming the BFS LoRA was not selected.
                'loras': _native_ltx_loras(meta.get('loras') or []),
            },
        }
    if pipeline == 'ic-lora':
        ic_lora = meta.get('ic_lora') if isinstance(meta.get('ic_lora'), dict) else {}
        ingredient_sheet = meta.get('ingredient_sheet') if isinstance(meta.get('ingredient_sheet'), dict) else {}
        image_name = _prompt_string(ic_lora.get('reference_image') or defaults.get('image')) or _first_ltx_image_name(nodes)
        if not image_name:
            return None
        width = int_quality_option({'width': _resolve_prompt_number(nodes_by_id, ['809', 0], defaults.get('width', 768))}, 'width', 768)
        height = int_quality_option({'height': _resolve_prompt_number(nodes_by_id, ['811', 0], defaults.get('height', 448))}, 'height', 448)
        frame_rate = float_quality_option({'frame_rate': _resolve_prompt_number(nodes_by_id, ['5098', 0], defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        latent = next((n for n in nodes if str(n.get('class_type') or '') == 'EmptyLTXVLatentVideo'), None)
        latent_inputs = _node_inputs(latent)
        raw_frames = defaults.get('frames') if defaults.get('frames') is not None else _resolve_prompt_number(nodes_by_id, latent_inputs.get('length'), 121)
        frames = _ltx_valid_frame_count(raw_frames, int(defaults.get('frames', 121) or 121))
        seed_value = _resolve_prompt_number(nodes_by_id, ['4832', 0], defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        loras = _native_ltx_loras(meta.get('loras') or [])
        try:
            conditioning_strength = max(0.0, min(1.0, float(ic_lora.get('conditioning_strength', 1.0))))
        except Exception:
            conditioning_strength = 1.0
        try:
            reference_strength = max(0.0, min(1.0, float(ic_lora.get('reference_strength', 1.0))))
        except Exception:
            reference_strength = 1.0
        reference_min_frames = int_option(ic_lora, 'reference_min_frames', 121, 1, 10000)
        target_min_frames = int_option(ic_lora, 'target_min_frames', 9, 9, 721)
        frames = max(frames, target_min_frames)
        image_crf = int_option(ic_lora, 'image_crf', 33, 0, 63)
        single_stage_value = ic_lora.get('single_stage', True)
        low_ram_value = ic_lora.get('low_ram', False)
        dev_transformer = _prompt_string(ic_lora.get('dev_transformer'))
        distilled_lora = _prompt_string(ic_lora.get('distilled_lora'))
        guided_dev_value = ic_lora.get('guided_dev', False)
        guided_dev = guided_dev_value is not False and str(guided_dev_value).strip().lower() not in {
            '0', 'false', 'off', 'no'
        }
        stage1_steps = int_option(ic_lora, 'stage1_steps', 30, 1, 100)
        cfg_scale = float_quality_option(ic_lora, 'cfg_scale', 4.0)
        stg_scale = float_quality_option(ic_lora, 'stg_scale', 1.0)
        runtime_timeout_seconds = int_option(ic_lora, 'runtime_timeout_seconds', 2400, 60, 14400)
        try:
            distilled_lora_strength = float(ic_lora.get('distilled_lora_strength', 0.5))
        except Exception:
            distilled_lora_strength = 0.5
        return {
            'variant': variant,
            'operation': 'ic-lora',
            'prompt': prompt_text,
            'reference_image_path': image_name,
            'images': _native_ltx_keyframes(meta.get('keyframes') or [], frames, frame_rate),
            'options': {
                'width': width,
                'height': height,
                'frames': frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': spec['model'],
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'conditioning_strength': conditioning_strength,
                'reference_strength': reference_strength,
                'reference_min_frames': reference_min_frames,
                'target_min_frames': target_min_frames,
                **({
                    'ingredient_source_count': int_option(ingredient_sheet, 'sourceCount', 0, 0, 12),
                    'ingredient_sheet_columns': int_option(ingredient_sheet, 'columns', 0, 0, 12),
                    'ingredient_sheet_rows': int_option(ingredient_sheet, 'rows', 0, 0, 12),
                    'ingredient_conditioning_only': bool(ingredient_sheet.get('conditioningOnly', True)),
                } if ingredient_sheet else {}),
                'image_crf': image_crf,
                'single_stage': single_stage_value is not False and str(single_stage_value).strip().lower() not in {'0', 'false', 'off', 'no'},
                'low_ram': low_ram_value is not False and str(low_ram_value).strip().lower() not in {'0', 'false', 'off', 'no'},
                **({'dev_transformer': dev_transformer} if dev_transformer else {}),
                'guided_dev': guided_dev,
                'stage1_steps': stage1_steps,
                'cfg_scale': cfg_scale,
                'stg_scale': stg_scale,
                'runtime_timeout_seconds': runtime_timeout_seconds,
                **({'distilled_lora': distilled_lora, 'distilled_lora_strength': distilled_lora_strength} if distilled_lora else {}),
                **({'loras': loras} if loras else {}),
            },
        }
    video = meta.get('video') if isinstance(meta.get('video'), dict) else None
    video_name = _prompt_string(video.get('path') or video.get('video_path') or video.get('filename')) if video else None
    if video_name:
        mode = str(video.get('mode') or 'extend').strip().lower()
        if mode != 'extend':
            return None
        video_model = str(spec.get('video_model') or '').strip()
        if not video_model or not Path(video_model).expanduser().exists():
            return None
        frame_rate = float_quality_option({'frame_rate': video.get('frame_rate', defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
        duration_seconds = float_quality_option({'duration_seconds': video.get('duration_seconds', defaults.get('duration_seconds', 4))}, 'duration_seconds', 4.0)
        extension_output_frames = _ltx_extension_output_frames(duration_seconds, frame_rate)
        extension_latent_frames = extension_output_frames // 8
        seed_value = _resolve_prompt_number(nodes_by_id, ['812', 0], defaults.get('seed', 42))
        seed = int(seed_value) if seed_value is not None else 42
        return {
            'variant': variant,
            'operation': 'extend',
            'prompt': prompt_text,
            'video_path': video_name,
            'images': [],
            'options': {
                'duration_seconds': duration_seconds,
                'extension_output_frames': extension_output_frames,
                'extension_latent_frames': extension_latent_frames,
                'extend_latent_frames': extension_latent_frames,
                'frame_rate': frame_rate,
                'seed': seed,
                'model': video_model,
                'title': spec['title'],
                'benchmark_seconds': spec.get('benchmark_seconds'),
                'distilled': bool(spec.get('video_distilled')),
                'cfg_scale': float(video.get('cfg_scale', 3.0)),
                'stg_scale': float(video.get('stg_scale', 1.0)),
                'steps': int(video.get('steps', 30)),
            },
        }
    image_name = _first_ltx_image_name(nodes)
    width = int_quality_option({'width': _resolve_prompt_number(nodes_by_id, ['809', 0], defaults.get('width', 480))}, 'width', 480)
    height = int_quality_option({'height': _resolve_prompt_number(nodes_by_id, ['811', 0], defaults.get('height', 832))}, 'height', 832)
    frame_rate = float_quality_option({'frame_rate': _resolve_prompt_number(nodes_by_id, ['542', 0], defaults.get('frame_rate', 24))}, 'frame_rate', 24.0)
    latent = next((n for n in nodes if str(n.get('class_type') or '') == 'EmptyLTXVLatentVideo'), None)
    latent_inputs = _node_inputs(latent)
    raw_frames = defaults.get('frames') if defaults.get('frames') is not None else _resolve_prompt_number(nodes_by_id, latent_inputs.get('length'), 233)
    frames = _ltx_valid_frame_count(raw_frames, int(defaults.get('frames', 233) or 233))
    seed_value = _resolve_prompt_number(nodes_by_id, ['812', 0], defaults.get('seed', 42))
    seed = int(seed_value) if seed_value is not None else 42
    keyframes = _native_ltx_keyframes(meta.get('keyframes') or [], frames, frame_rate, image_name)
    cfg_node_inputs = _node_inputs(nodes_by_id.get('583'))
    cfg_scale = _resolve_prompt_number(nodes_by_id, cfg_node_inputs.get('cfg'), defaults.get('cfg'))
    loras = _native_ltx_loras(meta.get('loras') or [])
    if not image_name and keyframes:
        image_name = keyframes[0].get('image_path')
    # image_name may legitimately be empty: LTX 2.3 generate supports text-to-video
    # (no anchor image), so route a prompt-only request to the native generate
    # pipeline all the same instead of bailing out here.

    return {
        'variant': variant,
        'prompt': prompt_text,
        'image_path': image_name or '',
        'images': keyframes,
        'options': {
            'width': width,
            'height': height,
            'frames': frames,
            'frame_rate': frame_rate,
            'seed': seed,
            'model': spec['model'],
            'title': spec['title'],
            'benchmark_seconds': spec.get('benchmark_seconds'),
            **({'cfg_scale': float(cfg_scale)} if cfg_scale is not None else {}),
            **({'denoise': normalize_ltx_denoise_mode(defaults.get('denoise'))}
               if normalize_ltx_denoise_mode(defaults.get('denoise')) else {}),
            # NAG inputs. The runner only acts on these for distilled variants,
            # where cfg=1 makes a CFG negative prompt inert.
            **({'negative_prompt': _prompt_string(defaults.get('negative_prompt'))}
               if _prompt_string(defaults.get('negative_prompt')) else {}),
            **({'nag_scale': float(defaults['nag_scale'])}
               if _prompt_number(defaults.get('nag_scale')) is not None else {}),
            **({'loras': loras} if loras else {}),
        },
    }


def _studio_lane_from_comfy_prompt_body(body):
    try:
        data = json.loads(
            body.decode('utf-8', errors='replace')
            if isinstance(body, (bytes, bytearray)) else body
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        return ''
    if not isinstance(data, dict):
        return ''
    extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
    return str(
        data.get('studio_lane')
        or extra_pnginfo.get('studioLane')
        or extra_pnginfo.get('studio_lane')
        or ''
    ).strip()[:512]


def detect_native_mlx_biglove_prompt(body):
    """Return a native MLX job extracted from a Comfy API prompt, or None.

    Privacy note: this parses prompt/image fields only in memory so the wrapper
    can route away from Comfy/MPS. It does not log or persist raw prompts/images.
    """
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    prompt_graph = data.get('prompt') if isinstance(data, dict) else None
    if not isinstance(prompt_graph, dict):
        return None

    nodes_by_id = {str(k): v for k, v in prompt_graph.items() if isinstance(v, dict)}
    nodes = list(nodes_by_id.values())

    # Do not silently replace a user's Comfy workflow with the native sidecar.
    # The sidecar is a fast approximation; full graph execution is the fidelity
    # path for workflows that rely on Comfy reference-conditioning semantics.
    if os.environ.get("ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT", "0") != "1":
        return None
    if not supports_native_mlx_biglove_route():
        return None
    if os.environ.get("ZIMG_ALLOW_MXFP8_COMFY_FALLBACK", "1") == "1" and _has_exact_comfy_features_required(nodes):
        return None

    model_node = None
    for node in nodes:
        inputs = _node_inputs(node)
        values = list(inputs.values())
        if any(_is_biglove_klein3_model_name(v) for v in values if isinstance(v, str)):
            model_node = node
            break
    if model_node is None:
        return None
    native_loras, unresolved_loras = _native_loras_from_prompt_nodes(nodes_by_id)
    if unresolved_loras and not native_loras:
        print("[native-mlx] BigLove prompt contains LoRAs that could not be resolved locally; routing to exact Comfy", flush=True)
        return None

    sampler = next((n for n in nodes if str(n.get('class_type') or '') in {'KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced'}), None)
    sampler_inputs = _node_inputs(sampler)
    image_names = _native_reference_image_names(nodes_by_id, nodes, sampler_inputs)
    if not image_names:
        return None
    image_name = image_names[0]

    pos_node = _find_linked_prompt_node(
        nodes_by_id,
        sampler_inputs.get('positive'),
        lambda n: n.get('class_type') == 'CLIPTextEncode' and bool(_prompt_string(_node_inputs(n).get('text'))),
    ) if sampler else None
    if pos_node is None:
        pos_node = next((n for n in nodes if n.get('class_type') == 'CLIPTextEncode' and _prompt_string(_node_inputs(n).get('text'))), None)
    prompt_text = _prompt_string(_node_inputs(pos_node).get('text') if pos_node else None)
    if not prompt_text:
        return None
    prompt_text = _strip_lora_prompt_tokens(prompt_text)

    neg_node = _find_linked_prompt_node(
        nodes_by_id,
        sampler_inputs.get('negative'),
        lambda n: n.get('class_type') == 'CLIPTextEncode' and bool(_prompt_string(_node_inputs(n).get('text'))),
    ) if sampler else None
    negative_prompt = _prompt_string(_node_inputs(neg_node).get('text') if neg_node else None)

    latent = next((n for n in nodes if str(n.get('class_type') or '') in {'EmptyLatentImage', 'EmptyFlux2LatentImage', 'EmptySD3LatentImage'}), None)
    latent_inputs = _node_inputs(latent)
    scheduler = next((n for n in nodes if str(n.get('class_type') or '') in {'Flux2Scheduler'}), None)
    scheduler_inputs = _node_inputs(scheduler)
    graph_steps = int_quality_option({'steps': _resolve_prompt_number(nodes_by_id, sampler_inputs.get('steps'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('steps'), 4))}, 'steps', 4)
    steps = normalize_biglove_klein3_steps(graph_steps)
    guidance_default = _resolve_prompt_number(nodes_by_id, sampler_inputs.get('guidance'), 1.0)
    guidance = float_quality_option({'guidance': _resolve_prompt_number(nodes_by_id, sampler_inputs.get('cfg'), guidance_default)}, 'guidance', 1.0)
    seed_val = _resolve_prompt_number(nodes_by_id, sampler_inputs.get('seed'), None)
    seed = int(seed_val) if seed_val is not None else None
    width_value = _resolve_prompt_number(nodes_by_id, latent_inputs.get('width'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('width'), 512))
    height_value = _resolve_prompt_number(nodes_by_id, latent_inputs.get('height'), _resolve_prompt_number(nodes_by_id, scheduler_inputs.get('height'), 512))
    requested_width = int_quality_option({'width': width_value}, 'width', 512)
    requested_height = int_quality_option({'height': height_value}, 'height', 512)
    # A graph's latent size is not a resolution request — it is usually the
    # stock 512x512 next to an ImageScaleToTotalPixels node that sets the real
    # canvas. Take the shape from it and the size from the trained bucket.
    bucket_width, bucket_height = orient_biglove_klein3_bucket(requested_width, requested_height)
    width, height = _cap_native_mx_dimensions(bucket_width, bucket_height)

    return {
        'prompt': prompt_text,
        'image_path': image_name,
        'options': {
            'width': width,
            'height': height,
            'requested_width': requested_width,
            'requested_height': requested_height,
            'steps': steps,
            'guidance': guidance,
            **({'seed': seed} if seed is not None else {}),
            **({'negative_prompt': negative_prompt} if negative_prompt else {}),
            **({'loras': native_loras} if native_loras else {}),
            **({'image_paths': image_names} if len(image_names) > 1 else {}),
        },
    }


def poll_swift_flux2_progress(job_id, total_steps, stop_event):
    """Mirror real Swift denoise step callbacks into the wrapper job record."""
    url = SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/progress/" + str(job_id)
    while not stop_event.is_set():
        try:
            with urlopen(url, timeout=2) as resp:
                rec = json.loads(resp.read().decode("utf-8") or "{}")
            current = int(rec.get("currentStep") or 0)
            total = int(rec.get("totalSteps") or total_steps or 1)
            overall = int(rec.get("overallPercent") or round((current / max(1, total)) * 100))
            step_progress = int(rec.get("currentStepPercent") or (100 if current > 0 else 0))
            with jobs_lock:
                job = jobs.get(job_id)
                if job and job.get("status") == "running":
                    job.update({
                        "current_step": current,
                        "total_steps": total,
                        "progress": max(0, min(100, overall)),
                        "step_progress": max(0, min(100, step_progress)),
                        "progress_phase": rec.get("phase") or "denoise",
                    })
                    jobs[job_id] = job
        except Exception:
            pass
        stop_event.wait(0.25)


def _is_mobile_workflow_metadata(value):
    if not isinstance(value, dict):
        return False
    if isinstance(value.get('nodes'), list):
        return True
    return (
        value.get('encrypted') is True
        and value.get('format') == 'comfyui-mobile-encrypted-workflow'
        and isinstance(value.get('data'), str)
        and isinstance(value.get('iv'), str)
        and isinstance(value.get('salt'), str)
    )


def _mobile_prompt_workflow_from_body(body):
    """Extract only Comfy's workflow metadata from a Mobile /api/prompt body."""
    try:
        data = json.loads(body.decode('utf-8', errors='replace') if isinstance(body, (bytes, bytearray)) else body)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    extra_data = data.get('extra_data') if isinstance(data.get('extra_data'), dict) else {}
    extra_pnginfo = extra_data.get('extra_pnginfo') if isinstance(extra_data.get('extra_pnginfo'), dict) else {}
    workflow = extra_pnginfo.get('workflow') if isinstance(extra_pnginfo.get('workflow'), dict) else None
    if _is_mobile_workflow_metadata(workflow):
        return workflow
    return None


def _comfy_history_prompt_tuple(job_id, workflow=None, backend='mlx-mxfp8-bigloves-klein3-edit'):
    extra = {'backend': backend}
    if workflow:
        extra['extra_pnginfo'] = {'workflow': scrub_workflow_prompt_text(workflow)}
    return [0, job_id, {}, extra, []]


def _png_chunk(chunk_type, payload):
    chunk_type_bytes = chunk_type.encode('ascii')
    return (
        len(payload).to_bytes(4, 'big')
        + chunk_type_bytes
        + payload
        + zlib.crc32(chunk_type_bytes + payload).to_bytes(4, 'big')
    )


def embed_workflow_text_chunk(png_path, workflow):
    """Embed editor workflow metadata in native PNG outputs without storing prompt text."""
    if not workflow:
        return False
    try:
        path = Path(png_path)
        data = path.read_bytes()
        signature = b'\x89PNG\r\n\x1a\n'
        if not data.startswith(signature):
            return False
        payload = b'workflow\x00' + json.dumps(workflow, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        text_chunk = _png_chunk('tEXt', payload)
        pos = data.rfind(b'IEND')
        if pos < 4:
            return False
        chunk_start = pos - 4
        # Replace an existing workflow tEXt chunk if present; otherwise insert before IEND.
        off = len(signature)
        out = bytearray(signature)
        replaced = False
        while off + 8 <= len(data):
            length = int.from_bytes(data[off:off + 4], 'big')
            ctype = data[off + 4:off + 8]
            end = off + 12 + length
            if end > len(data):
                return False
            if ctype == b'tEXt' and data[off + 8:off + 8 + min(length, 9)] == b'workflow\x00':
                if not replaced:
                    out.extend(text_chunk)
                    replaced = True
            else:
                if ctype == b'IEND' and not replaced:
                    out.extend(text_chunk)
                    replaced = True
                out.extend(data[off:end])
            off = end
            if ctype == b'IEND':
                break
        if replaced:
            path.write_bytes(bytes(out))
            return True
    except Exception as e:
        print(f"[workflow-metadata] failed to embed workflow in {png_path}: {e}", file=sys.stderr)
    return False


def _klein_request_fingerprint(prompt, image_paths, options=None, *, mode='edit', extra=None):
    """Hash the inputs that affect a Klein render without retaining the prompt.

    Inline uploads receive a fresh staged filename for every HTTP request, so
    paths cannot identify retries. Hashing the bytes is what lets a 27-request
    retry storm collapse back into the one render the caller intended.
    """
    digest = hashlib.sha256()

    def add_part(label, value):
        payload = str(value).encode('utf-8', errors='surrogatepass')
        digest.update(label.encode('ascii') + b'\0' + len(payload).to_bytes(8, 'big') + payload)

    add_part('version', 'klein-admission-v1')
    add_part('mode', mode)
    add_part('prompt', prompt or '')
    canonical_options = {
        key: value for key, value in dict(options or {}).items()
        if key != 'image_paths'
    }
    add_part(
        'options',
        json.dumps(canonical_options, sort_keys=True, separators=(',', ':'), default=str),
    )
    if extra is not None:
        add_part('extra', json.dumps(extra, sort_keys=True, separators=(',', ':'), default=str))
    for image_path in image_paths:
        path = Path(str(image_path)).expanduser()
        try:
            with path.open('rb') as handle:
                image_digest = hashlib.sha256()
                for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                    image_digest.update(chunk)
            add_part('image', image_digest.hexdigest())
        except OSError:
            # Validation and the user-facing error still happen in the runner.
            # Including the unresolved input in the private digest keeps two
            # different missing paths from incorrectly sharing one job.
            add_part('missing-image', str(path.resolve()))
    return digest.hexdigest()


def _register_klein_job(job_id, fingerprint, record):
    """Register one job or return the equivalent job already in flight."""
    with jobs_lock:
        existing_job_id = klein_inflight_jobs.get(fingerprint)
        existing = jobs.get(existing_job_id) if existing_job_id else None
        if existing and existing.get('status') in {'queued', 'running'}:
            existing['coalesced_requests'] = int(existing.get('coalesced_requests') or 0) + 1
            jobs[existing_job_id] = existing
            return existing_job_id
        if existing_job_id:
            klein_inflight_jobs.pop(fingerprint, None)
        jobs[job_id] = record
        klein_inflight_jobs[fingerprint] = job_id
    return job_id


def _studio_generation_lane_key(media_type, options=None):
    media = str(media_type or '').strip().lower()
    if media not in {'image', 'video'}:
        raise ValueError(f'unsupported generation media type: {media_type}')
    raw = str(dict(options or {}).get('studio_lane') or 'legacy-clients').strip()
    # Callers choose this value, so keep the scheduler key bounded and opaque.
    scoped = f'{media}:{raw[:512]}'
    return hashlib.sha256(scoped.encode('utf-8', errors='replace')).hexdigest()


def _drain_studio_generation_lane(lane_key):
    """Run one tab's submitted jobs in FIFO order, then discard the lane."""
    while True:
        with studio_generation_lanes_lock:
            lane = studio_generation_lanes.get(lane_key)
            if not lane or not lane['pending']:
                studio_generation_lanes.pop(lane_key, None)
                return
            runner, args = lane['pending'].pop(0)
        try:
            runner(*args)
        except Exception as error:
            # Generation runners normally persist their own terminal error. An
            # unexpected escape must not kill the lane and strand every job
            # queued behind it.
            print(
                f"[studio-queue] {getattr(runner, '__name__', 'generation')} failed: {error}",
                file=sys.stderr,
            )


def start_studio_generation_thread(media_type, options, runner, args):
    """Start one queued generation worker in the caller's app-tab lane."""
    lane_key = _studio_generation_lane_key(media_type, options)
    with studio_generation_lanes_lock:
        lane = studio_generation_lanes.get(lane_key)
        if lane is None:
            lane = {'pending': [], 'worker': None}
            studio_generation_lanes[lane_key] = lane
        lane['pending'].append((runner, args))
        if lane['worker'] is None:
            lane['worker'] = threading.Thread(
                target=_drain_studio_generation_lane,
                args=(lane_key,),
                daemon=True,
            )
            lane['worker'].start()
        return lane['worker']


def _record_klein_admission_error(job_id, error):
    with jobs_lock:
        rec = dict(jobs.get(job_id) or {'id': job_id, 'created_at': now_iso()})
        cancelled = isinstance(error, NativeJobCancelled)
        rec.update({
            'prompt': PRIVATE_PROMPT_LABEL,
            'status': 'cancelled' if cancelled else 'error',
            'finished_at': now_iso(),
            'error': 'Cancelled by the owner' if cancelled else str(error),
            'progress_phase': 'cancelled' if cancelled else 'error',
        })
        jobs[job_id] = rec
    append_history(rec)


def _run_admitted_klein_job(job_id, fingerprint, runner, args):
    """Queue within one tab lane, then reserve global memory before model load."""
    reservation = 0
    try:
        reservation = _acquire_klein_memory_reservation(job_id)
        runner(*args)
    except Exception as error:
        _record_klein_admission_error(job_id, error)
    finally:
        _release_klein_memory_reservation(reservation)
        with jobs_lock:
            if klein_inflight_jobs.get(fingerprint) == job_id:
                klein_inflight_jobs.pop(fingerprint, None)


def _available_memory_bytes():
    """Best-effort memory available for a new model load.

    macOS's `memory_pressure` accounts for reclaimable/compressed unified
    memory more accurately than raw free pages. Other platforms use POSIX
    available pages when exposed; an unknown reading does not reject a job.
    """
    if sys.platform == 'darwin':
        try:
            output = subprocess.check_output(
                ['memory_pressure', '-Q'], text=True, timeout=5,
                stderr=subprocess.DEVNULL,
            )
            total_match = re.search(r'The system has\s+(\d+)', output)
            free_match = re.search(r'memory free percentage:\s*(\d+(?:\.\d+)?)%', output, re.I)
            if total_match and free_match:
                return int(int(total_match.group(1)) * float(free_match.group(1)) / 100.0)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        return None
    try:
        return int(os.sysconf('SC_PAGE_SIZE')) * int(os.sysconf('SC_AVPHYS_PAGES'))
    except (OSError, TypeError, ValueError):
        return None


def _klein_memory_limits():
    try:
        headroom_gb = float(os.environ.get('ZIMG_KLEIN_MIN_AVAILABLE_MEMORY_GB', '24'))
    except ValueError:
        headroom_gb = 24.0
    try:
        job_gb = float(os.environ.get('ZIMG_KLEIN_JOB_MEMORY_GB', '24'))
    except ValueError:
        job_gb = 24.0
    # Do not allow a typo or stale environment override to silently remove the
    # safety margin. Klein 9B reached ~16.6 GiB RSS in the incident snapshot.
    headroom_gb = max(20.0, min(headroom_gb, 64.0))
    job_gb = max(20.0, min(job_gb, 64.0))
    return int(headroom_gb * 1024 ** 3), int(job_gb * 1024 ** 3)


def _acquire_klein_memory_reservation(job_id):
    """Atomically reserve memory across tab lanes, waiting instead of overloading.

    The reservation closes the race where two tabs both observe ample memory
    before either child process has allocated its model. If macOS cannot report
    pressure, only one unknown-size Klein reservation is admitted at a time.
    """
    global klein_reserved_memory_bytes
    headroom, reservation = _klein_memory_limits()
    try:
        wait_seconds = float(os.environ.get('ZIMG_KLEIN_MEMORY_WAIT_SECONDS', '600'))
    except ValueError:
        wait_seconds = 600.0
    deadline = time.monotonic() + max(30.0, min(wait_seconds, 3600.0))
    while True:
        if native_job_cancel_requested(job_id):
            raise NativeJobCancelled(f'job {job_id} was cancelled while queued')
        available = _available_memory_bytes()
        with klein_memory_condition:
            safe = (
                klein_reserved_memory_bytes == 0
                if available is None
                else available - klein_reserved_memory_bytes >= headroom + reservation
            )
            if safe:
                klein_reserved_memory_bytes += reservation
                return reservation
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                available_text = 'unknown' if available is None else f'{available / 1024 ** 3:.1f} GiB'
                raise RuntimeError(
                    'timed out waiting for safe unified-memory headroom for Klein 9B '
                    f'(available: {available_text})'
                )
            klein_memory_condition.wait(timeout=min(2.0, remaining))


def _release_klein_memory_reservation(reservation):
    global klein_reserved_memory_bytes
    if not reservation:
        return
    with klein_memory_condition:
        klein_reserved_memory_bytes = max(0, klein_reserved_memory_bytes - int(reservation))
        klein_memory_condition.notify_all()


def queue_native_mlx_biglove_job(prompt, image_path, options, workflow=None):
    if not supports_native_mlx_biglove_route():
        raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {accelerator_profile()}")
    options = dict(options or {})
    image_names = options.get('image_paths') if isinstance(options.get('image_paths'), list) else [image_path]
    uploaded_images = []
    for item in image_names[:BIGLOVE_KLEIN3_MAX_REFERENCES]:
        p = Path(str(item))
        if not p.is_absolute():
            p = COMFY_INPUT_DIR / str(item)
        uploaded_images.append(p)
    uploaded_image = uploaded_images[0]
    if len(uploaded_images) > 1:
        options['image_paths'] = [str(p) for p in uploaded_images]
    job_id = uuid.uuid4().hex[:12]
    fingerprint = _klein_request_fingerprint(prompt, uploaded_images, options)
    record = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple(job_id, workflow),
        "status": "queued",
        "backend": "mlx-mxfp8-bigloves-klein3-edit",
        "created_at": now_iso(),
        "options": {
            **{k: v for k, v in options.items() if k not in {'negative_prompt', 'loras', 'image_paths', 'studio_lane', 'run_on'}},
            **({'reference_images': len(uploaded_images)} if len(uploaded_images) > 1 else {}),
            **({'lora_count': len(options.get('loras') or [])} if options.get('loras') else {}),
        },
        "source": "comfy-prompt-intercept",
    }
    registered_job_id = _register_klein_job(job_id, fingerprint, record)
    if registered_job_id != job_id:
        return registered_job_id
    args = (job_id, prompt, uploaded_image, options or {}, workflow)
    start_studio_generation_thread(
        'image', options, _run_admitted_klein_job,
        (job_id, fingerprint, run_mlx_klein3_edit, args),
    )
    return job_id

def run_mlx_klein3_edit(job_id, prompt, image_path, options=None, workflow=None):
    started = now_iso()
    options = options or {}
    with jobs_lock:
        queued_rec = jobs.get(job_id) or {}
    # 0 means "no size asked for" and lands on the trained bucket — the old 512
    # fallback would now read as a request for a 0.26MP draft.
    requested_width = int_quality_option(options, 'requested_width', int_quality_option(options, 'width', 0))
    requested_height = int_quality_option(options, 'requested_height', int_quality_option(options, 'height', 0))
    target_width = int_quality_option(options, 'width', requested_width)
    target_height = int_quality_option(options, 'height', requested_height)
    bucket_width, bucket_height = snap_biglove_klein3_resolution(target_width, target_height)
    width, height = _cap_native_mx_dimensions(bucket_width, bucket_height)
    steps = normalize_biglove_klein3_steps(options.get('steps', 4))
    guidance = float_quality_option(options, 'guidance', 1.0)
    seed = resolve_seed_option(options)
    cache_gb = int_option(options, 'mlx_cache_limit_gb', 64, 8, 96)
    native_loras = _dedupe_lora_requests(options.get('loras') or [])
    reference_images = []
    for item in (options.get('image_paths') if isinstance(options.get('image_paths'), list) else [image_path]):
        p = Path(str(item)).resolve()
        reference_images.append(p)
    reference_images = reference_images[:BIGLOVE_KLEIN3_MAX_REFERENCES] or [Path(image_path).resolve()]
    out = OUT_DIR / f"biglove_klein3_mlx_{job_id}.png"
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple(job_id, workflow),
        "status": "running",
        "backend": "mlx-mxfp8-bigloves-klein3-edit",
        "created_at": queued_rec.get("created_at") or started,
        "started_at": started,
        "outputs": [],
        "options": {
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            # Only when the caller actually named a size — 0 is "took the
            # model's own canvas", which `width`/`height` already report.
            **({"requested_width": requested_width} if requested_width > 0 else {}),
            **({"requested_height": requested_height} if requested_height > 0 else {}),
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(native_loras)} if native_loras else {}),
        },
        "current_step": 0,
        "total_steps": steps,
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
        **({'coalesced_requests': queued_rec['coalesced_requests']} if queued_rec.get('coalesced_requests') else {}),
    }
    with jobs_lock:
        latest = jobs.get(job_id) or {}
        if latest.get('coalesced_requests'):
            rec['coalesced_requests'] = latest['coalesced_requests']
        jobs[job_id] = rec
    try:
        if not supports_native_mlx_biglove_route():
            raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {accelerator_profile()}")
        if not SWIFT_FLUX2_BIN.exists():
            raise RuntimeError(f"Swift Flux2 MLX runner not found: {SWIFT_FLUX2_BIN}")
        if not SWIFT_MLX_METALLIB.exists():
            raise RuntimeError(f"Swift Flux2 MLX metallib not found: {SWIFT_MLX_METALLIB}")
        allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), (Path.home() / ".comfy-private.noindex/input").resolve()]
        for ref_path in reference_images:
            if not any(str(ref_path).startswith(str(root)) for root in allowed) or not ref_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
        # Size the canvas from the reference image, not the fixed portrait
        # bucket — the bucket kept its ~1.5MP budget but stretched every
        # non-2:3 source. Same budget, source aspect, then the speed cap.
        width, height = _cap_native_mx_dimensions(
            *_reshape_dims_to_image_aspect(reference_images[0], bucket_width, bucket_height)
        )
        rec["options"].update({"width": width, "height": height})
        with jobs_lock:
            jobs[job_id] = rec
        result = _klein3_native_edit_once(
            prompt,
            reference_images,
            out,
            width=width,
            height=height,
            steps=steps,
            guidance=guidance,
            seed=seed,
            native_loras=native_loras,
            server_job_id=job_id,
            poll_job_id=job_id,
        )
        if result.get("warm_fallback"):
            rec["warm_server_fallback"] = result["warm_fallback"]
        embed_workflow_text_chunk(out, workflow)
        visible_out = mirror_output_to_comfy_output(out, job_id=job_id)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": [str(visible_out.resolve())],
            "elapsed_seconds": result["elapsed"],
            "runner_stdout": result["stdout"],
            "runner_stderr": result["stderr"],
            "current_step": steps,
            "total_steps": steps,
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except Exception as e:
        fallback_note = getattr(e, "warm_fallback", None)
        if fallback_note:
            rec["warm_server_fallback"] = fallback_note
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e)})
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _klein3_native_edit_once(prompt, reference_images, out, *, width, height, steps,
                             guidance, seed, native_loras=None, server_job_id=None,
                             poll_job_id=None):
    """One native Klein 9B edit: warm Swift server first, CLI fallback.

    BigLoveKlein3 MXFP8 is exposed to flux-2-swift-mlx as the local Klein9B transformer.
    The MXFP8 file is pre-dequantized with Comfy's exact E8M0 blocked-scale layout
    so the Swift MLX path can load it cleanly through its bf16 loader.
    The Swift pipeline uses Flux2's correct I2I conditioning path instead of mflux's
    image-latent/noise-injection edit shim, which was producing fuzzy/noisy copies.

    `server_job_id` names the run on the warm server's progress endpoint;
    `poll_job_id` (when set) mirrors that progress into jobs[poll_job_id] via
    poll_swift_flux2_progress. Returns {"elapsed", "stdout", "stderr",
    "warm_fallback"}; raises RuntimeError on failure (with .warm_fallback set
    when the warm server had already been tried)."""
    out = Path(out)
    warm_fallback = None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if use_swift_flux2_server():
        t0 = time.monotonic()
        payload_data = {
            "prompt": prompt,
            "imagePath": str(reference_images[0]),
            "outputPath": str(out),
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            "jobId": server_job_id or out.stem,
        }
        if len(reference_images) > 1:
            payload_data["imagePaths"] = [str(p) for p in reference_images]
        if native_loras:
            payload_data["loras"] = native_loras
        payload = json.dumps(payload_data).encode("utf-8")
        req = Request(
            SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            progress_stop = threading.Event()
            progress_thread = None
            if poll_job_id:
                progress_thread = threading.Thread(
                    target=poll_swift_flux2_progress,
                    args=(poll_job_id, steps, progress_stop),
                    daemon=True,
                )
                progress_thread.start()
            try:
                with urlopen(req, timeout=1200) as resp:
                    server_rec = json.loads(resp.read().decode("utf-8") or "{}")
            finally:
                progress_stop.set()
                if progress_thread is not None:
                    progress_thread.join(timeout=1)
        except Exception as server_error:
            # Keep the single app route reliable: if the warm server is not
            # up yet, fall back to the CLI path below instead of failing the
            # user's generation request.
            server_rec = {"ok": False, "error": f"warm server unavailable: {server_error}"}
        elapsed = round(time.monotonic() - t0, 2)
        if server_rec.get("ok") and out.exists() and out.stat().st_size >= 1000:
            return {
                "elapsed": elapsed,
                "stdout": f"Swift Flux2 persistent server: {server_rec.get('elapsedSeconds')}s",
                "stderr": "",
                "warm_fallback": None,
            }
        warm_fallback = json_safe_text(server_rec.get("error") or "missing output")
        if native_loras:
            error = RuntimeError(f"Swift Flux2 persistent server is required for native LoRA edits: {warm_fallback}")
            error.warm_fallback = warm_fallback
            raise error
    cmd = [
        str(SWIFT_FLUX2_BIN),
        'i2i',
        prompt,
        # Swift ArgumentParser array options take ONE value per flag:
        # --images a --images b. A single flag followed by several paths
        # makes every path after the first an unexpected argument.
        *[arg for p in reference_images for arg in ('--images', str(p))],
        '--model', 'klein-9b',
        '--transformer-quant', 'bf16',
        '--text-quant', '8bit',
        '--vae-variant', 'standard',
        '--steps', str(steps),
        '--guidance', str(guidance),
        '--seed', str(seed),
        '--width', str(width),
        '--height', str(height),
        '--output', str(out),
    ]
    env = os.environ.copy()
    env.setdefault('MLX_METAL_PATH', str(SWIFT_MLX_METALLIB))
    t0 = time.monotonic()
    proc = subprocess.run(cmd, cwd=str(SWIFT_FLUX2_BIN.parent), text=True, capture_output=True, timeout=1200, env=env)
    elapsed = round(time.monotonic() - t0, 2)
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()
    try:
        if proc.returncode != 0:
            raise RuntimeError(f"MLX runner exited {proc.returncode}\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{stderr[-2000:]}")
        if not out.exists() or out.stat().st_size < 1000:
            raise RuntimeError("MLX runner finished without a valid output image")
    except RuntimeError as error:
        if warm_fallback:
            error.warm_fallback = warm_fallback
        raise
    return {
        "elapsed": elapsed,
        "stdout": json_safe_text(stdout),
        "stderr": json_safe_text(stderr),
        "warm_fallback": warm_fallback,
    }


KLEIN_CHARACTER_SHEET_BACKEND = "mlx-klein3-character-sheet"


def _poll_klein_sheet_view_progress(job_id, server_job_id, view_index, view_count, steps, stop_event):
    """Mirror one view's warm-server denoise progress into the sheet job as a
    fraction of the whole sheet, so the studio's ETA bar stays monotonic
    instead of sawtoothing 0-100 once per view."""
    url = SWIFT_FLUX2_SERVER_URL.rstrip("/") + "/progress/" + str(server_job_id)
    while not stop_event.is_set():
        try:
            with urlopen(url, timeout=2) as resp:
                progress_rec = json.loads(resp.read().decode("utf-8") or "{}")
            current = int(progress_rec.get("currentStep") or 0)
            total = int(progress_rec.get("totalSteps") or steps or 1)
            view_fraction = min(1.0, current / max(1, total))
            overall = int(round(((view_index + view_fraction) / max(1, view_count)) * 100))
            with jobs_lock:
                job = jobs.get(job_id)
                if job and job.get("status") == "running":
                    job.update({
                        "current_step": view_index * steps + current,
                        "total_steps": steps * view_count,
                        "progress": max(0, min(100, overall)),
                        "step_progress": int(progress_rec.get("currentStepPercent") or (100 if current > 0 else 0)),
                        "progress_phase": f"view {view_index + 1}/{view_count}",
                    })
                    jobs[job_id] = job
        except Exception:
            pass
        stop_event.wait(0.25)


def queue_klein_character_sheet(prompt, reference_images, options, views, preset=None):
    options = dict(options or {})
    if reference_images:
        options['image_paths'] = [str(Path(p)) for p in reference_images]
    job_id = uuid.uuid4().hex[:12]
    fingerprint = _klein_request_fingerprint(
        prompt,
        reference_images,
        options,
        mode='character-sheet',
        extra={'preset': preset, 'views': views},
    )
    record = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple(job_id, backend=KLEIN_CHARACTER_SHEET_BACKEND),
        "status": "queued",
        "created_at": now_iso(),
        "backend": KLEIN_CHARACTER_SHEET_BACKEND,
        "mode": "character-sheet",
        "options": {
            **{k: v for k, v in options.items() if k not in {'negative_prompt', 'loras', 'image_paths', 'studio_lane', 'run_on'}},
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(options.get('loras') or [])} if options.get('loras') else {}),
        },
        "character_sheet": {
            **({'preset': preset} if preset else {}),
            "views": [view["id"] for view in views],
            "labels": [view["label"] for view in views],
            "total": len(views),
            "completed": 0,
        },
    }
    registered_job_id = _register_klein_job(job_id, fingerprint, record)
    if registered_job_id != job_id:
        return registered_job_id
    args = (job_id, prompt, reference_images, options, views, preset)
    start_studio_generation_thread(
        'image', options, _run_admitted_klein_job,
        (job_id, fingerprint, run_klein_character_sheet, args),
    )
    return job_id


def run_klein_character_sheet(job_id, prompt, reference_images, options=None, views=None, preset=None):
    """The Civitai multi-view recipe on the studio's native Klein edit lane:
    every view is one white-background edit of the SAME reference(s) with the
    SAME seed (identity holds across tiles, like Strength Hunt's fixed seed),
    then a labeled sheet leads the outputs so single-url clients get the sheet
    and History keeps the individual views."""
    started = now_iso()
    options = options or {}
    views = views or []
    with jobs_lock:
        queued_rec = jobs.get(job_id) or {}
    requested_width = int_quality_option(options, 'requested_width', int_quality_option(options, 'width', 1024))
    requested_height = int_quality_option(options, 'requested_height', int_quality_option(options, 'height', 1536))
    # Every tile shares one canvas — the trained portrait bucket. Reshaping to
    # the reference aspect (the single-edit behavior) would make ragged grids
    # from square or landscape references.
    bucket_width, bucket_height = snap_biglove_klein3_resolution(requested_width, requested_height)
    width, height = _cap_native_mx_dimensions(bucket_width, bucket_height)
    steps = normalize_biglove_klein3_steps(options.get('steps', 4))
    guidance = float_quality_option(options, 'guidance', 1.0)
    seed = resolve_seed_option(options)
    native_loras = _dedupe_lora_requests(options.get('loras') or [])
    view_count = len(views)
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple(job_id, backend=KLEIN_CHARACTER_SHEET_BACKEND),
        "status": "running",
        "backend": KLEIN_CHARACTER_SHEET_BACKEND,
        "mode": "character-sheet",
        "created_at": queued_rec.get("created_at") or started,
        "started_at": started,
        "outputs": [],
        "options": {
            "width": width,
            "height": height,
            "steps": steps,
            "guidance": guidance,
            "seed": seed,
            "requested_width": requested_width,
            "requested_height": requested_height,
            **({'reference_images': len(reference_images)} if len(reference_images) > 1 else {}),
            **({'lora_count': len(native_loras)} if native_loras else {}),
        },
        "character_sheet": {
            **({'preset': preset} if preset else {}),
            "views": [view["id"] for view in views],
            "labels": [view["label"] for view in views],
            "total": view_count,
            "completed": 0,
        },
        "current_step": 0,
        "total_steps": steps * max(1, view_count),
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
        **({'coalesced_requests': queued_rec['coalesced_requests']} if queued_rec.get('coalesced_requests') else {}),
    }
    with jobs_lock:
        latest = jobs.get(job_id) or {}
        if latest.get('coalesced_requests'):
            rec['coalesced_requests'] = latest['coalesced_requests']
        jobs[job_id] = rec
    staging_dir = None
    view_outputs = []
    try:
        if not views:
            raise RuntimeError("character sheet needs at least one view")
        if not supports_native_mlx_biglove_route():
            raise RuntimeError(f"native MLX BigLove route is not available for accelerator profile {accelerator_profile()}")
        if not SWIFT_FLUX2_BIN.exists():
            raise RuntimeError(f"Swift Flux2 MLX runner not found: {SWIFT_FLUX2_BIN}")
        if not SWIFT_MLX_METALLIB.exists():
            raise RuntimeError(f"Swift Flux2 MLX metallib not found: {SWIFT_MLX_METALLIB}")
        allowed = [OUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), (Path.home() / ".comfy-private.noindex/input").resolve()]
        resolved_refs = []
        for ref_path in reference_images:
            ref_path = Path(ref_path).resolve()
            if not any(str(ref_path).startswith(str(root)) for root in allowed) or not ref_path.exists():
                raise RuntimeError("input image is outside private image storage or does not exist")
            resolved_refs.append(ref_path)
        staging_dir = Path(tempfile.mkdtemp(prefix=f"charsheet-{job_id}-"))
        t0 = time.monotonic()
        tiles = []
        for index, view in enumerate(views):
            view_prompt = character_sheet_view_prompt(view, prompt)
            out = OUT_DIR / f"charsheet_{job_id}_{index:02d}_{view['id']}.png"
            server_job_id = f"{job_id}-v{index:02d}"
            progress_stop = threading.Event()
            progress_thread = None
            if use_swift_flux2_server():
                progress_thread = threading.Thread(
                    target=_poll_klein_sheet_view_progress,
                    args=(job_id, server_job_id, index, view_count, steps, progress_stop),
                    daemon=True,
                )
                progress_thread.start()
            try:
                _klein3_native_edit_once(
                    view_prompt,
                    resolved_refs,
                    out,
                    width=width,
                    height=height,
                    steps=steps,
                    guidance=guidance,
                    seed=seed,
                    native_loras=native_loras,
                    server_job_id=server_job_id,
                )
            finally:
                progress_stop.set()
                if progress_thread is not None:
                    progress_thread.join(timeout=1)
            # Capture plaintext bytes NOW — the privacy/E2E sweepers may seal
            # the file at any moment, and .e2e envelopes are unreadable
            # server-side by design.
            data, _mime = decrypt_output_bytes(out)
            staged = staging_dir / f"tile_{index:02d}.png"
            staged.write_bytes(data)
            tiles.append({"path": str(staged), "label": view["label"], "index": index})
            visible_out = mirror_output_to_comfy_output(out, job_id=job_id)
            view_outputs.append(str(visible_out.resolve()))
            with jobs_lock:
                job = jobs.get(job_id) or rec
                job["character_sheet"]["completed"] = index + 1
                job.update({
                    "current_step": (index + 1) * steps,
                    "progress": int(round(((index + 1) / view_count) * 100)),
                    "step_progress": 100,
                    "progress_phase": f"view {index + 1}/{view_count} done",
                })
                jobs[job_id] = job
                rec = job
        grid = character_sheet_grid(len(tiles))
        header_lines = [
            f"CHARACTER SHEET · SEED {seed} · STEPS {steps} · GUIDANCE {guidance}",
            f"{view_count} views · " + " / ".join(view["label"] for view in views),
            (prompt or "")[:200],
        ]
        sheet_path = _compose_labeled_sheet(
            OUT_DIR / f"charsheet_{job_id}_sheet.png",
            grid["rows"],
            grid["cols"],
            grid["square"],
            tiles,
            header_lines,
            tag="character-sheet",
        )
        sheet_outputs = []
        if sheet_path is not None:
            sheet_outputs = [str(mirror_output_to_comfy_output(sheet_path, job_id=job_id).resolve())]
        rec["character_sheet"]["sheet"] = bool(sheet_outputs)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": sheet_outputs + view_outputs,
            "elapsed_seconds": round(time.monotonic() - t0, 2),
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except Exception as e:
        # Keep the views that did finish — they are already mirrored, and a
        # partial turnaround is still useful.
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e), "outputs": view_outputs})
    finally:
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


def _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow=None, backend='mlx-ltx-eros-video'):
    extra = {'backend': backend}
    if workflow:
        extra['extra_pnginfo'] = {'workflow': scrub_workflow_prompt_text(workflow)}
    return [0, job_id, {}, extra, []]


def queue_native_mlx_ltx_job(native, workflow=None):
    if not supports_native_mlx_ltx_route():
        raise RuntimeError(f"native MLX LTX route is not available for accelerator profile {accelerator_profile()}")
    variant = native.get('variant')
    spec = LTX2_MLX_VARIANTS.get(variant)
    if not spec:
        raise RuntimeError(f"unknown native MLX LTX variant: {variant}")
    options = dict(native.get('options') or {})
    native = {**native, 'options': options}
    operation = str(native.get('operation') or 'generate')
    native_keyframes = native.get('images') if isinstance(native.get('images'), list) else []
    native_loras = _native_ltx_loras(options.get('loras') or [])
    job_id = uuid.uuid4().hex[:12]
    backend = _ltx_mlx_backend_name(spec, variant)
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "prompt": PRIVATE_PROMPT_LABEL,
            "comfy_prompt": _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow, backend),
            "status": "queued",
            "backend": backend,
            "created_at": now_iso(),
            "outputs": [],
            "options": {
                "variant": variant,
                "title": spec.get('title'),
                "width": options.get('width'),
                "height": options.get('height'),
                "frames": options.get('frames'),
                "frame_rate": options.get('frame_rate'),
                "seed": options.get('seed'),
                "operation": operation,
                **({"ingredient_source_count": options.get('ingredient_source_count'),
                    "ingredient_sheet_columns": options.get('ingredient_sheet_columns'),
                    "ingredient_sheet_rows": options.get('ingredient_sheet_rows'),
                    "ingredient_conditioning_only": options.get('ingredient_conditioning_only', True),
                    } if operation == 'ic-lora' and options.get('ingredient_source_count') else {}),
                **({"source_video": Path(str(native.get('video_path') or '')).name,
                    "duration_seconds": options.get('duration_seconds'),
                    "extension_output_frames": options.get('extension_output_frames'),
                    "extension_latent_frames": options.get('extension_latent_frames', options.get('extend_latent_frames')),
                    "extension_pipeline": "distilled" if options.get('distilled', spec.get('video_distilled', False)) else "dev"} if operation == 'extend' else {}),
                **({'lora_count': len(native_loras), 'loras': [
                    {'name': item.get('name') or Path(str(item.get('source') or '')).name, 'strength': item.get('scale', 1.0)}
                    for item in native_loras
                ]} if native_loras else {}),
                "keyframes": [
                    {
                        "image": Path(str(item.get('image_path') or item.get('image') or '')).name,
                        "frame": item.get('frame'),
                        "strength": item.get('strength'),
                        **({"role": item.get("role")} if item.get("role") else {}),
                    }
                    for item in native_keyframes
                    if isinstance(item, dict)
                ],
                "benchmark_seconds": spec.get('benchmark_seconds'),
            },
            "source": "comfy-prompt-intercept",
        }
    start_studio_generation_thread(
        'video', options, run_native_mlx_ltx_video, (job_id, native, workflow))
    return job_id


def _resolve_native_ltx_image_path(value):
    image_path = Path(str(value or ''))
    if not image_path.is_absolute():
        image_path = COMFY_INPUT_DIR / str(image_path)
    return image_path.resolve()


def _resolve_native_ltx_video_path(value):
    return _resolve_native_ltx_image_path(value)


# Post-generation grain cleanup for the distilled LTX path.
#
# The distilled two-stage pipeline refines the upscaled latent in 3 steps, which
# leaves a fine high-frequency residue that is re-rolled every frame — it reads
# as crawling grain. atadenoise is the right tool: it averages each pixel across
# neighbouring frames ONLY while the pixel stays inside a threshold, so static
# grain is averaged away while anything that actually moves is left alone (a
# plain temporal blur, e.g. hqdn3d's temporal terms, would trade the grain for
# more ghosting). The `strong` tier adds a purely SPATIAL hqdn3d pass — its two
# temporal terms are pinned to 0 for the same reason.
LTX_DENOISE_FILTERS = {
    'light': 'atadenoise=0a=0.02:0b=0.04:1a=0.02:1b=0.04:2a=0.02:2b=0.04:s=9',
    'strong': 'atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08:s=17,hqdn3d=1.5:1.0:0:0',
}


def normalize_ltx_denoise_mode(value):
    """Accept off/light/strong (plus loose truthy spellings); '' means no pass."""
    mode = str(value or '').strip().lower()
    if mode in LTX_DENOISE_FILTERS:
        return mode
    if mode in {'1', 'true', 'yes', 'on'}:
        return 'light'
    return ''


def apply_ltx_denoise_pass(path, mode):
    """Re-encode `path` in place through the grain filter. Returns a detail dict.

    Failure is non-fatal: the untouched original stays on disk, because a clip
    with grain beats no clip at all.
    """
    mode = normalize_ltx_denoise_mode(mode)
    if not mode:
        return None
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return {'mode': mode, 'applied': False, 'error': 'ffmpeg not found'}
    target = Path(path)
    scratch = target.with_name(f'{target.stem}.denoise-tmp{target.suffix or ".mp4"}')
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-i', str(target),
        '-vf', LTX_DENOISE_FILTERS[mode],
        '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        # LTX generates audio alongside the video — keep it bit-exact.
        '-c:a', 'copy',
        '-movflags', '+faststart',
        str(scratch),
    ]
    started = time.monotonic()
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if result.returncode != 0 or not scratch.exists() or scratch.stat().st_size < 1000:
            detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
            scratch.unlink(missing_ok=True)
            return {'mode': mode, 'applied': False, 'error': detail[-400:]}
        os.replace(scratch, target)
        return {'mode': mode, 'applied': True, 'seconds': round(time.monotonic() - started, 2)}
    except Exception as exc:
        scratch.unlink(missing_ok=True)
        return {'mode': mode, 'applied': False, 'error': str(exc)[-400:]}


# BFS "Best Face Swap" head-swap IC-LoRA (Alissonerdx). Its v3 conditioning is a
# GUIDE VIDEO, not a plain reference: every frame reserves a strip filled with
# chroma green holding the replacement face, placed ALONGSIDE the source footage
# so the new identity stays visible for the whole clip. Reproduced from the
# author's own ReservedRegionFrameComposer node (ComfyUI-BFSNodes/nodes.py) using
# the settings baked into workflow_ltx2_head_swap_drag_and_drop_v3.0.json, node 360:
#   ["left", 256, "all_faces_every_frame", 12, "loop", "auto", 100, 12, 12,
#    "center", "center", 0, 255, 0]
# i.e. a 256px strip on the LEFT, face at 100% scale, 12px padding, centred, and
# present in every frame. Getting the strip side or the chroma colour wrong gives
# the model conditioning it was never trained on, so these are not free knobs.
#
# The strip belongs to the GUIDE ONLY. Per the author's model card: "Even though
# the guide video used during inference contains the vertical chroma-key side
# strip, the final generated result does not include that strip." The workflow
# agrees — its sampler latent is sized from the un-stripped source (GetImageSize
# -> SolidMask) and nothing is cropped after VAEDecode. So the render is sized to
# the SOURCE frame, the guide is wider than it, and the output is delivered as-is.
BFS_HEADSWAP_REGION_PX = 256
BFS_HEADSWAP_REGION_POSITION = 'left'
BFS_HEADSWAP_CHROMA = '0x00FF00'
BFS_HEADSWAP_FACE_PADDING_PX = 12
# _prepare_face in the same node adds a 16px white border before placement.
BFS_HEADSWAP_FACE_BORDER_PX = 16
# Both axes of the render must sit on the pipeline's latent grid. Single-stage
# needs multiples of 32, the half-res paths (--upsample-only) need 64; snapping
# to 64 keeps the delivered size identical whichever sampler path is chosen,
# instead of the runtime silently flooring it to something else.
BFS_HEADSWAP_DIMENSION_GRID = 64
# v3's trigger. v1/v2 used a bare "head swap"; v3 is the structured form, and the
# author's card is explicit that the FACE/ACTION sections carry the identity and
# motion description the adapter was trained against.
BFS_HEADSWAP_PROMPT_HELP = (
    'head-swap prompts need the BFS v3 trigger, or the IC-LoRA does not engage and the '
    'render just reproduces the guide. Use:\n'
    '  head_swap: FACE: <apparent gender, ethnicity, skin tone, age range, head shape, hair> '
    'ACTION: <clothing, body position, movement, hand actions, objects, camera-facing behaviour>'
)


def bfs_headswap_lora_selected(item):
    """Is this LoRA entry the BFS head-swap adapter?

    Matched on the filename because that is all the runner carries. The author's
    release is head_swap_v3_rank_adaptive_fro_098.safetensors; earlier versions
    and renames still read as head-swap.
    """
    if not isinstance(item, dict):
        return False
    text = f"{item.get('filePath') or ''} {item.get('name') or ''} {item.get('source') or ''}".lower()
    return 'head_swap' in text or 'head-swap' in text or 'headswap' in text


FACEFUSION_DIR = Path(os.environ.get('FACEFUSION_DIR', str(Path.home() / 'comfy/facefusion')))
HEADSWAP_BACKENDS = ('bfs', 'facefusion')


def _headswap_backend_name(options):
    """Which head-swap engine this job asked for. Unknown values fall back to BFS."""
    raw = (_prompt_string((options or {}).get('head_swap_backend')) or '').strip().lower()
    return raw if raw in HEADSWAP_BACKENDS else 'bfs'


def facefusion_available():
    return (FACEFUSION_DIR / 'facefusion.py').is_file() and (FACEFUSION_DIR / '.venv' / 'bin' / 'python').is_file()


def run_facefusion_head_swap(job_id, native, options, *, started):
    """Swap the face onto the ORIGINAL frames with FaceFusion.

    The opposite trade to BFS: this never regenerates the picture, so body,
    clothing, background and motion stay bit-identical to the source and the
    whole clip is processed rather than a fixed frame budget — but it replaces
    only the face region, so hair and head shape stay the source actor's. No
    prompt, no LoRA, no guide video; none of the LTX preconditions apply.
    """
    if not facefusion_available():
        raise RuntimeError(
            f'FaceFusion is not installed at {FACEFUSION_DIR}. Clone '
            'https://github.com/facefusion/facefusion there and create its .venv, '
            'or point FACEFUSION_DIR at an existing checkout.'
        )
    source_video = _resolve_native_ltx_video_path(native.get('video_path'))
    face_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
    allowed = [COMFY_INPUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), OUT_DIR.resolve()]
    for path, label in ((source_video, 'source video'), (face_image, 'face image')):
        if not path.exists() or not any(_is_under(path, root) for root in allowed):
            raise RuntimeError(f'head-swap {label} is outside private Comfy storage or does not exist')

    out_dir = COMFY_OUTPUT_DIR / 'Eros'
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f'facefusion_headswap_{job_id}.mp4'
    rec = {
        'id': job_id,
        'prompt': PRIVATE_PROMPT_LABEL,
        'status': 'running',
        'backend': 'facefusion',
        'created_at': started,
        'outputs': [],
        'options': {
            'operation': 'head-swap',
            'head_swap_backend': 'facefusion',
            'title': 'FaceFusion head swap',
            'source_video': source_video.name,
            'reference_image': face_image.name,
        },
        'progress': 5,
        'progress_phase': 'facefusion',
    }
    with jobs_lock:
        jobs[job_id] = rec
    # --processors takes a list; face_enhancer restores detail the 128px swapper
    # loses, at roughly double the runtime.
    processors = ['face_swapper']
    if bool_option(options, 'head_swap_face_enhancer', False):
        processors.append('face_enhancer')
    cmd = [
        str(FACEFUSION_DIR / '.venv' / 'bin' / 'python'), 'facefusion.py', 'headless-run',
        '--source-paths', str(face_image),
        '--target-path', str(source_video),
        '--output-path', str(out),
        '--processors', *processors,
        # Apple Silicon has no CUDA; CoreML is what makes this ~10x quicker than
        # the diffusion path rather than slower.
        '--execution-providers', 'coreml',
    ]
    rec['options']['processors'] = list(processors)
    t0 = time.monotonic()
    mark_output_active(out)
    try:
        proc = _run_native_ltx_subprocess(
            job_id, rec, cmd,
            cwd=str(FACEFUSION_DIR),
            env=os.environ.copy(),
            timeout=int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
        )
        elapsed = round(time.monotonic() - t0, 2)
        if proc.returncode != 0:
            raise RuntimeError(
                f'facefusion exited {proc.returncode}\n'
                f'STDOUT:\n{proc.stdout.strip()[-1500:]}\nSTDERR:\n{proc.stderr.strip()[-1500:]}'
            )
        if not out.exists() or out.stat().st_size < 1000:
            raise RuntimeError('facefusion finished without a valid output video')
        width, height = _probe_video_dimensions(out)
        rec['options'].update({'width': width, 'height': height})
        visible_out = mirror_output_to_comfy_output(out, job_id=job_id)
        rec.update({
            'status': 'success',
            'finished_at': now_iso(),
            'outputs': [str(visible_out.resolve())],
            'elapsed_seconds': elapsed,
            'progress': 100,
            'step_progress': 100,
            'progress_phase': 'done',
        })
    except NativeJobCancelled:
        rec.update({'status': 'cancelled', 'finished_at': now_iso(),
                    'error': 'Cancelled by the owner', 'progress_phase': 'cancelled'})
    except Exception as exc:
        rec.update({'status': 'error', 'finished_at': now_iso(),
                    'error': str(exc), 'progress_phase': 'error'})
    finally:
        mark_output_inactive(out)
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec
    return rec


def find_bfs_headswap_lora():
    """Locate the installed BFS head-swap adapter, newest-looking first.

    Matched by name rather than pinned to one filename so a v4 release, or a
    rename, still resolves.
    """
    root = (COMFY / 'models' / 'loras')
    if not root.is_dir():
        return None
    found = [p for p in root.glob('*.safetensors') if bfs_headswap_lora_selected({'filePath': str(p)})]
    return sorted(found)[-1] if found else None


def bfs_headswap_prompt_has_trigger(prompt):
    """Does this prompt carry the v3 trigger the head-swap IC-LoRA expects?"""
    text = (_prompt_string(prompt) or '').lower()
    return 'head_swap:' in text or 'head swap:' in text


class _MultipartPart:
    """One decoded multipart field, shaped like the cgi.FieldStorage item we used."""

    __slots__ = ('name', 'filename', 'value', 'file')

    def __init__(self, name, filename, payload):
        self.name = name
        self.filename = filename or ''
        self.value = payload
        self.file = io.BytesIO(payload) if filename else None


class MultipartForm:
    """Minimal stand-in for cgi.FieldStorage over a multipart/form-data body.

    The `cgi` module was removed in Python 3.13, and this app is launched with
    whatever `python3` resolves to — currently Homebrew's 3.14 — so importing it
    took the whole media gateway down at startup. Only the three operations the
    upload handler actually used are reimplemented here: `getfirst`, `in`, and
    item access returning something with `.file` and `.filename`.
    """

    def __init__(self, body, content_type):
        header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode('utf-8', 'replace')
        message = email.parser.BytesParser(policy=email.policy.default).parsebytes(header + body)
        self._parts = {}
        if not message.is_multipart():
            return
        for part in message.iter_parts():
            disposition = part.get('Content-Disposition')
            if not disposition:
                continue
            name = part.get_param('name', header='Content-Disposition')
            if not name:
                continue
            filename = part.get_filename() or ''
            payload = part.get_payload(decode=True) or b''
            self._parts.setdefault(str(name), []).append(_MultipartPart(str(name), filename, payload))

    def __contains__(self, key):
        return key in self._parts

    def __getitem__(self, key):
        return self._parts[key][0]

    def getfirst(self, key, default=None):
        items = self._parts.get(key)
        if not items:
            return default
        part = items[0]
        if part.filename:
            return default
        return part.value.decode('utf-8', 'replace')


def _probe_video_dimensions(path):
    """(width, height) of a video's first video stream, or raise."""
    ffprobe = shutil.which('ffprobe')
    if not ffprobe:
        raise RuntimeError('ffprobe is required to measure the source video')
    payload = subprocess.check_output(
        [
            ffprobe, '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', str(path),
        ],
        text=True, stderr=subprocess.DEVNULL, timeout=30,
    )
    stream = (json.loads(payload or '{}').get('streams') or [{}])[0]
    width, height = int(stream.get('width') or 0), int(stream.get('height') or 0)
    if width <= 0 or height <= 0:
        raise RuntimeError(f'Could not read video dimensions from {Path(path).name}')
    return width, height


def _snap_headswap_dimension(value, grid=BFS_HEADSWAP_DIMENSION_GRID):
    """Round a pixel dimension to the nearest grid multiple, never below one."""
    snapped = int(round(float(value) / grid)) * grid
    return max(grid, snapped)


def plan_bfs_headswap_geometry(source_width, source_height, *, region_px=None, max_dimension=0):
    """Decide the guide layout and render size for a head swap. Pure arithmetic.

    Mirrors ReservedRegionFrameComposer exactly: the canvas KEEPS the source
    frame size and the footage is fitted into what the strip leaves, centred,
    with chroma filling the rest::

        canvas = Image.new("RGBA", (orig_w, orig_h), ...)
        video_x, video_y = region_size_px, (orig_h - fitted_video_h) // 2

    The render is therefore the SAME size as the guide, and the delivered frame
    is that render untouched. The model was trained to read the fitted, inset
    footage and draw the swapped scene back out across the WHOLE frame — which
    is why the author's card says the result carries no strip and his workflow
    has no crop node. Widening the canvas instead hands the LoRA a layout it has
    never seen and it just copies the guide through.
    """
    region = int(region_px or BFS_HEADSWAP_REGION_PX)
    region -= region % 32
    if region < 32:
        raise RuntimeError('Head-swap face strip must be at least 32px')
    src_w, src_h = int(source_width), int(source_height)
    if src_w <= 0 or src_h <= 0:
        raise RuntimeError('Head-swap source video has no usable dimensions')
    width, height = float(src_w), float(src_h)
    cap = int(max_dimension or 0)
    if cap > 0 and max(width, height) > cap:
        ratio = cap / max(width, height)
        width, height = width * ratio, height * ratio
    frame_w = _snap_headswap_dimension(width)
    frame_h = _snap_headswap_dimension(height)
    available_w = frame_w - region
    if available_w < 64:
        raise RuntimeError(
            f'Head-swap strip ({region}px) leaves no room in a {frame_w}px frame'
        )
    # Fit the footage into what is left, preserving its aspect (the node's
    # "fitted_video_*"). Even dimensions keep libx264/yuv420p happy.
    fit = min(available_w / src_w, frame_h / src_h)
    video_w = max(2, int(round(src_w * fit)) & ~1)
    video_h = max(2, int(round(src_h * fit)) & ~1)
    return {
        'width': frame_w,
        'height': frame_h,
        'region_px': region,
        'video_width': video_w,
        'video_height': video_h,
        'video_x': region if BFS_HEADSWAP_REGION_POSITION == 'left' else 0,
        'video_y': (frame_h - video_h) // 2,
        # The render, and so the delivered frame, is the whole canvas.
        'content_width': frame_w,
        'content_height': frame_h,
        'source_width': src_w,
        'source_height': src_h,
    }


def build_bfs_headswap_guide_video(source_video, face_image, output_path, *, region_px=None, max_dimension=0, frame_rate=None):
    """Compose the BFS head-swap guide clip: reserved face strip + fitted source.

    Reproduces ReservedRegionFrameComposer — same frame size as the source, the
    footage fitted into what the strip leaves and centred, chroma everywhere
    else. The caller renders at ``width`` x ``height`` (the whole canvas) and
    ships that untouched; see the BFS_HEADSWAP_* notes for why nothing is cropped.
    """
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required to build the BFS head-swap guide video')
    src_w, src_h = _probe_video_dimensions(source_video)
    geometry = plan_bfs_headswap_geometry(src_w, src_h, region_px=region_px, max_dimension=max_dimension)
    canvas_w, height = geometry['width'], geometry['height']
    region = geometry['region_px']
    video_w, video_h = geometry['video_width'], geometry['video_height']
    video_x, video_y = geometry['video_x'], geometry['video_y']
    face_w = max(8, region - 2 * BFS_HEADSWAP_FACE_PADDING_PX)
    face_h = max(8, height - 2 * BFS_HEADSWAP_FACE_PADDING_PX)
    face_x = BFS_HEADSWAP_FACE_PADDING_PX if BFS_HEADSWAP_REGION_POSITION == 'left' else canvas_w - region + BFS_HEADSWAP_FACE_PADDING_PX

    output_path.parent.mkdir(parents=True, exist_ok=True)
    filtergraph = (
        f"color=c={BFS_HEADSWAP_CHROMA}:s={canvas_w}x{height}[bg];"
        f"[1:v]pad=iw+{2 * BFS_HEADSWAP_FACE_BORDER_PX}:ih+{2 * BFS_HEADSWAP_FACE_BORDER_PX}:"
        f"{BFS_HEADSWAP_FACE_BORDER_PX}:{BFS_HEADSWAP_FACE_BORDER_PX}:white,"
        f"scale={face_w}:{face_h}:force_original_aspect_ratio=decrease[face];"
        f"[bg][face]overlay=x={face_x}:y=(H-h)/2[withface];"
        # Fitted, not stretched: the node preserves the footage's aspect inside
        # the leftover width and lets chroma take the slack above and below.
        f"[0:v]scale={video_w}:{video_h}[content];"
        f"[withface][content]overlay=x={video_x}:y={video_y}:shortest=1[out]"
    )
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-i', str(source_video),
        '-loop', '1', '-i', str(face_image),
        '-filter_complex', filtergraph,
        '-map', '[out]',
    ]
    if frame_rate:
        # Resample the guide to the RENDER's frame rate. The runtime reads the
        # first N frames of the guide at its native rate, so a 25fps guide driving
        # a 24fps render walks reference frame i and output frame i apart by 4%
        # over the clip — the swapped face lags the motion it is meant to track.
        cmd.extend(['-r', str(frame_rate)])
        geometry['frame_rate'] = float(frame_rate)
    cmd.extend([
        '-c:v', 'libx264', '-crf', '12', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        str(output_path),
    ])
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1000:
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'Head-swap guide build failed: {detail[-400:]}')
    return geometry


# Lightricks' IC-LoRA Detailer. Published against "LTX-2-19b", which reads like a
# different base than our 22B — but it targets transformer_blocks 0..47 at hidden
# dim 4096 and resolves 480/480 modules against the v1.4 transformer, so the two
# share topology and it fuses cleanly. It carries no .alpha tensors, so the
# strength passed here is the whole story.
LTX_DETAILER_LORA = 'LTX2_IC_LoRA_Detailer.safetensors'


def apply_ltx_detailer_pass(path, options, *, model_path, prompt, height, width, frames, frame_rate, seed, job_id, rec, env):
    """Optionally refine `path` in place with the IC-LoRA Detailer.

    This is a genuine second sampling pass, not a filter: the Detailer is an
    IC-LoRA that conditions on reference video frames, so the first pass's own
    output is fed back as the conditioning video.

    Returns None the instant no strength is set, which is what keeps an ordinary
    generation exactly as fast as it was before this existed. Failure is
    non-fatal for the same reason the denoise pass is — the un-refined clip is
    still a clip.
    """
    try:
        strength = float(options.get('detailer_strength') or 0)
    except (TypeError, ValueError):
        return None
    if strength <= 0:
        return None
    strength = max(0.05, min(1.5, strength))

    lora = (COMFY / 'models' / 'loras' / LTX_DETAILER_LORA)
    if not lora.is_file():
        return {'strength': strength, 'applied': False, 'error': f'{LTX_DETAILER_LORA} not installed'}

    target = Path(path)
    scratch = target.with_name(f'{target.stem}.detailer-tmp{target.suffix or ".mp4"}')
    cmd = [
        "uv", "run", "ltx-2-mlx", "ic-lora",
        "--model", str(model_path),
        "--gemma", LTX2_MLX_GEMMA,
        "--prompt", prompt,
        "--lora", str(lora), str(strength),
        # The clip we just made is the reference. Strength 1.0 keeps its
        # structure; the Detailer LoRA is what adds texture on top.
        "--video-conditioning", str(target), "1.0",
        "--single-stage",
        "-H", str(height), "-W", str(width), "-f", str(frames),
        "--frame-rate", str(frame_rate),
        "--seed", str(seed),
        "-o", str(scratch),
    ]
    started = time.monotonic()
    rec["progress_phase"] = "ltx-2-mlx detailer"
    try:
        proc = _run_native_ltx_subprocess(
            job_id, rec, cmd, cwd=str(LTX2_MLX_DIR), env=env,
            timeout=int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
        )
        if proc.returncode != 0 or not scratch.exists() or scratch.stat().st_size < 1000:
            detail = ((proc.stderr or proc.stdout or 'unknown detailer error')).strip()
            scratch.unlink(missing_ok=True)
            return {'strength': strength, 'applied': False, 'error': detail[-400:]}
        os.replace(scratch, target)
        return {'strength': strength, 'applied': True, 'seconds': round(time.monotonic() - started, 2)}
    except NativeJobCancelled:
        scratch.unlink(missing_ok=True)
        raise
    except Exception as exc:
        scratch.unlink(missing_ok=True)
        return {'strength': strength, 'applied': False, 'error': str(exc)[-400:]}


def _create_native_ltx_static_reference_video(image_path, output_path, frames, frame_rate):
    """Encode a lossless repeated reference sheet for MLX IC-LoRA conditioning."""
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required for native MLX IC-LoRA reference conditioning')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    frame_rate_arg = str(int(frame_rate)) if float(frame_rate).is_integer() else str(frame_rate)
    cmd = [
        ffmpeg, '-y', '-loglevel', 'error',
        '-loop', '1', '-framerate', frame_rate_arg,
        '-i', str(image_path),
        '-frames:v', str(frames),
        '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'rgb24',
        str(output_path),
    ]
    result = subprocess.run(cmd, text=True, capture_output=True, timeout=180)
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1000:
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'failed to prepare lossless IC-LoRA reference video: {detail[-1200:]}')
    return output_path


def _native_ltx_runtime_keyframes(native, frames):
    specs = native.get('images') if isinstance(native.get('images'), list) else []
    options = native.get('options') if isinstance(native.get('options'), dict) else {}
    default_crf = int_option(options, 'image_crf', 33, 0, 63)
    if not specs:
        specs = [{'image_path': native.get('image_path'), 'frame': 0, 'strength': 1.0, 'role': 'start'}]
    out = []
    for item in specs:
        if not isinstance(item, dict):
            continue
        image_name = _native_ltx_keyframe_image_name(item) or _prompt_string(item.get('image_path'))
        if not image_name:
            continue
        try:
            frame = max(0, min(frames - 1, int(round(float(item.get('frame', 0))))))
        except Exception:
            frame = 0
        out.append({
            'path': _resolve_native_ltx_image_path(image_name),
            'frame': frame,
            'strength': _native_ltx_keyframe_strength(item),
            'crf': int_option(item, 'crf', default_crf, 0, 63),
            'role': str(item.get('role') or '').strip() or None,
        })
    if not out and native.get('image_path'):
        out.append({
            'path': _resolve_native_ltx_image_path(native.get('image_path')),
            'frame': 0,
            'strength': 1.0,
            'crf': default_crf,
            'role': 'start',
        })
    return sorted(out, key=lambda item: item['frame'])


def _ltx_anchor_cache_path(source, width, height, prompt, seed):
    digest = hashlib.sha256()
    digest.update(b'ltx-anchor-canvas-v4\0')
    digest.update(Path(source).read_bytes())
    digest.update(f'\0{int(width)}x{int(height)}\0{int(seed)}\0'.encode('utf-8'))
    digest.update(str(prompt or '').encode('utf-8'))
    return COMFY_INPUT_DIR / '.ltx-anchor-cache' / f'{digest.hexdigest()[:24]}.png'


def _ltx_target_description(prompt):
    text = str(prompt or '').strip()
    marker = '### Target Description'
    if marker in text:
        return text.rsplit(marker, 1)[1].strip()
    return text


def _stage_ltx_anchor_source_for_comfy(source):
    source = Path(source).resolve()
    input_root = COMFY_INPUT_DIR.resolve()
    if _is_under(source, input_root):
        return source, source.relative_to(input_root).as_posix()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:24]
    suffix = source.suffix.lower() if source.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'} else '.png'
    staged = input_root / '.ltx-anchor-sources' / f'{digest}{suffix}'
    staged.parent.mkdir(parents=True, exist_ok=True)
    if not staged.exists():
        shutil.copyfile(source, staged)
    return staged, staged.relative_to(input_root).as_posix()


def _write_ltx_anchor_resize(source, output, width, height):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise RuntimeError('ffmpeg is required to prepare LTX timeline anchors')
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f'.{output.stem}.{uuid.uuid4().hex[:8]}.tmp.png')
    result = subprocess.run(
        [
            ffmpeg, '-y', '-loglevel', 'error', '-i', str(source),
            '-vf', f'scale={int(width)}:{int(height)}:flags=lanczos',
            '-frames:v', '1', str(temp),
        ],
        text=True,
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0 or not temp.is_file():
        temp.unlink(missing_ok=True)
        detail = (result.stderr or result.stdout or 'unknown ffmpeg error').strip()
        raise RuntimeError(f'failed to resize LTX anchor: {detail[-1200:]}')
    os.replace(temp, output)


def _prepare_native_ltx_anchor_canvas(source, width, height, prompt, seed):
    """Prepare one physical target-sized anchor with the shared Krea graph."""
    source = Path(source).resolve()
    dimensions = _image_dimensions(source)
    if not dimensions:
        raise RuntimeError(f'could not read LTX anchor dimensions: {source.name}')
    source_width, source_height = dimensions
    staged_source, image_name = _stage_ltx_anchor_source_for_comfy(source)
    compiled = build_krea2_turbo_outpaint_prompt(
        prompt,
        image_name,
        source_width=source_width,
        source_height=source_height,
        options={
            'width': width,
            'height': height,
            'seed': seed,
            'steps': 10,
            'cfg': 1.0,
            'ref_boost': 4.0,
            'identity_strength': 1.0,
            'grounding_px': 768,
            'feathering': 48,
        },
        profile=accelerator_profile(),
        filename_prefix='ltx_anchor_canvas',
    )
    geometry = compiled['geometry']
    if geometry['mode'] == 'passthrough':
        return staged_source, geometry

    output = _ltx_anchor_cache_path(staged_source, width, height, prompt, seed)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_file():
        return output, {**geometry, 'cached': True}
    if geometry['mode'] == 'resize':
        _write_ltx_anchor_resize(staged_source, output, width, height)
        return output, {**geometry, 'cached': False}

    graph = compiled['graph']
    prefix = f'ltx_anchor_canvas_{output.stem}'
    graph['12']['inputs']['filename_prefix'] = prefix
    body = json.dumps({
        'prompt': graph,
        'client_id': f'media-ltx-anchor-{uuid.uuid4().hex[:12]}',
    }).encode('utf-8')
    request = Request(
        f'{COMFY_HTTP_DEFAULT}/prompt',
        data=body,
        headers={'Content-Type': 'application/json'},
    )
    try:
        queued = json.loads(urlopen(request, timeout=30).read().decode('utf-8'))
    except HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RuntimeError(f'ComfyUI rejected LTX anchor outpaint graph: {detail[:4000]}') from exc
    prompt_id = queued.get('prompt_id')
    if not prompt_id:
        raise RuntimeError(f'ComfyUI did not return an LTX anchor prompt id: {queued}')

    history = None
    for _ in range(900):
        time.sleep(0.5)
        try:
            payload = urlopen(f'{COMFY_HTTP_DEFAULT}/history/{prompt_id}', timeout=10).read().decode('utf-8')
            data = json.loads(payload or '{}')
            if prompt_id in data:
                history = data[prompt_id]
                break
        except Exception:
            pass
    if history is None:
        raise RuntimeError(f'LTX anchor outpaint timed out waiting for prompt {prompt_id}')
    status = history.get('status') or {}
    if status.get('status_str') != 'success' or not status.get('completed'):
        raise RuntimeError(f'LTX anchor outpaint failed: {status}')
    media = None
    for node_output in (history.get('outputs') or {}).values():
        images = node_output.get('images') or []
        if images:
            media = images[0]
            break
    if not media:
        raise RuntimeError('LTX anchor outpaint completed without an image')
    logical = (COMFY_OUTPUT_DIR / str(media.get('subfolder') or '') / safe_name(media.get('filename') or '')).resolve()
    if logical.is_file():
        image_bytes = logical.read_bytes()
    elif encrypted_path_for(logical).is_file():
        image_bytes, _ = decrypt_output_bytes(logical)
    else:
        raise RuntimeError('LTX anchor outpaint image disappeared before staging')
    temp = output.with_name(f'.{output.stem}.{uuid.uuid4().hex[:8]}.tmp.png')
    temp.write_bytes(image_bytes)
    os.replace(temp, output)
    return output, {**geometry, 'cached': False}


def _update_native_ltx_process_progress(job_id, rec, text):
    matches = list(re.finditer(r"Denoising(?: \(guided\))?:[^\r\n]*?\|\s*(\d+)/(\d+)\s*\[", text))
    if matches:
        current, total = (int(value) for value in matches[-1].groups())
        rec.update({
            "current_step": current,
            "total_steps": total,
            "progress": min(90, 10 + round(80 * current / max(1, total))),
            "step_progress": round(100 * current / max(1, total)),
            "progress_phase": "denoising",
        })
    elif "Decoding video + audio" in text:
        rec.update({"progress": 94, "progress_phase": "decoding"})
    elif "Loading decoders" in text:
        rec.update({"progress": 91, "progress_phase": "loading-decoders"})
    else:
        return
    with jobs_lock:
        jobs[job_id] = rec


class NativeJobCancelled(Exception):
    """The owner cancelled a native generation job; the runner marks it 'cancelled'."""


def native_job_cancel_requested(job_id):
    with jobs_lock:
        return bool((jobs.get(job_id) or {}).get('cancel_requested'))


def _run_native_ltx_subprocess(job_id, rec, cmd, *, cwd, env, timeout=2400):
    """Run ltx-2-mlx while publishing tqdm progress from both output streams."""
    if native_job_cancel_requested(job_id):
        raise NativeJobCancelled(f"job {job_id} was cancelled before the render started")
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    with jobs_lock:
        native_job_procs[job_id] = proc
    streams = [stream for stream in (proc.stdout, proc.stderr) if stream is not None]
    output = {proc.stdout: bytearray(), proc.stderr: bytearray()}
    progress_tail = ""
    started = time.monotonic()
    try:
        while streams:
            if native_job_cancel_requested(job_id):
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                raise NativeJobCancelled(f"job {job_id} was cancelled mid-render")
            if time.monotonic() - started > timeout:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
                raise subprocess.TimeoutExpired(cmd, timeout)
            ready, _, _ = select.select(streams, [], [], 0.25)
            for stream in ready:
                chunk = os.read(stream.fileno(), 8192)
                if not chunk:
                    streams.remove(stream)
                    continue
                output[stream].extend(chunk)
                if len(output[stream]) > 500_000:
                    del output[stream][:-500_000]
                progress_tail = (progress_tail + chunk.decode('utf-8', errors='replace'))[-8192:]
                _update_native_ltx_process_progress(job_id, rec, progress_tail)
        returncode = proc.wait()
    except Exception:
        if proc.poll() is None:
            proc.terminate()
        raise
    finally:
        with jobs_lock:
            if native_job_procs.get(job_id) is proc:
                native_job_procs.pop(job_id, None)
    # The cancel route may have terminated the process directly, between this
    # loop's flag checks — report that as a cancellation, not an exit -15 error.
    if returncode != 0 and native_job_cancel_requested(job_id):
        raise NativeJobCancelled(f"job {job_id} was cancelled mid-render")
    stdout = bytes(output.get(proc.stdout, b'')).decode('utf-8', errors='replace')
    stderr = bytes(output.get(proc.stderr, b'')).decode('utf-8', errors='replace')
    return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=stderr)


def run_native_mlx_ltx_video(job_id, native, workflow=None):
    started = now_iso()
    variant = native.get('variant')
    spec = LTX2_MLX_VARIANTS.get(variant) or {}
    backend = _ltx_mlx_backend_name(spec, variant)
    options = dict(native.get('options') or {})
    operation = str(native.get('operation') or 'generate').strip().lower()
    # FaceFusion is a different kind of tool entirely — a per-frame 2D swap onto
    # the original footage, with no diffusion model, prompt, LoRA or guide. It
    # therefore branches out before every LTX precondition below, which would
    # otherwise demand a model and a prompt it has no use for.
    if operation == 'head-swap' and _headswap_backend_name(options) == 'facefusion':
        return run_facefusion_head_swap(job_id, native, options, started=started)
    prompt = str(native.get('prompt') or '').strip()
    width = int_quality_option(options, 'width', 480)
    height = int_quality_option(options, 'height', 832)
    # Only generate and ic-lora pass -H/-W to the CLI; extend inherits the
    # source clip's size and head-swap re-derives its own from the guide.
    if operation in ('generate', 'ic-lora'):
        snapped = _ltx_snap_render_dimensions(
            width, height,
            single_stage=operation == 'ic-lora' and bool(options.get('single_stage', True)),
        )
        if snapped != (width, height):
            print(f"[ltx] {job_id} render size {width}x{height} is off the pipeline grid; snapped to {snapped[0]}x{snapped[1]}", flush=True)
            width, height = snapped
    frames = _ltx_valid_frame_count(options.get('frames', 233), 233)
    if operation == 'ic-lora':
        frames = max(frames, int_option(options, 'target_min_frames', 9, 9, 721))
    reference_min_frames = int_option(options, 'reference_min_frames', 121, 1, 10000)
    reference_frames = max(frames, reference_min_frames)
    frame_rate = float_quality_option(options, 'frame_rate', 24.0)
    frame_rate_arg = str(int(frame_rate)) if float(frame_rate).is_integer() else str(frame_rate)
    seed = int_option(options, 'seed', 42, 0, 1_000_000_000)
    keyframes = _native_ltx_runtime_keyframes(native, frames)
    native_loras = _native_ltx_loras(options.get('loras') or [])
    cfg_scale = float_quality_option(options, 'cfg_scale', float_quality_option(options, 'cfg', 0.0))
    model_path = Path(str(options.get('model') or spec.get('model') or '')).resolve()
    out_dir = COMFY_OUTPUT_DIR / _ltx_mlx_output_subdir(spec)
    out_dir.mkdir(parents=True, exist_ok=True)
    extension_output_frames = int(options.get('extension_output_frames') or (int(options.get('extend_latent_frames') or 0) * 8))
    extension_latent_frames = int(options.get('extension_latent_frames') or options.get('extend_latent_frames') or 0)
    distilled_extension = operation == 'extend' and bool(options.get('distilled', spec.get('video_distilled', False)))
    output_frame_label = f"extend-{extension_output_frames}f" if operation == 'extend' else f"{frames}f"
    out = out_dir / f"{spec.get('output_prefix', 'mlx_ltx_eros_mobile')}_{job_id}_{output_frame_label}.mp4"
    reference_video_path = None
    rec = {
        "id": job_id,
        "prompt": PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _comfy_history_prompt_tuple_for_native_ltx(job_id, workflow, backend),
        "status": "running",
        "backend": backend,
        "created_at": started,
        "outputs": [],
        "options": {
            "variant": variant,
            "title": spec.get('title'),
            "model": str(model_path),
            "width": width,
            "height": height,
            "frames": frames,
            "frame_rate": frame_rate,
            "seed": seed,
            "operation": operation,
            **({"reference_image": Path(str(native.get('reference_image_path') or '')).name,
                "conditioning_strength": options.get('conditioning_strength', 1.0),
                "reference_strength": options.get('reference_strength', 1.0),
                "reference_frames": reference_frames,
                "single_stage": bool(options.get('single_stage', True)),
                **({"ingredient_source_count": options.get('ingredient_source_count'),
                    "ingredient_sheet_columns": options.get('ingredient_sheet_columns'),
                    "ingredient_sheet_rows": options.get('ingredient_sheet_rows'),
                    "ingredient_conditioning_only": options.get('ingredient_conditioning_only', True),
                    } if options.get('ingredient_source_count') else {}),
                } if operation == 'ic-lora' else {}),
            **({"source_video": Path(str(native.get('video_path') or '')).name,
                "duration_seconds": options.get('duration_seconds'),
                "extension_output_frames": extension_output_frames,
                "extension_latent_frames": extension_latent_frames,
                "extension_pipeline": "distilled" if distilled_extension else "dev"} if operation == 'extend' else {}),
            **({'cfg_scale': cfg_scale} if cfg_scale else {}),
            **({'lora_count': len(native_loras), 'loras': [
                {'name': item.get('name') or Path(str(item.get('source') or '')).name, 'strength': item.get('scale', 1.0)}
                for item in native_loras
            ]} if native_loras else {}),
            "keyframes": [
                {
                    "image": item['path'].name,
                    "frame": item['frame'],
                    "strength": item['strength'],
                    "crf": item['crf'],
                    **({"role": item["role"]} if item.get("role") else {}),
                }
                for item in keyframes
            ],
            "benchmark_seconds": spec.get('benchmark_seconds'),
        },
        "current_step": 0,
        "total_steps": 8 if operation == 'ic-lora' or distilled_extension else (int(options.get('steps') or 30) if operation == 'extend' else 2),
        "progress": 0,
        "step_progress": 0,
        "progress_phase": "queued",
    }
    with jobs_lock:
        jobs[job_id] = rec
    try:
        if not supports_native_mlx_ltx_route():
            raise RuntimeError(f"native MLX LTX route is not available for accelerator profile {accelerator_profile()}")
        if not LTX2_MLX_DIR.exists():
            raise RuntimeError(f"ltx-2-mlx checkout not found: {LTX2_MLX_DIR}")
        if not model_path.exists():
            raise RuntimeError(f"MLX LTX model not found: {model_path}")
        if not prompt:
            raise RuntimeError("prompt is required for native MLX LTX generation")
        allowed = [COMFY_INPUT_DIR.resolve(), COMFY_OUTPUT_DIR.resolve(), OUT_DIR.resolve()]
        source_video = None
        reference_image = None
        # Set only on the head-swap path; the shared post-run block reads it to
        # check the render came back at the size the guide was planned around.
        headswap_guide_info = None
        if operation == 'head-swap':
            # Needs both halves of the guide: the footage to alter and the face to
            # put into it. Validate them together so a missing one fails here with
            # a clear message rather than deep inside the ffmpeg filtergraph.
            source_video = _resolve_native_ltx_video_path(native.get('video_path'))
            if not source_video.exists() or not any(_is_under(source_video, root) for root in allowed):
                raise RuntimeError("head-swap source video is outside private Comfy storage or does not exist")
            reference_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
            if not reference_image.exists() or not any(_is_under(reference_image, root) for root in allowed):
                raise RuntimeError("head-swap face image is outside private Comfy storage or does not exist")
            # The BFS adapter is what teaches the model to read the reserved strip
            # and redraw the scene at full frame — without it the render comes
            # back as a copy of the guide. It is therefore a property of the
            # TASK, not a LoRA the operator has to remember to switch on, so the
            # task supplies it. Requiring it by hand cost several full renders
            # that looked like a compositor bug.
            headswap_lora_strength = float_quality_option(options, 'head_swap_lora_strength', 1.0)
            selected_bfs = [item for item in native_loras if bfs_headswap_lora_selected(item)]
            if selected_bfs:
                # Honour the operator's own entry, but the task owns its strength.
                for item in selected_bfs:
                    item['scale'] = headswap_lora_strength
            else:
                found = find_bfs_headswap_lora()
                if not found:
                    raise RuntimeError(
                        'head-swap needs the BFS head-swap IC-LoRA, and no file matching '
                        f'"head_swap" was found in {(COMFY / "models" / "loras")}. Install it from '
                        'https://civitai.com/models/2027766 (BFS - Best Face Swap).'
                    )
                native_loras.append({
                    'name': found.stem,
                    'filePath': str(found),
                    'scale': headswap_lora_strength,
                })
            if not bfs_headswap_prompt_has_trigger(prompt):
                # Without its trigger the v3 IC-LoRA has nothing to act on, and
                # the cheapest thing the model can do is reproduce the guide it
                # was handed — strip, face box and all. Failing here costs a
                # second; letting it run costs the whole render.
                raise RuntimeError(BFS_HEADSWAP_PROMPT_HELP)
        elif operation == 'extend':
            source_video = _resolve_native_ltx_video_path(native.get('video_path'))
            if not source_video.exists() or not any(_is_under(source_video, root) for root in allowed):
                raise RuntimeError("input video is outside private Comfy storage or does not exist")
        elif operation == 'ic-lora':
            reference_image = _resolve_native_ltx_image_path(native.get('reference_image_path'))
            if not reference_image.exists() or not any(_is_under(reference_image, root) for root in allowed):
                raise RuntimeError("IC-LoRA reference image is outside private Comfy storage or does not exist")
            if not native_loras:
                raise RuntimeError("native MLX IC-LoRA generation requires at least one IC-LoRA model")
            for item in keyframes:
                image_path = item['path']
                if not image_path.exists() or not any(_is_under(image_path, root) for root in allowed):
                    raise RuntimeError("input image is outside private Comfy storage or does not exist")
            dev_transformer = _prompt_string(options.get('dev_transformer'))
            distilled_lora = _prompt_string(options.get('distilled_lora'))
            if dev_transformer and not (model_path / dev_transformer).is_file():
                raise RuntimeError(f"native MLX IC-LoRA dev transformer not found: {dev_transformer}")
            if distilled_lora and not (model_path / distilled_lora).is_file():
                raise RuntimeError(f"native MLX IC-LoRA distilled LoRA not found: {distilled_lora}")
        else:
            # LTX 2.3 generate supports text-to-video: zero keyframes is valid
            # (the ltx-2-mlx CLI simply omits --image). Only validate anchors the
            # caller actually supplied.
            for item in keyframes:
                image_path = item['path']
                if not image_path.exists() or not any(_is_under(image_path, root) for root in allowed):
                    raise RuntimeError("input image is outside private Comfy storage or does not exist")
        lora_root = (COMFY / 'models' / 'loras').resolve()
        for item in native_loras:
            lora_path = Path(str(item.get('filePath') or '')).resolve() if item.get('filePath') else None
            if not lora_path or not lora_path.exists() or not _is_under(lora_path, lora_root):
                raise RuntimeError(f"native MLX LTX LoRA not found: {item.get('source') or item.get('name') or 'unnamed LoRA'}")
            item['filePath'] = str(lora_path)
        if operation == 'ic-lora' and keyframes:
            rec.update({'progress': 2, 'progress_phase': 'preparing-anchor'})
            with jobs_lock:
                jobs[job_id] = rec
            prepared_keyframes = []
            preparation = []
            anchor_prompt = _ltx_target_description(prompt)
            for item in keyframes:
                prepared_path, canvas = _prepare_native_ltx_anchor_canvas(
                    item['path'],
                    width,
                    height,
                    anchor_prompt,
                    seed,
                )
                prepared_keyframes.append({**item, 'path': prepared_path})
                preparation.append({
                    **canvas,
                    'frame': item['frame'],
                    **({'role': item['role']} if item.get('role') else {}),
                })
            keyframes = prepared_keyframes
            rec['options']['keyframes'] = [
                {
                    'image': item['path'].name,
                    'frame': item['frame'],
                    'strength': item['strength'],
                    'crf': item['crf'],
                    **({'role': item['role']} if item.get('role') else {}),
                }
                for item in keyframes
            ]
            rec['options']['anchor_preparation'] = preparation
            with jobs_lock:
                jobs[job_id] = rec
        if _env_enabled("ZIMG_LTX_MLX_FREE_COMFY_BEFORE_RUN", "1"):
            rec["progress_phase"] = "free-comfy"
            with jobs_lock:
                jobs[job_id] = rec
            _call_comfy_free_before_ltx()
        if operation == 'extend':
            extend_latent_frames = int_option(options, 'extension_latent_frames', int_option(options, 'extend_latent_frames', 12, 1, 90), 1, 90)
            steps = int_option(options, 'steps', 30, 1, 100)
            stg_scale = float_quality_option(options, 'stg_scale', 1.0)
            cmd = [
                "uv", "run", "ltx-2-mlx", "extend",
                *(["--distilled"] if distilled_extension else []),
                "--model", str(model_path),
                "--gemma", LTX2_MLX_GEMMA,
                "--prompt", prompt,
                "--video", str(source_video),
                "--extend-frames", str(extend_latent_frames),
                "--direction", "after",
            ]
            if not distilled_extension:
                cmd.extend([
                    "--steps", str(steps),
                    "--cfg-scale", str(cfg_scale or 3.0),
                    "--stg-scale", str(stg_scale),
                ])
            cmd.extend(["--seed", str(seed), "-o", str(out)])
        elif operation == 'head-swap':
            # BFS v3 conditions on a composed guide, not the raw footage: the face
            # sits in a reserved chroma strip that stays visible for every frame,
            # which is what gives it identity that survives the whole clip.
            guide_path = COMFY_INPUT_DIR / '.ltx-reference' / f'{job_id}-headswap.mp4'
            guide_info = build_bfs_headswap_guide_video(
                source_video, reference_image, guide_path,
                region_px=int_option(options, 'head_swap_region_px', BFS_HEADSWAP_REGION_PX, 32, 2048),
                max_dimension=int_option(options, 'head_swap_max_dimension', 0, 0, 4096),
                frame_rate=frame_rate,
            )
            headswap_guide_info = guide_info
            rec['options']['head_swap'] = dict(guide_info)
            # Everything that decides whether a head swap works, except the
            # prompt — which stays out of the log on purpose. Diagnosing this
            # from the guide file alone cost several wrong theories.
            print(
                f"[ltx] head-swap {job_id} model={Path(str(model_path)).name}"
                f" render={guide_info['width']}x{guide_info['height']} frames={frames}"
                f" video={guide_info['video_width']}x{guide_info['video_height']}"
                f"@{guide_info['video_x']},{guide_info['video_y']}"
                f" loras={[(Path(str(i['filePath'])).name, i.get('scale', 1.0)) for i in native_loras]}"
                f" ref_strength={float_quality_option(options, 'reference_strength', 1.0)}"
                f" cond_strength={float_quality_option(options, 'conditioning_strength', 1.0)}"
                f" pipeline={_prompt_string(options.get('head_swap_pipeline')) or 'single-stage'}"
                f" trigger={bfs_headswap_prompt_has_trigger(prompt)}",
                flush=True,
            )
            # Render the guide's own frame, which is also the source's frame: the
            # model reads the fitted, inset footage and draws the swapped scene
            # back across the WHOLE frame, so this render IS the deliverable.
            # Nothing is cropped — cropping the strip off is what read as a zoom.
            width, height = guide_info['width'], guide_info['height']
            cmd = [
                "uv", "run", "ltx-2-mlx", "ic-lora",
                "--model", str(model_path),
                "--gemma", LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            cmd.extend([
                "--video-conditioning", str(guide_path), str(float_quality_option(options, 'reference_strength', 1.0)),
                "--conditioning-strength", str(float_quality_option(options, 'conditioning_strength', 1.0)),
            ])
            # --single-stage tracks the control most tightly and is the default.
            # The fast path generates at half res with the control applied
            # throughout, upsamples, then runs a control-aware refine.
            if _prompt_string(options.get('head_swap_pipeline')) == 'fast':
                cmd.extend([
                    "--upsample-only",
                    "--refine-steps", str(int_option(options, 'head_swap_refine_steps', 3, 1, 8)),
                ])
            else:
                cmd.append("--single-stage")
            cmd.extend([
                "-H", str(height), "-W", str(width), "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        elif operation == 'ic-lora':
            reference_video_path = COMFY_INPUT_DIR / '.ltx-reference' / f'{job_id}.mkv'
            _create_native_ltx_static_reference_video(reference_image, reference_video_path, reference_frames, frame_rate)
            cmd = [
                "uv", "run", "ltx-2-mlx", "ic-lora",
                "--model", str(model_path),
                "--gemma", LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            if options.get('dev_transformer'):
                cmd.extend(["--dev-transformer", str(options['dev_transformer'])])
            if options.get('guided_dev'):
                cmd.extend([
                    "--guided-dev",
                    "--stage1-steps", str(options.get('stage1_steps', 30)),
                    "--cfg-scale", str(options.get('cfg_scale', 4.0)),
                    "--stg-scale", str(options.get('stg_scale', 1.0)),
                ])
            if options.get('distilled_lora'):
                cmd.extend([
                    "--distilled-lora", str(options['distilled_lora']),
                    "--distilled-lora-strength", str(options.get('distilled_lora_strength', 0.5)),
                ])
            cmd.extend([
                "--video-conditioning", str(reference_video_path), str(options.get('reference_strength', 1.0)),
                "--conditioning-strength", str(options.get('conditioning_strength', 1.0)),
            ])
            for item in keyframes:
                cmd.extend([
                    "--image", str(item['path']), str(item['frame']), str(item['strength']), str(item['crf'])
                ])
            if options.get('single_stage', True):
                cmd.append("--single-stage")
            if options.get('low_ram', False):
                cmd.append("--low-ram")
            cmd.extend([
                "-H", str(height),
                "-W", str(width),
                "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        else:
            # A distilled package has a distilled transformer and runs the no-CFG
            # --distilled two-stage. A dev package (locally converted v1.4, say)
            # has no distilled transformer, so --distilled would abort at load:
            # --two-stage is its equivalent — dev model + CFG at half res, upscale,
            # then distilled-LoRA refine. Slower, and it needs the q8 build.
            pipeline_flag = "--distilled" if spec.get('video_distilled') else "--two-stage"
            cmd = [
                "uv", "run", "ltx-2-mlx", "generate",
                pipeline_flag,
                "--model", str(model_path),
                "--gemma", LTX2_MLX_GEMMA,
                "--prompt", prompt,
            ]
            # Only the CFG two-stage path has a stage-1 step budget worth tuning;
            # --distilled reads its step count from the sigma table.
            stage1_steps = spec.get('video_stage1_steps')
            if stage1_steps and not spec.get('video_distilled'):
                cmd.extend(["--stage1-steps", str(int(stage1_steps))])
            # NAG carries the negative prompt on the distilled path, which runs
            # cfg=1 and would otherwise ignore it entirely. The dev two-stage
            # path has real CFG and consumes the negative prompt through that.
            negative_prompt = _prompt_string(options.get('negative_prompt'))
            if negative_prompt and spec.get('video_distilled'):
                nag_scale = float_quality_option(options, 'nag_scale', LTX_NAG_DEFAULTS['scale'])
                if nag_scale > 1.0:
                    cmd.extend([
                        "--negative-prompt", negative_prompt,
                        "--nag-scale", str(nag_scale),
                        "--nag-alpha", str(float_quality_option(options, 'nag_alpha', LTX_NAG_DEFAULTS['alpha'])),
                        "--nag-tau", str(float_quality_option(options, 'nag_tau', LTX_NAG_DEFAULTS['tau'])),
                    ])
            for item in keyframes:
                cmd.extend([
                    "--image", str(item['path']), str(item['frame']), str(item['strength']), str(item['crf'])
                ])
            for item in native_loras:
                cmd.extend(["--lora", str(item['filePath']), str(item.get('scale', 1.0))])
            if cfg_scale:
                cmd.extend(["--cfg-scale", str(cfg_scale)])
            cmd.extend([
                "-H", str(height),
                "-W", str(width),
                "-f", str(frames),
                "--frame-rate", frame_rate_arg,
                "--seed", str(seed),
                "-o", str(out),
            ])
        env = os.environ.copy()
        env.setdefault("LTX2_DIT_EVAL_EVERY", "8")
        # Per-variant sampling recipe (sigma ramps, ancestral eta). setdefault keeps
        # an operator-exported value authoritative for one-off experiments.
        for key, value in (spec.get('runtime_env') or {}).items():
            env.setdefault(str(key), str(value))
        if spec.get('runtime_env'):
            rec['options']['sampling_recipe'] = dict(spec['runtime_env'])
        rec["progress_phase"] = "ltx-2-mlx"
        rec["progress"] = 5
        with jobs_lock:
            jobs[job_id] = rec
        t0 = time.monotonic()
        mark_output_active(out)
        try:
            proc = _run_native_ltx_subprocess(
                job_id,
                rec,
                cmd,
                cwd=str(LTX2_MLX_DIR),
                env=env,
                timeout=int_option(options, 'runtime_timeout_seconds', 2400, 60, 14400),
            )
            elapsed = round(time.monotonic() - t0, 2)
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()
            if proc.returncode != 0:
                raise RuntimeError(f"ltx-2-mlx exited {proc.returncode}\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{stderr[-2000:]}")
            # Cancelled between the render finishing and the post passes: stop
            # here rather than spending more GPU time on a clip nobody wants.
            if native_job_cancel_requested(job_id):
                raise NativeJobCancelled(f"job {job_id} was cancelled after the render")
            if not out.exists() or out.stat().st_size < 1000:
                raise RuntimeError("ltx-2-mlx finished without a valid output video")
            # A head-swap render is already the deliverable: the reserved strip is
            # part of the guide the model reads, never part of the frame it draws
            # (author's model card), so there is nothing to crop off. Verify the
            # size we asked for is the size we got, and say so loudly if not.
            if headswap_guide_info:
                got_w, got_h = _probe_video_dimensions(out)
                want_w = headswap_guide_info['width']
                want_h = headswap_guide_info['height']
                if (got_w, got_h) != (want_w, want_h):
                    print(
                        f"[ltx] head-swap {job_id} rendered {got_w}x{got_h}, expected {want_w}x{want_h}",
                        flush=True,
                    )
                rec['options']['head_swap'] = {**headswap_guide_info, 'output_width': got_w, 'output_height': got_h}
            # Both post-passes run while the output is still marked active, so the
            # E2E sweeper never seals the intermediate file out from under them.
            # Detailer first: it resamples the clip, so grain filtering afterwards
            # judges the texture that actually ships.
            detailer_detail = apply_ltx_detailer_pass(
                out, options,
                model_path=model_path, prompt=prompt,
                height=height, width=width, frames=frames,
                frame_rate=frame_rate_arg, seed=seed,
                job_id=job_id, rec=rec, env=env,
            )
            if detailer_detail:
                rec['options']['detailer'] = detailer_detail
                if not detailer_detail.get('applied'):
                    print(f"[ltx] detailer pass skipped for {job_id}: {detailer_detail.get('error')}", flush=True)
            denoise_detail = apply_ltx_denoise_pass(out, options.get('denoise'))
            if denoise_detail:
                rec['options']['denoise'] = denoise_detail
                if not denoise_detail.get('applied'):
                    print(f"[ltx] denoise pass skipped for {job_id}: {denoise_detail.get('error')}", flush=True)
            visible_out = mirror_output_to_comfy_output(out, job_id=job_id)
        finally:
            mark_output_inactive(out)
        rec.update({
            "status": "success",
            "finished_at": now_iso(),
            "outputs": [str(visible_out.resolve())],
            "elapsed_seconds": elapsed,
            "runner_stdout": json_safe_text(stdout),
            "runner_stderr": json_safe_text(stderr),
            "current_step": rec.get("total_steps", 2),
            "total_steps": rec.get("total_steps", 2),
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except NativeJobCancelled:
        rec.update({"status": "cancelled", "finished_at": now_iso(), "error": "Cancelled by the owner", "progress_phase": "cancelled"})
    except Exception as e:
        rec.update({"status": "error", "finished_at": now_iso(), "error": str(e), "progress_phase": "error"})
    finally:
        if reference_video_path:
            try:
                reference_video_path.unlink(missing_ok=True)
            except Exception:
                pass
    append_history(rec)
    with jobs_lock:
        jobs[job_id] = rec


CSS = """
:root{--bg:#08090d;--panel:rgba(255,255,255,.075);--panel2:rgba(255,255,255,.11);--stroke:rgba(255,255,255,.14);--text:#f7f7fb;--muted:#a8a9b8;--pink:#ff4ecd;--violet:#8b5cf6;--cyan:#22d3ee;--green:#34d399;--red:#fb7185;--shadow:0 24px 80px rgba(0,0,0,.45)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 15% 0%,rgba(139,92,246,.36),transparent 32rem),radial-gradient(circle at 90% 8%,rgba(34,211,238,.25),transparent 31rem),radial-gradient(circle at 50% 110%,rgba(255,78,205,.20),transparent 26rem),var(--bg)}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.8),transparent 72%)}
a{color:inherit}.wrap{width:min(1180px,calc(100% - 28px));margin:0 auto;padding:28px 0 112px}.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:24px}.brand{display:flex;gap:13px;align-items:center}.orb{width:46px;height:46px;border-radius:15px;background:linear-gradient(135deg,var(--pink),var(--violet),var(--cyan));box-shadow:0 0 36px rgba(139,92,246,.75)}.eyebrow{color:var(--muted);font-size:13px;letter-spacing:.14em;text-transform:uppercase}.brand h1{margin:0;font-size:24px;line-height:1}.pills{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid var(--stroke);background:rgba(255,255,255,.06);border-radius:999px;padding:8px 12px;color:#d7d8e4;font-size:13px;backdrop-filter:blur(14px)}.tabs{position:sticky;top:10px;z-index:30;display:flex;gap:9px;flex-wrap:wrap;margin:-8px 0 20px;padding:8px;border:1px solid var(--stroke);background:rgba(8,9,13,.72);border-radius:999px;backdrop-filter:blur(18px);box-shadow:0 14px 44px rgba(0,0,0,.24)}.tab{border:1px solid var(--stroke);background:rgba(255,255,255,.06);border-radius:999px;padding:10px 14px;color:#e9e9f3;text-decoration:none;font-weight:750}.tab.active{background:linear-gradient(135deg,rgba(255,78,205,.36),rgba(34,211,238,.22));border-color:rgba(255,255,255,.28)}.bottom-tabs{position:fixed;left:50%;bottom:calc(12px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:1000;width:min(520px,calc(100% - 18px));display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px;border:1px solid rgba(255,255,255,.20);border-radius:24px;background:rgba(8,9,13,.82);backdrop-filter:blur(22px);box-shadow:0 18px 70px rgba(0,0,0,.55)}.bottom-tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:54px;border-radius:17px;text-decoration:none;color:#d8d9e6;font-size:12px;font-weight:850}.bottom-tab .ico{font-size:19px;line-height:1}.bottom-tab.active{color:#fff;background:linear-gradient(135deg,rgba(255,78,205,.42),rgba(139,92,246,.34),rgba(34,211,238,.24));box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr);gap:20px;align-items:stretch}.glass{border:1px solid var(--stroke);background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.06));border-radius:28px;box-shadow:var(--shadow);backdrop-filter:blur(22px)}.composer{padding:24px}.composer h2{font-size:42px;letter-spacing:-.04em;line-height:1.02;margin:0 0 12px}.sub{color:var(--muted);line-height:1.6;margin:0 0 20px}.field{position:relative}textarea{width:100%;min-height:160px;resize:vertical;border:1px solid rgba(255,255,255,.16);outline:none;border-radius:22px;background:rgba(0,0,0,.28);color:var(--text);font:inherit;font-size:16px;line-height:1.55;padding:18px 18px 44px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}textarea:focus{border-color:rgba(34,211,238,.65);box-shadow:0 0 0 4px rgba(34,211,238,.12),inset 0 1px 0 rgba(255,255,255,.05)}.counter{position:absolute;right:16px;bottom:13px;color:var(--muted);font-size:12px}.actions{display:flex;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap}.btn{appearance:none;border:0;border-radius:999px;padding:14px 20px;font-weight:800;color:white;background:linear-gradient(135deg,var(--pink),var(--violet) 48%,var(--cyan));box-shadow:0 12px 32px rgba(139,92,246,.38);cursor:pointer;font-size:16px}.btn:hover{filter:brightness(1.08)}.btn:disabled{opacity:.65;cursor:wait}.hint{color:var(--muted);font-size:13px}.examples{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.chip{border:1px solid var(--stroke);background:rgba(255,255,255,.06);color:#e6e7ef;border-radius:999px;padding:8px 11px;font-size:13px;cursor:pointer}.chip:hover{background:rgba(255,255,255,.12)}
.live{padding:22px;display:flex;flex-direction:column;min-height:100%}.live-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.live h3,.history-head h2{margin:0;font-size:20px}.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--stroke);border-radius:999px;padding:7px 10px;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.05em}.dot{width:8px;height:8px;border-radius:99px;background:var(--muted)}.running .dot,.queued .dot{background:var(--cyan);box-shadow:0 0 16px var(--cyan);animation:pulse 1s infinite}.success .dot{background:var(--green)}.error .dot{background:var(--red)}@keyframes pulse{50%{opacity:.35}}.preview{flex:1;min-height:270px;border:1px dashed rgba(255,255,255,.18);border-radius:23px;background:rgba(0,0,0,.18);display:grid;place-items:center;overflow:hidden;text-align:center;color:var(--muted);padding:18px}.preview img{width:100%;height:100%;object-fit:contain;border-radius:18px}.spinner{width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:var(--cyan);animation:spin 1s linear infinite;margin:0 auto 14px}@keyframes spin{to{transform:rotate(360deg)}}.jobmeta{margin-top:14px;color:var(--muted);font-size:13px;line-height:1.55}.jobmeta code{color:#d8d8e6}.errorbox{color:#fecdd3;background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.25);border-radius:16px;padding:12px;white-space:pre-wrap}
.history{margin-top:24px}.history-head{display:flex;align-items:end;justify-content:space-between;gap:14px;margin-bottom:14px}.history-head p{margin:5px 0 0;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border:1px solid var(--stroke);background:rgba(255,255,255,.07);border-radius:24px;overflow:hidden;box-shadow:0 12px 36px rgba(0,0,0,.25);backdrop-filter:blur(18px)}.thumb{aspect-ratio:1/1;background:rgba(0,0,0,.22);display:grid;place-items:center;color:var(--muted);overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s}.card:hover .thumb img{transform:scale(1.035)}.card-body{padding:14px}.card-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}.prompt{font-size:14px;line-height:1.45;margin:0;color:#f0f0f6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.time{color:var(--muted);font-size:12px;white-space:nowrap}.empty{border:1px dashed var(--stroke);border-radius:24px;padding:32px;text-align:center;color:var(--muted);background:rgba(255,255,255,.045)}.footer{margin-top:22px;color:var(--muted);font-size:13px;text-align:center}pre{white-space:pre-wrap;word-break:break-word}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ram{padding:18px;margin-bottom:20px}.ram-top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.bar{height:13px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid var(--stroke)}.bar>span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),var(--cyan),var(--violet));width:0}.model-section{margin:18px 0 28px}.model-section h2{font-size:22px;margin:0 0 12px}.model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.model{padding:14px;border:1px solid var(--stroke);background:rgba(255,255,255,.065);border-radius:20px}.model.equipped{border-color:rgba(52,211,153,.55);background:rgba(52,211,153,.08)}.model-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.model-name{font-weight:800;word-break:break-word}.model-meta{color:var(--muted);font-size:12px;margin-top:5px}.model-actions{display:flex;gap:8px;align-items:center;margin-top:12px}.mini{border:1px solid var(--stroke);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:8px 12px;font-weight:800;cursor:pointer}.mini.danger{background:rgba(251,113,133,.12)}.mini:disabled{opacity:.45;cursor:not-allowed}.badge{border-radius:999px;padding:5px 8px;font-size:11px;font-weight:900;text-transform:uppercase;background:rgba(255,255,255,.09);color:#dfe0ea}.badge.on{background:rgba(52,211,153,.16);color:#bbf7d0}
.cv-grid{display:flex!important;flex-direction:column;gap:8px;align-items:stretch}.cv-card{position:relative;display:grid;grid-template-columns:86px minmax(0,1fr);min-height:86px;overflow:hidden;padding:0;border-radius:14px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.055);box-shadow:0 6px 20px rgba(0,0,0,.18);backdrop-filter:blur(14px)}.cv-card:hover{border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.08)}.cv-thumb{position:relative;width:86px;height:86px;background:#11141a;border-right:1px solid rgba(255,255,255,.08);overflow:hidden}.cv-thumb img{width:100%;height:100%;object-fit:cover;display:block}.cv-thumb-empty{height:100%;display:grid;place-items:center;padding:8px;color:#7f8490;font-size:11px;line-height:1.15;text-align:center;background:radial-gradient(circle at 50% 0%,rgba(113,112,255,.18),transparent 60%),rgba(0,0,0,.28)}.cv-body{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title actions" "meta actions" "file actions";gap:4px 10px;padding:9px 10px;min-width:0}.cv-title-row{grid-area:title;display:flex;align-items:center;gap:8px;min-width:0}.cv-title{font-size:14px;line-height:1.18;font-weight:820;letter-spacing:-.015em;color:#f7f8f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.cv-downloads{flex:0 0 auto;color:#c8ccda;font-size:11px;font-weight:760;white-space:nowrap}.cv-meta{grid-area:meta;display:flex;flex-wrap:nowrap;gap:5px;margin:0;min-width:0;overflow:hidden}.cv-chip{flex:0 0 auto;max-width:180px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.04);border-radius:7px;padding:3px 6px;color:#b8bdca;font-size:10.5px;font-weight:680;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cv-file{grid-area:file;color:#8f95a3;font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.cv-stats{display:none}.cv-actions{grid-area:actions;align-self:center;display:flex;flex-direction:column;gap:6px;width:92px;margin:0;padding:0}.cv-actions .mini{border-radius:9px;text-align:center;text-decoration:none;padding:7px 8px;font-size:11.5px;line-height:1.1}.cv-actions .mini:first-child{background:#5e6ad2;border-color:#7479dd}.cv-actions .mini:first-child:hover{background:#7170ff}@media (max-width:560px){.cv-card{grid-template-columns:64px minmax(0,1fr);min-height:74px}.cv-thumb{width:64px;height:74px}.cv-body{grid-template-columns:minmax(0,1fr);grid-template-areas:"title" "meta" "file" "actions";gap:4px;padding:8px}.cv-actions{width:auto;flex-direction:row}.cv-actions .mini{flex:1}.cv-downloads{display:none}.cv-chip{max-width:130px}}
.cv-progress{grid-column:1/-1;margin-top:6px;display:none}.cv-progress.on{display:block}.cv-progress-bar{height:8px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.12)}.cv-progress-bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--pink),var(--violet),var(--cyan));transition:width .25s}.cv-progress-text{margin-top:4px;color:#b8bdca;font-size:11px;font-weight:700}
@media (min-width:761px){.bottom-tabs{position:sticky;top:10px;bottom:auto;left:auto;transform:none;width:max-content;max-width:100%;display:flex;grid-template-columns:none;margin:-8px 0 20px;border-radius:999px}.bottom-tab{flex-direction:row;min-height:42px;padding:0 14px}.bottom-tab .ico{font-size:16px}}.mobile-frame{width:100%;height:78vh;border:1px solid var(--stroke);border-radius:26px;background:#000;box-shadow:var(--shadow)}
@media (max-width:900px){.hero{grid-template-columns:1fr}.composer h2{font-size:34px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.top{align-items:flex-start;flex-direction:column}}@media (max-width:560px){.wrap{width:min(100% - 18px,1180px);padding-top:14px}.composer,.live{padding:16px;border-radius:22px}.composer h2{font-size:30px}.grid{grid-template-columns:1fr}.pills{gap:6px}.pill{font-size:12px;padding:7px 9px}}
"""


def status_chip(status):
    s = h(status or "waiting")
    return f'<span class="status {s}"><span class="dot"></span>{s}</span>'


def render_job_page(rec):
    r = public_record(rec)
    status = r.get("status", "unknown")
    active = status in {"queued", "running"}
    refresh = '<meta http-equiv="refresh" content="2">' if active else ""
    urls = r.get("image_urls") or []
    img = f'<a href="{h(urls[0])}" target="_blank"><img src="{h(urls[0])}" alt="Generated image"></a>' if urls else ('<div><div class="spinner"></div><div>Rendering…</div></div>' if active else '<div>No image output.</div>')
    err = f'<div class="errorbox">{h(r.get("error"))}</div>' if r.get("error") else ""
    rid = h(r.get("id"))
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{refresh}<title>Media Studio job {rid}</title><style>{CSS}</style></head><body>
<div class="wrap">
  <header class="top"><div class="brand"><div class="orb"></div><div><div class="eyebrow">Generation detail</div><h1>Media Studio</h1></div></div><a class="pill" href="/?token={TOKEN}">← Back to history</a></header>
  <main class="hero">
    <section class="glass live"><div class="live-head"><h3>Job {rid}</h3>{status_chip(status)}</div><div class="preview">{img}</div><div class="jobmeta">{h(nice_time(r.get('finished_at') or r.get('created_at')))} · <code>{rid}</code></div></section>
    <section class="glass composer"><h2>{'Rendering…' if active else 'Result'}</h2><p class="sub">{h(r.get('prompt'))}</p>{err}</section>
  </main>
</div></body></html>'''


def human_bytes(n):
    try: n = float(n)
    except Exception: return '0 B'
    units = ['B','KB','MB','GB','TB']
    i = 0
    while n >= 1024 and i < len(units)-1:
        n /= 1024; i += 1
    return f"{n:.1f} {units[i]}" if i else f"{int(n)} B"


def comfy_json(path, method='GET', data=None):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = Request(COMFY_HTTP_DEFAULT + path, data=body, method=method, headers=headers)
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))



def civitai_token(token_override=None):
    if token_override:
        return str(token_override).strip()
    for key in CIVITAI_TOKEN_ENV_KEYS:
        env = os.environ.get(key)
        if env:
            return env.strip()
    for p in [CIVITAI_TOKEN_FILE]:
        if p.exists():
            tok = p.read_text().strip()
            if tok:
                return tok
    return ''


def civitai_token_status():
    sources = []
    for key in CIVITAI_TOKEN_ENV_KEYS:
        if os.environ.get(key):
            sources.append({'type': 'env', 'name': key, 'set': True})
    sources.append({'type': 'file', 'path': str(CIVITAI_TOKEN_FILE), 'set': CIVITAI_TOKEN_FILE.exists() and bool(CIVITAI_TOKEN_FILE.read_text().strip())})
    return {'configured': bool(civitai_token()), 'sources': sources}


def civitai_headers(token_override=None):
    headers = {'User-Agent': 'Hermes-ZImage-ComfyUI/1.0'}
    tok = civitai_token(token_override)
    if tok:
        headers['Authorization'] = f'Bearer {tok}'
    return headers


def civitai_download_headers():
    # Do not use Authorization for /api/download/models. Civitai redirects to a
    # signed R2/S3 URL, and urllib preserves the Authorization header across the
    # redirect; R2 then treats it as AWS auth and returns 400
    # "Missing x-amz-content-sha256". Put the token in the Civitai URL query
    # instead, then follow the redirect with only normal browser-ish headers.
    return {'User-Agent': 'Hermes-ZImage-ComfyUI/1.0'}


def civitai_download_url(url, token_override=None):
    tok = civitai_token(token_override)
    if not tok:
        return url
    parsed = urlparse(str(url))
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    if host not in {'civitai.com', 'civitai.red'} or not re.search(r'/api/download/models/\d+', parsed.path):
        return url
    qs = parse_qs(parsed.query, keep_blank_values=True)
    if not qs.get('token'):
        qs['token'] = [tok]
    query = urlencode(qs, doseq=True)
    return parsed._replace(query=query).geturl()


def civitai_json(path, params=None, token_override=None):
    query = urlencode({k: v for k, v in (params or {}).items() if v not in (None, '', [])}, doseq=True)
    url = CIVITAI_API + path + (('?' + query) if query else '')
    req = Request(url, headers=civitai_headers(token_override))
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def civitai_search_models(params):
    """Fetch Civitai search results, following cursors until requested limit.

    Civitai's /models endpoint is paginated. The UI's "limit" is treated as the
    desired total count, not just the first API page size, so searches don't look
    artificially truncated.
    """
    clean = {k: v for k, v in (params or {}).items() if v not in (None, '', [])}
    try:
        requested = max(1, min(300, int(clean.get('limit') or 40)))
    except Exception:
        requested = 40
    per_page = min(100, requested)
    clean['limit'] = str(per_page)
    items = []
    metadata = {}
    cursor = clean.get('cursor')
    pages = 0
    while len(items) < requested and pages < 8:
        if cursor:
            clean['cursor'] = cursor
        data = civitai_json('/models', clean)
        pages += 1
        batch = data.get('items') or []
        items.extend(batch)
        metadata = data.get('metadata') or {}
        cursor = metadata.get('nextCursor') or None
        if not cursor or not batch:
            break
    return {'items': items[:requested], 'metadata': {**metadata, 'pagesFetched': pages, 'requestedLimit': requested, 'returned': min(len(items), requested)}}


def resolve_civitai_url(value):
    """Resolve civitai.com or civitai.red URLs to a modelVersionId/fileId."""
    raw = str(value or '').strip()
    if not raw:
        raise RuntimeError('Civitai URL required')
    parsed = urlparse(raw)
    host = (parsed.netloc or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    if host not in {'civitai.com', 'civitai.red'}:
        raise RuntimeError('URL must be from civitai.com or civitai.red')
    qs = parse_qs(parsed.query)
    version_id = (qs.get('modelVersionId') or qs.get('versionId') or qs.get('modelVersion') or [None])[0]
    file_id = (qs.get('fileId') or qs.get('modelFileId') or [None])[0]

    m = re.search(r'/api/download/models/(\d+)', parsed.path)
    if m:
        version_id = version_id or m.group(1)

    if version_id:
        version = civitai_json(f'/model-versions/{int(version_id)}')
        return {'versionId': str(version.get('id') or version_id), 'fileId': str(file_id or ''), 'version': version}

    m = re.search(r'/models/(\d+)', parsed.path)
    if not m:
        raise RuntimeError('Could not find a model or model version id in that Civitai URL')
    model_id = m.group(1)
    model = civitai_json(f'/models/{int(model_id)}')
    versions = model.get('modelVersions') or []
    if not versions:
        raise RuntimeError('No model versions found for that Civitai model URL')
    version = versions[0]
    return {'versionId': str(version.get('id')), 'fileId': str(file_id or ''), 'model': model, 'version': version}


def civitai_version_display_name(version):
    """Human label for a resolved version — lets a caller name a download in flight."""
    model_name = str(((version or {}).get('model') or {}).get('name') or '').strip()
    version_name = str((version or {}).get('name') or '').strip()
    if model_name and version_name and version_name.lower() not in model_name.lower():
        return f'{model_name} · {version_name}'
    return model_name or version_name


def validate_civitai_expected_type(version, expected_type=None):
    expected = str(expected_type or '').strip().lower()
    if not expected:
        return
    actual = str((version.get('model') or {}).get('type') or '').strip()
    normalized_actual = actual.lower().replace(' ', '')
    if expected == 'lora' and not any(token in normalized_actual for token in ('lora', 'locon', 'lycoris')):
        raise RuntimeError(f'Expected a Civitai LoRA URL, but the selected model type is {actual or "unknown"}')


def comfy_dir_for_civitai(model_type, file_name=''):
    mt = (model_type or '').lower().replace(' ', '')
    name = (file_name or '').lower()
    if 'lora' in mt or 'lycoris' in mt: return COMFY / 'models' / 'loras'
    if 'checkpoint' in mt: return COMFY / 'models' / 'checkpoints'
    if 'textualinversion' in mt or 'embedding' in mt: return COMFY / 'models' / 'embeddings'
    if mt == 'vae' or 'vae' in name: return COMFY / 'models' / 'vae'
    if 'controlnet' in mt or 'control' in mt: return COMFY / 'models' / 'controlnet'
    if 'upscaler' in mt or 'upscale' in mt or 'esrgan' in name: return COMFY / 'models' / 'upscale_models'
    if 'motion' in mt or 'animatediff' in mt: return COMFY / 'models' / 'animatediff_models'
    if 'clip' in mt or 'textencoder' in mt: return COMFY / 'models' / 'text_encoders'
    return COMFY / 'models' / safe_name(model_type or 'civitai')


def current_base_models():
    equipped = load_equipped()
    ids = {m.get('id','').lower() for m in equipped}
    names = ' '.join([m.get('name','') for m in equipped]).lower()
    vals = []
    if 'z_image' in names or 'z-image' in names or 'zimage' in names or any(('z_image' in x or 'zimage' in x) for x in ids):
        # Civitai's current canonical base-model filter for Z-Image Turbo LoRAs
        # is "ZImageTurbo". The human-facing spelling "Z-Image" only returns
        # a tiny older slice of results.
        vals += ['ZImageTurbo']
    if 'flux' in names: vals += ['Flux.1 D', 'Flux.1 Dev', 'Flux.1 Schnell', 'Flux']
    if 'sd_xl' in names or 'sdxl' in names or 'illustrious' in names: vals += ['SDXL 1.0', 'Illustrious', 'Pony']
    if 'sd15' in names or 'v1-5' in names or '1.5' in names: vals += ['SD 1.5']
    if not vals:
        vals = ['ZImageTurbo']
    # Civitai uses inconsistent spellings for this base in different places.
    # Keep the canonical display/API value first, but do not show near-duplicate
    # aliases like "Z Image" in the UI.
    seen=[]
    seen_norm=set()
    for v in vals:
        n = normalize_base(v)
        if n not in seen_norm:
            seen.append(v)
            seen_norm.add(n)
    return seen


def normalize_base(v):
    return re.sub(r'[^a-z0-9]+', '', str(v or '').lower())


def civitai_base_model_options(force=False):
    """Return richer Civitai base-model filter options.

    Civitai's public REST API does not provide a stable simple base-model list.
    We keep a broad fallback list and opportunistically harvest live baseModel
    values from top /models pages so new values appear without frontend edits.
    """
    import time
    now = time.time()
    cached = CIVITAI_BASE_MODELS_CACHE.get('items')
    if cached and not force and now - float(CIVITAI_BASE_MODELS_CACHE.get('at') or 0) < CIVITAI_BASE_MODELS_TTL:
        return cached

    values = []
    values.extend(current_base_models())
    values.extend(CIVITAI_FALLBACK_BASE_MODELS)
    try:
        # Sample popular/new models by type and collect version.baseModel strings.
        # Keep this bounded so the UI does not wait on a huge scrape.
        for model_type in ['LORA', 'Checkpoint', 'TextualInversion', 'Controlnet', 'VAE', 'Poses']:
            data = civitai_json('/models', {
                'types': model_type,
                'sort': 'Most Downloaded',
                'period': 'AllTime',
                'limit': '100',
                'primaryFileOnly': 'true',
            })
            for item in data.get('items') or []:
                for version in item.get('modelVersions') or []:
                    if version.get('baseModel'):
                        values.append(str(version.get('baseModel')))
    except Exception:
        # Cloudflare/rate limits/auth hiccups should not break the UI.
        pass

    seen = set()
    out = []
    preferred = {normalize_base(x): i for i, x in enumerate(current_base_models())}
    for raw in values:
        val = str(raw or '').strip()
        if not val:
            continue
        key = normalize_base(val)
        if key in seen:
            continue
        seen.add(key)
        out.append(val)
    out.sort(key=lambda x: (preferred.get(normalize_base(x), 999), x.lower()))
    CIVITAI_BASE_MODELS_CACHE.update({'at': now, 'items': out})
    return out


def compatible_base(base):
    return lora_base_matches(base, current_base_models())


def lora_base_matches(base, base_models):
    cur = {normalize_base(x) for x in (base_models or []) if normalize_base(x)}
    b = normalize_base(base)
    if not b or not cur:
        return False
    return b in cur or any(b.startswith(x) or x.startswith(b) for x in cur)


def lora_sidecar(path):
    return Path(str(path) + '.civitai.json')


def local_loras():
    root = COMFY / 'models' / 'loras'
    out=[]
    if not root.exists():
        return out
    for p in root.rglob('*'):
        if not p.is_file() or p.suffix.lower() not in {'.safetensors','.ckpt','.pt','.pth'}:
            continue
        meta = read_model_metadata(p)
        base = meta.get('baseModel') or meta.get('base_model') or meta.get('modelVersion',{}).get('baseModel') or ''
        if not base or not compatible_base(base):
            continue
        rel = str(p.relative_to(root))
        out.append({'id': rel, 'name': p.name, 'path': str(p), 'baseModel': base or 'Unknown/local', 'metadata': meta, 'selected': False, 'strength': 1.0})
    selected = {x.get('id'): x for x in load_selected_loras()}
    for l in out:
        if l['id'] in selected:
            l['selected'] = True
            l['strength'] = float(selected[l['id']].get('strength', 1.0))
    out.sort(key=lambda x: (not x['selected'], x['name'].lower()))
    return out


def load_selected_loras():
    if not SELECTED_LORAS_FILE.exists():
        return []
    try:
        items = json.loads(SELECTED_LORAS_FILE.read_text())
    except Exception:
        return []
    valid = {l['id']: l for l in local_loras_unfiltered()}
    out=[]
    for item in items:
        lid = item.get('id')
        if lid in valid and compatible_base(valid[lid].get('baseModel')):
            out.append({'id': lid, 'name': valid[lid]['name'], 'strength': float(item.get('strength', 1.0)), 'path': valid[lid]['path'], 'baseModel': valid[lid].get('baseModel','')})
    return out


def local_loras_unfiltered():
    root = COMFY / 'models' / 'loras'
    out=[]
    if not root.exists(): return out
    for p in root.rglob('*'):
        if not p.is_file() or p.suffix.lower() not in {'.safetensors','.ckpt','.pt','.pth'}: continue
        meta = read_model_metadata(p)
        base = meta.get('baseModel') or meta.get('base_model') or meta.get('modelVersion',{}).get('baseModel') or ''
        out.append({'id': str(p.relative_to(root)), 'name': p.name, 'path': str(p), 'baseModel': base, 'metadata': meta})
    return out


def lora_preview_source(path, meta):
    """Return a local image path or remote image URL for a LoRA card."""
    model_path = Path(path)
    candidates = []
    for key in ['preview_url', 'previewUrl', 'image', 'thumbnail']:
        if meta.get(key):
            candidates.append(str(meta.get(key)))
    for ext in ['.preview.png', '.preview.jpg', '.preview.jpeg', '.png', '.jpg', '.jpeg', '.webp']:
        candidates.append(str(model_path.with_suffix(ext)))
    for candidate in candidates:
        if candidate.startswith(('http://', 'https://')):
            return candidate
        preview_path = Path(candidate)
        if not preview_path.is_absolute():
            preview_path = model_path.parent / preview_path
        if preview_path.exists() and preview_path.is_file():
            return str(preview_path.resolve())

    image_groups = [
        (meta.get('civitai') or {}).get('images') or [],
        meta.get('images') or [],
        (meta.get('modelVersion') or {}).get('images') or [],
    ]
    for images in image_groups:
        for image in images:
            if not isinstance(image, dict) or not image.get('url'):
                continue
            if str(image.get('type') or 'image').lower() == 'video':
                continue
            return str(image['url'])
    return ''


def compact_lora_record(item):
    meta = item.get('metadata') if isinstance(item.get('metadata'), dict) else {}
    version = meta.get('modelVersion') if isinstance(meta.get('modelVersion'), dict) else {}
    model = version.get('model') if isinstance(version.get('model'), dict) else {}
    display_name = str(
        model.get('name')
        or meta.get('displayName')
        or meta.get('name')
        or Path(item.get('name') or item.get('id') or 'LoRA').stem
    ).strip()
    trigger_words = version.get('trainedWords') or meta.get('trainedWords') or meta.get('triggerWords') or []
    if isinstance(trigger_words, str):
        trigger_words = [value.strip() for value in re.split(r'[,\n]', trigger_words) if value.strip()]
    trigger_words = [str(value).strip() for value in trigger_words if str(value).strip()][:8]
    return {
        'id': item['id'],
        'name': item['name'],
        'displayName': display_name,
        'baseModel': item.get('baseModel') or 'Unknown/local',
        'triggerWords': trigger_words,
        'hasPreview': bool(lora_preview_source(item['path'], meta)),
        'defaultWeight': 1.0,
        # Version identity from the Civitai sidecar: what a card labels itself with
        # and what an update check compares against. Empty for hand-placed files.
        'versionId': str(version.get('id') or ''),
        'versionName': str(version.get('name') or '').strip(),
        # Civitai's /model-versions payload nests `model` WITHOUT an id and carries
        # the model id on the version itself, so real sidecars only have modelId.
        'modelId': str(version.get('modelId') or model.get('id') or ''),
    }


# ── LoRA data cache (encrypted at rest) ─────────────────────────────────────────
# Card previews and Civitai version lists are the only LoRA data that comes from the
# internet, and both used to be re-fetched constantly: the preview route pulled every
# remote image on every request, and the version list lived in memory alone, so a
# gateway restart re-asked Civitai about every installed LoRA.
#
# On disk entries are AES-256-CBC with the same machine key the outputs use, under
# hashed filenames — a LoRA collection is as private as the images it makes, so the
# cache must not name what is installed. In memory they stay plaintext (bounded) so
# repeat reads skip the key derivation entirely.
#
# Preview entries are keyed by the installed file's IDENTITY (id + size + mtime), so
# an updated or replaced LoRA can never serve its predecessor's image, and entries
# for LoRAs that are gone are pruned the next time the catalog is read.
LORA_CACHE_DIR = GATEWAY_STATE_DIR / "lora-cache"
LORA_PREVIEW_CACHE_DIR = LORA_CACHE_DIR / "previews"
LORA_VERSION_CACHE_DIR = LORA_CACHE_DIR / "versions"
LORA_CACHE_MEMORY_LIMIT = int(os.environ.get("ZIMG_LORA_CACHE_MEMORY_BYTES", str(32 * 1024 * 1024)))
LORA_CACHE_PASS_ENV = "HIVEMIND_LORA_CACHE_PASS"
_lora_cache_memory = {}
_lora_cache_memory_bytes = 0
_lora_cache_lock = threading.Lock()


def _lora_cache_recall(key):
    with _lora_cache_lock:
        return _lora_cache_memory.get(key)


def _lora_cache_remember(key, payload):
    global _lora_cache_memory_bytes
    if len(payload) > LORA_CACHE_MEMORY_LIMIT:
        return
    with _lora_cache_lock:
        if key in _lora_cache_memory:
            return
        while _lora_cache_memory and _lora_cache_memory_bytes + len(payload) > LORA_CACHE_MEMORY_LIMIT:
            evicted = next(iter(_lora_cache_memory))
            _lora_cache_memory_bytes -= len(_lora_cache_memory.pop(evicted))
        _lora_cache_memory[key] = payload
        _lora_cache_memory_bytes += len(payload)


def _lora_cache_forget(key):
    global _lora_cache_memory_bytes
    with _lora_cache_lock:
        payload = _lora_cache_memory.pop(key, None)
        if payload is not None:
            _lora_cache_memory_bytes -= len(payload)


def _lora_cache_openssl(args, payload):
    """Run openssl with the machine key in the CHILD ENV rather than on stdin.

    The output encryption passes its password on stdin, which works because it
    encrypts file-to-file. Cache entries are in-memory bytes, and staging them
    through a plaintext temp file would defeat the point of encrypting them, so the
    payload takes stdin and the password rides in the (short-lived) child's env.
    """
    password = output_encryption_password(create=True)
    if not password:
        return None
    env = dict(os.environ)
    env[LORA_CACHE_PASS_ENV] = password
    try:
        proc = subprocess.run(
            ["/usr/bin/openssl", "enc", *args, "-aes-256-cbc", "-pbkdf2",
             "-iter", str(OUTPUT_ENCRYPTION_ITER), "-pass", f"env:{LORA_CACHE_PASS_ENV}"],
            input=payload, capture_output=True, env=env, timeout=60,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return proc.stdout


def lora_cache_store(path, payload):
    sealed = _lora_cache_openssl(["-salt"], payload)
    if not sealed:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(sealed)
        os.replace(tmp, path)
        return True
    except Exception:
        return False


def lora_cache_load(path):
    try:
        if not path.is_file():
            return None
        sealed = path.read_bytes()
    except Exception:
        return None
    return _lora_cache_openssl(["-d"], sealed)


def lora_cache_key(item, extra=""):
    """Cache identity for an installed LoRA: change the file, change the key."""
    try:
        stat = Path(item.get("path") or "").stat()
        identity = f"{item.get('id')}|{stat.st_size}|{stat.st_mtime_ns}|{extra}"
    except OSError:
        return ""
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]


def lora_preview_cache_path(key):
    return LORA_PREVIEW_CACHE_DIR / f"{key}.enc"


def cached_lora_preview(item, source):
    """(bytes, content_type) for a remote preview already fetched, else None."""
    key = lora_cache_key(item, source)
    if not key:
        return None
    payload = _lora_cache_recall(key)
    if payload is None:
        payload = lora_cache_load(lora_preview_cache_path(key))
        if payload is None:
            return None
        _lora_cache_remember(key, payload)
    content_type, _, data = payload.partition(b"\n")
    if not data:
        return None
    return data, content_type.decode("utf-8", "replace") or "image/jpeg"


def cache_lora_preview(item, source, data, content_type):
    key = lora_cache_key(item, source)
    if not key or not data:
        return
    payload = f"{content_type or 'image/jpeg'}\n".encode("utf-8") + data
    _lora_cache_remember(key, payload)
    lora_cache_store(lora_preview_cache_path(key), payload)


def lora_version_cache_path(model_id):
    name = hashlib.sha256(f"model:{model_id}".encode("utf-8")).hexdigest()[:32]
    return LORA_VERSION_CACHE_DIR / f"{name}.enc"


def cached_model_versions(model_id):
    payload = lora_cache_load(lora_version_cache_path(model_id))
    if not payload:
        return None
    try:
        record = json.loads(payload.decode("utf-8"))
    except Exception:
        return None
    return record if isinstance(record, dict) and isinstance(record.get("versions"), list) else None


def cache_model_versions(model_id, record):
    try:
        lora_cache_store(lora_version_cache_path(model_id), json.dumps(record).encode("utf-8"))
    except Exception:
        pass


def prune_lora_caches(items):
    """Drop cached data for LoRAs that were deleted, replaced, or updated.

    A replaced file changes its own preview key, so this both removes the orphan and
    guarantees the next read refetches. Version lists belong to a Civitai model, not
    to a file, so they survive an update and are dropped only when nothing installed
    refers to that model any more.
    """
    previews, versions = set(), set()
    for item in items or []:
        source = lora_preview_source(item.get("path"), item.get("metadata") or {})
        if str(source).startswith(("http://", "https://")):
            key = lora_cache_key(item, source)
            if key:
                previews.add(f"{key}.enc")
        model_id = compact_lora_record(item).get("modelId")
        if model_id:
            versions.add(lora_version_cache_path(model_id).name)
    for directory, keep in ((LORA_PREVIEW_CACHE_DIR, previews), (LORA_VERSION_CACHE_DIR, versions)):
        try:
            stale = [p for p in directory.glob("*.enc") if p.name not in keep]
        except Exception:
            continue
        for path in stale:
            try:
                path.unlink()
            except OSError:
                continue
            _lora_cache_forget(path.stem)


def civitai_model_versions(model_id, force=False):
    """Version list for a Civitai model id, cached — update checks are chatty otherwise."""
    import time
    key = str(model_id)
    now = time.time()
    cached = CIVITAI_MODEL_VERSIONS_CACHE.get(key)
    if cached and not force and now - float(cached.get('at') or 0) < CIVITAI_MODEL_VERSIONS_TTL:
        return cached.get('versions') or []
    if not force:
        # Encrypted on disk, so a gateway restart does not re-ask Civitai about
        # every installed LoRA just to redraw the same update badges.
        stored = cached_model_versions(key)
        if stored and now - float(stored.get('at') or 0) < CIVITAI_MODEL_VERSIONS_TTL:
            CIVITAI_MODEL_VERSIONS_CACHE[key] = stored
            return stored.get('versions') or []
    model = civitai_json(f'/models/{int(model_id)}')
    versions = [
        {'id': str(v.get('id') or ''), 'name': str(v.get('name') or ''), 'baseModel': str(v.get('baseModel') or '')}
        for v in (model.get('modelVersions') or [])
        if v.get('id')
    ]
    record = {'at': now, 'versions': versions}
    CIVITAI_MODEL_VERSIONS_CACHE[key] = record
    cache_model_versions(key, record)
    return versions


_VERSION_TOKEN = re.compile(r'^v?\d+(?:[._-]\d+)*[a-z]?$')


def _version_label_tokens(name):
    """Words of a version name with the version numbers removed.

    "Soft Enhance" -> {soft, enhance}; "Krea 2 v1.0" -> {krea}; "v1.1" -> set().
    Digits inside a word go too, so "2vector" and "3vector" are one lineage.
    """
    words = re.split(r'[^a-z0-9]+', str(name or '').lower())
    labels = set()
    for word in words:
        if not word or _VERSION_TOKEN.match(word):
            continue
        stripped = re.sub(r'\d+', '', word)
        if len(stripped) > 1:  # a lone "v" or stray letter carries no meaning
            labels.add(stripped)
    return labels


def _version_numbers(name):
    return [
        tuple(int(part) for part in re.split(r'[._-]', match) if part.isdigit())
        for match in re.findall(r'\d+(?:[._-]\d+)*', str(name or ''))
    ]


def same_version_lineage(installed_name, candidate_name):
    """Whether two version names describe the same thing at different revisions.

    Civitai models publish OPTIONS as versions, not just revisions: "LTX 2.3 -
    Enhancers" ships "Soft Enhance" and "Crisp Enhance" side by side, and the
    higher id is simply the other option, not a newer one. Replacing on that is
    how a Soft install got overwritten with Crisp.

    Heuristic, deliberately conservative: the descriptive words (version numbers
    stripped) must be the same set, or one must be a subset of the other —
    "V4.1 Exp, pre" -> "v4.3_EXP" stays an update, "Soft" -> "Crisp" does not.
    """
    installed = _version_label_tokens(installed_name)
    candidate = _version_label_tokens(candidate_name)
    if not installed or not candidate:
        return True  # a bare "v1.1" says nothing that contradicts the install
    return installed <= candidate or candidate <= installed


def newer_civitai_version(versions, installed_version_id, base_models=None, installed_name=None):
    """The newest version of the SAME base model newer than the installed one, or None.

    Civitai returns versions newest-first, but ids are monotonic per model, so the
    comparison is on the id rather than on list order.

    The base-model filter is what makes this an update rather than a sibling: one
    Civitai model routinely publishes a version per base (ZImageTurbo, Krea 2, Qwen,
    Flux…), and the Krea 2 version of a Z-Image LoRA is a different adapter, not a
    newer one — replacing with it would swap a working file for an incompatible one.
    """
    try:
        installed = int(installed_version_id)
    except (TypeError, ValueError):
        return None
    wanted = [base for base in (base_models or []) if base]
    newest = None
    for version in versions or []:
        try:
            candidate = int(version.get('id'))
        except (TypeError, ValueError):
            continue
        if candidate <= installed:
            continue
        if wanted:
            candidate_base = version.get('baseModel') or ''
            # No declared base is not evidence of a match; skip rather than guess.
            if not candidate_base or not lora_base_matches(candidate_base, wanted):
                continue
        # A sibling option is not an upgrade path, however high its id.
        if installed_name and not same_version_lineage(installed_name, version.get('name')):
            continue
        if newest is None or candidate > int(newest['id']):
            newest = version
    return newest


def civitai_lora_updates(base_models=None, force=False):
    """Map of installed LoRA id -> newer Civitai version, for the ones that have any.

    Only LoRAs with a Civitai sidecar (model id + version id) can be checked; API
    failures are skipped per model so one rate limit does not hide every update.
    """
    items = local_loras_unfiltered()
    if base_models:
        items = [item for item in items if lora_base_matches(item.get('baseModel'), base_models)]
    out = {}
    for item in items:
        record = compact_lora_record(item)
        model_id, version_id = record.get('modelId'), record.get('versionId')
        if not model_id or not version_id:
            continue
        try:
            versions = civitai_model_versions(model_id, force=force)
        except Exception:
            continue
        # Prefer the installed file's own base model; fall back to the caller's
        # filter when the sidecar never recorded one.
        installed_base = [item.get('baseModel')] if item.get('baseModel') else list(base_models or [])
        newer = newer_civitai_version(versions, version_id, installed_base, record.get('versionName'))
        if not newer:
            continue
        out[record['id']] = {
            'currentVersionId': version_id,
            'currentVersionName': record.get('versionName') or '',
            'latestVersionId': newer['id'],
            'latestVersionName': newer.get('name') or '',
            'latestBaseModel': newer.get('baseModel') or '',
            'modelId': model_id,
            'url': f"https://civitai.com/models/{model_id}?modelVersionId={newer['id']}",
        }
    return out


def resolve_installed_lora_path(lora_id):
    """Absolute path for an installed-LoRA id, refusing anything outside models/loras."""
    root = (COMFY / 'models' / 'loras').resolve()
    candidate = (root / str(lora_id or '')).resolve()
    if candidate == root or root not in candidate.parents:
        raise RuntimeError('Refusing to touch a LoRA outside the ComfyUI loras directory')
    if not candidate.is_file():
        raise RuntimeError(f'No installed LoRA named {lora_id}')
    return candidate


def replace_installed_lora(old_path, result):
    """Retire the superseded file once its replacement is on disk.

    Called only after a successful download, so the old LoRA stays usable for the
    whole transfer. A same-filename update has already overwritten it, in which
    case there is nothing to remove.
    """
    old = Path(old_path).resolve()
    new = Path((result or {}).get('path') or '').resolve()
    if not new.is_file() or old == new:
        return {'removed': '', 'replacedBy': str(new)}
    root = (COMFY / 'models' / 'loras').resolve()
    if root not in old.parents:
        raise RuntimeError('Refusing to remove a LoRA outside the ComfyUI loras directory')
    for sidecar in metadata_sidecars(old):
        sidecar.unlink(missing_ok=True)
    old.unlink(missing_ok=True)
    # Carry the generation selection over to the replacement instead of silently
    # dropping the LoRA out of the active set.
    try:
        old_id = str(old.relative_to(root))
        new_id = str(new.relative_to(root))
        selected = load_selected_loras()
        if any(x.get('id') == old_id for x in selected):
            save_selected_loras([
                {'id': new_id, 'strength': x.get('strength', 1.0)} if x.get('id') == old_id else x
                for x in selected
            ])
    except Exception:
        pass
    return {'removed': str(old), 'replacedBy': str(new)}


def local_lora_catalog(base_models):
    items = local_loras_unfiltered()
    # Opening the panel is the moment the installed set is known, so it is also when
    # cached data for LoRAs that were deleted or replaced stops being reachable.
    prune_lora_caches(items)
    matches = [
        item for item in items
        if lora_base_matches(item.get('baseModel'), base_models)
    ]
    records = [compact_lora_record(item) for item in matches]
    records.sort(key=lambda item: (item['displayName'].lower(), item['name'].lower()))
    return records


def resolve_lora_selection(items, base_models=None):
    available = {item['id']: item for item in local_loras_unfiltered()}
    clean = []
    seen = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        lid = str(item.get('id', '')).strip()
        model = available.get(lid)
        if not model or lid in seen:
            continue
        if base_models and not lora_base_matches(model.get('baseModel'), base_models):
            continue
        try:
            strength = float(item.get('strength', 1.0))
        except Exception:
            strength = 1.0
        strength = max(LORA_STRENGTH_MIN, min(LORA_STRENGTH_MAX, strength))
        clean.append({
            'id': lid,
            'name': model['name'],
            'strength': strength,
            'path': model['path'],
            'baseModel': model.get('baseModel', ''),
        })
        seen.add(lid)
    return clean


def save_selected_loras(items):
    clean = resolve_lora_selection(items, current_base_models())
    SELECTED_LORAS_FILE.write_text(json.dumps(clean, indent=2))
    return clean


def selected_lora_id_for_model(model):
    """Return the ComfyUI lora_name/id for an installed model record, if it is a LoRA."""
    if not model or model.get('folder') != 'loras':
        return ''
    try:
        return str(Path(model.get('path', '')).resolve().relative_to((COMFY / 'models' / 'loras').resolve()))
    except Exception:
        mid = str(model.get('id') or '')
        return mid[len('loras/'):] if mid.startswith('loras/') else str(model.get('name') or '')


def add_lora_to_generation_selection(model, strength=1.0):
    lid = selected_lora_id_for_model(model)
    if not lid:
        return False
    selected = load_selected_loras()
    if any(x.get('id') == lid for x in selected):
        return False
    updated = save_selected_loras(selected + [{'id': lid, 'strength': strength}])
    return any(x.get('id') == lid for x in updated)


def remove_lora_from_generation_selection(model):
    lid = selected_lora_id_for_model(model)
    if not lid:
        return False
    selected = load_selected_loras()
    updated = [x for x in selected if x.get('id') != lid]
    if len(updated) == len(selected):
        return False
    save_selected_loras(updated)
    return True


def summarize_civitai_item(item):
    versions=[]
    for v in item.get('modelVersions') or []:
        files=[]
        for f in v.get('files') or []:
            files.append({'id': f.get('id'), 'name': f.get('name'), 'type': f.get('type'), 'primary': f.get('primary'), 'sizeKB': f.get('sizeKB'), 'metadata': f.get('metadata') or {}, 'downloadUrl': f.get('downloadUrl')})
        versions.append({'id': v.get('id'), 'name': v.get('name'), 'baseModel': v.get('baseModel'), 'trainedWords': v.get('trainedWords') or [], 'files': files, 'downloadUrl': v.get('downloadUrl'), 'images': v.get('images') or []})
    return {'id': item.get('id'), 'name': item.get('name'), 'type': item.get('type'), 'nsfw': item.get('nsfw'), 'creator': (item.get('creator') or {}).get('username'), 'stats': item.get('stats') or {}, 'modelVersions': versions}


class DownloadCancelled(Exception):
    """Raised inside the transfer loop when a caller asks to cancel a download."""


def download_civitai_version(version_id, file_id=None, progress_cb=None, token_override=None, should_cancel=None):
    version = civitai_json(f'/model-versions/{int(version_id)}', token_override=token_override)
    model_type = (version.get('model') or {}).get('type') or 'Model'
    files = version.get('files') or []
    chosen = None
    if file_id:
        chosen = next((f for f in files if str(f.get('id')) == str(file_id)), None)
    if not chosen:
        chosen = next((f for f in files if f.get('primary')), None) or (files[0] if files else None)
    if not chosen:
        raise RuntimeError('No downloadable files on this version')
    dest_dir = comfy_dir_for_civitai(model_type, chosen.get('name'))
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_name(chosen.get('name') or f'civitai_{version_id}.safetensors')
    dest = (dest_dir / filename).resolve()
    if not str(dest).startswith(str((COMFY / 'models').resolve())):
        raise RuntimeError('Refusing to write outside ComfyUI models directory')
    url = chosen.get('downloadUrl') or version.get('downloadUrl') or f'https://civitai.com/api/download/models/{version_id}'
    req = Request(civitai_download_url(url, token_override=token_override), headers=civitai_download_headers())
    try:
        r = urlopen(req, timeout=60)
    except HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            body = ''
        if e.code == 401:
            message = ''
            try:
                parsed = json.loads(body) if body else {}
                message = parsed.get('message') or parsed.get('error') or ''
            except Exception:
                message = body.strip()
            if message:
                message = message.rstrip('. ') + '.'
            # No path here: the token-file location named the owner's home
            # directory in a toast. Settings is where the token is added.
            token_hint = " This model needs a Civitai token — add it in Settings." if not civitai_token(token_override) else ""
            raise RuntimeError(f"Civitai download requires authenticated Civitai access for version {version_id}. {message}{token_hint}".strip()) from e
        raise
    with r:
        total = int(r.headers.get('Content-Length') or chosen.get('sizeKB') or 0)
        if total and total < 1024 * 1024 and chosen.get('sizeKB'):
            total = int(float(chosen.get('sizeKB')) * 1024)
        cd = r.headers.get('Content-Disposition','')
        m = re.search(r"filename\\*?=(?:UTF-8''|utf-8'')?\"?([^\";]+)", cd, re.I)
        if m:
            filename = safe_name(m.group(1).split('/')[-1])
            dest = (dest_dir / filename).resolve()
        tmp = dest.with_suffix(dest.suffix + '.part')
        done = 0
        if progress_cb:
            progress_cb(done, total)
        cancelled = False
        try:
            with tmp.open('wb') as f:
                while True:
                    if should_cancel and should_cancel():
                        cancelled = True
                        break
                    chunk = r.read(1024*1024)
                    if not chunk: break
                    f.write(chunk)
                    done += len(chunk)
                    if progress_cb:
                        progress_cb(done, total)
        except Exception:
            # A reset or a full disk used to leave the .part behind (only the
            # cancel path cleaned up); the partial file is the only trace.
            tmp.unlink(missing_ok=True)
            raise
        if cancelled:
            # Leave nothing half-written behind: the partial file is the only trace.
            tmp.unlink(missing_ok=True)
            raise DownloadCancelled('Download cancelled')
        tmp.rename(dest)
    side = {'downloadedAt': now_iso(), 'modelType': model_type, 'modelVersion': version, 'baseModel': version.get('baseModel'), 'file': chosen}
    lora_sidecar(dest).write_text(json.dumps(side, indent=2))
    return {'ok': True, 'path': str(dest), 'directory': str(dest_dir), 'filename': dest.name, 'modelType': model_type, 'baseModel': version.get('baseModel'), 'versionId': version.get('id'), 'fileId': chosen.get('id')}


def public_download_job(job):
    out = dict(job or {})
    total = int(out.get('total_bytes') or 0)
    done = int(out.get('downloaded_bytes') or 0)
    out['percent'] = int(min(100, max(0, (done / total) * 100))) if total else (100 if out.get('status') == 'success' else 0)
    return out


def cancel_civitai_download_job(job_id):
    """Flag a running download for cancellation; the transfer loop stops at the next chunk."""
    with download_jobs_lock:
        rec = download_jobs.get(job_id)
        if not rec:
            return None
        if rec.get('status') in ('queued', 'running'):
            rec['cancel_requested'] = True
            rec['updated_at'] = now_iso()
            download_jobs[job_id] = rec
            save_download_jobs_unlocked()
        return dict(rec)


def download_job_cancel_requested(job_id):
    with download_jobs_lock:
        return bool((download_jobs.get(job_id) or {}).get('cancel_requested'))


def start_civitai_download_job(version_id, file_id=None, token_override=None, name=None, replace_id=None):
    job_id = uuid.uuid4().hex[:12]
    rec = {'id': job_id, 'status': 'queued', 'created_at': now_iso(), 'versionId': str(version_id), 'fileId': str(file_id or ''), 'downloaded_bytes': 0, 'total_bytes': 0}
    if name:
        # Carried so a caller can label the download before the file lands.
        rec['name'] = str(name)
    replace_path = resolve_installed_lora_path(replace_id) if replace_id else None
    if replace_path:
        # Echoed so a reconnecting client knows which card this download updates.
        rec['replaces'] = str(replace_id)
    with download_jobs_lock:
        download_jobs[job_id] = rec
        save_download_jobs_unlocked()

    def progress(done, total):
        update_download_job(job_id, status='running', downloaded_bytes=int(done or 0), total_bytes=int(total or 0), updated_at=now_iso())

    def worker():
        update_download_job(job_id, status='running', started_at=now_iso())
        try:
            result = download_civitai_version(
                version_id,
                file_id,
                progress_cb=progress,
                token_override=token_override,
                should_cancel=lambda: download_job_cancel_requested(job_id),
            )
            if replace_path:
                # Only now that the replacement is on disk does the old file go.
                result = {**result, 'replaced': replace_installed_lora(replace_path, result)}
            with download_jobs_lock:
                downloaded = download_jobs[job_id].get('total_bytes') or download_jobs[job_id].get('downloaded_bytes', 0)
            update_download_job(job_id, status='success', finished_at=now_iso(), result=result, downloaded_bytes=downloaded)
        except DownloadCancelled:
            update_download_job(job_id, status='cancelled', finished_at=now_iso(), error='Download cancelled')
        except Exception as e:
            update_download_job(job_id, status='error', finished_at=now_iso(), error=str(e))

    threading.Thread(target=worker, daemon=True).start()
    return public_download_job(rec)

def ram_info():
    try:
        s = comfy_json('/system_stats')
        total = int(s.get('system', {}).get('ram_total') or 0)
        free = int(s.get('system', {}).get('ram_free') or 0)
    except Exception:
        total = free = 0
    if total <= 0:
        try:
            out = subprocess.check_output(['vm_stat'], text=True)
            page = 16384
            vals = {}
            for line in out.splitlines():
                if ':' in line:
                    k,v=line.split(':',1); vals[k]=int(re.sub(r'[^0-9]','',v) or 0)
            free = (vals.get('Pages free',0)+vals.get('Pages inactive',0)+vals.get('Pages speculative',0))*page
            total = int(subprocess.check_output(['sysctl','-n','hw.memsize'], text=True).strip())
        except Exception:
            total = free = 0
    equipped = load_equipped()
    reserved = sum(m.get('estimated_ram_bytes', 0) for m in equipped)
    used = max(total - free, 0) if total else 0
    return {'total': total, 'free': free, 'used': used, 'reserved_equipped': reserved, 'safe_free': max(free - 8*1024**3, 0)}


def model_category(folder, name):
    f, n = folder.lower(), name.lower()
    if any(x in n for x in ['wan', 'hunyuan', 'ltx', 'mochi', 'video', 'animatediff', 'svd']):
        return 'Video generation'
    # ComfyUI text_encoders are components for image/video workflows, not chat LLMs.
    # Check this before name-based LLM detection so qwen_3_4b stays with Z-Image parts.
    if any(x in f for x in ['text_encoders', 'clip', 'bert', 't5']): return 'Text encoders'
    if any(x in f for x in ['llm', 'gguf']) or any(x in n for x in ['llama', 'qwen', 'mistral', 'gemma', 'deepseek', 'phi-']):
        return 'LLM / text'
    if any(x in f for x in ['vae']): return 'VAE'
    if any(x in f for x in ['lora']): return 'LoRA / adapters'
    if any(x in f for x in ['controlnet']): return 'Control / conditioning'
    if any(x in f for x in ['upscale', 'esrgan']): return 'Upscalers'
    if any(x in f for x in ['audio', 'music', 'svae']): return 'Audio generation'
    return 'Image generation'


def estimate_ram(size, folder, name):
    factor = 1.25
    if model_category(folder, name) in {'Text encoders','LLM / text'}: factor = 1.15
    if model_category(folder, name) == 'LoRA / adapters': factor = 1.05
    return int(size * factor + 512*1024**2)


def model_role(folder, name):
    f, n = folder.lower(), name.lower()
    if f in {'diffusion_models', 'unet', 'checkpoints'}: return 'primary'
    if f in {'animatediff_models'}: return 'video_motion'
    if f in {'text_encoders', 'clip'}: return 'text_encoder'
    if f == 'vae': return 'vae'
    if f == 'loras': return 'adapter'
    return 'aux'


def scan_civitai_downloads():
    """Return Civitai version/file IDs already present on disk via download sidecars.

    The UI uses this to keep Download buttons as Downloaded after a browser reload,
    because React state only knows about downloads started in the current session.
    """
    root = COMFY / 'models'
    installed = {'versionIds': [], 'fileIds': [], 'byVersion': {}, 'byFile': {}}
    if not root.exists():
        return installed
    seen_versions, seen_files = set(), set()
    for side in root.rglob('*.civitai.json'):
        try:
            meta = json.loads(side.read_text(encoding='utf-8'))
        except Exception:
            continue
        version = meta.get('modelVersion') or {}
        file_meta = meta.get('file') or {}
        model_path = str(side)[:-len('.civitai.json')]
        rec = {
            'path': model_path,
            'filename': Path(model_path).name,
            'modelType': meta.get('modelType'),
            'baseModel': meta.get('baseModel') or version.get('baseModel'),
            'downloadedAt': meta.get('downloadedAt'),
            'versionId': version.get('id'),
            'fileId': file_meta.get('id'),
        }
        vid = str(version.get('id') or '')
        fid = str(file_meta.get('id') or '')
        if vid:
            installed['byVersion'][vid] = rec
            if vid not in seen_versions:
                installed['versionIds'].append(vid); seen_versions.add(vid)
        if fid:
            installed['byFile'][fid] = rec
            if fid not in seen_files:
                installed['fileIds'].append(fid); seen_files.add(fid)
    return installed


def scan_models():
    roots = [COMFY/'models']
    exts = {'.safetensors','.ckpt','.pt','.pth','.bin','.gguf','.onnx'}
    models = []
    base = COMFY/'models'
    if base.exists():
        for p in base.rglob('*'):
            if p.is_file() and p.suffix.lower() in exts and '.part' not in p.name:
                rel = p.relative_to(base)
                folder = rel.parts[0] if len(rel.parts) > 1 else 'models'
                size = p.stat().st_size
                mid = str(rel)
                models.append({'id': mid, 'name': p.name, 'folder': folder, 'path': str(p), 'size_bytes': size, 'size': human_bytes(size), 'category': model_category(folder, p.name), 'role': model_role(folder, p.name), 'estimated_ram_bytes': estimate_ram(size, folder, p.name)})
    models.sort(key=lambda m:(m['category'], m['folder'], m['name'].lower()))
    return models




def read_json_file(path, fallback=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return {} if fallback is None else fallback


def metadata_sidecars(path):
    p = Path(path)
    return [
        Path(str(p) + '.civitai.json'),
        p.with_suffix('.metadata.json'),
        Path(str(p) + '.metadata.json'),
    ]


def read_safetensors_metadata(path):
    """Read lightweight embedded safetensors metadata without loading tensor data."""
    p = Path(path)
    if p.suffix.lower() != '.safetensors':
        return {}
    try:
        import struct
        with p.open('rb') as f:
            raw_len = f.read(8)
            if len(raw_len) != 8:
                return {}
            header_len = struct.unpack('<Q', raw_len)[0]
            # Metadata headers are small; refuse absurd values to avoid reading model data.
            if header_len <= 0 or header_len > 64 * 1024 * 1024:
                return {}
            header = json.loads(f.read(header_len))
        meta = header.get('__metadata__') if isinstance(header, dict) else None
        return meta if isinstance(meta, dict) else {}
    except Exception:
        return {}


def normalize_embedded_lora_metadata(meta):
    """Map common embedded LoRA metadata keys into wrapper fields.

    Trainers are inconsistent: kohya-style LoRAs often use ss_base_model_version,
    newer files may use modelspec.architecture, and some files contain no useful
    compatibility metadata. Keep the raw keys too; only add normalized aliases.
    """
    if not isinstance(meta, dict):
        return {}
    out = dict(meta)
    base = (
        meta.get('baseModel')
        or meta.get('base_model')
        or meta.get('ss_base_model_version')
        or meta.get('modelspec.base_model')
        or meta.get('modelspec.architecture')
        or ''
    )
    if base and not out.get('baseModel'):
        out['baseModel'] = str(base)
    if meta.get('ss_output_name') and not out.get('name'):
        out['name'] = str(meta.get('ss_output_name'))
    return out


def read_model_metadata(path):
    merged = normalize_embedded_lora_metadata(read_safetensors_metadata(path))
    for side in metadata_sidecars(path):
        if side.exists():
            data = read_json_file(side, {})
            if isinstance(data, dict):
                # Sidecars from Civitai/downloads are more authoritative than
                # embedded trainer guesses, so let them override.
                merged.update(data)
    return merged


def preview_for_model(path, meta):
    candidates = []
    for key in ['preview_url', 'previewUrl', 'image', 'thumbnail']:
        if meta.get(key):
            candidates.append(str(meta.get(key)))
    civ = meta.get('civitai') or {}
    for img in (civ.get('images') or meta.get('images') or []):
        if isinstance(img, dict) and img.get('url'):
            candidates.append(str(img.get('url')))
    version = meta.get('modelVersion') or {}
    for img in version.get('images') or []:
        if isinstance(img, dict) and img.get('url'):
            candidates.append(str(img.get('url')))
    p = Path(path)
    for ext in ['.preview.png', '.preview.jpg', '.preview.jpeg', '.png', '.jpg', '.jpeg', '.webp']:
        candidates.append(str(p.with_suffix(ext)))
    for c in candidates:
        if not c:
            continue
        if c.startswith(('http://', 'https://')):
            return c
        # A local candidate only counts if the file is actually there. Absolute paths
        # used to short-circuit this check, so every model reported the FIRST sibling
        # extension whether it existed or not — a preview URL that always 404s.
        cp = Path(c)
        if not cp.is_absolute():
            cp = p.parent / c
        if cp.exists() and cp.is_file():
            return str(cp)
    return ''


def normalize_tags(meta):
    tags = meta.get('tags') or []
    if isinstance(tags, str):
        tags = [x.strip() for x in re.split(r'[,#]', tags) if x.strip()]
    civ = meta.get('civitai') or {}
    model = civ.get('model') or {}
    if isinstance(model.get('tags'), list):
        tags = list(tags) + model.get('tags')
    out=[]; seen=set()
    for t in tags:
        if not t: continue
        tt=str(t).strip()
        k=tt.lower()
        if k not in seen:
            out.append(tt); seen.add(k)
    return out[:24]


def trigger_words(meta):
    words=[]
    for src in [meta.get('civitai') or {}, meta.get('modelVersion') or {}, meta]:
        vals = src.get('trainedWords') or src.get('trigger_words') or []
        if isinstance(vals, str): vals = [x.strip() for x in vals.split(',') if x.strip()]
        if isinstance(vals, list): words += [str(x) for x in vals if x]
    out=[]; seen=set()
    for w in words:
        k=w.lower()
        if k not in seen:
            out.append(w); seen.add(k)
    return out[:20]


def library_item_from_model(m):
    path = Path(m['path'])
    meta = read_model_metadata(path)
    civ = meta.get('civitai') or {}
    civ_model = civ.get('model') or {}
    version = meta.get('modelVersion') or civ
    creator = meta.get('creator') or (civ.get('creator') or {}).get('username') or (civ_model.get('creator') or {}).get('username') or ''
    base = meta.get('base_model') or meta.get('baseModel') or version.get('baseModel') or m.get('baseModel') or ''
    display = meta.get('model_name') or meta.get('name') or civ_model.get('name') or path.stem
    modified = meta.get('modified') or path.stat().st_mtime
    usage = meta.get('usage_tips') or {}
    if isinstance(usage, str):
        try: usage = json.loads(usage)
        except Exception: usage = {'text': usage} if usage else {}
    return {
        **m,
        'displayName': display,
        'baseModel': base or 'Unknown',
        'creator': creator,
        'tags': normalize_tags(meta),
        'triggerWords': trigger_words(meta),
        'preview': preview_for_model(path, meta),
        'favorite': bool(meta.get('favorite')),
        'notes': meta.get('notes') or '',
        'description': meta.get('modelDescription') or version.get('description') or civ_model.get('description') or '',
        'usageTips': usage,
        'dateAdded': datetime.fromtimestamp(float(modified), timezone.utc).isoformat() if modified else '',
        'metadata': meta,
    }


def scan_library():
    models = [library_item_from_model(m) for m in scan_models()]
    buckets = {
        'loras': [],
        'checkpoints': [],
        'embeddings': [],
        'other': [],
    }
    for m in models:
        folder = (m.get('folder') or '').lower()
        role = (m.get('role') or '').lower()
        if 'lora' in folder or role == 'adapter': buckets['loras'].append(m)
        elif folder in {'checkpoints', 'diffusion_models', 'unet'} or role == 'primary': buckets['checkpoints'].append(m)
        elif 'embedding' in folder or 'textualinversion' in folder: buckets['embeddings'].append(m)
        else: buckets['other'].append(m)
    for arr in buckets.values():
        arr.sort(key=lambda x: (not x.get('favorite'), x.get('displayName','').lower()))
    recipes = scan_recipes(models)
    stats = library_stats(buckets, recipes)
    return {'items': models, **buckets, 'recipes': recipes, 'stats': stats, 'baseModels': sorted({m.get('baseModel') for m in models if m.get('baseModel')}), 'tags': top_values(models, 'tags')}


def top_values(models, key, limit=80):
    counts = {}
    for m in models:
        vals = m.get(key) or []
        if not isinstance(vals, list): vals=[vals]
        for v in vals:
            if v:
                counts[str(v)] = counts.get(str(v), 0) + 1
    return [{'name': k, 'count': v} for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))[:limit]]


def scan_recipes(models):
    recipes=[]
    # Treat saved generation history with selected LoRAs as lightweight recipes.
    for rec in load_history(300):
        loras = rec.get('loras') or []
        if not loras: continue
        recipes.append({
            'id': rec.get('id'),
            'title': 'Private recipe',
            'prompt': '',
            'loras': loras,
            'tags': ['history'],
            'created_at': rec.get('created_at') or rec.get('finished_at'),
            'preview': (public_record(rec).get('image_urls') or [''])[0],
        })
    recipe_dir = BASE / 'recipes'
    if recipe_dir.exists():
        for rp in recipe_dir.rglob('*.json'):
            data = read_json_file(rp, {})
            if isinstance(data, dict):
                recipes.append({'id': str(rp.relative_to(recipe_dir)), 'title': data.get('title') or data.get('name') or rp.stem, 'prompt': data.get('prompt') or data.get('positive') or '', 'loras': data.get('loras') or [], 'tags': data.get('tags') or [], 'created_at': data.get('created_at') or '', 'preview': data.get('preview') or ''})
    return recipes[:200]


def library_stats(buckets, recipes):
    allm = buckets['loras'] + buckets['checkpoints'] + buckets['embeddings'] + buckets['other']
    total_bytes = sum(int(m.get('size_bytes') or 0) for m in allm)
    return {
        'totalModels': len(allm),
        'loras': len(buckets['loras']),
        'checkpoints': len(buckets['checkpoints']),
        'embeddings': len(buckets['embeddings']),
        'recipes': len(recipes),
        'totalBytes': total_bytes,
        'favoriteCount': sum(1 for m in allm if m.get('favorite')),
        'taggedCount': sum(1 for m in allm if m.get('tags')),
        'withPreviewCount': sum(1 for m in allm if m.get('preview')),
        'baseModels': top_values(allm, 'baseModel', 30),
        'topTags': top_values(allm, 'tags', 30),
    }


def model_bundles(models=None):
    """Best-effort stack metadata. ComfyUI exposes available files, but not a universal
    primary-model -> encoder/VAE dependency graph, so we combine known manifests
    (e.g. Z-Image) plus workflow/file heuristics. This can be extended as new
    image/video stacks are installed."""
    models = models or scan_models()
    by_id = {m['id']: m for m in models}
    bundles = {}
    def add(primary, label, deps=None, replaces_roles=None, source='manifest'):
        if primary not in by_id: return
        deps = [d for d in (deps or []) if d in by_id]
        bundles[primary] = {
            'primary': primary,
            'label': label,
            'deps': deps,
            'all': [primary] + deps,
            'replaces_roles': replaces_roles or ['primary', 'text_encoder', 'vae'],
            'source': source,
        }
    add('diffusion_models/z_image_turbo_bf16.safetensors', 'Z-Image Turbo stack', ['text_encoders/qwen_3_4b.safetensors', 'vae/ae.safetensors'])
    for m in models:
        if m['folder'] == 'checkpoints' and m['id'] not in bundles:
            add(m['id'], m['name'].replace('.safetensors','').replace('.ckpt','') + ' checkpoint stack', [], ['primary', 'text_encoder', 'vae'], 'checkpoint')
    return bundles


def load_equipped():
    if not EQUIPPED_FILE.exists():
        return []
    try:
        return json.loads(EQUIPPED_FILE.read_text())
    except Exception:
        return []


def save_equipped(items):
    EQUIPPED_FILE.write_text(json.dumps(items, indent=2))


def equip_model(mid):
    models_list = scan_models()
    models = {m['id']: m for m in models_list}
    if mid not in models: return False, 'Model not found'
    bundles = model_bundles(models_list)
    bundle = bundles.get(mid)
    equipped = load_equipped()
    eq_by_id = {m.get('id'): m for m in equipped}
    if bundle:
        desired_ids = set(bundle['all'])
        # Switching a managed image/video stack replaces old primary/text-encoder/VAE
        # components so incompatible encoders do not stay equipped accidentally.
        def role_of(item):
            cur = models.get(item.get('id'), item)
            return cur.get('role') or item.get('role')
        keep = [models.get(m.get('id'), m) for m in equipped if not (role_of(m) in bundle['replaces_roles'] and m.get('id') not in desired_ids)]
        for did in bundle['all']:
            if did not in {m.get('id') for m in keep}:
                keep.append(models[did])
        new_equipped = keep
        added = [models[i]['name'] for i in bundle['all'] if i not in eq_by_id]
        removed = [models.get(m.get('id'), m).get('name') for m in equipped if role_of(m) in bundle['replaces_roles'] and m.get('id') not in desired_ids]
        msg = f"Equipped {bundle['label']}"
        if added: msg += f"; added {', '.join(added)}"
        if removed: msg += f"; replaced {', '.join(removed)}"
    else:
        if any(m.get('id') == mid for m in equipped): return True, 'Already equipped'
        new_equipped = equipped + [models[mid]]
        msg = 'Equipped'
    ram = ram_info()
    reserved = sum(m.get('estimated_ram_bytes', 0) for m in new_equipped)
    limit = max(ram.get('total',0) - 10*1024**3, 0)
    if ram.get('total') and reserved > limit:
        return False, f"Not enough safe RAM: equipping would reserve {human_bytes(reserved)} of {human_bytes(ram['total'])}."
    save_equipped(new_equipped)
    if models[mid].get('folder') == 'loras':
        if add_lora_to_generation_selection(models[mid]):
            msg += '; added to generation selection'
        else:
            msg += '; generation selection unchanged'
    return True, msg


def unequip_model(mid):
    before = load_equipped()
    removed = [m for m in before if m.get('id') == mid]
    after = [m for m in before if m.get('id') != mid]
    save_equipped(after)
    for model in removed:
        remove_lora_from_generation_selection(model)
    try:
        comfy_json('/free', 'POST', {'unload_models': True, 'free_memory': True})
    except Exception:
        pass
    return len(after) != len(before)


class Handler(BaseHTTPRequestHandler):
    server_version = "ZImageEndpoint/1.1"

    def log_message(self, fmt, *args):
        rendered = redact_access_log_message(fmt % args)
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), rendered))

    def auth_cookie_header(self):
        # Query-token auth is awkward for embedded apps because Vite/React emits
        # absolute asset/API URLs without ?token=. Once a user reaches an
        # authenticated wrapper page, persist that auth to a same-origin cookie so
        # iframe assets, /mobile/api/* calls, and /comfy/* proxy calls can load.
        return f"zimg_token={TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"

    def authed(self, query=None):
        if query and query.get("token", [None])[0] == TOKEN:
            self._set_auth_cookie = True
            return True
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {TOKEN}":
            return True
        if self.headers.get("X-Token") == TOKEN:
            return True
        cookie = self.headers.get("Cookie", "")
        if any(part.strip() == f"zimg_token={TOKEN}" for part in cookie.split(";")):
            return True
        return False

    def maybe_auth_cookie(self):
        if getattr(self, "_set_auth_cookie", False):
            self.send_header("Set-Cookie", self.auth_cookie_header())

    def cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors_headers()
        self.end_headers()

    def send_json(self, data, status=200):
        # Handing a caller a NEW job id (202 Accepted) is the one moment we know
        # both the job and who asked for it, for every generate route at once —
        # so that is where an agent registers as a second seal recipient. A 202
        # is always returned before the job finishes, so registration lands well
        # ahead of output sealing. No-op unless ZIMG_AGENT_DUAL_SEAL=1 and the
        # request presented X-E2E-Requester-Pub.
        if status == 202 and isinstance(data, dict) and data.get("id"):
            try:
                register_agent_seal_recipient(data["id"], self.headers.get(REQUESTER_PUB_HEADER))
            except Exception as exc:
                print(f"[agent-seal] register failed: {exc}", file=sys.stderr)
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.maybe_auth_cookie()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, status=200, ctype="text/html; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.maybe_auth_cookie()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, max_bytes=None):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n > (max_bytes or MAX_JSON_BODY_BYTES):
            raise ValueError("request body too large")
        return self.rfile.read(n) if n else b""

    def proxy_to_frontend(self, parsed):
        target_path = parsed.path
        if target_path in {"/models", "/history", "/workbench"}:
            target_path = "/"
        query = parsed.query
        url = FRONTEND_HTTP + target_path + (("?" + query) if query else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "content-length", "authorization", "x-token", "connection", "accept-encoding"}}
        try:
            req = Request(url, method="GET", headers=headers)
            with urlopen(req, timeout=30) as r:
                data = r.read()
                ctype = r.headers.get("Content-Type", mimetypes.guess_type(target_path)[0] or "application/octet-stream")
                self.send_response(r.status)
                self.send_header("Content-Type", ctype)
                if "Cache-Control" in r.headers:
                    self.send_header("Cache-Control", r.headers["Cache-Control"])
                else:
                    self.send_header("Cache-Control", "no-store, max-age=0")
                self.maybe_auth_cookie()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers(); self.wfile.write(data)
        except Exception as e:
            self.send_text(f"Next.js frontend proxy error: {e}\n", 502, "text/plain")

    def comfy_target(self, parsed):
        target_path = parsed.path
        if target_path.startswith("/comfy"):
            target_path = target_path[len("/comfy"):] or "/"
        qs = parse_qs(parsed.query, keep_blank_values=True)
        qs.pop("token", None)
        query = urlencode(qs, doseq=True)
        return target_path, query

    def proxy_to_comfy(self, parsed, method="GET"):
        target_path, query = self.comfy_target(parsed)
        body = self.read_body() if method not in ("GET", "HEAD") else None
        upstream_base = COMFY_HTTP_DEFAULT
        lane_name = "default"
        submit_route_meta = None
        if method == "POST" and target_path in {"/api/prompt", "/prompt"} and body:
            try:
                lane_name = comfy_lane_for_prompt_body(body, run_on=_run_on_from_comfy_prompt_body(body))
            except ComfyLanePinError as exc:
                # Operational, like a dead tunnel: names the machine, carries no
                # prompt content, and so survives machine-private redaction.
                return self.send_json({"error": str(exc), "operational": True}, 409)
            upstream_base = COMFY_LANES.get(lane_name, COMFY_HTTP_DEFAULT)
        if method in ("GET", "HEAD"):
            history_match = re.match(r"^/(?:api/)?history/([^/?]+)$", target_path)
            if history_match:
                pid = unquote(history_match.group(1))
                route = comfy_prompt_route(pid)
                if route:
                    # Scope status to the requester that owns this prompt.
                    if not requester_may_read_prompt(route, self.headers.get(REQUESTER_PUB_HEADER)):
                        return self.send_json({}, 404)
                    if route.get("remote"):
                        # Remote prompts are answered from the gateway's route
                        # record in every phase: the lane's live history must
                        # not stream through this proxy, and after harvest the
                        # lane entry is scrubbed anyway.
                        return self.send_json(synthetic_comfy_history_for_route(pid, route))
                    lane_name = route.get("lane") or "default"
                    upstream_base = COMFY_LANES.get(lane_name, COMFY_HTTP_DEFAULT)
        url = upstream_base + target_path + (("?" + query) if query else "")
        if method == "POST" and target_path in {"/api/prompt", "/prompt"} and body:
            record_mobile_prompt_lora_trace(body)
            native_ltx = detect_native_mlx_ltx_prompt(body)
            if native_ltx:
                try:
                    studio_lane = _studio_lane_from_comfy_prompt_body(body)
                    if studio_lane:
                        native_ltx['options'] = {
                            **dict(native_ltx.get('options') or {}),
                            'studio_lane': studio_lane,
                        }
                    workflow = _mobile_prompt_workflow_from_body(body)
                    job_id = queue_native_mlx_ltx_job(native_ltx, workflow)
                    return self.send_json({
                        "prompt_id": job_id,
                        "number": 0,
                        "node_errors": {},
                        "native_mlx": True,
                        "native_video": True,
                        "backend": _ltx_mlx_backend_name(LTX2_MLX_VARIANTS.get(native_ltx.get('variant')) or {}, native_ltx.get('variant')),
                        "status": "queued",
                    }, 200)
                except Exception as e:
                    return self.send_json({"error": f"native LTX route failed before Comfy fallback: {e}"}, 500)
            native = detect_native_mlx_biglove_prompt(body)
            if native:
                try:
                    studio_lane = _studio_lane_from_comfy_prompt_body(body)
                    if studio_lane:
                        native['options'] = {
                            **dict(native.get('options') or {}),
                            'studio_lane': studio_lane,
                        }
                    workflow = _mobile_prompt_workflow_from_body(body)
                    job_id = queue_native_mlx_biglove_job(native['prompt'], native['image_path'], native.get('options') or {}, workflow)
                    return self.send_json({
                        "prompt_id": job_id,
                        "number": 0,
                        "node_errors": {},
                        "native_mlx": True,
                        "backend": "mlx-mxfp8-bigloves-klein3-edit",
                        "status": "queued",
                    }, 200)
                except Exception as e:
                    return self.send_json({"error": f"native BigLove route failed before Comfy fallback: {e}"}, 500)
            body = exact_comfy_biglove_prompt_body(body)
            body = exact_comfy_krea2_turbo_pre_lora_prompt_body(body)
            requester_spki = normalized_requester_spki(self.headers.get(REQUESTER_PUB_HEADER))
            pushed_inputs = []
            if comfy_lane_is_remote(lane_name):
                transport_error = comfy_lane_transport_error(lane_name)
                if transport_error:
                    return self.send_json({"error": transport_error, "operational": True}, 502)
                if not (requester_spki or vault_public_key_spki()):
                    return self.send_json({
                        "error": "remote lane requires a sealing key: present "
                                 f"{REQUESTER_PUB_HEADER} with the job or create the owner vault",
                    }, 409)
                # Only once the lane is both permitted AND sealable: ask whether
                # it is still there, before staging anything on it. Staging into
                # a dead tunnel hangs for minutes and then surfaces as an
                # unexplained timeout. This costs one round trip and names the
                # real problem while it is still actionable. It stays BELOW the
                # sealing-key refusal so a lane we may not use is never touched.
                liveness_error = comfy_lane_liveness_error(lane_name)
                if liveness_error:
                    return self.send_json({"error": liveness_error, "operational": True}, 502)
                try:
                    pushed_inputs = push_prompt_inputs_to_lane(body, lane_name)
                except Exception as e:
                    # Also operational: a staging failure is the transport
                    # giving out mid-upload, which the liveness probe above
                    # cannot predict — a small GET succeeds on a path that
                    # still cannot carry a multi-megabyte reference.
                    return self.send_json({
                        "error": f"could not stage inputs on remote lane '{lane_name}': {e}",
                        "operational": True,
                    }, 502)
            # What the MCP priced this graph at, and the card it is about to run
            # on: the pair that turns an OOM (or a clean finish) into a fact
            # about this card size rather than an anecdote.
            priced_rows = _packed_rows_from_comfy_prompt_body(body)
            card_vram_gb = None
            if priced_rows:
                try:
                    card_vram_gb = _comfy_lane_system_probe(lane_name)[1]
                except Exception:
                    card_vram_gb = None
            submit_route_meta = {
                "lane": lane_name,
                "requester_spki": requester_spki,
                "pushed_inputs": pushed_inputs,
                "packed_rows": priced_rows,
                "card_vram_gb": card_vram_gb,
                # Staging a reference job's inputs (above) runs inside this
                # request and can outlast the caller's timeout. Keeping the
                # submitter's own client_id is what lets it find the job again
                # instead of leaving it queued with nobody holding its id.
                "client_id": _prompt_body_client_id(body),
            }
        # ComfyUI's aiohttp server rejects cross-origin-looking browser requests
        # (403) when forwarded with the wrapper's Origin/Referer. Strip browser
        # origin metadata so this remains a same-machine server-to-server proxy.
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "content-length", "authorization", "x-token", "connection", "origin", "referer", REQUESTER_PUB_HEADER.lower()}}
        lane_auth = comfy_lane_token(lane_name)
        if lane_auth:
            headers["Authorization"] = f"Bearer {lane_auth}"
        try:
            req = Request(url, data=body, method=method, headers=headers)
            with urlopen(req, timeout=60) as r:
                data = r.read()
                if submit_route_meta is not None and r.status < 400:
                    try:
                        submitted_pid = str(json.loads(data.decode("utf-8")).get("prompt_id") or "")
                    except Exception:
                        submitted_pid = ""
                    if submitted_pid:
                        record_comfy_prompt_route(
                            submitted_pid, submit_route_meta["lane"],
                            requester_spki=submit_route_meta["requester_spki"],
                            pushed_inputs=submit_route_meta["pushed_inputs"],
                            client_id=submit_route_meta["client_id"],
                        )
                        if submit_route_meta.get("packed_rows"):
                            update_comfy_prompt_route(
                                submitted_pid,
                                packed_rows=submit_route_meta["packed_rows"],
                                card_vram_gb=submit_route_meta["card_vram_gb"],
                            )
                        if comfy_lane_is_remote(submit_route_meta["lane"]):
                            threading.Thread(target=watch_remote_comfy_prompt, args=(submitted_pid,), daemon=True).start()
                ctype = r.headers.get("Content-Type", mimetypes.guess_type(target_path)[0] or "application/octet-stream")
                if ("text/html" in ctype or "javascript" in ctype) and data:
                    text = data.decode("utf-8", errors="replace")
                    text = text.replace('"/api/', '"/comfy/api/').replace("'/api/", "'/comfy/api/").replace('`/api/', '`/comfy/api/')
                    text = text.replace('"/system_stats', '"/comfy/system_stats').replace("'/system_stats", "'/comfy/system_stats").replace('`/system_stats', '`/comfy/system_stats')
                    text = text.replace('"/view?', '"/comfy/view?').replace("'/view?", "'/comfy/view?").replace('`/view?', '`/comfy/view?')
                    text = text.replace('"/upload/', '"/comfy/upload/').replace("'/upload/", "'/comfy/upload/").replace('`/upload/', '`/comfy/upload/')
                    # Vite's production HTML adds bare `crossorigin` to module/CSS
                    # assets. In Chromium that makes requests omit credentials, so
                    # token-cookie auth is not sent and the module quietly fails,
                    # leaving the iframe as a blank black rectangle.
                    if "text/html" in ctype:
                        text = text.replace(" crossorigin", "")
                    data = text.encode("utf-8")
                self.send_response(r.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.maybe_auth_cookie()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers(); self.wfile.write(data)
        except Exception as e:
            self.send_text(f"Comfy proxy error: {e}\n", 502, "text/plain")

    def proxy_websocket_to_comfy(self, parsed):
        target_path, query = self.comfy_target(parsed)
        # Progress websockets can follow a prompt to its lane: ?lane=<name>
        # (stripped before forwarding). Unknown lanes fall back to default.
        ws_qs = parse_qs(query, keep_blank_values=True)
        lane_values = ws_qs.pop("lane", [])
        lane_name = (lane_values[0].strip().lower() if lane_values else "") or "default"
        if lane_name not in COMFY_LANES:
            lane_name = "default"
        query = urlencode(ws_qs, doseq=True)
        upstream = urlparse(COMFY_LANES.get(lane_name, COMFY_HTTP_DEFAULT))
        host = upstream.hostname or "127.0.0.1"
        port = upstream.port or (443 if upstream.scheme == "https" else 80)
        if upstream.scheme == "https":
            # Graceful degrade: no live progress tunnel for TLS lanes - the
            # client's history polling still observes completion.
            return self.send_text("WebSocket proxy supports http lanes only; poll history for progress on this lane\n", 502, "text/plain")
        path = target_path + (("?" + query) if query else "")
        try:
            sock = socket.create_connection((host, port), timeout=10)
            lines = [f"GET {path} HTTP/1.1", f"Host: {host}:{port}"]
            lane_auth = comfy_lane_token(lane_name)
            if lane_auth:
                lines.append(f"Authorization: Bearer {lane_auth}")
            skip = {"host", "origin", "referer", "authorization", "x-token", "cookie", "connection"}
            for k, v in self.headers.items():
                kl = k.lower()
                if kl in skip:
                    continue
                lines.append(f"{k}: {v}")
            lines.extend(["Connection: Upgrade", "", ""])
            sock.sendall("\r\n".join(lines).encode("utf-8"))

            # Relay the upstream handshake, then tunnel WebSocket frames both ways.
            self.close_connection = True
            handshake = b""
            while b"\r\n\r\n" not in handshake:
                data = sock.recv(4096)
                if not data:
                    sock.close(); return
                self.connection.sendall(data)
                handshake += data
            # Two blocking pump threads. The previous non-blocking select loop called
            # sendall() on non-blocking sockets: whenever the tailnet client couldn't
            # drain Comfy's binary latent-preview frames fast enough, sendall raised
            # BlockingIOError mid-frame (or wrote a partial frame, desyncing the
            # WebSocket stream) and the tunnel died mid-generation - clients then
            # missed the 'executed' event and image delivery fell back to slow
            # history polling. Blocking sockets make sendall apply backpressure
            # instead of dying. Timeouts are cleared so an idle-but-healthy tunnel
            # does not inherit create_connection's 10s recv timeout.
            self.connection.setblocking(True)
            self.connection.settimeout(None)
            sock.setblocking(True)
            sock.settimeout(None)

            def pump(src, dst):
                try:
                    while True:
                        chunk = src.recv(65536)
                        if not chunk:
                            break
                        dst.sendall(chunk)
                except Exception:
                    pass
                finally:
                    for s in (src, dst):
                        try:
                            s.shutdown(socket.SHUT_RDWR)
                        except Exception:
                            pass

            downstream = threading.Thread(target=pump, args=(self.connection, sock), daemon=True)
            downstream.start()
            pump(sock, self.connection)
            downstream.join(timeout=5)
            sock.close()
            return
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            return self.send_text(f"Comfy WebSocket proxy error: {e}\n", 502, "text/plain")

    def find_job(self, jid):
        with jobs_lock:
            rec = jobs.get(jid)
        if rec:
            return rec
        for r in load_history(500):
            if r.get("id") == jid:
                return r
        return None

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path in ["/healthz", "/health"]:
            return self.send_json({
                "ok": True,
                "comfy": str(COMFY),
                "runner": RUNNER.exists(),
                "ui": "v2",
                "accelerator_profile": accelerator_profile(),
                "native_mlx_ltx": supports_native_mlx_ltx_route(),
            })
        if not self.authed(qs):
            return self.send_text("Unauthorized. Add ?token=... or Authorization: Bearer ***", 401, "text/plain")
        # One stat() per request; picks up an attach/detach without a restart.
        refresh_comfy_lanes()
        if parsed.path == "/workflow-key":
            # Deprecated: old builds exposed a backend-derived workflow metadata
            # key. ComfyUI Mobile now uses a user-only browser unlock key kept
            # only in loaded-tab memory, so the backend must not return a
            # decrypt key.
            return self.send_json({"error": "workflow key endpoint disabled; unlock in the browser"}, status=410)
        if parsed.path == "/api/e2e/vault-identity":
            identity = vault_identity_json()
            return self.send_json({"ok": True, "exists": identity is not None, "identity": identity})
        if parsed.path == "/workflow-for-output":
            name = safe_name(qs.get('filename', [''])[0])
            envelope = workflow_envelope_for_filename(name) if name else None
            if envelope:
                return self.send_json({"workflow": envelope})
            return self.send_json({"error": "no workflow recorded for this output"}, 404)
        if parsed.path == "/ws":
            return self.proxy_websocket_to_comfy(parsed)
        if parsed.path in ["/", "/history", "/models", "/workbench"] or parsed.path.startswith("/_next/") or parsed.path in ["/favicon.ico"]:
            return self.proxy_to_frontend(parsed)
        if parsed.path == "/api/models":
            models = scan_models()
            return self.send_json({"models": models, "bundles": model_bundles(models), "equipped": load_equipped(), "ram": ram_info(), "civitaiInstalled": scan_civitai_downloads()})
        if parsed.path == "/api/library":
            return self.send_json(scan_library())
        if parsed.path == "/api/model-preview":
            target = qs.get('path', [''])[0]
            p = Path(target).resolve()
            allowed = [COMFY.resolve(), BASE.resolve(), OUT_DIR.resolve()]
            if not any(str(p).startswith(str(a)) for a in allowed) or not p.exists() or not p.is_file():
                return self.send_text("not found\n", 404, "text/plain")
            ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
            data = p.read_bytes()
            self.send_response(200); self.cors_headers(); self.send_header("Content-Type", ctype); self.send_header("Cache-Control", "public, max-age=86400"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        if parsed.path == "/api/loras/preview":
            lora_id = qs.get('id', [''])[0]
            item = next((value for value in local_loras_unfiltered() if value.get('id') == lora_id), None)
            if not item:
                return self.send_text("not found\n", 404, "text/plain")
            source = lora_preview_source(item['path'], item.get('metadata') or {})
            if not source:
                return self.send_text("not found\n", 404, "text/plain")
            try:
                if source.startswith(('http://', 'https://')):
                    # Civitai-hosted card art: fetched once, then served from the
                    # encrypted cache until this LoRA file changes or goes away.
                    cached = cached_lora_preview(item, source)
                    if cached:
                        data, ctype = cached
                    else:
                        preview_request = Request(source, headers={'User-Agent': 'HivemindContentStudio/1.0'})
                        with urlopen(preview_request, timeout=30) as upstream:
                            data = upstream.read()
                            ctype = upstream.headers.get('Content-Type', 'image/jpeg').split(';', 1)[0]
                        cache_lora_preview(item, source, data, ctype)
                else:
                    preview_path = Path(source).resolve()
                    lora_root = (COMFY / 'models' / 'loras').resolve()
                    if not preview_path.exists() or not preview_path.is_file() or not _is_under(preview_path, lora_root):
                        return self.send_text("not found\n", 404, "text/plain")
                    data = preview_path.read_bytes()
                    ctype = mimetypes.guess_type(str(preview_path))[0] or 'application/octet-stream'
                self.send_response(200)
                self.cors_headers()
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "private, max-age=3600")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception:
                return self.send_text("not found\n", 404, "text/plain")
        if parsed.path == "/api/loras":
            requested_bases = []
            for raw in qs.get('baseModels', []):
                requested_bases.extend(value.strip() for value in raw.split(',') if value.strip())
            if qs.get('compact', [''])[0].lower() in {'1', 'true', 'yes'}:
                base_models = requested_bases or current_base_models()
                return self.send_json({"baseModels": base_models, "loras": local_lora_catalog(base_models)})
            return self.send_json({"baseModels": current_base_models(), "loras": local_loras(), "selected": load_selected_loras()})
        if parsed.path == "/api/civitai/lora-updates":
            requested_bases = []
            for raw in qs.get('baseModels', []):
                requested_bases.extend(value.strip() for value in raw.split(',') if value.strip())
            force = qs.get('refresh', [''])[0] in {'1', 'true', 'yes'}
            try:
                updates = civitai_lora_updates(requested_bases or current_base_models(), force=force)
                return self.send_json({"updates": updates})
            except Exception as e:
                return self.send_json({"error": str(e)}, 502)
        if parsed.path == "/api/civitai/base-models":
            force = qs.get('refresh', [''])[0] in {'1', 'true', 'yes'}
            return self.send_json({"baseModels": civitai_base_model_options(force=force), "currentBaseModels": current_base_models()})
        if parsed.path == "/api/civitai/search":
            params = {k: qs.get(k, [None])[0] for k in ['query','tag','username','sort','period','supportsGeneration','fromPlatform','earlyAccess','primaryFileOnly','cursor','page','limit']}
            nsfw = qs.get('nsfw', [None])[0]
            if nsfw in {'true', 'false'}:
                params['nsfw'] = nsfw
            checkpoint_type = qs.get('checkpointType', [None])[0]
            if checkpoint_type in {'Trained', 'Merge'}:
                params['checkpointType'] = checkpoint_type
            for multi in ['types','baseModels']:
                vals = qs.get(multi, [])
                if vals:
                    params[multi] = ','.join(vals)
            if not params.get('limit'):
                params['limit'] = '24'
            try:
                data = civitai_search_models(params)
                return self.send_json({"items": [summarize_civitai_item(i) for i in data.get('items', [])], "metadata": data.get('metadata', {}), "baseModels": current_base_models(), "baseModelOptions": civitai_base_model_options(), "installed": scan_civitai_downloads()})
            except Exception as e:
                return self.send_json({"error": str(e)}, 502)
        if parsed.path.startswith("/api/civitai/download/"):
            jid = parsed.path.rsplit("/", 1)[-1]
            with download_jobs_lock:
                rec = download_jobs.get(jid)
            return self.send_json(public_download_job(rec) if rec else {"error": "not found"}, 200 if rec else 404)
        if parsed.path.startswith("/api/comfy/prompt-by-client/"):
            # Hand a submitter back the prompt id it never received. Staging a
            # reference job's inputs on a remote lane happens inside the submit
            # request, so a caller can time out while the job goes on to queue,
            # run and be harvested with nobody holding its id. Scoped the same
            # way history is: the requester key that submitted it may read it.
            client_id = unquote(parsed.path.rsplit("/", 1)[-1])
            prompt_id, route = comfy_prompt_id_for_client(client_id)
            if not prompt_id:
                return self.send_json({"error": "no prompt recorded for this client id"}, 404)
            if not requester_may_read_prompt(route, self.headers.get(REQUESTER_PUB_HEADER)):
                return self.send_json({"error": "not found"}, 404)
            return self.send_json({
                "prompt_id": prompt_id,
                "lane": route.get("lane"),
                "remote": bool(route.get("remote")),
                "status": route.get("status"),
                "created_at": route.get("created_at"),
            })
        if parsed.path in ["/comfy/view", "/view"]:
            name = safe_name(qs.get('filename', [''])[0])
            p = find_output_logical_path(name)
            if p:
                try:
                    send_output_file(self, p)
                    return
                except Exception as e:
                    print(f"[output-encryption] failed to serve {name}: {e}", file=sys.stderr)
                    return self.send_text("not found\n", 404, "text/plain")
            # If this is not one of our native/private outputs, let ComfyUI answer normally.
        if parsed.path == "/output":
            p = find_exact_output_logical_path(qs.get('path', [''])[0])
            if not p:
                return self.send_text("not found\n", 404, "text/plain")
            try:
                send_output_file(self, p)
            except Exception as e:
                print(f"[output-encryption] failed to serve exact output: {e}", file=sys.stderr)
                return self.send_text("not found\n", 404, "text/plain")
            return
        if parsed.path in ["/mobile", "/mobile/"] or parsed.path.startswith(("/mobile/", "/assets/", "/comfy/")):
            return self.proxy_to_comfy(parsed, "GET")
        if parsed.path == "/api/history":
            return self.send_json({"history": [public_record(r) for r in all_records(200)]})
        if parsed.path.startswith("/api/job/"):
            jid = parsed.path.rsplit("/", 1)[-1]
            rec = self.find_job(jid)
            if rec:
                return self.send_json(public_record(rec), 200)
            # A prompt routed to a remote lane has no local wrapper job, so this
            # used to 404 for its whole life - which is exactly how a finished
            # remote generation left the studio spinning: the trusted
            # server-side channel had no record to report completion (or
            # progress) from. Serve the route record in job shape instead.
            routed = remote_comfy_job_record(jid)
            return self.send_json(routed or {"error": "not found"}, 200 if routed else 404)
        if parsed.path.startswith("/job/"):
            jid = parsed.path.rsplit("/", 1)[-1]
            rec = self.find_job(jid)
            if not rec:
                return self.send_text("job not found\n", 404, "text/plain")
            return self.send_text(render_job_page(rec))
        if parsed.path.startswith("/image/"):
            name = safe_name(parsed.path.rsplit("/", 1)[-1])
            p = find_output_logical_path(name)
            if not p:
                return self.send_text("not found\n", 404, "text/plain")
            try:
                send_output_file(self, p)
            except Exception as e:
                print(f"[output-encryption] failed to serve {name}: {e}", file=sys.stderr)
                return self.send_text("not found\n", 404, "text/plain")
            return
        return self.send_text("not found\n", 404, "text/plain")

    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if not self.authed(qs):
            return self.send_json({"error": "unauthorized"}, 401)
        # One stat() per request; picks up an attach/detach without a restart.
        refresh_comfy_lanes()
        if parsed.path.startswith("/api/job/") and parsed.path.endswith("/cancel"):
            jid = parsed.path[len("/api/job/"):-len("/cancel")].strip("/")
            return self.send_json(cancel_generation_job(jid))
        if parsed.path.startswith("/api/cancel/"):
            return self.send_json(cancel_generation_job(parsed.path.rsplit("/", 1)[-1]))
        if parsed.path == "/api/delete-output":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                if data.get("confirm") is not True:
                    return self.send_json({"error": "permanent deletion requires confirm=true"}, 400)
                result = delete_output_everywhere(str(data.get("filename") or ""))
                return self.send_json(result)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except RuntimeError as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path == "/api/lanes/resolve":
            # Which lane a graph would route to, and what that lane's ComfyUI
            # was launched with. The MCP's motion-reference guard asks this
            # before pricing a reference job: its budget was measured with
            # --vram-headroom, and a lane without the flag is held to the
            # registry's smaller ceiling (comfy_lane_vram_headroom). Answered
            # here, not in the MCP, because only the gateway knows the lanes —
            # the same first-match rules that will route the submission.
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, 400)
            graph = data.get("graph") if isinstance(data, dict) else None
            if not isinstance(graph, dict):
                return self.send_json({"error": "graph (a ComfyUI API prompt graph) is required"}, 400)
            try:
                lane = comfy_lane_for_prompt_body(
                    json.dumps({"prompt": graph}).encode("utf-8"), run_on=data.get("run_on"),
                )
            except ComfyLanePinError as exc:
                return self.send_json({"error": str(exc), "operational": True}, 409)
            return self.send_json({"ok": True, **comfy_lane_vram_headroom(lane)})
        if parsed.path == "/api/delete-input":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                return self.send_json({"ok": True, "deleted": delete_private_input(data.get("filename"))})
            except (json.JSONDecodeError, ValueError) as exc:
                return self.send_json({"error": str(exc)}, 400)
        if parsed.path == "/api/interpolate":
            try:
                data = json.loads((self.read_body(max_bytes=INTERPOLATE_MAX_BODY_BYTES) or b"{}").decode("utf-8"))
                staged = stage_inline_video_base64(data.get("video_base64"))
                if staged is None:
                    return self.send_json({"error": "video_base64 is required"}, 400)
                factor = 4 if str(data.get("factor")) == "4" else 2
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "rife-interpolation", "mode": f"{factor}x", "options": {"factor": factor}}
                t = threading.Thread(target=run_video_interpolation, args=(job_id, staged, {"factor": factor}), daemon=True)
                t.start()
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "rife-interpolation",
                    "mode": f"{factor}x",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path == "/api/smart-mask":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                staged = stage_inline_image_base64(data.get("image_base64"))
                if staged is None:
                    return self.send_json({"error": "image_base64 is required"}, 400)
                options = {
                    "prompt": str(data.get("prompt") or "")[:400],
                    "points": data.get("points"),
                    "confidence": data.get("confidence"),
                }
                if not options["prompt"].strip() and not options["points"]:
                    return self.send_json({"error": "describe an object or tap the image"}, 400)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "sam3-smart-mask"}
                threading.Thread(
                    target=run_sam3_smart_mask, args=(job_id, staged, options), daemon=True,
                ).start()
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "sam3-smart-mask",
                    "job_url": f"/api/job/{job_id}",
                }, 202)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path == "/api/ltx-director":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                project = data.get("project")
                if not isinstance(project, dict):
                    return self.send_json({"error": "project is required"}, 400)
                options = {
                    "width": data.get("width"),
                    "height": data.get("height"),
                    "seed": data.get("seed"),
                    "loras": data.get("loras"),
                }
                options = {k: v for k, v in options.items() if v is not None}
                # Validate before queueing so a malformed timeline answers the
                # caller directly instead of failing inside a background job.
                build_ltx_director_prompt(project, options)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "ltx-director"}
                threading.Thread(
                    target=run_ltx_director, args=(job_id, project, options), daemon=True,
                ).start()
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "ltx-director",
                    "job_url": f"/api/job/{job_id}",
                }, 202)
            except DirectorProjectError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path == "/api/episode":
            try:
                data = json.loads((self.read_body(max_bytes=INTERPOLATE_MAX_BODY_BYTES) or b"{}").decode("utf-8"))
                staged = stage_inline_video_base64(data.get("video_base64"))
                if staged is None:
                    return self.send_json({"error": "video_base64 is required"}, 400)
                shots = int_option(data, "shots", 0, 0, 512)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "episode-join", "options": {"shots": shots}}
                threading.Thread(
                    target=run_episode_save, args=(job_id, staged, {"shots": shots}), daemon=True,
                ).start()
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "episode-join",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path == "/api/upscale":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                staged = stage_inline_image_base64(data.get("image_base64"))
                if staged is None:
                    return self.send_json({"error": "image_base64 is required"}, 400)
                options = {
                    "mode": data.get("mode"),
                    "scale": data.get("scale"),
                    "prompt": data.get("prompt"),
                    "negative_prompt": data.get("negative_prompt"),
                    "refine_steps": data.get("refine_steps"),
                    "refine_denoise": data.get("refine_denoise"),
                    "seed": data.get("seed"),
                    "run_on": data.get("run_on"),
                }
                # A stale "Run on" pin is refused here, before a job exists to
                # fail, so the studio hears the reason instead of a dead job.
                try:
                    comfy_lane_for_pin(options.get("run_on"))
                except ComfyLanePinError as exc:
                    return self.send_json({"error": str(exc), "operational": True}, 409)
                job_id = uuid.uuid4().hex[:12]
                mode = "max" if str(data.get("mode") or "fast").lower() == "max" else "fast"
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "comfy-upscale", "mode": mode, "options": {"mode": mode}}
                t = threading.Thread(target=run_comfy_upscale, args=(job_id, staged, options), daemon=True)
                t.start()
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "comfy-upscale",
                    "mode": mode,
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, 400)
            except Exception as exc:
                return self.send_json({"error": str(exc)}, 500)
        if parsed.path in ["/api/models/equip", "/api/models/unequip"]:
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                mid = str(data.get("id", ""))
                if parsed.path.endswith("/equip"):
                    ok, msg = equip_model(mid)
                    return self.send_json({"ok": ok, "message": msg, "equipped": load_equipped(), "selected": load_selected_loras(), "ram": ram_info()}, 200 if ok else 409)
                changed = unequip_model(mid)
                return self.send_json({"ok": True, "changed": changed, "equipped": load_equipped(), "selected": load_selected_loras(), "ram": ram_info()})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        if parsed.path == "/api/loras/select":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                selected = save_selected_loras(data.get('loras', []))
                return self.send_json({"ok": True, "selected": selected, "loras": local_loras()})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        if parsed.path == "/api/civitai/download":
            try:
                data = json.loads((self.read_body() or b"{}").decode("utf-8"))
                civitai_key = data.get('civitai_key') or data.get('civitai_token') or data.get('civitaiToken') or data.get('civitaiApiKey')
                if data.get('url'):
                    resolved = resolve_civitai_url(data.get('url'))
                    validate_civitai_expected_type(resolved.get('version') or {}, data.get('expectedType'))
                    job = start_civitai_download_job(
                        resolved.get('versionId'),
                        data.get('fileId') or resolved.get('fileId'),
                        token_override=civitai_key,
                        name=civitai_version_display_name(resolved.get('version') or {}),
                        replace_id=data.get('replaceId') or data.get('replace_id'),
                    )
                    job['resolved'] = {'versionId': resolved.get('versionId'), 'fileId': data.get('fileId') or resolved.get('fileId')}
                    return self.send_json(job, 202)
                job = start_civitai_download_job(data.get('versionId') or data.get('modelVersionId'), data.get('fileId'), token_override=civitai_key)
                return self.send_json(job, 202)
            except Exception as e:
                return self.send_json({"error": str(e)}, 502)
        if parsed.path.startswith("/api/civitai/cancel-download/"):
            jid = parsed.path.rsplit("/", 1)[-1]
            rec = cancel_civitai_download_job(jid)
            return self.send_json(public_download_job(rec) if rec else {"error": "not found"}, 200 if rec else 404)
        if parsed.path.startswith("/comfy/") or parsed.path.startswith("/mobile/"):
            return self.proxy_to_comfy(parsed, "POST")
        if parsed.path not in ["/generate", "/api/generate"]:
            return self.send_json({"error": "not found"}, 404)
        try:
            ctype = self.headers.get("Content-Type", "")
            data = {}
            uploaded_image = None
            if "multipart/form-data" in ctype:
                try:
                    content_length = int(self.headers.get('Content-Length') or 0)
                except (TypeError, ValueError):
                    content_length = 0
                form = MultipartForm(self.rfile.read(content_length) if content_length > 0 else b'', ctype)
                prompt = str(form.getfirst("prompt", "")).strip()
                for key in ['backend', 'width', 'height', 'steps', 'cfg', 'guidance', 'seed', 'mlx_cache_limit_gb', 'ref_boost', 'identity_strength', 'grounding_px', 'studio_lane', 'run_on']:
                    if key in form:
                        data[key] = form.getfirst(key)
                image_item = form['image'] if 'image' in form else None
                if image_item is not None and getattr(image_item, 'file', None) and getattr(image_item, 'filename', ''):
                    ext = Path(image_item.filename).suffix.lower()
                    if ext not in {'.png', '.jpg', '.jpeg', '.webp'}:
                        ext = '.png'
                    upload_dir = OUT_DIR / 'mlx-inputs'
                    upload_dir.mkdir(parents=True, exist_ok=True)
                    uploaded_image = upload_dir / f"{uuid.uuid4().hex[:12]}{ext}"
                    with uploaded_image.open('wb') as f:
                        while True:
                            chunk = image_item.file.read(1024 * 1024)
                            if not chunk:
                                break
                            f.write(chunk)
            else:
                body = self.read_body()
                if "application/json" in ctype:
                    data = json.loads(body.decode("utf-8") or "{}")
                    prompt = str(data.get("prompt", "")).strip()
                    uploaded_image = stage_inline_image_base64(data.get("image_base64"))
                else:
                    data = parse_qs(body.decode("utf-8"))
                    prompt = str(data.get("prompt", [""])[0]).strip()
            wants_character_sheet = isinstance(data, dict) and isinstance(data.get('character_sheet'), dict)
            if not prompt and not wants_character_sheet:
                # A character sheet works from the reference alone — its view
                # prompts are built server-side; the user prompt is optional.
                return self.send_json({"error": "prompt required"}, 400)
            options = {}
            if isinstance(data, dict):
                for key in ['width', 'height', 'steps', 'cfg', 'cfgScale', 'guidance', 'seed', 'sampler_name', 'scheduler', 'negative_prompt', 'mlx_cache_limit_gb', 'ref_boost', 'identity_strength', 'grounding_px', 'couple_mode', 'couple_shared', 'couple_split', 'couple_direction', 'couple_pair', 'studio_lane', 'run_on']:
                    if key in data:
                        options[key] = data.get(key)
                _normalize_couple_options(options)
                # The studio's per-tab "Run on" pin. Refused up front when it
                # names a machine that is no longer attached: a queued job that
                # fails seconds later would reach the tab as a bare failure.
                try:
                    comfy_lane_for_pin(options.get('run_on'))
                except ComfyLanePinError as exc:
                    return self.send_json({"error": str(exc), "operational": True}, 409)
            backend = str(data.get('backend', '') if isinstance(data, dict) else '')
            if wants_character_sheet:
                # The Klein edit branch is the only lane that honors
                # character_sheet; it is reached by naming a Klein backend
                # (image_path/image_paths references are collected there) or by
                # sending an inline image with no other backend claim. Fail
                # loudly instead of letting the request fall through to a lane
                # that would silently ignore the key.
                klein_reachable = (
                    backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'}
                    or (uploaded_image is not None and backend != 'comfy-api-image' and backend not in KREA2_IDENTITY_BACKENDS)
                )
                if not klein_reachable:
                    return self.send_json({"error": "character sheet runs on the Klein edit backend and requires a reference image (image_base64 or image_path)"}, 400)
            if backend == 'comfy-api-image':
                options['workflow_file'] = str(data.get('workflow_file', '') if isinstance(data, dict) else '')
                if isinstance(data, dict) and isinstance(data.get('loras'), list):
                    options['loras'] = data.get('loras')
                if isinstance(data, dict):
                    # H3 Studio graphs size from aspect_ratio + megapixels (or
                    # the studio's Resolution tier) and pick their own sampler
                    # from a profile, so none of these reach the request
                    # through the shared width/height/steps keys above.
                    for key in ('aspect_ratio', 'base_size', 'megapixels', 'sampling_profile',
                                'frame_profile', 'route', 'adherence'):
                        if key in data:
                            options[key] = data.get(key)
                    try:
                        options['reference_image_paths'] = [
                            str(path) for path in collect_reference_image_paths(data, uploaded_image)
                        ]
                    except ValueError as exc:
                        return self.send_json({"error": str(exc)}, 400)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {
                        "id": job_id,
                        "prompt": PRIVATE_PROMPT_LABEL,
                        "status": "queued",
                        "created_at": now_iso(),
                        "backend": "comfy-api-image",
                        "options": {k: v for k, v in options.items() if k not in ('negative_prompt', 'workflow_file', 'loras')},
                    }
                start_studio_generation_thread(
                    'image', options, run_comfy_api_image, (job_id, prompt, options))
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "comfy-api-image",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            if backend in KREA2_IDENTITY_BACKENDS:
                if isinstance(data, dict) and data.get('loras') is not None:
                    krea_loras = resolve_lora_selection(data.get('loras') or [], ['Krea 2'])
                    options['loras'] = [
                        {'id': item['id'], 'strength': item['strength']}
                        for item in krea_loras
                    ]
                if uploaded_image is None:
                    maybe_image = str(data.get('image_path', '') if isinstance(data, dict) else '')
                    if maybe_image:
                        uploaded_image = Path(maybe_image).expanduser()
                        if not uploaded_image.is_absolute():
                            uploaded_image = COMFY_INPUT_DIR / maybe_image
                # Masked edit (soft inpaint): a white-on-black mask PNG rides
                # along as mask_base64; only the painted area (plus a small
                # grown collar) changes, the rest is composited back untouched.
                inpaint_req = data.get('inpaint') if isinstance(data, dict) else None
                if isinstance(inpaint_req, dict) and inpaint_req.get('mask_base64'):
                    if uploaded_image is None:
                        return self.send_json({"error": "inpaint requires a source image"}, 400)
                    try:
                        mask_path = stage_inline_image_base64(inpaint_req.get('mask_base64'))
                    except ValueError as exc:
                        return self.send_json({"error": f"inpaint mask: {exc}"}, 400)
                    for key in ('mask_expand', 'mask_influence'):
                        if inpaint_req.get(key) is not None:
                            options[key] = inpaint_req.get(key)
                    job_id = uuid.uuid4().hex[:12]
                    with jobs_lock:
                        jobs[job_id] = {
                            "id": job_id,
                            "prompt": PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": now_iso(),
                            "backend": "comfy-krea2-inpaint",
                            "mode": "inpaint",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    start_studio_generation_thread(
                        'image', options, run_comfy_krea2_inpaint,
                        (job_id, prompt, uploaded_image, mask_path, options),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-inpaint",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                # Canvas expansion: pixel-preserving centered outpaint on the
                # same lane (Mix-Studio port; the LTX anchor pipeline's graph).
                outpaint_req = data.get('outpaint') if isinstance(data, dict) else None
                if isinstance(outpaint_req, dict) and outpaint_req.get('width') and outpaint_req.get('height'):
                    if uploaded_image is None:
                        return self.send_json({"error": "outpaint requires a source image"}, 400)
                    job_id = uuid.uuid4().hex[:12]
                    with jobs_lock:
                        jobs[job_id] = {
                            "id": job_id,
                            "prompt": PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": now_iso(),
                            "backend": "comfy-krea2-outpaint",
                            "mode": "outpaint",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    start_studio_generation_thread(
                        'image', options, run_comfy_krea2_outpaint,
                        (job_id, prompt, uploaded_image, options, outpaint_req),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-outpaint",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                # Strength Hunt: same lane, but sweeps 1-2 selected LoRA
                # strengths across a fixed prompt+seed and adds a labeled
                # comparison sheet (see strength_hunt.py).
                hunt = data.get('strength_hunt') if isinstance(data, dict) else None
                if isinstance(hunt, dict) and hunt.get('lora_ids'):
                    job_id = uuid.uuid4().hex[:12]
                    with jobs_lock:
                        jobs[job_id] = {
                            "id": job_id,
                            "prompt": PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": now_iso(),
                            "backend": "comfy-krea2-strength-hunt",
                            "mode": "identity-edit" if uploaded_image else "text-to-image",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    start_studio_generation_thread(
                        'image', options, run_comfy_krea2_strength_hunt,
                        (job_id, prompt, uploaded_image, options, hunt),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-strength-hunt",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {
                        "id": job_id,
                        "prompt": PRIVATE_PROMPT_LABEL,
                        "status": "queued",
                        "created_at": now_iso(),
                        "backend": "comfy-krea2-turbo-identity-edit",
                        "mode": "identity-edit" if uploaded_image else "text-to-image",
                        "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                    }
                start_studio_generation_thread(
                    'image', options, run_comfy_krea2_identity,
                    (job_id, prompt, uploaded_image, options),
                )
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "comfy-krea2-turbo-identity-edit",
                    "mode": "identity-edit" if uploaded_image else "text-to-image",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            if backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'} or uploaded_image is not None:
                native_loras = _native_loras_from_generation_request(data, ['Flux.2 Klein 9B'])
                if native_loras:
                    options['loras'] = native_loras
                # Klein conditions on up to BIGLOVE_KLEIN3_MAX_REFERENCES
                # images (identity across views, character sheets).
                reference_images = collect_reference_image_paths(data, uploaded_image)[:BIGLOVE_KLEIN3_MAX_REFERENCES]
                if not reference_images:
                    return self.send_json({"error": "image required for BigLoveKlein3 edit"}, 400)
                uploaded_image = reference_images[0]
                if len(reference_images) > 1:
                    options['image_paths'] = [str(p) for p in reference_images]
                # Character sheet: N per-view edits of the same reference(s) on
                # the native Klein lane, composited into one labeled sheet.
                if wants_character_sheet:
                    sheet_req = data.get('character_sheet')
                    try:
                        sheet_views = resolve_character_sheet_views(sheet_req)
                    except ValueError as exc:
                        return self.send_json({"error": str(exc)}, 400)
                    if not supports_native_mlx_biglove_route():
                        return self.send_json({"error": f"character sheet needs the native MLX Klein route (accelerator profile {accelerator_profile()})"}, 400)
                    sheet_preset = str(sheet_req.get('preset') or '').strip().lower() or None
                    job_id = queue_klein_character_sheet(prompt, reference_images, options, sheet_views, preset=sheet_preset)
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": KLEIN_CHARACTER_SHEET_BACKEND,
                        "mode": "character-sheet",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                if supports_native_mlx_biglove_route():
                    job_id = queue_native_mlx_biglove_job(prompt, uploaded_image, options)
                    return self.send_json({"id": job_id, "status": "queued", "backend": "mlx-mxfp8-bigloves-klein3-edit", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
                if backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'}:
                    return self.send_json({"error": f"native MLX BigLove route is not available for accelerator profile {accelerator_profile()}"}, 400)
                job_id = uuid.uuid4().hex[:12]
                with jobs_lock:
                    jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "backend": "comfy-bigloves-klein3-edit", "options": {k: v for k, v in options.items() if k != 'negative_prompt'}}
                start_studio_generation_thread(
                    'image', options, run_comfy_klein3_edit,
                    (job_id, prompt, uploaded_image, options),
                )
                return self.send_json({"id": job_id, "status": "queued", "backend": "comfy-bigloves-klein3-edit", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
            req_loras = data.get('loras') if isinstance(data, dict) else None
            loras = resolve_lora_selection(req_loras, current_base_models()) if req_loras is not None else load_selected_loras()
            job_id = uuid.uuid4().hex[:12]
            with jobs_lock:
                jobs[job_id] = {"id": job_id, "prompt": PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": now_iso(), "loras": loras, "options": {k: v for k, v in options.items() if k != 'negative_prompt'}}
            start_studio_generation_thread(
                'image', options, run_generation, (job_id, prompt, loras, options))
            if parsed.path == "/generate":
                return self.send_text(f"<meta http-equiv='refresh' content='0; url=/job/{job_id}?token={TOKEN}'>Queued job {job_id}. Opening live status page...", 202)
            return self.send_json({"id": job_id, "status": "queued", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
    def do_DELETE(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if not self.authed(qs):
            return self.send_json({"error": "unauthorized"}, 401)
        if parsed.path.startswith("/comfy/") or parsed.path.startswith("/mobile/"):
            return self.proxy_to_comfy(parsed, "DELETE")
        return self.send_json({"error": "not found"}, 404)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    if OUTPUT_ENCRYPTION_ENABLED:
        output_encryption_password(create=True)
        migrated = encrypt_existing_outputs_once(max_age_seconds=0)
        if migrated:
            print(f"[output-encryption] encrypted {migrated} existing output image(s)", flush=True)
        threading.Thread(target=output_encryption_sweeper, daemon=True).start()
    threading.Thread(target=workflow_index_sweeper, daemon=True).start()
    respawn_remote_comfy_watchers()
    cleanup_staged_private_inputs_once()
    threading.Thread(target=private_input_sweeper, daemon=True).start()
    with download_jobs_lock:
        download_jobs.update(load_download_jobs())
        # Jobs that were mid-flight during a backend restart cannot be resumed safely.
        # Mark them retryable instead of leaving the UI stuck forever.
        changed = False
        for rec in download_jobs.values():
            if rec.get('status') in {'queued', 'running'}:
                rec['status'] = 'error'
                rec['error'] = 'Backend restarted before this download finished. Retry the download.'
                rec['finished_at'] = rec.get('finished_at') or now_iso()
                changed = True
        if changed:
            save_download_jobs_unlocked()
    print(f"Media Studio endpoint listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
