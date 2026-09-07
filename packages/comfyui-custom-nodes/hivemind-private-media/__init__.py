"""Load the owner's media into a graph without it ever being a file.

`LoadImage` reads the input directory, so until now every reference the owner
sent was decrypted by their browser, posted to the gateway, and written there
as a plaintext PNG for a sweeper to expire later. That directory is the window
another process on this machine used: it listed the input dir, found the
owner's upscale source, and copied it.

This node takes a handle instead of a filename and fetches the bytes from the
gateway's memory over loopback (gateway/private_inputs.py). The graph carries
no filename, the input directory gains no file, and there is nothing left for
anyone to list or copy. The returned tensors are byte-for-byte what core
`LoadImage` would have produced from the same PNG, so it substitutes into any
graph that used one — the gateway swaps it in at submit time.

Scope, honestly: this closes a FILE, not a process. The bytes exist in this
process's memory while the graph runs, and on a Mac a process running as the
same user may be able to read another's memory. What it ends is the case that
actually happened — owner media sitting in a directory, readable with `cp`,
for hours after the job that needed it finished.
"""

from __future__ import annotations

import io
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import comfy.model_management
import node_helpers

GATEWAY_URL = os.environ.get("ZIMG_GATEWAY_URL", "http://127.0.0.1:8787").rstrip("/")
FETCH_TIMEOUT_SECONDS = int(os.environ.get("ZIMG_PRIVATE_INPUT_FETCH_TIMEOUT", "30"))


def _token_file() -> Path:
    explicit = os.environ.get("ZIMG_TOKEN_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    state = os.environ.get("HIVEMIND_MEDIA_STATE_DIR", "").strip()
    root = Path(state).expanduser() if state else Path.home() / ".hivemindos" / "media-studio"
    return root / "secure" / "zimg-token"


def _gateway_token() -> str:
    """The gateway's own capability token, read from the 0600 file it writes.

    The lane runs as the same user as the gateway, which is exactly why this
    node has to exist — and is also why reading the token here grants nothing
    a process on this machine did not already have. The handle is the part
    that is hard to come by: 256 bits, never written to disk, and gone from
    memory when the job is over.
    """
    try:
        token = _token_file().read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(
            "This lane cannot reach the studio gateway to load a private input."
        ) from exc
    if len(token) < 12:
        raise RuntimeError("This lane cannot reach the studio gateway to load a private input.")
    return token


def fetch_private_input(handle: str) -> bytes:
    key = str(handle or "").strip()
    if not key:
        raise RuntimeError("This graph asked for a private input without a handle.")
    url = f"{GATEWAY_URL}/internal/private-input?handle={urllib.parse.quote(key)}"
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {_gateway_token()}"})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # The honest failure. A handle outlives staging by an hour, so this
            # is a job that sat in a queue past its input's life, not a bug the
            # person can do anything about except run it again.
            raise RuntimeError(
                "That private input is no longer held in memory — start the generation again."
            ) from exc
        raise RuntimeError("The studio gateway refused to hand this lane its private input.") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeError("The studio gateway did not answer this lane's private input request.") from exc


def decode_image(payload: bytes):
    """Bytes -> (IMAGE, MASK), matching core LoadImage exactly.

    Same EXIF transpose, same RGB conversion, same inverted-alpha mask and the
    same 64x64 zero mask when there is no alpha, so a graph cannot tell which
    loader produced its tensors.
    """
    dtype = comfy.model_management.intermediate_dtype()
    device = comfy.model_management.intermediate_device()
    img = node_helpers.pillow(Image.open, io.BytesIO(payload))

    output_images = []
    output_masks = []
    width, height = None, None
    for frame in ImageSequence.Iterator(img):
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        image = frame.convert("RGB")
        if not output_images:
            width, height = image.size
        if image.size[0] != width or image.size[1] != height:
            continue
        pixels = np.array(image).astype(np.float32) / 255.0
        pixels = torch.from_numpy(pixels)[None, ]
        if "A" in frame.getbands():
            alpha = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(alpha)
        else:
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
        output_images.append(pixels.to(dtype=dtype))
        output_masks.append(mask.unsqueeze(0).to(dtype=dtype))

    if not output_images:
        raise RuntimeError("That private input did not decode as an image.")
    return (
        torch.cat(output_images, dim=0).to(device=device, dtype=dtype),
        torch.cat(output_masks, dim=0).to(device=device, dtype=dtype),
    )


class HivemindLoadPrivateImage:
    """Drop-in for LoadImage whose input is a memory handle, not a filename."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"handle": ("STRING", {"default": "", "multiline": False})}}

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load"
    CATEGORY = "hivemind/private"
    DESCRIPTION = "Load an image the studio is holding in memory, so it never becomes a file."

    def load(self, handle):
        return decode_image(fetch_private_input(handle))

    @classmethod
    def IS_CHANGED(cls, handle):
        # The handle IS the identity of the bytes: a new staging makes a new
        # handle, so this keys the execution cache per job without the node
        # ever having to hold or hash the media itself.
        return str(handle or "")

    @classmethod
    def VALIDATE_INPUTS(cls, handle):
        # Validation runs before execution and must not reach for the bytes:
        # a graph is checked while the person is still queueing it.
        return True if str(handle or "").strip() else "This graph has a private input with no handle."


NODE_CLASS_MAPPINGS = {"HivemindLoadPrivateImage": HivemindLoadPrivateImage}
NODE_DISPLAY_NAME_MAPPINGS = {"HivemindLoadPrivateImage": "Load Private Image (Hivemind)"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
