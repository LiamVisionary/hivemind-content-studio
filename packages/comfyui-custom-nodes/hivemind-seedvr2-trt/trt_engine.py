"""ONNX -> TensorRT-RTX engine for SeedVR2's VAE decoder, and the tiled runtime.

WHY THIS AND NOT torch-tensorrt. Measured across two rented RTX 5090s
(2026-08-31): compiling this decoder through `torch.export` or
`torch.compile(backend="tensorrt")` does not work and cannot be made to work.
Export hits a data-dependent guard that a static shape does not remove; the
dynamo path then hits TensorRT's rank-8 limit; and with that fixed it aborts the
process with a CUDA illegal memory access. Three blockers, one of them
uncatchable.

The path that DOES work — the one vrgamegirl19/VRGDG-SeedVR2-TensorRT-Studio
takes (Apache-2.0; independently reimplemented here, see THIRD_PARTY_NOTICES) —
avoids every one of them by not going through PyTorch's compiler at all:

    reconfigure the VAE  ->  torch.onnx.export (LEGACY tracer, fixed shape)
                         ->  TensorRT-RTX parses the ONNX
                         ->  a fixed-shape engine, run over spatial tiles

Each step removes a specific blocker, and it is worth being precise about which:

* THE LEGACY TRACER runs the model with a concrete input and records what
  happened. A branch on a computed value is simply taken — it becomes a
  constant in the graph. There is nothing left to "guard on", which is why the
  data-dependent failure disappears rather than being worked around.
* A FIXED SHAPE means `torch.tile` records as an ONNX `Tile` with constant
  repeats at rank 5. No repeat-decomposition, no rank-10 intermediate.
* TENSORRT PARSES THE ONNX ITSELF. torch-tensorrt's converters — the layer that
  produced the illegal memory access — are not in the picture.

THE THREE RECONFIGURATIONS, before anything is traced. Each one exists to keep
Python control flow out of the recorded graph:

    disable_slicing()          temporal slicing is a Python loop over chunks
    set_memory_limit(inf)      the memory-safe path CHUNKS GroupNorm, which
                               traces to ONNX *sequence* operators that
                               TensorRT cannot import at all
    module.slicing = False     UpDecoderBlock3D's split/list control flow

They are applied for the export ONLY and restored afterwards. They are not free:
removing the memory limits is exactly the safety net that stops a high-resolution
PyTorch decode from running out of memory, and leaving them off would make the
FALLBACK worse than it was before anyone asked for acceleration.

WHY TILED. The engine is fixed-shape, so one engine could only ever serve one
resolution — unless the thing it decodes is a TILE. It is: the latent is cut
into overlapping square tiles, each decoded by the same engine, and the results
feathered back together. One engine then serves every output size, and the only
per-project variable left is the temporal batch.
"""

from __future__ import annotations

import hashlib
from contextlib import contextmanager
from pathlib import Path

