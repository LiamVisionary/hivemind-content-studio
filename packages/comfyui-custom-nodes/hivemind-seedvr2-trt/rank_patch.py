"""Keep SeedVR2's decoder under TensorRT's tensor-rank limit.

THE PROBLEM, measured 2026-08-31 on a rented RTX 5090. TensorRT refuses to
compile the VAE decoder:

    IShuffleLayer, (1, 1, 1, 1, 1, 1, 16, 1, 136, 240)
    while executing aten.expand -> [1, 1, 2, 1, 1, 1, 16, 1, 136, 240]

Ten dimensions against a rank limit of eight. Read the two halves of that shape
and it names itself: `[1,1,2,1,1]` is a repeat spec and `[1,16,1,136,240]` is the
tensor — this is `aten.repeat`'s standard decomposition, which unsqueezes a rank-N
tensor to 2N dims, expands, and reshapes back. For a 5-D video latent that is
always 10 dims, and always too many.

WHERE IT COMES FROM. One line, in the causal padding that replicates the first
frame (`causal_inflation_lib.extend_head`, and the identical non-causal
`inflated_lib.extend_head`):

    tile_repeat = [1] * tensor.ndim
    tile_repeat[2] = times
    torch.cat((torch.tile(tensor[:, :, :1], tile_repeat), tensor), dim=2)

Every entry of `tile_repeat` is 1 except the temporal one. A tile whose repeats
are all-ones-but-one is exactly an `expand` of a singleton dimension — which is
a view, stays rank-5, and is if anything cheaper.

WHY THIS IS A PATCH AND NOT A FORK. It replaces two functions, at runtime, in an
upstream pack that stays pinned and unvendored. The alternative — forking the
model's convolution implementation — is the same three lines plus a permanent
merge burden.

WHY IT IS SAFE TO CHANGE MODEL MATH AT ALL. Because it is not changed: the
replacement is checked to be BIT-IDENTICAL to the original, on this machine, on
real shapes, before it is installed. Not "close enough" — `torch.equal`. If any
case differs by one bit, nothing is patched, TensorRT stays off, and the reason
is reported. A restoration is not worth a silent pixel change.
"""

from __future__ import annotations


# Shapes the decoder actually sees, plus the awkward ones: a single latent
# frame, several, a batch, and the widest channel count in the network. The
# equivalence check runs over all of them at install time.
EQUIVALENCE_SHAPES = (
    (1, 16, 1, 17, 30),
    (1, 16, 2, 34, 60),
    (2, 128, 5, 9, 16),
    (1, 512, 3, 5, 8),
)
EQUIVALENCE_TIMES = (1, 2, 3)


def _vae_module(vae):
    """The module the VAE class was defined in.

    Everything the pack imports — MemoryState, InflatedCausalConv3d — is a name
    in there, which is a more reliable way to reach them from an INSTANCE than
    rebuilding the package path by hand.
    """
    import sys

    module = sys.modules.get(type(vae).__module__)
    if module is None:
        raise RuntimeError("the VAE's defining module is not importable")
    return module


def memory_state_disabled(vae):
    """`MemoryState.DISABLED`, the state in which a decode is a pure function."""
    return _vae_module(vae).MemoryState.DISABLED


def inflated_causal_conv_class(vae):
    """The pack's causal 3D convolution class, for finding them on a model."""
    return _vae_module(vae).InflatedCausalConv3d


def rank_safe_extend_head(tensor, times: int = 2, memory=None):
    """`extend_head`, without the rank-doubling tile.

    Signature and semantics are upstream's exactly: with `memory`, concatenate
    it; with `times == 0`, pass through; otherwise repeat the first frame
    `times` times along the temporal axis and prepend it.
    """
    import torch

    if memory is not None:
        return torch.cat((memory.to(tensor), tensor), dim=2)
    assert times >= 0, "Invalid input for function 'extend_head'!"
    if times == 0:
        return tensor
    # expand, not tile: every repeat except the temporal one is 1, so this is
    # the same values — as a view, at rank 5 instead of 10.
    sizes = [-1] * tensor.ndim
    sizes[2] = times
    return torch.cat((tensor[:, :, :1].expand(*sizes), tensor), dim=2)


