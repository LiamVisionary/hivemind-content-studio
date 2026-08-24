"""The account gate over HTTP, and the isolation claim end to end.

test_account_scope.py proves two stores cannot see each other. This file proves
the same thing through the API a browser actually calls — signing in as one
workspace, writing something, signing in as another, and finding nothing. That
distinction matters: the stores could be perfectly separated and a route could
still resolve the wrong one.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio.accounts import ACCOUNT_COOKIE, AccountStore
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

OWNER_PASSWORD = "owner-passphrase"


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


def _sign_in(client: TestClient, account_id: int, password: str) -> None:
    response = client.post("/api/accounts/unlock", json={"account_id": account_id, "password": password})
    assert response.status_code == 200, response.text


def _add_workspace(client: TestClient, name: str, password: str) -> int:
    _sign_in(client, 1, OWNER_PASSWORD)
    created = client.post("/api/accounts", json={"name": name, "password": password})
    assert created.status_code == 201, created.text
    client.post("/api/accounts/sign-out")
    return int(created.json()["account"]["id"])


# ── the gate ─────────────────────────────────────────────────────────────────

def test_the_picker_is_reachable_before_sign_in_and_leaks_nothing(client):
    response = client.get("/api/accounts")
    assert response.status_code == 200
    payload = response.json()
    assert payload["signed_in_as"] is None
    assert [account["name"] for account in payload["accounts"]] == ["Owner"]
    owner = payload["accounts"][0]
    assert owner["has_password"] is True and owner["has_passkey"] is False
    # Nothing an attacker can take away and grind on.
    body = json.dumps(payload)
    assert "scrypt" not in body and "password_hash" not in body and "salt" not in body


def test_everything_else_is_refused_until_a_workspace_is_open(client):
    assert client.get("/api/studio-state/opengen-composer").status_code == 401
    assert client.get("/api/media-studio/references").status_code == 401
    gate = client.get("/", headers={"accept": "text/html"})
    assert gate.status_code == 200 and "Who's working?" in gate.text


def test_sign_in_and_out_moves_the_gate(client):
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.get("/api/accounts").json()["signed_in_as"] == 1
    assert client.get("/api/studio-state/opengen-composer").status_code == 200
    assert client.post("/api/accounts/sign-out").status_code == 200
    assert client.get("/api/studio-state/opengen-composer").status_code == 401


def test_a_wrong_password_says_nothing_useful_and_is_throttled(client):
    for _ in range(5):
        refused = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "nope"})
        assert refused.status_code == 401
        assert refused.json()["detail"] == "Wrong password"
    blocked = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "nope"})
    assert blocked.status_code == 429
    assert "Retry-After" in blocked.headers
    # Even the CORRECT password is refused while the block stands, or the
    # throttle would be a speed bump rather than a lockout.
    assert client.post("/api/accounts/unlock",
                       json={"account_id": 1, "password": OWNER_PASSWORD}).status_code == 429


def test_a_missing_workspace_is_indistinguishable_from_a_bad_password(client):
    absent = client.post("/api/accounts/unlock", json={"account_id": 9999, "password": "whatever"})
    wrong = client.post("/api/accounts/unlock", json={"account_id": 1, "password": "whatever"})
    assert absent.status_code == wrong.status_code == 401
    assert absent.json()["detail"] == wrong.json()["detail"]


def test_a_forged_cookie_does_not_open_a_workspace(client):
    client.cookies.set(ACCOUNT_COOKIE, "1.99999999999.nonce.deadbeef")
    assert client.get("/api/studio-state/opengen-composer").status_code == 401


# ── managing workspaces ──────────────────────────────────────────────────────

def test_the_gate_offers_a_new_workspace_card(client):
    gate = client.get("/", headers={"accept": "text/html"})
    assert gate.status_code == 200
    assert "New workspace" in gate.text
    assert 'id="create-form"' in gate.text
    # Both approval paths are in the page: the owner-passkey button (shown only
    # when the owner has a passkey) and the owner-password fallback.
    assert 'id="create-passkey"' in gate.text
    assert 'id="create-owner-password"' in gate.text


def test_the_gates_create_flow_lands_in_the_new_workspace(client):
    # The exact sequence the gate's create card performs: owner approval sets
    # the session the create route checks, then unlocking the NEW workspace
    # switches the session so the reload lands inside it.
    _sign_in(client, 1, OWNER_PASSWORD)
    created = client.post("/api/accounts", json={"name": "Editor", "password": "editor-pass"})
    assert created.status_code == 201, created.text
    new_id = int(created.json()["account"]["id"])
    _sign_in(client, new_id, "editor-pass")
    assert client.get("/api/accounts").json()["signed_in_as"] == new_id


def test_only_the_owner_can_add_a_workspace(client):
    assert client.post("/api/accounts", json={"name": "Sneaky", "password": "x"}).status_code == 403

    second = _add_workspace(client, "Second", "second-pass")
    assert second == 2
    _sign_in(client, second, "second-pass")
    refused = client.post("/api/accounts", json={"name": "Third", "password": "x"})
    assert refused.status_code == 403


def test_the_owner_workspace_cannot_be_deleted(client):
    _sign_in(client, 1, OWNER_PASSWORD)
    refused = client.delete("/api/accounts/1")
    assert refused.status_code == 400
    assert "owner workspace cannot be deleted" in refused.json()["detail"]


def test_a_workspace_cannot_delete_a_sibling(client):
    second = _add_workspace(client, "Second", "second-pass")
    third = _add_workspace(client, "Third", "third-pass")
    _sign_in(client, second, "second-pass")
    assert client.delete(f"/api/accounts/{third}").status_code == 403
    # ...but may delete itself, and the owner may delete anyone.
    assert client.delete(f"/api/accounts/{second}").status_code == 200
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.delete(f"/api/accounts/{third}").status_code == 200
    assert [account["id"] for account in client.get("/api/accounts").json()["accounts"]] == [1]


def test_deleting_a_workspace_destroys_its_data(client, tmp_path):
    second = _add_workspace(client, "Second", "second-pass")
    _sign_in(client, second, "second-pass")
    client.put("/api/studio-state/opengen-composer", json={"state": {"prompt": "theirs"}})
    root = tmp_path / "accounts" / str(second)
    assert root.is_dir()
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.delete(f"/api/accounts/{second}").status_code == 200
    assert not root.exists()


# ── the isolation claim, over HTTP ───────────────────────────────────────────

def test_one_workspace_cannot_read_anothers_composer(client):
    second = _add_workspace(client, "Second", "second-pass")

    _sign_in(client, 1, OWNER_PASSWORD)
    client.put("/api/studio-state/opengen-composer", json={"state": {"prompt": "owner's private draft"}})
    assert client.get("/api/studio-state/opengen-composer").json()["state"]["prompt"] == "owner's private draft"

    client.post("/api/accounts/sign-out")
    _sign_in(client, second, "second-pass")
    response = client.get("/api/studio-state/opengen-composer")
    assert response.status_code == 200
    assert response.json()["state"] == {}
    assert "owner's private draft" not in response.text


def test_one_workspace_cannot_list_anothers_references(client):
    second = _add_workspace(client, "Second", "second-pass")
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64

    _sign_in(client, 1, OWNER_PASSWORD)
    uploaded = client.post(
        "/api/media-studio/references",
        files={"file": ("owner-secret.png", png, "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    owner_reference = uploaded.json()["url"]
    assert len(client.get("/api/media-studio/references").json()["references"]) == 1

    client.post("/api/accounts/sign-out")
    _sign_in(client, second, "second-pass")
    assert client.get("/api/media-studio/references").json()["references"] == []
    # Naming the other workspace's file directly does not fetch it either: the
    # path is resolved under THIS account's root, where it does not exist.
    assert client.get(owner_reference).status_code in {403, 404}


def test_each_workspace_has_its_own_vault_identity_over_http(client):
    second = _add_workspace(client, "Second", "second-pass")
    identity = {
        "salt": "s", "wrapped_mk_pass": "a", "wrapped_mk_recovery": "b",
        "public_key": "owner-public-key", "wrapped_private_key": "d",
    }
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.put("/api/vault/identity", json={"identity": identity}).status_code in {200, 201}
    assert client.get("/api/vault/identity").json()["identity"]["public_key"] == "owner-public-key"

    client.post("/api/accounts/sign-out")
    _sign_in(client, second, "second-pass")
    # A fresh workspace has NO vault, so its browser is asked to create one
    # rather than being handed the owner's.
    assert client.get("/api/vault/identity").json()["identity"] is None


def test_one_workspace_cannot_enumerate_anothers_runs(client):
    second = _add_workspace(client, "Second", "second-pass")
    _sign_in(client, 1, OWNER_PASSWORD)
    owner_run = client.post("/api/runs", json={
        "lane": "static-text-ad", "title": "Owner ad",
        "concept": "Owner's private concept.", "scenes": [{"overlay": "Owner"}],
    }).json()["run_id"]

    client.post("/api/accounts/sign-out")
    _sign_in(client, second, "second-pass")
    # The listing enumerates only this workspace's runs…
    assert client.get("/api/runs").json()["runs"] == []
    # …and the owner's run is INDISTINGUISHABLE from one that never existed.
    hidden = client.get(f"/api/runs/{owner_run}")
    absent = client.get(f"/api/runs/{owner_run}x")
    assert hidden.status_code == absent.status_code == 404
    assert hidden.json()["detail"].replace(f"{owner_run}", "") == absent.json()["detail"].replace(f"{owner_run}x", "")
    assert client.get(f"/api/runs/{owner_run}/artifacts/anything").status_code == 404
    assert client.post(f"/api/runs/{owner_run}/cancel", json={"reason": "not mine"}).status_code == 404

    # Its own runs appear normally — and stay invisible to the owner in turn.
    mine = client.post("/api/runs", json={
        "lane": "static-text-ad", "title": "Second ad",
        "concept": "Second's concept.", "scenes": [{"overlay": "Second"}],
    }).json()["run_id"]
    assert [run["run_id"] for run in client.get("/api/runs").json()["runs"]] == [mine]

    client.post("/api/accounts/sign-out")
    _sign_in(client, 1, OWNER_PASSWORD)
    owner_listed = [run["run_id"] for run in client.get("/api/runs").json()["runs"]]
    assert owner_run in owner_listed and mine not in owner_listed
    assert client.get(f"/api/runs/{mine}").status_code == 404


def test_canvas_history_shows_each_workspace_only_its_own_gateway_outputs(client, tmp_path, monkeypatch):
    """The canvas index reads MACHINE-wide sources (the gateway's output roots
    and job log), where every workspace's video-studio clips land side by side.
    The studio claims each gateway job it starts and each output it finishes
    for the workspace that asked, and every History lists only what its scope
    may see: a sibling its own clips, the owner everything unclaimed — and
    neither the other's. (2026-08-22: a second workspace generated a video,
    saw it in the studio, and found History empty — the whole gateway surface
    was owner-only.)"""
    def piece(name: str) -> str:
        path = tmp_path / name
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        return str(path)

    records = [{
        "id": "job-1", "status": "success",
        "created_at": "2026-08-21T00:00:00+00:00", "finished_at": "2026-08-21T00:00:00+00:00",
        "outputs": [piece("canvas-piece.png")],
    }]
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_start",
        lambda **_: {"job_id": "job-sib-1", "uploaded_names": [], "provider": "Media Studio"},
    )
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_check",
        lambda job_id, **_: {"status": "completed", "failed": False, "error": "",
                             "video_url": "http://gateway/image/sibling-clip.mp4", "progress": 1.0},
    )
    # The gateway names the sealed form; claims and listings meet on the logical name.
    monkeypatch.setattr(
        "hivemind_content_studio.control_api.run_media_studio_video_finish",
        lambda job_id, **_: {"job_id": job_id, "provider": "Media Studio", "gateway_output": "sibling-clip.mp4.e2e"},
    )
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    canvas_client = TestClient(build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password=OWNER_PASSWORD, cipher=cipher),
        private_cipher=cipher,
        canvas_history_fetcher=lambda: [dict(record) for record in records],
        canvas_media_fetcher=lambda name, requester_pub="": (b"sealed:" + Path(name).name.encode(), "application/vnd.hivemind.e2e+json"),
    ))

    def basenames(view: dict) -> list[str]:
        return sorted(item["output_basename"] for item in view["history"])

    _sign_in(canvas_client, 1, OWNER_PASSWORD)
    owner_view = canvas_client.get("/api/canvas/history").json()
    assert basenames(owner_view) == ["canvas-piece.png"]
    owner_item = owner_view["history"][0]["history_id"]
    created = canvas_client.post("/api/accounts", json={"name": "Second", "password": "second-pass"})
    assert created.status_code == 201, created.text
    second = int(created.json()["account"]["id"])

    # The sibling's clip lands at the gateway (a file record, id unrelated to
    # the job) BEFORE the studio has finished the job — the owner's History,
    # polling meanwhile, adopts it as unclaimed.
    records.append({"id": "file-deadbeef", "status": "success", "created_at": "2026-08-22T00:28:00+00:00",
                    "finished_at": "2026-08-22T00:28:00+00:00", "outputs": [piece("sibling-clip.mp4")]})
    # A page-1 listing re-indexes the gateway at most every few seconds per
    # workspace (the History poll used to walk both output roots every tick);
    # ?refresh=1 is the explicit re-index, and what this step needs — the
    # owner's previous listing was milliseconds ago.
    assert basenames(canvas_client.get("/api/canvas/history?refresh=1").json()) == ["canvas-piece.png", "sibling-clip.mp4"]

    canvas_client.post("/api/accounts/sign-out")
    _sign_in(canvas_client, second, "second-pass")
    # Nothing is the sibling's yet: not the owner's piece, not an unclaimed clip.
    assert canvas_client.get("/api/canvas/history").json()["history"] == []

    # The sibling generates a video through the real start/poll path: start
    # claims the job id, finishing it claims the output name.
    queued = canvas_client.post("/api/media-studio/video/start",
                                json={"prompt": "a clip of my own", "workflow_id": "ltx23-eros-fast", "duration_seconds": 2})
    assert queued.status_code == 200, queued.text
    assert queued.json()["job_id"] == "job-sib-1"
    done = canvas_client.get("/api/media-studio/video/job/job-sib-1").json()
    assert done.get("ok") is True and done["output"] == "sibling-clip.mp4.e2e", done
    # A local-lane record the studio never finished (restart mid-run) is still
    # found by the job id the gateway's workflow index lists it under.
    records.append({"id": "job-sib-1", "status": "success", "created_at": "2026-08-22T00:30:00+00:00",
                    "finished_at": "2026-08-22T00:30:00+00:00", "outputs": [piece("sibling-local.mp4")]})

    second_view = canvas_client.get("/api/canvas/history?refresh=1").json()
    assert basenames(second_view) == ["sibling-clip.mp4", "sibling-local.mp4"]
    mine = next(item for item in second_view["history"] if item["output_basename"] == "sibling-clip.mp4")
    media = canvas_client.get(f"/api/canvas/history/{mine['history_id']}/media")
    assert media.status_code == 200 and media.content == b"sealed:sibling-clip.mp4"
    assert media.headers["X-E2E-Media"] == "1"
    # The owner's items stay hidden outright from the sibling's detail routes.
    assert canvas_client.get(f"/api/canvas/history/{owner_item}/media").status_code == 404
    assert canvas_client.get(f"/api/canvas/history/{owner_item}/workflow").status_code == 404
    assert canvas_client.delete(f"/api/canvas/history/{owner_item}", params={}).status_code in {404, 422}

    # And in the other direction: the owner's History drops the clip it had
    # adopted before the claim existed, and never lists the sibling's ids.
    canvas_client.post("/api/accounts/sign-out")
    _sign_in(canvas_client, 1, OWNER_PASSWORD)
    assert basenames(canvas_client.get("/api/canvas/history?refresh=1").json()) == ["canvas-piece.png"]
    assert canvas_client.get(f"/api/canvas/history/{mine['history_id']}/media").status_code == 404


def test_one_workspace_cannot_read_anothers_sealed_blobs(client):
    second = _add_workspace(client, "Second", "second-pass")
    _sign_in(client, 1, OWNER_PASSWORD)
    assert client.put("/api/vault/blob/library/saved-prompts",
                      json={"ciphertext": "owner-ciphertext"}).status_code in {200, 201}

    client.post("/api/accounts/sign-out")
    _sign_in(client, second, "second-pass")
    response = client.get("/api/vault/blob/library/saved-prompts")
    assert response.status_code in {200, 404}
    assert "owner-ciphertext" not in response.text


# ── passkeys over HTTP ───────────────────────────────────────────────────────

def test_passkey_registration_requires_an_open_workspace(client):
    assert client.post("/api/accounts/webauthn/register/options").status_code == 401
    assert client.post("/api/accounts/webauthn/register", json={
        "credential_id": "c", "public_key": "k", "algorithm": -7, "client_data_json": "x",
    }).status_code == 401


def test_registration_options_are_bound_to_the_signed_in_workspace(client):
    second = _add_workspace(client, "Second", "second-pass")
    _sign_in(client, second, "second-pass")
    options = client.post("/api/accounts/webauthn/register/options").json()["publicKey"]
    assert options["rp"]["id"] == "testserver"
    assert options["user"]["displayName"] == "Second"
    # The user handle is a digest of the account id, never the name in clear.
    expected = hashlib.sha256(f"hivemind-account-{second}".encode("utf-8")).digest()[:16]
    assert options["user"]["id"] == __import__("base64").urlsafe_b64encode(expected).decode().rstrip("=")


def test_the_relying_party_follows_the_browsers_host_through_the_proxy(client):
    """The tailnet proxy rewrites Host to its upstream target, so without the
    forwarded host the RP id comes out as 127.0.0.1 and the browser refuses:
    'The relying party ID is not a registrable domain suffix of, nor equal to
    the current domain.'"""
    _sign_in(client, 1, OWNER_PASSWORD)
    response = client.post("/api/accounts/webauthn/register/options", headers={
        "x-forwarded-host": "studio.tailnet.example:8789",
        "x-forwarded-proto": "https",
    })
    assert response.json()["publicKey"]["rp"]["id"] == "studio.tailnet.example"