# Latent tile the engine is built for, in LATENT pixels (x8 in output pixels).
#
# 32 -> a 256px tile, which is where the reference implementation starts too,
# and MEASURED 2026-08-31 that is not a stylistic choice: a 64-latent tile built
# a perfectly good engine and then failed at enqueue with
#   Error Code 1: Myelin (CUDA error 2 launching ... kernel)
# — cudaErrorMemoryAllocation. The decode runs while the 7.9GB DiT is still
# resident, and a 512x512x5 tile's activations do not fit in what is left of a
# 32GB card. Smaller tiles mean more launches; they also mean the engine can
# actually run.
DEFAULT_TILE_LATENT = int(__import__("os").environ.get("HIVEMIND_SEEDVR2_TRT_TILE", "64"))
# Overlap between tiles, feathered. Four latent pixels is 32 output pixels of
# cross-fade — kept proportional to the tile so the seam treatment does not
# change when the tile does.
DEFAULT_OVERLAP_LATENT = max(2, DEFAULT_TILE_LATENT // 8)

# SeedVR2's temporal expansion: n latent frames decode to 4n-3 output frames.
# (2 -> 5, 6 -> 21 — the two temporal batches the reference implementation
# supports, which is where those numbers come from.)
def output_frames_for(latent_frames: int) -> int:
    return latent_frames * 4 - 3


def latent_frames_for(batch_size: int) -> int:
    """The latent depth for a 4n+1 temporal batch."""
    return (int(batch_size) - 1) // 4 + 1


def tile_positions(length: int, tile: int, overlap: int) -> list[int]:
    """Where each tile starts, with the last one flush against the edge.

    Flush rather than padded-and-cropped: a partial final tile would be a
    different shape, and a fixed-shape engine has exactly one.
    """
    if length <= tile:
        return [0]
    stride = tile - overlap
    values = list(range(0, length - tile + 1, stride))
    if values[-1] != length - tile:
        values.append(length - tile)
    return values


def feather_weights(length: int, overlap: int, left: bool, right: bool, device, dtype):
    """A 1-D cross-fade ramp for one tile edge, or flat where there is no join.

    Only INTERIOR edges are ramped. Feathering the outer edge of the first and
    last tile would fade the picture into nothing at the frame border.
    """
    import torch

    weight = torch.ones(length, device=device, dtype=dtype)
    if left and overlap:
        weight[:overlap] = torch.linspace(0.0, 1.0, overlap + 1, device=device, dtype=dtype)[1:]
    if right and overlap:
        weight[-overlap:] = torch.minimum(
            weight[-overlap:],
            torch.linspace(1.0, 0.0, overlap + 1, device=device, dtype=dtype)[1:],
        )
    return weight


@contextmanager
def fixed_profile(vae):
    """Put the VAE in a traceable state, then put it back exactly as it was.

    Restoring matters more than configuring: `set_memory_limit` is the guard
    that keeps a high-resolution PyTorch decode from running out of memory, and
    leaving it off after an export would make the fallback path worse than it
    was before anyone asked for TensorRT.
    """
    saved_slicing = getattr(vae, "use_slicing", None)
    saved_block_slicing = []
    saved_conv_limits = []

    try:
        from .rank_patch import inflated_causal_conv_class
        conv_class = inflated_causal_conv_class(vae)
    except Exception:
        conv_class = None

    if hasattr(vae, "disable_slicing"):
        vae.disable_slicing()
    if hasattr(vae, "set_memory_limit"):
        # No saved value to restore: the limits live on the modules below, and
        # this call is what pushes them down.
        vae.set_memory_limit(None, None)
    for module in vae.modules():
        if conv_class is not None and isinstance(module, conv_class):
            saved_conv_limits.append((module, getattr(module, "memory_limit", None),
                                      getattr(module, "memory_device", None)))
            module.set_memory_limit(float("inf"))
            module.set_memory_device(None)
        if hasattr(module, "slicing"):
            saved_block_slicing.append((module, module.slicing))
            module.slicing = False
    try:
        yield
    finally:
        for module, limit, device in saved_conv_limits:
            try:
                module.set_memory_limit(float("inf") if limit is None else limit)
                module.set_memory_device(device)
            except Exception:
                pass
        for module, value in saved_block_slicing:
            module.slicing = value
        if saved_slicing and hasattr(vae, "enable_slicing"):
            vae.enable_slicing()


def export_decoder_onnx(vae, destination: Path, *, latent_frames: int, tile: int, dtype) -> Path:
    """Trace the decoder at one fixed shape and write the ONNX graph.

    `dynamo=False` is the whole point — the legacy tracer runs the model and
    records what it did, so a branch on a computed value becomes a constant
    instead of an unbacked symbol. `do_constant_folding=False` and
    `optimize=False` keep the graph as traced, because TensorRT's parser is what
    should be deciding how to fold it.
    """
    import torch
    from torch import nn

    class _Decoder(nn.Module):
        """Just the decoder stack. The streaming/memory branches are configured
        out by `fixed_profile`, not traced through."""

        def __init__(self, decoder, memory_state):
            super().__init__()
            self.decoder = decoder
            self._memory_state = memory_state

        def forward(self, latent):
            return self.decoder(latent, memory_state=self._memory_state)

    from .rank_patch import memory_state_disabled
    module = _Decoder(vae.decoder, memory_state_disabled(vae)).eval()
    device = next(vae.decoder.parameters()).device
    sample = torch.zeros(
        (1, 16, int(latent_frames), int(tile), int(tile)), device=device, dtype=dtype,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)

    # cuDNN off and MATH attention: both emit portable operators. A flash or
    # mem-efficient SDPA kernel does not trace to anything ONNX can carry.
    contexts = [torch.inference_mode(), torch.backends.cudnn.flags(enabled=False)]
    try:
        from torch.nn.attention import SDPBackend, sdpa_kernel
        contexts.append(sdpa_kernel(SDPBackend.MATH))
    except (ImportError, AttributeError):
        pass

    import contextlib

    with contextlib.ExitStack() as stack:
        for context in contexts:
            stack.enter_context(context)
        torch.onnx.export(
            module,
            (sample,),
            str(destination),
            input_names=["latent"],
            output_names=["sample"],
            opset_version=20,
            dynamo=False,
            do_constant_folding=False,
        )
    return destination


def _trt_module():
    """TensorRT-RTX if present, otherwise stock TensorRT.

    RTX first because that is what the reference implementation builds against
    and what a consumer RTX card ships; the stock package exposes the same
    builder/runtime API, so the code below does not care which it got.
    """
    try:
        import tensorrt_rtx as trt
        return trt, "tensorrt_rtx"
    except Exception:
        import tensorrt as trt
        return trt, "tensorrt"


def build_engine(onnx_path: Path, destination: Path, *, workspace_gb: float = 8.0) -> Path:
    """Parse the ONNX and serialize an engine for THIS machine's GPU.

    The result is architecture- and library-specific and is never shared between
    machines — which is why it is written beside the weights on the box that
    built it and never uploaded anywhere.
    """
    trt, _flavour = _trt_module()
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network()
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(onnx_path)):
        errors = "; ".join(str(parser.get_error(i)) for i in range(parser.num_errors))
        raise RuntimeError(f"TensorRT could not parse the decoder graph: {errors[:600]}")
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, int(workspace_gb * (1 << 30)))
    blob = builder.build_serialized_network(network, config)
    if blob is None:
        raise RuntimeError("TensorRT parsed the decoder but could not build an engine from it")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(blob)
    return destination


