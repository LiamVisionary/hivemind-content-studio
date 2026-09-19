"""The serverless worker behind the studio's pay-per-render restoration lane.

WHAT THIS IS. The errand that restores exactly ONE chunk of footage and hands
it back, run on a Modal GPU container (see modal_app.py, which owns the image,
the GPU and the web doors). It is woken by the restore-gateway worker
(hivemind-cloud-services/workers/restore-gateway), which has already quoted the
chunk, reserved the credits and put the source in R2; this end knows nothing
about money and never sees a credit token.

WHY THIS EXISTS BESIDE THE RENTED LANE. Renting a box by the hour is the right
deal for an afternoon of restoration and a poor one for a single clip: an hour's
minimum, provisioning time, and the box sitting there until somebody remembers
to destroy it. This is the other shape — nothing running, a chunk arrives, a
worker wakes, and it scales back to zero afterwards. The cost of that is a cold
start on the first chunk of a quiet period, which the gateway's price floor is
sized to absorb.

THE ONE DESIGN RULE HERE: THERE IS ONLY ONE GRAPH BUILDER. This handler imports
the studio's own ``video_restore.build_restore_graph`` — the same function the
local lane and the rented lane submit — rather than reimplementing it. A second
copy would drift, and a drifted copy means the hosted rail quietly produces
different pixels from the free one for the same settings. modal_app.py copies
that module into the image beside this file;
``test/studio/test_serverless_restore_handler.py`` asserts the graph really is
the local one.

It also means this container is, in every respect that matters, a local lane:
frames come back through ComfyUI's temp directory as PNGs and are encoded here.
It returns EVERY frame it was given, lead-in included — the studio's assembler
needs both copies of a chunk boundary to dissolve the seam, and a container that
helpfully trimmed would silently turn every hosted render into hard cuts.

WHAT IT RETURNS. Not the clip. The bytes are PUT straight to the URL the gateway
supplied, and the job's own result is a receipt: ``{"uploaded": true, ...}``.
A job result travels through the platform's result store and a restored chunk
is tens of megabytes; the receipt is a few bytes.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import video_restore

COMFY_URL = os.environ.get("HIVEMIND_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_ROOT = Path(os.environ.get("HIVEMIND_COMFY_ROOT", "/comfyui"))
COMFY_INPUT_DIR = Path(os.environ.get("HIVEMIND_COMFY_INPUT", COMFY_ROOT / "input"))
COMFY_TEMP_DIR = Path(os.environ.get("HIVEMIND_COMFY_TEMP", COMFY_ROOT / "temp"))
WORK_DIR = Path(os.environ.get("HIVEMIND_WORK_DIR", "/tmp/hivemind-restore"))

# A chunk is seconds of video, not hours. Past this something is wrong with the
# job rather than slow about it, and a serverless worker that hangs is billed
# for every second of the hang.
CHUNK_TIMEOUT_SECONDS = float(os.environ.get("HIVEMIND_CHUNK_TIMEOUT", "1800"))
COMFY_BOOT_TIMEOUT_SECONDS = 300.0
DOWNLOAD_TIMEOUT_SECONDS = 600.0
UPLOAD_TIMEOUT_SECONDS = 900.0
# Load-bearing, not politeness: Cloudflare answers 403 to urllib's default
# `Python-urllib/*` in front of the restore gateway this container fetches from
# and uploads to — measured 2026-09-01. Without it every job fails at the first
# byte, and it fails in a way that looks like the gateway being down.
USER_AGENT = "HivemindRestoreWorker/1.0 (+https://hivemindos.com)"


class ChunkError(RuntimeError):
    """Something this job cannot do. The message reaches the gateway, which
    refunds the whole reservation — so it should say what went wrong."""


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def chunk_plan(job_input: dict[str, Any]) -> dict[str, Any]:
    """The subset of a render plan one chunk needs, from the job's own fields.

    Deliberately NOT ``video_restore.restore_plan``: that function decides how a
    whole clip is cut into chunks, and that decision was already made by the
    studio before it uploaded this one. Re-planning here would be a second
    opinion about a settled question, and the two could disagree.
    """
    model = str(job_input.get("model") or "")
    colour = str(job_input.get("color_correction") or "")
    return {
        # Checked against the module's own registries rather than trusted. The
        # gateway sends full filenames, so this is a guard and not a parser: an
        # unknown model here means the two ends disagree, and defaulting is a
        # better answer than a validation error the caller cannot read.
        "model": model if model in video_restore.DIT_MODELS else video_restore.DEFAULT_DIT,
        "vae": video_restore.DEFAULT_VAE,
        "seed": max(0, int(job_input.get("seed") or 0)),
        "short_edge": _positive_int(job_input.get("resolution"), 1440),
        "max_edge": max(0, int(job_input.get("max_edge") or 0)),
        "batch_size": video_restore.snap_batch_size(job_input.get("batch_size"), 5),
        "color_correction": colour if colour in video_restore.COLOR_CORRECTIONS else "lab",
        "temporal_overlap": max(0, int(job_input.get("temporal_overlap") or 0)),
        "fps": float(job_input.get("fps") or 24.0),
    }


def chunk_graph(job_input: dict[str, Any], *, source_name: str) -> dict[str, Any]:
    """This chunk's ComfyUI graph — the studio's own, not a copy of it.

    The frames sink, because this container CAN read what it produced: the PNGs
    land in ComfyUI's temp directory and are encoded here. That is the same sink
    a local lane uses, and it is why a hosted render can dissolve its seams
    while a rented one (whose chunks are sealed on arrival) cannot.
    """
    plan = chunk_plan(job_input)
    frames = _positive_int(job_input.get("frames"), 0)
    if not frames:
        raise ChunkError("this job did not say how many frames the chunk has")
    chunk = {"index": 0, "source_start": 0, "source_length": frames, "context": 0, "output_length": frames}
    device = os.environ.get("HIVEMIND_RESTORE_DEVICE", "cuda:0")
    return video_restore.build_restore_graph(
        source_name=source_name,
        plan=plan,
        chunk=chunk,
        sink=video_restore.SINK_FRAMES,
        device=device,
        # Kept on the GPU between jobs, which is the entire point of a warm
        # serverless worker: the chunk after this one arrives seconds later and
        # must not reload 8-16GB of weights. "cpu" rather than the device
        # itself because this is CUDA, where freeing VRAM for the decode is
        # worth the copy.
        offload_device=os.environ.get("HIVEMIND_RESTORE_OFFLOAD", "cpu"),
        attention_mode=os.environ.get("HIVEMIND_RESTORE_ATTENTION", "sdpa"),
        cache_models=True,
        tiled_vae=str(job_input.get("tiled_vae") or "").lower() in ("1", "true", "yes"),
        tile_size=_positive_int(job_input.get("tile_size"), 1024),
        # Both refused rather than exposed. torch.compile makes the first chunk
        # slower and crashes the second; the TensorRT VAE measured 0.98x on a
        # 5090 and is not shipped. Neither is a knob a paying caller should be
        # able to turn on our GPU.
        torch_compile=False,
        tensorrt=False,
    )


# --- the errand --------------------------------------------------------------

def _download(url: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with destination.open("wb") as handle:
                shutil.copyfileobj(response, handle, length=1024 * 1024)
    except Exception as exc:
        raise ChunkError(f"the source chunk could not be fetched ({type(exc).__name__})") from None
    if not destination.is_file() or destination.stat().st_size < 512:
        raise ChunkError("the source chunk arrived empty")
    return destination


def _upload(url: str, source: Path) -> int:
    size = source.stat().st_size
    with source.open("rb") as handle:
        request = urllib.request.Request(
            url,
            data=handle,
            method="PUT",
            headers={"Content-Type": "video/mp4", "Content-Length": str(size), "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(request, timeout=UPLOAD_TIMEOUT_SECONDS) as response:
                response.read()
        except Exception as exc:
            raise ChunkError(f"the restored chunk could not be delivered ({type(exc).__name__})") from None
    return size


def _wait_for_comfy(deadline: float) -> None:
    """A cold worker's ComfyUI is still coming up when the first job lands."""
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/system_stats", timeout=5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(2)
    raise ChunkError("the renderer did not come up in time")


