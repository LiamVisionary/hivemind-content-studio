"""TensorRT acceleration for SeedVR2's VAE decode — the decision rules.

WHAT IS ACCELERATED, AND WHY IT IS SAFE TO. SeedVR2's decode path
(`VideoAutoencoderKL._decode`) is stateful in general: its causal 3D convolutions
carry a memory bank between temporal slices, keyed by a `MemoryState`. That is
not a function, and it cannot be an engine.

But with `MemoryState.DISABLED` — which is every call the upscaler actually makes
on a single GPU, because the context-parallel slice/gather helpers are no-ops
there — the whole of `_decode` reduces to::

    decoder(post_quant_conv(z))

…a pure function of one tensor. THAT is what gets built into an engine, and any
call carrying live memory state falls straight through to PyTorch. The seam is
narrow on purpose.

WHY A CHUNKED RENDER IS THE RIGHT WORKLOAD FOR THIS. An engine wants stable
shapes, and building one costs minutes. A restoration is dozens of chunks at ONE
resolution with ONE temporal batch, so the decode shape is constant for the whole
project — the first chunk pays for the engine and every chunk after it is free.
That is also why this is not offered for a two-second preview: a preview is a
single chunk, and it would pay the build and never collect.

(Tiling, when the lane turns it on, makes the shape constant across projects too,
because the decoder is then called per fixed-size tile. It is not required — an
untiled decode is equally stable WITHIN a project, which is the case that
matters here.)

THREE RULES THIS MODULE EXISTS TO ENFORCE, all of which are about not making
things worse on a machine somebody is paying for by the hour:

1. **A build is never free, so it is never implicit.** Compiling an engine is
   minutes of billed GPU. The caller says whether this job may build one; a
   preview says no and simply uses PyTorch.
2. **An engine is adopted only if it is measurably faster.** TRT does not win on
   every shape and every card. Both paths are timed on the real tile, and a
   slower engine is discarded — an "acceleration" that loses is a bug, not a
   trade-off.
3. **An engine is adopted only if it produces the same picture.** The output is
   compared against PyTorch's on the same input, and an engine outside tolerance
   is discarded. A faster decoder that changes the pixels is not a decoder.

Anything that raises anywhere in here falls back to PyTorch and records why.
A rented render must never be broken by an optimisation.
"""

from __future__ import annotations

import hashlib
import os
import time

# Torch is imported lazily by callers; this module must be importable (and
# testable) on a machine with no CUDA, no TensorRT and no torch at all.
try:  # pragma: no cover - exercised on the rental, not in unit tests
    import torch
except Exception:  # pragma: no cover
    torch = None


# How much faster TRT has to be before it is worth using at all. Below this the
# engine is discarded: the cache, the build time and the extra moving part are
# not worth a rounding error.
MIN_SPEEDUP = 1.10

# How close the engine's picture has to be to PyTorch's. THREE numbers, because
# one is the wrong test for a reordered floating-point pipeline and a max on its
# own fails a perfectly good engine.
#
# MEASURED 2026-08-31, RTX 5090, TensorRT-RTX 1.6.1, bf16 weights, identical
# tiling on both sides: max 3.044%, mean 0.0492%, 0.0054% of pixels over 1%.
# bf16 carries an 8-bit mantissa — a unit roundoff around 0.4% — and TensorRT
# reorders and fuses arithmetic, so a handful of outlier pixels is what correct
# looks like. A genuinely different picture is different on AVERAGE.
#
# Each limit catches a different failure and none of them is slack:
#   mean      a systematically different picture
#   fraction  a corrupted REGION, which lights up many pixels at once
#   max       a catastrophic single value (an inf or nan path)
# The measured figures sit 10x, 18x and 3x inside them respectively.
MAX_RELATIVE_ERROR = 0.10
MAX_MEAN_ERROR = 0.005
MAX_FRACTION_OVER_ONE_PERCENT = 0.001

# A decode this small is not worth an engine — the launch overhead dominates and
# the build would never pay for itself.
MIN_ELEMENTS_TO_ACCELERATE = 1 << 16


