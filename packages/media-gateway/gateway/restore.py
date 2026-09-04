"""SeedVR2 video restoration: chunking, per-chunk lane or cloud dispatch,
assembly, retention and the project store."""
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import uuid
import shutil
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from gateway import config, history as _history, jobs, lanes, media, net, promptroutes, runners, util


# --- SeedVR2 video restoration ----------------------------------------------
#
# The long-render half of packages/media-gateway/video_restore.py: staging,
# chunk submission, resume, assembly and finishing. The arithmetic lives there
# and is unit-tested without a GPU; what lives here is everything that touches
# a lane, a disk or ffmpeg.
#
# WHERE THE FILES GO, and why not in the output directory: a restore project is
# working state, not a result. Its staged source, its per-chunk cuts and its
# restored chunk intermediates sit in the gateway's private state directory,
# which the output-encryption sweeper does not walk — so an intermediate is
# never sealed out from under the assembler mid-render. Exactly one file leaves
# the project directory: the finished master, written into the normal output
# directory and sealed by the normal path, so it lands in History like any
# other clip.

RESTORE_ROOT = config.GATEWAY_STATE_DIR / "restore"
# Projects are the point of the feature (reopen last week's render) but they are
# also multi-gigabyte, so old ones are reaped rather than kept forever.
RESTORE_PROJECT_TTL_DAYS = int(os.environ.get("ZIMG_RESTORE_PROJECT_TTL_DAYS", "30"))
# The source arrives on /api/restore/upload as a RAW body written to disk a
# block at a time, so this is a disk ceiling rather than a memory one: nothing
# in this process, or in the control API in front of it, ever holds the clip.
# It used to arrive as base64 inside a JSON body, which meant three full copies
# of a multi-hundred-megabyte file — and a browser that refused to build the
# string at all somewhere north of 384MB, on exactly the footage people rent a
# GPU to restore. The number is advertised in /api/restore/capabilities so the
# studio can say it BEFORE the upload rather than after it.
RESTORE_MAX_SOURCE_BYTES = int(os.environ.get(
    "ZIMG_RESTORE_MAX_SOURCE_BYTES", str(4 * 1024 * 1024 * 1024)))
# Staged sources that no project ever claimed. A picked-then-abandoned clip is
# not working state anybody will come back to, and it is gigabytes.
RESTORE_UPLOAD_ROOT = RESTORE_ROOT / "uploads"
RESTORE_UPLOAD_TTL_HOURS = int(os.environ.get("ZIMG_RESTORE_UPLOAD_TTL_HOURS", "24"))
# What the streaming reader pulls off the socket at a time. Big enough that a
# gigabyte is a few thousand reads, small enough that memory is flat.
RESTORE_UPLOAD_BLOCK_BYTES = 4 * 1024 * 1024
# One chunk of a 4K render is minutes of diffusion on a laptop; the cap is
# generous because the failure it guards against is a hung lane, not a slow one.
RESTORE_CHUNK_TIMEOUT_SECONDS = int(os.environ.get("ZIMG_RESTORE_CHUNK_TIMEOUT", "5400"))

restore_cancel_flags = set()
restore_cancel_lock = threading.Lock()

# The owner's HivemindOS credit token, for the life of ONE hosted render.
#
# In memory and nowhere else: not in the project manifest, not in a job record,
# not in a log. This process cannot read the owner's account itself — the token
# lives in the control API's encrypted store — so it is handed over on the start
# request that asks for the hosted lane and forgotten when the render ends. A
# resume asks for it again and gets it for free, because a resume is a fresh
# start request through the same proxy. If the gateway restarts mid-render the
# render has stopped anyway, so there is nothing here worth persisting.
restore_credit_tokens = {}
restore_credit_lock = threading.Lock()


def remember_restore_credit_token(project_id, token):
    if not token:
        return
    with restore_credit_lock:
        restore_credit_tokens[str(project_id)] = str(token)


def _restore_credit_token(project_id):
    with restore_credit_lock:
        return restore_credit_tokens.get(str(project_id), "")


def forget_restore_credit_token(project_id):
    with restore_credit_lock:
        restore_credit_tokens.pop(str(project_id), None)


class RestoreCancelled(RuntimeError):
    """The owner stopped the project. Finished chunks stay on disk."""


class RestoreTooLarge(ValueError):
    """The source is past this machine's ceiling — said with both numbers.

    Its own class because the answer is a 413 with advice ("trim it, or raise
    the ceiling"), not the 400 every other bad body gets.
    """

    def __init__(self, size_bytes, max_bytes):
        megabyte = 1024 * 1024
        self.size_bytes = int(size_bytes)
        self.max_bytes = int(max_bytes)
        super().__init__(
            f"that clip is {self.size_bytes // megabyte}MB and this machine takes up to "
            f"{self.max_bytes // megabyte}MB — trim it, or restore it in two halves"
        )


def restore_project_dir(project_id):
    name = util.safe_name(str(project_id))
    # `uploads` is the staging directory beside the projects, so a project by
    # that name would have its delete route rmtree everybody's staged sources.
    if name == RESTORE_UPLOAD_ROOT.name:
        raise ValueError("bad restore project id")
    directory = (RESTORE_ROOT / name).resolve()
    if not util._is_under(directory, RESTORE_ROOT.resolve()):
        raise ValueError("bad restore project id")
    return directory


def restore_manifest_path(project_id):
    return restore_project_dir(project_id) / "project.json"


def request_restore_cancel(project_id):
    with restore_cancel_lock:
        restore_cancel_flags.add(str(project_id))


def _restore_cancelled(project_id):
    with restore_cancel_lock:
        return str(project_id) in restore_cancel_flags


def _clear_restore_cancel(project_id):
    with restore_cancel_lock:
        restore_cancel_flags.discard(str(project_id))


def restore_upload_path(source_id):
    """Where a streamed source landed, for the start request that claims it.

    Always `.mp4` regardless of what the container really is: the runner moves
    this file to `source.mp4` a moment later anyway, and ffmpeg reads the bytes
    rather than the name. One name means one path to validate.
    """
    name = util.safe_name(str(source_id or ""))
    if not name:
        raise ValueError("that upload id is not one this machine issued")
    candidate = (RESTORE_UPLOAD_ROOT / f"{name}.mp4").resolve()
    if not util._is_under(candidate, RESTORE_UPLOAD_ROOT.resolve()):
        raise ValueError("that upload id is not one this machine issued")
    return candidate


