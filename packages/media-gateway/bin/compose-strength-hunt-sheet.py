#!/usr/bin/env python3
"""Compose the labeled Strength Hunt comparison sheet (runs under the repo venv
for PIL, like compose-ingredients-sheet.py). Layout math lives in
strength_hunt.sheet_layout so it stays unit-testable without PIL.

Manifest JSON (stdin or --manifest):
  {
    "output": "/abs/path/sheet.png",
    "rows": 2, "cols": 3, "square": false,
    "header_lines": ["SEED 42 · CFG 1 · STEPS 10 · krea2", "AXIS style (MAX 0.6)", "prompt …"],
    "tiles": [{"path": "/abs/variant.png", "label": "style 0.4", "index": 0}, …]
  }

Adapted from Mix-Studio (BlackMixture/Mix-Studio, GPL-3.0) lib/strength-hunt.js
buildStrengthHuntSheet — PIL replaces their hand-rolled PNG codec + bitmap font.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strength_hunt import sheet_layout  # noqa: E402

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

BACKGROUND = (18, 18, 21)
HEADER_TEXT = (232, 230, 227)
LABEL_TEXT = (226, 181, 58)
TILE_BORDER = (58, 56, 51)


def load_font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has no sizable default font
        return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="path to the manifest JSON (default: stdin)")
    args = parser.parse_args()
    raw = Path(args.manifest).read_text() if args.manifest else sys.stdin.read()
    manifest = json.loads(raw)

    tiles = manifest.get("tiles") or []
    if not tiles:
        raise SystemExit("strength hunt sheet: no tiles")
    rows = int(manifest.get("rows") or 1)
    cols = int(manifest.get("cols") or len(tiles))

    first = Image.open(tiles[0]["path"])
    tile_aspect = first.width / max(1, first.height)
    layout = sheet_layout(rows, cols, tile_aspect, square=bool(manifest.get("square")), count=len(tiles))

    sheet = Image.new("RGB", (layout["width"], layout["height"]), BACKGROUND)
    draw = ImageDraw.Draw(sheet)

    header_font = load_font(26)
    label_font = load_font(max(14, layout["label_height"] - 18))
    y = 18
    for line in (manifest.get("header_lines") or [])[:4]:
        draw.text((layout["margin"], y), str(line)[:220], fill=HEADER_TEXT, font=header_font)
        y += 34

    for tile in tiles:
        index = int(tile.get("index") or 0)
        row, col = divmod(index, layout["cols"])
        x = layout["margin"] + col * (layout["tile_width"] + layout["gap"])
        y = layout["header_height"] + layout["margin"] + row * (
            layout["tile_height"] + layout["label_height"] + layout["gap"]
        )
        try:
            image = Image.open(tile["path"]).convert("RGB")
        except Exception:
            draw.rectangle(
                [x, y, x + layout["tile_width"], y + layout["tile_height"]],
                outline=TILE_BORDER, width=2,
            )
            draw.text((x + 12, y + 12), "missing", fill=LABEL_TEXT, font=label_font)
        else:
            image = image.resize((layout["tile_width"], layout["tile_height"]), Image.LANCZOS)
            sheet.paste(image, (x, y))
        draw.text(
            (x + 2, y + layout["tile_height"] + 6),
            str(tile.get("label") or "")[:60],
            fill=LABEL_TEXT,
            font=label_font,
        )

    output = Path(manifest["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG")
    print(json.dumps({"output": str(output), "width": sheet.width, "height": sheet.height}))


if __name__ == "__main__":
    main()
