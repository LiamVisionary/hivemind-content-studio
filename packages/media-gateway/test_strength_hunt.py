"""Strength Hunt unit tests — sweep planning, graph merging, layout math.
Behavior mirrors Mix-Studio's lib/strength-hunt.js (GPL-3.0); see
docs/MIX_STUDIO_ASSIMILATION_PLAN.md for the assimilation record."""

import unittest

from strength_hunt import (
    MAX_HUNT_VARIANTS,
    build_strength_hunt_plan,
    merge_strength_hunt_graphs,
    sheet_layout,
    strength_hunt_output_index,
    strength_values,
)


class StrengthValuesTest(unittest.TestCase):
    def test_positive_sweep_includes_zero_and_max(self):
        self.assertEqual(strength_values(1.0), [0.0, 0.2, 0.4, 0.6, 0.8, 1.0])

    def test_negative_sweep_steps_toward_negative(self):
        self.assertEqual(strength_values(-0.6), [0.0, -0.2, -0.4, -0.6])

    def test_magnitude_is_capped_at_two(self):
        values = strength_values(37)
        self.assertEqual(values[-1], 2.0)
        self.assertEqual(len(values), 11)

    def test_non_multiple_max_is_appended_exactly(self):
        values = strength_values(0.5)
        self.assertEqual(values, [0.0, 0.2, 0.4, 0.5])

    def test_zero_strength_is_single_tile(self):
        self.assertEqual(strength_values(0), [0.0])


class PlanTest(unittest.TestCase):
    LORAS = [
        {"id": "style.safetensors", "strength": 0.6},
        {"id": "detail.safetensors", "strength": 0.4},
        {"id": "kept.safetensors", "strength": 0.9},
    ]

    def test_single_axis_plan(self):
        plan = build_strength_hunt_plan(self.LORAS, ["style.safetensors"])
        self.assertEqual(plan["rows"], 1)
        self.assertEqual(plan["cols"], 4)  # 0, .2, .4, .6
        self.assertEqual(len(plan["variants"]), 4)
        # Zero variant drops the swept LoRA but keeps the others untouched.
        zero = plan["variants"][0]
        self.assertNotIn("style.safetensors", [entry["id"] for entry in zero["loras"]])
        self.assertIn("kept.safetensors", [entry["id"] for entry in zero["loras"]])
        # Non-zero variants carry the swept value.
        self.assertEqual(plan["variants"][2]["coords"]["style.safetensors"], 0.4)

    def test_two_axis_plan_is_row_major_axis2_rows(self):
        plan = build_strength_hunt_plan(self.LORAS, ["style.safetensors", "detail.safetensors"])
        self.assertEqual(plan["cols"], 4)  # axis 1: 0..0.6
        self.assertEqual(plan["rows"], 3)  # axis 2: 0..0.4
        self.assertEqual(len(plan["variants"]), 12)
        v = plan["variants"][5]  # row 1, col 1
        self.assertEqual((v["row"], v["col"]), (1, 1))
        self.assertEqual(v["coords"]["style.safetensors"], 0.2)
        self.assertEqual(v["coords"]["detail.safetensors"], 0.2)

    def test_unknown_and_excess_axes_are_rejected(self):
        with self.assertRaises(ValueError):
            build_strength_hunt_plan(self.LORAS, ["missing.safetensors"])
        with self.assertRaises(ValueError):
            build_strength_hunt_plan(self.LORAS, [entry["id"] for entry in self.LORAS])
        with self.assertRaises(ValueError):
            build_strength_hunt_plan(self.LORAS, [])

    def test_variant_cap_guard(self):
        loras = [
            {"id": "a.safetensors", "strength": 2.0},
            {"id": "b.safetensors", "strength": 2.0},
        ]
        plan = build_strength_hunt_plan(loras, ["a.safetensors", "b.safetensors"])
        self.assertEqual(len(plan["variants"]), MAX_HUNT_VARIANTS)
        with self.assertRaises(ValueError):
            build_strength_hunt_plan(loras, ["a.safetensors", "b.safetensors"], max_variants=100)