def reap_restore_uploads(ttl_hours=None):
    """Drop staged sources no start request ever claimed.

    A clip picked and then abandoned is gigabytes of nothing. Anything a project
    took has already been MOVED out of this directory by the runner, so age is
    the only test needed.
    """
    ttl = RESTORE_UPLOAD_TTL_HOURS if ttl_hours is None else int(ttl_hours)
    if ttl <= 0 or not RESTORE_UPLOAD_ROOT.exists():
        return 0
    cutoff = time.time() - ttl * 3600
    removed = 0
    for candidate in list(RESTORE_UPLOAD_ROOT.glob("*")):
        try:
            if not candidate.is_file() or candidate.stat().st_mtime > cutoff:
                continue
            candidate.unlink()
            removed += 1
        except OSError:
            continue
    return removed


def _claim_restore_source(data):
    """The staged clip a start (or finish) request is pointing at, or None.

    Two transports, and only one of them is the good one. `source_id` names a
    file already streamed to disk by /api/restore/upload — nothing is copied,
    and it is how anything larger than a phone clip gets here. `video_base64`
    is the old inline body, kept because the MCP and older clients still send
    it for small clips; the studio no longer does.
    """
    source_id = str((data or {}).get("source_id") or "").strip()
    if source_id:
        staged = restore_upload_path(source_id)
        if not staged.is_file():
            raise ValueError(
                "that upload is no longer on this machine — pick the clip again and restart"
            )
        return staged
    return runners.stage_inline_video_base64((data or {}).get("video_base64"), RESTORE_MAX_SOURCE_BYTES)


def restore_retention():
    """How long the two kinds of working file are kept, for the studio to say.

    The reaper's behaviour is right — a restore project is gigabytes of
    intermediates — but it used to be announced only in the service log, so a
    project that aged out simply vanished. Saying the number on the card is the
    difference between a policy and a disappearance.
    """
    return {
        "project_ttl_days": RESTORE_PROJECT_TTL_DAYS,
        "upload_ttl_hours": RESTORE_UPLOAD_TTL_HOURS,
        "max_source_bytes": RESTORE_MAX_SOURCE_BYTES,
    }


