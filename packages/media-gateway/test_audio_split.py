"""Splitting a clip's sound leaves nothing behind.

The stems of a generated video are somebody's dialogue. The contract under test
is the one smart-select set for a mask, applied to audio:

  * the clip goes into the graph as a memory handle, never a filename, and the
    handle is released when the job ends — whichever way it ends;
  * the stems leave through ComfyUI's TEMP directory, are read once and deleted,
    and ride back on the in-memory job record only: history.jsonl learns that a
    split ran, never what was in it;
  * voices are separated from the DIALOGUE stem, not from the mix;
  * the weights are fetched over https from an immutable revision and trusted by
    hash, and a lane that cannot load the splitter is refused with a sentence
    while anything is rendering rather than restarted underneath it.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import re
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


def load_graphs():
    spec = importlib.util.spec_from_file_location("audio_split_under_test", BASE / "audio_split.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheGraph(unittest.TestCase):
    def setUp(self):
        self.audio_split = load_graphs()

    def test_the_clip_goes_in_as_a_handle_and_nothing_is_saved_as_an_output(self):
        graph, stems = self.audio_split.build_audio_split_prompt("a" * 64)
        classes = {node["class_type"] for node in graph.values()}
        self.assertEqual(classes, set(self.audio_split.REQUIRED_CLASSES))
        self.assertEqual(graph["1"], {"class_type": "HivemindLoadPrivateAudio", "inputs": {"handle": "a" * 64}})
        # SaveAudio* writes into the output directory, where the sweeper would
        # seal five stems into History for every clip anyone ever split.
        self.assertFalse([name for name in classes if name.startswith("Save")])
        self.assertEqual(sorted(stems.values()), ["dialogue", "effects", "music", "voice_1", "voice_2"])
        for node_id in stems:
            self.assertEqual(graph[node_id]["class_type"], self.audio_split.PREVIEW_CLASS)

    def test_voices_are_split_from_the_dialogue_stem_not_the_mix(self):
        graph, _ = self.audio_split.build_audio_split_prompt("h")
        self.assertEqual(graph["3"]["class_type"], self.audio_split.VOICES_CLASS)
        self.assertEqual(graph["3"]["inputs"]["audio"], ["2", 0])
        self.assertEqual(dict(self.audio_split.SOUNDTRACK_STEMS)["dialogue"], 0)

    def test_voices_can_be_left_out_and_a_handle_is_required(self):
        graph, stems = self.audio_split.build_audio_split_prompt("h", voices=False)
        self.assertNotIn("3", graph)
        self.assertEqual(sorted(stems.values()), ["dialogue", "effects", "music"])
        with self.assertRaises(ValueError):
            self.audio_split.build_audio_split_prompt("  ")

    def test_weights_are_https_pinned_to_a_revision_and_trusted_by_hash(self):
        for item in self.audio_split.WEIGHTS:
            self.assertRegex(item["url"], r"^https://huggingface\.co/JusperLee/[\w-]+/resolve/[0-9a-f]{40}/model\.safetensors$")
            self.assertNotIn("/resolve/main/", item["url"])
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(item["bytes"], 1_000_000)

    def test_the_pack_and_the_gateway_agree_on_where_the_weights_live(self):
        pack = (BASE.parent / "comfyui-custom-nodes" / "hivemind-audio-split" / "__init__.py").read_text(encoding="utf-8")
        self.assertIn(f'MODELS_SUBDIR = "{self.audio_split.MODELS_SUBDIR}"', pack)
        for item in self.audio_split.WEIGHTS:
            self.assertIn(f'"folder": "{item["folder"]}"', pack)
        for name in self.audio_split.REQUIRED_CLASSES[1:]:
            self.assertRegex(pack, rf'"{name}": {name},')


class FakeLane:
    """ComfyUI's four endpoints, as far as the runner reads them."""

    def __init__(self, temp_root, *, classes, queue=None, outcome="success", message=""):
        self.temp_root = temp_root
        self.classes = set(classes)
        self.queue = queue or {"queue_running": [], "queue_pending": []}
        self.outcome = outcome
        self.message = message
        self.submitted = None

    def urlopen(self, target, timeout=None):
        url = target if isinstance(target, str) else target.full_url
        if "/object_info/" in url:
            name = url.rsplit("/", 1)[-1]
            return _Answer({name: {}} if name in self.classes else {})
        if url.endswith("/queue"):
            return _Answer(self.queue)
        if url.endswith("/prompt"):
            self.submitted = json.loads(target.data.decode("utf-8"))
            return _Answer({"prompt_id": "p1"})
        if url.endswith("/history/p1"):
            if self.outcome != "success":
                return _Answer({"p1": {"status": {
                    "status_str": "error",
                    "messages": [["execution_error", {"exception_message": self.message}]],
                }}})
            outputs = {}
            (self.temp_root / "temp").mkdir(parents=True, exist_ok=True)
            for node_id, node in self.submitted["prompt"].items():
                if node["class_type"] != "HivemindPreviewStemWav":
                    continue
                name = f"hivemind-stem-{node_id}.wav"
                (self.temp_root / "temp" / name).write_bytes(b"RIFF" + node_id.encode())
                outputs[node_id] = {
                    "audio": [{"filename": name, "subfolder": "", "type": "temp"}],
                    # voice_2 (the last output node) is the empty track.
                    "level_db": [-70.4 if node_id == "14" else -20.0],
                    "seconds": [9.0],
                }
            return _Answer({"p1": {"status": {"status_str": "success", "completed": True}, "outputs": outputs}})
        raise AssertionError(f"unexpected lane call: {url}")


