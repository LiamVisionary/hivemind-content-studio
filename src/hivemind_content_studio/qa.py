"""Technical render QA shared by every video lane."""

from __future__ import annotations

import json
import shutil
import subprocess
import mimetypes
from pathlib import Path
from typing import Any

from PIL import Image

# Pillow 10 cannot decode AVIF/HEIC on its own; these plugins register the
# decoders so reference uploads in modern formats pass technical QA.
try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass
try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass


def qa_asset(path: str | Path, *, output_dir: str | Path | None = None) -> dict[str, Any]:
    asset = Path(path).expanduser().resolve()
    media_type = mimetypes.guess_type(asset.name)[0] or ""
    if media_type.startswith("video/"):
        return {"kind": "video", **qa_video(asset, output_dir=output_dir)}
    if media_type.startswith("image/"):
        return {"kind": "image", **qa_image(asset)}
    return {"kind": "unknown", "ok": False, "path": str(asset), "failures": ["unsupported publish media type"]}


def qa_image(path: str | Path) -> dict[str, Any]:
    image_path = Path(path).expanduser().resolve()
    if not image_path.is_file() or image_path.stat().st_size <= 0:
        return {"ok": False, "path": str(image_path), "failures": ["image file is missing or empty"]}
    try:
        with Image.open(image_path) as image:
            image.verify()
        with Image.open(image_path) as image:
            width, height = image.size
            image_format = image.format
    except Exception:
        return {"ok": False, "path": str(image_path), "failures": ["image could not be decoded"]}
    return {
        "ok": width > 0 and height > 0,
        "path": str(image_path),
        "size_bytes": image_path.stat().st_size,
        "width": width,
        "height": height,
        "format": image_format,
        "visual_inspection_required": True,
        "failures": [],
    }


def qa_video(video: str | Path, *, output_dir: str | Path | None = None, require_audio: bool = True) -> dict[str, Any]:
    video_path = Path(video).expanduser().resolve()
    failures: list[str] = []
    if not video_path.is_file() or video_path.stat().st_size <= 0:
        return {"ok": False, "video": str(video_path), "failures": ["video file is missing or empty"]}
    if not shutil.which("ffprobe") or not shutil.which("ffmpeg"):
        return {"ok": False, "video": str(video_path), "failures": ["ffprobe and ffmpeg are required"]}

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=index,codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", str(video_path)],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if probe.returncode != 0:
        return {"ok": False, "video": str(video_path), "failures": ["ffprobe could not read the video"]}
    metadata = json.loads(probe.stdout)
    streams = metadata.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    try:
        duration = float(metadata.get("format", {}).get("duration", 0))
    except (TypeError, ValueError):
        duration = 0
    if not video_streams:
        failures.append("video stream missing")
    if require_audio and not audio_streams:
        failures.append("audio stream missing")
    if duration <= 0:
        failures.append("duration is not positive")

    frame_dir = Path(output_dir).expanduser().resolve() if output_dir else video_path.parent / "qa"
    frame_dir.mkdir(parents=True, exist_ok=True)
    frame = frame_dir / f"{video_path.stem}-middle.jpg"
    timestamp = max(0.0, min(duration / 2, max(0.0, duration - 0.05)))
    extract = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{timestamp:.3f}", "-i", str(video_path), "-frames:v", "1", str(frame)],
        text=True,
        capture_output=True,
        timeout=90,
        check=False,
    )
    if extract.returncode != 0 or not frame.is_file() or frame.stat().st_size < 512:
        failures.append("representative frame extraction failed or produced an unreadable frame")

    primary = video_streams[0] if video_streams else {}
    return {
        "ok": not failures,
        "video": str(video_path),
        "size_bytes": video_path.stat().st_size,
        "duration_seconds": duration,
        "width": primary.get("width"),
        "height": primary.get("height"),
        "video_codec": primary.get("codec_name"),
        "audio_codecs": [stream.get("codec_name") for stream in audio_streams],
        "representative_frame": str(frame) if frame.exists() else None,
        "visual_inspection_required": True,
        "failures": failures,
    }
