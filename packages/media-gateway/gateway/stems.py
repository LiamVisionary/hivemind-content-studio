"""Split a finished clip's sound into stems and hand them straight back.

The job behind the Video stage's "Split the sound" — see audio_split.py for the
graph and for why the stems are never outputs. Shaped like
runners.run_sam3_smart_mask, which solved the same problem for a mask: the
source arrives already decrypted from the browser (so this never needs the
vault key), the result leaves ComfyUI through its temp directory, is read once,
deleted, and rides back INLINE on the in-memory job record. Nothing is sealed
into History, nothing plaintext is left on disk, and history.jsonl learns only
that a split happened and how long it took.

What it adds to that shape is the install. A production app installs what is
missing itself: the two checkpoints (20 MB together) are fetched on the first
split, pinned and checksummed, and the node pack is linked into ComfyUI and the
lane restarted if this stack started before the pack existed — but only when
the lane is idle, because a restart takes whatever is rendering down with it.
"""

import base64
import binascii
import json
import re
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request

from gateway import config, graphs as _graphs, history as _history, jobs, net, private_inputs, runners, util

import audio_split

BACKEND = "audio-split"
# TIGER-DnR runs three 4M-parameter models over 12 s windows 4 s apart; measured
# on an M-series GPU at ~3.2x the clip's length. An hour covers any clip the
# voice splitter will accept, on a machine several times slower.
TIMEOUT_SECONDS = 3600
# The stems stay on the record for as long as a studio tab could plausibly
# still be asking, then go. They are tens of megabytes of someone's dialogue
# held in this process; "until the gateway restarts" is not a retention policy.
STEMS_TTL_SECONDS = 600
# The largest clip the route accepts. Same ceiling as the other inline-video
# routes (runners.stage_inline_video_base64).
MAX_SOURCE_BYTES = 400 * 1024 * 1024

PACK_DIR = Path(__file__).resolve().parents[2] / "comfyui-custom-nodes" / "hivemind-audio-split"
PACK_LINK_NAME = "hivemind-audio-split"


class SplitRefused(RuntimeError):
    """A refusal that is already a sentence for the person who asked."""


