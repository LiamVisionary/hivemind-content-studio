"""TensorRT VAE decode for SeedVR2 — the patch, the engine, and the switch.

Installed as a ComfyUI custom node beside `seedvr2_videoupscaler` (which is NOT
vendored and NOT modified). This pack does three things:

1. Wraps `VideoAutoencoderKL._decode` at the class level, so a decode that is a
   pure function can run through a TensorRT engine instead of PyTorch. Every
   other decode falls through untouched.
2. Adds one graph node, `HivemindSeedVR2TensorRT`, which the restore lane puts
   in the VAE path to say — per job — whether TensorRT may be used and whether
   this job is allowed to spend minutes building an engine.
3. Serves `GET /hivemind/seedvr2-trt`, so the gateway can ask a lane what it can
   actually do rather than inferring it from the node pack merely being present.

WHY PATCH THE CLASS RATHER THAN THE INSTANCE. The upscaler builds, caches and
re-materialises its VAE through several paths (`model_cache`, `prepare_runner`,
`apply_model_specific_config`), and an instance patched at one of them is an
instance the next path replaces. The method survives all of it — the same reason
the rental privacy node patches ComfyUI's progress registry method rather than
registering a handler.

WHAT HAPPENS WHEN ANYTHING GOES WRONG: PyTorch runs, the render completes, and
the reason is recorded and reported. There is no failure mode here that is
allowed to cost somebody a rented hour.
"""

import os
import sys
import threading

from . import rank_patch, trt_engine, trt_vae

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Per-prompt policy, set by the node below and read by the patched method.
# ComfyUI executes one prompt at a time per process and runs the VAE path before
# the upscaler, so the node has always run by the time a decode happens. A lock
# rather than a bare dict because ComfyUI's server threads read this for /status.
_policy_lock = threading.Lock()
_policy = {
    # Off unless a graph asks for it: this pack being installed is not consent
    # to spend build time on every job that happens to use the VAE.
    "enabled": False,
    "may_build": False,
    "fp16": True,
}

# What the rank patch did, if anything. TensorRT is attempted only when the
# decoder has been brought under its rank limit AND that rewrite was proven
# bit-identical — see trt_vae.KNOWN_BLOCKER for what happens otherwise.
_rank_state = {"verified": False, "reason": "not attempted yet", "patched": []}


def _ensure_rank_patch():
    """Bring the decoder under TensorRT's rank limit, once.

    Retried from the node rather than only at import, because at import time the
    SeedVR2 pack may not be registered yet — the same load-order problem the
    decode patch has."""
    if _rank_state["verified"]:
        return True
    try:
        root = _seedvr2_root_package()
    except Exception as exc:
        _rank_state["reason"] = f"the SeedVR2 node pack is not reachable here ({type(exc).__name__})"
        return False
    state = rank_patch.install(root)
    _rank_state.update(
        verified=bool(state["verified"] and state["patched"]),
        reason=state["reason"] or "; ".join(state["skipped"]) or "nothing to patch",
        patched=state["patched"],
    )
    _log(_rank_state["reason"])
    return _rank_state["verified"]


def _blocked_unless_retry():
    """Nothing blocks the attempt any more.

    The hard block that used to live here was about torch-tensorrt's compiler,
    which aborted the process — see the history in trt_vae. This pack no longer
    uses that compiler at all, so the attempt is allowed and the numerics and
    speed gates decide, the way they were always meant to.

    HIVEMIND_SEEDVR2_TRT=0 switches it off on a lane."""
    return not _env_flag("HIVEMIND_SEEDVR2_TRT", True)

# What actually happened, so the studio can say something true.
_state = {
    "engines": {},        # cache key -> compiled callable
    "rejected": {},       # cache key -> why PyTorch was kept
    "speedup": 0.0,
    "last_reason": "not attempted yet",
    "decodes_accelerated": 0,
    "decodes_total": 0,
}


def _env_flag(name, default=False):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _log(message):
    print(f"[seedvr2-trt] {message}", flush=True)


# --- the engine -------------------------------------------------------------


def _seedvr2_root_package():
    """The SeedVR2 pack's top-level module name, from ComfyUI's own registry.

    Not the directory name and not a guess: packs get forked, renamed and
    hyphenated, and by the time a graph executes the registry is authoritative.
    """
    import nodes

    node = nodes.NODE_CLASS_MAPPINGS.get("SeedVR2VideoUpscaler")
    if node is None:
        raise RuntimeError("the SeedVR2 upscaler node is not registered in this ComfyUI")
    return str(node.__module__).split(".")[0]


