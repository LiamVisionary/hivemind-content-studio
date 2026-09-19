#!/usr/bin/env python3
"""Re-encode a HEIC/HEIF picture from stdin as a JPEG on stdout.

The Media Studio MCP stages every inline or local reference picture into the
private Comfy input folder, and whichever lane loads it — the local one or a
rented GPU — runs ComfyUI with plain Pillow, which cannot open HEIC. Left as
the raw container, an iPhone photo fails the run at LoadImage, and from a
rented lane that comes back as a stripped error. So it is stored as a JPEG
instead, the same conversion the studio's upload route makes before sealing a
reference: orientation is baked into the pixels (pillow-heif applies the HEIF
orientation on decode and resets the tag; ImageOps.exif_transpose covers a
JPEG-style tag the same way), and the rest of the EXIF block — GPS
coordinates, device serials — is not carried over, which is the right default
for bytes that leave this host for a rented GPU at generate time.

Exit 0 with the JPEG on stdout; any other status with a one-line reason on
stderr and nothing on stdout. The reason never includes a path or the image.
"""

from __future__ import annotations

import io
import sys

JPEG_QUALITY = 92


def main() -> int:
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print("Pillow is not installed for the MCP's Python (set MEDIA_STUDIO_PYTHON to the project venv)", file=sys.stderr)
        return 2
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        print("pillow-heif is not installed for the MCP's Python (set MEDIA_STUDIO_PYTHON to the project venv)", file=sys.stderr)
        return 2

    data = sys.stdin.buffer.read()
    if not data:
        print("no image bytes on stdin", file=sys.stderr)
        return 2
    try:
        with Image.open(io.BytesIO(data)) as image:
            frame = ImageOps.exif_transpose(image.convert("RGB"))
            output = io.BytesIO()
            frame.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    except Exception as error:  # noqa: BLE001 - the one-line reason is the contract
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(output.getvalue())
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
