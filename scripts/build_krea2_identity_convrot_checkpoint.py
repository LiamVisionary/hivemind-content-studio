#!/usr/bin/env python3
"""Build the Krea 2 Turbo identity LoRA into a reusable ConvRot checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
GATEWAY_DIR = ROOT / "packages/media-gateway"
sys.path.insert(0, str(GATEWAY_DIR))

from krea2_identity_workflow import (  # noqa: E402
    KREA2_IDENTITY_CONVROT_MODEL,
    KREA2_IDENTITY_LORA,
    KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
)


def request_json(url: str, payload=None, timeout=30):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_checkpoint(path: Path) -> dict:
    from safetensors import safe_open

    with safe_open(path, framework="pt", device="cpu") as handle:
        quant_keys = [key for key in handle.keys() if key.endswith(".comfy_quant")]
        convrot_layers = 0
        for key in quant_keys:
            config = json.loads(bytes(handle.get_tensor(key).tolist()).decode("utf-8"))
            convrot_layers += int(bool(config.get("convrot")))
    if len(quant_keys) < 224 or convrot_layers != len(quant_keys):
        raise RuntimeError(
            f"Checkpoint validation failed: {convrot_layers}/{len(quant_keys)} "
            "quantized layers contain ConvRot metadata"
        )
    return {
        "bytes": path.stat().st_size,
        "quantized_layers": len(quant_keys),
        "convrot_layers": convrot_layers,
    }


def comfy_output_dir(comfy_url: str, explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    stats = request_json(f"{comfy_url}/system_stats")
    argv = stats.get("system", {}).get("argv", [])
    for index, arg in enumerate(argv[:-1]):
        if arg == "--output-directory":
            return Path(argv[index + 1]).expanduser().resolve()
    return (Path.home() / "comfy/ComfyUI/output").resolve()


def build_checkpoint(comfy_url: str, comfy_dir: Path, output_dir: Path, target: Path) -> dict:
    source = comfy_dir / "models/diffusion_models" / KREA2_TURBO_PRE_LORA_SOURCE_MODEL
    lora = comfy_dir / "models/loras" / KREA2_IDENTITY_LORA
    for dependency in (source, lora):
        if not dependency.is_file():
            raise FileNotFoundError(str(dependency))

    object_info = request_json(f"{comfy_url}/object_info")
    missing_nodes = [
        name
        for name in ("MultiLoRAStackToPreLora", "OTUNetLoaderW8A8", "INT8ModelSave")
        if name not in object_info
    ]
    if missing_nodes:
        raise RuntimeError(f"ComfyUI is missing required nodes: {', '.join(missing_nodes)}")

    build_id = f"{int(time.time())}-{os.getpid()}"
    stem = f"Krea2_Turbo_identity_v1_2_convrot_int8mixed_build_{build_id}"
    filename_prefix = f"int8_models/{stem}"
    prompt = {
        "1": {
            "class_type": "MultiLoRAStackToPreLora",
            "inputs": {
                "lora_stack": json.dumps(
                    [{"on": True, "lora": KREA2_IDENTITY_LORA, "strength": 1.0}],
                    separators=(",", ":"),
                )
            },
        },
        "2": {
            "class_type": "OTUNetLoaderW8A8",
            "inputs": {
                "unet_name": KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
                "weight_dtype": "default",
                "model_type": "krea2",
                "on_the_fly_quantization": True,
                "enable_convrot": True,
                "lora_mode": "None",
                "pre_lora": ["1", 0],
            },
        },
        "3": {
            "class_type": "INT8ModelSave",
            "inputs": {"model": ["2", 0], "filename_prefix": filename_prefix},
        },
    }
    queued = request_json(
        f"{comfy_url}/prompt",
        {"prompt": prompt, "client_id": f"krea2-identity-checkpoint-{build_id}"},
    )
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI did not return a prompt id: {queued}")

    started = time.monotonic()
    history = None
    for _ in range(900):
        payload = request_json(f"{comfy_url}/history/{prompt_id}", timeout=10)
        if prompt_id in payload:
            history = payload[prompt_id]
            break
        time.sleep(1)
    if history is None:
        raise TimeoutError(f"Timed out waiting for ComfyUI prompt {prompt_id}")
    status = history.get("status", {})
    if status.get("status_str") != "success" or not status.get("completed"):
        raise RuntimeError(f"ComfyUI checkpoint build failed: {status}")

    candidates = sorted((output_dir / "int8_models").glob(f"{stem}_*.safetensors"))
    if not candidates:
        raise FileNotFoundError(f"ComfyUI completed but did not write checkpoint prefix {stem}")
    built = candidates[-1]
    validation = validate_checkpoint(built)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    shutil.copy2(built, partial)
    os.replace(partial, target)
    digest = sha256(target)
    metadata = {
        "artifact": target.name,
        "source_model": KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
        "identity_lora": KREA2_IDENTITY_LORA,
        "identity_strength": 1.0,
        "quantization": "INT8 W8A8 mixed precision with ConvRot",
        "sha256": digest,
        **validation,
    }
    target.with_suffix(".metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )
    try:
        built.unlink()
    except OSError:
        pass
    return {
        "status": "built",
        "prompt_id": prompt_id,
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "checkpoint": str(target),
        **metadata,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    parser.add_argument("--comfy-dir", type=Path, default=Path.home() / "comfy/ComfyUI")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    comfy_dir = args.comfy_dir.expanduser().resolve()
    target = comfy_dir / "models/diffusion_models" / KREA2_IDENTITY_CONVROT_MODEL
    if target.is_file() and not args.force:
        validation = validate_checkpoint(target)
        result = {
            "status": "reused",
            "checkpoint": str(target),
            "sha256": sha256(target),
            **validation,
        }
        target.with_suffix(".metadata.json").write_text(
            json.dumps({
                "artifact": target.name,
                "source_model": KREA2_TURBO_PRE_LORA_SOURCE_MODEL,
                "identity_lora": KREA2_IDENTITY_LORA,
                "identity_strength": 1.0,
                "quantization": "INT8 W8A8 mixed precision with ConvRot",
                **result,
            }, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps(result, indent=2))
        return 0

    result = build_checkpoint(
        args.comfy_url.rstrip("/"),
        comfy_dir,
        comfy_output_dir(args.comfy_url.rstrip("/"), args.output_dir),
        target,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