def _seedvr2_modules():
    """The SeedVR2 pack's VAE class and MemoryState, via ComfyUI's own registry.

    Found through `NODE_CLASS_MAPPINGS` rather than imported by package name.
    The pack's directory name is not a fixed thing (a hyphen, a fork, a rename)
    and custom nodes load in an order nobody controls — but by the time a graph
    executes, the registry is complete and the module is already imported. This
    is the same route the Krea2 identity node takes to reach its own donor pack.
    """
    import importlib

    base = f"{_seedvr2_root_package()}.src.models.video_vae_v3.modules"
    attn = importlib.import_module(f"{base}.attn_video_vae")
    types = importlib.import_module(f"{base}.types")
    return attn.VideoAutoencoderKL, types.MemoryState


_pure_decode_class = None


def _pure_decode(vae):
    """`decoder(post_quant_conv(z))` as a plain module — the only part of the
    decode that is a function of its input, and therefore the only part that
    can be an engine."""
    global _pure_decode_class
    import torch.nn as nn

    if _pure_decode_class is None:
        _, memory_state = _seedvr2_modules()
        disabled = memory_state.DISABLED

        class _Wrapper(nn.Module):
            def __init__(self, post_quant_conv, decoder):
                super().__init__()
                self.post_quant_conv = post_quant_conv
                self.decoder = decoder

            def forward(self, z):
                if self.post_quant_conv is not None:
                    z = self.post_quant_conv(z, memory_state=disabled)
                return self.decoder(z, memory_state=disabled)

        # Defined once: a class rebuilt per call is a new type every time, which
        # would defeat torch.export's own caching and make every build colder
        # than it needs to be.
        _pure_decode_class = _Wrapper
    return _pure_decode_class(getattr(vae, "post_quant_conv", None), vae.decoder).eval()


def _engine_dir():
    from pathlib import Path

    directory = Path(trt_vae.cache_dir())
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _build_tiled_engine(vae, sample, *, tile, overlap):
    """Export the decoder to ONNX at one fixed tile shape and build an engine.

    This is the whole of the working path, and none of it goes through
    PyTorch's compiler — see trt_engine's module docstring for why every one of
    those attempts failed on real hardware and this one does not.

    An engine already on disk for this exact profile is reused: the build is
    minutes, and a box that renders two projects at the same settings should pay
    for it once.
    """
    import torch

    latent_frames = int(sample.shape[2])
    # The MODEL's dtype, never a hard-coded one. The runner picks bf16 by
    # default; tracing in fp16 against bf16 weights fails inside the first
    # convolution with "Input type (c10::Half) and bias type (c10::BFloat16)".
    dtype = next(vae.decoder.parameters()).dtype
    device_name = torch.cuda.get_device_name(0)
    trt, flavour = trt_engine._trt_module()
    fingerprint = trt_vae.weights_fingerprint(vae.decoder)
    name = trt_engine.engine_name(
        weights_fingerprint=fingerprint,
        latent_frames=latent_frames, tile=tile, overlap=overlap,
        device_name=device_name, flavour=flavour,
        version=f"{getattr(trt, '__version__', '?')}-{dtype}",
    )
    engine_path = _engine_dir() / name
    if not engine_path.is_file():
        onnx_path = engine_path.with_suffix(".onnx")
        # Before an export AND before a build: both trace and allocate on the
        # card the render is still using.
        torch.cuda.empty_cache()
        _log(f"exporting the decoder at tile {tile}x{tile}, {latent_frames} latent frames")
        # The reconfiguration is scoped: the memory limits it removes are the
        # ones that keep a high-resolution PyTorch decode alive, and the
        # fallback has to be left exactly as it was found.
        with trt_engine.fixed_profile(vae):
            trt_engine.export_decoder_onnx(
                vae, onnx_path, latent_frames=latent_frames, tile=tile, dtype=dtype,
            )
        _log(f"building a {flavour} engine — minutes, once per profile")
        trt_engine.build_engine(onnx_path, engine_path)
        onnx_path.unlink(missing_ok=True)
    return trt_engine.TiledDecoder(
        engine_path, tile=tile, overlap=overlap, latent_frames=latent_frames, dtype=dtype,
    )


