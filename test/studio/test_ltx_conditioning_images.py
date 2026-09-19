from __future__ import annotations

import importlib.util
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "packages" / "media-gateway" / "bin" / "compose-ingredients-sheet.py"


def load_compositor():
    spec = importlib.util.spec_from_file_location("ltx_conditioning_images", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_anchor_fit_preserves_the_entire_portrait_without_black_padding(tmp_path: Path) -> None:
    compositor = load_compositor()
    source = tmp_path / "portrait.png"
    output = tmp_path / "anchor.png"
    image = Image.new("RGB", (100, 200), "red")
    for y in range(100, 200):
        for x in range(100):
            image.putpixel((x, y), (0, 0, 255))
    image.save(source)

    metadata = compositor.fit_anchor(source, output, width=160, height=90)

    with Image.open(output) as fitted:
        assert fitted.size == (160, 90)
        # The complete source survives in the centered foreground: top and bottom
        # remain visible, while the generated side fill contains no black bars.
        assert fitted.getpixel((80, 2))[0] > 200
        assert fitted.getpixel((80, 87))[2] > 200
        assert all(any(channel > 0 for channel in pixel) for pixel in fitted.getdata())
    assert metadata["fit"] == "contain_blur"
    assert metadata["foreground_width"] == 45
    assert metadata["foreground_height"] == 90


def test_target_sized_nine_view_sheet_uses_model_scale_gutters_and_unique_positions(tmp_path: Path) -> None:
    compositor = load_compositor()
    sources = []
    for index in range(9):
        source = tmp_path / f"view-{index}.png"
        Image.new("RGB", (100, 150), (40 + index, 120, 200)).save(source)
        sources.append(source)

    metadata = compositor.compose(
        sources,
        tmp_path / "sheet.png",
        cell_size=512,
        gutter=None,
        width=768,
        height=448,
    )

    assert metadata["gutter"] == 4
    assert metadata["cell_width"] >= 148
    assert metadata["cell_height"] >= 218
    positions = [panel["position"] for panel in metadata["panels"]]
    assert len(set(positions)) == len(positions)
    assert positions[0] == "top row, column 1 of 5"
    assert positions[-1] == "bottom row, column 4 of 5"


def test_mixed_aspect_references_are_packed_without_tiny_letterboxed_panels(tmp_path: Path) -> None:
    compositor = load_compositor()
    sizes = [
        (399, 405), (350, 405), (777, 405), (352, 283), (248, 283),
        (313, 283), (254, 283), (107, 283), (239, 283), (1533, 383),
    ]
    sources = []
    for index, size in enumerate(sizes):
        source = tmp_path / f"mixed-{index}.png"
        Image.new("RGB", size, (60 + index * 10, 120, 200)).save(source)
        sources.append(source)

    metadata = compositor.compose(
        sources,
        tmp_path / "mixed-sheet.png",
        cell_size=512,
        gutter=None,
        width=768,
        height=448,
    )

    with Image.open(tmp_path / "mixed-sheet.png") as sheet:
        black_fraction = sum(pixel == (0, 0, 0) for pixel in sheet.getdata()) / (sheet.width * sheet.height)
    assert metadata["layout"] == "packed"
    assert black_fraction < 0.30
    assert len({panel["position"] for panel in metadata["panels"]}) == len(sources)
    assert all(panel["width"] >= 80 and panel["height"] >= 70 for panel in metadata["panels"])
