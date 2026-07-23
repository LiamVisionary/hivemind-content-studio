#!/usr/bin/env python3
"""Compose untouched reference views into an Ingredients IC-LoRA contact sheet."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

try:
    import pillow_avif  # noqa: F401
except ImportError:
    pass

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:
    pass

from PIL import Image, ImageFilter, ImageOps


def model_scale_gutter(width: int | None, height: int | None) -> int:
    if width is None or height is None:
        return 24
    return max(2, round(min(width, height) / 112))


def grid_shape(
    count: int,
    *,
    width: int | None = None,
    height: int | None = None,
    gutter: int = 0,
    aspect_ratios: list[float] | None = None,
) -> tuple[int, int]:
    if width is None or height is None:
        columns = math.ceil(math.sqrt(count))
        return columns, math.ceil(count / columns)

    candidates: list[tuple[float, int, int]] = []
    for columns in range(1, count + 1):
        rows = math.ceil(count / columns)
        cell_width = (width - (columns + 1) * gutter) / columns
        cell_height = (height - (rows + 1) * gutter) / rows
        if cell_width <= 0 or cell_height <= 0:
            continue
        empty_cells = columns * rows - count
        if aspect_ratios:
            used_area = 0.0
            for aspect_ratio in aspect_ratios:
                fitted_width = min(cell_width, cell_height * aspect_ratio)
                fitted_height = min(cell_height, cell_width / aspect_ratio)
                used_area += fitted_width * fitted_height
            coverage_penalty = 1.0 - used_area / (width * height)
            candidates.append((coverage_penalty + empty_cells * 0.01, columns, rows))
        else:
            square_penalty = abs(math.log(cell_width / cell_height))
            candidates.append((square_penalty + empty_cells * 0.18, columns, rows))
    if not candidates:
        raise ValueError("canvas is too small for the requested ingredient grid")
    _, columns, rows = min(candidates)
    return columns, rows


def panel_position(row: int, column: int, rows: int, columns: int) -> str:
    vertical = "top" if row == 0 else "bottom" if row == rows - 1 else "middle"
    horizontal = "left" if column == 0 else "right" if column == columns - 1 else "center"
    if columns > 3:
        row_name = f"{vertical} row" if rows > 1 else "row"
        return f"{row_name}, column {column + 1} of {columns}"
    if rows == 1:
        return horizontal
    if columns == 1:
        return vertical
    return f"{vertical} {horizontal}"


def _prune_free_rectangles(rectangles: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    unique = list(dict.fromkeys(rect for rect in rectangles if rect[2] > 0 and rect[3] > 0))
    return [
        rect
        for index, rect in enumerate(unique)
        if not any(
            index != other_index
            and rect[0] >= other[0]
            and rect[1] >= other[1]
            and rect[0] + rect[2] <= other[0] + other[2]
            and rect[1] + rect[3] <= other[1] + other[3]
            for other_index, other in enumerate(unique)
        )
    ]


def _split_free_rectangles(
    rectangles: list[tuple[int, int, int, int]],
    used: tuple[int, int, int, int],
) -> list[tuple[int, int, int, int]]:
    ux, uy, uw, uh = used
    split: list[tuple[int, int, int, int]] = []
    for fx, fy, fw, fh in rectangles:
        if ux >= fx + fw or ux + uw <= fx or uy >= fy + fh or uy + uh <= fy:
            split.append((fx, fy, fw, fh))
            continue
        if ux > fx:
            split.append((fx, fy, ux - fx, fh))
        if ux + uw < fx + fw:
            split.append((ux + uw, fy, fx + fw - ux - uw, fh))
        if uy > fy:
            split.append((fx, fy, fw, uy - fy))
        if uy + uh < fy + fh:
            split.append((fx, uy + uh, fw, fy + fh - uy - uh))
    return _prune_free_rectangles(split)


def _pack_equal_area_rectangles(
    aspect_ratios: list[float],
    *,
    width: int,
    height: int,
    gutter: int,
    area: float,
) -> list[tuple[int, int, int, int]] | None:
    dimensions = []
    for index, aspect_ratio in enumerate(aspect_ratios):
        panel_height = max(1, math.floor(math.sqrt(area / aspect_ratio)))
        panel_width = max(1, math.floor(panel_height * aspect_ratio))
        dimensions.append((index, panel_width, panel_height))

    orders = (
        sorted(dimensions, key=lambda item: (max(item[1], item[2]), item[2]), reverse=True),
        sorted(dimensions, key=lambda item: (item[2], item[1]), reverse=True),
        sorted(dimensions, key=lambda item: (item[1], item[2]), reverse=True),
    )
    best: list[tuple[int, int, int, int]] | None = None
    best_extent: tuple[int, int] | None = None
    for ordered in orders:
        free = [(0, 0, width, height)]
        placements: list[tuple[int, int, int, int] | None] = [None] * len(dimensions)
        for index, panel_width, panel_height in ordered:
            packed_width = panel_width + gutter
            packed_height = panel_height + gutter
            candidates = []
            for free_index, (x, y, free_width, free_height) in enumerate(free):
                if packed_width <= free_width and packed_height <= free_height:
                    candidates.append((
                        min(free_width - packed_width, free_height - packed_height),
                        max(free_width - packed_width, free_height - packed_height),
                        y,
                        x,
                        free_index,
                    ))
            if not candidates:
                break
            *_, free_index = min(candidates)
            x, y, _, _ = free[free_index]
            used = (x, y, packed_width, packed_height)
            placements[index] = (
                x + gutter // 2,
                y + gutter // 2,
                panel_width,
                panel_height,
            )
            free = _split_free_rectangles(free, used)
        if any(placement is None for placement in placements):
            continue
        complete = [placement for placement in placements if placement is not None]
        extent = (
            max(x + panel_width for x, _, panel_width, _ in complete),
            max(y + panel_height for _, y, _, panel_height in complete),
        )
        if best_extent is None or extent[0] * extent[1] < best_extent[0] * best_extent[1]:
            best = complete
            best_extent = extent
    return best


def packed_layout(
    aspect_ratios: list[float],
    *,
    width: int,
    height: int,
    gutter: int,
) -> list[tuple[int, int, int, int]]:
    low = 1.0
    high = width * height / len(aspect_ratios)
    best: list[tuple[int, int, int, int]] | None = None
    for _ in range(24):
        area = (low + high) / 2
        candidate = _pack_equal_area_rectangles(
            aspect_ratios,
            width=width,
            height=height,
            gutter=gutter,
            area=area,
        )
        if candidate is None:
            high = area
        else:
            best = candidate
            low = area
    if best is None:
        raise ValueError("canvas is too small for the requested ingredient panels")
    return best


def packed_panel_position(
    x: int,
    y: int,
    panel_width: int,
    panel_height: int,
    *,
    width: int,
    height: int,
    index: int,
    count: int,
) -> str:
    center_x = (x + panel_width / 2) / width
    center_y = (y + panel_height / 2) / height
    vertical = "top" if center_y < 1 / 3 else "bottom" if center_y > 2 / 3 else "middle"
    horizontal = "left" if center_x < 1 / 3 else "right" if center_x > 2 / 3 else "center"
    return f"{vertical} {horizontal} area, reference {index + 1} of {count}"


def compose(
    images: list[Path],
    output: Path,
    *,
    cell_size: int,
    gutter: int | None,
    width: int | None = None,
    height: int | None = None,
) -> dict:
    if not images:
        raise ValueError("at least one ingredient image is required")
    if (width is None) != (height is None):
        raise ValueError("width and height must be supplied together")
    gutter = model_scale_gutter(width, height) if gutter is None else gutter
    aspect_ratios: list[float] = []
    for source in images:
        with Image.open(source) as opened:
            oriented = ImageOps.exif_transpose(opened)
            aspect_ratios.append(oriented.width / oriented.height)
    use_packed_layout = (
        width is not None
        and height is not None
        and max(aspect_ratios) / min(aspect_ratios) >= 2.5
    )
    if use_packed_layout:
        placements = packed_layout(
            aspect_ratios,
            width=width,
            height=height,
            gutter=gutter,
        )
        columns, rows = grid_shape(
            len(images),
            width=width,
            height=height,
            gutter=gutter,
            aspect_ratios=aspect_ratios,
        )
    else:
        placements = None
        columns, rows = grid_shape(
            len(images),
            width=width,
            height=height,
            gutter=gutter,
            aspect_ratios=aspect_ratios,
        )
    width = width or columns * cell_size + (columns + 1) * gutter
    height = height or rows * cell_size + (rows + 1) * gutter
    cell_width = (width - (columns + 1) * gutter) // columns
    cell_height = (height - (rows + 1) * gutter) // rows
    sheet = Image.new("RGB", (width, height), "black")
    panels: list[dict] = []

    for index, source in enumerate(images):
        row, column = divmod(index, columns)
        if placements is not None:
            panel_x, panel_y, panel_width, panel_height = placements[index]
        else:
            panel_x = gutter + column * (cell_width + gutter)
            panel_y = gutter + row * (cell_height + gutter)
            panel_width = cell_width
            panel_height = cell_height
        with Image.open(source) as opened:
            # Preserve the full source view: no crop, stretch, color adjustment,
            # or rendered label. Downscale only when a view exceeds its cell.
            view = ImageOps.exif_transpose(opened).convert("RGB")
            view.thumbnail((panel_width, panel_height), Image.Resampling.LANCZOS, reducing_gap=3.0)
            x = panel_x + (panel_width - view.width) // 2
            y = panel_y + (panel_height - view.height) // 2
            sheet.paste(view, (x, y))
        panels.append({
            "index": index,
            "row": row,
            "column": column,
            "x": x,
            "y": y,
            "width": view.width,
            "height": view.height,
            "position": (
                packed_panel_position(
                    x,
                    y,
                    view.width,
                    view.height,
                    width=width,
                    height=height,
                    index=index,
                    count=len(images),
                )
                if placements is not None
                else panel_position(row, column, rows, columns)
            ),
        })

    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", compress_level=4)
    return {
        "output": str(output),
        "width": width,
        "height": height,
        "columns": columns,
        "rows": rows,
        "cell_width": cell_width,
        "cell_height": cell_height,
        "gutter": gutter,
        "layout": "packed" if placements is not None else "grid",
        "panels": panels,
    }


def fit_anchor(source: Path, output: Path, *, width: int, height: int) -> dict:
    """Preserve a complete timeline image on a target-sized, non-black canvas."""
    with Image.open(source) as opened:
        view = ImageOps.exif_transpose(opened).convert("RGB")
        source_width, source_height = view.size
        background = ImageOps.fit(
            view,
            (width, height),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
        background = background.filter(ImageFilter.GaussianBlur(radius=max(8, round(min(width, height) * 0.04))))
        foreground = ImageOps.contain(view, (width, height), method=Image.Resampling.LANCZOS)
        x = (width - foreground.width) // 2
        y = (height - foreground.height) // 2
        background.paste(foreground, (x, y))

    output.parent.mkdir(parents=True, exist_ok=True)
    background.save(output, format="PNG", compress_level=4)
    return {
        "output": str(output),
        "width": width,
        "height": height,
        "source_width": source_width,
        "source_height": source_height,
        "foreground_width": foreground.width,
        "foreground_height": foreground.height,
        "foreground_x": x,
        "foreground_y": y,
        "fit": "contain_blur",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fit-anchor", type=Path)
    parser.add_argument("--cell-size", type=int, default=512)
    parser.add_argument("--gutter", type=int)
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("images", nargs="*", type=Path)
    args = parser.parse_args()
    if not 256 <= args.cell_size <= 1024:
        raise SystemExit("cell size must be between 256 and 1024")
    if args.gutter is not None and not 0 <= args.gutter <= 128:
        raise SystemExit("gutter must be between 0 and 128")
    if args.width is not None and not 256 <= args.width <= 4096:
        raise SystemExit("width must be between 256 and 4096")
    if args.height is not None and not 256 <= args.height <= 4096:
        raise SystemExit("height must be between 256 and 4096")
    if len(args.images) > 12:
        raise SystemExit("at most 12 ingredient images are supported")
    sources = [args.fit_anchor] if args.fit_anchor else args.images
    missing = [str(path) for path in sources if path is not None and not path.is_file()]
    if missing:
        raise SystemExit(f"ingredient image not found: {missing[0]}")
    if args.fit_anchor:
        if args.width is None or args.height is None:
            raise SystemExit("--fit-anchor requires --width and --height")
        if args.images:
            raise SystemExit("--fit-anchor does not accept ingredient images")
        print(json.dumps(fit_anchor(args.fit_anchor, args.output, width=args.width, height=args.height)))
        return
    if not args.images:
        raise SystemExit("at least one ingredient image is required")
    print(json.dumps(compose(
        args.images,
        args.output,
        cell_size=args.cell_size,
        gutter=args.gutter,
        width=args.width,
        height=args.height,
    )))


if __name__ == "__main__":
    main()