def tiny_graph(strength, index):
    """A minimal API graph shaped like real ones: shared loader/encode, one
    variant-specific LoRA+sampler chain, one save."""
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "krea2.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "same prompt", "clip": ["1", 1]}},
        "3": {"class_type": "LoraLoader", "inputs": {"model": ["1", 0], "strength_model": strength}},
        "4": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "positive": ["2", 0], "seed": 42}},
        "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": f"hunt_strength_hunt_{index:03d}"}},
    }


class MergeTest(unittest.TestCase):
    def test_shared_nodes_collapse_and_variant_chains_fork(self):
        merged = merge_strength_hunt_graphs([tiny_graph(0.2, 0), tiny_graph(0.4, 1)])
        by_class = {}
        for node in merged.values():
            by_class.setdefault(node["class_type"], []).append(node)
        # Loader and text-encode are identical across variants: shared once.
        self.assertEqual(len(by_class["CheckpointLoaderSimple"]), 1)
        self.assertEqual(len(by_class["CLIPTextEncode"]), 1)
        # The differing LoRA strength forks the LoRA node and its sampler.
        self.assertEqual(len(by_class["LoraLoader"]), 2)
        self.assertEqual(len(by_class["KSampler"]), 2)
        self.assertEqual(len(by_class["SaveImage"]), 2)

    def test_identical_side_effect_nodes_are_never_shared(self):
        graph = tiny_graph(0.2, 0)
        merged = merge_strength_hunt_graphs([graph, graph])
        saves = [n for n in merged.values() if n["class_type"] == "SaveImage"]
        self.assertEqual(len(saves), 2)
        # Everything else IS shared: total = 4 shared + 2 saves.
        self.assertEqual(len(merged), 6)

    def test_links_are_rewritten_to_merged_ids(self):
        merged = merge_strength_hunt_graphs([tiny_graph(0.2, 0), tiny_graph(0.4, 1)])
        for node in merged.values():
            for value in node["inputs"].values():
                if isinstance(value, list) and len(value) == 2 and isinstance(value[1], int):
                    self.assertIn(str(value[0]), merged, f"dangling link {value}")
        # Both samplers must reference the SAME shared text-encode node.
        samplers = [n for n in merged.values() if n["class_type"] == "KSampler"]
        positives = {tuple(n["inputs"]["positive"]) for n in samplers}
        self.assertEqual(len(positives), 1)

    def test_empty_graph_is_rejected(self):
        with self.assertRaises(ValueError):
            merge_strength_hunt_graphs([{}])


class OutputIndexTest(unittest.TestCase):
    def test_index_extraction(self):
        self.assertEqual(strength_hunt_output_index("hunt_strength_hunt_007_00001_.png"), 7)
        self.assertIsNone(strength_hunt_output_index("krea2_identity_abc_00001_.png"))


class SheetLayoutTest(unittest.TestCase):
    def test_strip_layout_within_bounds(self):
        layout = sheet_layout(1, 6, tile_aspect=1.0)
        self.assertEqual(layout["rows"], 1)
        self.assertEqual(layout["cols"], 6)
        self.assertLessEqual(layout["width"], 6144)
        self.assertEqual(layout["tile_width"], 512)

    def test_matrix_layout_shrinks_to_fit(self):
        layout = sheet_layout(11, 11, tile_aspect=1.0)
        self.assertLessEqual(layout["width"], 4096)
        self.assertLessEqual(layout["height"], 4096)
        self.assertGreater(layout["tile_width"], 0)

    def test_square_option_rewraps_a_strip(self):
        layout = sheet_layout(1, 6, tile_aspect=1.0, square=True, count=6)
        self.assertEqual(layout["cols"], 3)
        self.assertEqual(layout["rows"], 2)


if __name__ == "__main__":
    unittest.main()
