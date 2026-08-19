"""The requester key must survive every hop from the browser to the gateway.

A generation is sealed to whoever presented a key when it was submitted. The
studio sits in the middle of that submission — browser -> control_api ->
media_studio -> MCP sidecar -> gateway — and every hop that drops the key
silently re-attributes the media to the relaying process instead of the person
who asked for it. That failure is invisible at generation time: the job
succeeds, History lists it, and only later does the tile refuse to decrypt.

These tests pin the forwarding at each Python hop.
"""

from __future__ import annotations

import pytest

from hivemind_content_studio import media_studio
from hivemind_content_studio.canvas_history import CanvasGatewayClient

# A syntactically valid base64url SPKI (length is what the validator checks).
DEVICE_PUB = "D" * 392
OTHER_PUB = "O" * 392

HEADER = "X-E2E-Requester-Pub"


def _descriptor():
    return media_studio.MediaStudioDescriptor(
        app_id="test:media-studio",
        app_name="Media Studio",
        mcp_url="http://127.0.0.1:8796/mcp",
        upload_base="http://127.0.0.1:8787",
        auth_env_key=None,
        tool="media_generate_video",
        job_tool="media_get_job",
        workflow_id=None,
    )


@pytest.mark.parametrize(
    "value",
    ["", "   ", None, "short", "not/valid/base64url+chars", "x" * 4001],
)
def test_a_missing_or_malformed_key_is_dropped_rather_than_forwarded(value) -> None:
    # Junk must not travel: the gateway would reject it, and a rejected header
    # is indistinguishable from "seal to the owner" at the point it matters.
    assert media_studio.normalized_requester_pub(value) == ""
    assert media_studio._requester_headers(value) == {}


def test_a_valid_key_is_forwarded_verbatim() -> None:
    assert media_studio.normalized_requester_pub(f"  {DEVICE_PUB}  ") == DEVICE_PUB
    assert media_studio._requester_headers(DEVICE_PUB) == {HEADER: DEVICE_PUB}


def test_the_mcp_client_presents_the_callers_key_alongside_its_token(monkeypatch) -> None:
    monkeypatch.setattr(media_studio, "_token", lambda _descriptor: "gateway-token")
    captured: dict = {}

    class Client:
        def __init__(self, url, headers=None):
            captured.update(url=url, headers=dict(headers or {}))

    monkeypatch.setattr(media_studio, "McpHttpClient", Client)

    media_studio._client(_descriptor(), DEVICE_PUB)
    assert captured["headers"][HEADER] == DEVICE_PUB
    # The key is additive: auth still has to be there or the call is rejected.
    assert captured["headers"]["Authorization"] == "Bearer gateway-token"


def test_an_unkeyed_call_sends_no_requester_header_at_all(monkeypatch) -> None:
    # Absent means "I have no key of my own" — NOT "seal to an empty key". The
    # header has to be gone entirely so the far end falls back to the owner.
    monkeypatch.setattr(media_studio, "_token", lambda _descriptor: "gateway-token")
    captured: dict = {}

    class Client:
        def __init__(self, url, headers=None):
            captured.update(headers=dict(headers or {}))

    monkeypatch.setattr(media_studio, "McpHttpClient", Client)

    media_studio._client(_descriptor())
    assert HEADER not in captured["headers"]


def test_status_polls_present_the_same_key_the_job_was_started_with(monkeypatch) -> None:
    # The gateway scopes reads on a keyed job to its requester, so a poll that
    # forgets the key is answered as though the job did not exist.
    seen: list[str] = []

    class Client:
        def call_tool(self, *_args, **_kwargs):
            return None

    def fake_client(_descriptor, requester_pub=""):
        seen.append(requester_pub)
        return Client()

    monkeypatch.setattr(media_studio, "_required_descriptor", _descriptor)
    monkeypatch.setattr(media_studio, "_client", fake_client)
    monkeypatch.setattr(media_studio, "_result_json", lambda _call: {"ok": False, "status": 404})
    monkeypatch.setattr(
        media_studio, "_private_json",
        lambda _descriptor, _path, requester_pub="": seen.append(f"private:{requester_pub}") or {"status": "running"},
    )

    media_studio.check_video("job-1", requester_pub=DEVICE_PUB)
    assert seen[0] == DEVICE_PUB
    assert f"private:{DEVICE_PUB}" in seen


def test_cancel_presents_the_key_so_a_keyed_job_can_actually_be_stopped(monkeypatch) -> None:
    monkeypatch.setattr(media_studio, "discover_media_studio", lambda: _descriptor())
    monkeypatch.setattr(media_studio, "_token", lambda _descriptor: "gateway-token")
    captured: dict = {}

    class Response:
        status = 200

        def read(self):
            return b'{"interrupted": true}'

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def fake_urlopen(request, timeout=0):
        captured["headers"] = dict(request.headers)
        return Response()

    monkeypatch.setattr(media_studio.urllib.request, "urlopen", fake_urlopen)

    media_studio.cancel_video("job-1", requester_pub=DEVICE_PUB)
    # urllib title-cases header names on the way in.
    assert captured["headers"].get("X-e2e-requester-pub") == DEVICE_PUB


def test_canvas_media_reads_present_the_key_that_selects_the_envelope(monkeypatch, tmp_path) -> None:
    # Same URL, different envelope per key: without this header a device-sealed
    # output comes back in a form only the owner vault can open.
    token_file = tmp_path / "token"
    token_file.write_text("gateway-token-value", encoding="utf-8")
    client = CanvasGatewayClient(token_file=token_file, output_roots=[tmp_path], history_file=tmp_path / "h.jsonl")
    captured: dict = {}

    class Response:
        headers = type("H", (), {"get_content_type": staticmethod(lambda: "application/vnd.hivemind.e2e+json")})()

        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

    def fake_urlopen(request, timeout=0):
        captured["headers"] = dict(request.headers)
        return Response()

    monkeypatch.setattr("hivemind_content_studio.canvas_history.urllib.request.urlopen", fake_urlopen)

    client.media(str(tmp_path / "clip.mp4"), requester_pub=DEVICE_PUB)
    assert captured["headers"].get("X-e2e-requester-pub") == DEVICE_PUB

    client.media(str(tmp_path / "clip.mp4"))
    assert "X-e2e-requester-pub" not in captured["headers"]