def _submit(graph: dict[str, Any]) -> str:
    body = json.dumps({"prompt": graph, "client_id": f"hivemind-serverless-{uuid.uuid4().hex[:8]}"}).encode()
    request = urllib.request.Request(
        f"{COMFY_URL}/prompt", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            queued = json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:
        detail = getattr(exc, "read", lambda: b"")()
        raise ChunkError(f"the renderer refused this chunk: {detail[:600].decode('utf-8', 'replace')}") from None
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        raise ChunkError("the renderer accepted nothing")
    return str(prompt_id)


def _await_frames(prompt_id: str, deadline: float) -> list[Path]:
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            with urllib.request.urlopen(f"{COMFY_URL}/history/{prompt_id}", timeout=15) as response:
                data = json.loads(response.read().decode("utf-8") or "{}")
        except Exception:
            continue
        if prompt_id not in data:
            continue
        history = data[prompt_id]
        status = history.get("status") or {}
        if status.get("status_str") != "success" or not status.get("completed"):
            raise ChunkError(f"the renderer could not restore this chunk: {json.dumps(status)[:600]}")
        # Batch order, not filename order: the history lists frames in the order
        # the node emitted them and PreviewImage's names are random per run.
        frames: list[Path] = []
        for node_out in (history.get("outputs") or {}).values():
            for image in node_out.get("images") or []:
                candidate = COMFY_TEMP_DIR / (image.get("subfolder") or "") / (image.get("filename") or "")
                if candidate.is_file():
                    frames.append(candidate)
        if not frames:
            raise ChunkError("the renderer finished but produced no frames")
        return frames
    raise ChunkError("this chunk timed out")


def _encode(frames: list[Path], destination: Path, *, fps: float) -> Path:
    """Near-lossless, and the studio is told so.

    The local lane keeps its intermediates in FFV1, mathematically lossless,
    because they never leave the disk they were written on. An FFV1 chunk of
    1440p footage is about 80MB for four seconds; the same chunk at CRF 12 in
    10-bit is under ten, and this one has to cross the internet twice. That is
    the trade, it is real, and the studio's panel names it rather than implying
    the two rails produce identical files.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    listing = destination.parent / f"{destination.stem}.frames.txt"
    listing.write_text(
        "".join(f"file '{str(path).replace(chr(39), chr(39) * 3)}'\n" for path in frames), encoding="utf-8")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-r", f"{float(fps):.6f}",
                "-f", "concat", "-safe", "0", "-i", str(listing),
                "-c:v", "libx264", "-preset", "medium", "-crf", "12",
                "-pix_fmt", "yuv420p10le", "-profile:v", "high10",
                # Every frame a key frame would double the size for no benefit
                # here; the studio re-cuts from this file with ffmpeg, which
                # seeks by decoding.
                "-g", "24",
                str(destination),
            ],
            check=True, capture_output=True, timeout=1800,
        )
    except subprocess.CalledProcessError as exc:
        raise ChunkError(f"the restored chunk could not be encoded: {exc.stderr[-400:].decode('utf-8', 'replace')}") from None
    finally:
        listing.unlink(missing_ok=True)
    if not destination.is_file() or destination.stat().st_size < 512:
        raise ChunkError("the restored chunk came out empty")
    return destination


def restore_one_chunk(job_input: dict[str, Any]) -> dict[str, Any]:
    """Fetch, restore, encode, deliver. The whole errand."""
    source_url = str(job_input.get("source_url") or "").strip()
    upload_url = str(job_input.get("upload_url") or "").strip()
    if not source_url or not upload_url:
        raise ChunkError("this job carried no source or no destination")

    started = time.monotonic()
    _wait_for_comfy(started + COMFY_BOOT_TIMEOUT_SECONDS)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    source_name = f"hivemind-chunk-{uuid.uuid4().hex[:12]}.mp4"
    staged = COMFY_INPUT_DIR / source_name
    restored = WORK_DIR / f"{staged.stem}-out.mp4"
    frames: list[Path] = []
    try:
        _download(source_url, staged)
        graph = chunk_graph(job_input, source_name=source_name)
        prompt_id = _submit(graph)
        frames = _await_frames(prompt_id, started + CHUNK_TIMEOUT_SECONDS)
        _encode(frames, restored, fps=float(job_input.get("fps") or 24.0))
        bytes_sent = _upload(upload_url, restored)
        return {
            "uploaded": True,
            "frames": len(frames),
            "bytes": bytes_sent,
            "seconds": round(time.monotonic() - started, 2),
        }
    finally:
        # Nothing survives the job. A serverless worker is reused by the NEXT
        # caller, and one caller's footage sitting in the input directory when
        # somebody else's job starts is the whole disclosure risk of this design.
        staged.unlink(missing_ok=True)
        restored.unlink(missing_ok=True)
        for frame in frames:
            try:
                frame.unlink(missing_ok=True)
            except OSError:
                pass


def handler(job: dict[str, Any]) -> dict[str, Any]:
    """The entry point modal_app.py calls, with ``{"input": {...}}``.

    A failure is returned as data rather than raised, with ``uploaded: false``,
    because the gateway reads that field to decide whether anything was
    delivered — and a chunk nobody received is refunded in full.
    """
    try:
        return restore_one_chunk(dict(job.get("input") or {}))
    except ChunkError as exc:
        return {"uploaded": False, "error": str(exc)}
    except Exception as exc:  # pragma: no cover - the backstop, not the path
        return {"uploaded": False, "error": f"the restoration failed ({type(exc).__name__})"}