class _Answer:
    status = 200

    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TheRunner(unittest.TestCase):
    def setUp(self):
        self.app = load_app()
        self.stems = sys.modules["gateway.stems"]
        self.private_inputs = sys.modules["gateway.private_inputs"]
        self.history = sys.modules["gateway.history"]
        self.jobs = sys.modules["gateway.jobs"]

    def _run(self, lane, *, weights_missing=()):
        written = []
        with patch.object(self.stems.net, "urlopen", lane.urlopen), \
             patch.object(self.stems.runners, "COMFY_TEMP_DIR", lane.temp_root), \
             patch.object(self.stems, "weights_missing", lambda: list(weights_missing)), \
             patch.object(self.stems._history, "append_history", written.append), \
             patch.object(self.stems.time, "sleep", lambda _s: None), \
             patch.object(self.stems, "_forget_stems_later", lambda _job: None):
            self.stems.run_audio_split("job1", b"\x00\x00\x00\x18ftypmp42", "video/mp4", {})
        with self.jobs.jobs_lock:
            return dict(self.jobs.jobs["job1"]), written

    def test_stems_ride_back_inline_and_nothing_is_left_behind(self):
        with TemporaryDirectory() as td:
            lane = FakeLane(Path(td), classes=self.stems.audio_split.REQUIRED_CLASSES)
            rec, written = self._run(lane)
            self.assertEqual(rec["status"], "success", rec.get("error"))
            self.assertEqual([stem["key"] for stem in rec["stems"]], ["dialogue", "effects", "music", "voice_1", "voice_2"])
            self.assertEqual([stem["silent"] for stem in rec["stems"]], [False, False, False, False, True])
            self.assertTrue(base64.b64decode(rec["stems"][0]["wav_base64"]).startswith(b"RIFF"))
            # Read once and deleted: no plaintext stem survives the job.
            self.assertEqual(list((Path(td) / "temp").iterdir()), [])
            # The graph carried a handle, and the handle is gone.
            handle = lane.submitted["prompt"]["1"]["inputs"]["handle"]
            self.assertRegex(handle, r"^[0-9a-f]{64}$")
            self.assertIsNone(self.private_inputs.fetch(handle))
            self.assertEqual(self.private_inputs.staged_count(), 0)
            # History learns that a split ran — never what was in it.
            self.assertEqual(len(written), 1)
            self.assertNotIn("stems", written[0])
            self.assertNotIn("RIFF", json.dumps(written[0]))
            self.assertEqual(rec["outputs"], [], "a stem is never a studio output")

    def test_the_nodes_own_sentence_is_what_the_person_is_told(self):
        with TemporaryDirectory() as td:
            lane = FakeLane(Path(td), classes=self.stems.audio_split.REQUIRED_CLASSES,
                            outcome="error", message="That clip has no sound to split.")
            rec, _ = self._run(lane)
            self.assertEqual(rec["status"], "error")
            self.assertEqual(rec["error"], "That clip has no sound to split.")
            self.assertEqual(self.private_inputs.staged_count(), 0, "a failed job still releases its input")

    def test_a_silent_clip_is_said_the_way_the_sound_only_row_says_it(self):
        with TemporaryDirectory() as td:
            lane = FakeLane(Path(td), classes=self.stems.audio_split.REQUIRED_CLASSES,
                            outcome="error", message="No audio stream found in the file.")
            rec, _ = self._run(lane)
            self.assertEqual(rec["error"], "This clip has no sound.")

    def test_a_busy_lane_is_never_restarted_to_load_the_splitter(self):
        with TemporaryDirectory() as td, TemporaryDirectory() as comfy:
            (Path(comfy) / "custom_nodes").mkdir()
            lane = FakeLane(Path(td), classes=["HivemindLoadPrivateAudio"], queue={"queue_running": [["x"]], "queue_pending": []})
            restarts = []
            dependencies = sys.modules["gateway.dependencies"]
            with patch.object(self.stems.config, "COMFY", Path(comfy)), \
                 patch.object(dependencies, "restart_lane", lambda lane="default": restarts.append(lane) or {"accepted": True}):
                rec, _ = self._run(lane)
            self.assertEqual(rec["status"], "error")
            self.assertIn("Something is rendering right now", rec["error"])
            self.assertEqual(restarts, [], "a restart takes the running render down with it")
            # …but the install itself happened, so the next engine start has it.
            link = Path(comfy) / "custom_nodes" / "hivemind-audio-split"
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), self.stems.PACK_DIR.resolve())
            self.assertIsNone(lane.submitted, "nothing is queued on a lane that cannot run it")

    def test_a_real_directory_in_the_packs_place_is_never_replaced(self):
        with TemporaryDirectory() as td, TemporaryDirectory() as comfy:
            mine = Path(comfy) / "custom_nodes" / "hivemind-audio-split"
            mine.mkdir(parents=True)
            (mine / "keep.txt").write_text("somebody's", encoding="utf-8")
            lane = FakeLane(Path(td), classes=[])
            with patch.object(self.stems.config, "COMFY", Path(comfy)):
                rec, _ = self._run(lane)
            self.assertEqual(rec["status"], "error")
            self.assertIn("is not the studio's link", rec["error"])
            self.assertTrue((mine / "keep.txt").is_file())