def probe_restore_source(path):
    """Frames, rate, size and whether there is a soundtrack to carry over.

    nb_frames is missing or a lie in plenty of containers, so the count is
    derived from duration x rate when the container will not say — a plan built
    on a wrong frame count silently truncates the last chunk.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is required to read the source clip")
    payload = subprocess.check_output(
        [
            ffprobe, "-v", "error", "-show_entries",
            "stream=codec_type,width,height,r_frame_rate,nb_frames,duration:format=duration",
            "-of", "json", str(path),
        ],
        text=True, stderr=subprocess.DEVNULL, timeout=60,
    )
    parsed = json.loads(payload or "{}")
    streams = parsed.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError("that file has no video track to restore")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rate_text = str(video.get("r_frame_rate") or "0/1")
    try:
        numerator, _, denominator = rate_text.partition("/")
        fps = float(numerator) / float(denominator or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        fps = 0.0
    if fps <= 0:
        fps = 24.0
    duration = 0.0
    for candidate in (video.get("duration"), (parsed.get("format") or {}).get("duration")):
        try:
            duration = float(candidate)
            break
        except (TypeError, ValueError):
            continue
    frames = 0
    try:
        frames = int(video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frames = 0
    if frames <= 0:
        frames = int(round(duration * fps))
    if frames <= 0:
        raise RuntimeError("could not work out how many frames that clip has")
    return {
        "width": width,
        "height": height,
        "fps": round(fps, 6),
        "frames": frames,
        "duration": round(duration or frames / fps, 3),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }


def _ffmpeg_or_raise():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for video restoration")
    return ffmpeg


def _run_ffmpeg(args, *, timeout=1800, what="ffmpeg"):
    proc = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{what} failed: {detail[-1200:]}")
    return proc


def cut_restore_chunk(source, destination, *, start_frame, length, fps):
    """Cut one chunk out of the source, re-encoded so its first frame is a key
    frame. A stream copy would start on the preceding key frame instead, and the
    model would restore frames the plan does not think this chunk covers."""
    ffmpeg = _ffmpeg_or_raise()
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            ffmpeg, "-y", "-v", "error",
            # Seeking by time before -i is the fast path; the trim filter then
            # takes exactly the frames asked for regardless of where the seek
            # actually landed.
            "-ss", f"{max(0, start_frame) / float(fps):.6f}",
            "-i", str(source),
            "-frames:v", str(int(length)),
            "-an", "-sn", "-dn",
            # Visually lossless intermediate: this clip is the model's INPUT,
            # and compression the restorer then has to undo is a self-inflicted
            # wound.
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "10",
            "-pix_fmt", "yuv420p",
            str(destination),
        ],
        timeout=900, what="cutting a chunk from the source",
    )
    if not destination.is_file() or destination.stat().st_size < 512:
        raise RuntimeError("the source chunk came out empty")
    return destination


def encode_restore_chunk_from_frames(frames, destination, *, fps):
    """Turn a chunk's PNG frames into its intermediate.

    FFV1 in Matroska: mathematically lossless, so re-finishing a project a
    second time starts from exactly the pixels the model produced. It is large,
    which is the trade a restoration tool is supposed to make — the chunk files
    exist so that changing your mind about grain does not cost another hour of
    diffusion.
    """
    ffmpeg = _ffmpeg_or_raise()
    if not frames:
        raise RuntimeError("the chunk produced no frames")
    listing = destination.parent / f"{destination.stem}.frames.txt"
    listing.write_text(
        "".join(f"file '{str(path).replace(chr(39), chr(39) * 3)}'\n" for path in frames),
        encoding="utf-8",
    )
    try:
        _run_ffmpeg(
            [
                ffmpeg, "-y", "-v", "error",
                "-r", f"{float(fps):.6f}",
                "-f", "concat", "-safe", "0", "-i", str(listing),
                "-c:v", "ffv1", "-level", "3", "-g", "1",
                str(destination),
            ],
            timeout=1800, what="encoding the restored chunk",
        )
    finally:
        listing.unlink(missing_ok=True)
    return destination


def assemble_restore_master(project, directory, *, output, source_for_audio=None):
    """Cut the finished chunks down to the plan and join them into one master.

    Every segment is rendered to its own lossless file first and joined with the
    concat demuxer, rather than built as one enormous filter graph: a 40-chunk
    project would otherwise be a filter chain no one can debug, and a failure
    halfway through would take the whole assembly with it.
    """
    ffmpeg = _ffmpeg_or_raise()
    plan = project["plan"]
    fps = float(plan["fps"])
    chunk_files = {}
    for index, entry in (project.get("chunks") or {}).items():
        name = str(entry.get("file") or "")
        if not name:
            raise RuntimeError("this project's chunks live on a rented machine and are assembled in the studio")
        chunk_files[int(index)] = directory / "chunks" / name

    staging = directory / "assembly"
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    segments = []
    try:
        for position, step in enumerate(config.video_restore.assembly_steps(plan)):
            piece = staging / f"seg-{position:04d}.mkv"
            if step["kind"] == "trim":
                source = chunk_files[step["chunk"]]
                _run_ffmpeg(
                    [
                        ffmpeg, "-y", "-v", "error", "-i", str(source),
                        "-vf", config.video_restore.trim_filter(step["start"], step["length"]),
                        "-an", "-fps_mode", "passthrough",
                        "-c:v", "ffv1", "-level", "3", "-g", "1", str(piece),
                    ],
                    timeout=1800, what="cutting an assembled segment",
                )
            else:
                first = chunk_files[step["chunk"]]
                second = chunk_files[step["next_chunk"]]
                _run_ffmpeg(
                    [
                        ffmpeg, "-y", "-v", "error", "-i", str(first), "-i", str(second),
                        "-filter_complex", config.video_restore.blend_filter_complex(step),
                        "-map", "[v]", "-an", "-fps_mode", "passthrough",
                        "-c:v", "ffv1", "-level", "3", "-g", "1", str(piece),
                    ],
                    timeout=1800, what="dissolving a chunk seam",
                )
            segments.append(piece)

        listing = staging / "segments.txt"
        listing.write_text(
            "".join(f"file '{str(path).replace(chr(39), chr(39) * 3)}'\n" for path in segments),
            encoding="utf-8",
        )
        joined = staging / "joined.mkv"
        _run_ffmpeg(
            [ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
             "-c", "copy", str(joined)],
            timeout=1800, what="joining the restored segments",
        )

        finish = dict(project.get("options", {}).get("finish") or {})
        filters = config.video_restore.finishing_filters(finish, width=plan["width"], height=plan["height"])
        args = [ffmpeg, "-y", "-v", "error", "-i", str(joined)]
        # The soundtrack is remuxed from the ORIGINAL, never regenerated and
        # never re-encoded if it can be copied: restoration is a picture job.
        audio = source_for_audio if (source_for_audio and Path(source_for_audio).is_file()) else None
        if audio and project.get("source", {}).get("has_audio"):
            args += ["-i", str(audio), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "256k", "-shortest"]
        else:
            args += ["-map", "0:v:0", "-an"]
        if filters:
            args += ["-vf", ",".join(filters)]
        args += config.video_restore.master_encode_args(finish)
        # Constant rate at the source's own fps. The segments already carry
        # frame-indexed timestamps, so this re-times nothing — it just stops the
        # master being written as variable-rate, which some players read as a
        # different duration than the audio.
        args += ["-fps_mode", "cfr", "-r", f"{fps:.6f}", str(output)]
        _run_ffmpeg(args, timeout=7200, what="finishing the master")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if not output.is_file() or output.stat().st_size < 1024:
        raise RuntimeError("the finished master came out empty")
    return output


def lane_restore_capability(lane_url, timeout=8.0):
    """What a lane can restore with: its device names, its installed models, and
    whether it has the SeedVR2 nodes at all.

    Asked rather than assumed. The same graph runs on an Apple lane whose only
    device is "mps" and on a rented Blackwell whose devices are "cuda:N", and a
    lane provisioned before SeedVR2 shipped has none of these nodes — that is a
    sentence the studio should say before a job exists, not a validation error
    after one does.
    """
    capability = {
        "available": False,
        "devices": [],
        "offload_devices": [],
        "models": [],
        "attention_modes": [],
        "missing": list(config.video_restore.REQUIRED_NODE_CLASSES),
        "tensorrt": {"available": False, "reason": "not asked yet"},
    }
    try:
        with net.urlopen(f"{lane_url}/object_info", timeout=timeout) as response:
            info = json.loads(response.read().decode("utf-8") or "{}")
    except Exception:
        return capability
    if not isinstance(info, dict):
        return capability
    capability["missing"] = [name for name in config.video_restore.REQUIRED_NODE_CLASSES if name not in info]
    if capability["missing"]:
        return capability
    loader = ((info.get("SeedVR2LoadDiTModel") or {}).get("input") or {})
    required = loader.get("required") or {}
    optional = loader.get("optional") or {}

    def combo(spec):
        if not isinstance(spec, list) or not spec:
            return []
        if isinstance(spec[0], list):
            return [str(v) for v in spec[0]]
        meta = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        return [str(v) for v in (meta.get("options") or [])]

    capability.update({
        "available": True,
        "devices": combo(required.get("device")),
        "offload_devices": combo(optional.get("offload_device")),
        "models": [name for name in combo(required.get("model")) if name.endswith((".safetensors", ".gguf"))],
        "attention_modes": combo(optional.get("attention_mode")),
        "tensorrt": lane_tensorrt_capability(lane_url, has_node=config.video_restore.TENSORRT_NODE_CLASS in info),
    })
    return capability


def lane_tensorrt_capability(lane_url, *, has_node, timeout=8.0):
    """Whether this lane can run the VAE decode through TensorRT, and if not, why.

    Three different states that all look the same from outside, and the studio
    has to distinguish them because only one of them is fixable by the owner:
    the node pack is not installed (a re-provision), torch-tensorrt is missing
    or the card is not NVIDIA (nothing to do — the render runs on PyTorch), or
    it is installed and working (say the measured speedup, not a promise).

    Never raises. A lane that will not answer this question can still restore.
    """
    if not has_node:
        return {
            "available": False,
            "installed": False,
            "reason": "this machine does not have the Hivemind TensorRT node — the decode runs on PyTorch",
        }
    try:
        with net.urlopen(f"{lane_url}/hivemind/seedvr2-trt", timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:
        return {
            "available": False,
            "installed": True,
            "reason": f"the machine did not answer about TensorRT ({type(exc).__name__})",
        }
    if not isinstance(payload, dict):
        return {"available": False, "installed": True, "reason": "the machine gave an unreadable answer"}
    return {
        "available": bool(payload.get("available")) and bool(payload.get("patched")),
        "installed": True,
        "device": str(payload.get("device") or ""),
        "torch_tensorrt": str(payload.get("torch_tensorrt") or ""),
        # Measured on this machine, on a real tile, or 0 before anything ran.
        # Never a claim.
        "speedup": float(payload.get("speedup") or 0),
        "engines_built": int(payload.get("engines_built") or 0),
        "reason": str(payload.get("patch_error") or payload.get("reason") or ""),
    }


def _restore_lane_devices(capability, options):
    """The device to run on and the one to park weights on between chunks.

    A requested device the lane does not have is dropped rather than sent: the
    pin is a preference, and honouring it into a validation error helps nobody.
    The offload choice is not a preference — see resolve_offload_device, which
    owns the caching coupling the node enforces.
    """
    devices = capability.get("devices") or []
    wanted = str(options.get("device") or "").strip()
    device = wanted if wanted in devices else (devices[0] if devices else "")
    offload = config.video_restore.resolve_offload_device(
        capability.get("offload_devices") or [],
        str(options.get("offload_device") or ""),
        device=device,
        cache_models=util.bool_option(options, "cache_models", True),
    )
    return device, offload


def _restore_chunk_on_lane(project, chunk, *, source_name, lane_name, lane_url, capability, job_id):
    """Submit one chunk and return what came back.

    Two shapes, and the difference is not a preference — see the sink note in
    video_restore. A local lane hands frames back through ComfyUI's temp
    directory as plaintext PNGs the gateway may read. A rented lane's output is
    sealed to the owner's vault the moment it is harvested and the gateway
    cannot read it at all, so a rented chunk comes back as a sealed clip name
    and the studio joins the project.
    """
    plan = project["plan"]
    options = project.get("options") or {}
    remote = lanes.comfy_lane_is_remote(lane_name)
    sink = config.video_restore.SINK_CLIP if remote else config.video_restore.SINK_FRAMES
    device, offload = _restore_lane_devices(capability, options)
    policy = config.video_restore.tensorrt_policy(
        plan, capability, requested=util.bool_option(options, "tensorrt", True),
    )
    graph = config.video_restore.build_restore_graph(
        source_name=source_name,
        plan=plan,
        chunk=chunk,
        sink=sink,
        filename_prefix=f"restore/{project['id']}-{chunk['index']:04d}",
        device=device,
        offload_device=offload,
        attention_mode=str(options.get("attention_mode") or "sdpa"),
        cache_models=util.bool_option(options, "cache_models", True),
        tiled_vae=util.bool_option(options, "tiled_vae", False),
        tile_size=util.int_option(options, "tile_size", 1024, 128, 4096),
        # Refused rather than passed through: it crashes chunk two.
        torch_compile=(util.bool_option(options, "torch_compile", False)
                       and config.video_restore.torch_compile_supported()[0]),
        tensorrt=policy["enabled"],
        tensorrt_may_build=policy["may_build"],
        tensorrt_fp16=util.bool_option(options, "tensorrt_fp16", True),
    )
    # Recorded on the project, because "why was this not accelerated" is a
    # question asked after the render, when the graph is long gone.
    project["tensorrt"] = policy
    body = json.dumps({"prompt": graph}).encode("utf-8")
    client_id = f"media-restore-{job_id}-{chunk['index']}"
    pushed_inputs = []
    if remote:
        transport_error = lanes.comfy_lane_transport_error(lane_name) or lanes.comfy_lane_liveness_error(lane_name)
        if transport_error:
            raise RuntimeError(transport_error)
        if not media.vault_public_key_spki():
            raise RuntimeError(
                f"lane '{lane_name}' is remote and its outputs must be sealed: create the owner vault first"
            )
        pushed_inputs = promptroutes.push_prompt_inputs_to_lane(body, lane_name)

    request = Request(
        f"{lane_url}/prompt",
        data=json.dumps({"prompt": graph, "client_id": client_id}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        queued = json.loads(net.urlopen(request, timeout=60).read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ComfyUI rejected the restore graph: {detail[:1500]}") from exc
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

    if remote:
        promptroutes.record_comfy_prompt_route(prompt_id, lane_name, pushed_inputs=pushed_inputs, client_id=client_id)
        route = promptroutes.watch_remote_comfy_prompt(prompt_id, timeout_seconds=RESTORE_CHUNK_TIMEOUT_SECONDS) or {}
        if route.get("status") != "harvested":
            raise RuntimeError(route.get("error") or "the rented machine did not finish this chunk")
        names = [str(name) for name in route.get("outputs") or []]
        if not names:
            raise RuntimeError("the rented machine returned no clip for this chunk")
        return {"output": names[0], "sealed": True}

    deadline = time.monotonic() + RESTORE_CHUNK_TIMEOUT_SECONDS
    history = None
    while time.monotonic() < deadline:
        if _restore_cancelled(project["id"]):
            try:
                net.urlopen(Request(f"{lane_url}/interrupt", data=b"", method="POST"), timeout=10).read()
            except Exception:
                pass
            raise RestoreCancelled("stopped")
        time.sleep(2)
        try:
            payload = net.urlopen(f"{lane_url}/history/{prompt_id}", timeout=15).read().decode("utf-8")
            data = json.loads(payload or "{}")
            if prompt_id in data:
                history = data[prompt_id]
                break
        except Exception:
            continue
    if history is None:
        raise RuntimeError("this chunk timed out — the lane may be stuck or out of memory")
    status = history.get("status") or {}
    if status.get("status_str") != "success" or not status.get("completed"):
        raise RuntimeError(f"the lane could not restore this chunk: {json.dumps(status)[:800]}")

    # Batch order, not filename order: the history lists the frames in the order
    # the node emitted them, and PreviewImage's names are random per run.
    frames = []
    for node_out in (history.get("outputs") or {}).values():
        for image in node_out.get("images") or []:
            resolved = runners.resolve_comfy_temp_file(image.get("filename"), image.get("subfolder"))
            if resolved is not None:
                frames.append(resolved)
    if not frames:
        raise RuntimeError("the lane restored this chunk but returned no frames")
    return {"frames": frames, "sealed": False}


def _restore_chunk_in_cloud(project, chunk, *, staged, destination, job_id):
    """Restore one chunk on the hosted serverless service.

    The other two lanes submit a ComfyUI graph to a machine. This one uploads
    the chunk, and the container at the far end builds the graph from THIS
    repo's own `video_restore.build_restore_graph` — copied into its image — so
    the hosted rail cannot drift into different pixels than the free one.

    What comes back is ordinary readable bytes, which is why a hosted project
    behaves like a local one from here on: the gateway assembles it, the seams
    dissolve, and re-finishing costs one ffmpeg pass rather than another render.

    THE SPEND CEILING IS ENFORCED HERE, not only at the far end. The studio
    approved a figure for the WHOLE render; each chunk is allowed the smaller of
    its own quote and what is left of that. A render that would run past the
    approved total stops with the finished chunks kept, because "it cost more
    than you agreed" is a conversation to have before the money moves.
    """
    plan = project["plan"]
    token = _restore_credit_token(project["id"])
    if not token:
        raise RuntimeError(
            "this render needs your HivemindOS account — reopen the project and press resume, "
            "or connect the account in Settings"
        )
    spend = project.setdefault("spend", {"approved_usd": 0.0, "charged_usd": 0.0})
    approved_total = float(spend.get("approved_usd") or 0.0)
    already = float(spend.get("charged_usd") or 0.0)
    remaining = approved_total - already if approved_total > 0 else 0.0
    if approved_total > 0 and remaining <= 0:
        raise RuntimeError(
            f"this render has spent the ${approved_total:.2f} you approved. "
            "The finished chunks are kept — resume to approve more."
        )
    try:
        result = config.cloud_restore.restore_chunk(
            source=staged,
            destination=destination,
            request_body=config.video_restore.cloud_chunk_request(
                plan=plan, chunk=chunk, project_id=project["id"]),
            token=token,
            # The per-chunk ceiling the service will refuse to exceed. What is
            # left of the whole render's approval when that is the tighter
            # number.
            maximum_debit_usd=max(0.01, remaining) if approved_total > 0 else 5.0,
            idempotency_key=f"{project['id']}-{int(chunk['index'])}-{job_id}",
            should_cancel=lambda: _restore_cancelled(project["id"]),
        )
    except config.cloud_restore.CloudRestoreError as exc:
        # A stop is not a failure. It has to arrive as the runner's own cancel
        # so the project is left "stopped" with its finished chunks kept, and
        # the studio offers resume rather than an error nobody can act on.
        if str(exc) == "stopped":
            raise RestoreCancelled("stopped") from None
        raise RuntimeError(str(exc)) from None
    spend["charged_usd"] = round(already + float(result.get("charged_usd") or 0.0), 6)
    return result


def run_video_restore(job_id, video_path, options=None):
    """Restore and upscale a clip with SeedVR2, one resumable chunk at a time.

    `video_path` is a plaintext clip the browser already decrypted, the same
    round trip RIFE and upscale make — nothing here needs the vault key until
    the finished master is sealed on the way out.

    Resume is the whole shape of this function: every finished chunk is written
    to the project directory and recorded in the manifest before the next one
    starts, so an interrupted render (a crash, a stop, a laptop lid) continues
    from the first chunk that has no file rather than from frame zero.
    """
    started = util.now_iso()
    options = dict(options or {})
    project_id = util.safe_name(str(options.get("project_id") or "")) or f"r{uuid.uuid4().hex[:10]}"
    # Taken out of `options` FIRST, because `options` is written into the
    # project manifest verbatim a few lines below. A credit token on disk in a
    # project directory would outlive the render, survive a backup, and be
    # readable by anything that can read a file — none of which is true of the
    # place it is going instead, which is this process's memory for the length
    # of one render.
    remember_restore_credit_token(project_id, options.pop("credit_token", "") or "")
    directory = restore_project_dir(project_id)
    manifest = restore_manifest_path(project_id)
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "seedvr2-restore",
        "created_at": started,
        "outputs": [],
        "project_id": project_id,
        "options": {"project_id": project_id},
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    _clear_restore_cancel(project_id)
    video_path = Path(video_path) if video_path else None
    project = None
    try:
        directory.mkdir(parents=True, exist_ok=True)
        source = directory / "source.mp4"
        if manifest.is_file():
            project = config.video_restore.read_project(manifest)
        if video_path is not None and video_path.is_file():
            # A new upload replaces the staged source and invalidates the plan:
            # different footage is a different project, not a resume.
            if project is not None and project.get("source", {}).get("sha256") and _file_sha256(video_path) != project["source"]["sha256"]:
                project = None
            shutil.move(str(video_path), str(source))
            video_path = None
        if not source.is_file():
            raise RuntimeError("this project's source clip is gone — upload it again to resume")

        if project is None:
            probed = probe_restore_source(source)
            probed["sha256"] = _file_sha256(source)
            plan = config.video_restore.restore_plan(
                frames=probed["frames"], fps=probed["fps"],
                width=probed["width"], height=probed["height"],
                options=options,
            )
            lane_name, lane_url, capability = _resolve_restore_lane(plan, options)
            sink = _restore_sink_for_lane(lane_name)
            if not config.video_restore.sink_supports_seams(sink):
                # Said in the plan rather than discovered at assembly: a rented
                # chunk arrives already trimmed and sealed, so there is no
                # second copy of a boundary left to dissolve.
                plan["seam_frames"] = 0
            project = config.video_restore.new_project(
                project_id=project_id, source=probed, plan=plan,
                options=options, lane=lane_name, sink=sink,
            )
            project["created_at"] = started
        else:
            plan = project["plan"]
            lane_name, lane_url, capability = _resolve_restore_lane(plan, {**project.get("options", {}), **options})
            project["lane"] = lane_name
            # A resume on a different KIND of lane cannot reuse the chunks:
            # local chunks are readable files, rented ones are sealed clips, and
            # half of each is not a project. A hosted project's chunks ARE
            # readable, but they were made by a different pipeline build, so the
            # same rule applies rather than a special case nobody would expect.
            sink = _restore_sink_for_lane(lane_name)
            if project.get("sink") != sink and project.get("chunks"):
                raise RuntimeError(
                    "this project's finished chunks were made on a "
                    f"{_restore_sink_word(project['sink'])} machine; "
                    "finish it there, or start a new project to switch"
                )
            project["sink"] = sink

        if sink == config.video_restore.SINK_CLOUD:
            # What the owner agreed to spend on this render, from the figure the
            # panel SHOWED them. Re-approved on every start, including a resume:
            # the chunks already paid for are recorded on the project, and a
            # resume a week later is a fresh decision at that day's price.
            approved = float(options.get("max_spend_usd") or 0.0)
            if approved <= 0:
                # Refused rather than defaulted. This is the one lane where
                # starting a render spends money by itself, and "however much it
                # takes" is not a figure anybody agreed to. The studio always
                # sends one, because it puts it on the button first.
                raise RuntimeError(
                    "a hosted render needs a spending limit — start it from the studio, "
                    "which quotes the render and shows the price before it sends anything"
                )
            spend = project.setdefault("spend", {"approved_usd": 0.0, "charged_usd": 0.0})
            spend["charged_usd"] = round(sum(
                float(entry.get("charged_usd") or 0.0) for entry in (project.get("chunks") or {}).values()
            ), 6)
            spend["approved_usd"] = round(spend["charged_usd"] + approved, 6)

        project["status"] = "running"
        project["updated_at"] = util.now_iso()
        project["error"] = ""
        rec["options"].update({"lane": lane_name, "preview": bool(plan.get("preview"))})
        rec["lane"] = lane_url
        config.video_restore.write_project(manifest, project)
        with jobs.jobs_lock:
            jobs.jobs[job_id] = rec

        t0 = time.monotonic()
        chunks_dir = directory / "chunks"
        chunks_dir.mkdir(parents=True, exist_ok=True)
        for chunk in plan["chunks"]:
            index = int(chunk["index"])
            if str(index) in (project.get("chunks") or {}):
                continue
            if _restore_cancelled(project_id):
                raise RestoreCancelled("stopped")
            chunk_started = time.monotonic()
            staged_name = f"restore-{project_id}-{index:04d}.mp4"
            staged = (config.COMFY_INPUT_DIR / staged_name)
            config.COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
            cut_restore_chunk(
                source, staged,
                start_frame=chunk["source_start"], length=chunk["source_length"], fps=plan["fps"],
            )
            try:
                if project["sink"] == config.video_restore.SINK_CLOUD:
                    # The hosted service hands back a finished clip rather than
                    # frames, so it lands as the chunk intermediate directly.
                    # .mp4 rather than the local .mkv because that is what came
                    # down the wire; the assembler reads either.
                    destination = chunks_dir / f"out-{index:04d}.mp4"
                    result = _restore_chunk_in_cloud(
                        project, chunk, staged=staged, destination=destination, job_id=job_id,
                    )
                    entry = {
                        "file": destination.name,
                        "frames": result.get("frames") or chunk["source_length"],
                        # What this chunk actually cost, kept per chunk so the
                        # panel can show a running total that is invoices rather
                        # than an estimate, and so a resume knows what is spent.
                        "charged_usd": round(float(result.get("charged_usd") or 0.0), 6),
                    }
                elif (result := _restore_chunk_on_lane(
                    project, chunk, source_name=staged_name, lane_name=lane_name,
                    lane_url=lane_url, capability=capability, job_id=job_id,
                )).get("sealed"):
                    entry = {"output": result["output"], "frames": chunk["source_length"]}
                else:
                    destination = chunks_dir / f"out-{index:04d}.mkv"
                    encode_restore_chunk_from_frames(result["frames"], destination, fps=plan["fps"])
                    for frame in result["frames"]:
                        try:
                            frame.unlink(missing_ok=True)
                        except OSError:
                            pass
                    entry = {"file": destination.name, "frames": len(result["frames"])}
            finally:
                staged.unlink(missing_ok=True)
            entry["elapsed_seconds"] = round(time.monotonic() - chunk_started, 2)
            project.setdefault("chunks", {})[str(index)] = entry
            project["updated_at"] = util.now_iso()
            # The checkpoint. Written before the next chunk starts so a crash
            # in the next one costs nothing already paid for.
            config.video_restore.write_project(manifest, project)
            rec["progress"] = config.video_restore.project_progress(project)
            with jobs.jobs_lock:
                jobs.jobs[job_id] = rec

        if not config.video_restore.sink_assembles_locally(project["sink"]):
            # Nothing more this side can do: the chunks are sealed clips and the
            # key to join them lives in the browser.
            project["status"] = "awaiting_assembly"
            config.video_restore.write_project(manifest, project)
            rec.update({
                "status": "success",
                "finished_at": util.now_iso(),
                "elapsed_seconds": round(time.monotonic() - t0, 2),
                "restore": {
                    "project_id": project_id,
                    "status": "awaiting_assembly",
                    "chunk_outputs": [
                        project["chunks"][str(chunk["index"])]["output"] for chunk in plan["chunks"]
                    ],
                },
            })
        else:
            config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            suffix = "preview" if plan.get("preview") else "master"
            master = config.COMFY_OUTPUT_DIR / f"restore_{project_id}_{suffix}.mp4"
            media.mark_output_active(master)
            try:
                assemble_restore_master(project, directory, output=master, source_for_audio=source)
            finally:
                media.mark_output_inactive(master)
            project["master"] = master.name
            project["status"] = "complete"
            config.video_restore.write_project(manifest, project)
            rec.update({
                "status": "success",
                "finished_at": util.now_iso(),
                "outputs": media.encrypt_outputs([str(master)], job_id=job_id),
                "elapsed_seconds": round(time.monotonic() - t0, 2),
                "restore": {"project_id": project_id, "status": "complete"},
            })
    except RestoreCancelled:
        if project is not None:
            project["status"] = "stopped"
            project["updated_at"] = util.now_iso()
            try:
                config.video_restore.write_project(manifest, project)
            except Exception:
                pass
        rec.update({
            "status": "cancelled", "finished_at": util.now_iso(),
            # Said plainly: the finished chunks are the reason to press resume
            # rather than start again.
            "error": "Stopped. The chunks already finished are kept — resume continues from the next one.",
        })
    except Exception as exc:
        if project is not None:
            project["status"] = "error"
            project["error"] = str(exc)
            project["updated_at"] = util.now_iso()
            try:
                config.video_restore.write_project(manifest, project)
            except Exception:
                pass
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        _clear_restore_cancel(project_id)
        if video_path is not None:
            video_path.unlink(missing_ok=True)
        # The token is only ever in this process's memory, and only for as long
        # as the render it belongs to.
        forget_restore_credit_token(project_id)
        if (project is not None and util.bool_option(options, "cache_models", True)
                and project.get("lane") != config.video_restore.CLOUD_LANE):
            # Nothing to free on the hosted lane: there is no machine holding
            # weights for us, which is the whole difference it is sold on.
            _free_restore_lane(project.get("lane") or "default", rec.get("lane") or config.COMFY_HTTP_DEFAULT)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def run_restore_finish(job_id, project_id, finish_options, assembled_path=None):
    """Change the finish without re-restoring anything.

    The expensive half of a restoration is on disk before this runs: the lossless
    chunks for a local project, or a clip the studio joined for one whose chunks
    are sealed. Sharpening, grain, flat-detail softening and the reframe are one
    ffmpeg pass over that, which is the whole point of keeping the chunks.

    A rented project reaches here with `assembled_path`: the gateway cannot read
    its sealed chunks, so the join happens in the browser and the finished join
    comes back as ordinary decrypted bytes, exactly like the RIFE and upscale
    round trips.
    """
    started = util.now_iso()
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": "seedvr2-finish",
        "created_at": started,
        "outputs": [],
        "project_id": project_id,
    }
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec
    assembled_path = Path(assembled_path) if assembled_path else None
    master = None
    try:
        manifest = restore_manifest_path(project_id)
        if not manifest.is_file():
            raise RuntimeError("no such restoration project")
        project = config.video_restore.read_project(manifest)
        directory = restore_project_dir(project_id)
        source = directory / "source.mp4"
        plan = project["plan"]
        finish = dict(finish_options or {})
        project.setdefault("options", {})["finish"] = finish

        config.COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        suffix = "preview" if plan.get("preview") else "master"
        # A new file rather than an overwrite: the previous finish is already in
        # History and may be the one somebody liked.
        master = config.COMFY_OUTPUT_DIR / f"restore_{project_id}_{suffix}_{uuid.uuid4().hex[:6]}.mp4"
        t0 = time.monotonic()
        media.mark_output_active(master)
        try:
            if assembled_path is not None:
                if not assembled_path.is_file():
                    raise RuntimeError("the assembled clip did not arrive")
                ffmpeg = _ffmpeg_or_raise()
                filters = config.video_restore.finishing_filters(finish, width=plan["width"], height=plan["height"])
                args = [ffmpeg, "-y", "-v", "error", "-i", str(assembled_path)]
                if source.is_file() and project.get("source", {}).get("has_audio"):
                    args += ["-i", str(source), "-map", "0:v:0", "-map", "1:a:0?",
                             "-c:a", "aac", "-b:a", "256k", "-shortest"]
                else:
                    args += ["-map", "0:v:0", "-an"]
                if filters:
                    args += ["-vf", ",".join(filters)]
                args += config.video_restore.master_encode_args(finish)
                args += [str(master)]
                _run_ffmpeg(args, timeout=7200, what="finishing the assembled master")
            else:
                if not (project.get("chunks") or {}):
                    raise RuntimeError("this project has no finished chunks to assemble yet")
                assemble_restore_master(
                    project, directory, output=master,
                    source_for_audio=source if source.is_file() else None,
                )
        finally:
            media.mark_output_inactive(master)
        project["master"] = master.name
        project["status"] = "complete"
        project["updated_at"] = util.now_iso()
        config.video_restore.write_project(manifest, project)
        rec.update({
            "status": "success",
            "finished_at": util.now_iso(),
            "outputs": media.encrypt_outputs([str(master)], job_id=job_id),
            "elapsed_seconds": round(time.monotonic() - t0, 2),
            "restore": {"project_id": project_id, "status": "complete"},
        })
    except Exception as exc:
        if master is not None:
            master.unlink(missing_ok=True)
        rec.update({"status": "error", "finished_at": util.now_iso(), "error": str(exc)})
    finally:
        if assembled_path is not None:
            assembled_path.unlink(missing_ok=True)
    _history.append_history(rec)
    with jobs.jobs_lock:
        jobs.jobs[job_id] = rec


def _free_restore_lane(lane_name, lane_url):
    """Hand the weights back when a project is done.

    Caching keeps 8-16GB resident so the chunks do not each pay a model load;
    leaving it resident AFTER the last chunk is the memory complaint the lane
    panel exists to make (a native Klein edit waits for ~48GB of headroom and
    times out without it). Freeing costs one reload if another project starts
    straight away, which is the cheaper mistake. Remote lanes are somebody
    else's memory and are left alone.
    """
    if lanes.comfy_lane_is_remote(lane_name):
        return
    try:
        request = Request(
            f"{lane_url}/free",
            data=json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with net.urlopen(request, timeout=20):
            pass
    except Exception as exc:
        print(f"[restore] could not free {lane_name}: {exc}", file=sys.stderr)


def _file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def restore_pin_error(options):
    """Why a "Run on" pin cannot be honoured, or None.

    The pre-check the start route runs BEFORE a job exists, so a stale pin is a
    409 with a sentence rather than a dead job. The hosted lane is not a ComfyUI
    lane and never in COMFY_LANES — it has no machine — so the pin resolver
    must not be asked about it. Measured on the first end-to-end run: it was,
    and the studio's only paid-per-render lane answered 409 to every start.
    """
    pin = str((options or {}).get("run_on") or "").strip()
    if not pin or pin == config.video_restore.CLOUD_LANE:
        return None
    try:
        lanes.comfy_lane_for_pin(pin)
    except lanes.ComfyLanePinError as exc:
        return str(exc)
    return None


def _cloud_restore_capability(health=None):
    """What the hosted lane can do, in the shape the local probe returns.

    The models the container actually carries, and only those — the whole
    point of baking the weights into the image is that a caller never waits
    for a download, and a model that is not baked would be one. There are no
    device names to offer: which card it lands on is the service's problem,
    not a dial anybody should turn.
    """
    health = health or {}
    return {
        "available": bool(health.get("available")),
        "devices": [],
        "offload_devices": [],
        "models": list(config.video_restore.CLOUD_MODELS),
        "attention_modes": ["sdpa"],
        "missing": [] if health.get("available") else ["hosted service"],
        "tensorrt": {"available": False, "installed": False, "reason": health.get("reason") or ""},
    }


def _restore_sink_for_lane(lane_name):
    """Which sink a lane implies. The one place that mapping lives.

    Three lanes, three answers, and the difference is only ever about who may
    read the finished chunk: a rented lane's output is sealed to the owner's
    vault on arrival and the gateway cannot, so it assembles in the browser.
    """
    if lane_name == config.video_restore.CLOUD_LANE:
        return config.video_restore.SINK_CLOUD
    return config.video_restore.SINK_CLIP if lanes.comfy_lane_is_remote(lane_name) else config.video_restore.SINK_FRAMES


def _restore_sink_word(sink):
    """The word a person would use for the machine behind a sink."""
    return {
        config.video_restore.SINK_CLIP: "rented",
        config.video_restore.SINK_CLOUD: "hosted",
    }.get(sink, "local")


def _resolve_restore_lane(plan, options):
    """Which lane runs this project, and proof that it can.

    A pinned machine that cannot restore is refused BY NAME here, before a job
    exists to fail: "that box has no SeedVR2 nodes" is actionable, and a
    ComfyUI validation error three minutes into a staged upload is not.
    """
    lanes.refresh_comfy_lanes()
    pin = str(options.get("run_on") or "").strip()
    if pin == config.video_restore.CLOUD_LANE:
        # Not a machine, so there is no /object_info to ask: what stands in for
        # a capability probe is whether the service says it is on. Refused BY
        # NAME here for the same reason a rented box without the nodes is —
        # "hosted restoration is switched off" before a job exists beats a
        # credit error three chunks in.
        health = config.cloud_restore.status()
        if not health.get("available"):
            raise RuntimeError(
                health.get("reason") or "hosted restoration is not available right now"
            )
        capability = _cloud_restore_capability(health)
        if plan.get("model") and plan["model"] not in capability["models"]:
            # Refused by name, before a chunk exists. The container carries the
            # fp8 checkpoints; an fp16 one would be a 16GB download billed to
            # whoever asked, and a lane that quietly did that is worse than
            # one that says which models it has.
            raise RuntimeError(
                f"the hosted service does not carry {plan['model']} — pick one of: "
                + ", ".join(capability["models"])
            )
        return config.video_restore.CLOUD_LANE, "", capability
    lane_name = lanes.comfy_lane_for_pin(pin) if pin else None
    if lane_name is None:
        # No pin: prefer a lane that actually has the nodes, in configured
        # order, so a stack whose video lane carries SeedVR2 is found without
        # the studio having to know which one that is.
        for candidate in list(lanes.COMFY_LANES):
            capability = lane_restore_capability(lanes.COMFY_LANES[candidate])
            if capability.get("available"):
                return candidate, lanes.COMFY_LANES[candidate], capability
        raise RuntimeError(
            "no connected machine has the SeedVR2 nodes installed — install "
            "ComfyUI-SeedVR2_VideoUpscaler on this ComfyUI, or attach a rented machine that has it"
        )
    lane_url = lanes.COMFY_LANES.get(lane_name, config.COMFY_HTTP_DEFAULT)
    capability = lane_restore_capability(lane_url)
    if not capability.get("available"):
        missing = ", ".join(capability.get("missing") or []) or "the SeedVR2 nodes"
        raise RuntimeError(f"the machine you pinned cannot restore video: it is missing {missing}")
    return lane_name, lane_url, capability


def restore_projects_summary(limit=50):
    """Every project this machine knows about, newest first."""
    projects = []
    if not RESTORE_ROOT.exists():
        return projects
    for manifest in sorted(RESTORE_ROOT.glob("*/project.json")):
        try:
            project = config.video_restore.read_project(manifest)
        except Exception:
            continue
        plan = project.get("plan") or {}
        projects.append({
            "id": project.get("id"),
            "status": project.get("status"),
            "created_at": project.get("created_at"),
            "updated_at": project.get("updated_at"),
            "lane": project.get("lane"),
            "sink": project.get("sink"),
            "preview": bool(plan.get("preview")),
            "width": plan.get("width"),
            "height": plan.get("height"),
            "frames": plan.get("frames"),
            "fps": plan.get("fps"),
            "model": plan.get("model"),
            "master": project.get("master") or "",
            "error": project.get("error") or "",
            "progress": config.video_restore.project_progress(project),
            "has_source": (manifest.parent / "source.mp4").is_file(),
        })
    projects.sort(key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""), reverse=True)
    return projects[:max(1, int(limit))]


def reap_restore_projects(ttl_days=None):
    """Delete project directories nobody has touched in a month.

    A restore project is gigabytes of lossless intermediates; keeping them
    forever turns a feature into a disk leak. Anything still running is left
    alone regardless of age.
    """
    ttl = RESTORE_PROJECT_TTL_DAYS if ttl_days is None else int(ttl_days)
    if ttl <= 0 or not RESTORE_ROOT.exists():
        return 0
    cutoff = time.time() - ttl * 86400
    removed = 0
    for manifest in list(RESTORE_ROOT.glob("*/project.json")):
        try:
            project = config.video_restore.read_project(manifest)
            if project.get("status") == "running":
                continue
            if manifest.stat().st_mtime > cutoff:
                continue
            shutil.rmtree(manifest.parent, ignore_errors=True)
            removed += 1
            # Recorded, not just logged. A project that ages out used to vanish
            # from the studio with nothing to read; this is the line that lets
            # it say what happened instead. No prompt, no path — the project id
            # and the rule that removed it.
            try:
                _history.append_history({
                    "id": f"reap-{project.get('id') or manifest.parent.name}",
                    "kind": "restore_project_reaped",
                    "backend": "seedvr2-restore",
                    "status": "reaped",
                    "project_id": project.get("id") or manifest.parent.name,
                    "finished_at": util.now_iso(),
                    "error": (
                        f"Its working files were removed after {ttl} days. "
                        "Any master it produced is still in History."
                    ),
                })
            except OSError:
                pass
        except Exception:
            continue
    return removed