def test_the_gate_asks_for_registration_options_with_a_post(client):
    """The gate's api() helper sends GET when no body is passed, and a GET to
    this POST-only path falls through to the root static mount, whose bare 404
    surfaced as 'Not Found' on the Add-a-passkey card. Every call the gate
    script makes to it must therefore carry a body."""
    gate = client.get("/", headers={"accept": "text/html"})
    calls = re.findall(r"api\('/api/accounts/webauthn/register/options'(.)", gate.text)
    assert calls, "the gate script no longer registers passkeys?"
    assert all(next_char == "," for next_char in calls), \
        "a bodiless api() call goes out as GET and 404s against the static mount"


def test_a_sign_in_challenge_is_offered_without_a_session(client):
    """The whole point of a passkey tile: no password, no prior session."""
    response = client.post("/api/accounts/webauthn/authenticate/options", json={"account_id": 1})
    assert response.status_code == 200
    options = response.json()["publicKey"]
    assert options["challenge"] and options["rpId"] == "testserver"
    # A workspace that does not exist is not a probe oracle for challenges.
    assert client.post("/api/accounts/webauthn/authenticate/options",
                       json={"account_id": 9999}).status_code == 404


def test_a_bogus_assertion_is_refused(client):
    refused = client.post("/api/accounts/webauthn/authenticate", json={
        "credential_id": "not-a-real-credential", "client_data_json": "x",
        "authenticator_data": "y", "signature": "z",
    })
    assert refused.status_code == 401
    assert client.get("/api/studio-state/opengen-composer").status_code == 401


