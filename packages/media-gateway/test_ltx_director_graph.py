"""LTX Director graph shape — adapted from Mix-Studio's ltx-director workflow
tests (BlackMixture/Mix-Studio, GPL-3.0).

These are structural: the two-pass wiring is easy to get subtly wrong in ways
that still produce a runnable graph (audio dropped, guides left baked in, the
refine pass fed the base latent), and each of those is a silent quality bug
rather than an error.
"""

import unittest

from ltx_director_graph import (
    ASSETS,
    SIGMAS_BASE,
    build_ltx_director_prompt,
    missing_ltx_director_assets,
)


def project(**overrides):
    base = {
        "version": 1,
        "durationFrames": 240,
        "range": {"startFrame": 0, "lengthFrames": 120},
        "globalPrompt": "a lantern-lit alley after rain",
        "segments": [{"start": 0, "length": 120, "prompt": "she steps out"}],
    }
    base.update(overrides)
    return base


class GraphShapeTest(unittest.TestCase):
    def setUp(self):
        self.graph, self.meta = build_ltx_director_prompt(project(), {"seed": 7})

    def test_the_timeline_reaches_the_node_as_scalars_not_a_dict(self):
        inputs = self.graph["director"]["inputs"]
        self.assertIsInstance(inputs["timeline_data"], str, "timeline_data is a JSON string widget")
        self.assertEqual(inputs["local_prompts"], "she steps out")
        self.assertEqual(inputs["segment_lengths"], "120")
        self.assertEqual(inputs["duration_frames"], 120)
        self.assertEqual(inputs["end_second"], 5.0)
        self.assertEqual(self.meta["frames"], 121, "8n+1 lattice")

    def test_audio_rides_through_the_sampler_and_is_split_back_out(self):
        # LTX 2.3 is a joint audio-video model; sampling the video latent alone
        # is how a clip comes back silent.
        self.assertEqual(
            self.graph["concat1"]["inputs"]["audio_latent"], ["director", 3],
        )
        self.assertEqual(self.graph["sep1"]["inputs"]["av_latent"], ["samp1", 0])
        self.assertEqual(
            self.graph["concat2"]["inputs"]["audio_latent"], ["sep1", 1],
            "the refine pass carries the base pass's audio, it does not regenerate it",
        )
        self.assertEqual(self.graph["audio_dec"]["inputs"]["samples"], ["sep2", 1])
        self.assertEqual(self.graph["video"]["inputs"]["audio"], ["audio_dec", 0])

    def test_guides_are_cropped_off_after_every_pass(self):
        # Left in, the guide frames appear in the delivered video.
        self.assertEqual(self.graph["crop1"]["inputs"]["latent"], ["sep1", 0])
        self.assertEqual(self.graph["crop2"]["inputs"]["latent"], ["sep2", 0])
        self.assertEqual(self.graph["decode"]["inputs"]["samples"], ["crop2", 2])

    def test_the_refine_pass_samples_the_upsampled_latent(self):
        self.assertEqual(self.graph["ups"]["inputs"]["samples"], ["crop1", 2])
        self.assertEqual(self.graph["guide_refine"]["inputs"]["latent"], ["ups", 0])
        self.assertEqual(self.graph["guide_base"]["inputs"]["scale_by"], 0.5)
        self.assertEqual(self.graph["guide_refine"]["inputs"]["scale_by"], 1)
        self.assertEqual(self.graph["samp2"]["inputs"]["latent_image"], ["concat2", 0])

    def test_each_pass_uses_its_own_sampler_and_ladder(self):
        self.assertEqual(self.graph["sampler_sel1"]["inputs"]["sampler_name"], "euler_ancestral_cfg_pp")
        self.assertEqual(self.graph["sampler_sel2"]["inputs"]["sampler_name"], "euler_cfg_pp")
        self.assertEqual(self.graph["sigmas1"]["inputs"]["sigmas"], SIGMAS_BASE)
        self.assertNotEqual(
            self.graph["sigmas2"]["inputs"]["sigmas"], SIGMAS_BASE,
            "the refine pass must not re-run the full ladder",
        )

    def test_the_director_takes_the_lora_chained_model_and_the_lora_clip(self):
        self.assertEqual(self.graph["model_lora"]["inputs"]["strength_model"], 0.5)
        self.assertEqual(self.graph["director"]["inputs"]["model"], ["model_lora", 0])
        # Slot 1 of LoraLoader is CLIP; slot 0 would hand the node a MODEL.
        self.assertEqual(self.graph["director"]["inputs"]["clip"], ["te_lora", 1])

    def test_extra_loras_stack_after_the_distilled_one(self):
        graph, _ = build_ltx_director_prompt(project(), {
            "loras": [
                {"name": "a.safetensors", "strength": 0.8},
                {"name": "off.safetensors", "enabled": False},
                {"name": "b.safetensors"},
            ],
        })
        self.assertEqual(graph["director_lora_1"]["inputs"]["model"], ["model_lora", 0])
        self.assertEqual(graph["director_lora_1"]["inputs"]["strength_model"], 0.8)
        self.assertEqual(graph["director_lora_2"]["inputs"]["model"], ["director_lora_1", 0])
        self.assertEqual(graph["director_lora_2"]["inputs"]["strength_model"], 1.0, "default full")
        self.assertEqual(graph["director"]["inputs"]["model"], ["director_lora_2", 0])
        self.assertNotIn("director_lora_3", graph, "a disabled LoRA is not chained")


