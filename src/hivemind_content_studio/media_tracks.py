"""The two halves of a finished clip: its sound without the picture, and its
picture without the sound.

A generated video is one file, and the first thing an editor does with it is
take it apart: the line goes under a different shot, or the shot goes over a
different score. Both halves are a remux away, and neither needs a model — so
they are separate from the stem splitter (packages/media-gateway/audio_split.py),
which does, and they work on a machine that has no GPU lane at all.

  * `audio`  -> 16-bit PCM WAV. Not a stream copy into .m4a, even though that
    would be smaller and bit-exact: WAV is the one format every timeline opens,
    the lanes do not agree on a codec (AAC from one, Opus in a WebM from
    another), and the stem splitter hands back WAV, so everything the download
    menu offers lays into the same project the same way.
  * `silent` -> the same container with the audio dropped and the video stream
    COPIED. Not one frame is re-encoded, so this is the picture exactly as it
    was generated.

Runs in the directory it is given and returns bytes: the caller
(api/bridge.py) owns the TemporaryDirectory and its lifetime, as it does for
the settings stamp.
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess

MODES = ("audio", "silent")
_TIMEOUT_SECONDS = 600


class TrackError(RuntimeError):
    """A refusal that is already a sentence for the person who asked."""


def _run(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, timeout=_TIMEOUT_SECONDS, check=False)


def has_audio(ffmpeg: str, source: pathlib.Path) -> bool:
    """Whether the file carries an audio stream.

    Asked of ffmpeg itself rather than ffprobe: the two ship together almost
    everywhere, but the studio only ever required the first. `-i` with no
    output exits non-zero and prints the stream table to stderr, which is all
    this needs.
    """
    probe = _run([ffmpeg, "-hide_banner", "-i", str(source)])
    return b"Audio:" in (probe.stderr or b"")


def extract(source: pathlib.Path, mode: str) -> tuple[bytes, str, str]:
    """(bytes, media type, file extension) for one half of `source`."""
    if mode not in MODES:
        raise TrackError("Unknown track.")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TrackError("ffmpeg is not installed on this machine, so the clip cannot be taken apart here.")

    if mode == "audio":
        if not has_audio(ffmpeg, source):
            raise TrackError("This clip has no sound.")
        target = source.with_name("track.wav")
        command = [ffmpeg, "-y", "-loglevel", "error", "-i", str(source), "-vn", "-c:a", "pcm_s16le", str(target)]
        media_type, extension = "audio/wav", ".wav"
    else:
        extension = source.suffix.lower() if source.suffix.lower() in (".mp4", ".mov", ".m4v", ".webm", ".mkv") else ".mp4"
        target = source.with_name(f"silent{extension}")
        command = [ffmpeg, "-y", "-loglevel", "error", "-i", str(source), "-an", "-c:v", "copy"]
        if extension in (".mp4", ".mov", ".m4v"):
            # The index up front, so the file plays before it has finished
            # arriving wherever it is sent next.
            command += ["-movflags", "+faststart"]
        command.append(str(target))
        media_type = {".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime"}.get(extension, "video/mp4")

    try:
        result = _run(command)
    except subprocess.TimeoutExpired as exc:
        raise TrackError("Taking this clip apart took too long and was stopped.") from exc
    if result.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
        raise TrackError("This clip could not be taken apart — its container may be damaged.")
    return target.read_bytes(), media_type, extension
