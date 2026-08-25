"""One table decides which generator runs which image provider.

The failure this pins: the studios dispatched on "is it local?" and sent every
cloud provider to MUAPI. Three providers in the catalog offer a model called
`gpt-image-2` on three different accounts, so a wrong dispatch is not an error —
it is a charge on someone else's bill, invisible until it arrives.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio import image_router
from hivemind_content_studio.media_catalog import media_catalog


# Providers that render something that is not a generated image. Listed by name
# so a NEW provider cannot join them by accident.
NOT_IMAGE_MODELS = {"static-text-renderer", "stickman-renderer"}


def test_every_catalogued_image_provider_has_a_route() -> None:
    """A provider added to the catalog and not here would be a KeyError at the
    route — which is the point. Silently defaulting it bills the wrong account."""
    catalogued = {str(provider["id"]) for provider in media_catalog()["image"]}

    missing = catalogued - set(image_router.ROUTES) - NOT_IMAGE_MODELS

    assert missing == set(), f"no image route for: {sorted(missing)}"


def test_the_two_openai_credentials_are_two_different_routes() -> None:
    """Same model id, two accounts. This is the pair that was confused."""
    api = image_router.ROUTES["openai-gpt-image"]
    oauth = image_router.ROUTES["openai-gpt-image-oauth"]

    assert api.run is not oauth.run
    # The label is what the owner is told when it fails, so it has to name the
    # account rather than "the provider".
    assert "API key" in api.label
    assert "sign-in" in oauth.label


def test_an_unknown_provider_is_refused_rather_than_defaulted(tmp_path: Path) -> None:
    with pytest.raises(image_router.ImageRouterError) as excinfo:
        image_router.render_image(
            provider="brand-new-provider", model="x", prompt="a pier", output=tmp_path / "a.png",
        )

    assert "No image route" in str(excinfo.value)
    # And it says what IS known, so the fix is obvious.
    assert "openai-gpt-image-oauth" in str(excinfo.value)


def test_an_empty_provider_is_refused_too(tmp_path: Path) -> None:
    with pytest.raises(image_router.ImageRouterError):
        image_router.render_image(provider="", model="gpt-image-2", prompt="x", output=tmp_path / "a.png")


def test_a_request_with_no_prompt_never_reaches_a_paid_provider(tmp_path: Path) -> None:
    called: list[str] = []
    routes = {"muapi": image_router.Route("muapi", "MUAPI", lambda **_: called.append("ran") or {})}

    with pytest.raises(image_router.ImageRouterError):
        image_router.render_image(
            provider="muapi", model="m", prompt="   ", output=tmp_path / "a.png", routes=routes,
        )

    assert called == []


def test_the_selected_provider_and_model_reach_the_generator(tmp_path: Path) -> None:
    seen: dict = {}

    def fake(**kwargs):
        seen.update(kwargs)
        return {"output": str(kwargs["output"])}

    routes = {"openai-gpt-image-oauth": image_router.Route("openai-gpt-image-oauth", "OpenAI (sign-in)", fake)}
    result = image_router.render_image(
        provider="openai-gpt-image-oauth", model="gpt-image-2", prompt="an empty terminus",
        aspect_ratio="9:16", output=tmp_path / "a.png", routes=routes,
    )

    assert seen["model"] == "gpt-image-2"
    assert seen["prompt"] == "an empty terminus"
    assert seen["aspect_ratio"] == "9:16"
    assert result["provider"] == "openai-gpt-image-oauth"


def test_a_provider_failure_names_the_account_the_owner_has_to_fix(tmp_path: Path) -> None:
    def boom(**_):
        raise RuntimeError("401 Unauthorized")

    routes = {"xai-imagine-oauth": image_router.Route("xai-imagine-oauth", "xAI Imagine (sign-in)", boom)}

    with pytest.raises(image_router.ImageRouterError) as excinfo:
        image_router.render_image(
            provider="xai-imagine-oauth", model="grok-imagine-image", prompt="x",
            output=tmp_path / "a.png", routes=routes,
        )

    # "401" on its own does not say WHICH of five credentials to go and fix.
    assert "xAI Imagine (sign-in)" in str(excinfo.value)
    assert "401" in str(excinfo.value)


def test_every_route_states_the_account_in_its_label() -> None:
    for provider, route in image_router.ROUTES.items():
        assert route.label.strip(), f"{provider} has no label to show the owner"
        assert route.provider == provider


# ── The route ───────────────────────────────────────────────────────────────


def _client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from hivemind_content_studio.approval_ledger import ApprovalLedger
    from hivemind_content_studio.control_api import build_control_app
    from hivemind_content_studio.orchestrator import ContentOrchestrator
    from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
    from hivemind_content_studio.run_store import RunStore

    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "a.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/owner/unlock", json={"password": "pw"}).status_code == 200
    return client


def test_the_route_sends_the_picked_provider_to_its_own_generator(tmp_path, monkeypatch) -> None:
    """The bug, at the route: an OAuth pick must not reach the MUAPI generator."""
    from hivemind_content_studio import control_api

    seen: dict = {}

    def fake_render(**kwargs):
        seen.update(kwargs)
        Path(kwargs["output"]).write_bytes(b"\x89PNG\r\n\x1a\n")
        return {"provider": kwargs["provider"], "model": kwargs["model"], "output": str(kwargs["output"])}

    monkeypatch.setattr(control_api.image_router, "render_image", fake_render)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/media-studio/image", json={
        "provider": "openai-gpt-image-oauth", "model": "gpt-image-2",
        "prompt": "an empty estuary terminus", "aspect_ratio": "9:16",
    }).json()

    assert seen["provider"] == "openai-gpt-image-oauth"
    assert seen["model"] == "gpt-image-2"
    assert body["provider"] == "openai-gpt-image-oauth"
    assert body["url"].startswith("/api/media-studio/generated/")


def test_the_route_refuses_a_provider_it_cannot_route(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/media-studio/image", json={
        "provider": "brand-new-provider", "model": "x", "prompt": "a pier",
    })

    assert response.status_code == 400
    # The detail is an object now: the message AND what to do about it.
    assert "No image route" in response.json()["detail"]["message"]
    assert response.json()["detail"]["remedy"] == ""


def test_the_route_requires_a_provider_at_all(tmp_path, monkeypatch) -> None:
    """A model id alone is ambiguous — three providers offer `gpt-image-2`."""
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/media-studio/image", json={"model": "gpt-image-2", "prompt": "x"})

    assert response.status_code == 422


def test_the_route_is_owner_only(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    client.cookies.clear()

    response = client.post("/api/media-studio/image", json={
        "provider": "muapi", "model": "flux-2-pro", "prompt": "x",
    })

    assert response.status_code in (401, 403)


def test_a_generated_still_does_not_stay_on_disk_in_the_clear(tmp_path, monkeypatch) -> None:
    """Same rule as every other generated output: encrypted AT REST.

    The route still serves the decrypted bytes back to the signed-in owner —
    that is what the legacy-cipher path is for. The invariant is the file, not
    the response.
    """
    from hivemind_content_studio import control_api

    landed: dict = {}

    def fake_render(**kwargs):
        Path(kwargs["output"]).write_bytes(b"\x89PNG\r\n\x1a\nplaintext-pixels")
        landed["path"] = Path(kwargs["output"])
        return {"provider": kwargs["provider"], "model": kwargs["model"], "output": str(kwargs["output"])}

    monkeypatch.setattr(control_api.image_router, "render_image", fake_render)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/media-studio/image", json={
        "provider": "muapi", "model": "flux-2-pro", "prompt": "a pier",
    }).json()

    on_disk = landed["path"]
    assert not (on_disk.is_file() and on_disk.read_bytes().startswith(b"\x89PNG")), \
        "the still is sitting in the outputs folder as a readable PNG"
    # And the owner can still read it back through the route.
    served = client.get(body["url"])
    assert served.status_code == 200
    assert b"plaintext-pixels" in served.content


def test_an_expired_grant_comes_back_with_a_reconnect_remedy(tmp_path, monkeypatch) -> None:
    """Reported 2026-08-24: picking GPT Image 2 (OAuth) and pressing Draw showed
    "OpenAI GPT Image (ChatGPT sign-in): Invalid refresh token." and nothing else.
    That sentence is not an instruction and the studio could not act on it."""
    from hivemind_content_studio import control_api

    def expired(**_):
        raise RuntimeError("Invalid refresh token.")

    monkeypatch.setattr(
        control_api.image_router, "ROUTES",
        {**control_api.image_router.ROUTES,
         "openai-gpt-image-oauth": control_api.image_router.Route(
             "openai-gpt-image-oauth", "OpenAI GPT Image (ChatGPT sign-in)", expired, oauth="openai")},
    )
    client = _client(tmp_path, monkeypatch)

    detail = client.post("/api/media-studio/image", json={
        "provider": "openai-gpt-image-oauth", "model": "gpt-image-2", "prompt": "a pier",
    }).json()["detail"]

    assert detail["remedy"] == "reconnect"
    assert detail["provider"] == "openai"
    # The provider's own words survive underneath, for debugging.
    assert "Invalid refresh token" in detail["message"]


def test_a_failure_that_reconnecting_cannot_fix_offers_no_reconnect(tmp_path, monkeypatch) -> None:
    """Offering the wrong remedy is its own kind of lie."""
    from hivemind_content_studio import control_api

    def rate_limited(**_):
        raise RuntimeError("429 Too Many Requests")

    monkeypatch.setattr(
        control_api.image_router, "ROUTES",
        {**control_api.image_router.ROUTES,
         "openai-gpt-image-oauth": control_api.image_router.Route(
             "openai-gpt-image-oauth", "OpenAI GPT Image (ChatGPT sign-in)", rate_limited, oauth="openai")},
    )
    client = _client(tmp_path, monkeypatch)

    detail = client.post("/api/media-studio/image", json={
        "provider": "openai-gpt-image-oauth", "model": "gpt-image-2", "prompt": "a pier",
    }).json()["detail"]

    assert detail["remedy"] == ""


def test_a_key_provider_never_offers_a_reconnect_it_cannot_perform(tmp_path, monkeypatch) -> None:
    """MUAPI has no grant to reconnect; the remedy there is a key, not a sign-in."""
    from hivemind_content_studio import control_api

    def unauthorized(**_):
        raise RuntimeError("401 unauthorized")

    monkeypatch.setattr(
        control_api.image_router, "ROUTES",
        {**control_api.image_router.ROUTES,
         "muapi": control_api.image_router.Route("muapi", "MUAPI", unauthorized)},
    )
    client = _client(tmp_path, monkeypatch)

    detail = client.post("/api/media-studio/image", json={
        "provider": "muapi", "model": "flux-2-pro", "prompt": "a pier",
    }).json()["detail"]

    assert detail["remedy"] == ""
