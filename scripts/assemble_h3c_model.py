#!/usr/bin/env python3
"""Build the model directory h3.c wants out of a Hugging Face MiniMax-H3 snapshot.

h3.c reads a plain checkpoint tree — ``FL2VA/{transformer,text_encoder,tokenizer,
video_vae/source,audio_vae}`` and optionally ``Ref2VA/transformer`` — and the
FL2VA half alone is ~134 GB.  A machine that already runs H3 through another
port usually has those bytes on disk once already, so this links them into
h3's layout instead of downloading a second copy: every leaf is a symlink and
the assembled tree costs a few kilobytes.

Two things make that more than an ``ln -s`` loop:

* **The shards can live away from the index.**  The MLX port keeps the FL2VA
  transformer under its own ``dit-bf16/`` while leaving ``config.json`` and
  ``model.safetensors.index.json`` behind in the snapshot, so a naive link
  produces a transformer directory the engine reads as empty.
* **A re-saved checkpoint can be missing a tensor.**  ``rope.inv_freq`` is a
  derived 16-float buffer that PyTorch drops on re-save, and h3.c refuses to
  start without it (``required weight is absent: rope.inv_freq``) forty seconds
  into a render, after the 62 GB text encoder has already loaded.  Every tensor
  the index names is checked here, and a missing one is fetched from the
  official repository by HTTP range request — 64 real bytes out of a 5 GB
  shard.  Nothing is ever synthesised: a tensor that cannot be fetched is
  reported, not invented.
* **A re-saved shard can be misaligned, and that renders BLACK.**  The
  safetensors format pads its JSON header with spaces so the payload starts on
  an 8-byte boundary.  Hugging Face's writer does; MLX's ``save_safetensors``
  did not, and 8 of the 13 shards it wrote here start their payload 1, 2 or 3
  bytes off.  h3.c on an M5 maps shard bytes straight into GPU buffers
  (``H3_ZERO_COPY_WEIGHTS``), and a 4-byte GPU load at a 2-mod-4 address
  silently reads the wrong bytes — every render came out black with saturated
  audio, byte-identical across seeds, while the CPU read the same file
  perfectly.  ``--check`` reports each shard's alignment; ``--realign`` pads the
  headers to spec (payload shifted through a temp file and an atomic rename,
  so an interrupted run leaves the original untouched).  The lane's runner
  also checks this itself and falls back to copied weight buffers on a
  misaligned snapshot, so a render is never silently wrong — but copied
  buffers cost the memory the file-backed mode exists to save.

Usage:

    scripts/assemble_h3c_model.py --from ~/comfy/mlx-models/minimax-h3/upstream
    scripts/assemble_h3c_model.py --check
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path

# Where the studio looks unless H3C_MODEL_DIR says otherwise. Kept in step with
# packages/media-gateway/gateway/config.py.
DEFAULT_DEST = Path.home() / "comfy/mlx-models/minimax-h3/h3c-model"

# Snapshots this machine might already hold, most specific first. A source is
# any directory with an FL2VA/ (or Ref2VA/) child.
DEFAULT_SOURCES = (
    Path.home() / "comfy/mlx-models/minimax-h3/upstream",
    Path.home() / "comfy/mlx-models/minimax-h3",
    Path.home() / "models/MiniMax-H3",
)

# Where loose transformer shards hide when the index was left behind.
TRANSFORMER_SHARD_HINTS = ("dit-bf16", "transformer-bf16", "dit")

UPSTREAM_REPO = "https://huggingface.co/MiniMaxAI/MiniMax-H3/resolve/main"
USER_AGENT = "hivemind-content-studio/1.0"

# The checkpoint subtrees h3.c requires, and the file each one is proved by.
# (h3.c: h3_require_file / h3_inventory in h3.c's model open path.)
FL2VA_PARTS = {
    "transformer": "config.json",
    "tokenizer": "tokenizer.json",
    "text_encoder": None,
    "video_vae": None,
    "audio_vae": None,
    # Not required by the engine, but the Qwen processor travels with the
    # encoder and costs nothing to link.
    "processor": None,
}


def _log(message: str) -> None:
    print(message, flush=True)


def _resolve_source(explicit: str | None) -> Path:
    if explicit:
        source = Path(explicit).expanduser().resolve()
        if not (source / "FL2VA").is_dir():
            raise SystemExit(f"{source} has no FL2VA/ directory — that is not an H3 snapshot")
        return source
    for candidate in DEFAULT_SOURCES:
        if (candidate / "FL2VA").is_dir():
            return candidate.resolve()
    raise SystemExit(
        "No MiniMax-H3 snapshot found. Pass --from <dir>, where <dir> holds FL2VA/ "
        "(download it with: hf download MiniMaxAI/MiniMax-H3 --include 'FL2VA/*')"
    )


def _link(target: Path, link: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(target)


def _shard_directory(source: Path, transformer: Path, explicit: str | None) -> Path:
    """Where the FL2VA transformer's safetensors shards actually are."""
    if explicit:
        directory = Path(explicit).expanduser().resolve()
        if not list(directory.glob("*.safetensors")):
            raise SystemExit(f"{directory} holds no .safetensors shards")
        return directory
    if list(transformer.glob("*.safetensors")):
        return transformer
    for hint in TRANSFORMER_SHARD_HINTS:
        for root in (source, source.parent):
            candidate = root / hint
            if candidate.is_dir() and list(candidate.glob("*.safetensors")):
                return candidate
    raise SystemExit(
        f"{transformer} has an index but no shards, and none were found beside the snapshot. "
        "Pass --transformer <dir>."
    )


