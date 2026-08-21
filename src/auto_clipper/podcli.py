"""Podcli process wrapper.

The command shape is adapted from nmbrthirteen/podcli's documented CLI:
`podcli process <video> --top N --caption-style STYLE --output DIR`.
"""

from __future__ import annotations

import json
import os
import pty
import re
import select
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from . import db, rerank, titles
from .config import Config
from .transcripts import prepare_podcli_transcript

CAPTION_STYLES = {"branded", "branded-legacy", "hormozi", "karaoke", "subtle"}


def render_run(
    conn,
    cfg: Config,
    source_id: int,
    *,
    top: int,
    style: str,
    category: str | None = None,
) -> int:
    if style not in CAPTION_STYLES:
        raise ValueError(f"Unsupported style {style!r}. Choose one of: {', '.join(sorted(CAPTION_STYLES))}")
    source = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    if source is None:
        raise ValueError(f"Source {source_id} does not exist")
    input_path = source["local_path"] or source["source_ref"]
    output_dir = cfg.data_dir / "runs" / f"source-{source_id:04d}"
    output_dir.mkdir(parents=True, exist_ok=True)

    transcript = prepare_podcli_transcript(
        source["transcript_path"],
        output_dir,
        total_duration=source["duration_seconds"],
    )
    command = build_command(cfg, input_path=input_path, top=top, style=style, output_dir=output_dir, transcript=transcript)
    run_id = db.create_run(
        conn,
        source_id=source_id,
        top_n=top,
        style=style,
        output_dir=str(output_dir),
        podcli_command=" ".join(shlex.quote(part) for part in command),
        category=category,
    )

    if os.environ.get("AUTO_CLIPPER_FAKE_RENDER") == "1":
        _fake_clips(conn, run_id, output_dir, top)
        db.set_run_status(conn, run_id, "rendered")
        enrich_run(conn, cfg, run_id, output_dir=output_dir, category=category)
        return run_id

    if not is_podcli_available(cfg):
        db.set_run_status(conn, run_id, "render_failed")
        raise FileNotFoundError(
            "Podcli was not found. Run scripts/install_podcli.sh or set PODCLI_BIN to an audited Podcli executable."
        )

    log_path = output_dir / f"run-{run_id:04d}.log"
    result = run_podcli_command(command, timeout=7200)
    log_path.write_text(
        "COMMAND\n" + " ".join(shlex.quote(part) for part in command) + "\n\nSTDOUT\n" + result.stdout + "\n\nSTDERR\n" + result.stderr,
        encoding="utf-8",
    )
    if result.returncode != 0:
        db.set_run_status(conn, run_id, "render_failed")
        raise RuntimeError(f"Podcli failed with exit code {result.returncode}. See {log_path}")

    created = import_podcli_outputs(conn, run_id, output_dir, result.stdout, transcript=transcript)
    db.set_run_status(conn, run_id, "rendered" if created else "rendered_no_clips")
    if created:
        enrich_run(conn, cfg, run_id, output_dir=output_dir, category=category)
    return run_id


def enrich_run(
    conn,
    cfg: Config,
    run_id: int,
    *,
    output_dir: Path,
    category: str | None = None,
) -> dict[str, dict]:
    """Score the candidates and write their hooks.

    Runs after the render is already recorded as `rendered`, and both steps
    swallow their own failures, so a missing or broken LLM can never cost us a
    render we already paid for.
    """
    ranked = rerank.rerank_run(
        conn, cfg, run_id, category=category, output_dir=output_dir
    )
    written = titles.generate_titles(
        conn, cfg, run_id, category=category, output_dir=output_dir
    )
    return {"rerank": ranked, "titles": written}


def build_command(
    cfg: Config,
    *,
    input_path: str,
    top: int,
    style: str,
    output_dir: Path,
    transcript: Path | None = None,
) -> list[str]:
    template = cfg.podcli_command_template
    transcript_arg = f"--transcript {shlex.quote(str(transcript))}" if transcript else ""
    template_uses_transcript = (
        "{transcript_arg}" in template or "{transcript_path}" in template or "--transcript" in template
    )
    rendered = template.format(
        podcli=shlex.quote(cfg.podcli_bin),
        input=shlex.quote(input_path),
        top=top,
        style=style,
        output_dir=shlex.quote(str(output_dir)),
        transcript_path=shlex.quote(str(transcript)) if transcript else "",
        transcript_arg=transcript_arg,
    )
    if transcript_arg and not template_uses_transcript:
        rendered = f"{rendered} {transcript_arg}"
    return shlex.split(rendered)


