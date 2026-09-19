"""A person's own ComfyUI workflow can take a picture.

Until 2026-09-14 the generic runner behind every dropped-in workflow patched
the prompt, seed, steps, cfg and dimensions and touched no picture at all —
only the two graph shapes we fingerprint (the H3 Director and the Klein
direction lanes) could take one. Discovery therefore refused any graph with a
LoadImage node outright, so a stranger's edit or ControlNet workflow silently
never appeared. These pin the two halves of that being fixed.
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from test_app import load_app


def edit_graph():
    """An img2img graph shaped the way a person's export actually is."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "x.safetensors"}},
        "4": {"class_type": "LoadImage", "inputs": {"image": "their-own-default.png"}},
        "7": {"class_type": "VAEEncode", "inputs": {"pixels": ["4", 0], "vae": ["3", 0]}},
        "8": {"class_type": "KSampler", "inputs": {"latent_image": ["7", 0]}},
    }


class AutoWorkflowReferences(unittest.TestCase):
    def test_slots_are_the_load_image_nodes_in_the_order_a_person_reads_them(self):
        app = load_app()
        graph = {
            "12": {"class_type": "LoadImage", "inputs": {"image": "c.png"}},
            "3": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "7": {"class_type": "LoadImage", "inputs": {"image": "b.png"}},
            "9": {"class_type": "KSampler", "inputs": {}},
            # Not a picture slot: filling it would hand the graph a file of the
            # wrong kind.
            "20": {"class_type": "LoadVideo", "inputs": {"file": "v.mp4"}},
        }
        self.assertEqual(
            [node_id for node_id, _ in app.graphs.auto_reference_slots(graph)],
            ["3", "7", "12"],
            "node ids sort numerically — 12 comes last, not first",
        )

    def test_a_reference_replaces_the_graphs_own_filename(self):
        """The default is not a fallback, it is a stale name.

        A workflow ships whatever file its author had. Leaving that in place
        for a filled slot would run the run on somebody else's picture, or on
        no file at all.
        """
        app = load_app()
        with TemporaryDirectory() as td:
            comfy_input = Path(td) / "input"
            comfy_input.mkdir()
            source = Path(td) / "mine.png"
            source.write_bytes(b"the caller's picture")
            graph = edit_graph()
            with patch.object(app.config, "COMFY_INPUT_DIR", comfy_input):
                rec = {}
                applied = app.graphs._auto_apply_reference_images(graph, [source], rec)
            self.assertEqual(applied, 1)
            staged = graph["4"]["inputs"]["image"]
            self.assertNotEqual(staged, "their-own-default.png")
            self.assertEqual((comfy_input / staged).read_bytes(), b"the caller's picture")
            # The count reaches the job record; the filename never does.
            self.assertEqual(rec["options"]["reference_images"], 1)

    def test_an_unfilled_slot_keeps_what_the_workflow_shipped(self):
        """A graph carrying its own control image still runs untouched."""
        app = load_app()
        with TemporaryDirectory() as td:
            comfy_input = Path(td) / "input"
            comfy_input.mkdir()
            graph = edit_graph()
            graph["5"] = {"class_type": "LoadImage", "inputs": {"image": "bundled-pose.png"}}
            source = Path(td) / "mine.png"
            source.write_bytes(b"one picture")
            with patch.object(app.config, "COMFY_INPUT_DIR", comfy_input):
                applied = app.graphs._auto_apply_reference_images(graph, [source], {})
            self.assertEqual(applied, 1, "one reference fills one slot, not both")
            self.assertEqual(graph["5"]["inputs"]["image"], "bundled-pose.png")

    def test_no_references_leaves_the_graph_exactly_as_it_was(self):
        app = load_app()
        graph = edit_graph()
        before = str(graph)
        self.assertEqual(app.graphs._auto_apply_reference_images(graph, [], {}), 0)
        self.assertEqual(str(graph), before)

    def test_a_staged_reference_is_still_swapped_for_the_private_loader(self):
        """Staging must not open a hole in the no-plaintext-on-disk rule.

        The reference lands in ComfyUI's input dir as a plaintext PNG, and it
        is PRIVATE_LOADERS that moves those bytes into memory and deletes the
        file at submit. A LoadImage this function filled has to still be a
        LoadImage when that swap runs.
        """
        app = load_app()
        self.assertIn("LoadImage", app.graphs.PRIVATE_LOADERS)
        with TemporaryDirectory() as td:
            comfy_input = Path(td) / "input"
            comfy_input.mkdir()
            source = Path(td) / "mine.png"
            source.write_bytes(b"private bytes")
            graph = edit_graph()
            with patch.object(app.config, "COMFY_INPUT_DIR", comfy_input):
                app.graphs._auto_apply_reference_images(graph, [source], {})
            self.assertEqual(graph["4"]["class_type"], "LoadImage")


if __name__ == "__main__":
    unittest.main()