# THE WHOLE THING WORKS, AND IT DOES NOT HELP. Both halves are measured.
#
# WORKS (RTX 5090, TensorRT-RTX 1.6.1, bf16, 2026-08-31): the decoder exports to
# ONNX, TensorRT-RTX builds a 294MB engine from it, and the tiled runtime
# decodes a 1080p latent correctly — mean error 0.049% against an identically
# tiled PyTorch decode, 0.0054% of pixels over 1%. That is bf16 rounding noise
# (bf16's unit roundoff is ~0.4%), not a different picture.
#
# DOES NOT HELP, same run, same latent, median of three:
#     untiled PyTorch   2.253s
#     tiled PyTorch     2.531s
#     tiled TensorRT    2.587s     <- 0.98x. No speedup, on identical tiling.
# The decoder is large 3D convolutions that PyTorch already runs near peak;
# there is no fusion or tactic left for TensorRT to win. Tiling then adds
# 1.4-1.9x the pixels (overlap, plus flushing the last tile to the edge), so
# against an untiled decode it is 0.87x — slower.
#
# AND IT COULD NOT HAVE HELPED MUCH ANYWAY. In the same render, a chunk spent
# ~5.6s encoding, ~15.9s in DiT sampling and ~2.3s decoding. The VAE decode is
# under a tenth of the time. Even a hypothetical 2x decode is ~4% off a render.
# The reference implementation says the same thing in its own README: the VAE is
# the FIRST target and "the DiT graph and custom temporal operators can be
# tackled" afterwards. The DiT is where the time is, and it is not done there.
#
# Three earlier attempts through PyTorch's own compiler failed outright and are
# recorded so nobody repeats them: torch.export hit a data-dependent guard that
# a static shape did not remove; torch.compile(backend="tensorrt") hit
# TensorRT's rank-8 limit on a rank-10 tensor; and with that fixed it aborted
# the process with a CUDA illegal memory access. The ONNX path avoids all three
# by never entering that compiler.
KNOWN_BLOCKER = (
    "TensorRT is not available on this machine — the decode runs on PyTorch."
)


class TrtUnavailable(RuntimeError):
    """TensorRT cannot be used here. Always carries the reason, in words."""


def describe_environment(*, torch_module=None, tensorrt_module=None) -> dict:
    """What this machine can actually do, as a sentence the studio can show.

    Asked rather than assumed, and asked SEPARATELY from "is it switched on":
    "no CUDA device" and "torch-tensorrt is not installed" are different
    problems with different fixes, and collapsing them into `available: false`
    is how a fixable box looks broken.
    """
    state = {
        "available": False,
        "reason": "",
        "device": "",
        "tensorrt": "",
        "flavour": "",
    }
    torch_module = torch_module if torch_module is not None else torch
    if torch_module is None:
        state["reason"] = "PyTorch is not importable in this ComfyUI"
        return state
    try:
        if not torch_module.cuda.is_available():
            state["reason"] = "this machine has no CUDA device — TensorRT is NVIDIA only"
            return state
        state["device"] = torch_module.cuda.get_device_name(0)
    except Exception as exc:
        state["reason"] = f"CUDA could not be queried: {exc}"
        return state
    module = tensorrt_module
    flavour = "tensorrt_rtx"
    if module is None:
        # TensorRT-RTX first: it is what a consumer RTX card ships with and what
        # the reference implementation builds against. Stock TensorRT exposes
        # the same builder and runtime API, so either will do.
        try:
            import tensorrt_rtx as module  # type: ignore
        except Exception:
            try:
                import tensorrt as module  # type: ignore
                flavour = "tensorrt"
            except Exception as exc:
                state["reason"] = (
                    "neither tensorrt-rtx nor tensorrt is installed on this machine "
                    f"(pip install tensorrt-rtx) — {type(exc).__name__}"
                )
                return state
    state["tensorrt"] = str(getattr(module, "__version__", "unknown"))
    state["flavour"] = flavour
    state["available"] = True
    return state


def should_accelerate(*, memory_state_disabled: bool, elements: int, enabled: bool) -> tuple[bool, str]:
    """Whether this particular decode call is a candidate at all.

    Pure, and separated from everything that needs a GPU, because these three
    rules are the ones that decide whether a render is correct — a call that
    carries live causal-conv memory MUST go to PyTorch, and getting that wrong
    would corrupt long clips in a way that looks like a model artefact.
    """
    if not enabled:
        return False, "TensorRT is switched off for this job"
    if not memory_state_disabled:
        # The memory bank is the whole reason this is not a pure function.
        return False, "this decode carries causal-conv memory across slices"
    if elements < MIN_ELEMENTS_TO_ACCELERATE:
        return False, "this decode is too small for an engine to pay for itself"
    return True, ""


