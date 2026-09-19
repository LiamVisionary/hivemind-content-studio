"""The rank-safe causal padding.

This is model math being replaced at runtime, which is only acceptable because
it is not actually changed — so the tests that matter are the equivalence ones,
and they run against the SAME comparison the patch performs before installing
itself. If these fail, nothing gets patched on a real machine either.

Needs torch. Skipped where there is none, because the patch is inert there too.

Run them from the pack directory, in importlib mode:

    cd packages/comfyui-custom-nodes/hivemind-seedvr2-trt
    python -m pytest -q --import-mode=importlib

Both parts matter. These are NOT in the repo's gate — `testpaths = ["test"]` in
pyproject.toml does not reach here — and without `--import-mode=importlib`
pytest resolves the test module through this pack's `__init__.py`, which is a
ComfyUI entry point doing relative imports and cannot be imported standalone.
Every test then errors at setup, which reads as a broken environment rather than
a suite that is not running. It was not running: two tests here were failing
unnoticed until 2026-09-01.
"""

import unittest

try:
    import torch
except Exception:  # pragma: no cover
    torch = None

import rank_patch


def upstream_extend_head(tensor, times=2, memory=None):
    """Verbatim from seedvr2_videoupscaler causal_inflation_lib.extend_head, at
    the pinned commit — the thing the replacement has to equal."""
    if memory is not None:
        return torch.cat((memory.to(tensor), tensor), dim=2)
    assert times >= 0, "Invalid input for function 'extend_head'!"
    if times == 0:
        return tensor
    tile_repeat = [1] * tensor.ndim
    tile_repeat[2] = times
    return torch.cat(tensors=(torch.tile(tensor[:, :, :1], tile_repeat), tensor), dim=2)


@unittest.skipIf(torch is None, "torch is not available here")
class ItIsTheSameArithmetic(unittest.TestCase):
    def test_bit_identical_on_every_shape_the_decoder_sees(self):
        ok, why = rank_patch.proves_identical(upstream_extend_head, rank_patch.rank_safe_extend_head)
        self.assertTrue(ok, why)

    def test_the_check_is_equality_not_closeness(self):
        # A replacement that is merely CLOSE has a different premise and must be
        # refused: the point is that nothing about the picture changes.
        def almost(tensor, times=2, memory=None):
            result = rank_patch.rank_safe_extend_head(tensor, times, memory)
            return result + 1e-7
        ok, why = rank_patch.proves_identical(upstream_extend_head, almost)
        self.assertFalse(ok)
        self.assertIn("differ", why)

    def test_a_replacement_that_raises_is_refused_rather_than_installed(self):
        def broken(tensor, times=2, memory=None):
            raise RuntimeError("nope")
        ok, why = rank_patch.proves_identical(upstream_extend_head, broken)
        self.assertFalse(ok)
        self.assertIn("raised", why)

    def test_the_memory_branch_is_covered(self):
        # The branch a long clip actually takes, and the one where a wrong
        # replacement would corrupt only the chunks after the first.
        memory = torch.randn(1, 16, 2, 9, 16)
        sample = torch.randn(1, 16, 4, 9, 16)
        self.assertTrue(torch.equal(
            upstream_extend_head(sample, 2, memory),
            rank_patch.rank_safe_extend_head(sample, 2, memory),
        ))

    def test_times_zero_passes_the_tensor_straight_through(self):
        sample = torch.randn(1, 16, 3, 9, 16)
        self.assertIs(rank_patch.rank_safe_extend_head(sample, 0), sample)


@unittest.skipIf(torch is None, "torch is not available here")
class ItStaysUnderTheRankLimit(unittest.TestCase):
    def test_the_replacement_emits_expand_where_upstream_emits_tile(self):
        """`aten.tile` is the op whose decomposition unsqueezes a rank-N tensor
        to 2N dims — 10 for a video latent, against TensorRT's limit of 8.
        `aten.expand` on a rank-5 tensor has nowhere to inflate to."""
        import torch.nn as nn

        class Wrap(nn.Module):
            def __init__(self, fn):
                super().__init__()
                self.fn = fn

            def forward(self, tensor):
                return self.fn(tensor, 2)

        sample = torch.randn(1, 16, 1, 17, 30)
        ops = {}
        for name, fn in (("upstream", upstream_extend_head),
                         ("ours", rank_patch.rank_safe_extend_head)):
            exported = torch.export.export(Wrap(fn), (sample,), strict=False)
            ops[name] = " ".join(
                str(node.target) for node in exported.graph.nodes if node.op == "call_function"
            )
        self.assertIn("tile", ops["upstream"])
        self.assertNotIn("tile", ops["ours"])
        self.assertIn("expand", ops["ours"])
        self.assertNotIn("repeat", ops["ours"])

    def test_no_intermediate_exceeds_rank_eight(self):
        import torch.nn as nn

        class Wrap(nn.Module):
            def forward(self, tensor):
                return rank_patch.rank_safe_extend_head(tensor, 2)

        exported = torch.export.export(Wrap(), (torch.randn(1, 16, 1, 17, 30),), strict=False)
        worst = 0
        for node in exported.graph.nodes:
            value = node.meta.get("val", None)
            if hasattr(value, "shape"):
                worst = max(worst, len(value.shape))
        self.assertLessEqual(worst, 8, "TensorRT's tensor rank limit")


