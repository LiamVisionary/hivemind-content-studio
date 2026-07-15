from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mlx.core as mx
from mlx import nn


KREA2_LORA_PREFIX = "diffusion_model."


@dataclass(frozen=True)
class ResolvedKrea2Lora:
    name: str
    path: str
    strength: float = 1.0


class LinearWithAdapters(nn.Module):
    def __init__(self, base: nn.Module, adapters: list[Any]):
        super().__init__()
        self.base = base
        self.adapters = adapters

    def __call__(self, x: mx.array) -> mx.array:
        out = self.base(x)
        for adapter in self.adapters:
            out = out + adapter(x, out.dtype)
        return out


class StandardLoraAdapter:
    def __init__(self, up: mx.array, down: mx.array, scale: float):
        self.up = up
        self.down = down
        self.scale = float(scale)

    def __call__(self, x: mx.array, dtype: mx.Dtype) -> mx.array:
        down = self.down.astype(dtype)
        up = self.up.astype(dtype)
        hidden = mx.matmul(x, down.T)
        out = mx.matmul(hidden, up.T)
        return out * self.scale


class LoKrAdapter:
    def __init__(self, w1: mx.array, w2: mx.array, scale: float):
        self.w1 = w1
        self.w2 = w2
        self.scale = float(scale)

    def __call__(self, x: mx.array, dtype: mx.Dtype) -> mx.array:
        c = self.w1.astype(dtype)
        w2 = self.w2.astype(dtype)
        if w2.ndim != 2:
            raise ValueError(f"Krea2 MLX LoKr only supports linear adapters; got w2 ndim={w2.ndim}")
        uq = int(c.shape[1])
        if int(x.shape[-1]) % uq != 0:
            raise ValueError(f"Krea2 MLX LoKr input dim {x.shape[-1]} is not divisible by {uq}")

        grouped = x.reshape(*x.shape[:-1], uq, -1)
        w2_out = mx.matmul(grouped, w2.T)
        cross = w2_out.swapaxes(-1, -2)
        w1_out = mx.matmul(cross, c.T)
        out = w1_out.swapaxes(-1, -2).reshape(*x.shape[:-1], -1)
        return out * self.scale


class FusedProjectionAdapter:
    def __init__(self, parts: list[Any | None], dims: list[int]):
        self.parts = parts
        self.dims = dims

    def __call__(self, x: mx.array, dtype: mx.Dtype) -> mx.array:
        outputs = []
        for adapter, dim in zip(self.parts, self.dims, strict=True):
            if adapter is None:
                outputs.append(mx.zeros((*x.shape[:-1], dim), dtype=dtype))
            else:
                outputs.append(adapter(x, dtype))
        return mx.concatenate(outputs, axis=-1)


def active_lora_signature(loras: list[dict[str, Any]] | None) -> str:
    normalized = []
    for entry in loras or []:
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        try:
            stat = os.stat(path)
            stamp = [int(stat.st_mtime_ns), int(stat.st_size)]
        except OSError:
            stamp = [0, 0]
        normalized.append({
            "path": os.path.realpath(path),
            "strength": float(entry.get("strength", 1.0)),
            "stamp": stamp,
        })
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def normalize_lora_entries(loras: list[dict[str, Any]] | None) -> list[ResolvedKrea2Lora]:
    normalized: list[ResolvedKrea2Lora] = []
    for entry in loras or []:
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        strength = float(entry.get("strength", 1.0))
        if strength == 0:
            continue
        p = Path(path).expanduser()
        if not p.exists():
            raise FileNotFoundError(f"Krea2 LoRA not found: {path}")
        normalized.append(ResolvedKrea2Lora(
            name=str(entry.get("name") or p.name),
            path=str(p),
            strength=strength,
        ))
    return normalized


def _scalar(value: mx.array | None) -> float | None:
    if value is None:
        return None
    return float(value.astype(mx.float32).item())


def _strip_prefix(key: str) -> str:
    return key[len(KREA2_LORA_PREFIX):] if key.startswith(KREA2_LORA_PREFIX) else key


def _group_lora_tensors(weights: dict[str, mx.array]) -> dict[str, dict[str, mx.array]]:
    grouped: dict[str, dict[str, mx.array]] = {}
    suffixes = {
        ".lora_A.weight": "down",
        ".lora_B.weight": "up",
        ".alpha": "alpha",
        ".lokr_w1": "lokr_w1",
        ".lokr_w2": "lokr_w2",
        ".lokr_w1_a": "lokr_w1_a",
        ".lokr_w1_b": "lokr_w1_b",
        ".lokr_w2_a": "lokr_w2_a",
        ".lokr_w2_b": "lokr_w2_b",
        ".lokr_t2": "lokr_t2",
    }
    for raw_key, tensor in weights.items():
        key = _strip_prefix(raw_key)
        for suffix, part in suffixes.items():
            if key.endswith(suffix):
                target = key[:-len(suffix)]
                grouped.setdefault(target, {})[part] = tensor
                break
    return grouped