def _safetensors_header(path: Path) -> dict:
    with path.open("rb") as handle:
        length = struct.unpack("<Q", handle.read(8))[0]
        return json.loads(handle.read(length))


def _fetch_tensor(relative: str, name: str) -> bytes | None:
    """The real bytes of one tensor, by two range requests against the repo."""
    url = f"{UPSTREAM_REPO}/{relative}"

    def _range(first: int, last: int) -> bytes:
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={first}-{last}"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()

    try:
        length = struct.unpack("<Q", _range(0, 7))[0]
        header = json.loads(_range(8, 8 + length - 1))
        entry = header.get(name)
        if not entry:
            return None
        start, end = entry["data_offsets"]
        payload = _range(8 + length + start, 8 + length + end - 1)
        return payload if len(payload) == end - start else None
    except Exception as error:  # noqa: BLE001 — any failure means "report it"
        _log(f"  could not fetch {name} from {relative}: {error}")
        return None


def _write_single_tensor_shard(path: Path, name: str, dtype: str, shape: list[int], payload: bytes) -> None:
    header = json.dumps(
        {name: {"dtype": dtype, "shape": shape, "data_offsets": [0, len(payload)]}},
        separators=(",", ":"),
    ).encode()
    header += b" " * ((-len(header)) % 8)
    path.write_bytes(struct.pack("<Q", len(header)) + header + payload)


SAFETENSORS_ALIGN = 8


def shard_alignment(path: Path) -> int:
    """How far this shard's payload sits off an 8-byte boundary. 0 is spec."""
    with path.open("rb") as handle:
        header_len = struct.unpack("<Q", handle.read(8))[0]
    return (8 + header_len) % SAFETENSORS_ALIGN


def misaligned_shards(directory: Path) -> list[Path]:
    return [
        shard for shard in sorted(directory.glob("*.safetensors"))
        if shard.is_file() and shard_alignment(shard) != 0
    ]


