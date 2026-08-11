"""Small poster images for saved media references.

A reference's thumbnail used to BE the reference: the picker pointed a 32px tile
at the sealed original, so the browser downloaded and decrypted the whole asset
to draw it. For a 62 MB screen recording that is 62 MB of transfer and AES-GCM
per tile, which is why a panel of six clips took seconds to fill in.

A poster is built once, at upload, while the server still holds the plaintext —
after sealing it never can again, because the vault key is the browser's alone.
That is also the limitation: references sealed BEFORE this existed cannot be
given a poster server-side. The browser backfills those, since it is the only
party that can read them (see the reference poster upload route).

Posters are sealed exactly like the reference they belong to, so nothing about
the privacy contract changes — the host still cannot read either one.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# Wide enough to stay sharp on a retina 36px row and in the 2x-density saved
# list, small enough that the decrypt is instant.
POSTER_WIDTH = 320
POSTER_SUFFIX = ".poster.jpg"
POSTER_MEDIA_TYPE = "image/jpeg"
# A poster that is not obviously a poster is a bug waiting to happen; anything
# larger than this from the browser backfill is refused.
MAX_POSTER_BYTES = 512 * 1024

# Video routinely opens on black — a fade-in, a slate, a screen recording's
# first compositor frame — so a poster taken at 0s is a black rectangle as
# uninformative as the icon it replaces. The browser-side extractor uses the
# same offset for the same reason.
POSTER_SECONDS = 0.35


def poster_path_for(reference: str | Path) -> Path:
    """Where the poster for `reference` lives (plaintext path; it gets sealed)."""
    target = Path(reference)
    return target.with_name(f"{target.stem}{POSTER_SUFFIX}")


def is_poster_name(name: str) -> bool:
    return str(name).endswith(POSTER_SUFFIX)


def poster_owner_stem(name: str) -> str | None:
    """The stem of the reference a poster belongs to, or None if not a poster.

    A poster replaces its reference's extension (`ref-ab12.mp4` becomes
    `ref-ab12.poster.jpg`), so the stem is what ties the two together — the
    caller matches it against the references it has indexed.
    """
    return str(name)[: -len(POSTER_SUFFIX)] if is_poster_name(name) else None


def build_image_poster(source: Path, destination: Path) -> bool:
    try:
        from PIL import Image
    except Exception:
        return False
    try:
        with Image.open(source) as image:
            image.draft("RGB", (POSTER_WIDTH * 2, POSTER_WIDTH * 2))
            frame = image.convert("RGB")
            frame.thumbnail((POSTER_WIDTH, POSTER_WIDTH))
            frame.save(destination, format="JPEG", quality=80, optimize=True)
        return destination.is_file() and destination.stat().st_size > 0
    except Exception:
        destination.unlink(missing_ok=True)
        return False


def build_video_poster(source: Path, destination: Path) -> bool:
    if not shutil.which("ffmpeg"):
        return False
    # -ss before -i seeks by keyframe, which is both fast and enough: the poster
    # only has to be representative, not frame-exact.
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", str(POSTER_SECONDS),
        "-i", str(source),
        "-frames:v", "1",
        "-vf", f"scale={POSTER_WIDTH}:-2:flags=bicubic",
        "-q:v", "4",
        str(destination),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=30)
    except Exception:
        destination.unlink(missing_ok=True)
        # A clip shorter than the seek offset yields no frame; take the very
        # first one rather than leaving the reference with no poster at all.
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
                 "-frames:v", "1", "-vf", f"scale={POSTER_WIDTH}:-2", "-q:v", "4", str(destination)],
                check=True, capture_output=True, timeout=30,
            )
        except Exception:
            destination.unlink(missing_ok=True)
            return False
    return destination.is_file() and destination.stat().st_size > 0


def build_reference_poster(source: Path, *, kind: str) -> Path | None:
    """Build the poster for a still-plaintext reference. None when there is
    nothing to show (a voice clip) or the media could not be decoded."""
    if kind not in {"image", "video"}:
        return None
    destination = poster_path_for(source)
    built = build_image_poster(source, destination) if kind == "image" else build_video_poster(source, destination)
    return destination if built else None