class TiledDecoder:
    """A built engine, plus the tiling that lets one fixed shape decode any size."""

    def __init__(self, engine_path: Path, *, tile: int, overlap: int, latent_frames: int, dtype=None):
        import torch

        trt, self.flavour = _trt_module()
        self.trt = trt
        self.logger = trt.Logger(trt.Logger.WARNING)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(Path(engine_path).read_bytes())
        if self.engine is None:
            raise RuntimeError(f"could not deserialize the engine at {engine_path}")
        names = [self.engine.get_tensor_name(i) for i in range(self.engine.num_io_tensors)]
        self.input_name = next(
            name for name in names if self.engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT)
        self.output_name = next(
            name for name in names if self.engine.get_tensor_mode(name) == trt.TensorIOMode.OUTPUT)
        expected = tuple(self.engine.get_tensor_shape(self.input_name))
        wanted = (1, 16, int(latent_frames), int(tile), int(tile))
        if expected != wanted:
            # A cached engine from a different profile is not a cache hit.
            raise RuntimeError(f"engine input {expected} does not match the tile {wanted}")
        self.context = self.engine.create_execution_context()
        if self.context is None:
            raise RuntimeError("could not create a TensorRT execution context")
        self.tile = int(tile)
        self.overlap = int(overlap)
        self.latent_frames = int(latent_frames)
        # The engine was built from a graph traced in the MODEL's dtype, so its
        # bindings expect that dtype — feeding it anything else is the
        # "Input type (c10::Half) and bias type (c10::BFloat16)" failure, one
        # layer further along.
        self.dtype = dtype if dtype is not None else torch.float16
        self.stream = torch.cuda.Stream()
        # What the engine needs for its own activations, so a failure to launch
        # can be reported as the memory problem it is rather than as "execution
        # failed".
        self.device_memory = int(getattr(self.engine, "device_memory_size", 0) or 0)

    def decode(self, latent):
        """Decode a full latent by tiling it, through the engine."""
        return self._decode_tiled(latent, self._run_engine)

    def decode_reference(self, per_tile):
        """The SAME tiling, with PyTorch decoding each tile.

        This is what the engine is checked against, and the choice matters. A
        tiled decode is not the same function as an untiled one — each tile's
        convolutions see padding where the neighbouring content used to be — so
        comparing tiled-TensorRT against untiled-PyTorch measures the tiling,
        not the engine, and reports tens of percent no matter how perfect the
        engine is. (MEASURED: 38.96%.) Running both sides through identical
        tiling leaves the engine as the only difference.
        """
        return self._decode_tiled(latent=None, runner=per_tile, source=self._last_source)

    def _run_engine(self, tile_in):
        import torch

        depth = output_frames_for(self.latent_frames)
        out_tile = self.tile * 8
        tile_out = torch.empty((1, 3, depth, out_tile, out_tile),
                               device=tile_in.device, dtype=self.dtype)
        self.context.set_tensor_address(self.input_name, tile_in.data_ptr())
        self.context.set_tensor_address(self.output_name, tile_out.data_ptr())
        # ENQUEUE ONLY — no synchronize here. Measured 2026-08-31: syncing after
        # every tile made the engine 0.87x, i.e. SLOWER than PyTorch, because a
        # 1080p decode is ~45 tiles and each stall is a round trip to the host
        # with the GPU idle. The accumulation below runs on this same stream, so
        # CUDA orders it after the kernel without anyone waiting.
        if not self.context.execute_async_v3(self.stream.cuda_stream):
            free, total = torch.cuda.mem_get_info()
            raise RuntimeError(
                f"TensorRT execution failed — the engine wants "
                f"{self.device_memory / 1e9:.1f}GB of scratch and the card has "
                f"{free / 1e9:.1f}GB of {total / 1e9:.1f}GB free"
            )
        return tile_out

    def _decode_tiled(self, latent, runner, source=None):
        import torch

        if source is None:
            source = latent.to(dtype=self.dtype).contiguous()
            self._last_source = source
        _batch, _channels, frames, height, width = source.shape
        depth = output_frames_for(frames)
        if frames != self.latent_frames:
            raise RuntimeError(
                f"this engine decodes {self.latent_frames} latent frames, not {frames}")
        tile, overlap = self.tile, self.overlap
        out_tile = tile * 8
        out_h, out_w = height * 8, width * 8
        ys = tile_positions(height, tile, overlap)
        xs = tile_positions(width, tile, overlap)
        # Pad rather than shrink the last tile: the engine has one input shape.
        padded_h = max(height, ys[-1] + tile)
        padded_w = max(width, xs[-1] + tile)
        padded = torch.nn.functional.pad(source, (0, padded_w - width, 0, padded_h - height))

        # The decode runs after sampling, with the DiT still resident. Handing
        # PyTorch's cached blocks back first is the difference between the
        # engine having scratch and not.
        torch.cuda.empty_cache()

        accumulator = torch.zeros((1, 3, depth, padded_h * 8, padded_w * 8),
                                  device=source.device, dtype=torch.float32)
        weights = torch.zeros((1, 1, 1, padded_h * 8, padded_w * 8),
                              device=source.device, dtype=torch.float32)
        # Everything on ONE stream: the engine's kernels and the accumulation
        # that reads their output are ordered by CUDA, so there is exactly one
        # synchronize for the whole decode rather than one per tile.
        with torch.cuda.stream(self.stream):
            for y in ys:
                for x in xs:
                    tile_in = padded[:, :, :, y:y + tile, x:x + tile].contiguous()
                    tile_out = runner(tile_in)
                    ramp_y = feather_weights(out_tile, overlap * 8, y != ys[0], y != ys[-1],
                                             source.device, torch.float32)
                    ramp_x = feather_weights(out_tile, overlap * 8, x != xs[0], x != xs[-1],
                                             source.device, torch.float32)
                    window = (ramp_y[:, None] * ramp_x[None, :]).view(1, 1, 1, out_tile, out_tile)
                    oy, ox = y * 8, x * 8
                    accumulator[:, :, :, oy:oy + out_tile, ox:ox + out_tile] += tile_out.float() * window
                    weights[:, :, :, oy:oy + out_tile, ox:ox + out_tile] += window
            blended = accumulator / weights.clamp_min(1e-6)
        self.stream.synchronize()
        return blended[:, :, :, :out_h, :out_w].to(dtype=self.dtype)


def engine_name(*, weights_fingerprint: str, latent_frames: int, tile: int, overlap: int,
                device_name: str, flavour: str, version: str) -> str:
    """A filename that changes whenever the engine behind it would be wrong."""
    key = "|".join([weights_fingerprint, str(latent_frames), str(tile), str(overlap),
                    device_name, flavour, version])
    return f"seedvr2-vae-{hashlib.sha256(key.encode()).hexdigest()[:20]}.rtxplan"