def _make_adapter(parts: dict[str, mx.array], strength: float) -> Any | None:
    if "up" in parts and "down" in parts:
        down = parts["down"]
        rank = int(down.shape[0])
        alpha = _scalar(parts.get("alpha"))
        scale = strength * (alpha / rank if alpha is not None else 1.0)
        return StandardLoraAdapter(parts["up"], down, scale)

    if "lokr_w1" in parts and "lokr_w2" in parts:
        return LoKrAdapter(parts["lokr_w1"], parts["lokr_w2"], strength)

    if "lokr_w1_a" in parts and "lokr_w1_b" in parts and "lokr_w2_a" in parts and "lokr_w2_b" in parts:
        if "lokr_t2" in parts:
            raise ValueError("Krea2 MLX LoKr Tucker adapters are not supported yet.")
        w1 = mx.matmul(parts["lokr_w1_a"], parts["lokr_w1_b"])
        w2 = mx.matmul(parts["lokr_w2_a"], parts["lokr_w2_b"])
        rank = int(parts["lokr_w2_b"].shape[0])
        alpha = _scalar(parts.get("alpha"))
        scale = strength * (alpha / rank if alpha is not None else 1.0)
        return LoKrAdapter(w1, w2, scale)

    return None


def _get_parent(root: Any, path: str) -> tuple[Any, str] | None:
    current = root
    parts = path.split(".")
    for part in parts[:-1]:
        if isinstance(current, list):
            current = current[int(part)]
        else:
            if not hasattr(current, part):
                return None
            current = getattr(current, part)
    return current, parts[-1]


def _append_adapter(root: Any, path: str, adapter: Any) -> bool:
    parent_attr = _get_parent(root, path)
    if parent_attr is None:
        return False
    parent, attr = parent_attr
    if isinstance(parent, list):
        base = parent[int(attr)]
        if isinstance(base, LinearWithAdapters):
            base.adapters.append(adapter)
        else:
            parent[int(attr)] = LinearWithAdapters(base, [adapter])
        return True

    if not hasattr(parent, attr):
        return False
    base = getattr(parent, attr)
    if isinstance(base, LinearWithAdapters):
        base.adapters.append(adapter)
    else:
        setattr(parent, attr, LinearWithAdapters(base, [adapter]))
    return True


def _fused_main_block_targets(grouped: dict[str, dict[str, mx.array]], strength: float) -> dict[str, Any]:
    fused: dict[str, Any] = {}
    for block_index in range(28):
        prefix = f"blocks.{block_index}"
        qkv_parts = [
            _make_adapter(grouped.get(f"{prefix}.attn.wq", {}), strength),
            _make_adapter(grouped.get(f"{prefix}.attn.wk", {}), strength),
            _make_adapter(grouped.get(f"{prefix}.attn.wv", {}), strength),
            _make_adapter(grouped.get(f"{prefix}.attn.gate", {}), strength),
        ]
        if any(part is not None for part in qkv_parts):
            fused[f"{prefix}.attn.qkvgate"] = FusedProjectionAdapter(qkv_parts, [6144, 1536, 1536, 6144])

        gate_up_parts = [
            _make_adapter(grouped.get(f"{prefix}.mlp.gate", {}), strength),
            _make_adapter(grouped.get(f"{prefix}.mlp.up", {}), strength),
        ]
        if any(part is not None for part in gate_up_parts):
            fused[f"{prefix}.mlp.gate_up"] = FusedProjectionAdapter(gate_up_parts, [16384, 16384])
    return fused


def _direct_targets(grouped: dict[str, dict[str, mx.array]], strength: float) -> dict[str, Any]:
    direct: dict[str, Any] = {}
    for target, parts in grouped.items():
        if ".attn.wq" in target or ".attn.wk" in target or ".attn.wv" in target or ".attn.gate" in target:
            if target.startswith("blocks."):
                continue
        if (".mlp.gate" in target or ".mlp.up" in target) and target.startswith("blocks."):
            continue
        adapter = _make_adapter(parts, strength)
        if adapter is not None:
            direct[target] = adapter
    return direct


def apply_lora_stack_to_pipeline(pipeline: Any, loras: list[dict[str, Any]] | None) -> int:
    active = normalize_lora_entries(loras)
    if not active:
        return 0

    applied = 0
    transformer = pipeline.transformer
    for entry in active:
        weights = mx.load(entry.path)
        grouped = _group_lora_tensors(weights)
        if not grouped:
            raise ValueError(f"Krea2 LoRA has no recognized adapter tensors: {entry.name}")

        targets = {}
        targets.update(_fused_main_block_targets(grouped, entry.strength))
        targets.update(_direct_targets(grouped, entry.strength))

        applied_for_entry = 0
        for target, adapter in targets.items():
            if _append_adapter(transformer, target, adapter):
                applied_for_entry += 1
        if applied_for_entry == 0:
            raise ValueError(f"Krea2 LoRA did not match any MLX transformer layers: {entry.name}")
        applied += applied_for_entry
        print(
            f"[Krea2MLXLoRA] applied {applied_for_entry} layer adapters from {entry.name} "
            f"strength={entry.strength}",
            flush=True,
        )

    mx.eval(transformer.parameters())
    return applied