def is_podcli_available(cfg: Config) -> bool:
    candidate = Path(cfg.podcli_bin).expanduser()
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return True
    return shutil.which(cfg.podcli_bin) is not None


def run_podcli_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    """Run Podcli with a PTY so its questionary review prompt can accept Enter.

    Podcli currently always opens an interactive review picker after selecting
    clips. Hermes and this CLI run it as a background process, so a normal pipe
    causes prompt_toolkit to crash. A PTY plus one Enter chooses the default
    "Render selected clips" option without changing Podcli itself.
    """
    if os.name != "posix":
        return subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)

    master_fd, slave_fd = pty.openpty()
    proc = subprocess.Popen(command, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True)
    os.close(slave_fd)

    output = bytearray()
    sent_confirm = False
    deadline = time.monotonic() + timeout

    try:
        while True:
            if time.monotonic() > deadline:
                proc.kill()
                return subprocess.CompletedProcess(command, 124, output.decode("utf-8", errors="replace"), "timeout")

            ready, _, _ = select.select([master_fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(master_fd, 8192)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)

            text_tail = output[-5000:].decode("utf-8", errors="replace").lower()
            if not sent_confirm and "clips selected" in text_tail and "render" in text_tail:
                time.sleep(0.3)
                os.write(master_fd, b"\r")
                sent_confirm = True

            if proc.poll() is not None:
                while True:
                    ready, _, _ = select.select([master_fd], [], [], 0)
                    if not ready:
                        break
                    try:
                        chunk = os.read(master_fd, 8192)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                decoded = output.decode("utf-8", errors="replace")
                return subprocess.CompletedProcess(command, proc.returncode or 0, decoded, "")
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


def import_podcli_outputs(
    conn,
    run_id: int,
    output_dir: Path,
    stdout: str,
    transcript: Path | None = None,
) -> int:
    count = 0
    json_candidates = _json_objects(stdout)
    for idx, payload in enumerate(json_candidates, start=1):
        if not isinstance(payload, dict):
            continue
        clips = payload.get("clips") if isinstance(payload.get("clips"), list) else [payload]
        for clip in clips:
            if not isinstance(clip, dict):
                continue
            output = clip.get("output_path") or clip.get("path") or clip.get("file")
            slug = clip.get("slug") or f"clip-{count + 1:02d}"
            db.add_clip(
                conn,
                run_id=run_id,
                slug=str(slug),
                start_seconds=_number_or_none(clip.get("start") or clip.get("start_seconds")),
                end_seconds=_number_or_none(clip.get("end") or clip.get("end_seconds")),
                score=_number_or_none(clip.get("score")),
                rationale=clip.get("rationale") or clip.get("reason"),
                transcript_excerpt=clip.get("transcript") or clip.get("excerpt"),
                output_path=str(output) if output else None,
                status="rendered",
            )
            count += 1

    if count:
        return count

    # Podcli writes no machine-readable manifest, but it does print its
    # selection. Parsing that is the difference between knowing a clip's range
    # and its opening line, and importing a directory listing blind.
    selected = parse_selected_clips(stdout)
    videos = rendered_clip_files(output_dir)
    segments = _transcript_segments(transcript)

    if selected and videos:
        for idx, entry in enumerate(selected, start=1):
            path = _match_clip_file(entry["text"], videos)
            # Podcli only prints the first ~50 characters of the opening line,
            # truncated mid-word. Recover the clip's real text from the
            # transcript we handed it, so the semantic pass scores and writes
            # hooks from what is actually said rather than from a fragment.
            excerpt = _excerpt_for_range(
                segments, entry["start_seconds"], entry["end_seconds"]
            ) or entry["text"]
            db.add_clip(
                conn,
                run_id=run_id,
                slug=f"clip-{idx:02d}",
                start_seconds=entry["start_seconds"],
                end_seconds=entry["end_seconds"],
                score=entry["score"],
                rationale=f"Podcli heuristic selection ({entry['raw_score']}).",
                transcript_excerpt=excerpt,
                output_path=str(path) if path else None,
                status="rendered",
            )
            count += 1
        return count

    for idx, path in enumerate(videos, start=1):
        db.add_clip(
            conn,
            run_id=run_id,
            slug=f"clip-{idx:02d}",
            output_path=str(path),
            status="rendered",
            rationale="Imported from Podcli output directory.",
        )
        count += 1
    return count


_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
# "  ✓ 1. [1:36 → +37s] (14/20) And then you spend seven months pretending you don"
_SELECTED = re.compile(
    r"[✓✔]\s*(?P<index>\d+)\.\s*"
    r"\[(?P<start>(?:\d+:)?\d+:\d+)\s*(?:→|->)\s*\+(?P<duration>\d+(?:\.\d+)?)s\]\s*"
    r"\((?P<score>[^)]*)\)\s*(?P<text>.*)"
)
# Everything Podcli leaves behind that is not a finished clip: the pre-outro
# intermediate it keeps beside each render, and the per-clip thumbnail frames.
_NOT_A_CLIP = ("outro_scaled", "_with_thumb", "thumb_frame")


def parse_selected_clips(stdout: str) -> list[dict]:
    """Recover Podcli's own picks — range, heuristic score, opening line."""
    entries: list[dict] = []
    for line in _ANSI.sub("", stdout).splitlines():
        match = _SELECTED.search(line)
        if not match:
            continue
        start = _clock_to_seconds(match.group("start"))
        if start is None:
            continue
        duration = float(match.group("duration"))
        raw_score = match.group("score").strip()
        entries.append(
            {
                "index": int(match.group("index")),
                "start_seconds": start,
                "end_seconds": start + duration,
                "score": _normalize_heuristic_score(raw_score),
                "raw_score": raw_score,
                "text": match.group("text").strip(),
            }
        )
    entries.sort(key=lambda entry: entry["index"])
    return entries


def rendered_clip_files(output_dir: Path) -> list[Path]:
    """Finished clips only.

    A bare `rglob("*.mp4")` also returns Podcli's pre-outro intermediates and
    its per-clip thumbnail frames, which is how a `--top 3` run produced nine
    clip rows — and how a thumbnail frame could reach an approval queue.
    """
    return sorted(
        path
        for path in output_dir.rglob("*.mp4")
        if path.is_file() and not any(marker in path.name for marker in _NOT_A_CLIP)
    )


def _transcript_segments(transcript: Path | None) -> list[dict]:
    """Timed segments from the JSON we generated for Podcli, if we have it."""
    if transcript is None:
        return []
    try:
        payload = json.loads(Path(transcript).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    segments = payload.get("segments")
    return segments if isinstance(segments, list) else []


def _excerpt_for_range(segments: list[dict], start: float, end: float) -> str | None:
    """Every segment that overlaps the clip, joined in order."""
    if not segments:
        return None
    spoken: list[str] = []
    for segment in segments:
        try:
            seg_start = float(segment.get("start"))
            seg_end = float(segment.get("end"))
        except (TypeError, ValueError):
            continue
        if seg_end <= start or seg_start >= end:
            continue
        text = str(segment.get("text") or "").strip()
        if text:
            spoken.append(text)
    return " ".join(spoken) or None


def _clock_to_seconds(value: str) -> float | None:
    parts = value.split(":")
    try:
        numbers = [int(part) for part in parts]
    except ValueError:
        return None
    if len(numbers) == 2:
        return float(numbers[0] * 60 + numbers[1])
    if len(numbers) == 3:
        return float(numbers[0] * 3600 + numbers[1] * 60 + numbers[2])
    return None


def _normalize_heuristic_score(raw: str) -> float | None:
    """Podcli reports either `14/20` or `10pts`. Only the fraction has a scale."""
    fraction = re.match(r"^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*$", raw)
    if not fraction:
        return None
    numerator, denominator = float(fraction.group(1)), float(fraction.group(2))
    if denominator <= 0:
        return None
    return max(0.0, min(1.0, numerator / denominator))


def _match_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _match_clip_file(text: str, videos: list[Path]) -> Path | None:
    """Podcli names each file after the clip's opening line, so the line matches it."""
    wanted = _match_key(text)
    if not wanted:
        return None
    for path in videos:
        stem = _match_key(path.stem.removesuffix("_short"))
        if not stem:
            continue
        shortest = min(len(stem), len(wanted))
        if shortest >= 12 and stem[:shortest] == wanted[:shortest]:
            return path
    return None


def _json_objects(text: str) -> list[dict]:
    objects: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            objects.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return objects


def _number_or_none(value) -> float | None:
    if value in {None, ""}:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fake_clips(conn, run_id: int, output_dir: Path, top: int) -> None:
    for idx in range(1, top + 1):
        db.add_clip(
            conn,
            run_id=run_id,
            slug=f"clip-{idx:02d}",
            start_seconds=float((idx - 1) * 60),
            end_seconds=float((idx - 1) * 60 + 45),
            score=1.0 - (idx * 0.01),
            rationale="Fake render candidate for tests and dry-run workflow checks.",
            transcript_excerpt="Placeholder transcript excerpt.",
            output_path=str(output_dir / f"clip-{idx:02d}.mp4"),
            status="rendered",
        )