class IcLoraTest(unittest.TestCase):
    def test_the_ic_lora_stands_down_without_a_motion_track(self):
        graph, meta = build_ltx_director_prompt(project(), {})
        self.assertEqual(meta["icLoraName"], "None")
        self.assertEqual(graph["guide_base"]["inputs"]["ic_lora_name"], "None")

    def test_a_motion_track_switches_the_ic_lora_on(self):
        graph, meta = build_ltx_director_prompt(project(
            motionSegments=[{"start": 0, "length": 120, "videoFile": "ref.mp4"}],
        ), {})
        self.assertEqual(meta["icLoraName"], ASSETS["ic_lora"])
        self.assertTrue(graph["director"]["inputs"]["use_custom_motion"])

    def test_a_project_ic_lora_name_keeps_forward_slashes(self):
        # The donor rewrites '/' to '\' here, which is a Windows-ism — ComfyUI
        # lists this LoRA as 'ltx/2.3/...' on this host and a backslash misses.
        graph, meta = build_ltx_director_prompt(project(
            motionSegments=[{"start": 0, "length": 120, "videoFile": "ref.mp4"}],
            settings={"icLoraName": "ltx/2.3/custom.safetensors"},
        ), {})
        self.assertEqual(meta["icLoraName"], "ltx/2.3/custom.safetensors")
        self.assertNotIn("\\", graph["guide_base"]["inputs"]["ic_lora_name"])


class DimensionTest(unittest.TestCase):
    def test_dimensions_snap_to_the_sixty_four_grid_with_a_floor(self):
        _, meta = build_ltx_director_prompt(project(), {"width": 1290, "height": 700})
        self.assertEqual(meta["width"], 1280)
        self.assertEqual(meta["height"], 704)
        _, tiny = build_ltx_director_prompt(project(), {"width": 10, "height": 10})
        self.assertEqual((tiny["width"], tiny["height"]), (256, 256))


class AssetTest(unittest.TestCase):
    def test_missing_weights_are_named_against_what_comfy_offers(self):
        available = {
            "checkpoints": [ASSETS["checkpoint"]],
            "loras": [ASSETS["distilled_lora"], ASSETS["ic_lora"]],
            "text_encoders": [],
            "latent_upscale_models": [ASSETS["upscaler"]],
        }
        self.assertEqual(
            missing_ltx_director_assets(available),
            [ASSETS["text_encoder"], ASSETS["text_encoder_lora"]],
        )
        available["text_encoders"] = [ASSETS["text_encoder"]]
        available["loras"].append(ASSETS["text_encoder_lora"])
        self.assertEqual(missing_ltx_director_assets(available), [])

    def test_asset_overrides_reach_the_graph(self):
        graph, meta = build_ltx_director_prompt(
            project(), {}, {"checkpoint": "other.safetensors", "bogus": "ignored"},
        )
        self.assertEqual(graph["ckpt"]["inputs"]["ckpt_name"], "other.safetensors")
        self.assertEqual(graph["audio_vae"]["inputs"]["ckpt_name"], "other.safetensors")
        self.assertNotIn("bogus", meta["assets"])


if __name__ == "__main__":
    unittest.main()