def rank_safe_cache_send_recv(tensor, cache_size, times, memory=None):
    """`cache_send_recv`, without the rank-doubling tile.

    Upstream calls this "single GPU inference — simplified cache handling", and
    the name `context_parallel_lib` makes it look like a multi-GPU path that a
    single card never reaches. It is not: MEASURED 2026-08-31, this is where the
    rank-10 expand came from, called once per causal convolution. Its
    `tile_repeat` is all ones but the temporal one, exactly like `extend_head`.
    """
    if memory is not None:
        return memory.to(tensor[0])
    if times > 0:
        sizes = [-1] * tensor[0].ndim
        sizes[2] = times
        return tensor[0][:, :, :1].expand(*sizes)
    return None


def proves_identical(original, replacement) -> tuple[bool, str]:
    """Bit-for-bit, on real shapes, before anything is patched.

    `torch.equal`, deliberately, not `allclose`. The replacement is supposed to
    be the same arithmetic in a different order of view operations; if it is
    only ALMOST the same, the premise is wrong and the patch has no business
    being installed on somebody's render.
    """
    import torch

    generator = torch.Generator().manual_seed(0)
    for shape in EQUIVALENCE_SHAPES:
        for times in EQUIVALENCE_TIMES:
            sample = torch.randn(*shape, generator=generator)
            try:
                expected = original(sample, times)
                actual = replacement(sample, times)
            except Exception as exc:  # noqa: BLE001 - any failure means: do not patch
                return False, f"the replacement raised on {shape} x{times}: {type(exc).__name__}: {exc}"
            if expected.shape != actual.shape:
                return False, f"shape differs on {shape} x{times}: {tuple(expected.shape)} vs {tuple(actual.shape)}"
            if not torch.equal(expected, actual):
                return False, f"values differ on {shape} x{times}"
    # …and the memory branch, which is the one a long clip actually takes.
    memory = torch.randn(1, 16, 2, 17, 30, generator=generator)
    sample = torch.randn(1, 16, 4, 17, 30, generator=generator)
    if not torch.equal(original(sample, 2, memory), replacement(sample, 2, memory)):
        return False, "values differ when carrying causal-conv memory"
    return True, ""


def proves_identical_cache(original, replacement) -> tuple[bool, str]:
    """The same bit-for-bit proof, for the cache helper.

    Its signature differs (a LIST of tensors, a cache size, and `times` that may
    legitimately be 0 or negative), so it gets its own comparison rather than
    being squeezed into the other one.
    """
    import torch

    generator = torch.Generator().manual_seed(1)
    for shape in EQUIVALENCE_SHAPES:
        for times in (0, 1, 2, 3):
            sample = [torch.randn(*shape, generator=generator)]
            try:
                expected = original(sample, 4, times)
                actual = replacement(sample, 4, times)
            except Exception as exc:  # noqa: BLE001
                return False, f"the replacement raised on {shape} x{times}: {type(exc).__name__}: {exc}"
            if expected is None or actual is None:
                if expected is not actual:
                    return False, f"one returned None and the other did not on {shape} x{times}"
                continue
            if expected.shape != actual.shape or not torch.equal(expected, actual):
                return False, f"values differ on {shape} x{times}"
    memory = torch.randn(1, 16, 2, 9, 16, generator=generator)
    sample = [torch.randn(1, 16, 4, 9, 16, generator=generator)]
    if not torch.equal(original(sample, 4, 2, memory), replacement(sample, 4, 2, memory)):
        return False, "values differ when carrying causal-conv memory"
    return True, ""


