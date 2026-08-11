"""Storing a browser-joined chained episode as a first-class output.

The shots are E2E-sealed at rest, so only the client can read them and only the
client can join them — which left the finished episode as a blob URL in one
tab: gone on reload and invisible to History. These cover the route that takes
that joined file and files it exactly where a generated clip goes, so the
History view (which scans the output directory) picks it up on its own.
"""

import base64
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from test_app import load_app


class EpisodeRouteTest(unittest.TestCase):
    def test_route_stages_the_joined_clip_and_dispatches(self):
        app = load_app()
        completed = app.threading.Event()
        captured = {}

        def fake_run(job_id, video_path, options):
            captured.update(job_id=job_id, video_path=Path(video_path), options=options,
                            video_bytes=Path(video_path).read_bytes())
            completed.set()

        with TemporaryDirectory() as td:
            out_dir = Path(td) / "out"
            out_dir.mkdir()
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
            server_thread = app.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app, "TOKEN", "test-token"), \
                 patch.object(app, "OUT_DIR", out_dir), \
                 patch.object(app, "jobs", {}), \
                 patch.object(app, "run_episode_save", side_effect=fake_run):
                server_thread.start()
                try:
                    request = app.Request(
                        f"http://127.0.0.1:{server.server_port}/api/episode",
                        data=json.dumps({
                            "video_base64": "data:video/mp4;base64," + base64.b64encode(b"episodebytes").decode(),
                            "shots": 3,
                        }).encode("utf-8"),
                        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
                        method="POST",
                    )
                    with app.urlopen(request, timeout=5) as response:
                        payload = json.loads(response.read().decode("utf-8"))
                        self.assertEqual(response.status, 202)
                    self.assertTrue(completed.wait(1))
                finally:
                    server.shutdown()
                    server.server_close()
                    server_thread.join(timeout=2)

        self.assertEqual(payload["backend"], "episode-join")
        self.assertEqual(captured["video_bytes"], b"episodebytes")
        self.assertEqual(captured["options"], {"shots": 3})
        self.assertEqual(captured["video_path"].parent, out_dir)

    def test_route_rejects_a_request_with_no_clip(self):
        app = load_app()
        with TemporaryDirectory() as td:
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
            server_thread = app.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app, "TOKEN", "test-token"), \
                 patch.object(app, "OUT_DIR", Path(td)), \
                 patch.object(app, "jobs", {}):
                server_thread.start()
                try:
                    request = app.Request(
                        f"http://127.0.0.1:{server.server_port}/api/episode",
                        data=json.dumps({"shots": 2}).encode("utf-8"),
                        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"},
                        method="POST",
                    )
                    with self.assertRaises(app.HTTPError) as raised:
                        app.urlopen(request, timeout=5)
                    self.assertEqual(raised.exception.code, 400)
                finally:
                    server.shutdown()
                    server.server_close()
                    server_thread.join(timeout=2)

    def test_runner_files_the_episode_as_a_sealed_output(self):
        """It has to land in COMFY_OUTPUT_DIR and go through the normal sealing
        path — that directory is what the History view scans, and an unsealed
        clip sitting there would be plaintext at rest."""
        app = load_app()
        with TemporaryDirectory() as td:
            comfy_out = Path(td) / "comfy-out"
            comfy_out.mkdir()
            staged = Path(td) / "staged.mp4"
            staged.write_bytes(b"joined-episode-bytes")
            sealed = []

            def fake_encrypt(paths):
                # Stand in for the real seal: prove the runner hands it the
                # written output and records what comes back.
                for path in paths:
                    envelope = Path(f"{path}.e2e")
                    envelope.write_text("sealed")
                    Path(path).unlink()
                    sealed.append(str(envelope))
                return sealed

            with patch.object(app, "COMFY_OUTPUT_DIR", comfy_out), \
                 patch.object(app, "jobs", {}), \
                 patch.object(app, "encrypt_outputs", side_effect=fake_encrypt), \
                 patch.object(app, "append_history", lambda rec: None):
                app.run_episode_save("job123", staged, {"shots": 3})
                record = app.jobs["job123"]

        self.assertEqual(record["status"], "success")
        self.assertEqual(record["backend"], "episode-join")
        self.assertEqual(len(record["outputs"]), 1)
        self.assertTrue(record["outputs"][0].endswith("episode_job123.mp4.e2e"))
        # The staged plaintext copy is moved, never left behind for the sweeper.
        self.assertFalse(staged.exists())

    def test_runner_reports_a_missing_clip_instead_of_filing_an_empty_output(self):
        app = load_app()
        with TemporaryDirectory() as td:
            comfy_out = Path(td) / "comfy-out"
            comfy_out.mkdir()
            with patch.object(app, "COMFY_OUTPUT_DIR", comfy_out), \
                 patch.object(app, "jobs", {}), \
                 patch.object(app, "append_history", lambda rec: None):
                app.run_episode_save("job404", Path(td) / "gone.mp4", {"shots": 2})
                record = app.jobs["job404"]
            # Read the directory while the temp tree still exists.
            leftovers = list(comfy_out.iterdir())

        self.assertEqual(record["status"], "error")
        self.assertIn("missing", record["error"])
        self.assertEqual(leftovers, [], "a failed save leaves no half-written output")


if __name__ == "__main__":
    unittest.main()