def realign_shard(path: Path, log=_log) -> bool:
    """Pad the header to a multiple of 8 so the payload lands on spec.

    The header JSON is followed by spaces up to the boundary — exactly what the
    reference writer emits — which moves the whole payload forward by a few
    bytes.  The rewrite goes through a sibling temp file and an atomic rename,
    and the payload is copied in 64 MiB pieces, so a crash mid-way costs nothing
    but the temp file.  Symlinks are resolved first: the shard that gets fixed
    is the real file, so every tree that links it sees the repair.
    """
    real = path.resolve()
    with real.open("rb") as handle:
        header_len = struct.unpack("<Q", handle.read(8))[0]
        header = handle.read(header_len)
    pad = (-(8 + header_len)) % SAFETENSORS_ALIGN
    if pad == 0:
        return False
    padded = header + b" " * pad
    temp = real.with_name(real.name + ".realign.tmp")
    total = real.stat().st_size
    with real.open("rb") as source, temp.open("wb") as target:
        target.write(struct.pack("<Q", len(padded)))
        target.write(padded)
        source.seek(8 + header_len)
        copied = 0
        while True:
            chunk = source.read(64 << 20)
            if not chunk:
                break
            target.write(chunk)
            copied += len(chunk)
        target.flush()
        os.fsync(target.fileno())
    if copied != total - 8 - header_len:
        temp.unlink(missing_ok=True)
        raise RuntimeError(f"{real.name}: copied {copied} payload bytes, expected {total - 8 - header_len}")
    os.replace(temp, real)
    log(f"  realigned {real.name}: header {header_len} -> {len(padded)} bytes (+{pad}), payload now on an 8-byte boundary")
    return True


def _repair_transformer(destination: Path, fetch: bool) -> list[str]:
    """Every tensor the index names, present in the linked shards — or fetched.

    Returns the names still missing afterwards.
    """
    index_path = destination / "model.safetensors.index.json"
    if not index_path.exists():
        return []
    weight_map = json.loads(index_path.read_text()).get("weight_map", {})
    present: set[str] = set()
    for shard in sorted(destination.glob("*.safetensors")):
        try:
            present.update(key for key in _safetensors_header(shard) if key != "__metadata__")
        except Exception as error:  # noqa: BLE001
            _log(f"  unreadable shard {shard.name}: {error}")
    missing = sorted(set(weight_map) - present)
    if not missing:
        return []
    _log(f"  {len(missing)} tensor(s) named by the index are absent from the shards: {', '.join(missing[:6])}")
    if not fetch:
        return missing
    still_missing: list[str] = []
    for index, name in enumerate(missing, start=1):
        relative = f"FL2VA/transformer/{weight_map[name]}"
        url = f"{UPSTREAM_REPO}/{relative}"
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-7"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                length = struct.unpack("<Q", response.read())[0]
            header_request = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "Range": f"bytes=8-{8 + length - 1}"}
            )
            with urllib.request.urlopen(header_request, timeout=60) as response:
                entry = json.loads(response.read())[name]
        except Exception as error:  # noqa: BLE001
            _log(f"  could not read the upstream header for {name}: {error}")
            still_missing.append(name)
            continue
        size = entry["data_offsets"][1] - entry["data_offsets"][0]
        if size > 64 * 1024 * 1024:
            # A big absent tensor is a broken snapshot, not a dropped buffer.
            _log(f"  {name} is {size / 1e6:.0f} MB — re-download the shard rather than patching it")
            still_missing.append(name)
            continue
        payload = _fetch_tensor(relative, name)
        if payload is None:
            still_missing.append(name)
            continue
        shard = destination / f"restored-{index:02d}-{name.replace('.', '_')}.safetensors"
        _write_single_tensor_shard(shard, name, entry["dtype"], entry["shape"], payload)
        _log(f"  restored {name} ({entry['dtype']}{entry['shape']}, {len(payload)} bytes) from the official repo")
    return still_missing


