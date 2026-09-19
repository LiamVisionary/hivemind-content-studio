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

# Formats the browser cannot draw. Chromium (and so the desktop app) has no
# HEIC/HEIF decoder, and neither does a stock ComfyUI (its requirements pin
# Pillow alone) — so an iPhone photo stored as-is would draw as a broken tile
# AND fail inside the lane's LoadImage at generate time. Such an upload is
# re-encoded to JPEG while the plaintext is still here; see
# `transcode_opaque_image`.
OPAQUE_IMAGE_SUFFIXES = frozenset({".heic", ".heif"})
TRANSCODED_SUFFIX = ".jpg"
TRANSCODE_QUALITY = 92

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


_PLUGINS_REGISTERED = False


def _register_image_plugins() -> None:
    """Teach Pillow the containers phones upload in. Pillow decodes HEIC/HEIF
    only through pillow-heif, and only once its opener is registered — the
    package being installed is not enough, which is how an iPhone upload got a
    silent `None` poster here while qa.py could read the same file fine."""
    global _PLUGINS_REGISTERED
    if _PLUGINS_REGISTERED:
        return
    _PLUGINS_REGISTERED = True
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except Exception:
        # Without the plugin HEIC simply stays undecodable here, and the
        # callers already treat that as "no poster" / "leave the file as it is".
        pass


def build_image_poster(source: Path, destination: Path) -> bool:
    try:
        from PIL import Image, ImageOps
    except Exception:
        return False
    _register_image_plugins()
    try:
        with Image.open(source) as image:
            image.draft("RGB", (POSTER_WIDTH * 2, POSTER_WIDTH * 2))
            # Browsers draw a JPEG the way its EXIF orientation says; a poster
            # that ignores it shows a phone portrait lying on its side next to
            # the upright original. (pillow-heif already applies the HEIF
            # orientation on decode and resets the tag, so this is a no-op there.)
            frame = ImageOps.exif_transpose(image.convert("RGB"))
            frame.thumbnail((POSTER_WIDTH, POSTER_WIDTH))
            frame.save(destination, format="JPEG", quality=80, optimize=True)
        return destination.is_file() and destination.stat().st_size > 0
    except Exception:
        destination.unlink(missing_ok=True)
        return False


def transcode_opaque_image(source: Path) -> Path | None:
    """Re-encode a HEIC/HEIF reference as a JPEG sibling and remove the original.

    Returns the JPEG path, or None when the file is not one of those formats or
    could not be decoded — in which case the caller keeps the original as-is,
    exactly as before. Orientation is baked into the pixels (the browser and the
    lane then agree on which way is up); the rest of the EXIF block — GPS
    coordinates, device serials — is not carried over, which is the right
    default for bytes that leave this host for a rented GPU at generate time.
    Must run before sealing: afterwards this host can never read the file again.
    """
    if Path(source).suffix.lower() not in OPAQUE_IMAGE_SUFFIXES:
        return None
    try:
        from PIL import Image, ImageOps
    except Exception:
        return None
    _register_image_plugins()
    destination = Path(source).with_suffix(TRANSCODED_SUFFIX)
    try:
        with Image.open(source) as image:
            frame = ImageOps.exif_transpose(image.convert("RGB"))
            frame.save(destination, format="JPEG", quality=TRANSCODE_QUALITY, optimize=True)
        if not (destination.is_file() and destination.stat().st_size > 0):
            destination.unlink(missing_ok=True)
            return None
    except Exception:
        destination.unlink(missing_ok=True)
        return None
    Path(source).unlink(missing_ok=True)
    return destination


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
