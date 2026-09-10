"""Saving an output with its generation settings written into the file.

Everything this studio keeps is sealed and the local lane runs ComfyUI with
--disable-metadata, so a downloaded picture is exactly its pixels: the prompt,
the seed and the model live encrypted in the owner's vault, beside the output
rather than inside it. This route is the deliberate exception, asked for one
file at a time from the download menu behind a switch that has to be turned on
first.

Three things are load-bearing and each has a test here:

  * it is OWNER-GATED. Unlike the Civitai staging route — which is ungated on
    purpose, because Civitai's composer fetches it cross-origin with no cookie —
    this one answers only the signed-in owner. Nothing else needs to reach it.
  * it never holds plaintext. The stamper needs a path (ffmpeg remuxes), so the
    bytes touch a temporary directory; that directory must be gone by the time
    the response is sent.
  * it reports honestly. A stamp that could not be written (no Pillow, no
    ffmpeg, a container that will not carry tags) still returns the file, with
    X-Settings-Embedded: 0, so the studio can say the recipe did not travel
    instead of implying it did.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "owner-passphrase"
ROUTE = "/api/media/stamp-settings"


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


def png_bytes(size=(64, 48)) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", size, (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def _post(client: TestClient, data: bytes, meta: dict, *, name="shot.png", content_type="image/png"):
    return client.post(
        ROUTE,
        files={"file": (name, data, content_type)},
        data={"meta": json.dumps(meta)},
    )


def test_the_settings_land_inside_the_returned_png(client: TestClient) -> None:
    from PIL import Image

    _sign_in(client)
    response = _post(
        client,
        png_bytes(),
        {
            "prompt": "a heron at dawn",
            "negativePrompt": "blurry",
            "seed": 12345,
            "steps": 28,
            "cfgScale": 4.5,
            "sampler": "er_sde",
            "scheduler": "beta",
            "model": "krea2",
        },
    )

    assert response.status_code == 200, response.text
    assert response.headers["X-Settings-Embedded"] == "1"
    assert response.headers["Cache-Control"] == "no-store"

    stamped = Image.open(io.BytesIO(response.content))
    parameters = stamped.info["parameters"]
    # A1111's shape, which is what Civitai, ComfyUI and every metadata viewer
    # actually parse — not a private format only this studio can read.
    assert parameters.splitlines()[0] == "a heron at dawn"
    assert "Negative prompt: blurry" in parameters
    assert "Seed: 12345" in parameters
    assert "Steps: 28" in parameters
    assert "Schedule type: beta" in parameters


def test_the_pixels_are_not_touched(client: TestClient) -> None:
    from PIL import Image

    _sign_in(client)
    original = png_bytes(size=(64, 48))
    response = _post(client, original, {"prompt": "a heron"})

    assert response.status_code == 200
    before = Image.open(io.BytesIO(original))
    after = Image.open(io.BytesIO(response.content))
    assert after.size == before.size
    assert list(after.convert("RGB").getdata()) == list(before.convert("RGB").getdata())


def test_nothing_to_stamp_returns_the_file_and_says_so(client: TestClient) -> None:
    _sign_in(client)
    # No prompt and no settings: there is no parameters block to write. The
    # person still asked to save their file, so they get it — with the header
    # saying the recipe did not travel.
    original = png_bytes()
    response = _post(client, original, {})

    assert response.status_code == 200
    assert response.headers["X-Settings-Embedded"] == "0"
    assert response.content == original


def test_an_unstampable_container_still_returns_the_file(client: TestClient) -> None:
    _sign_in(client)
    # Not an image Pillow can open and not a video ffmpeg is asked about: the
    # stamp fails, the bytes come back unchanged rather than the save failing.
    original = b"not really a picture"
    response = _post(client, original, {"prompt": "p"}, name="shot.bin", content_type="application/octet-stream")

    assert response.status_code == 200
    assert response.headers["X-Settings-Embedded"] == "0"
    assert response.content == original


def test_an_empty_file_is_refused(client: TestClient) -> None:
    _sign_in(client)
    response = _post(client, b"", {"prompt": "p"})
    assert response.status_code == 400


def test_meta_that_is_not_an_object_is_ignored_rather_than_fatal(client: TestClient) -> None:
    _sign_in(client)
    original = png_bytes()
    response = client.post(
        ROUTE,
        files={"file": ("shot.png", original, "image/png")},
        data={"meta": "[1, 2, 3]"},
    )
    assert response.status_code == 200
    assert response.headers["X-Settings-Embedded"] == "0"


def test_the_route_is_owner_gated(client: TestClient) -> None:
    # The Civitai staging route is ungated because Civitai's composer has to
    # fetch it cross-origin with no cookie. This one has no such reason, and a
    # route that stamps a prompt into a file must not answer a stranger.
    response = _post(client, png_bytes(), {"prompt": "a heron"})
    assert response.status_code in (401, 403), response.text


def test_no_plaintext_is_left_behind(client: TestClient, tmp_path: Path, monkeypatch) -> None:
    seen: list[str] = []
    real_tempdir = __import__("tempfile").TemporaryDirectory

    class _Watched(real_tempdir):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            seen.append(self.name)

    monkeypatch.setattr("tempfile.TemporaryDirectory", _Watched)
    _sign_in(client)
    response = _post(client, png_bytes(), {"prompt": "a heron at dawn"})

    assert response.status_code == 200
    assert seen, "the stamper must work in a temporary directory it owns"
    # The whole point: the decrypted bytes live for the length of the stamp and
    # not one moment past the response.
    for path in seen:
        assert not Path(path).exists(), f"{path} outlived the request"
