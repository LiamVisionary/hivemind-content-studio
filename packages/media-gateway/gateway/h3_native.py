"""MiniMax H3 on Apple silicon, through antirez/h3.c. No ComfyUI in the path.

The CUDA H3 lanes in the registry run a ComfyUI graph on a rented Blackwell
card, because H3's released text encoder is nvfp4 and only that card can read
it. h3.c is the other half of the same model: a Metal engine that reads the
ORIGINAL BF16 Hugging Face checkpoint and runs the whole thing — Qwen3-VL text
encoder, 50-block DiT, video VAE and audio VAE — on the Mac's own GPU. Same
model, same 17k+5 frame lattice, same joint audio-video output; a completely
different set of dials, which is why this lane is its own registry row rather
than a flag on the CUDA one.

Three things about this engine shape everything below.

**Its knobs are speed-for-fidelity trades, not quality settings.** `--layers`
drops transformer blocks, `--reuse` reuses the denoiser's velocity between
steps, `--core-reuse` refreshes the core residual less often. Every one makes a
DIFFERENT take, not the same take faster, so the studio presents them as one
"Effort" ladder with the individual dials behind it.

**Two of them are machine facts, not preferences.** `--ssd-streaming` trades
26% of the speed for 34 GB of memory, which is a rescue on a 36 GB Mac and a
pure loss on a 128 GB one; `--use-int8-row-fc2` is an M5 kernel. Those are
DERIVED from what the machine is (`recommended_settings`), not asked.

**`--token-reduction` is off, and stays off unless someone asks for it.**
Upstream measures it 28% faster; a user on an M4 Max 128 GB measured every
render with it producing doubled images and garbled audio, and upstream's own
README says not to combine it with `--layers 40 --reuse 3`. A 28% saving is not
worth a coin flip on whether the clip is usable, so the default is off and the
switch says what it costs.
"""
import json
import math
import os
import platform
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from gateway import config, history as _history, jobs, media as _media, native_mlx, util

BACKEND = "h3c-metal-minimax-h3"
OUTPUT_SUBDIR = "MiniMaxH3"

# Straight out of vendor/h3.c: h3_host.h (H3_CANVAS_MULTIPLE, H3_MAX_PIXELS,
# H3_FPS) and h3_valid_params/h3_generate in h3.c. Duplicated here so the lane
# can refuse a bad request in the studio's words instead of forty seconds into
# a render in the engine's.
CANVAS_MULTIPLE = 32
MAX_PIXELS = 768 * 1344
FPS = 24
FRAME_MODULUS = 17
FRAME_OFFSET = 5
MIN_FRAMES = 22          # one trained 22-frame decoder chunk
MAX_FRAMES = 362         # 5 + 17*21, ~15.1s
LAYER_RANGE = (35, 50)
STEP_RANGE = (2, 1000)
REUSE_RANGE = (1, 3)
CORE_REUSE_RANGE = (1, 6)
MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
MAX_LORAS = 20           # h3.h H3_MAX_LORAS

# How long a render may take before the runner gives up on it. A reference-
# quality 15s clip is genuinely tens of minutes on a laptop, so this is wide.
DEFAULT_TIMEOUT_SECONDS = 10800

# The safetensors format pads its header so the payload starts on an 8-byte
# boundary; a writer that skips the padding leaves every tensor 1-3 bytes off.
# h3.c on an M5 maps shard bytes straight into GPU buffers, and a 4-byte GPU
# load at a 2-mod-4 address silently reads the wrong bytes — a black render
# with saturated audio, byte-identical across seeds. So the lane checks every
# transformer shard (8 bytes each) before a render and, on a misaligned
# snapshot, starts h3 with H3_ZERO_COPY_WEIGHTS=0: copied buffers, which are
# realigned by construction. An aligned snapshot keeps the engine's own
# default, the file-backed mode that makes H3 fit on a smaller Mac.
SAFETENSORS_ALIGN = 8
ZERO_COPY_WEIGHTS_WHEN_MISALIGNED = "0"


# ---------------------------------------------------------------------------
# The effort ladder
# ---------------------------------------------------------------------------
# Four stops, in the order the studio's slider walks them. steps/layers/reuse
# come from upstream's own measured recipes (README "Recommended
# configurations"): draft is its aggressive preview, fast and reference are its
# fast and reference rows, balanced is the fast row with every block back.
#
# `render_scale` is this lane's own idea, not upstream's: h3.c can sample on a
# smaller internal canvas (--render-width/--render-height) and upscale, so a
# draft of a 1216x704 shot costs a quarter of the rows without the studio
# having to change the size the person asked for.
#
# core_reuse stays 1 at every stop: h3.c refuses core_reuse > 1 together with
# reuse > 1, so a preset that raised both would simply fail to start.
PRESETS = {
    "draft": {
        "label": "Draft",
        "steps": 4,
        "layers": 40,
        "reuse": 3,
        "core_reuse": 1,
        "render_scale": 0.5,
        "description": "A look at the framing and the motion in seconds, at half the internal size.",
    },
    "fast": {
        "label": "Fast",
        "steps": 20,
        "layers": 45,
        "reuse": 2,
        "core_reuse": 1,
        "render_scale": 1.0,
        "description": "Upstream's fast recipe: five blocks dropped, velocity reused every other step.",
    },
    "balanced": {
        "label": "Balanced",
        "steps": 20,
        "layers": 50,
        "reuse": 2,
        "core_reuse": 1,
        "render_scale": 1.0,
        "description": "Every transformer block, still reusing velocity. The best take per minute.",
    },
    "reference": {
        "label": "Reference",
        "steps": 50,
        "layers": 50,
        "reuse": 1,
        "core_reuse": 1,
        "render_scale": 1.0,
        "description": "Nothing skipped and nothing reused — the model's own output, and much slower.",
    },
}
PRESET_ORDER = ("draft", "fast", "balanced", "reference")
DEFAULT_PRESET = "balanced"