class TheRoute(unittest.TestCase):
    def test_inline_media_is_decoded_in_memory_and_bounded(self):
        load_app()
        stems = sys.modules["gateway.stems"]
        payload, media_type = stems.decode_inline_media("data:video/webm;base64," + base64.b64encode(b"clip").decode())
        self.assertEqual((payload, media_type), (b"clip", "video/webm"))
        self.assertEqual(stems.decode_inline_media(base64.b64encode(b"raw").decode()), (b"raw", "video/mp4"))
        for bad in (None, "", "data:image/png;base64,AAAA", "not base64!!"):
            with self.assertRaises(ValueError):
                stems.decode_inline_media(bad)
        with patch.object(stems, "MAX_SOURCE_BYTES", 2), self.assertRaises(ValueError):
            stems.decode_inline_media(base64.b64encode(b"three").decode())
        # No path is ever made for the clip: past its docstring (which names the
        # directory the sibling routes write to), the function touches no file.
        source = (BASE / "gateway" / "stems.py").read_text(encoding="utf-8")
        body = source[source.index("def decode_inline_media"):source.index("def _set(")]
        code = body[body.index('"""', body.index('"""') + 3) + 3:]
        self.assertIsNone(re.search(r"write_bytes|open\(|Path\(|tempfile|OUT_DIR", code))


if __name__ == "__main__":
    unittest.main()
