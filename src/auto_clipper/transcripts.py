"""Transcript normalization for Podcli.

Podcli's public parser can understand VTT/SRT, but the current
`podcli process --transcript` path only accepts JSON or speaker-style text.
This module converts subtitle files to Podcli-compatible JSON while preserving
the cue timing from yt-dlp downloads.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def prepare_podcli_transcript(path: str | Path | None, output_dir: Path, *, total_duration: float | None = None) -> Path | None:
    if not path:
        return None
    source = Path(path).expanduser()
    if not source.is_file():
        return None

    suffix = source.suffix.lower()
    if suffix == ".json":
        return source
    if suffix not in {".vtt", ".srt"}:
        return source

    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"{source.stem}.podcli.json"
    payload = parse_subtitle_file(source, total_duration=total_duration)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return target


def parse_subtitle_file(path: Path, *, total_duration: float | None = None) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8-sig")
    suffix = path.suffix.lower()
    if suffix == ".vtt":
        blocks = parse_vtt(text)
    elif suffix == ".srt":
        blocks = parse_srt(text)
    else:
        raise ValueError(f"Unsupported subtitle format: {path}")
    if not blocks:
        raise ValueError(f"No subtitle blocks found in {path}")
    return blocks_to_podcli_json(blocks, total_duration=total_duration)


def parse_vtt(text: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    lines = text.splitlines()
    current_start: float | None = None
    current_end: float | None = None
    current_text: list[str] = []

    for raw in lines:
        line = raw.strip()
        ts = re.match(
            r"(?P<start>\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*"
            r"(?P<end>\d{1,2}:\d{2}(?::\d{2})?\.\d{3})",
            line,
        )
        if ts:
            _append_block(blocks, current_start, current_end, current_text)
            current_start = parse_vtt_timestamp(ts.group("start"))
            current_end = parse_vtt_timestamp(ts.group("end"))
            current_text = []
            continue

        if current_start is None:
            continue
        if not line:
            _append_block(blocks, current_start, current_end, current_text)
            current_start = None
            current_end = None
            current_text = []
            continue
        current_text.append(line)

    _append_block(blocks, current_start, current_end, current_text)
    return blocks


def parse_srt(text: str) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    current_start: float | None = None
    current_end: float | None = None
    current_text: list[str] = []

    for raw in text.splitlines():
        line = raw.strip()
        ts = re.match(
            r"(?P<start>\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*"
            r"(?P<end>\d{2}:\d{2}:\d{2},\d{3})",
            line,
        )
        if ts:
            _append_block(blocks, current_start, current_end, current_text)
            current_start = parse_srt_timestamp(ts.group("start"))
            current_end = parse_srt_timestamp(ts.group("end"))
            current_text = []
            continue

        if current_start is None:
            continue
        if not line:
            _append_block(blocks, current_start, current_end, current_text)
            current_start = None
            current_end = None
            current_text = []
            continue
        current_text.append(line)

    _append_block(blocks, current_start, current_end, current_text)
    return blocks


def parse_vtt_timestamp(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0


def parse_srt_timestamp(value: str) -> float:
    return parse_vtt_timestamp(value.replace(",", "."))


def blocks_to_podcli_json(blocks: list[dict[str, Any]], *, total_duration: float | None = None) -> dict[str, Any]:
    words: list[dict[str, Any]] = []
    segments: list[dict[str, Any]] = []

    for block in blocks:
        text = block["text"]
        block_words = text.split()
        if not block_words:
            continue
        start = float(block["start"])
        end = float(block["end"])
        duration = max(0.001, end - start)
        word_duration = duration * 0.95 / len(block_words)

        for idx, word in enumerate(block_words):
            word_start = start + idx * word_duration
            word_end = word_start + word_duration * 0.9
            words.append(
                {
                    "word": word,
                    "start": round(word_start, 3),
                    "end": round(word_end, 3),
                    "speaker": None,
                }
            )

        segments.append(
            {
                "text": text,
                "start": round(start, 3),
                "end": round(end, 3),
                "speaker": None,
            }
        )

    duration = total_duration or (float(blocks[-1]["end"]) if blocks else 0.0)
    return {
        "transcript": " ".join(word["word"] for word in words),
        "words": words,
        "segments": segments,
        "duration": round(duration, 2),
        "language": "en",
        "speakers": [],
        "speaker_segments": [],
        "imported": True,
        "format": "json",
    }


def _append_block(
    blocks: list[dict[str, Any]],
    start: float | None,
    end: float | None,
    text_lines: list[str],
) -> None:
    if start is None or end is None or not text_lines:
        return
    text = " ".join(text_lines)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text:
        blocks.append({"start": start, "end": end, "text": text})
