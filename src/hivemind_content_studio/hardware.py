"""What this machine is, in the four numbers a model store needs.

The Models page has to answer one question per card — "will this run here?" —
and until now nothing on the server could. `doctor.collect_checks()` knows
whether ffmpeg is on PATH; `unified_runtime` knows whether ComfyUI answers.
Neither knows how much memory this box has, what kind of accelerator it has, or
whether the download would even fit on the disk the weights land on.

Everything here is a machine FACT: RAM, accelerator class, free space under the
models root, and how many weight files are already sitting there. No paths to
private files, no credentials, nothing about what the owner has generated.

The probes are subprocesses (`sysctl`, `nvidia-smi`), so the result is cached —
a machine does not grow RAM between two page loads.
"""

from __future__ import annotations

import platform
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from .settings import load_settings

# The weight kinds a studio can actually generate with. LoRAs and embeddings are
# accessories to a model, not a model, so they are deliberately not counted:
# "3 models installed" has to mean three things you can pick in a studio.
_MODEL_DIRS = ("checkpoints", "unet", "diffusion_models")
_WEIGHT_SUFFIXES = (".safetensors", ".ckpt", ".gguf", ".sft", ".pth")

_PROFILE_TTL_SECONDS = 300.0
_INVENTORY_TTL_SECONDS = 60.0
_cache: dict[str, dict[str, Any]] = {}


def forget_hardware_cache() -> None:
    """Drop the memoised probes. Tests and a settings change both need this."""
    _cache.clear()


def _cached(name: str, ttl: float, build) -> Any:
    entry = _cache.get(name)
    now = time.monotonic()
    if entry is not None and now - entry["at"] <= ttl:
        return entry["value"]
    value = build()
    _cache[name] = {"value": value, "at": now}
    return value


def _run(command: list[str], timeout: float = 2.0) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _total_ram_bytes() -> int:
    if platform.system() == "Darwin":
        raw = _run(["sysctl", "-n", "hw.memsize"])
        return int(raw) if raw.isdigit() else 0
    try:
        text = Path("/proc/meminfo").read_text(encoding="utf-8")
    except OSError:
        return 0
    match = re.search(r"^MemTotal:\s+(\d+) kB", text, re.MULTILINE)
    return int(match.group(1)) * 1024 if match else 0


def _accelerator() -> dict[str, Any]:
    """Which lane this machine has, named the way a person would name it.

    `vram_gb` is what a model has to fit in. On Apple Silicon that is the same
    unified memory the OS is using, which is why the fit line has to leave room
    for the rest of the machine rather than treating it as a dedicated card.
    """
    system = platform.system()
    machine = platform.machine()
    if system == "Darwin" and machine == "arm64":
        chip = _run(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple Silicon"
        return {"class": "apple-silicon", "label": chip, "unified_memory": True}
    nvidia = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], timeout=2.0)
    if nvidia:
        first = nvidia.splitlines()[0]
        name, _, total = first.partition(",")
        megabytes = re.sub(r"[^0-9]", "", total)
        return {
            "class": "nvidia",
            "label": name.strip() or "NVIDIA GPU",
            "unified_memory": False,
            "vram_gb": round(int(megabytes) / 1024, 1) if megabytes else None,
        }
    return {"class": "cpu", "label": f"{system} {machine}".strip() or "this machine", "unified_memory": False}


def _models_root() -> Path:
    return load_settings().paths.models_root


def _free_disk_gb(root: Path) -> float | None:
    """Free space where the weights would land.

    A models root that does not exist yet is normal on a fresh machine — walk up
    to the first parent that does, which is the volume the download would use.
    """
    candidate = root
    for _ in range(6):
        if candidate.exists():
            try:
                return round(shutil.disk_usage(candidate).free / 1024**3, 1)
            except OSError:
                return None
        if candidate.parent == candidate:
            break
        candidate = candidate.parent
    return None


def _installed_weights(root: Path) -> int:
    total = 0
    for name in _MODEL_DIRS:
        directory = root / "models" / name
        if not directory.is_dir():
            continue
        try:
            for path in directory.rglob("*"):
                if path.suffix.lower() in _WEIGHT_SUFFIXES and path.is_file():
                    total += 1
        except OSError:
            continue
    return total


def hardware_profile() -> dict[str, Any]:
    """RAM, accelerator, and the disk the models root sits on."""

    def build() -> dict[str, Any]:
        root = _models_root()
        ram_bytes = _total_ram_bytes()
        accelerator = _accelerator()
        ram_gb = round(ram_bytes / 1024**3, 1) if ram_bytes else None
        if accelerator["class"] == "apple-silicon":
            accelerator = {**accelerator, "vram_gb": ram_gb}
        accelerator.setdefault("vram_gb", None)
        return {
            "platform": platform.system(),
            "arch": platform.machine(),
            "ram_gb": ram_gb,
            "accelerator": accelerator,
            "models_root": str(root),
            "free_disk_gb": _free_disk_gb(root),
        }

    return _cached("profile", _PROFILE_TTL_SECONDS, build)


def model_inventory() -> dict[str, Any]:
    """How many weights are already on this disk, and where they live."""

    def build() -> dict[str, Any]:
        root = _models_root()
        return {
            "root": str(root),
            "root_exists": root.is_dir(),
            "runnable": _installed_weights(root),
        }

    return _cached("inventory", _INVENTORY_TTL_SECONDS, build)
