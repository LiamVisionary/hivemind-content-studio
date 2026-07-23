"""Deterministic black-line stickman keyframe renderer."""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from .manifest import add_artifact, load_manifest, write_manifest
from .private_access import encrypt_private_media, read_private_json


FRAME_SIZES = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080), "4:5": (1080, 1350)}


def _font(size: int) -> ImageFont.ImageFont:
    candidates = (
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def _scene_contract(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    artifact = next((item for item in manifest["artifacts"] if item["role"] == "stickman-scenes"), None)
    if not artifact:
        raise ValueError("Run has no stickman-scenes artifact")
    scenes = read_private_json(Path(artifact["path"]))
    if not isinstance(scenes, list):
        raise ValueError("stickman-scenes must be a JSON list")
    return [scene for scene in scenes if isinstance(scene, dict)]


def _draw_stickman(draw: ImageDraw.ImageDraw, width: int, height: int, scene_index: int) -> None:
    center_x = width // 2
    center_y = int(height * 0.58)
    scale = min(width, height) / 8
    line = max(8, int(scale * 0.07))
    radius = int(scale * 0.42)
    draw.ellipse((center_x - radius, center_y - int(scale * 1.8), center_x + radius, center_y - int(scale * 0.96)), outline="black", width=line)
    neck_y = center_y - int(scale * 0.96)
    hip_y = center_y + int(scale * 0.42)
    draw.line((center_x, neck_y, center_x, hip_y), fill="black", width=line)
    arm_y = center_y - int(scale * 0.45)
    direction = 1 if scene_index % 2 else -1
    draw.line((center_x, arm_y, center_x + direction * int(scale * 1.25), arm_y - int(scale * 0.55)), fill="black", width=line)
    draw.line((center_x, arm_y, center_x - direction * int(scale * 0.85), arm_y + int(scale * 0.45)), fill="black", width=line)
    draw.line((center_x, hip_y, center_x - int(scale * 0.75), hip_y + int(scale * 1.2)), fill="black", width=line)
    draw.line((center_x, hip_y, center_x + int(scale * 0.75), hip_y + int(scale * 1.2)), fill="black", width=line)


def _draw_centered_text(draw: ImageDraw.ImageDraw, text: str, width: int, top: int, font: ImageFont.ImageFont) -> None:
    wrapped = "\n".join(textwrap.wrap(text.strip(), width=24))
    box = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=14, align="center")
    text_width = box[2] - box[0]
    draw.multiline_text(((width - text_width) / 2, top), wrapped, fill="black", font=font, spacing=14, align="center")


def render_stickman_frames(manifest_path: str | Path) -> dict[str, Any]:
    manifest_file = Path(manifest_path).expanduser().resolve()
    manifest = load_manifest(manifest_file)
    if manifest["lane"] != "stickman-performance-ad":
        raise ValueError("Stickman frames require a stickman-performance-ad run")
    aspect_ratio = str(manifest["brief"].get("aspect_ratio") or "9:16")
    width, height = FRAME_SIZES.get(aspect_ratio, FRAME_SIZES["9:16"])
    output_dir = manifest_file.parent / "keyframes"
    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[str] = []
    manifest["artifacts"] = [item for item in manifest["artifacts"] if item["role"] != "keyframe"]
    for index, scene in enumerate(_scene_contract(manifest), start=1):
        image = Image.new("RGB", (width, height), "white")
        draw = ImageDraw.Draw(image)
        overlay = str(scene.get("overlay") or scene.get("title") or scene.get("beat") or f"Scene {index}")
        _draw_centered_text(draw, overlay, width, int(height * 0.09), _font(max(38, int(width * 0.065))))
        _draw_stickman(draw, width, height, index)
        path = output_dir / f"scene-{index:03d}.png"
        image.save(path, format="PNG", optimize=True)
        frames.append(str(path))
        add_artifact(manifest, role="keyframe", path=path, provider="stickman-renderer")
        encrypt_private_media(path)
    write_manifest(manifest_file, manifest)
    return {"frames": frames, "provider": "stickman-renderer", "aspect_ratio": aspect_ratio}
