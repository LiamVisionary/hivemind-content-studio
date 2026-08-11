"""Soft-inpaint graph tests (Mix-Studio port). The load-bearing contract: the
intact source is VAE-encoded with only the NOISE masked (never
VAEEncodeForInpaint — flow/DiT models reproduce its grey erase), and the
untouched source is composited back outside the grown mask."""

import unittest

from krea2_identity_workflow import (
    build_krea2_turbo_inpaint_prompt,
    localized_edit_prompt,
    mask_expand_pixels,
    mask_influence_denoise,
)


class MaskHelperTest(unittest.TestCase):
    def test_expand_clamps_to_donor_range(self):
        self.assertEqual(mask_expand_pixels(None), 14)
        self.assertEqual(mask_expand_pixels(2), 6)
        self.assertEqual(mask_expand_pixels(500), 32)
        self.assertEqual(mask_expand_pixels(20), 20)

    def test_influence_maps_percent_to_denoise(self):
        self.assertEqual(mask_influence_denoise(None), 0.78)
        self.assertEqual(mask_influence_denoise(100), 1.0)
        self.assertEqual(mask_influence_denoise(10), 0.25)
        self.assertEqual(mask_influence_denoise(50), 0.5)

    def test_localized_prompt_appends_preservation_clause(self):
        text = localized_edit_prompt("make the jacket red")
        self.assertTrue(text.startswith("make the jacket red. Localized edit only."))
        self.assertIn("Preserve the exact surrounding scene", localized_edit_prompt(""))


class InpaintGraphTest(unittest.TestCase):
    def build(self, profile, **options):
        return build_krea2_turbo_inpaint_prompt(
            "make the jacket red",
            "source.png",
            "mask.png",
            options=options,
            profile=profile,
            filename_prefix="test_inpaint",
        )

    def test_soft_inpaint_wiring_not_grey_erase(self):
        graph = self.build("apple-silicon", seed=42)
        classes = [node["class_type"] for node in graph.values()]
        self.assertNotIn("VAEEncodeForInpaint", classes)
        self.assertEqual(graph["encode"]["class_type"], "VAEEncode")
        self.assertEqual(graph["encode"]["inputs"]["pixels"], ["src", 0])
        self.assertEqual(graph["inpaint_latent"]["class_type"], "SetLatentNoiseMask")
        self.assertEqual(graph["7"]["inputs"]["latent_image"], ["inpaint_latent", 0])
        # The composite keeps source pixels everywhere outside the grown mask.
        comp = graph["composite"]["inputs"]
        self.assertEqual(comp["destination"], ["src", 0])
        self.assertEqual(comp["mask"], ["mask_grow", 0])
        self.assertTrue(comp["resize_source"])
        self.assertEqual(graph["10"]["inputs"]["images"], ["composite", 0])

    def test_mask_chain_grows_with_tapered_corners(self):
        graph = self.build("apple-silicon", mask_expand=24)
        self.assertEqual(graph["mask_chan"]["inputs"]["channel"], "red")
        grow = graph["mask_grow"]["inputs"]
        self.assertEqual(grow["expand"], 24)
        self.assertTrue(grow["tapered_corners"])

    def test_influence_reaches_denoise_and_prompt_is_localized(self):
        graph = self.build("apple-silicon", mask_influence=60)
        self.assertEqual(graph["7"]["inputs"]["denoise"], 0.6)
        self.assertIn("Localized edit only.", graph["4"]["inputs"]["prompt"])

    def test_apple_profile_bakes_loras_into_loader(self):
        graph = self.build("apple-silicon", loras=[{"id": "style.safetensors", "strength": 0.8}])
        self.assertEqual(graph["1"]["class_type"], "MultiLoRAStackToPreLora")
        self.assertIn("style.safetensors", graph["1"]["inputs"]["lora_stack"])
        self.assertEqual(graph["7"]["inputs"]["model"], ["2", 0])

    def test_portable_profile_chains_loras_off_shared_loader(self):
        graph = self.build("cuda", loras=[{"id": "style.safetensors", "strength": 0.8}])
        self.assertEqual(graph["2"]["class_type"], "UNETLoader")
        loaders = [k for k, node in graph.items() if node["class_type"] == "LoraLoaderModelOnly"]
        self.assertEqual(len(loaders), 1)
        self.assertEqual(graph["7"]["inputs"]["model"], [loaders[0], 0])


if __name__ == "__main__":
    unittest.main()