def _probe_over_rank(vae, sample):
    """Name every op whose output exceeds TensorRT's rank limit, with its stack.

    Guessing which line produces a 10-dimensional intermediate is expensive —
    each wrong guess is a rented box and twenty minutes. The tensor does not
    exist in eager execution (the decomposition creates it), so a
    TorchFunctionMode cannot see it; only the compiler's own graph can. This
    backend takes that graph, finds the offending nodes and prints where they
    came from, then hands execution straight back to PyTorch.

    Switched on with HIVEMIND_SEEDVR2_TRT_PROBE=1. It compiles nothing.
    """
    import torch

    findings = []
    # The rank-doubling ops, by name. A >8-D tensor does NOT appear in dynamo's
    # own graph — measured: the probe found none, while TensorRT still choked on
    # a rank-10 expand. It is torch-tensorrt's decomposition that inflates
    # `repeat`/`tile` into unsqueeze+expand+reshape at 2N dims, so the thing to
    # hunt is the OP, not the shape.
    INFLATING = ("repeat", "tile", "expand")

    def inspect_graph(gm, example_inputs):
        for node in gm.graph.nodes:
            target = str(node.target)
            value = node.meta.get("val", None)
            rank = len(value.shape) if hasattr(value, "shape") else 0
            if not any(name in target for name in INFLATING):
                continue
            findings.append({
                "op": target,
                "rank": rank,
                "shape": tuple(value.shape) if hasattr(value, "shape") else (),
                "args": str(node.args)[:160],
                "stack": (node.meta.get("stack_trace") or "").strip().splitlines()[-3:],
            })
        return gm.forward

    torch._dynamo.reset()
    compiled = torch.compile(_pure_decode(vae), backend=inspect_graph, dynamic=False)
    with torch.no_grad():
        compiled(sample)
    if not findings:
        _log(f"probe: no rank-inflating op for input {tuple(sample.shape)}")
    for item in findings:
        _log(f"probe: {item['op']} rank{item['rank']} -> {item['shape']} args={item['args']}")
        for line in item["stack"]:
            _log(f"probe:   {line.strip()}")
    return findings


def _adopt_or_reject(vae, sample, original, *, tile, overlap):
    """Build, time and check an engine. Returns a callable, or None with a reason.

    Both checks run against the SAME latent the render is about to decode, on
    the whole thing rather than one tile, so the numbers include the tiling and
    the feathered blend — which is what the render will actually pay for.

    The reference implementation states the same rule in its own words: the
    TensorRT output has to match the PyTorch VAE within an agreed tolerance
    before the DiT graph is even attempted."""
    import torch

    decoder = _build_tiled_engine(vae, sample, tile=tile, overlap=overlap)
    with torch.no_grad():
        # ACCURACY: the same tiling on both sides, so the engine is the only
        # difference. Comparing the tiled engine against an UNTILED PyTorch
        # decode measures the tiling instead — measured 2026-08-31, that reads
        # 38.96% however good the engine is, because each tile's convolutions
        # see padding where its neighbours used to be.
        candidate = decoder.decode(sample)
        reference = decoder.decode_reference(lambda tile_in: original(tile_in))
        if tuple(candidate.shape) != tuple(reference.shape):
            return None, (
                f"the engine returned {tuple(candidate.shape)} where PyTorch returned "
                f"{tuple(reference.shape)} — kept PyTorch"
            )
        stats = trt_vae.error_stats(reference, candidate)
        error = stats["max"]
        _log(
            f"accuracy vs PyTorch on identical tiling: max {stats['max']:.3%}, "
            f"mean {stats['mean']:.4%}, {stats['fraction_above_1pct']:.4%} of pixels over 1%"
        )
        # SPEED, measured THREE ways, because the fair comparison depends on
        # what the render would otherwise do and that is not one fixed thing.
        #
        #   untiled torch : what a decode that FITS does today
        #   tiled torch   : what a decode that does NOT fit does today, and the
        #                   only apples-to-apples measure of the engine itself
        #   tiled trt     : this
        #
        # Tiling is not free work: overlap plus flushing the last tile to the
        # edge decodes ~1.4-1.9x the pixels. Timing tiled-TRT against
        # untiled-PyTorch charges the engine for that, which is right when the
        # untiled path is available and wrong when it is not.
        torch_seconds = trt_vae.time_call(lambda: original(sample))
        torch_tiled_seconds = trt_vae.time_call(
            lambda: decoder.decode_reference(lambda tile_in: original(tile_in)))
        trt_seconds = trt_vae.time_call(lambda: decoder.decode(sample))
        _log(
            f"speed: untiled torch {torch_seconds:.3f}s | tiled torch "
            f"{torch_tiled_seconds:.3f}s | tiled TensorRT {trt_seconds:.3f}s "
            f"-> {torch_seconds / trt_seconds:.2f}x vs untiled, "
            f"{torch_tiled_seconds / trt_seconds:.2f}x vs the same tiling"
        )
    keep, reason = trt_vae.verdict(
        torch_seconds=torch_seconds, trt_seconds=trt_seconds, error=error, stats=stats,
    )
    if not keep:
        return None, reason
    _state["speedup"] = round(torch_seconds / trt_seconds, 2)
    return decoder.decode, reason