def _describe(destination: Path) -> int:
    """Print what h3.c will find here. Returns a process exit code."""
    fl2va = destination / "FL2VA"
    ok = True
    _log(f"h3.c model directory: {destination}")
    if not fl2va.is_dir():
        _log("  FL2VA: absent — nothing will run")
        return 1
    for part, proof in FL2VA_PARTS.items():
        directory = fl2va / part
        if not directory.is_dir():
            _log(f"  FL2VA/{part}: absent")
            if part != "processor":
                ok = False
            continue
        if proof and not (directory / proof).exists():
            _log(f"  FL2VA/{part}: present but {proof} is missing")
            ok = False
            continue
        shards = list(directory.glob("*.safetensors"))
        bad = [shard for shard in shards if shard.is_file() and shard_alignment(shard) != 0]
        _log(f"  FL2VA/{part}: ok" + (f" ({len(shards)} shards)" if shards else ""))
        if bad:
            ok = False
            _log(
                f"    {len(bad)} of {len(shards)} shards start their payload off the 8-byte boundary "
                f"({', '.join(shard.name for shard in bad[:4])}{', …' if len(bad) > 4 else ''}).\n"
                "    h3's file-backed weight mapping reads them WRONG on the GPU (a black render). "
                "Fix: assemble_h3c_model.py --realign"
            )
    if not (fl2va / "video_vae" / "source").is_dir():
        _log("  FL2VA/video_vae/source: absent — the decoder weights live here")
        ok = False
    ref2va = destination / "Ref2VA/transformer"
    if (ref2va / "model.safetensors.index.json").exists() and list(ref2va.glob("*.safetensors")):
        _log("  Ref2VA: ok — reference pictures, clips and voices are available")
    else:
        _log(
            "  Ref2VA: absent — text-to-video and first/last frame work; reference mode does not.\n"
            "    hf download MiniMaxAI/MiniMax-H3 --include 'Ref2VA/*'   (~62 GiB)"
        )
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="source", default=None, help="A directory holding FL2VA/ (and maybe Ref2VA/)")
    parser.add_argument("--dest", default=str(DEFAULT_DEST), help=f"Where to assemble (default {DEFAULT_DEST})")
    parser.add_argument("--transformer", default=None, help="Where the FL2VA transformer shards are, if not beside the index")
    parser.add_argument("--check", action="store_true", help="Only report what the destination already holds")
    parser.add_argument("--no-fetch", action="store_true", help="Never reach the network; report absent tensors instead")
    parser.add_argument("--realign", action="store_true",
                        help="Pad every misaligned transformer shard's header to spec (rewrites the real files in place, safely)")
    args = parser.parse_args(argv)

    destination = Path(args.dest).expanduser().resolve()
    if args.realign:
        transformer = destination / "FL2VA" / "transformer"
        bad = misaligned_shards(transformer)
        if not bad:
            _log("every transformer shard already starts its payload on an 8-byte boundary")
            return _describe(destination)
        _log(f"realigning {len(bad)} shard(s) under {transformer}")
        for shard in bad:
            realign_shard(shard)
        return _describe(destination)
    if args.check:
        return _describe(destination)

    source = _resolve_source(args.source)
    _log(f"Linking {source} -> {destination}")
    fl2va = source / "FL2VA"
    for part in FL2VA_PARTS:
        directory = fl2va / part
        if not directory.is_dir():
            continue
        if part == "transformer":
            continue
        _link(directory, destination / "FL2VA" / part)
        _log(f"  FL2VA/{part}")

    transformer = fl2va / "transformer"
    if transformer.is_dir():
        shard_dir = _shard_directory(source, transformer, args.transformer)
        target = destination / "FL2VA" / "transformer"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("config.json", "model.safetensors.index.json"):
            if (transformer / name).exists():
                _link(transformer / name, target / name)
        for shard in sorted(shard_dir.glob("*.safetensors")):
            _link(shard, target / shard.name)
        _log(f"  FL2VA/transformer (shards from {shard_dir})")
        missing = _repair_transformer(target, fetch=not args.no_fetch)
        if missing:
            _log(f"  still missing: {', '.join(missing)} — h3 will refuse to render")

    ref2va = source / "Ref2VA"
    if ref2va.is_dir():
        _link(ref2va, destination / "Ref2VA")
        _log("  Ref2VA")

    _log("")
    return _describe(destination)


if __name__ == "__main__":
    sys.exit(main())
