"""The TensorRT decision rules.

Everything here runs without CUDA and without TensorRT, because these are the
rules that decide whether a render is CORRECT and whether a rented hour is
wasted — and they must not be verifiable only on the one machine that cannot be
attached to a debugger. Two tests cover the tile feathering and do need torch
for its tensors; they skip where there is none, like `test_rank_patch.py`.

What is deliberately NOT tested here: that an engine builds, and that it is
faster. Neither can be asserted on a machine with no NVIDIA GPU, and both are
measured at runtime by the code under test rather than assumed — which is the
whole design (see `verdict`).

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

import trt_vae


class WhichCallsAreCandidates(unittest.TestCase):
    def test_a_decode_carrying_causal_memory_is_never_accelerated(self):
        # THE correctness rule. The causal convolutions hold a memory bank
        # across temporal slices, so such a call is not a function of its input
        # and an engine would silently drop the history — which looks like a
        # model artefact halfway through a long clip, not like a bug.
        allowed, why = trt_vae.should_accelerate(
            memory_state_disabled=False, elements=10**7, enabled=True,
        )
        self.assertFalse(allowed)
        self.assertIn("memory", why)

    def test_a_switched_off_job_is_never_accelerated(self):
        allowed, why = trt_vae.should_accelerate(
            memory_state_disabled=True, elements=10**7, enabled=False,
        )
        self.assertFalse(allowed)
        self.assertIn("switched off", why)

    def test_a_tiny_decode_is_left_alone(self):
        allowed, why = trt_vae.should_accelerate(
            memory_state_disabled=True, elements=64, enabled=True,
        )
        self.assertFalse(allowed)
        self.assertIn("too small", why)

    def test_a_real_tile_with_no_memory_state_is_a_candidate(self):
        allowed, why = trt_vae.should_accelerate(
            memory_state_disabled=True, elements=16 * 5 * 128 * 128, enabled=True,
        )
        self.assertTrue(allowed)
        self.assertEqual(why, "")

    def test_every_refusal_says_why(self):
        # The reason reaches the studio; "TensorRT is off" with no reason is
        # indistinguishable from a bug.
        for kwargs in (
            {"memory_state_disabled": False, "elements": 10**7, "enabled": True},
            {"memory_state_disabled": True, "elements": 10**7, "enabled": False},
            {"memory_state_disabled": True, "elements": 1, "enabled": True},
        ):
            allowed, why = trt_vae.should_accelerate(**kwargs)
            self.assertFalse(allowed)
            self.assertTrue(why.strip(), kwargs)


class WhenAnEngineIsKept(unittest.TestCase):
    def test_a_slower_engine_is_thrown_away(self):
        # An "acceleration" that loses is a bug, not a trade-off.
        keep, why = trt_vae.verdict(torch_seconds=1.0, trt_seconds=1.2, error=0.0)
        self.assertFalse(keep)
        self.assertIn("kept PyTorch", why)

    def test_a_marginally_faster_engine_is_not_worth_the_moving_part(self):
        keep, _ = trt_vae.verdict(torch_seconds=1.0, trt_seconds=0.95, error=0.0)
        self.assertFalse(keep)

    def test_a_genuinely_faster_engine_is_kept_and_says_by_how_much(self):
        keep, why = trt_vae.verdict(torch_seconds=2.0, trt_seconds=1.0, error=0.001)
        self.assertTrue(keep)
        self.assertIn("2.00x", why)

    def test_a_fast_engine_that_changes_the_picture_is_refused(self):
        # Speed never buys a different output. A genuinely different picture is
        # different ON AVERAGE, which is what this catches.
        keep, why = trt_vae.verdict(
            torch_seconds=10.0, trt_seconds=1.0, error=0.5,
            stats={"max": 0.5, "mean": 0.05, "fraction_above_1pct": 0.4})
        self.assertFalse(keep)
        self.assertIn("on average", why)

    def test_a_corrupted_region_is_caught_even_when_the_average_is_fine(self):
        # Four million good pixels can hide a broken patch. The fraction over
        # 1% is the number that sees it.
        keep, why = trt_vae.verdict(
            torch_seconds=2.0, trt_seconds=1.0, error=0.09,
            stats={"max": 0.09, "mean": 0.001, "fraction_above_1pct": 0.05})
        self.assertFalse(keep)
        self.assertIn("of the engine's pixels", why)

    def test_bf16_rounding_noise_is_accepted_because_that_is_what_correct_is(self):
        # The figures MEASURED on an RTX 5090 with TensorRT-RTX 1.6.1 against an
        # identically tiled PyTorch decode. bf16's unit roundoff is ~0.4% and
        # TensorRT reorders arithmetic, so a few outlier pixels are expected.
        keep, why = trt_vae.verdict(
            torch_seconds=2.0, trt_seconds=1.0, error=0.03044,
            stats={"max": 0.03044, "mean": 0.000492, "fraction_above_1pct": 0.000054})
        self.assertTrue(keep, why)

    def test_a_single_catastrophic_pixel_is_still_refused(self):
        # An inf or nan path shows up here and nowhere else.
        keep, why = trt_vae.verdict(
            torch_seconds=2.0, trt_seconds=1.0, error=0.4,
            stats={"max": 0.4, "mean": 0.0001, "fraction_above_1pct": 0.00001})
        self.assertFalse(keep)
        self.assertIn("one of the engine's pixels", why)

    def test_an_untimeable_comparison_keeps_pytorch(self):
        keep, why = trt_vae.verdict(torch_seconds=0.0, trt_seconds=0.0, error=0.0)
        self.assertFalse(keep)
        self.assertIn("kept PyTorch", why)


class EngineIdentity(unittest.TestCase):
    def base(self, **overrides):
        args = {
            "weights_fingerprint": "abc123",
            "shape": (1, 16, 5, 128, 128),
            "dtype": "torch.bfloat16",
            "device_name": "NVIDIA GeForce RTX 5090",
            "torch_tensorrt_version": "2.5.0",
            "fp16": True,
        }
        args.update(overrides)
        return trt_vae.engine_cache_key(**args)

    def test_the_same_job_on_the_same_box_is_one_engine(self):
        self.assertEqual(self.base(), self.base())

    def test_every_field_that_would_make_an_engine_wrong_changes_the_key(self):
        # An engine is built for one architecture and serialized by one library
        # version; reusing one across either is undefined behaviour on a machine
        # somebody is paying for, not a cache hit.
        for field, value in [
            ("weights_fingerprint", "different-checkpoint"),
            ("shape", (1, 16, 9, 128, 128)),
            ("dtype", "torch.float16"),
            ("device_name", "NVIDIA RTX PRO 6000"),
            ("torch_tensorrt_version", "2.6.0"),
            ("fp16", False),
        ]:
            with self.subTest(field):
                self.assertNotEqual(self.base(), self.base(**{field: value}))


class WhyThereIsNoShapeProfile(unittest.TestCase):
    def test_two_temporal_sizes_are_two_engines(self):
        """MEASURED 2026-08-31 on a rented 5090: exporting with a dynamic
        temporal dimension fails outright (GuardOnDataDependentSymNode — the
        causal convolutions branch on whether it is 1). So engines are per exact
        shape, and the cache key is what has to separate them."""
        def key(frames):
            return trt_vae.engine_cache_key(
                weights_fingerprint="w", shape=(1, 16, frames, 136, 240),
                dtype="torch.bfloat16", device_name="NVIDIA GeForce RTX 5090",
                torch_tensorrt_version="2.10.0", fp16=True,
            )
        self.assertNotEqual(key(2), key(1))
        self.assertEqual(key(2), key(2))

    def test_the_module_no_longer_offers_a_profile_to_be_tempted_by(self):
        self.assertFalse(hasattr(trt_vae, "shape_profile"))


class EnvironmentReport(unittest.TestCase):
    class _NoTorch:
        pass

    def test_a_machine_with_no_cuda_says_so_rather_than_just_failing(self):
        class FakeTorch:
            class cuda:
                @staticmethod
                def is_available():
                    return False
        state = trt_vae.describe_environment(torch_module=FakeTorch)
        self.assertFalse(state["available"])
        self.assertIn("NVIDIA", state["reason"])

    def test_a_cuda_box_without_the_library_names_the_missing_library(self):
        # A fixable box must not look like an unsupported one.
        class FakeTorch:
            class cuda:
                @staticmethod
                def is_available():
                    return True

                @staticmethod
                def get_device_name(_):
                    return "NVIDIA GeForce RTX 5090"
        state = trt_vae.describe_environment(torch_module=FakeTorch)
        if not state["available"]:
            self.assertIn("tensorrt-rtx", state["reason"])
            self.assertEqual(state["device"], "NVIDIA GeForce RTX 5090")

    def test_a_working_box_reports_its_device_and_versions(self):
        class FakeTorch:
            class cuda:
                @staticmethod
                def is_available():
                    return True

                @staticmethod
                def get_device_name(_):
                    return "NVIDIA RTX PRO 6000"

        class FakeTrt:
            __version__ = "2.5.0"

        state = trt_vae.describe_environment(torch_module=FakeTorch, tensorrt_module=FakeTrt)
        self.assertTrue(state["available"])
        self.assertEqual(state["device"], "NVIDIA RTX PRO 6000")
        self.assertEqual(state["tensorrt"], "2.5.0")
        self.assertEqual(state["flavour"], "tensorrt_rtx")


class EnginePlumbing(unittest.TestCase):
    """The tiling arithmetic that lets ONE fixed-shape engine decode any size."""

    def test_tiles_cover_the_latent_and_the_last_one_sits_flush(self):
        from trt_engine import tile_positions

        # Flush, not padded-and-cropped: the engine has exactly one input shape,
        # so a short final tile is not a thing that can be run.
        for length in (64, 65, 100, 136, 240):
            starts = tile_positions(length, 64, 8)
            self.assertEqual(starts[0], 0)
            if length > 64:
                self.assertEqual(starts[-1], length - 64)
            covered = set()
            for start in starts:
                covered.update(range(start, start + 64))
            self.assertTrue(set(range(length)).issubset(covered), length)

    def test_a_latent_smaller_than_one_tile_is_a_single_tile(self):
        from trt_engine import tile_positions
        self.assertEqual(tile_positions(30, 64, 8), [0])

    @unittest.skipIf(torch is None, "torch is not available here")
    def test_the_outer_edges_are_never_feathered(self):
        from trt_engine import feather_weights

        # Fading the first and last tile's outer edge would fade the picture
        # into nothing at the frame border.
        only = feather_weights(64, 8, False, False, torch.device("cpu"), torch.float32)
        self.assertTrue(bool((only == 1).all()))
        middle = feather_weights(64, 8, True, True, torch.device("cpu"), torch.float32)
        self.assertLess(middle[0].item(), 1.0)
        self.assertLess(middle[-1].item(), 1.0)
        self.assertEqual(middle[32].item(), 1.0)

    @unittest.skipIf(torch is None, "torch is not available here")
    def test_overlapping_ramps_sum_to_one_so_the_blend_is_neutral(self):
        from trt_engine import feather_weights

        rising = feather_weights(64, 8, True, False, torch.device("cpu"), torch.float32)
        falling = feather_weights(64, 8, False, True, torch.device("cpu"), torch.float32)
        # A join is a cross-fade: the two ramps have to add up, or the seam is a
        # bright or dark band.
        total = falling[-8:] + rising[:8]
        self.assertTrue(torch.allclose(total, torch.ones(8), atol=1e-6), total)

    def test_the_temporal_expansion_matches_the_models_4n_plus_1_batches(self):
        from trt_engine import latent_frames_for, output_frames_for

        # The two batches the reference implementation supports are 5 and 21,
        # which is exactly what 2 and 6 latent frames decode to.
        self.assertEqual(latent_frames_for(5), 2)
        self.assertEqual(latent_frames_for(21), 6)
        self.assertEqual(output_frames_for(2), 5)
        self.assertEqual(output_frames_for(6), 21)

    def test_an_engine_name_changes_with_everything_that_would_break_it(self):
        from trt_engine import engine_name

        base = dict(weights_fingerprint="w", latent_frames=2, tile=64, overlap=8,
                    device_name="RTX 5090", flavour="tensorrt_rtx", version="1.0")
        self.assertEqual(engine_name(**base), engine_name(**base))
        for field, value in [
            ("weights_fingerprint", "other"), ("latent_frames", 6), ("tile", 32),
            ("overlap", 4), ("device_name", "RTX PRO 6000"), ("flavour", "tensorrt"),
            ("version", "1.1"),
        ]:
            with self.subTest(field):
                self.assertNotEqual(engine_name(**base), engine_name(**{**base, field: value}))


class CacheLocation(unittest.TestCase):
    def test_the_cache_follows_the_comfyui_it_was_built_for(self):
        import os
        os.environ.pop("HIVEMIND_SEEDVR2_TRT_CACHE", None)
        os.environ["COMFYUI_DIR"] = "/opt/ComfyUI"
        try:
            self.assertEqual(trt_vae.cache_dir(), "/opt/ComfyUI/models/SEEDVR2/trt-cache")
        finally:
            os.environ.pop("COMFYUI_DIR", None)

    def test_an_explicit_cache_location_wins(self):
        import os
        os.environ["HIVEMIND_SEEDVR2_TRT_CACHE"] = "/mnt/fast/trt"
        try:
            self.assertEqual(trt_vae.cache_dir(), "/mnt/fast/trt")
        finally:
            os.environ.pop("HIVEMIND_SEEDVR2_TRT_CACHE", None)


if __name__ == "__main__":
    unittest.main()
