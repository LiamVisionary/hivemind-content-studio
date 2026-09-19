"""One half of a clip: its sound, or its picture.

`POST /api/media/track` is the remux behind two rows of the Video stage's
download menu. What is pinned here:

  * `audio` is a real 16-bit WAV of the clip's soundtrack, and `silent` is the
    clip with its VIDEO STREAM COPIED — the bytes of the picture are the ones
    that were generated, not a re-encode of them;
  * a clip with no sound is an answer about the file (422, a sentence), not a
    failure of the route;
  * the route is owner-gated, and the decrypted clip does not outlive the
    request — and is never on disk under the name the person gave it.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import media_tracks
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "owner-passphrase"
ROUTE = "/api/media/track"

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is what this route drives")


@pytest.fixture()
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
    )
    return TestClient(app)


def _sign_in(client: TestClient) -> None:
    response = client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD})
    assert response.status_code == 200, response.text


def _clip(tmp_path: Path, *, sound: bool) -> bytes:
    target = tmp_path / ("clip.mp4" if sound else "mute.mp4")
    command = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=12:duration=1"]
    if sound:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-shortest"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(target)]
    subprocess.run(command, check=True)
    return target.read_bytes()


def _post(client: TestClient, data: bytes, mode: str, *, name="my private title.mp4"):
    return client.post(ROUTE, files={"file": (name, data, "video/mp4")}, data={"mode": mode})


def _streams(path: Path) -> str:
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)], capture_output=True, check=False)
    return probe.stderr.decode("utf-8", errors="replace")


def _video_packets_md5(path: Path) -> str:
    # The hash of the video PACKETS as stored — equal only if the stream was
    # copied. A re-encode of identical-looking frames hashes differently.
    result = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path), "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"],
        capture_output=True, check=True,
    )
    return result.stdout.decode().strip()


def test_sound_only_is_a_real_wav_of_the_soundtrack(client: TestClient, tmp_path: Path) -> None:
    _sign_in(client)
    response = _post(client, _clip(tmp_path, sound=True), "audio")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["x-track-extension"] == ".wav"
    assert response.headers["cache-control"] == "no-store"
    out = tmp_path / "out.wav"
    out.write_bytes(response.content)
    with wave.open(str(out)) as handle:
        assert handle.getsampwidth() == 2
        assert 0.9 < handle.getnframes() / handle.getframerate() < 1.2


def test_video_without_sound_copies_the_picture_and_drops_the_audio(client: TestClient, tmp_path: Path) -> None:
    _sign_in(client)
    clip = _clip(tmp_path, sound=True)
    response = _post(client, clip, "silent")
    assert response.status_code == 200, response.text
    assert response.headers["x-track-extension"] == ".mp4"
    out = tmp_path / "out.mp4"
    out.write_bytes(response.content)
    streams = _streams(out)
    assert "Video:" in streams and "Audio:" not in streams
    assert _video_packets_md5(out) == _video_packets_md5(tmp_path / "clip.mp4"), "the picture was re-encoded"


def test_a_clip_with_no_sound_is_an_answer_not_a_failure(client: TestClient, tmp_path: Path) -> None:
    _sign_in(client)
    response = _post(client, _clip(tmp_path, sound=False), "audio")
    assert response.status_code == 422
    assert response.json()["detail"] == "This clip has no sound."


def test_bad_requests_are_refused(client: TestClient, tmp_path: Path) -> None:
    _sign_in(client)
    assert _post(client, b"", "audio").status_code == 400
    assert _post(client, b"x", "everything").status_code == 400
    # Bytes that are not a clip at all: a sentence, not a traceback.
    broken = _post(client, b"not a video", "silent")
    assert broken.status_code == 422
    assert "could not be taken apart" in broken.json()["detail"]


def test_the_route_is_owner_gated(client: TestClient, tmp_path: Path) -> None:
    response = _post(client, _clip(tmp_path, sound=True), "audio")
    assert response.status_code in (401, 403), response.text


def test_no_plaintext_is_left_behind_or_named(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    seen: list[str] = []
    names: list[str] = []
    real_tempdir = __import__("tempfile").TemporaryDirectory
    real_extract = media_tracks.extract

    class _Watched(real_tempdir):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            seen.append(self.name)

    def _spy(source, mode):
        names.extend(path.name for path in Path(source).parent.iterdir())
        return real_extract(source, mode)

    monkeypatch.setattr("tempfile.TemporaryDirectory", _Watched)
    monkeypatch.setattr(media_tracks, "extract", _spy)
    _sign_in(client)
    response = _post(client, _clip(tmp_path, sound=True), "audio")

    assert response.status_code == 200
    assert seen, "the remux must work in a temporary directory it owns"
    for path in seen:
        assert not Path(path).exists(), f"{path} outlived the request"
    # The upload's name is somebody's title; nothing about a remux needs it on disk.
    assert names == ["source.mp4"]
