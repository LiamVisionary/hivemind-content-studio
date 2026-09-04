"""The durable job history file: rotation, prompt scrubbing, the public and
private record shapes, and download-job persistence."""
import contextlib
import json
import threading
from pathlib import Path

from gateway import config, promptroutes, util


HISTORY_FILE = config.GATEWAY_STATE_DIR / "history.jsonl"
# The generation before the last rotation. Kept, not deleted — and purged
# alongside the live file whenever an output is deleted.
HISTORY_PREVIOUS_FILE = config.GATEWAY_STATE_DIR / "history.1.jsonl"
HISTORY_ROTATE_BYTES = 8 * 1024 * 1024
# How many records stay in the live file when it rotates. Comfortably more than
# the largest limit any reader asks for (500), so a rotation never blanks the
# History tab or hides a job a poll is still looking for.
HISTORY_KEEP_ON_ROTATE = 2000
# The seek margin per record wanted, for the tail read. A record is a few
# hundred bytes; this is deliberately generous so one seek is normally enough.
HISTORY_TAIL_BYTES_PER_RECORD = 4096
history_write_lock = threading.Lock()
DOWNLOAD_JOBS_FILE = config.GATEWAY_STATE_DIR / "download_jobs.json"
download_jobs = {}
download_jobs_lock = threading.Lock()


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
    return "\n".join(promptroutes._sanitized_remote_error_text(line) for line in kept)


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
    with history_write_lock:
        with HISTORY_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(private_rec(rec), ensure_ascii=False) + "\n")
        _rotate_history_if_large()


def _rotate_history_if_large():
    """Move everything but the recent tail into the cold log, once it is large.

    Caller holds history_write_lock. Every reader wants the tail, so the live
    file only has to hold recent work — but it must never be emptied outright,
    or /api/history would go blank until the next generation. What is moved out
    is appended to history.1.jsonl rather than deleted, and that file is purged
    alongside the live one whenever an output is deleted.
    """
    try:
        if HISTORY_FILE.stat().st_size < HISTORY_ROTATE_BYTES:
            return
        lines = HISTORY_FILE.read_bytes().splitlines()
    except OSError:
        return
    if len(lines) <= HISTORY_KEEP_ON_ROTATE:
        return  # a few enormous records; moving them would leave nothing to read
    keep = lines[-HISTORY_KEEP_ON_ROTATE:]
    older = lines[:-HISTORY_KEEP_ON_ROTATE]
    staged = HISTORY_FILE.parent / f"{HISTORY_FILE.name}.rotating"
    with contextlib.suppress(OSError):
        with HISTORY_PREVIOUS_FILE.open("ab") as handle:
            handle.write(b"\n".join(older) + b"\n")
        staged.write_bytes(b"\n".join(keep) + b"\n")
        staged.replace(HISTORY_FILE)


def _tail_lines(path, want, size):
    """The last `want` lines, read from the end instead of from the start.

    Every caller of load_history asks for the most recent 100-500 records, and
    reading the whole file to serve them made a job poll for an unknown id cost
    the entire history — which only grows. This seeks to a whole-record margin
    before the end, drops whatever partial line that landed in, and widens the
    window only if the file's records turned out to be smaller than the margin.
    """
    window = min(size, max(1, want) * HISTORY_TAIL_BYTES_PER_RECORD)
    with path.open("rb") as handle:
        while True:
            start = max(0, size - window)
            handle.seek(start)
            chunk = handle.read()
            if start:
                cut = chunk.find(b"\n")
                chunk = chunk[cut + 1:] if cut >= 0 else b""
            lines = chunk.splitlines()
            if len(lines) >= want or start == 0:
                return lines
            window = min(size, window * 4)


def load_history(limit=100):
    if not HISTORY_FILE.exists():
        return []
    want = max(1, int(limit))
    try:
        size = HISTORY_FILE.stat().st_size
        lines = _tail_lines(HISTORY_FILE, want, size)
    except OSError:
        return []
    recs = []
    for line in lines[-want:]:
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
    # Caller must hold download_jobs_lock. Atomic: a crash between truncate and
    # write used to empty the whole download queue, because the loader reads an
    # unparseable file as "no jobs".
    util.write_json_atomic(DOWNLOAD_JOBS_FILE, download_jobs, indent=2)


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
        # Bare paths. This used to carry the capability token in every URL, so
        # one saved /api/history response was a permanent key to the whole
        # library — and the token rode along into browser history and Referer
        # headers. Every real reader already authenticates its own fetch: the
        # studio proxies and the MCP send Authorization, and the pages served
        # from this origin have the cookie.
        out["image_urls"] = [f"/image/{util.safe_name(Path(p).name)}" for p in out["outputs"]]
    options = out.get("options")
    if isinstance(options, dict):
        out["options"] = {
            key: ("" if key.lower() in _PROMPT_TEXT_KEYS and isinstance(value, str) else value)
            for key, value in options.items()
        }
    return out
