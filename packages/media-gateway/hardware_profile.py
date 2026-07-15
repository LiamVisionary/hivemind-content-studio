#!/usr/bin/env python3
"""Hardware capability profile for Z-Image runtime routing.

This deliberately keeps Apple Silicon optimizations behind an Apple Silicon
profile so public builds can add CUDA/ROCm routes without inheriting MLX/Metal
or ASFP8 env flags by accident.
"""

import argparse
import json
import os
import platform
import shlex
import shutil


KNOWN_PROFILES = {"apple-silicon", "apple-intel", "cuda", "rocm", "cpu"}


def normalize_profile(value):
    raw = str(value or "auto").strip().lower().replace("_", "-")
    aliases = {
        "auto": "auto",
        "apple": "apple-silicon",
        "mac": "apple-silicon",
        "macos": "apple-silicon",
        "mps": "apple-silicon",
        "mlx": "apple-silicon",
        "metal": "apple-silicon",
        "apple-silicon": "apple-silicon",
        "apple-intel": "apple-intel",
        "intel-mac": "apple-intel",
        "nvidia": "cuda",
        "cuda": "cuda",
        "amd": "rocm",
        "rocm": "rocm",
        "cpu": "cpu",
    }
    return aliases.get(raw, raw if raw in KNOWN_PROFILES else "auto")


def detect_profile(env=None, system_name=None, machine_name=None, which=shutil.which):
    if env is None:
        env = os.environ
    requested = normalize_profile(env.get("ZIMG_ACCELERATOR_PROFILE") or env.get("ZIMG_HARDWARE_PROFILE"))
    if requested != "auto":
        return requested

    system_name = (system_name or platform.system() or "").lower()
    machine_name = (machine_name or platform.machine() or "").lower()
    if system_name == "darwin":
        return "apple-silicon" if machine_name in {"arm64", "aarch64"} else "apple-intel"

    cuda_visible = env.get("CUDA_VISIBLE_DEVICES")
    cuda_not_disabled = cuda_visible is None or cuda_visible.strip() not in {"", "-1", "none", "None"}
    if cuda_not_disabled and which("nvidia-smi"):
        return "cuda"
    if which("rocm-smi") or which("rocminfo"):
        return "rocm"
    return "cpu"


def capabilities_for_profile(profile=None):
    profile = normalize_profile(profile or detect_profile())
    apple_silicon = profile == "apple-silicon"
    return {
        "profile": profile,
        "apple_silicon": apple_silicon,
        "apple_silicon_optimizations": apple_silicon,
        "native_mlx": apple_silicon,
        "swift_flux2": apple_silicon,
        "asfp8_int8_ext": apple_silicon,
        "asfp8_fp8_ext": apple_silicon,
        "asfp8_trace_ops": False,
        "asfp8_profile": False,
        "comfy_attention": "--use-quad-cross-attention" if apple_silicon else "",
    }


def shell_assignments(caps):
    mapping = {
        "ZIMG_ACCELERATOR_PROFILE": caps["profile"],
        "ZIMG_IS_APPLE_SILICON": "1" if caps["apple_silicon"] else "0",
        "ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS": "1" if caps["apple_silicon_optimizations"] else "0",
        "ZIMG_DEFAULT_ENABLE_FLUX2_SERVER": "1" if caps["swift_flux2"] else "0",
        "ZIMG_DEFAULT_ASFP8_INT8_EXT": "1" if caps["asfp8_int8_ext"] else "0",
        "ZIMG_DEFAULT_ASFP8_FP8_EXT": "1" if caps["asfp8_fp8_ext"] else "0",
        "ZIMG_DEFAULT_ASFP8_TRACE_OPS": "1" if caps["asfp8_trace_ops"] else "0",
        "ZIMG_DEFAULT_ASFP8_PROFILE": "1" if caps["asfp8_profile"] else "0",
        "ZIMG_DEFAULT_COMFY_ATTENTION": caps["comfy_attention"],
    }
    return "\n".join(f"{key}={shlex.quote(value)}" for key, value in mapping.items())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shell", action="store_true", help="print shell assignments")
    args = parser.parse_args()
    caps = capabilities_for_profile()
    if args.shell:
        print(shell_assignments(caps))
    else:
        print(json.dumps(caps, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
