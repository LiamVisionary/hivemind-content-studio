"""How long a generation should take, learned from the ones already measured.

Moved out of control_api.py unchanged (2026-09-04). ``control_api`` re-exports
every name here, which is what keeps ``monkeypatch.setattr("…control_api.
_VIDEO_UNRESPONSIVE_CHECKS", 1)`` working: the video routes read those three
ceilings off the control_api module at call time, exactly as they did when the
routes lived in it.
"""

from __future__ import annotations

import contextlib
import json
import statistics
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from ..media_studio import video_dimensions_for_request
from .models import MediaStudioVideoBody  # noqa: F401 — the annotation below names it

# First-run fallback before any real duration is recorded, expressed per WORK
# UNIT (one frame-megapixel) so an unmeasured run still scales with its length
# and resolution: ~4.5 puts a 4-second 16:9 standard clip (97 frames at 0.34MP)
# near 150s, and the same clip at the high tier — 2.5x the pixels — near 375s.
_DEFAULT_VIDEO_SECONDS_PER_WORK_UNIT = 4.5

# When to stop believing a video job is still rendering. Deliberately generous:
# the gateway is a single-threaded server that a large upload can block for a
# while, and a false "it died" on a live render is worse than a slow true one.
# Read at call time so a test can shorten them.
_VIDEO_UNRESPONSIVE_CHECKS = 5
_VIDEO_UNRESPONSIVE_SECONDS = 30.0
_VIDEO_RECORD_PROBE_SECONDS = 10.0
_VIDEO_BACKEND_GONE = "The video backend stopped responding"


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