class ItPatchesEverySite(unittest.TestCase):
    def test_it_targets_the_imported_binding_too_not_just_the_definitions(self):
        """`inflated_layers` does `from .inflated_lib import extend_head`, so it
        owns its own binding. Rebinding only the defining modules would leave
        half the network calling the old function — a patch that looks installed
        and does nothing."""
        modules = [module for module, _name in rank_patch.TARGETS]
        self.assertIn("models.video_vae_v3.modules.causal_inflation_lib", modules)
        self.assertIn("models.video_vae_v3.modules.inflated_lib", modules)
        self.assertIn("models.video_vae_v3.modules.inflated_layers", modules)

    def test_a_pack_without_the_helpers_is_reported_rather_than_half_patched(self):
        state = rank_patch.install("a_package_that_is_not_installed")
        self.assertFalse(state["verified"])
        self.assertEqual(state["patched"], [])
        self.assertTrue(state["reason"].strip())


if __name__ == "__main__":
    unittest.main()


def upstream_cache_send_recv(tensor, cache_size, times, memory=None):
    """Verbatim from context_parallel_lib.cache_send_recv at the pinned commit."""
    recv_buffer = None
    if memory is not None:
        recv_buffer = memory.to(tensor[0])
    elif times > 0:
        tile_repeat = [1] * tensor[0].ndim
        tile_repeat[2] = times
        recv_buffer = torch.tile(tensor[0][:, :, :1], tile_repeat)
    return recv_buffer


@unittest.skipIf(torch is None, "torch is not available here")
class TheOneThatActuallyMattered(unittest.TestCase):
    """`context_parallel_lib.cache_send_recv` — the source of the rank-10 expand.

    Its file reads as a multi-GPU path and its own comment says "single GPU
    inference"; it was skipped on that basis and finding it cost a rented box.
    It runs once per causal convolution on ONE card."""

    def test_bit_identical_including_the_none_and_memory_branches(self):
        ok, why = rank_patch.proves_identical_cache(
            upstream_cache_send_recv, rank_patch.rank_safe_cache_send_recv)
        self.assertTrue(ok, why)

    def test_times_zero_returns_nothing_exactly_as_upstream_does(self):
        sample = [torch.randn(1, 16, 3, 9, 16)]
        self.assertIsNone(rank_patch.rank_safe_cache_send_recv(sample, 4, 0))

    def test_it_emits_expand_where_upstream_emits_tile(self):
        import torch.nn as nn

        class Wrap(nn.Module):
            def __init__(self, fn):
                super().__init__()
                self.fn = fn

            def forward(self, tensor):
                return self.fn([tensor], 4, 2)

        sample = torch.randn(1, 16, 1, 17, 30)
        for name, fn, expect in (
            ("upstream", upstream_cache_send_recv, "tile"),
            ("ours", rank_patch.rank_safe_cache_send_recv, "expand"),
        ):
            exported = torch.export.export(Wrap(fn), (sample,), strict=False)
            ops = " ".join(str(n.target) for n in exported.graph.nodes if n.op == "call_function")
            self.assertIn(expect, ops, name)
        exported = torch.export.export(Wrap(rank_patch.rank_safe_cache_send_recv), (sample,), strict=False)
        ops = " ".join(str(n.target) for n in exported.graph.nodes if n.op == "call_function")
        self.assertNotIn("tile", ops)

    def test_both_call_sites_are_targeted(self):
        modules = [module for module, _name in rank_patch.CACHE_TARGETS]
        self.assertIn("models.video_vae_v3.modules.context_parallel_lib", modules)
        # …and the imported binding the convolutions actually call.
        self.assertIn("models.video_vae_v3.modules.causal_inflation_lib", modules)

