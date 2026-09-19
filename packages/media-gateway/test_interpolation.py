"""RIFE interpolation route + runner tests. The end-to-end test runs the REAL
vendored rife-mlx (Practical-RIFE 4.25, MLX) on a synthetic clip — proper RIFE,
not a filter — and verifies the 2x frame contract plus audio passthrough.
Requires ffmpeg + the repo venv with vendor/rife-mlx installed; weights come
from the HF cache (fetched on first use)."""

import base64
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from test_app import load_app


def ffprobe_streams(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,nb_frames,r_frame_rate", "-of", "json", str(path)],
        text=True, capture_output=True, timeout=30,
    )
    return json.loads(out.stdout or "{}").get("streams", [])


def make_test_clip(path, frames=10, fps=10):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "lavfi", "-i", f"testsrc2=size=192x128:rate={fps}:duration={frames / fps}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={frames / fps}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)],
        check=True, timeout=60,
    )


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
class InterpolationRouteTest(unittest.TestCase):
    def test_interpolate_route_stages_clip_and_dispatches(self):
        app = load_app()
        completed = app.jobs.threading.Event()
        captured = {}

        def fake_run(job_id, video_path, options):
            captured.update(job_id=job_id, video_path=Path(video_path), options=options,
                            video_bytes=Path(video_path).read_bytes())
            completed.set()

        with TemporaryDirectory() as td:
            out_dir = Path(td) / "out"
            out_dir.mkdir()
            server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
            server_thread = app.jobs.threading.Thread(target=server.serve_forever, daemon=True)
            with patch.object(app.config, "TOKEN", "test-token"), \
                 patch.object(app.config, "OUT_DIR", out_dir), \
                 patch.object(app.jobs, "jobs", {}), \
                 patch.object(app.runners, "run_video_interpolation", side_effect=fake_run):
                server_thread.start()
                try:
                    request = app.net.Request(
                        f"http://127.0.0.1:{server.server_port}/api/interpolate",
                        data=json.dumps({
                            "video_base64": "data:video/mp4;base64," + base64.b64encode(b"clipbytes").decode(),
                            "factor": 4,
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
                    server_thread.join(timeout=2)

        self.assertEqual(payload["backend"], "rife-interpolation")
        self.assertEqual(payload["mode"], "4x")
        self.assertEqual(captured["video_bytes"], b"clipbytes")
        self.assertEqual(captured["options"], {"factor": 4})
        self.assertEqual(captured["video_path"].parent, out_dir)

    def test_run_video_interpolation_real_rife_2x_with_audio(self):
        app = load_app()
        venv_python = Path(app.media.SUBPROCESS_PYTHON)
        if not venv_python.is_file():
            self.skipTest("repo venv python unavailable")
        probe = subprocess.run(
            [str(venv_python), "-c", "import rife_mlx"], capture_output=True, timeout=60,
        )
        if probe.returncode != 0:
            self.skipTest("vendor/rife-mlx not installed in the repo venv")

        with TemporaryDirectory() as td:
            out_dir = Path(td) / "comfy-out"
            out_dir.mkdir()
            clip = Path(td) / "in.mp4"
            make_test_clip(clip, frames=8, fps=8)
            with patch.object(app.config, "COMFY_OUTPUT_DIR", out_dir), \
                 patch.object(app.jobs, "jobs", {}), \
                 patch.object(app.media, "encrypt_outputs", side_effect=lambda paths, job_id=None: [str(p) for p in paths]), \
                 patch.object(app.history, "append_history", side_effect=lambda rec: None):
                app.runners.run_video_interpolation("testjob01", clip, {"factor": 2})
                rec = app.jobs.jobs["testjob01"]

            self.assertEqual(rec["status"], "success", rec.get("error"))
            output = Path(rec["outputs"][0])
            self.assertTrue(output.is_file())
            streams = {s["codec_type"]: s for s in ffprobe_streams(output)}
            self.assertIn("audio", streams, "audio must be remuxed through")
            video = streams["video"]
            # 8 source frames -> 15 (one interpolated between each pair), fps 2x.
            self.assertEqual(int(video["nb_frames"]), 15)
            self.assertEqual(video["r_frame_rate"], "16/1")
            # The staged input is consumed (deleted) by the runner.
            self.assertFalse(clip.exists())


if __name__ == "__main__":
    unittest.main()
