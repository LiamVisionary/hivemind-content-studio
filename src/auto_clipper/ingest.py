"""Source ingestion.

The yt-dlp options are adapted from Tahactw/AI-YOUTUBE-SHORTS'
YouTube service: quiet metadata extraction, retries, browser-like user agent,
and bounded quality to keep local processing sane.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

from . import db
from .config import Config
from .media import duration_seconds


def is_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def slugify(value: str, fallback: str = "source") -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip(".-")
    return safe[:80] or fallback


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _yt_dlp_options(output_dir: Path, metadata_only: bool) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 60,
        "http_chunk_size": 10_485_760,
        "user_agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "referer": "https://www.youtube.com/",
        "extractor_retries": 3,
        "file_access_retries": 3,
        "fragment_retries": 3,
        "writeinfojson": True,
        "writethumbnail": True,
        "writeautomaticsub": True,
        "writesubtitles": True,
        "subtitleslangs": ["en.*", "en"],
        "subtitlesformat": "vtt/best",
        "outtmpl": str(output_dir / "source.%(ext)s"),
    }
    if not metadata_only:
        opts["format"] = "bv*[height<=1080]+ba/best[height<=1080]/best"
        opts["merge_output_format"] = "mp4"
    return opts


def ingest_source(
    conn,
    cfg: Config,
    source_ref: str,
    *,
    creator: str,
    metadata_only: bool = False,
) -> int:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    if is_url(source_ref):
        return _ingest_url(conn, cfg, source_ref, creator=creator, metadata_only=metadata_only)
    return _ingest_file(conn, cfg, source_ref, creator=creator)


def _ingest_file(conn, cfg: Config, source_ref: str, *, creator: str) -> int:
    path = Path(source_ref).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Local source file not found: {path}")

    source_dir = cfg.data_dir / "sources" / slugify(path.stem)
    source_dir.mkdir(parents=True, exist_ok=True)
    copied = source_dir / path.name
    if copied != path:
        shutil.copy2(path, copied)

    metadata = {
        "title": path.stem,
        "source_type": "file",
        "original_path": str(path),
        "local_path": str(copied),
    }
    metadata_path = source_dir / "metadata.json"
    _write_json(metadata_path, metadata)
    return db.add_source(
        conn,
        source_ref=str(path),
        source_type="file",
        creator=creator,
        title=path.stem,
        duration_seconds=duration_seconds(copied),
        local_path=str(copied),
        metadata_path=str(metadata_path),
        thumbnail_path=None,
        transcript_path=None,
        provenance={"ingested_by": "auto-clipper", "mode": "local_file_copy"},
    )


def _ingest_url(conn, cfg: Config, url: str, *, creator: str, metadata_only: bool) -> int:
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError("yt-dlp is required for URL ingestion. Run: python -m pip install -e .") from exc

    source_dir = cfg.data_dir / "sources" / slugify(creator) / slugify(urlparse(url).path or "url")
    source_dir.mkdir(parents=True, exist_ok=True)
    opts = _yt_dlp_options(source_dir, metadata_only=metadata_only)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=not metadata_only)

    prepared = Path(ydl.prepare_filename(info))
    local_path = None if metadata_only else _find_downloaded_video(source_dir, prepared)
    metadata_path = source_dir / "metadata.json"
    _write_json(metadata_path, _serializable_info(info, url=url, local_path=local_path))
    thumbnail = _first_existing(source_dir, ["source.webp", "source.jpg", "source.png", "source.jpeg"])
    transcript = _first_existing_transcript(source_dir)
    return db.add_source(
        conn,
        source_ref=url,
        source_type="url",
        creator=creator,
        title=info.get("title") or url,
        duration_seconds=info.get("duration"),
        local_path=str(local_path) if local_path else None,
        metadata_path=str(metadata_path),
        thumbnail_path=str(thumbnail) if thumbnail else info.get("thumbnail"),
        transcript_path=str(transcript) if transcript else None,
        provenance={
            "ingested_by": "auto-clipper",
            "mode": "yt-dlp",
            "metadata_only": metadata_only,
            "extractor": info.get("extractor_key"),
            "webpage_url": info.get("webpage_url") or url,
        },
    )


def _find_downloaded_video(source_dir: Path, prepared: Path) -> Path | None:
    if prepared.exists() and prepared.suffix.lower() not in {".json", ".webp", ".jpg", ".png"}:
        return prepared
    candidates = [
        p
        for p in source_dir.glob("source.*")
        if p.suffix.lower() not in {".json", ".webp", ".jpg", ".jpeg", ".png", ".description"}
    ]
    return candidates[0] if candidates else None


def _first_existing(source_dir: Path, names: list[str]) -> Path | None:
    for name in names:
        path = source_dir / name
        if path.exists():
            return path
    return None


def _first_existing_transcript(source_dir: Path) -> Path | None:
    candidates = sorted(
        p
        for p in source_dir.glob("source.*")
        if p.suffix.lower() in {".vtt", ".srt", ".json"} and not p.name.endswith(".info.json")
    )
    return candidates[0] if candidates else None


def _serializable_info(info: dict, *, url: str, local_path: Path | None) -> dict:
    allowed = {
        "id",
        "title",
        "description",
        "duration",
        "thumbnail",
        "uploader",
        "channel",
        "view_count",
        "webpage_url",
        "extractor_key",
        "upload_date",
    }
    payload = {key: info.get(key) for key in allowed if key in info}
    payload["source_url"] = url
    if local_path:
        payload["local_path"] = str(local_path)
    return payload