def engine_cache_key(
    *,
    weights_fingerprint: str,
    shape: tuple[int, ...],
    dtype: str,
    device_name: str,
    torch_tensorrt_version: str,
    fp16: bool,
) -> str:
    """One key over everything that would make a cached engine wrong.

    The device name and the library version are in here because an engine is
    built for a specific architecture and serialized by a specific version;
    reusing one across either is not a cache hit, it is undefined behaviour on
    a machine somebody is paying for.
    """
    parts = [
        weights_fingerprint,
        "x".join(str(int(value)) for value in shape),
        dtype,
        device_name,
        torch_tensorrt_version,
        "fp16" if fp16 else "native",
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


# There is deliberately no shape profile here, and that is a MEASURED decision
# rather than an omission. A dynamic temporal dimension is what an optimization
# profile would be for, and exporting one fails: the causal convolutions branch
# in Python on whether the temporal size is 1, so `torch.export` cannot decide
# the branch (GuardOnDataDependentSymNode, on a rented 5090, 2026-08-31).
#
# Engines are therefore built per exact shape, which `engine_cache_key` already
# distinguishes. That costs nothing here: a project renders dozens of chunks at
# one resolution and one batch, so it has at most two decode shapes — the full
# batch and the chunk's tail.


def error_stats(reference, candidate) -> dict:
    """How far the engine's picture is from PyTorch's — max AND mean.

    Relative to the output's range rather than absolute: the decoder's output is
    roughly [-1, 1] but not exactly, and an absolute threshold would be a
    different test at different exposures.

    Both numbers are needed, and one alone misleads in opposite directions. A
    max on its own condemns an engine for a handful of outlier pixels, which is
    what bf16 rounding produces when TensorRT reorders and fuses arithmetic. A
    mean on its own hides a corrupted region inside four million good pixels.
    A picture that is genuinely different is different on AVERAGE.
    """
    difference = (reference.float() - candidate.float()).abs()
    span = (reference.float().max() - reference.float().min()).abs().item()
    scale = span if span > 1e-6 else 1.0
    above = (difference / scale > 0.01).float().mean().item()
    return {
        "max": difference.max().item() / scale,
        "mean": difference.mean().item() / scale,
        "fraction_above_1pct": above,
    }


def relative_error(reference, candidate) -> float:
    """The worst single pixel, kept for callers that only want one number."""
    return error_stats(reference, candidate)["max"]


def verdict(*, torch_seconds: float, trt_seconds: float, error: float,
            stats: dict | None = None) -> tuple[bool, str]:
    """Keep this engine, or throw it away and say why.

    Both halves matter and neither is negotiable. An engine that is slower is
    pure overhead; an engine outside tolerance is a different picture. The
    sentence is kept because it ends up in the studio, where "TensorRT is off"
    with no reason is indistinguishable from a bug.
    """
    stats = stats or {"max": error, "mean": 0.0, "fraction_above_1pct": 0.0}
    if stats["mean"] > MAX_MEAN_ERROR:
        return False, (
            f"the engine's picture differs from PyTorch's on average by "
            f"{stats['mean']:.3%} (limit {MAX_MEAN_ERROR:.1%}) — kept PyTorch"
        )
    if stats["fraction_above_1pct"] > MAX_FRACTION_OVER_ONE_PERCENT:
        return False, (
            f"{stats['fraction_above_1pct']:.3%} of the engine's pixels are more than 1% "
            f"off PyTorch's (limit {MAX_FRACTION_OVER_ONE_PERCENT:.1%}) — kept PyTorch"
        )
    if stats["max"] > MAX_RELATIVE_ERROR:
        return False, (
            f"one of the engine's pixels is {stats['max']:.3%} off PyTorch's "
            f"(limit {MAX_RELATIVE_ERROR:.0%}) — kept PyTorch"
        )
    if trt_seconds <= 0 or torch_seconds <= 0:
        return False, "the comparison could not be timed — kept PyTorch"
    speedup = torch_seconds / trt_seconds
    if speedup < MIN_SPEEDUP:
        return False, (
            f"TensorRT was only {speedup:.2f}x here, below the {MIN_SPEEDUP:.2f}x "
            "worth keeping — kept PyTorch"
        )
    return True, f"TensorRT VAE decode is {speedup:.2f}x faster on this machine"


def cache_dir() -> str:
    """Where built engines live. Beside the weights, on the machine that built
    them — an engine is architecture- and version-specific and is never shared
    between boxes."""
    override = os.environ.get("HIVEMIND_SEEDVR2_TRT_CACHE", "").strip()
    if override:
        return override
    comfy = os.environ.get("COMFYUI_DIR", "").strip()
    if comfy:
        return os.path.join(comfy, "models", "SEEDVR2", "trt-cache")
    return os.path.join(os.path.expanduser("~"), ".cache", "hivemind-seedvr2-trt")


def weights_fingerprint(module) -> str:
    """A cheap, stable identity for the decoder's weights.

    Shapes and a sample of values rather than a full hash of several GB: the
    thing this has to catch is a DIFFERENT checkpoint, not a bit flip, and
    hashing the whole VAE on every decode would cost more than the engine saves.
    """
    digest = hashlib.sha256()
    for name, tensor in sorted(module.state_dict().items()):
        digest.update(name.encode("utf-8"))
        digest.update("x".join(str(int(v)) for v in tensor.shape).encode("utf-8"))
        flat = tensor.detach().flatten()
        if flat.numel():
            sample = flat[:: max(1, flat.numel() // 8)][:8].float().cpu()
            digest.update(",".join(f"{value:.4f}" for value in sample.tolist()).encode("utf-8"))
    return digest.hexdigest()[:16]


def time_call(function, *args, repeats: int = 3) -> float:
    """Median wall time of a callable, with the GPU actually finished.

    Median rather than mean: the first call of either path allocates, and one
    outlier would otherwise decide whether an engine is adopted.
    """
    samples = []
    for _ in range(max(1, repeats)):
        if torch is not None and torch.cuda.is_available():
            torch.cuda.synchronize()
        started = time.perf_counter()
        function(*args)
        if torch is not None and torch.cuda.is_available():
            torch.cuda.synchronize()
        samples.append(time.perf_counter() - started)
    samples.sort()
    return samples[len(samples) // 2]