def decode_inline_media(value):
    """(bytes, media type) from raw base64 or a video/audio data URL.

    Decoded into memory and left there. The sibling inline-video routes write
    their clip under OUT_DIR for ffmpeg to open; this one has no reader that
    needs a path, so it never makes one."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("media_base64 is required")
    encoded = value.strip()
    media_type = "video/mp4"
    if encoded.startswith("data:"):
        match = re.match(r"^data:((?:video|audio)/[a-zA-Z0-9.+-]+);base64,(.*)$", encoded, flags=re.DOTALL)
        if not match:
            raise ValueError("media_base64 must be raw base64 or a video/audio data URL")
        media_type, encoded = match.groups()
    try:
        payload = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("media_base64 is not valid base64") from exc
    if not payload:
        raise ValueError("media_base64 decoded to an empty clip")
    if len(payload) > MAX_SOURCE_BYTES:
        raise ValueError(f"that clip is over {MAX_SOURCE_BYTES // (1024 * 1024)}MB")
    return payload, media_type


def _set(rec, **fields):
    rec.update(fields)
    with jobs.jobs_lock:
        jobs.jobs[rec["id"]] = rec


def weights_missing():
    root = config.COMFY / "models" / audio_split.MODELS_SUBDIR
    missing = []
    for item in audio_split.WEIGHTS:
        dest = root / item["folder"] / item["filename"]
        if not dest.is_file() or dest.stat().st_size != item["bytes"]:
            missing.append((item, dest))
    return missing


def install_weights(rec):
    """Fetch whichever checkpoint is absent. Resumable, size- and hash-checked
    (dependencies.download_url), so a partial or substituted file never loads."""
    missing = weights_missing()
    if not missing:
        return
    from gateway import dependencies

    total = sum(item["bytes"] for item, _ in missing)
    fetched = 0
    for item, dest in missing:
        base = fetched

        def report(done, _total, base=base):
            _set(rec, stage="installing", progress=round(min(0.99, (base + done) / total), 3))

        try:
            dependencies.download_url(
                item["url"], dest, expected_bytes=item["bytes"], sha256=item["sha256"], progress_cb=report,
            )
        except Exception as exc:
            raise SplitRefused(
                "The sound splitter's model could not be downloaded (20 MB, from Hugging Face). "
                "Check this machine's connection and split the clip again — it resumes where it stopped."
            ) from exc
        fetched += item["bytes"]


def _lane_has(lane_url, class_name):
    try:
        payload = net.urlopen(f"{lane_url}/object_info/{class_name}", timeout=10).read()
        return class_name in json.loads(payload.decode("utf-8") or "{}")
    except Exception:
        return False


def _lane_idle(lane_url):
    try:
        queue = json.loads(net.urlopen(f"{lane_url}/queue", timeout=10).read().decode("utf-8") or "{}")
    except Exception:
        return False
    return not (queue.get("queue_running") or queue.get("queue_pending"))


def ensure_pack_loaded(rec, lane_url):
    """Make sure the lane can resolve the splitter's nodes, installing them if not.

    The stack script links this repo's packs into ComfyUI when it starts, so
    this only has work to do on a stack that started before the pack existed —
    which is every stack, the day the feature ships.
    """
    missing = [name for name in audio_split.REQUIRED_CLASSES if not _lane_has(lane_url, name)]
    if not missing:
        return
    link = config.COMFY / "custom_nodes" / PACK_LINK_NAME
    if not PACK_DIR.is_dir():
        raise SplitRefused("This install is missing the sound splitter. Update the studio and split the clip again.")
    # Same rule as the stack script: replace our own symlink, never a real
    # directory somebody put there.
    if link.is_symlink() or not link.exists():
        if link.is_symlink():
            link.unlink()
        link.symlink_to(PACK_DIR, target_is_directory=True)
    else:
        raise SplitRefused(
            "The sound splitter could not be installed: custom_nodes/hivemind-audio-split exists and is not the studio's link. "
            "Move it aside and split the clip again."
        )
    if not _lane_idle(lane_url):
        raise SplitRefused(
            "The sound splitter is installed and loads the next time this machine's engine restarts. "
            "Something is rendering right now, so it was left alone — split the clip again when it finishes."
        )
    from gateway import dependencies

    _set(rec, stage="restarting")
    answer = dependencies.restart_lane("default")
    if not answer.get("accepted"):
        raise SplitRefused(
            "The sound splitter is installed, but this machine's engine has to restart to load it: "
            + str(answer.get("reason") or "restart the studio")
            + "."
        )
    deadline = time.monotonic() + 240
    time.sleep(3)
    while time.monotonic() < deadline:
        if dependencies.lane_ready("default") and all(_lane_has(lane_url, name) for name in audio_split.REQUIRED_CLASSES):
            return
        time.sleep(2)
    raise SplitRefused("This machine's engine restarted but did not load the sound splitter. Restart the studio and try again.")


def _forget_stems_later(job_id):
    def forget():
        with jobs.jobs_lock:
            rec = jobs.jobs.get(job_id)
            if rec is not None:
                rec.pop("stems", None)
                rec["stems_expired"] = True

    timer = threading.Timer(STEMS_TTL_SECONDS, forget)
    timer.daemon = True
    timer.start()


def run_audio_split(job_id, payload, media_type="video/mp4", options=None):
    options = options or {}
    rec = {
        "id": job_id,
        "prompt": _history.PRIVATE_PROMPT_LABEL,
        "status": "running",
        "backend": BACKEND,
        "created_at": util.now_iso(),
        "outputs": [],
        "stage": "preparing",
    }
    _set(rec)
    lane_url = config.COMFY_HTTP_DEFAULT
    handle = ""
    temp_files = []
    try:
        t0 = time.monotonic()
        install_weights(rec)
        ensure_pack_loaded(rec, lane_url)

        # An hour, like any staged input: long enough to sit behind a render
        # already in the lane's queue. Released in `finally` either way.
        handle = private_inputs.stage(payload, media_type)
        graph, stem_nodes = audio_split.build_audio_split_prompt(
            handle, voices=util.bool_option(options, "voices", True),
        )
        _set(rec, stage="splitting", progress=0)
        body = _graphs.private_prompt_body(graph, f"media-audiosplit-{job_id}", lane_url)
        request = Request(f"{lane_url}/prompt", data=body, headers={"Content-Type": "application/json"})
        try:
            queued = json.loads(net.urlopen(request, timeout=30).read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI rejected the sound-split graph: {detail[:2000]}") from exc
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        run = None
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(2)
            try:
                data = json.loads(net.urlopen(f"{lane_url}/history/{prompt_id}", timeout=10).read().decode("utf-8") or "{}")
            except Exception:
                continue
            if prompt_id in data:
                run = data[prompt_id]
                break
        if run is None:
            raise RuntimeError("the sound split timed out — the lane may be stuck or out of memory")
        status = run.get("status") or {}
        if status.get("status_str") != "success":
            raise RuntimeError(_failure_sentence(status))

        stems = []
        for node_id, node_out in (run.get("outputs") or {}).items():
            key = stem_nodes.get(str(node_id))
            entry = (node_out.get("audio") or [None])[0]
            if not key or not isinstance(entry, dict):
                continue
            path = runners.resolve_comfy_temp_file(entry.get("filename"), entry.get("subfolder"))
            if path is None:
                continue
            temp_files.append(path)
            level = float((node_out.get("level_db") or [-120.0])[0])
            stems.append({
                "key": key,
                "seconds": float((node_out.get("seconds") or [0])[0]),
                "level_db": level,
                "silent": level < audio_split.SILENT_BELOW_DB,
                "wav_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
            })
        if not stems:
            raise RuntimeError("the lane split the sound but returned no stems")
        order = [name for name, _ in audio_split.SOUNDTRACK_STEMS + audio_split.VOICE_STEMS]
        stems.sort(key=lambda stem: order.index(stem["key"]))
        _set(
            rec,
            status="success",
            stage="done",
            progress=1,
            finished_at=util.now_iso(),
            elapsed_seconds=round(time.monotonic() - t0, 2),
            stems=stems,
        )
        _forget_stems_later(job_id)
    except Exception as exc:
        _set(rec, status="error", finished_at=util.now_iso(), error=str(exc))
    finally:
        if handle:
            private_inputs.release(handle)
        for path in temp_files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
    # The stems are somebody's dialogue. They ride back in memory only; the
    # history line records that a split ran, not what was in it.
    _history.append_history({key: value for key, value in rec.items() if key not in ("stems", "progress", "stage")})


def _failure_sentence(status):
    """ComfyUI's execution_error, reduced to the node's own message.

    The pack raises sentences written for a person (no sound in the clip, a
    clip too long for the voice splitter, weights absent); the status blob
    around them is a traceback nobody asked for."""
    for message in status.get("messages") or []:
        if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == "execution_error":
            said = str((message[1] or {}).get("exception_message") or "").strip()
            # The one refusal that is ComfyUI's wording rather than the pack's:
            # its audio loader, handed a clip that was generated silent. Said
            # the way the "Sound only" row says it, because it is the same fact.
            if "no audio stream" in said.lower():
                return "This clip has no sound."
            if said:
                return said
    return f"the lane could not split this clip: {json.dumps(status)[:600]}"
