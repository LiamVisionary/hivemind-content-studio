"""Deterministic FFmpeg assembly and portable editor handoff."""

from __future__ import annotations

import csv
import shutil
import subprocess
from contextlib import ExitStack
from pathlib import Path
from typing import Any

from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, read_private_json, read_private_media, staged_private_media
from .qa import qa_video


def _run(command: list[str], *, timeout: int = 300) -> None:
    completed = subprocess.run(command, text=True, capture_output=True, timeout=timeout, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"FFmpeg assembly step failed with exit code {completed.returncode}")


def _timeline(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    artifact = next((item for item in manifest["artifacts"] if item["role"] == "editor-handoff"), None)
    if not artifact:
        raise ValueError("Run has no editor-handoff artifact")
    data = read_private_json(Path(artifact["path"]))
    return data.get("timeline", [])


def _quoted(path: Path) -> str:
    return str(path.resolve()).replace("'", "'\\''")


def assemble_run(manifest_path: str | Path, *, output: str | Path | None = None) -> dict[str, Any]:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg and ffprobe are required")
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    timeline = _timeline(manifest)
    keyframes = [Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "keyframe"]
    scene_videos = [Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "scene-video"]
    if not scene_videos and not keyframes:
        raise ValueError("Run needs scene-video or keyframe artifacts before assembly")
    work = manifest_file.parent / "assembly"
    work.mkdir(parents=True, exist_ok=True)
    try:
        with ExitStack() as stack:
            def staged(source: Path) -> Path:
                return stack.enter_context(staged_private_media(source, directory=work))

            clips: list[Path] = []
            if scene_videos:
                clips = [staged(video) for video in scene_videos]
            else:
                for index, frame in enumerate(keyframes, start=1):
                    duration = float(timeline[index - 1].get("duration_seconds") or 4) if index <= len(timeline) else 4.0
                    clip = work / f"scene-{index:03d}.mp4"
                    _run(
                        [
                            "ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", str(staged(frame)),
                            "-t", f"{max(0.25, duration):.3f}", "-r", "30", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(clip),
                        ]
                    )
                    clips.append(clip)
            concat = work / "video-concat.txt"
            concat.write_text("".join(f"file '{_quoted(clip)}'\n" for clip in clips), encoding="utf-8")
            silent = work / "silent.mp4"
            _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(silent)])

            voice_files = [Path(item["path"]) for item in manifest["artifacts"] if item["role"] == "voice-line"]
            destination = Path(output).expanduser().resolve() if output else manifest_file.parent / "final.mp4"
            if voice_files:
                audio_list = work / "audio-concat.txt"
                staged_voices = [staged(audio) for audio in voice_files]
                audio_list.write_text("".join(f"file '{_quoted(audio)}'\n" for audio in staged_voices), encoding="utf-8")
                audio = work / "voice.m4a"
                _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(audio_list), "-ar", "48000", "-ac", "2", "-c:a", "aac", str(audio)])
                _run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(silent), "-i", str(audio), "-c:v", "copy", "-af", "apad", "-shortest", "-c:a", "aac", str(destination)])
            else:
                shutil.copyfile(silent, destination)
        qa = qa_video(destination, output_dir=work / "qa", require_audio=bool(voice_files))
        if not qa["ok"]:
            raise RuntimeError("Assembled video failed technical QA: " + "; ".join(qa["failures"]))
        manifest["artifacts"] = [item for item in manifest["artifacts"] if item["role"] != "final-video"]
        add_artifact(manifest, role="final-video", path=destination, provider="moneyprinterturbo")
        write_manifest(manifest_file, manifest)
        if destination.is_relative_to(manifest_file.parent):
            encrypt_private_media(destination)
    finally:
        # The work dir holds decrypted intermediates; never leave them behind.
        shutil.rmtree(work, ignore_errors=True)
    return {"video": str(destination), "qa": qa, "provider": "ffmpeg"}


def _export_asset(path_value: str, destination: Path) -> str:
    """Materialise a possibly-encrypted asset as plaintext inside the handoff."""
    source = Path(path_value)
    if source.is_file():
        return str(source)
    assets_dir = destination / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    exported = assets_dir / source.name
    exported.write_bytes(read_private_media(source))
    return str(exported)


def export_capcut_handoff(manifest_path: str | Path, *, output_dir: str | Path | None = None) -> dict[str, str]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    destination = Path(output_dir).expanduser().resolve() if output_dir else manifest_file.parent / "capcut-handoff"
    destination.mkdir(parents=True, exist_ok=True)
    keyframes = [_export_asset(item["path"], destination) for item in manifest["artifacts"] if item["role"] == "keyframe"]
    videos = [_export_asset(item["path"], destination) for item in manifest["artifacts"] if item["role"] == "scene-video"]
    voices = [_export_asset(item["path"], destination) for item in manifest["artifacts"] if item["role"] == "voice-line"]
    timeline_csv = destination / "timeline.csv"
    elapsed = 0.0
    with timeline_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["scene", "start_seconds", "duration_seconds", "video", "keyframe", "voice", "overlay"])
        writer.writeheader()
        for index, item in enumerate(_timeline(manifest), start=1):
            duration = float(item.get("duration_seconds") or 4)
            writer.writerow({
                "scene": index,
                "start_seconds": f"{elapsed:.3f}",
                "duration_seconds": f"{duration:.3f}",
                "video": videos[index - 1] if index <= len(videos) else "",
                "keyframe": keyframes[index - 1] if index <= len(keyframes) else "",
                "voice": voices[index - 1] if index <= len(voices) else "",
                "overlay": item.get("overlay") or "",
            })
            elapsed += duration
    readme = destination / "README.md"
    readme.write_text(
        "# CapCut handoff\n\nImport the referenced assets, then use `timeline.csv` for order, timing, overlays, and voice placement. This portable handoff deliberately avoids CapCut's unstable private project database format.\n",
        encoding="utf-8",
    )
    return {"timeline_csv": str(timeline_csv), "readme": str(readme)}
