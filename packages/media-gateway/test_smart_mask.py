"""SAM3 smart-select graphs and the route that runs them.

Translated from Mix-Studio's `lib/edit-mask.js`, with one deliberate change:
the mask leaves through PreviewImage (temp dir) rather than SaveImage, because
anything written to the output directory is sealed by the privacy sweeper —
which would both clutter History and make the mask unreadable to the gateway
that just produced it.
"""

import base64
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from smart_mask import MAX_DETECTIONS, build_sam3_mask_prompt, normalize_points
from test_app import load_app


class SmartMaskGraphTest(unittest.TestCase):
    def test_text_mode_grounds_the_named_object(self):
        graph = build_sam3_mask_prompt("shot.png", prompt="the jacket")
        self.assertEqual(graph["source"]["inputs"]["image"], "shot.png")
        ground = graph["sam3_ground"]["inputs"]
        self.assertEqual(ground["text_prompt"], "the jacket")
        self.assertEqual(ground["max_detections"], MAX_DETECTIONS)
        self.assertEqual(ground["confidence_threshold"], 0.2)
        self.assertEqual(graph["mask_image"]["inputs"]["mask"], ["sam3_ground", 0])
        # The mask must NOT become an output — see the module docstring.
        self.assertIn("preview_mask", graph)
        self.assertNotIn("save_mask", graph)
        self.assertEqual(graph["preview_mask"]["class_type"], "PreviewImage")

    def test_point_mode_splits_include_and_exclude_taps(self):
        graph = build_sam3_mask_prompt("shot.png", points=[
            {"x": 0.5, "y": 0.5},
            {"x": 0.1, "y": 0.9, "foreground": False},
        ])
        self.assertIn("sam3_positive_1", graph)
        self.assertIn("sam3_negative_1", graph)
        self.assertTrue(graph["sam3_positive_1"]["inputs"]["is_foreground"])
        self.assertFalse(graph["sam3_negative_1"]["inputs"]["is_foreground"])
        segment = graph["sam3_segment"]["inputs"]
        self.assertEqual(segment["positive_points"], ["sam3_positive_combine", 0])
        self.assertEqual(segment["negative_points"], ["sam3_negative_combine", 0])
        self.assertTrue(segment["output_best_mask"])
        self.assertEqual(graph["mask_image"]["inputs"]["mask"], ["sam3_segment", 0])

    def test_text_wins_over_taps_so_one_question_is_asked(self):
        graph = build_sam3_mask_prompt("shot.png", prompt="the dog", points=[{"x": 0.2, "y": 0.2}])
        self.assertIn("sam3_ground", graph)
        self.assertNotIn("sam3_segment", graph)

    def test_taps_are_clamped_and_bounded(self):
        points = normalize_points([{"x": -3, "y": 9}] + [{"x": 0.5, "y": 0.5}] * 40)
        self.assertEqual(len(points), 10, "a selection is not a scene graph")
        self.assertEqual((points[0]["x"], points[0]["y"]), (0.0, 1.0))
        self.assertTrue(points[0]["foreground"], "taps include by default")
        # Junk entries are dropped rather than crashing the graph.
        self.assertEqual(normalize_points([None, "x", {"x": "nope"}]), [])

    def test_a_request_that_says_nothing_is_refused(self):
        with self.assertRaises(ValueError):
            build_sam3_mask_prompt("shot.png")
        with self.assertRaises(ValueError):
            build_sam3_mask_prompt("", prompt="the jacket")
        # Only exclude-taps cannot describe a selection.
        with self.assertRaises(ValueError):
            build_sam3_mask_prompt("shot.png", points=[{"x": 0.5, "y": 0.5, "foreground": False}])


