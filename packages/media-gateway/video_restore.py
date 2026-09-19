"""Video restoration and upscaling with SeedVR2 — the arithmetic, the graph, and
the assembly plan, kept out of the runner.

WHAT THIS IS. SeedVR2 (numz/ComfyUI-SeedVR2_VideoUpscaler) is a diffusion
restorer: it re-generates a clip at a higher resolution and, on the way, removes
the compression mush, the sharpening halos and the sensor noise that an ESRGAN
upscale would faithfully enlarge instead. The existing `/api/upscale` route is
still the right tool for one image; this is the one for footage, where temporal
consistency is the whole problem.

WHY IT IS CHUNKED AT ALL. The model holds a batch of frames in memory at once,
and that batch is what buys temporal consistency — so the batch cannot be one
frame, and it cannot be the whole clip either. Every practical render is
therefore a sequence of windows, and once it is a sequence, an interrupted
render that has to start from frame 0 is a render nobody will run twice. Chunk
boundaries are the checkpoints: a finished chunk is a file on disk, and a resume
is "which chunk file is missing".

THE THREE NUMBERS, and why they are not free choices:

  batch_size      Frames the model denoises together. MUST be 4n+1 (1, 5, 9,
                  13 ...) — the DiT's temporal compression is 4x plus one key
                  frame, and an off-lattice batch is rejected, not rounded.
  chunk_frames    Frames per graph submit. Kept a whole multiple of batch_size
                  so the last batch of a chunk is a full batch; a short tail
                  batch is the frame range most likely to shift in colour.
  context_frames  Source frames re-fed at the head of every chunk after the
                  first. They are already restored in the previous chunk — they
                  are here so the model ENTERS the chunk having seen the frames
                  before it, which is what stops a visible re-grade at every
                  boundary. Also a whole multiple of batch_size, so the context
                  occupies whole batches rather than splitting one.

SEAMS. With context frames, each boundary is covered TWICE: the tail of chunk i
and the head of chunk i+1 restore the same source frames from different
starting states. `seam_frames` says how many of those to cross-dissolve rather
than hard-cut. The dissolve replaces frames rather than inserting them, so the
master is exactly as long as the source — a crossfade that shortened the clip
by a few frames per boundary would silently desync the audio, which is remuxed
from the source untouched.

FINISHING IS NOT RESTORATION. Sharpening, grain, skin softening and the seam
dissolve are all decided at ASSEMBLY time from the saved chunk files, so
changing your mind about grain costs one ffmpeg pass, not another hour of
diffusion. That is the whole reason chunks are kept after the master is written.

WHERE IT RUNS. Every function here is lane-agnostic. The runner in app.py picks
the sink (see `SINK_*`), and there are three, because there are three places a
render can happen and they differ in exactly one thing: who is allowed to read
the finished chunk.

  local     this computer's ComfyUI. Frames come back as PNGs through ComfyUI's
            temp directory; the gateway reads them and encodes the chunk itself.
  rented    a GPU the owner rented and attached, billed by the hour. Its outputs
            are sealed to the owner's vault the moment they are harvested and
            the gateway may NOT read them — so those chunks are trimmed in the
            graph and assembled in the browser where the key lives.
  cloud     a serverless GPU, billed per chunk in HivemindOS credits. The
            restored chunk comes back to the gateway as ordinary bytes, so this
            sink behaves like the local one from here on: the gateway assembles,
            seams dissolve, and re-finishing costs one ffmpeg pass. What it buys
            instead of an hourly rate is that nothing is running between renders.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

# --- the model's own lattice -------------------------------------------------

# SeedVR2 compresses 4 frames to 1 latent plus a key frame, so a legal batch is
# 4n+1. Off-lattice values are refused by the node, not rounded down.
BATCH_MODULUS = 4
BATCH_OFFSET = 1

# Registry names from the node's model_registry.py. The node downloads a missing
# one on first use (several GB), which is why the studio says so before starting.
DIT_MODELS = (
    "seedvr2_ema_3b_fp8_e4m3fn.safetensors",
    "seedvr2_ema_3b_fp16.safetensors",
    "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
    "seedvr2_ema_7b_fp16.safetensors",
    "seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors",
    "seedvr2_ema_7b_sharp_fp16.safetensors",
)
DEFAULT_DIT = "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors"
DEFAULT_VAE = "ema_vae_fp16.safetensors"

COLOR_CORRECTIONS = ("lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none")

# Shortest-edge targets. SeedVR2's `resolution` input is the SHORT edge and the
# aspect ratio follows the source, so these are the honest names for what the
# model is actually asked for — "2K" here means a 1440-pixel short edge, which
# on 16:9 is 2560x1440.
RESOLUTION_PRESETS = {
    "720p": 720,
    "1080p": 1080,
    "1440p": 1440,
    "2k": 1440,
    "4k": 2160,
}

# Three chunk sinks, and the choice is forced by who may read the result rather
# than by taste — see the module docstring.
SINK_FRAMES = "frames"   # PreviewImage -> ComfyUI temp -> gateway reads plaintext
SINK_CLIP = "clip"       # SaveVideo -> harvested and sealed -> browser assembles
SINK_CLOUD = "cloud"     # serverless render -> clip fetched back -> gateway assembles

# The lane name of the hosted serverless rail. Not a ComfyUI lane and never in
# COMFY_LANES: there is no machine to reach, no /object_info to ask, and nothing
# running between renders. It is offered when the hosted service says it is on.
CLOUD_LANE = "cloud"

# What the hosted container carries — the three fp8 checkpoints the studio
# recommends, baked into its image so a cold start loads rather than downloads.
# Kept in step with BAKED_MODELS in packages/gpu-rentals/serverless/modal_app.py
# by a test, because a model listed here that the container does not have would
# be a 16GB download on somebody's credits.
CLOUD_MODELS = (
    "seedvr2_ema_3b_fp8_e4m3fn.safetensors",
    "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors",
    "seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors",
)


def resolve_offload_device(available, requested: str = "", *, device: str = "", cache_models: bool = True) -> str:
    """Where the weights sit between chunks — and the one coupling that bites.

    The node REFUSES `cache_model=True` alongside `offload_device="none"`: a
    cached model has to be cached somewhere. That is easy to miss, because both
    defaults are individually sensible and the failure arrives from the VAE
    loader three minutes into a render.

    Caching matters here more than in a one-shot graph. A chunked render submits
    one prompt per chunk, so without it every chunk reloads 8-16GB of weights,
    and on a long film that reload is most of the wall clock.

    Order: what the caller asked for if the lane has it, then "cpu" (a CUDA box
    frees its VRAM for the decode between chunks), then the compute device
    itself — which on Apple's unified memory is not a copy at all, just "leave
    it where it is", and is why an MPS lane offers no "cpu" option to begin with.
    """
    options = [str(item) for item in (available or [])]
    wanted = str(requested or "").strip()
    if wanted and wanted in options:
        if not (cache_models and wanted == "none"):
            return wanted
    if not cache_models:
        return "none" if "none" in options else (options[0] if options else "none")
    for candidate in ("cpu", str(device or "")):
        if candidate and candidate in options:
            return candidate
    real = [item for item in options if item != "none"]
    return real[0] if real else "none"


def sink_supports_seams(sink: str) -> bool:
    """Whether a dissolve is even possible on this sink.

    It depends on whether both copies of a boundary survive. A sealed chunk
    arrives already trimmed to its body, because nothing downstream of the seal
    can trim it — so a rented render hard-cuts, and the plan should say 0 rather
    than promise a dissolve that will not happen. The other two sinks hand the
    gateway readable frames, lead-in included, so both can dissolve.
    """
    return sink in (SINK_FRAMES, SINK_CLOUD)


def sink_assembles_locally(sink: str) -> bool:
    """Whether the GATEWAY can build the master, or the browser has to.

    The same question as seams, asked about the other end of the render, and
    kept separate because they could come apart: a sink could in principle be
    readable but unsuitable for dissolving. Today they agree, and both answers
    are "everything except the sealed one".
    """
    return sink != SINK_CLIP


MIN_CHUNK_FRAMES = 5
MAX_CHUNK_FRAMES = 2048


class RestoreError(ValueError):
    """A restore request that cannot be planned. Always says which number."""


# --- small option helpers ----------------------------------------------------

def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _clamp_float(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return max(low, min(high, number))


def snap_batch_size(value: Any, default: int = 5) -> int:
    """The nearest legal 4n+1 batch at or below `value` (never 0).

    The default stays at 5 on measured evidence rather than caution. Measured on
    a rented RTX 5090, 105 frames of 640x360 restored to 1280x720, warm weights,
    sdpa, 2026-09-01:

        3B fp8, batch 5    45.4s wall   encode 9.2s   DiT  9.2s   decode 19.9s   14.0 GB
        3B fp8, batch 21   42.3s wall   encode 8.8s   DiT  6.5s   decode 19.9s   21.2 GB
        7B fp8, batch 5    54.4s wall   encode 9.2s   DiT 17.8s   decode 19.9s   14.0 GB

    Batch 21 is 1.41x on the DiT but only 1.07x on the render, because the DiT
    is a minority of it — and it costs 52% more VRAM, which is the difference
    between fitting and not fitting on a smaller card. A bigger batch is a
    steadiness lever, not a speed one, and the studio says so.

    The row that matters most is the last column: the VAE decode is ~19.9s in
    every configuration — same VAE, same frames, same resolution — so it is a
    FIXED 37-44% of a render, larger than the DiT on the 3B. It is the biggest
    single lever in this pipeline and the one an accelerated decode would move.
    See `tensorrt_policy` for why the TensorRT engine does not move it: it
    builds and matches, but it measured 0.98x."""
    raw = _clamp_int(value, default, 1, 121)
    return BATCH_OFFSET + ((raw - BATCH_OFFSET) // BATCH_MODULUS) * BATCH_MODULUS if raw >= BATCH_OFFSET else 1


def resolve_short_edge(value: Any, default: int = 1440) -> int:
    """A preset name or a pixel count, as a short-edge target."""
    if isinstance(value, str):
        key = value.strip().lower()
        if key in RESOLUTION_PRESETS:
            return RESOLUTION_PRESETS[key]
    # Even values only: the model's own step, and an odd edge breaks yuv420p.
    edge = _clamp_int(value, default, 128, 4320)
    return edge - (edge % 2)


def target_dimensions(width: int, height: int, short_edge: int, max_edge: int = 0) -> tuple[int, int]:
    """What the model will actually produce, so the studio can say it up front.

    Mirrors the node's own rule: scale so the SHORT edge hits `short_edge`, then,
    if `max_edge` is set and the long edge overshoots it, scale both down again.
    Rounded to even numbers because every encoder downstream wants them.
    """
    if width <= 0 or height <= 0:
        raise RestoreError("the source clip reported no dimensions")
    scale = short_edge / float(min(width, height))
    out_w, out_h = width * scale, height * scale
    if max_edge and max(out_w, out_h) > max_edge:
        shrink = max_edge / float(max(out_w, out_h))
        out_w, out_h = out_w * shrink, out_h * shrink
    even = lambda v: max(2, int(round(v / 2.0)) * 2)  # noqa: E731
    return even(out_w), even(out_h)


# --- the plan ----------------------------------------------------------------

def restore_plan(*, frames: int, fps: float, width: int, height: int, options: dict[str, Any] | None = None) -> dict[str, Any]:
    """Everything a render is: which frames each chunk covers, and at what size.

    Pure, and deliberately so — the studio runs the same arithmetic before a
    byte is uploaded so it can say "14 chunks, 2560x1440" rather than asking the
    gateway and hoping the two agree.
    """
    options = dict(options or {})
    total = _clamp_int(frames, 0, 0, 10_000_000)
    if total <= 0:
        raise RestoreError("the source clip has no frames to restore")
    rate = _clamp_float(fps, 24.0, 0.1, 480.0)

    batch = snap_batch_size(options.get("batch_size"), 5)
    short_edge = resolve_short_edge(options.get("resolution"), 1440)
    max_edge = _clamp_int(options.get("max_resolution"), 0, 0, 8192)
    out_w, out_h = target_dimensions(width, height, short_edge, max_edge)

    # Chunk length is asked for in SECONDS because that is the unit a person has
    # an opinion about, then snapped to whole batches.
    wanted = _clamp_float(options.get("chunk_seconds"), 4.0, 0.5, 120.0)
    chunk_frames = max(batch, int(round(wanted * rate / batch)) * batch)
    chunk_frames = max(MIN_CHUNK_FRAMES, min(MAX_CHUNK_FRAMES, chunk_frames))

    # One batch of lead-in by default: enough for the model to arrive at the
    # boundary with history, cheap enough not to inflate the render much.
    context = _clamp_int(options.get("context_frames"), batch, 0, 4 * batch)
    context = (context // batch) * batch if batch else 0
    context = min(context, chunk_frames)

    # A dissolve can only span frames that were restored twice.
    seam = min(_clamp_int(options.get("seam_frames"), min(3, context), 0, 32), context)

    preview_frames = _clamp_int(options.get("preview_frames"), 0, 0, MAX_CHUNK_FRAMES)
    # A playhead parked in the last second would otherwise ask for a batch of
    # frames that do not exist; the preview slides back rather than rendering
    # past the end.
    preview_start = _clamp_int(options.get("preview_start_frame"), 0, 0, max(0, total - min(batch, total)))
    if preview_frames:
        # A preview is one chunk, wherever the person parked the playhead: no
        # context (there is nothing before it to be consistent with) and no
        # seams (there is no second chunk to seam against).
        length = max(batch, int(round(preview_frames / batch)) * batch)
        length = max(1, min(length, total - preview_start))
        chunks = [{
            "index": 0,
            "source_start": preview_start,
            "source_length": length,
            "context": 0,
            "output_length": length,
        }]
        context, seam = 0, 0
        chunk_frames = length
    else:
        chunks = []
        for index, start in enumerate(range(0, total, chunk_frames)):
            lead = min(context, start)
            body = min(chunk_frames, total - start)
            chunks.append({
                "index": index,
                # What ffmpeg cuts out of the source for this chunk…
                "source_start": start - lead,
                "source_length": lead + body,
                # …and how much of the restored result is lead-in rather than
                # new footage. The assembler needs both.
                "context": lead,
                "output_length": body,
            })
        # One chunk has no boundary. Reported as 0 rather than left at what was
        # asked for, because the panel shows this number and "3-frame dissolve"
        # on a clip with nothing to dissolve is a promise nothing will keep.
        if len(chunks) < 2:
            seam = 0

    return {
        "version": 1,
        "frames": total,
        "fps": rate,
        "source_width": int(width),
        "source_height": int(height),
        "width": out_w,
        "height": out_h,
        "short_edge": short_edge,
        "max_edge": max_edge,
        "batch_size": batch,
        "chunk_frames": chunk_frames,
        "context_frames": context,
        "seam_frames": seam,
        "model": _dit_model(options.get("model")),
        "vae": DEFAULT_VAE,
        "color_correction": _color_correction(options.get("color_correction")),
        "seed": _clamp_int(options.get("seed"), 42, 0, 2**32 - 1),
        "temporal_overlap": _clamp_int(options.get("temporal_overlap"), 0, 0, 16),
        "preview": bool(preview_frames),
        "chunks": chunks,
    }


def _dit_model(value: Any) -> str:
    name = str(value or "").strip()
    if name in DIT_MODELS:
        return name
    # Accept the short names the studio shows ("7b-sharp-fp16") as well as the
    # full filename, so a saved project keeps working if the UI labels change.
    key = re.sub(r"[^a-z0-9]+", "", name.lower())
    for candidate in DIT_MODELS:
        if re.sub(r"[^a-z0-9]+", "", candidate.lower()).startswith("seedvr2ema" + key):
            return candidate
    return DEFAULT_DIT


def _color_correction(value: Any) -> str:
    name = str(value or "").strip().lower()
    return name if name in COLOR_CORRECTIONS else "lab"


def estimate_seconds(plan: dict[str, Any], *, seconds_per_megapixel_frame: float) -> float:
    """Render time from a measured per-lane rate, or 0 when nothing is measured.

    Deliberately not a constant: the same clip is minutes on a rented Blackwell
    and an evening on a laptop, and a made-up ETA is worse than none. The runner
    stores the real rate after each chunk and this turns it back into an answer.
    """
    rate = _clamp_float(seconds_per_megapixel_frame, 0.0, 0.0, 3600.0)
    if rate <= 0:
        return 0.0
    megapixels = (plan["width"] * plan["height"]) / 1_000_000.0
    frames = sum(chunk["source_length"] for chunk in plan["chunks"])
    return round(frames * megapixels * rate, 1)


# --- the graph ---------------------------------------------------------------

def build_restore_graph(
    *,
    source_name: str,
    plan: dict[str, Any],
    chunk: dict[str, Any],
    sink: str,
    filename_prefix: str = "",
    device: str = "",
    offload_device: str = "",
    attention_mode: str = "sdpa",
    cache_models: bool = True,
    tiled_vae: bool = False,
    tile_size: int = 1024,
    torch_compile: bool = False,
    tensorrt: bool = False,
    tensorrt_may_build: bool = False,
    tensorrt_fp16: bool = True,
) -> dict[str, Any]:
    """One chunk's ComfyUI API graph.

    `source_name` is a file already staged in ComfyUI's input directory holding
    exactly this chunk's frames — cut there rather than here so the graph never
    decodes footage it will not use, and so a rented lane receives only the
    seconds it is about to restore rather than the whole film.

    `device` and `offload_device` are passed in rather than guessed: the same
    graph runs on an Apple lane whose only device is "mps" and on a rented box
    whose devices are "cuda:0"…, and a hard-coded device is the difference
    between a render and a validation error.
    """
    if sink not in (SINK_FRAMES, SINK_CLIP):
        raise RestoreError(f"unknown chunk sink: {sink}")
    if not str(source_name).strip():
        raise RestoreError("the chunk has no staged source file")
    if cache_models and str(offload_device or "none").strip() in ("", "none"):
        # Refused here rather than emitted: the node rejects this pair, and a
        # graph that is going to fail at its VAE loader should not be a job.
        raise RestoreError(
            "caching the models between chunks needs somewhere to keep them — "
            "pick an offload device, or turn caching off"
        )

    dit_inputs: dict[str, Any] = {
        "model": plan["model"],
        "device": device or "",
        "offload_device": offload_device or "none",
        # Cached across chunks on purpose: reloading 8-16GB of weights between
        # chunks would cost more than the chunks. The runner frees the lane
        # when the project finishes.
        "cache_model": bool(cache_models),
        "attention_mode": attention_mode or "sdpa",
    }
    vae_inputs: dict[str, Any] = {
        "model": plan.get("vae") or DEFAULT_VAE,
        "device": device or "",
        # Both loaders, not just the DiT: each keeps its own cache and each
        # refuses cache_model with no offload. The VAE is the smaller model and
        # the easier one to forget, which is exactly why it is written here
        # rather than left to the node's default.
        "offload_device": offload_device or "none",
        "cache_model": bool(cache_models),
        # Tiling is the VRAM lever for the decode, which is where a high-res
        # chunk actually runs out of room. Off by default: it costs time and
        # can leave faint tile edges on flat gradients.
        "encode_tiled": bool(tiled_vae),
        "decode_tiled": bool(tiled_vae),
        "encode_tile_size": int(tile_size),
        "decode_tile_size": int(tile_size),
    }

    graph: dict[str, Any] = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": source_name}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
        "3": {"class_type": "SeedVR2LoadDiTModel", "inputs": dit_inputs},
        "4": {"class_type": "SeedVR2LoadVAEModel", "inputs": vae_inputs},
        "5": {
            "class_type": "SeedVR2VideoUpscaler",
            "inputs": {
                "image": ["2", 0],
                "dit": ["3", 0],
                "vae": ["4", 0],
                "seed": int(plan["seed"]),
                "resolution": int(plan["short_edge"]),
                "max_resolution": int(plan.get("max_edge") or 0),
                "batch_size": int(plan["batch_size"]),
                # Chunk lengths are whole multiples of the batch, so no padding
                # is needed and forcing uniform batches would only add frames.
                "uniform_batch_size": False,
                "color_correction": plan["color_correction"],
                "temporal_overlap": int(plan.get("temporal_overlap") or 0),
                "prepend_frames": 0,
                # Every chunk of one project gets the same seed. Restoration is
                # not a lottery: two chunks denoised from different noise are
                # two slightly different grades meeting at a seam.
                "offload_device": offload_device or "none",
            },
        },
    }

    if tensorrt:
        # Sits between the VAE loader and the upscaler purely to carry a
        # per-job policy: the acceleration itself is a patch on the decode
        # method, so this node changes no tensor and adds no step. It is a node
        # rather than an env var because "may this job spend minutes building an
        # engine" is a decision per RENDER, not per machine — a preview must not
        # pay for an engine it will use exactly once.
        graph["4b"] = {
            "class_type": TENSORRT_NODE_CLASS,
            "inputs": {
                "vae": ["4", 0],
                "enabled": True,
                "build_engine": bool(tensorrt_may_build),
                "fp16": bool(tensorrt_fp16),
            },
        }
        graph["5"]["inputs"]["vae"] = ["4b", 0]

    if torch_compile:
        # DO NOT ENABLE THIS. It is kept only so the option is not silently
        # dropped, and `torch_compile_supported()` refuses it before a caller
        # can reach here — see that function for the measurement.
        graph["6"] = {
            "class_type": "SeedVR2TorchCompileSettings",
            "inputs": {
                "backend": "inductor",
                "mode": "default",
                "fullgraph": False,
                "dynamic": False,
                # REQUIRED, both of them, and omitting them made ComfyUI reject
                # the whole graph with a 400 — measured 2026-08-31, which means
                # the studio's "Compile the model" toggle had never worked.
                # Values are the node's own defaults.
                "dynamo_cache_size_limit": 64,
                "dynamo_recompile_limit": 128,
            },
        }
        graph["3"]["inputs"]["torch_compile_args"] = ["6", 0]
        graph["4"]["inputs"]["torch_compile_args"] = ["6", 0]

    if sink == SINK_FRAMES:
        # Into ComfyUI's TEMP directory, one PNG per frame: lossless out of the
        # model, never swept into an output envelope, and deleted as soon as the
        # gateway has encoded the chunk. The intermediate's quality is then the
        # gateway's choice rather than a fixed h264 default.
        graph["9"] = {"class_type": "PreviewImage", "inputs": {"images": ["5", 0]}}
    else:
        # The lead-in frames are dropped IN THE GRAPH, so the clip that comes
        # back is exactly this chunk's body. A sealed chunk cannot be trimmed
        # afterwards — the gateway cannot read it and the browser's join is a
        # packet copy — so the trim has to happen while the frames are still
        # frames. That also settles why a rented render hard-cuts at its seams:
        # there is no second copy of the boundary left to dissolve with.
        graph["6b"] = {
            "class_type": "ImageFromBatch",
            "inputs": {
                "image": ["5", 0],
                "batch_index": int(chunk["context"]),
                "length": int(chunk["output_length"]),
            },
        }
        graph["7"] = {
            "class_type": "CreateVideo",
            "inputs": {"images": ["6b", 0], "fps": float(plan["fps"]), "bit_depth": 10},
        }
        graph["8"] = {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["7", 0],
                "filename_prefix": filename_prefix or "restore/chunk",
                "format": "mp4",
                "codec": "h264",
            },
        }
    return graph


def graph_needs(graph: dict[str, Any]) -> list[str]:
    """Node classes a lane must have for this graph. Used by the capability
    probe so an unsupported lane is refused by name before a job exists."""
    return sorted({str(node.get("class_type") or "") for node in graph.values() if isinstance(node, dict)})


REQUIRED_NODE_CLASSES = (
    "LoadVideo",
    "GetVideoComponents",
    "SeedVR2LoadDiTModel",
    "SeedVR2LoadVAEModel",
    "SeedVR2VideoUpscaler",
)

# Ours, not upstream's: packages/comfyui-custom-nodes/hivemind-seedvr2-trt.
# Its absence is not a missing feature, it is a lane that runs the decode on
# PyTorch — which is what the node pack does anyway.
TENSORRT_NODE_CLASS = "HivemindSeedVR2TensorRT"


# --- the cloud lane's chunk request ------------------------------------------

def cloud_chunk_request(*, plan: dict[str, Any], chunk: dict[str, Any], project_id: str = "") -> dict[str, Any]:
    """What the hosted service is told about one chunk.

    The serverless container builds the graph at its end — from THIS module,
    copied into its image, so there is exactly one graph builder and the hosted
    rail cannot quietly drift into different pixels. What crosses the wire is
    therefore the settings, not a graph: a caller who could post a graph could
    run anything they liked on somebody else's GPU.

    The size fields are here for a second reason. They are what the render is
    PRICED from, and they are measured by this side rather than probed by the
    service — which means the quote can be shown before a byte is uploaded, and
    a caller who understated them would only under-reserve and be refused.

    Note the frame count: `source_length`, not `output_length`. The container
    returns everything it was given, lead-in included, because the assembler
    needs both copies of a chunk boundary to dissolve the seam.
    """
    return {
        "project_ref": str(project_id or "")[:64],
        "chunk_index": int(chunk["index"]),
        "frames": int(chunk["source_length"]),
        "width": int(plan["width"]),
        "height": int(plan["height"]),
        "source_width": int(plan["source_width"]),
        "source_height": int(plan["source_height"]),
        "model": plan["model"],
        "short_edge": int(plan["short_edge"]),
        "max_edge": int(plan.get("max_edge") or 0),
        "batch_size": int(plan["batch_size"]),
        "color_correction": plan["color_correction"],
        "temporal_overlap": int(plan.get("temporal_overlap") or 0),
        "seed": int(plan["seed"]),
        "fps": float(plan["fps"]),
    }


def cloud_quote_request(plan: dict[str, Any]) -> dict[str, Any]:
    """What a WHOLE render would cost, asked in one round trip.

    One call rather than one per chunk: the studio has to put a number on the
    button while the file is still in the picker, and a 75-chunk film would
    otherwise be 75 requests to find out. Each chunk is still priced on its own
    at the far end, so the total is the sum of the invoices rather than a
    smoother number they would then exceed.
    """
    return {
        "chunk_frames": [int(chunk["source_length"]) for chunk in plan.get("chunks") or []],
        "width": int(plan["width"]),
        "height": int(plan["height"]),
        "source_width": int(plan["source_width"]),
        "source_height": int(plan["source_height"]),
        "model": plan["model"],
    }

# How many chunks a render needs before building an engine is worth it.
#
# Compiling costs minutes of GPU time and happens once per decode shape; the
# engine is then reused by every remaining chunk. A two-chunk render would pay
# the build and barely collect, and on a rented box that is a bill for nothing.
# Four is the point where even a slow build against a modest speedup comes out
# ahead. A preview is one chunk by definition and never builds.
TENSORRT_MIN_CHUNKS_TO_BUILD = 4


def torch_compile_supported() -> tuple[bool, str]:
    """Whether `torch.compile` can be offered on the DiT at all. It cannot.

    MEASURED 2026-08-31 on a rented RTX 5090, four chunks each, one input clip
    per chunk — a real render, not a synthetic loop:

        sdpa            10.56  10.50  10.06  10.44   all four succeed
        sdpa + compile  15.42  CRASH                 TypeError: CompatibleDiT
                                                     does not support len()

    Chunk one is 47% SLOWER because it is compiling, and chunk two dies. The
    crash is upstream's: on the second generation the node re-runs
    `apply_model_specific_config`, its `isinstance(model, CompatibleDiT)` check
    does not see through torch.compile's `OptimizedModule`, so it wraps the
    already-compiled model again and something in that path calls `len()` on it.

    A fresh process per chunk would avoid the crash and recompile every time,
    which is the 15.42s column. So there is no arrangement in which a chunked
    render benefits: the warm case the feature exists for is unreachable here.

    Re-test it when the node pack is updated. If upstream's check learns to see
    through the compile wrapper, this becomes a real question again and the
    answer is one benchmark away.
    """
    return False, (
        "Compiling the model is disabled: measured on an RTX 5090 it makes the first "
        "chunk 47% slower and the second chunk crashes the render "
        "(CompatibleDiT does not support len()). PyTorch runs the DiT at full speed."
    )


def tensorrt_policy(plan: dict[str, Any], capability: dict[str, Any] | None, *, requested: bool = True) -> dict[str, Any]:
    """Whether this render uses TensorRT, whether it may build, and why not.

    Pure, so the reason the studio shows is the same reason the graph acted on.
    Kept out of the runner because "why is my render not accelerated" is a
    question with five different answers and every one of them is actionable or
    explicitly not.
    """
    trt = dict((capability or {}).get("tensorrt") or {})
    if not requested:
        return {"enabled": False, "may_build": False, "reason": "TensorRT is switched off for this render"}
    if not trt.get("available"):
        return {
            "enabled": False,
            "may_build": False,
            "reason": trt.get("reason") or "this machine cannot run TensorRT",
        }
    chunks = len(plan.get("chunks") or [])
    if plan.get("preview"):
        return {
            "enabled": True,
            "may_build": False,
            # Enabled but not building: an engine already cached from a full
            # render of the same shape still gets used, which is the common case
            # when someone previews a change mid-project.
            "reason": "a preview uses an engine if one is already built, but will not spend minutes building one",
        }
    if chunks < TENSORRT_MIN_CHUNKS_TO_BUILD:
        return {
            "enabled": True,
            "may_build": False,
            "reason": (
                f"this render is only {chunks} chunk{'' if chunks == 1 else 's'} — too short for building "
                "an engine to pay for itself"
            ),
        }
    return {
        "enabled": True,
        "may_build": True,
        "reason": "TensorRT VAE decode, built on the first chunk and reused by the rest",
    }


# --- assembly ----------------------------------------------------------------

def assembly_steps(plan: dict[str, Any]) -> list[dict[str, Any]]:
    """How to turn finished chunk files into one master, frame-exactly.

    Returns an ordered list of segments. Two kinds:

      {"kind": "trim",  "chunk": i, "start": a, "length": n}
      {"kind": "blend", "chunk": i, "start": a, "next_chunk": i+1,
       "next_start": b, "length": n}

    A "trim" is footage only one chunk restored. A "blend" is the overlap both
    chunks restored, cross-dissolved from the first to the second. The lengths
    sum to exactly `plan["frames"]`, which the tests assert: a master that is
    even one frame short of the source desyncs the remuxed audio, and that is
    the failure most likely to survive a casual look at the result.
    """
    chunks = plan.get("chunks") or []
    if not chunks:
        return []
    seam = int(plan.get("seam_frames") or 0)
    steps: list[dict[str, Any]] = []
    for position, chunk in enumerate(chunks):
        index = int(chunk["index"])
        context = int(chunk["context"])
        body = int(chunk["output_length"])
        following = chunks[position + 1] if position + 1 < len(chunks) else None
        # How much of THIS chunk's tail the next chunk also restored, and is
        # therefore available to dissolve into.
        overlap = min(seam, int(following["context"])) if following else 0
        overlap = min(overlap, body)
        if body - overlap > 0:
            steps.append({
                "kind": "trim",
                "chunk": index,
                "start": context,
                "length": body - overlap,
            })
        if overlap > 0:
            steps.append({
                "kind": "blend",
                "chunk": index,
                "start": context + body - overlap,
                "next_chunk": int(following["index"]),
                # The next chunk's context ends where its body begins, so the
                # matching frames are the LAST `overlap` of its lead-in.
                "next_start": int(following["context"]) - overlap,
                "length": overlap,
            })
    return steps


def assembled_frame_count(plan: dict[str, Any]) -> int:
    return sum(int(step["length"]) for step in assembly_steps(plan))


# Trimming alone is not enough to line two chunks up.
#
# MEASURED 2026-08-31 on the local MPS lane: a 3-frame dissolve came out 4
# frames long, and a 24-frame master came out 26. Matroska stores timestamps in
# milliseconds, so at 24fps frame 7 lands on 292ms and frame 2 lands on 83ms;
# after `setpts=PTS-STARTPTS` the two trimmed streams read 0,41,83 and 0,42,84.
# blend's framesync then sees five distinct timestamps rather than three pairs
# and invents frames to cover them.
#
# So every segment's timestamps are REBUILT from the frame index on one shared
# timebase before anything is blended or concatenated. It is one filter, and
# without it the master is quietly the wrong length — which the audio remux
# then makes audible.
TIMEBASE_NORMALIZER = "settb=AVTB,setpts=N/(FRAME_RATE*TB)"


def trim_filter(start: int, length: int) -> str:
    """One chunk's frames [start, start+length), on a normalised timebase."""
    return f"trim=start_frame={int(start)}:end_frame={int(start) + int(length)},{TIMEBASE_NORMALIZER}"