# ── the legacy owner path still works ────────────────────────────────────────

def test_the_old_owner_unlock_still_signs_into_the_owner_workspace(client):
    """An open tab, a bookmark, or the fallback lock page must keep working."""
    assert client.post("/api/owner/unlock", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/owner/unlock", json={"password": OWNER_PASSWORD}).status_code == 200
    session = client.get("/api/owner/session").json()
    assert session["unlocked"] is True and session["account"]["id"] == 1
    assert client.get("/api/accounts").json()["signed_in_as"] == 1


def test_the_legacy_owner_hash_is_upgraded_to_scrypt_on_first_use(client, tmp_path):
    store = AccountStore(tmp_path / "accounts.sqlite3")
    assert store.password_hash(1) == hashlib.sha256(OWNER_PASSWORD.encode()).hexdigest()
    _sign_in(client, 1, OWNER_PASSWORD)
    upgraded = store.password_hash(1)
    assert upgraded.startswith("scrypt$")
    # ...and the same password still opens it afterwards.
    client.post("/api/accounts/sign-out")
    _sign_in(client, 1, OWNER_PASSWORD)


def test_gpu_rentals_follow_any_signed_in_workspace(client, monkeypatch):
    # No marketplace is consulted: the claim under test is the ACCESS rule,
    # and the conftest transport guard would (rightly) refuse a real call.
    from hivemind_content_studio import rental_providers

    monkeypatch.setattr(rental_providers, "configured_providers", lambda: [])
    # Signed out, the rental surface is refused outright…
    assert client.get("/api/gpu-rentals").status_code == 401
    # …but any workspace may manage rentals once signed in: its creation was
    # owner-approved, and that approval carries the whole studio.
    second = _add_workspace(client, "Second", "second-pass")
    _sign_in(client, second, "second-pass")
    reached = client.get("/api/gpu-rentals")
    assert reached.status_code not in (401, 403)