class SmartMaskRouteTest(unittest.TestCase):
    def test_route_stages_the_image_and_dispatches(self):
        app = load_app()
        completed = app.jobs.threading.Event()
        captured = {}

        def fake_run(job_id, image_path, options):
            captured.update(job_id=job_id, image_path=Path(image_path), options=options)
            completed.set()

        png = base64.b64encode(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
            )
        ).decode()
        with TemporaryDirectory() as td:
            out_dir = Path(td) / "out"
            out_dir.mkdir()
            server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
            thread = app.jobs.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app.config, "TOKEN", "test-token"), \
                 patch.object(app.config, "OUT_DIR", out_dir), \
                 patch.object(app.jobs, "jobs", {}), \
                 patch.object(app.runners, "run_sam3_smart_mask", side_effect=fake_run):
                thread.start()
                try:
                    request = app.net.Request(
                        f"http://127.0.0.1:{server.server_port}/api/smart-mask",
                        data=json.dumps({
                            "image_base64": "data:image/png;base64," + png,
                            "prompt": "the jacket",
                        }).encode("utf-8"),
                        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
                        method="POST",
                    )
                    with app.net.urlopen(request, timeout=5) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                        self.assertEqual(response.status, 202)
                    self.assertTrue(completed.wait(1))
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

        self.assertEqual(payload["backend"], "sam3-smart-mask")
        self.assertEqual(captured["options"]["prompt"], "the jacket")

    def test_route_refuses_a_request_with_neither_words_nor_taps(self):
        app = load_app()
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        with TemporaryDirectory() as td:
            server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
            thread = app.jobs.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app.config, "TOKEN", "test-token"), \
                 patch.object(app.config, "OUT_DIR", Path(td)), \
                 patch.object(app.jobs, "jobs", {}):
                thread.start()
                try:
                    request = app.net.Request(
                        f"http://127.0.0.1:{server.server_port}/api/smart-mask",
                        data=json.dumps({"image_base64": "data:image/png;base64," + png}).encode("utf-8"),
                        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
                        method="POST",
                    )
                    with self.assertRaises(app.http.HTTPError) as raised:
                        app.net.urlopen(request, timeout=5)
                    self.assertEqual(raised.exception.code, 400)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_the_mask_never_reaches_the_history_file(self):
        """The selection rides back in memory only. history.jsonl is on disk
        forever, so a base64 mask there would be exactly the plaintext record
        the temp-file handling exists to avoid."""
        app = load_app()
        written = []
        with TemporaryDirectory() as td:
            comfy_temp = Path(td) / "temp"
            # ComfyUI appends its OWN "temp" segment to the configured root, so
            # this is where a temp output really lands on this stack. Getting it
            # wrong reads as "the graph produced nothing" even though it ran.
            (comfy_temp / "temp").mkdir(parents=True, exist_ok=True)
            mask = comfy_temp / "temp" / "mask.png"
            mask.write_bytes(b"\x89PNG\r\n\x1a\nmaskbytes")
            history = {
                "pid": {
                    "status": {"status_str": "success", "completed": True},
                    "outputs": {"preview_mask": {"images": [{"filename": "mask.png", "subfolder": "", "type": "temp"}]}},
                }
            }

            class FakeResponse:
                def __init__(self, payload): self._payload = payload
                def read(self): return json.dumps(self._payload).encode()
                def __enter__(self): return self
                def __exit__(self, *a): return False

            def fake_urlopen(req, timeout=None):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                if url.endswith("/prompt"):
                    return FakeResponse({"prompt_id": "pid"})
                return FakeResponse(history)

            source = Path(td) / "src.png"
            source.write_bytes(b"image")
            with patch.object(app.runners, "COMFY_TEMP_DIR", comfy_temp), \
                 patch.object(app.config, "COMFY_INPUT_DIR", Path(td) / "input"), \
                 patch.object(app.jobs, "jobs", {}), \
                 patch.object(app.net, "urlopen", side_effect=fake_urlopen), \
                 patch.object(app.media, "time", app.media.time), \
                 patch.object(app.history, "append_history", side_effect=written.append):
                app.runners.run_sam3_smart_mask("job1", source, {"prompt": "the jacket"})
                record = app.jobs.jobs["job1"]
            mask_still_there = mask.exists()

        self.assertEqual(record["status"], "success", record.get("error"))
        self.assertTrue(record["mask_base64"].startswith("data:image/png;base64,"))
        self.assertEqual(len(written), 1)
        self.assertNotIn("mask_base64", written[0], "the mask must not be persisted")
        self.assertFalse(mask_still_there, "the temp mask is deleted after it is read")


if __name__ == "__main__":
    unittest.main()
