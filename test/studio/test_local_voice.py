from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from hivemind_content_studio.local_voice import generate_local_voice_lines, list_local_voices
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan


def test_local_tts_discovers_voices_and_generates_manifest_recorded_lines(tmp_path: Path, monkeypatch) -> None:
    requests: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            payload = {"object": "list", "data": [{"id": "narrator", "name": "Narrator"}]}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode())

        def do_POST(self) -> None:  # noqa: N802
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.end_headers()
            self.wfile.write(b"RIFF" + b"audio" * 20)

        def log_message(self, _format: str, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("UNIVERSAL_TTS_URL", f"http://127.0.0.1:{server.server_port}")
        monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
        brief = tmp_path / "brief.yaml"
        brief.write_text("id: local-voice\nlane: stickman-performance-ad\nvoice:\n  provider: universal-tts\n  model_id: local-model\n  voice_id: narrator\nscenes:\n  - beat: Hook\n    voice: Exact local line.\n", encoding="utf-8")
        manifest_path = plan(brief)

        voices = list_local_voices()
        result = generate_local_voice_lines(manifest_path)
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert voices[0]["id"] == "narrator"
    assert requests[0]["input"] == "Exact local line."
    assert requests[0]["voice"] == "narrator"
    assert len(result["audio_files"]) == 1
    assert any(item["role"] == "voice-line" and item["provider"] == "universal-tts" for item in load_manifest(manifest_path)["artifacts"])
