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

import base64
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


# --- media this lane may hold, but only as ciphertext -----------------------
#
# A rented lane cannot reach this machine's memory, so it gets the bytes the
# only way it can: as a file. What it does NOT get is a plaintext one. The
# gateway encrypts each staged input under a key made for that job alone,
# pushes the ciphertext, and puts the key in the graph. The lane decrypts in
# memory here and the plaintext never lands on the rented disk.
#
# What that buys, precisely: RESIDUE. Whoever controls a rented box can read
# its process memory and its ComfyUI history while a job runs, and renting
# means trusting it with the pixels for that long — the model has to see them.
# What it can no longer do is keep them. The file left behind when the machine
# is recycled to the next tenant, or imaged by the provider, is ciphertext
# whose key never touched that disk and is gone when the job ends.
def decrypt_sealed_input(payload: bytes, key_b64url: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = key_b64url + "=" * (-len(key_b64url) % 4)
    material = base64.urlsafe_b64decode(raw.encode("ascii"))
    if len(material) != 44:
        raise RuntimeError("That private input's key is not the right shape.")
    return AESGCM(material[12:]).decrypt(material[:12], payload, None)


def read_private_bytes(handle="", sealed_file="", sealed_key=""):
    """The bytes behind whichever door this lane was given.

    `handle` on a lane that shares a machine with the gateway: nothing on disk
    at all. `sealed_file` + `sealed_key` on a lane that does not: ciphertext on
    disk, opened here and never written back.
    """
    name = str(sealed_file or "").strip()
    if name:
        import folder_paths

        path = Path(folder_paths.get_input_directory()) / name
        if not path.is_file():
            raise RuntimeError("That private input is not on this lane.")
        return decrypt_sealed_input(path.read_bytes(), str(sealed_key or "").strip())
    return fetch_private_input(handle)


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


def _private_input_types():
    """Two doors, both optional, exactly one used.

    `handle` for a lane on this machine (nothing on disk); `sealed_file` plus
    `sealed_key` for a lane that is not (ciphertext on disk, opened in memory).
    """
    return {
        "required": {"handle": ("STRING", {"default": "", "multiline": False})},
        "optional": {
            "sealed_file": ("STRING", {"default": "", "multiline": False}),
            "sealed_key": ("STRING", {"default": "", "multiline": False}),
        },
    }


def _private_is_changed(cls, handle="", sealed_file="", sealed_key=""):
    # The handle (or the sealed name) IS the identity of the bytes: a new
    # staging makes a new one, so this keys the execution cache per job without
    # the node ever holding or hashing the media itself.
    return f"{handle}|{sealed_file}"


def _private_validate(cls, handle="", sealed_file="", sealed_key=""):
    # Validation runs while the person is still queueing and must not reach for
    # the bytes.
    if str(sealed_file or "").strip():
        return True if str(sealed_key or "").strip() else "This graph has a sealed private input with no key."
    return True if str(handle or "").strip() else "This graph has a private input with no handle."


class HivemindLoadPrivateImage:
    """Drop-in for LoadImage whose input is a memory handle, not a filename."""

    INPUT_TYPES = classmethod(lambda cls: _private_input_types())
    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "load"
    CATEGORY = "hivemind/private"
    DESCRIPTION = "Load an image the studio is holding in memory, so it never becomes a file."

    def load(self, handle="", sealed_file="", sealed_key=""):
        return decode_image(read_private_bytes(handle, sealed_file, sealed_key))

    IS_CHANGED = classmethod(_private_is_changed)
    VALIDATE_INPUTS = classmethod(_private_validate)


class HivemindLoadPrivateVideo:
    """Drop-in for LoadVideo. Decodes through the fork's own VideoFromFile, so
    the VIDEO it returns is the one every downstream node already expects."""

    INPUT_TYPES = classmethod(lambda cls: _private_input_types())
    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "load"
    CATEGORY = "hivemind/private"
    DESCRIPTION = "Load a video the studio is holding in memory, so it never becomes a file."

    def load(self, handle="", sealed_file="", sealed_key=""):
        from comfy_api.latest import InputImpl

        payload = read_private_bytes(handle, sealed_file, sealed_key)
        # VideoFromFile takes a file-like source, so the clip is decoded from
        # this buffer and never needs a path.
        return (InputImpl.VideoFromFile(io.BytesIO(payload)),)

    IS_CHANGED = classmethod(_private_is_changed)
    VALIDATE_INPUTS = classmethod(_private_validate)


class HivemindLoadPrivateAudio:
    """Drop-in for LoadAudio, decoded by the fork's own loader.

    comfy_extras.nodes_audio.load() opens its argument with av.open(), which
    takes a file-like object as readily as a path — so the same function that
    reads a file reads this buffer, and the waveform is identical.
    """

    INPUT_TYPES = classmethod(lambda cls: _private_input_types())
    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "load"
    CATEGORY = "hivemind/private"
    DESCRIPTION = "Load an audio clip the studio is holding in memory, so it never becomes a file."

    def load(self, handle="", sealed_file="", sealed_key=""):
        from comfy_extras.nodes_audio import load as _load_audio

        payload = read_private_bytes(handle, sealed_file, sealed_key)
        waveform, sample_rate = _load_audio(io.BytesIO(payload))
        return ({"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate},)

    IS_CHANGED = classmethod(_private_is_changed)
    VALIDATE_INPUTS = classmethod(_private_validate)


NODE_CLASS_MAPPINGS = {
    "HivemindLoadPrivateImage": HivemindLoadPrivateImage,
    "HivemindLoadPrivateVideo": HivemindLoadPrivateVideo,
    "HivemindLoadPrivateAudio": HivemindLoadPrivateAudio,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "HivemindLoadPrivateImage": "Load Private Image (Hivemind)",
    "HivemindLoadPrivateVideo": "Load Private Video (Hivemind)",
    "HivemindLoadPrivateAudio": "Load Private Audio (Hivemind)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
