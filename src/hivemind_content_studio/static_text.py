"""Deterministic plain-background text ad renderer."""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, read_private_json
from .stickman import FRAME_SIZES, _font


def _hex(value: Any, fallback: str) -> str:
    text = str(value or fallback).strip()
    return text if len(text) in {4, 7} and text.startswith("#") else fallback


def _centered(draw: ImageDraw.ImageDraw, text: str, *, width: int, y: int, font, color: str, wrap: int) -> int:
    wrapped = "\n".join(textwrap.wrap(text.strip(), width=wrap))
    box = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=18, align="center")
    text_width = box[2] - box[0]
    text_height = box[3] - box[1]
    draw.multiline_text(((width - text_width) / 2, y), wrapped, fill=color, font=font, spacing=18, align="center")
    return y + text_height


def render_static_text_frames(manifest_path: str | Path) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    if manifest["lane"] != "static-text-ad":
        raise ValueError("Static frames require a static-text-ad run")
    artifact = next((item for item in manifest["artifacts"] if item["role"] == "static-text-scenes"), None)
    if not artifact:
        raise ValueError("Run has no static-text-scenes artifact")
    scenes = read_private_json(Path(artifact["path"]))
    aspect_ratio = str(manifest["brief"].get("aspect_ratio") or "4:5")
    width, height = FRAME_SIZES.get(aspect_ratio, FRAME_SIZES["4:5"])
    palette = manifest["brief"].get("palette") if isinstance(manifest["brief"].get("palette"), dict) else {}
    background = _hex(palette.get("background"), "#F7F5F2")
    foreground = _hex(palette.get("foreground"), "#171717")
    accent = _hex(palette.get("accent"), foreground)
    output_dir = manifest_file.parent / "keyframes"
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest["artifacts"] = [item for item in manifest["artifacts"] if item["role"] != "keyframe"]
    frames: list[str] = []
    for index, raw in enumerate(scenes, start=1):
        scene = raw if isinstance(raw, dict) else {"overlay": str(raw)}
        image = Image.new("RGB", (width, height), background)
        draw = ImageDraw.Draw(image)
        margin = int(width * 0.09)
        draw.rounded_rectangle((margin, margin, width - margin, margin + 18), radius=9, fill=accent)
        headline = str(scene.get("overlay") or scene.get("title") or scene.get("beat") or "")
        subtext = str(scene.get("subtext") or "")
        next_y = _centered(draw, headline, width=width, y=int(height * 0.31), font=_font(max(44, int(width * 0.075))), color=foreground, wrap=20)
        if subtext:
            _centered(draw, subtext, width=width, y=next_y + int(height * 0.05), font=_font(max(28, int(width * 0.038))), color=foreground, wrap=30)
        path = output_dir / f"static-{index:03d}.png"
        image.save(path, format="PNG", optimize=True)
        frames.append(str(path))
        add_artifact(manifest, role="keyframe", path=path, provider="static-text-renderer", scene=index)
        encrypt_private_media(path)
    write_manifest(manifest_file, manifest)
    return {"frames": frames, "provider": "static-text-renderer", "aspect_ratio": aspect_ratio}