# Weights resident in unified memory need ~36.5 GB for the DiT alone, on top of
# the 62 GB encoder pass and the VAEs. Below this, stream the DiT from SSD and
# pay the 26%; above it, streaming is a pure loss.
SSD_STREAMING_BELOW_GB = 48

_profile_cache = {"at": 0.0, "value": None}
_PROFILE_TTL_SECONDS = 120.0


def _sysctl(name):
    try:
        result = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def engine_path():
    return Path(config.H3C_BIN).expanduser()


def model_dir():
    return Path(config.H3C_MODEL_DIR).expanduser()


def shard_alignment(path):
    """How far a shard's payload sits off the 8-byte boundary. 0 is spec."""
    with open(path, "rb") as handle:
        header_len = int.from_bytes(handle.read(8), "little")
    return (8 + header_len) % SAFETENSORS_ALIGN


def transformer_shards_aligned(directory):
    """(aligned, misaligned_names) for the FL2VA transformer under `directory`.

    Eight bytes per shard, so cheap enough for every profile read. An absent
    or unreadable shard counts as aligned here — readiness reports that case
    on its own, and this is only about the one silent failure.
    """
    transformer = Path(directory) / "FL2VA" / "transformer"
    misaligned = []
    for shard in sorted(transformer.glob("*.safetensors")):
        try:
            if shard.is_file() and shard_alignment(shard) != 0:
                misaligned.append(shard.name)
        except OSError:
            continue
    return (not misaligned, misaligned)


def _model_inventory(directory):
    """What the checkpoint tree at `directory` actually holds.

    Deliberately a filesystem check rather than `h3 --info`: this is asked on
    every catalog load, and --info maps every safetensors header in a 134 GB
    tree. The engine's own inventory is read once, lazily, by `device_info`.
    """
    fl2va = directory / "FL2VA"
    transformer = fl2va / "transformer"
    ref2va = directory / "Ref2VA" / "transformer"
    fl2va_ready = bool(
        (transformer / "config.json").exists()
        and list(transformer.glob("*.safetensors"))
        and (fl2va / "tokenizer" / "tokenizer.json").exists()
        and list((fl2va / "text_encoder").glob("*.safetensors"))
        and (fl2va / "video_vae" / "source").is_dir()
        and (fl2va / "audio_vae").is_dir()
    )
    aligned, misaligned = transformer_shards_aligned(directory)
    return {
        "path": str(directory),
        "fl2va": fl2va_ready,
        "ref2va": bool(ref2va.is_dir() and list(ref2va.glob("*.safetensors"))),
        # False means the file-backed weight path would read these shards
        # WRONG on the GPU; the runner copies instead, and the studio says so.
        "shards_aligned": aligned,
        "misaligned_shards": misaligned,
    }