def blend_filter_complex(step: dict[str, Any]) -> str:
    """The filter_complex that dissolves one seam between two chunk files."""
    length = int(step["length"])
    return (
        f"[0:v]{trim_filter(step['start'], length)}[a];"
        f"[1:v]{trim_filter(step['next_start'], length)}[b];"
        f"[a][b]blend=all_expr='{blend_expression(length)}'[v]"
    )


def blend_expression(length: int) -> str:
    """A linear dissolve across `length` frames, as an ffmpeg blend expression.

    N is the frame index within the segment. The first frame is all A and the
    last is all B, so consecutive segments meet without a repeated frame.
    """
    span = max(1, int(length) - 1)
    return f"A*(1-N/{span})+B*(N/{span})"


# --- finishing ---------------------------------------------------------------

FINISH_DEFAULTS = {
    "sharpen": 0.0,
    "grain": 0.0,
    "skin_softening": 0.0,
    "aspect": "source",
    "quality": 16,
}

ASPECT_POLICIES = ("source", "pad", "crop")


def finishing_filters(options: dict[str, Any] | None, *, width: int, height: int) -> list[str]:
    """The ffmpeg filter chain for a finishing pass. Empty when nothing is asked.

    Order is deliberate and is the order a colourist would use: fit the frame,
    sharpen the edges, calm the flat areas the sharpening just made noisy, then
    lay grain over the finished picture rather than under it.
    """
    options = dict(options or {})
    filters: list[str] = []

    aspect = str(options.get("aspect") or "source").strip().lower()
    ratio = _aspect_ratio(options.get("aspect_ratio"))
    if aspect in ("pad", "crop") and ratio:
        target_w, target_h = _fit_box(width, height, ratio)
        if aspect == "pad":
            # Bars, never a stretch: the restored pixels keep their geometry.
            filters.append(f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease")
            filters.append(f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black")
        else:
            filters.append(f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase")
            filters.append(f"crop={target_w}:{target_h}")

    sharpen = _clamp_float(options.get("sharpen"), 0.0, 0.0, 1.0)
    if sharpen > 0:
        # Modest by design. SeedVR2 already resolves detail; an aggressive
        # unsharp on top of it produces the halo the restore just removed.
        filters.append(f"unsharp=5:5:{round(sharpen * 0.9, 3)}:5:5:0.0")

    skin = _clamp_float(options.get("skin_softening"), 0.0, 0.0, 1.0)
    if skin > 0:
        # smartblur with a NEGATIVE luma threshold blurs flat areas and leaves
        # edges alone — skin texture and sensor grain go, eyelashes stay. It is
        # not face-aware, which is why the studio calls it "soften flat detail"
        # rather than promising it only touches faces.
        filters.append(f"smartblur=lr=2.0:ls={round(skin * 0.8, 3)}:lt=-20:cr=1.0:cs=0.2:ct=-12")

    grain = _clamp_float(options.get("grain"), 0.0, 0.0, 1.0)
    if grain > 0:
        # Temporal so it moves; without allf=t it is a fixed dirt pattern.
        filters.append(f"noise=alls={max(1, int(round(grain * 20)))}:allf=t+u")

    return filters


def _aspect_ratio(value: Any) -> float:
    text = str(value or "").strip()
    if not text:
        return 0.0
    match = re.match(r"^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$", text)
    if match:
        width, height = float(match.group(1)), float(match.group(2))
        return width / height if height else 0.0
    try:
        ratio = float(text)
    except ValueError:
        return 0.0
    return ratio if 0.1 <= ratio <= 10 else 0.0


def _fit_box(width: int, height: int, ratio: float) -> tuple[int, int]:
    """The largest even-sided box of `ratio` that keeps the restored resolution.

    The box FITS INSIDE the restored frame, so a reframe never asks for pixels
    the model did not make: padding adds bars, cropping removes footage, and
    neither upscales. A wider target is limited by the restored width, a taller
    one by its height.
    """
    if ratio >= width / float(height):
        out_w = width
        out_h = out_w / ratio
    else:
        out_h = height
        out_w = out_h * ratio
    even = lambda v: max(2, int(round(v / 2.0)) * 2)  # noqa: E731
    return even(out_w), even(out_h)


def master_encode_args(options: dict[str, Any] | None) -> list[str]:
    """Encoder settings for the finished master.

    CRF rather than a bitrate: the point of a restoration is that the picture
    decides how many bits it needs.
    """
    options = dict(options or {})
    crf = _clamp_int(options.get("quality"), FINISH_DEFAULTS["quality"], 8, 30)
    return [
        "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ]


# --- the project manifest ----------------------------------------------------

def new_project(*, project_id: str, source: dict[str, Any], plan: dict[str, Any], options: dict[str, Any], lane: str, sink: str) -> dict[str, Any]:
    return {
        "version": 1,
        "id": project_id,
        "created_at": "",
        "updated_at": "",
        "status": "queued",
        "lane": lane,
        "sink": sink,
        "source": dict(source),
        "options": dict(options),
        "plan": plan,
        # index -> {"file"|"output", "frames", "elapsed_seconds"}
        "chunks": {},
        "master": "",
        "error": "",
        "log": [],
    }


def first_unfinished_chunk(project: dict[str, Any]) -> int:
    """Where a resume starts. -1 when every chunk is already on disk."""
    done = project.get("chunks") or {}
    for chunk in project.get("plan", {}).get("chunks") or []:
        if str(chunk["index"]) not in done:
            return int(chunk["index"])
    return -1


def project_progress(project: dict[str, Any]) -> dict[str, Any]:
    chunks = project.get("plan", {}).get("chunks") or []
    done = len(project.get("chunks") or {})
    elapsed = [
        float(entry.get("elapsed_seconds") or 0)
        for entry in (project.get("chunks") or {}).values()
        if entry.get("elapsed_seconds")
    ]
    per_chunk = sum(elapsed) / len(elapsed) if elapsed else 0.0
    return {
        "chunks_total": len(chunks),
        "chunks_done": done,
        "fraction": round(done / len(chunks), 4) if chunks else 0.0,
        "seconds_per_chunk": round(per_chunk, 1),
        # Only ever an extrapolation from THIS project's own measured chunks.
        "eta_seconds": round(per_chunk * max(0, len(chunks) - done), 1) if per_chunk else 0,
    }


def read_project(path: Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_project(path: Path, project: dict[str, Any]) -> None:
    """Written through a temp file: the manifest IS the checkpoint, and a
    half-written one after a crash would lose every finished chunk with it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(path.name + ".writing")
    staged.write_text(json.dumps(project, indent=2), encoding="utf-8")
    staged.replace(path)
