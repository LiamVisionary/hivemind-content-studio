from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.voice import generate_elevenlabs_lines


def test_elevenlabs_generates_exact_scene_lines_and_records_artifacts(tmp_path: Path, monkeypatch) -> None:
    requests: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append(json.loads(body))
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            self.wfile.write(b"ID3" + b"voice" * 20)

        def log_message(self, _format: str, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        monkeypatch.setenv("ELEVENLABS_API_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
        brief = tmp_path / "brief.yaml"
        brief.write_text(
            """id: exact-lines
lane: stickman-performance-ad
voice:
  provider: elevenlabs
  voice_id: voice-123
  delivery: dry and direct
scenes:
  - beat: First scene
    voice: Exact first line.
  - beat: Second scene
    voice: Exact second line.
""",
            encoding="utf-8",
        )
        manifest_path = plan(brief)

        result = generate_elevenlabs_lines(manifest_path, confirm="PAID_GENERATE")
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert [request["text"] for request in requests] == ["Exact first line.", "Exact second line."]
    assert all(request["model_id"] == "eleven_v3" for request in requests)
    assert len(result["audio_files"]) == 2
    manifest = load_manifest(manifest_path)
    assert len([item for item in manifest["artifacts"] if item["role"] == "voice-line"]) == 2