# Every module that holds a reference to `extend_head`, not just the two that
# define it. `inflated_layers` does `from .inflated_lib import extend_head`, so
# it owns its OWN binding and rebinding the source module would leave its calls
# on the old function — the patch would look installed and do nothing on half
# the network. Verified by reading the imports, not assumed.
TARGETS = (
    # Defines it, and calls it through module globals (InflatedCausalConv3d).
    ("models.video_vae_v3.modules.causal_inflation_lib", "extend_head"),
    # The non-causal twin: same three lines, kept in step.
    ("models.video_vae_v3.modules.inflated_lib", "extend_head"),
    # Imported binding — its calls resolve here, not in inflated_lib.
    ("models.video_vae_v3.modules.inflated_layers", "extend_head"),
)

# The one that actually mattered. `context_parallel_lib` reads as a multi-GPU
# file and its own comment says "single GPU inference — simplified cache
# handling", so it is easy to skip: it was skipped, and it cost a rented box to
# find. It runs once per causal convolution on ONE card, and its tile is what
# TensorRT refused.
CACHE_TARGETS = (
    ("models.video_vae_v3.modules.context_parallel_lib", "cache_send_recv"),
    # causal_inflation_lib does `from .context_parallel_lib import
    # cache_send_recv`, so it owns its own binding and this is the one its
    # convolutions actually call.
    ("models.video_vae_v3.modules.causal_inflation_lib", "cache_send_recv"),
)


def install(root_package: str) -> dict:
    """Patch every target, or none of them. Returns what happened, in words.

    `root_package` is the SeedVR2 pack's top-level module name, resolved from
    ComfyUI's node registry rather than assumed — the directory it lives in is
    not a fixed thing.
    """
    state = {"patched": [], "skipped": [], "verified": False, "reason": ""}
    families = (
        (TARGETS, rank_safe_extend_head, proves_identical),
        (CACHE_TARGETS, rank_safe_cache_send_recv, proves_identical_cache),
    )
    for targets, replacement, prover in families:
        _install_family(root_package, targets, replacement, prover, state)
    if state["patched"] and not state["reason"]:
        state["verified"] = True
        state["reason"] = (
            f"causal padding rewritten to stay at rank 5 ({len(state['patched'])} call sites), "
            "verified bit-identical"
        )
    elif not state["patched"] and not state["reason"]:
        # Never silent: an unpatched decoder is a decoder TensorRT will refuse,
        # and "no reason given" is indistinguishable from "it worked".
        state["reason"] = (
            "nothing to patch: the SeedVR2 causal-padding helpers were not found here"
            + (f" ({'; '.join(state['skipped'])})" if state["skipped"] else "")
        )
    return state


def _install_family(root_package, targets, replacement, prover, state) -> None:
    """Patch one family of call sites, all or nothing, after proving it."""
    import importlib

    modules = []
    for suffix, name in targets:
        try:
            module = importlib.import_module(f"{root_package}.src.{suffix}")
        except Exception as exc:  # noqa: BLE001
            state["skipped"].append(f"{suffix}: not importable ({type(exc).__name__})")
            continue
        original = getattr(module, name, None)
        if original is None:
            state["skipped"].append(f"{suffix}.{name}: not present")
            continue
        if getattr(original, "_hivemind_rank_safe", False):
            state["patched"].append(f"{suffix}.{name} (already)")
            continue
        modules.append((suffix, name, module, original))

    if not modules:
        return

    # ONE verification against the first real original, then all or nothing.
    ok, why = prover(modules[0][3], replacement)
    if not ok:
        state["reason"] = (
            f"the rank-safe rewrite is not bit-identical to upstream's ({why}) — "
            "nothing patched, TensorRT stays off"
        )
        state["verified"] = False
        return

    replacement._hivemind_rank_safe = True
    for suffix, name, module, _original in modules:
        setattr(module, name, replacement)
        state["patched"].append(f"{suffix}.{name}")
