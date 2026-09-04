"""Every environment knob, path and vendored-workflow import the gateway reads
at startup. Imported by every other module and importing none of them."""
import json
import os
import sys
import tempfile
from pathlib import Path

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
import video_restore
import cloud_restore


# The package lives one level down from the gateway's own directory, which
# is what every relative path below (and the sibling imports above) mean.
BASE = Path(__file__).resolve().parents[1]
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


def gateway_version():
    """The package version, for /health. A build with no readable package.json
    reports "0" rather than failing the health check over a missing file."""
    try:
        return str(json.loads((BASE / "package.json").read_text(encoding="utf-8")).get("version") or "0")
    except Exception:
        return "0"


GATEWAY_VERSION = gateway_version()


def _env_enabled(name, default='0'):
    return str(os.environ.get(name, default)).strip().lower() in {'1', 'true', 'yes', 'on'}
