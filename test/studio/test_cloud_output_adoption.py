"""A finished cloud result is kept the way a local render is kept.

MUAPI renders in its own cloud and hands back a CDN link that expires within
the day. Until the adopt route existed, a lip sync, a Cinema shot and every
cloud image lived in one browser tab and nowhere else — close the window and
minutes of paid work were gone, with nothing on screen having said so. These
tests pin the whole round trip through the same HTTP doors the studio uses:
adopt the link, find the output in this workspace's History, and read the bytes
back out of it.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app, cloud_output_suffix
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "test-owner-password"
_CIPHER_SECRET = b"test-private-state-secret"

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"0" * 64
CLIP_BYTES = b"\x00\x00\x00\x18ftypmp42" + b"1" * 64


def _client(tmp_path: Path, monkeypatch, **overrides) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    orchestrator = ContentOrchestrator(RunStore(tmp_path / "state.sqlite3"))
    approvals = ApprovalLedger(tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret")
    cipher = PrivateFieldCipher.from_secret(_CIPHER_SECRET)
    app = build_control_app(
        orchestrator=orchestrator,
        approvals=approvals,
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
        # The gateway is not running in a test, and its output roots are
        # machine-wide: an empty listing is what "nothing else on this machine"
        # looks like, so every row below is one this route wrote.
        canvas_history_fetcher=lambda: [],
        **overrides,
    )
    client = TestClient(app)
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 200
    return client


def test_an_adopted_cloud_result_is_sealed_and_listed_in_this_workspace_history(tmp_path: Path, monkeypatch) -> None:
    fetched: list[str] = []

    def fetch(url: str) -> tuple[bytes, str]:
        fetched.append(url)
        return PNG_BYTES, "image/png"

    client = _client(tmp_path, monkeypatch, cloud_output_fetcher=fetch)
    adopted = client.post(
        "/api/media-studio/adopt",
        json={"url": "https://cdn.example.test/results/abc.png", "kind": "image", "model": "flux-1"},
    )
    assert adopted.status_code == 200, adopted.text
    payload = adopted.json()
    assert fetched == ["https://cdn.example.test/results/abc.png"]
    assert payload["url"] == f"/api/media-studio/generated/{payload['output']}"
    assert payload["output"].endswith(".png")
    assert payload["encrypted_at_rest"] is True

    # Sealed, not written in the clear: the plaintext file is gone and only the
    # cipher's sidecar is left behind.
    outputs = tmp_path / "accounts" / "1" / "generated" / "media-studio"
    assert not (outputs / payload["output"]).is_file()
    assert list(outputs.glob(f"{payload['output']}.*")), "the sealed form should be on disk"

    # The Library lists it without the gateway knowing anything about it.
    listing = client.get("/api/canvas/history").json()["history"]
    assert [row["output_basename"] for row in listing] == [payload["output"]]
    row = listing[0]
    assert row["media_type"] == "image/png"
    assert row["encrypted_at_rest"] is True

    # And both doors hand back the same bytes the provider produced.
    assert client.get(row["media_url"]).content == PNG_BYTES
    assert client.get(payload["url"]).content == PNG_BYTES


def test_an_adopted_result_can_be_deleted_from_history(tmp_path: Path, monkeypatch) -> None:
    """The gateway never held this file, so asking IT to delete one answered 503
    and left the output on disk with its row cleared."""
    client = _client(tmp_path, monkeypatch, cloud_output_fetcher=lambda url: (CLIP_BYTES, "video/mp4"))
    adopted = client.post(
        "/api/media-studio/adopt",
        json={"url": "https://cdn.example.test/results/clip", "kind": "video"},
    ).json()
    assert adopted["output"].endswith(".mp4")

    history_id = client.get("/api/canvas/history").json()["history"][0]["history_id"]
    gone = client.request("DELETE", f"/api/canvas/history/{history_id}", json={"confirm": True})
    assert gone.status_code == 200, gone.text
    assert gone.json()["deleted_files"] >= 1
    assert client.get("/api/canvas/history?refresh=1").json()["history"] == []
    outputs = tmp_path / "accounts" / "1" / "generated" / "media-studio"
    assert not list(outputs.glob(f"{adopted['output']}*"))


def test_an_address_this_machine_cannot_fetch_is_a_refusal_the_owner_can_read(tmp_path: Path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch, cloud_output_fetcher=lambda url: (PNG_BYTES, "image/png"))
    refused = client.post("/api/media-studio/adopt", json={"url": "file:///etc/passwd", "kind": "image"})
    assert refused.status_code == 400
    assert "fetch" in refused.json()["detail"]
    assert client.get("/api/canvas/history").json()["history"] == []


def test_a_provider_that_does_not_answer_never_leaves_a_half_output(tmp_path: Path, monkeypatch) -> None:
    def fetch(url: str) -> tuple[bytes, str]:
        raise RuntimeError("The provider's result could not be downloaded.")

    client = _client(tmp_path, monkeypatch, cloud_output_fetcher=fetch)
    failed = client.post("/api/media-studio/adopt", json={"url": "https://cdn.example.test/x.png"})
    assert failed.status_code == 502
    assert client.get("/api/canvas/history").json()["history"] == []
    assert not list((tmp_path / "accounts" / "1" / "generated" / "media-studio").glob("cloud-*"))


def test_the_stored_extension_follows_the_kind_and_never_the_provider_query_string() -> None:
    assert cloud_output_suffix("https://x.test/a/b.png?token=1", "image/png", "image") == ".png"
    assert cloud_output_suffix("https://x.test/a/b", "image/jpeg", "image") == ".jpg"
    # A video URL wearing an image extension is still a video: the kind decides
    # which suffixes are even possible, so History lists a player, not a broken
    # image row.
    assert cloud_output_suffix("https://x.test/a/b.png", "video/mp4", "video") == ".mp4"
    assert cloud_output_suffix("https://x.test/a/b", "", "video") == ".mp4"