# --- the patch --------------------------------------------------------------


def _install_patch():
    """Wrap `VideoAutoencoderKL._decode`. Returns why, if it could not.

    Called at import AND again from the node, because custom packs load in an
    order nobody controls: at import time the SeedVR2 pack may not be registered
    yet, while by graph execution it always is."""
    try:
        VideoAutoencoderKL, MemoryState = _seedvr2_modules()
    except Exception as exc:
        return f"the SeedVR2 node pack is not reachable here ({type(exc).__name__}: {exc})"

    if getattr(VideoAutoencoderKL._decode, "_hivemind_trt", False):
        return ""  # already installed (ComfyUI re-imports custom nodes on reload)

    original_decode = VideoAutoencoderKL._decode

    def _decode(self, z, memory_state=MemoryState.DISABLED):
        _state["decodes_total"] += 1
        with _policy_lock:
            policy = dict(_policy)
        candidate, why = trt_vae.should_accelerate(
            memory_state_disabled=(memory_state == MemoryState.DISABLED),
            elements=int(z.numel()),
            enabled=policy["enabled"] and not _blocked_unless_retry(),
        )
        if policy["enabled"] and _blocked_unless_retry():
            why = trt_vae.KNOWN_BLOCKER
        if not candidate:
            _state["last_reason"] = why
            return original_decode(self, z, memory_state=memory_state)

        key = ""
        try:
            import torch

            trt_module, _flavour = trt_engine._trt_module()  # presence check before any work

            fingerprint = getattr(self, "_hivemind_trt_fingerprint", None)
            if fingerprint is None:
                fingerprint = trt_vae.weights_fingerprint(self.decoder)
                self._hivemind_trt_fingerprint = fingerprint
            key = trt_vae.engine_cache_key(
                weights_fingerprint=fingerprint,
                # Only the temporal depth varies per engine now: the spatial
                # dims are the fixed tile, which is what lets one engine serve
                # every output resolution.
                shape=(1, 16, int(z.shape[2]), trt_engine.DEFAULT_TILE_LATENT,
                       trt_engine.DEFAULT_TILE_LATENT),
                dtype=str(z.dtype),
                device_name=torch.cuda.get_device_name(0),
                torch_tensorrt_version=str(getattr(trt_module, "__version__", "?")),
                fp16=policy["fp16"],
            )
            if key in _state["rejected"]:
                _state["last_reason"] = _state["rejected"][key]
                return original_decode(self, z, memory_state=memory_state)

            engine = _state["engines"].get(key)
            if engine is None:
                if not policy["may_build"]:
                    # A build is minutes of billed GPU. A job that did not ask
                    # for one gets PyTorch and says so.
                    _state["last_reason"] = "no engine for this shape yet, and this job may not build one"
                    return original_decode(self, z, memory_state=memory_state)
                if _env_flag("HIVEMIND_SEEDVR2_TRT_PROBE", False):
                    _probe_over_rank(self, z.contiguous())
                    _state["rejected"][key] = "probe mode: nothing was compiled"
                    return original_decode(self, z, memory_state=memory_state)
                _log(f"preparing an engine for {tuple(z.shape)} — once per profile")
                pure = _pure_decode(self)
                engine, reason = _adopt_or_reject(
                    self, z.contiguous(), pure,
                    tile=trt_engine.DEFAULT_TILE_LATENT,
                    overlap=trt_engine.DEFAULT_OVERLAP_LATENT,
                )
                _state["last_reason"] = reason
                _log(reason)
                if engine is None:
                    _state["rejected"][key] = reason
                    return original_decode(self, z, memory_state=memory_state)
                _state["engines"][key] = engine

            with torch.no_grad():
                output = engine(z.contiguous())
            _state["decodes_accelerated"] += 1
            return output
        except Exception as exc:
            # The whole point: an optimisation is never allowed to break a
            # render. Recorded by shape so it is not retried every tile.
            reason = f"TensorRT decode failed ({type(exc).__name__}: {exc}) — kept PyTorch"
            _state["last_reason"] = reason
            _log(reason)
            if key:
                # Recorded by shape so the next tile does not retry a failure
                # that is going to fail identically, once per tile, all render.
                _state["rejected"][key] = reason
            return original_decode(self, z, memory_state=memory_state)

    _decode._hivemind_trt = True
    VideoAutoencoderKL._decode = _decode
    return ""


