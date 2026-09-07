"""A decrypted reference never becomes a file.

The incident these are about: another process on this machine listed ComfyUI's
input directory, found the plaintext PNG the gateway had staged from the
owner's own upscale, and copied it. The staging is why `LoadImage` could read
it, and the file is why anything else could.

So the contract under test is: for a lane that has the private loader, the
bytes go into the gateway's memory under a handle, the graph carries the
handle, and the file is gone by the time the prompt is submitted. For a lane
that does not have it — including every rented one — nothing changes at all.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

BASE = Path(__file__).resolve().parent


def load_app():
    for cached in [n for n in sys.modules if n == "gateway" or n.startswith("gateway.")]:
        del sys.modules[cached]
    spec = importlib.util.spec_from_file_location("zimg_app", BASE / "app.py")
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    return app


PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100" "05fe02fe" "dccc59e70000000049454e44ae426082"
)


class StagedInputsLiveInMemory(unittest.TestCase):
    def setUp(self):
        self.app = load_app()

    def test_a_handle_returns_its_bytes_and_an_unknown_one_returns_nothing(self):
        store = self.app.private_inputs
        handle = store.stage(PNG, "image/png")
        self.assertEqual(len(handle), 64, "a handle must be worth guessing at")
        self.assertEqual(store.fetch(handle), (PNG, "image/png"))
        self.assertIsNone(store.fetch("0" * 64))
        self.assertIsNone(store.fetch(""))

    def test_a_handle_is_readable_more_than_once(self):
        # ComfyUI re-executes a node when a prompt is re-queued; a single-use
        # handle would turn that into a failed generation.
        store = self.app.private_inputs
        handle = store.stage(PNG)
        self.assertIsNotNone(store.fetch(handle))
        self.assertIsNotNone(store.fetch(handle))

    def test_an_expired_handle_is_forgotten(self):
        store = self.app.private_inputs
        handle = store.stage(PNG, ttl_seconds=-1)
        self.assertIsNone(store.fetch(handle))

    def test_the_store_is_bounded(self):
        store = self.app.private_inputs
        for _ in range(store.MAX_STAGED + 5):
            store.stage(PNG)
        self.assertLessEqual(store.staged_count(), store.MAX_STAGED)

    def test_releasing_a_handle_drops_the_bytes(self):
        store = self.app.private_inputs
        handle = store.stage(PNG)
        self.assertTrue(store.release(handle))
        self.assertIsNone(store.fetch(handle))


class StagedInputsLeaveTheInputDirectory(unittest.TestCase):
    def setUp(self):
        self.app = load_app()

    def _graph(self, name):
        return {
            "4": {"class_type": "LoadImage", "inputs": {"image": name, "upload": "image"}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": "out"}},
        }

    def test_a_staged_reference_moves_into_memory_and_off_disk(self):
        app = self.app
        with TemporaryDirectory() as td:
            root = Path(td) / "input"
            root.mkdir()
            staged = root / "media-studio-inline-abcdef0123456789.png"
            staged.write_bytes(PNG)
            graph = self._graph(staged.name)
            with patch.object(app.config, "COMFY_INPUT_DIR", root), \
                 patch.object(app.graphs, "lane_loads_private_inputs", lambda url: True):
                body = app.graphs.private_prompt_body(graph, "cid", "http://127.0.0.1:8188")

            self.assertFalse(staged.exists(), "the plaintext reference must not survive submit")
            node = json.loads(body)["prompt"]["4"]
            self.assertEqual(node["class_type"], "HivemindLoadPrivateImage")
            self.assertNotIn("image", node["inputs"], "no filename may remain in the graph")
            self.assertEqual(app.private_inputs.fetch(node["inputs"]["handle"])[0], PNG)

    def test_a_lane_without_the_node_is_left_exactly_as_it_was(self):
        app = self.app
        with TemporaryDirectory() as td:
            root = Path(td) / "input"
            root.mkdir()
            staged = root / "media-studio-inline-abcdef0123456789.png"
            staged.write_bytes(PNG)
            graph = self._graph(staged.name)
            with patch.object(app.config, "COMFY_INPUT_DIR", root), \
                 patch.object(app.graphs, "lane_loads_private_inputs", lambda url: False):
                body = app.graphs.private_prompt_body(graph, "cid", "http://127.0.0.1:8188")

            self.assertTrue(staged.exists(), "installing the pack is what turns this on")
            self.assertEqual(json.loads(body)["prompt"]["4"]["class_type"], "LoadImage")

    def test_a_remote_lane_never_has_its_inputs_taken_away(self):
        # A rented lane reads inputs PUSHED to it and cannot reach this
        # machine's memory; rewriting its graph would break every load.
        app = self.app
        self.assertFalse(app.graphs.lane_loads_private_inputs("http://10.0.0.5:8188"))
        self.assertFalse(app.graphs.lane_loads_private_inputs("https://rental.example:8188"))

    def test_a_persons_own_upload_is_left_where_they_can_pick_it_again(self):
        app = self.app
        with TemporaryDirectory() as td:
            root = Path(td) / "input"
            root.mkdir()
            photo = root / "holiday.png"
            photo.write_bytes(PNG)
            graph = self._graph(photo.name)
            with patch.object(app.config, "COMFY_INPUT_DIR", root), \
                 patch.object(app.graphs, "lane_loads_private_inputs", lambda url: True):
                body = app.graphs.private_prompt_body(graph, "cid", "http://127.0.0.1:8188")
            self.assertTrue(photo.exists())
            self.assertEqual(json.loads(body)["prompt"]["4"]["class_type"], "LoadImage")

    def test_a_name_that_escapes_the_input_directory_is_ignored(self):
        app = self.app
        with TemporaryDirectory() as td:
            root = Path(td) / "input"
            root.mkdir()
            graph = self._graph("media-studio-inline-../../escape.png")
            with patch.object(app.config, "COMFY_INPUT_DIR", root), \
                 patch.object(app.graphs, "lane_loads_private_inputs", lambda url: True):
                body = app.graphs.private_prompt_body(graph, "cid", "http://127.0.0.1:8188")
            self.assertEqual(json.loads(body)["prompt"]["4"]["class_type"], "LoadImage")

    def test_an_unreadable_staged_file_leaves_the_graph_alone_rather_than_failing(self):
        app = self.app
        with TemporaryDirectory() as td:
            root = Path(td) / "input"
            root.mkdir()
            graph = self._graph("media-studio-inline-missing.png")
            with patch.object(app.config, "COMFY_INPUT_DIR", root), \
                 patch.object(app.graphs, "lane_loads_private_inputs", lambda url: True):
                body = app.graphs.private_prompt_body(graph, "cid", "http://127.0.0.1:8188")
            self.assertEqual(json.loads(body)["prompt"]["4"]["class_type"], "LoadImage")

    def test_the_body_keeps_the_shape_comfyui_expects(self):
        app = self.app
        with patch.object(app.graphs, "lane_loads_private_inputs", lambda url: False):
            body = json.loads(app.graphs.private_prompt_body({"1": {}}, "cid", "http://127.0.0.1:8188"))
            self.assertEqual(body, {"prompt": {"1": {}}, "client_id": "cid"})
            self.assertNotIn("client_id", json.loads(
                app.graphs.private_prompt_body({"1": {}}, "", "http://127.0.0.1:8188")))


class EverySubmitGoesThroughTheRewrite(unittest.TestCase):
    """A submit that builds its own body is a lane that keeps writing files."""

    def test_no_local_submit_hand_rolls_its_prompt_body(self):
        for name in ("gateway/runners.py", "gateway/graphs.py"):
            source = (BASE / name).read_text(encoding="utf-8")
            for line_no, line in enumerate(source.splitlines(), start=1):
                stripped = line.strip()
                if not stripped.startswith("body = json.dumps({"):
                    continue
                # graphs.prompt_body is the one sanctioned raw encoder and it
                # lives inside graphs.py itself.
                # The auto-workflow runner builds one body purely to CHOOSE a
                # lane and to push inputs to a rented one; it submits through
                # _auto_submit_prompt, which is wired.
                self.assertNotIn(
                    "client_id", stripped,
                    f"{name}:{line_no} submits a prompt without routing private inputs",
                )


if __name__ == "__main__":
    unittest.main()