def engine_fuses_loras(binary):
    """Whether this h3 build takes --lora, which patches/h3c-lora.patch adds.

    Asked of the binary rather than assumed from the install script, so a Mac
    that built the engine before the patch existed is told to rebuild instead
    of failing a render on an unknown option. `--help` returns before the
    engine touches Metal or the checkpoint.
    """
    if not (binary.is_file() and os.access(binary, os.X_OK)):
        return False
    try:
        result = subprocess.run([str(binary), "--help"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return "--lora-strength" in (result.stdout or "") + (result.stderr or "")


def machine_profile(refresh=False):
    """What this Mac is, and what of the lane is installed on it.

    Everything the studio needs to say "MiniMax H3 runs here, at about this
    speed" before anything has been generated, and to pick a starting preset
    without asking. Cached: a machine does not grow memory between page loads.
    """
    now = time.monotonic()
    if not refresh and _profile_cache["value"] is not None and now - _profile_cache["at"] < _PROFILE_TTL_SECONDS:
        return _profile_cache["value"]
    memory_bytes = int(_sysctl("hw.memsize") or 0)
    chip = _sysctl("machdep.cpu.brand_string") or "Apple Silicon"
    binary = engine_path()
    directory = model_dir()
    inventory = _model_inventory(directory)
    generation = _chip_generation(chip)
    profile = {
        "platform": platform.system(),
        "arch": platform.machine(),
        "chip": chip,
        "chip_generation": generation,
        "memory_gb": round(memory_bytes / 1024 ** 3, 1) if memory_bytes else None,
        "apple_silicon": platform.system() == "Darwin" and platform.machine() == "arm64",
        "engine_installed": binary.is_file() and os.access(binary, os.X_OK),
        "engine_path": str(binary),
        "engine_loras": engine_fuses_loras(binary),
        "ffmpeg": bool(shutil.which(os.environ.get("H3_FFMPEG", "ffmpeg"))
                       and shutil.which(os.environ.get("H3_FFPROBE", "ffprobe"))),
        "model": inventory,
        "route_enabled": config.supports_native_h3_route(),
    }
    profile["recommended"] = recommended_settings(profile)
    # Not a blocker — the runner copies the weights instead — but worth a
    # sentence and its fix, because file-backed weights are what let H3 fit on
    # a smaller Mac, and a person on one would otherwise never learn why it is
    # heavier here than the engine's README says.
    profile["advisory"] = None if inventory["shards_aligned"] else {
        "reason": (f"{len(inventory['misaligned_shards'])} of the checkpoint's transformer shards were written "
                   "without the safetensors header padding, so the weights are copied into memory instead of "
                   "mapped from disk (about 62 GB more resident)."),
        "fix": "scripts/assemble_h3c_model.py --realign",
    }
    profile["ready"] = bool(
        profile["apple_silicon"] and profile["route_enabled"]
        and profile["engine_installed"] and profile["ffmpeg"] and inventory["fl2va"]
    )
    profile["blocked_by"] = _first_blocker(profile)
    _profile_cache.update({"at": now, "value": profile})
    return profile


def _chip_generation(chip):
    """The M-number, when the brand string carries one. 0 for anything else."""
    match = re.search(r"\bM(\d+)\b", str(chip or ""), re.IGNORECASE)
    return int(match.group(1)) if match else 0


def _first_blocker(profile):
    """The ONE thing standing between this machine and a render, with the fix.

    Ordered by what has to be true first, so the studio never tells someone to
    download 134 GB of weights for an engine they have not built.
    """
    if not profile["apple_silicon"]:
        return {
            "reason": "h3.c is a Metal engine and this machine is not Apple silicon.",
            "fix": "",
        }
    if not profile["route_enabled"]:
        return {
            "reason": "The native H3 route is switched off on this machine.",
            "fix": "Unset ZIMG_ENABLE_H3C_ROUTE=0 in stack-local.env and restart the stack.",
        }
    if not profile["engine_installed"]:
        return {
            "reason": "The h3.c engine is not built on this machine yet.",
            "fix": "scripts/install_h3c.sh",
        }
    if not profile["ffmpeg"]:
        return {
            "reason": "h3.c shells out to ffmpeg and ffprobe for media, and they are not on PATH.",
            "fix": "brew install ffmpeg",
        }
    if not profile["model"]["fl2va"]:
        return {
            "reason": "The MiniMax H3 checkpoint is not in place for h3.c.",
            "fix": "scripts/assemble_h3c_model.py --from <snapshot>",
        }
    return None


def recommended_settings(profile):
    """The starting point this machine should be given, and why.

    The preset is a judgement about patience; the other two are facts about the
    hardware and are not offered as choices in the studio.
    """
    memory = float(profile.get("memory_gb") or 0)
    generation = int(profile.get("chip_generation") or 0)
    if memory >= 64 and generation >= 5:
        preset = "balanced"
        why = f"{profile.get('chip')} with {memory:.0f} GB holds the whole model in memory."
    elif memory >= 64:
        preset = "fast"
        why = f"{memory:.0f} GB is enough to keep the model resident; five blocks dropped keeps it quick."
    elif memory >= 32:
        preset = "fast"
        why = f"{memory:.0f} GB means the transformer streams from disk, so fewer blocks is the right trade."
    else:
        preset = "draft"
        why = f"{memory:.0f} GB is below what a full-size H3 render needs; drafts at half size will run."
    return {
        "preset": preset,
        "why": why,
        # Below ~48 GB the resident DiT does not fit beside the encoder pass.
        "ssd_streaming": memory > 0 and memory < SSD_STREAMING_BELOW_GB,
        # An M5-only kernel (upstream: ~2.6% faster), inert elsewhere.
        "int8_row_fc2": generation >= 5,
        # Never recommended. See the module docstring.
        "token_reduction": False,
    }


def route_readiness():
    """The lane's own preflight, in the shape the gateway's dependency report
    uses: ok plus, when not, the one thing to do about it."""
    profile = machine_profile()
    return {
        "ok": profile["ready"],
        "reference_mode": profile["model"]["ref2va"],
        "blocked_by": profile["blocked_by"],
        "profile": profile,
    }


def device_info():
    """`h3 --info`, parsed. The engine's own account of the GPU and the
    checkpoint — Metal 4, the Apple GPU family, the tensor counts — which is
    worth having in a job record but costs a full header walk, so it is never
    on the catalog path."""
    binary = engine_path()
    directory = model_dir()
    if not (binary.is_file() and directory.is_dir()):
        return None
    try:
        result = subprocess.run(
            [str(binary), "--info", "-d", str(directory)],
            capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = result.stdout or ""
    device = re.search(r"^Device:\s*(.+?)\s*\((.+?)\)\s*$", text, re.MULTILINE)
    info = {
        "device": device.group(1) if device else "",
        "architecture": device.group(2) if device else "",
        "metal4": bool(re.search(r"^\s*Metal 4\s+yes", text, re.MULTILINE)),
    }
    family = re.search(r"^\s*Apple GPU family\s+(\d+)", text, re.MULTILINE)
    if family:
        info["gpu_family"] = int(family.group(1))
    return info


# ---------------------------------------------------------------------------
# Turning a studio request into an h3 command line
# ---------------------------------------------------------------------------

def align_frames(requested):
    """h3_align_frame_count: the smallest 5+17n at or above `requested`."""
    value = max(FRAME_OFFSET, int(requested or 0))
    remainder = (value - FRAME_OFFSET) % FRAME_MODULUS
    if remainder:
        value += FRAME_MODULUS - remainder
    return value


def snap_canvas(width, height):
    """The legal h3 canvas closest to what was asked for.

    Legal means both sides multiples of 32 and the product inside 768x1344.
    "Closest" means the *shape* is what is preserved: of every grid canvas that
    fits, this takes the one whose aspect ratio is nearest the request, and
    breaks ties on area. Scaling and flooring each side independently is what a
    first pass does, and it quietly turns a 16:9 request into 1.83:1 — a drift
    nobody asked for and nobody would spot until the clip was letterboxed.
    """
    width = max(CANVAS_MULTIPLE, int(width or 0))
    height = max(CANVAS_MULTIPLE, int(height or 0))
    if width % CANVAS_MULTIPLE == 0 and height % CANVAS_MULTIPLE == 0 and width * height <= MAX_PIXELS:
        return width, height
    wanted = width / float(height)
    scale = min(1.0, math.sqrt(MAX_PIXELS / float(width * height)))
    base_w = max(CANVAS_MULTIPLE, int(width * scale))
    base_h = max(CANVAS_MULTIPLE, int(height * scale))
    best = None
    for steps_w in range(-4, 5):
        candidate_w = (base_w // CANVAS_MULTIPLE + steps_w) * CANVAS_MULTIPLE
        if candidate_w < CANVAS_MULTIPLE:
            continue
        for steps_h in range(-4, 5):
            candidate_h = (base_h // CANVAS_MULTIPLE + steps_h) * CANVAS_MULTIPLE
            if candidate_h < CANVAS_MULTIPLE or candidate_w * candidate_h > MAX_PIXELS:
                continue
            drift = abs(candidate_w / float(candidate_h) - wanted)
            # Shape first, then the canvas nearest the asked-for area — so a
            # request that already fits is never quietly enlarged to use up the
            # pixel budget.
            score = (round(drift, 6), abs(candidate_w * candidate_h - width * height))
            if best is None or score < best[0]:
                best = (score, (candidate_w, candidate_h))
    if best is not None:
        return best[1]
    # Nothing in the neighbourhood fits, which only happens for an absurd
    # request; fall back to the smallest legal canvas of roughly that shape.
    return (CANVAS_MULTIPLE, CANVAS_MULTIPLE)


# Below this on the short edge the token grid is too coarse to hold a shot
# together — upstream measures 256 as the native fast-preview size and calls
# 128 (a 4x4 grid) unsupported. A draft of an already-small canvas therefore
# samples at full size rather than at a size that renders mush.
MIN_RENDER_EDGE = 256


def snap_render_canvas(width, height, scale):
    """An internal sampling canvas at `scale`, same aspect, multiples of 32.

    h3.c requires render_width * height == render_height * width exactly, so
    this walks down from the ideal until the cross-product matches rather than
    rounding each side and hoping. Returns (0, 0) when there is no smaller
    same-aspect canvas worth using, which is the engine's own way of saying
    "sample at full size".
    """
    if not scale or scale >= 1.0:
        return 0, 0
    for steps_down in range(0, 64):
        candidate_w = int(width * scale) - steps_down * CANVAS_MULTIPLE
        if candidate_w < CANVAS_MULTIPLE:
            break
        candidate_w = (candidate_w // CANVAS_MULTIPLE) * CANVAS_MULTIPLE
        if candidate_w < CANVAS_MULTIPLE or candidate_w > width:
            continue
        if (candidate_w * height) % width:
            continue
        candidate_h = (candidate_w * height) // width
        if candidate_h < CANVAS_MULTIPLE or candidate_h % CANVAS_MULTIPLE or candidate_h > height:
            continue
        if min(candidate_w, candidate_h) < MIN_RENDER_EDGE:
            return 0, 0
        return candidate_w, candidate_h
    return 0, 0


def _clamp(value, low, high, default):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def resolve_settings(options):
    """The effective dials for one request: a preset, then whatever was overridden.

    A request names a preset (or takes this machine's recommendation) and may
    override any dial on top. The result records `preset` as the stop it
    started from and `custom` as whether anything moved, so the studio's slider
    and the job record agree about what actually ran.
    """
    options = dict(options or {})
    profile = machine_profile()
    recommended = profile["recommended"]
    name = str(options.get("preset") or "").strip().lower()
    if name not in PRESETS:
        name = recommended["preset"] if recommended["preset"] in PRESETS else DEFAULT_PRESET
    preset = PRESETS[name]

    steps = _clamp(options.get("steps"), *STEP_RANGE, preset["steps"]) if options.get("steps") is not None else preset["steps"]
    layers = _clamp(options.get("layers"), *LAYER_RANGE, preset["layers"]) if options.get("layers") is not None else preset["layers"]
    reuse = _clamp(options.get("reuse"), *REUSE_RANGE, preset["reuse"]) if options.get("reuse") is not None else preset["reuse"]
    core_reuse = (_clamp(options.get("core_reuse"), *CORE_REUSE_RANGE, preset["core_reuse"])
                  if options.get("core_reuse") is not None else preset["core_reuse"])
    render_scale = preset["render_scale"]
    if options.get("render_scale") is not None:
        try:
            render_scale = max(0.25, min(1.0, float(options["render_scale"])))
        except (TypeError, ValueError):
            pass

    # h3.c refuses both reuse dials at once (h3.c: "core reuse and denoise
    # reuse cannot both be raised"). They say the same thing at different
    # granularities, so the one the request actually moved wins rather than the
    # render failing to start.
    if core_reuse > 1 and reuse > 1:
        if options.get("core_reuse") is not None and options.get("reuse") is None:
            reuse = 1
        else:
            core_reuse = 1

    token_reduction = bool(options.get("token_reduction"))
    # Upstream's own warning, and the shape of the artefact reports: paired
    # tokens plus a thinned, reused transformer is where the doubled images
    # come from. Refuse the combination rather than render a ruined clip.
    if token_reduction and layers <= 40 and reuse >= 3:
        token_reduction = False

    ssd_streaming = options.get("ssd_streaming")
    ssd_streaming = recommended["ssd_streaming"] if ssd_streaming is None else bool(ssd_streaming)
    int8_row_fc2 = options.get("int8_row_fc2")
    int8_row_fc2 = recommended["int8_row_fc2"] if int8_row_fc2 is None else bool(int8_row_fc2)

    settings = {
        "preset": name,
        "steps": steps,
        "layers": layers,
        "reuse": reuse,
        "core_reuse": core_reuse,
        "render_scale": render_scale,
        "token_reduction": token_reduction,
        "ssd_streaming": ssd_streaming,
        "int8_row_fc2": int8_row_fc2,
    }
    settings["custom"] = any(
        settings[key] != preset[key] for key in ("steps", "layers", "reuse", "core_reuse", "render_scale")
    )
    return settings


def build_command(*, prompt, output, width, height, frames, seed, settings,
                  first_frame=None, last_frame=None, reference_images=(),
                  reference_videos=(), reference_audios=(), loras=(),
                  binary=None, directory=None):
    """The argv h3 is run with. Pure: no filesystem, no globals — the runner
    stages the media, this only names it, which is what makes it testable."""
    binary = Path(binary or engine_path())
    directory = Path(directory or model_dir())
    command = [str(binary), "-d", str(directory), "-p", prompt]
    # Ref2VA and frame anchors are separate checkpoints and h3 refuses the
    # combination; the caller is expected to have chosen, and this asserts it
    # rather than letting the engine say it forty seconds in.
    if reference_images or reference_videos or reference_audios:
        if first_frame or last_frame:
            raise ValueError(
                "MiniMax H3 reference mode and a start/end frame are different checkpoints "
                "and cannot be combined — use reference pictures, or frames, not both."
            )
        for path in list(reference_images)[:MAX_REFERENCE_IMAGES]:
            command += ["--ref-image", str(path)]
        for entry in list(reference_videos)[:MAX_REFERENCE_VIDEOS]:
            # h3.c draws the distinction itself: --ref-video conditions on the
            # clip AND its soundtrack (which then takes an <Audio N> label of
            # its own), --ref-silent-video on the pictures alone. The studio's
            # per-row "use its sound" switch is exactly this choice, so it
            # picks the flag rather than the lane re-encoding the file.
            path, use_audio = entry if isinstance(entry, tuple) else (entry, False)
            command += ["--ref-video" if use_audio else "--ref-silent-video", str(path)]
        for path in list(reference_audios)[:MAX_REFERENCE_AUDIOS]:
            command += ["--ref-audio", str(path)]
    else:
        if first_frame:
            command += ["--first-frame", str(first_frame)]
        if last_frame:
            command += ["--last-frame", str(last_frame)]
    command += [
        "--width", str(width),
        "--height", str(height),
        "--frames", str(frames),
        "--steps", str(settings["steps"]),
        "--layers", str(settings["layers"]),
        "--reuse", str(settings["reuse"]),
        "--seed", str(seed),
    ]
    if settings["core_reuse"] > 1:
        command += ["--core-reuse", str(settings["core_reuse"])]
    render_width, render_height = snap_render_canvas(width, height, settings["render_scale"])
    if render_width and render_height:
        command += ["--render-width", str(render_width), "--render-height", str(render_height)]
    if settings["token_reduction"]:
        command.append("--token-reduction")
    if settings["ssd_streaming"]:
        command.append("--ssd-streaming")
    if settings["int8_row_fc2"]:
        command.append("--use-int8-row-fc2")
    # Each LoRA is the library's resolved file, at the strength after it. h3.c
    # stacks them in this order and checks every adapter before it loads.
    for lora in loras:
        command += ["--lora", str(lora["filePath"]),
                    "--lora-strength", f"{float(lora.get('scale', 1.0)):g}"]
    command += ["-o", str(output)]
    return command


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------
# h3.c writes `\r%-25s %4d/%-4d` to stderr (h3_cli.c: cli_progress). The phases
# it emits are fixed, and so is the ORDER, which is the only thing that makes a
# band table into a real position rather than a guess.
#
# THE ORDER IS LOAD-BEARING, and getting it wrong does not look like a bug — it
# looks like a hang. The bar only ever moves forward (a percentage that retreats
# reads as a stall), so a phase placed EARLIER in this table than the engine
# emits it simply never moves the bar: the first real render on an M5 Max sat at
# 37% for twenty-five seconds because `load transformer core` was listed above
# `refine text` while the engine emits it below. Read off h3_dit.c's load_dit,
# which calls them in exactly this sequence: refine_text, then the AdaLN
# schedule precompute, then load_core.
#
# The widths are what each phase costs as a share of a whole render. Denoise
# gets the largest because it is the only one that scales with sampling steps;
# the transformer load gets the next largest because on a cold run it is most of
# the wall clock. The three encoder phases at the top only appear when something
# is attached, and a run without them simply starts further along.
_PROGRESS_BANDS = (
    ("tokenizer", 0.0, 1.0),
    ("audio VAE encoder", 1.0, 3.0),
    ("video VAE encoder", 3.0, 6.0),
    ("Qwen vision", 6.0, 9.0),
    ("text encoder", 9.0, 22.0),
    ("refine text", 22.0, 23.0),
    ("precompute AdaLN", 23.0, 27.0),
    ("load transformer core", 27.0, 45.0),
    ("preview VAE load", 45.0, 46.0),
    ("denoise enqueue", 46.0, 48.0),
    ("denoise", 48.0, 86.0),
    ("audio VAE", 86.0, 89.0),
    ("video VAE load", 89.0, 97.0),
    ("FFmpeg", 97.0, 100.0),
)

# The sequence h3.c actually emits, which the bands above must agree with. Kept
# beside them so a reordering has to change both, and pinned by a test.
PHASE_ORDER = tuple(name for name, _start, _end in _PROGRESS_BANDS)
_PROGRESS_LINE = re.compile(r"([A-Za-z][A-Za-z0-9 .]*?)\s+(\d+)\s*/\s*(\d+)\s*$")


def parse_progress_line(text):
    """One `phase n/total` line -> (phase, completed, total), or None."""
    match = _PROGRESS_LINE.match(text.strip())
    if not match:
        return None
    phase = match.group(1).strip()
    completed, total = int(match.group(2)), int(match.group(3))
    if total <= 0 or completed > total:
        return None
    return phase, completed, total


def progress_percent(phase, completed, total):
    """Where in the whole render this phase-and-count sits, 0-100."""
    for name, start, end in _PROGRESS_BANDS:
        if name == phase:
            return start + (end - start) * (completed / float(total))
    # An unnamed phase still moves: place it where the denoise band is if it
    # mentions denoising, otherwise leave the bar alone by returning None.
    if "denoise" in phase.lower():
        return 48.0 + 38.0 * (completed / float(total))
    return None


def update_process_progress(job_id, rec, text):
    """The `on_progress` hook handed to native_mlx.run_native_subprocess.

    `text` is the rolling tail of BOTH streams, carriage returns and all, so
    the last complete measurement in it is the current one.
    """
    latest = None
    for chunk in re.split(r"[\r\n]+", text):
        parsed = parse_progress_line(chunk)
        if parsed:
            latest = parsed
    if latest is None:
        return
    phase, completed, total = latest
    percent = progress_percent(phase, completed, total)
    if percent is None:
        return
    rec.update({
        "progress": max(int(rec.get("progress") or 0), int(round(percent))),
        "progress_phase": phase,
    })
    if phase == "denoise":
        rec.update({
            "current_step": completed,
            "total_steps": total,
            "step_progress": round(100 * completed / max(1, total)),
        })
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


# h3.c says what it will fuse on stderr before it loads anything (h3.c,
# h3_generate): adapter and tensor counts, then a warning with how many
# adapters it skipped because their shape does not fit this checkpoint.
_LORA_FUSED_LINE = re.compile(r"h3: lora: fusing (\d+) adapters into (\d+) DiT tensors")
_LORA_SKIPPED_LINE = re.compile(r"h3: lora warning: skipped (\d+) adapters")


def lora_fusion_report(text):
    """The engine's own account of the LoRAs it fused, for the job record.

    Skipping an adapter that does not fit is ComfyUI's rule too, so the count
    has to reach the record: a half-applied LoRA otherwise reads exactly like a
    whole one. Empty when the render asked for none.
    """
    fused = _LORA_FUSED_LINE.search(text or "")
    if not fused:
        return {}
    skipped = _LORA_SKIPPED_LINE.search(text or "")
    return {
        "lora_adapters": int(fused.group(1)),
        "lora_tensors": int(fused.group(2)),
        "lora_adapters_skipped": int(skipped.group(1)) if skipped else 0,
    }


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------

def _history_prompt_tuple(job_id, workflow=None):
    extra = {"backend": BACKEND}
    if workflow:
        extra["extra_pnginfo"] = {"workflow": _history.scrub_workflow_prompt_text(workflow)}
    return [0, job_id, {}, extra, []]


def _staged_path(value):
    """A name the MCP uploaded, resolved under the gateway's input directory.

    An absolute path is taken as given (the studio stages some media itself);
    anything else is a name inside COMFY_INPUT_DIR, never a path out of it.
    """
    if not value:
        return None
    path = Path(str(value))
    if not path.is_absolute():
        path = config.COMFY_INPUT_DIR / path.name
    return path


def refuse_unrunnable_loras(loras, settings, profile, options):
    """Why a LoRA render cannot start, raised before the queue in the lane's words.

    h3.c checks every adapter against the checkpoint itself within a second of
    starting, and refuses a LoRA made for another model in its own sentence.
    These are the refusals it cannot make, or would make about a flag rather
    than about this Mac.
    """
    if not loras:
        return
    if len(loras) > MAX_LORAS:
        raise RuntimeError(f"MiniMax H3 (Apple Silicon) fuses at most {MAX_LORAS} LoRAs into one render.")
    missing = next((lora for lora in loras if not lora.get("filePath")), None)
    if missing:
        raise RuntimeError(
            f"LoRA not found in this Mac's LoRA library: {missing.get('name') or missing.get('source')}"
        )
    if not profile.get("engine_loras"):
        raise RuntimeError(
            "The h3.c build on this Mac predates LoRA support. Run scripts/install_h3c.sh, "
            "which applies patches/h3c-lora.patch and rebuilds the engine."
        )
    if settings["ssd_streaming"]:
        if options.get("ssd_streaming") is True:
            raise RuntimeError(
                "LoRAs are fused into the transformer as it loads, and SSD streaming never loads it: "
                "switch SSD streaming off to render with LoRAs."
            )
        raise RuntimeError(
            "LoRAs are fused into the transformer as it loads, so it has to be held in memory, and this Mac "
            f"({profile.get('memory_gb')} GB) streams it from SSD instead. Render without LoRAs here, or use a "
            "MiniMax H3 lane on a rented NVIDIA machine, which applies them through ComfyUI."
        )


def queue_native_h3_job(native, workflow=None):
    """Admit one h3.c render and return its job id.

    Refuses here, before the queue, for anything the machine cannot do — an
    unbuilt engine, absent weights, reference pictures with no Ref2VA
    checkpoint, a LoRA it cannot fuse — so the studio gets a sentence it can
    act on instead of a job that dies a minute later.
    """
    readiness = route_readiness()
    if not readiness["ok"]:
        blocker = readiness["blocked_by"] or {}
        raise RuntimeError(blocker.get("reason") or "MiniMax H3 cannot run on this machine")
    options = dict(native.get("options") or {})
    if native.get("reference_images") or native.get("reference_videos") or native.get("reference_audios"):
        if not readiness["reference_mode"]:
            raise RuntimeError(
                "Reference pictures need MiniMax H3's Ref2VA checkpoint, which is not installed "
                "(hf download MiniMaxAI/MiniMax-H3 --include 'Ref2VA/*'). Generate from the prompt, "
                "or from a start frame, instead."
            )
    settings = resolve_settings(options)
    refuse_unrunnable_loras(native.get("loras") or [], settings, readiness["profile"], options)
    job_id = uuid.uuid4().hex[:12]
    with jobs.jobs_lock:
        jobs.jobs[job_id] = {
            "id": job_id,
            "prompt": _history.PRIVATE_PROMPT_LABEL,
            "comfy_prompt": _history_prompt_tuple(job_id, workflow),
            "status": "queued",
            "backend": BACKEND,
            "created_at": util.now_iso(),
            "outputs": [],
            "options": _public_options(native, settings),
            "source": "comfy-prompt-intercept",
        }
    jobs.start_studio_generation_thread(
        "video", options, run_native_h3_video, (job_id, native, workflow))
    return job_id


def _public_options(native, settings):
    """What the job record says about this render. Counts and dials, and LoRA
    names as the LTX native lane records them — no prompt, no paths, nothing
    that names the owner's media."""
    options = dict(native.get("options") or {})
    loras = native.get("loras") or []
    return {
        "engine": "h3.c",
        "preset": settings["preset"],
        "custom": settings["custom"],
        "steps": settings["steps"],
        "layers": settings["layers"],
        "reuse": settings["reuse"],
        "core_reuse": settings["core_reuse"],
        "render_scale": settings["render_scale"],
        "token_reduction": settings["token_reduction"],
        "ssd_streaming": settings["ssd_streaming"],
        "int8_row_fc2": settings["int8_row_fc2"],
        "width": options.get("width"),
        "height": options.get("height"),
        "frames": options.get("frames"),
        "frame_rate": FPS,
        "seed": options.get("seed"),
        "mode": _mode_name(native),
        **({"reference_images": len(native.get("reference_images") or [])}
           if native.get("reference_images") else {}),
        **({"reference_videos": len(native.get("reference_videos") or [])}
           if native.get("reference_videos") else {}),
        **({"reference_audios": len(native.get("reference_audios") or [])}
           if native.get("reference_audios") else {}),
        **({"lora_count": len(loras), "loras": [
            {"name": lora.get("name") or Path(str(lora.get("source") or "")).name,
             "strength": lora.get("scale", 1.0)}
            for lora in loras
        ]} if loras else {}),
    }


def _mode_name(native):
    if native.get("reference_images") or native.get("reference_videos") or native.get("reference_audios"):
        return "reference"
    if native.get("first_frame") and native.get("last_frame"):
        return "first-last-frame"
    if native.get("first_frame"):
        return "image-to-video"
    if native.get("last_frame"):
        return "last-frame"
    return "text-to-video"


def runner_environment(base=None, shards_aligned=None):
    """The environment h3 is started with. Pure over its inputs, so testable.

    The tool paths keep the render working under a launchd stack with a minimal
    PATH — h3.c looks ffmpeg and ffprobe up by name. The weight-mapping choice
    is THE SETTING THAT DECIDED WHETHER THIS LANE RENDERED ANYTHING: h3.c on an
    M5 maps every transformer shard file-backed into GPU buffers, which is the
    right default for a spec-aligned snapshot and a silent black render for a
    misaligned one (see ZERO_COPY_WEIGHTS_WHEN_MISALIGNED). So the choice
    follows the snapshot: misaligned shards get copied buffers, aligned ones
    keep the engine's own default. Every entry is setdefault — an operator's
    own value in stack-local.env stays authoritative for experiments.
    """
    env = dict(os.environ if base is None else base)
    for name, tool in (("H3_FFMPEG", "ffmpeg"), ("H3_FFPROBE", "ffprobe")):
        found = shutil.which(tool)
        if found:
            env.setdefault(name, found)
    if shards_aligned is None:
        shards_aligned, _names = transformer_shards_aligned(model_dir())
    if not shards_aligned:
        env.setdefault("H3_ZERO_COPY_WEIGHTS", ZERO_COPY_WEIGHTS_WHEN_MISALIGNED)
    return env


def run_native_h3_video(job_id, native, workflow=None):
    started = util.now_iso()
    options = dict(native.get("options") or {})
    settings = resolve_settings(options)
    prompt = str(native.get("prompt") or "").strip()
    width, height = snap_canvas(options.get("width") or 864, options.get("height") or 480)
    frames = max(MIN_FRAMES, min(MAX_FRAMES, align_frames(options.get("frames") or 56)))
    seed = util.int_option(options, "seed", 42, 0, 1_000_000_000)
    out_dir = config.COMFY_OUTPUT_DIR / OUTPUT_SUBDIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"h3c_{job_id}_{frames}f.mp4"

    first_frame = _staged_path(native.get("first_frame"))
    last_frame = _staged_path(native.get("last_frame"))
    reference_images = [_staged_path(item) for item in (native.get("reference_images") or [])]
    # Each motion clip carries whether its own soundtrack is conditioned in,
    # which decides the flag rather than a re-encode. A bare string is the same
    # row with the sound left out.
    reference_videos = [
        (_staged_path(item.get("path") if isinstance(item, dict) else item),
         bool(item.get("use_audio")) if isinstance(item, dict) else False)
        for item in (native.get("reference_videos") or [])
    ]
    reference_audios = [_staged_path(item) for item in (native.get("reference_audios") or [])]
    staged = [path for path in ([first_frame, last_frame] + reference_images
                                + [item[0] for item in reference_videos] + reference_audios) if path]
    for path in staged:
        if not path.is_file():
            raise FileNotFoundError("One of the attached references could not be read")

    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "comfy_prompt": _history_prompt_tuple(job_id, workflow),
        "status": "running",
        "backend": BACKEND,
        "created_at": started,
        "started_at": started,
        "outputs": [],
        "options": {**_public_options(native, settings), "width": width, "height": height, "frames": frames, "seed": seed},
        "current_step": 0,
        "total_steps": settings["steps"],
        "progress": 1,
        "step_progress": 0,
        "progress_phase": "loading",
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec

    elapsed = 0.0
    stdout = stderr = ""
    visible_out = out
    try:
        command = build_command(
            prompt=prompt, output=out, width=width, height=height, frames=frames, seed=seed,
            settings=settings,
            first_frame=first_frame, last_frame=last_frame,
            reference_images=reference_images,
            reference_videos=reference_videos,
            reference_audios=reference_audios,
            loras=native.get("loras") or [],
        )
        env = runner_environment()
        # What the weights were loaded through, so a render that comes back
        # wrong can be read against it: the engine's own default ("engine"),
        # or the copy path forced by a misaligned snapshot ("0").
        rec["options"]["zero_copy_weights"] = env.get("H3_ZERO_COPY_WEIGHTS", "engine")
        t0 = time.monotonic()
        _media.mark_output_active(out)
        try:
            proc = native_mlx.run_native_subprocess(
                job_id, rec, command,
                cwd=str(engine_path().parent),
                env=env,
                timeout=util.int_option(options, "runtime_timeout_seconds", DEFAULT_TIMEOUT_SECONDS, 60, 43200),
                # The owner's start frame and references go in nameless, exactly
                # as they do on the LTX native lane: for the length of the render
                # there is nothing in any directory for another process to find.
                anonymize_paths=[str(path) for path in staged],
                on_progress=update_process_progress,
            )
            elapsed = round(time.monotonic() - t0, 2)
            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()
            # Before the exit code, so a render that fails after fusing still
            # says what it fused.
            rec["options"].update(lora_fusion_report(stderr))
            if proc.returncode != 0:
                raise RuntimeError(f"h3 exited {proc.returncode}\nSTDOUT:\n{stdout[-2000:]}\nSTDERR:\n{stderr[-2000:]}")
            if native_mlx.native_job_cancel_requested(job_id):
                raise native_mlx.NativeJobCancelled(f"job {job_id} was cancelled after the render")
            if not out.exists() or out.stat().st_size < 1000:
                raise RuntimeError("h3 finished without a valid output video")
            visible_out = jobs.mirror_output_to_comfy_output(out, job_id=job_id)
        finally:
            _media.mark_output_inactive(out)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": [str(Path(visible_out).resolve())],
            "elapsed_seconds": elapsed,
            "runner_stdout": util.json_safe_text(stdout),
            "runner_stderr": util.json_safe_text(stderr),
            "current_step": settings["steps"],
            "total_steps": settings["steps"],
            "progress": 100,
            "step_progress": 100,
            "progress_phase": "done",
        })
    except native_mlx.NativeJobCancelled:
        rec.update({"status": "cancelled", "finished_at": util.now_iso(),
                    "error": "Cancelled by the owner", "progress_phase": "cancelled"})
    except Exception as error:  # noqa: BLE001 — recorded on the job, not raised at a thread
        rec.update({"status": "error", "finished_at": util.now_iso(),
                    "error": str(error), "progress_phase": "error"})
    finally:
        # A native runner hands its media to a subprocess by path, so the file
        # has to exist while h3 reads it — but not a moment longer. Only
        # pipeline staging goes; a picture the owner uploaded under their own
        # name is theirs to keep.
        for path in staged:
            try:
                if path.name.startswith(_media.PRIVATE_INPUT_PREFIXES):
                    path.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    return job_id


def public_profile():
    """The machine + lane summary the studio renders. JSON-safe by construction."""
    profile = machine_profile()
    return json.loads(json.dumps({
        "presets": [{"name": name, **{k: v for k, v in PRESETS[name].items()}} for name in PRESET_ORDER],
        "default_preset": DEFAULT_PRESET,
        "limits": {
            "max_pixels": MAX_PIXELS,
            "canvas_multiple": CANVAS_MULTIPLE,
            "fps": FPS,
            "min_frames": MIN_FRAMES,
            "max_frames": MAX_FRAMES,
            "frame_grid": {"modulus": FRAME_MODULUS, "offset": FRAME_OFFSET},
            "layers": list(LAYER_RANGE),
            "steps": list(STEP_RANGE),
            "reuse": list(REUSE_RANGE),
            "core_reuse": list(CORE_REUSE_RANGE),
            "reference_images": MAX_REFERENCE_IMAGES,
            "reference_videos": MAX_REFERENCE_VIDEOS,
            "reference_audios": MAX_REFERENCE_AUDIOS,
        },
        "machine": profile,
    }))