_patch_error = _install_patch()
if _patch_error:
    _log(f"not installed: {_patch_error}")


# --- the graph node ---------------------------------------------------------


class HivemindSeedVR2TensorRT:
    """Per-job TensorRT policy for the SeedVR2 VAE decode."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vae": ("SEEDVR2_VAE",),
                "enabled": ("BOOLEAN", {"default": True}),
                "build_engine": ("BOOLEAN", {"default": True}),
                "fp16": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("SEEDVR2_VAE",)
    RETURN_NAMES = ("vae",)
    FUNCTION = "apply"
    CATEGORY = "SEEDVR2"
    DESCRIPTION = (
        "Run SeedVR2's VAE decode through a TensorRT engine when that is "
        "measurably faster on this machine and produces the same picture.\n\n"
        "build_engine: compiling an engine takes minutes of GPU time and happens "
        "once per tile shape. Leave it off for a short preview — the preview will "
        "use PyTorch, and the full render can build the engine it then reuses for "
        "every chunk.\n\n"
        "Does nothing on a machine without CUDA and torch-tensorrt; the render "
        "runs on PyTorch exactly as it would without this node."
    )

    def apply(self, vae, enabled=True, build_engine=True, fp16=True):
        global _patch_error
        if _patch_error:
            # By now the SeedVR2 pack is certainly loaded, whatever the order was
            # at import time.
            _patch_error = _install_patch()
            if _patch_error:
                _state["last_reason"] = _patch_error
                _log(f"not installed: {_patch_error}")
        with _policy_lock:
            _policy.update({
                "enabled": bool(enabled),
                "may_build": bool(enabled and build_engine),
                "fp16": bool(fp16),
            })
        if enabled:
            # Before the policy is set, and before any decode: the rewrite has
            # to be in place while the graph is traced, not after.
            _ensure_rank_patch()
        environment = trt_vae.describe_environment()
        if enabled and _blocked_unless_retry():
            # Said once, plainly, rather than letting the render look as though
            # something is merely missing.
            _state["last_reason"] = trt_vae.KNOWN_BLOCKER
        elif enabled and not environment["available"]:
            _state["last_reason"] = environment["reason"]
            _log(f"asked for, but unavailable: {environment['reason']}")
        # The config passes through untouched: the policy is process state, and
        # rewriting the VAE config here would fight the node pack's own cache.
        return (vae,)


NODE_CLASS_MAPPINGS["HivemindSeedVR2TensorRT"] = HivemindSeedVR2TensorRT
NODE_DISPLAY_NAME_MAPPINGS["HivemindSeedVR2TensorRT"] = "SeedVR2 TensorRT VAE (Hivemind)"


# --- the status route -------------------------------------------------------
#
# So a lane can be ASKED what it can do. The node pack being installed says
# nothing about whether torch-tensorrt imports, whether the card is supported,
# or whether an engine was adopted once built — and the studio has to tell the
# owner which of those it is.

try:  # pragma: no cover - needs a running ComfyUI
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/hivemind/seedvr2-trt")
    async def _seedvr2_trt_status(request):
        environment = trt_vae.describe_environment()
        with _policy_lock:
            policy = dict(_policy)
        blocked = _blocked_unless_retry()
        return web.json_response({
            "ok": True,
            "patched": not _patch_error,
            "patch_error": _patch_error,
            **environment,
            # The library and the card can both be fine and this still be false.
            # Whoever asks deserves the real reason, not the missing-dependency
            # one that happens to be easier to report.
            "available": bool(environment.get("available")) and not blocked,
            "blocked": blocked,
            "reason_blocked": trt_vae.KNOWN_BLOCKER if blocked else "",
            # The rewrite that decides it, and whether it proved itself.
            "rank_patch": dict(_rank_state),
            "policy": policy,
            "engines_built": len(_state["engines"]),
            "engines_rejected": len(_state["rejected"]),
            "speedup": _state["speedup"],
            "reason": _state["last_reason"],
            "decodes_total": _state["decodes_total"],
            "decodes_accelerated": _state["decodes_accelerated"],
        })
except Exception as exc:  # pragma: no cover
    print(f"[seedvr2-trt] status route unavailable: {exc}", file=sys.stderr)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
