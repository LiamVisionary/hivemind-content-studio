"""Music recipes: a local library, and the one opt-in call that leaves the machine.

Every test is named for what goes wrong without the rule under it — a section
name the instrumental LoRA was never shown, lyrics riding along to a hosted
model, a low-confidence guess applied as if it were a match, or a test run that
spends the developer's OpenRouter balance.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from hivemind_content_studio import music_recipes, provider_models


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def answering(payload: dict, *, seen: list):
    def opener(request, timeout=None):
        seen.append({
            "url": request.full_url,
            "headers": {key.lower(): value for key, value in request.headers.items()},
            "body": json.loads(request.data.decode()),
            "timeout": timeout,
        })
        return FakeResponse(json.dumps(payload).encode())
    return opener


def decision(choice: str, confidence: float, probabilities: dict[str, float] | None = None) -> dict:
    return {
        "model": "typesafe/jev-1.13.0",
        "answers": {"recipe": {"choice": choice, "confidence": confidence,
                               "probabilities": probabilities or {choice: confidence}}},
        "usage": {"input_tokens": 1500, "cost": 0.00006},
    }


@pytest.fixture
def connected(monkeypatch):
    """An owner with OpenRouter connected — a fake key, so nothing real is spent."""
    monkeypatch.setattr(provider_models, "stored_names", lambda: {"OPENROUTER_API_KEY"})
    monkeypatch.setattr(provider_models, "credential", lambda name, reason="": "sk-test-not-a-real-key")


# ── the library ─────────────────────────────────────────────────────────────


def test_every_recipe_uses_only_the_six_section_names_the_lora_was_trained_on() -> None:
    for recipe in music_recipes.recipes():
        assert set(recipe["sections"]) <= set(music_recipes.SECTION_TAGS), recipe["id"]


def test_every_recipe_says_where_its_form_and_tempo_came_from() -> None:
    """The library mixes a cited source with general knowledge; each field owns up to which."""
    families = {row["id"] for row in music_recipes.library()["families"]}
    for recipe in music_recipes.recipes():
        assert recipe["basis"]["form"] in ("skills", "general"), recipe["id"]
        assert recipe["basis"]["tempo"] in ("skills", "general"), recipe["id"]
        assert recipe["family"] in families, recipe["id"]
        if recipe["bpm"] is not None and recipe["bpm_range"]:
            low, high = recipe["bpm_range"]
            assert low <= recipe["bpm"] <= high, f"{recipe['id']}: typical tempo outside its own range"


def test_a_malformed_library_is_refused_at_load(tmp_path, monkeypatch) -> None:
    bad = {"recipes": [{"id": "x1", "label": "X", "describes": "x", "sections": ["intro", "guitar solo"]}]}
    path = tmp_path / "music_recipes.json"
    path.write_text(json.dumps(bad))
    monkeypatch.setattr(music_recipes, "LIBRARY_PATH", path)
    music_recipes.library.cache_clear()
    try:
        with pytest.raises(ValueError, match="sections may only use"):
            music_recipes.library()
    finally:
        music_recipes.library.cache_clear()


def test_the_catalog_needs_no_network_and_says_what_suggest_would_send() -> None:
    payload = music_recipes.catalog_payload()
    assert payload["suggest"]["available"] is False  # nothing connected under the test isolation
    assert payload["suggest"]["disclosure"]["sends"] == "your style line"
    assert "lyrics" in payload["suggest"]["disclosure"]["never_sends"]
    assert len(payload["recipes"]) >= 30


# ── the pick ────────────────────────────────────────────────────────────────


def test_no_account_means_no_call_and_the_refusal_points_back_at_the_list() -> None:
    seen: list = []
    with pytest.raises(music_recipes.MusicRecipeError) as refusal:
        music_recipes.suggest("deep house, warm chords", opener=answering(decision("deep-house", 1.0), seen=seen))
    assert seen == [], "nothing may leave the machine without a connected account"
    assert refusal.value.status == 409 and refusal.value.remedy == "connect-openrouter"
    assert "pick a recipe from the list" in str(refusal.value)


def test_only_the_style_line_leaves_the_machine(connected) -> None:
    seen: list = []
    music_recipes.suggest("  deep house,\n warm chords  ", opener=answering(decision("deep-house", 0.97), seen=seen))
    (call,) = seen
    assert call["url"] == music_recipes.DECISION_URL
    assert call["headers"]["authorization"] == "Bearer sk-test-not-a-real-key"
    assert call["body"]["model"] == "typesafe/jev-1.13", "pinned - never the moving alias"
    assert call["body"]["state"] == {"style_description": "deep house, warm chords"}
    assert set(call["body"]) == {"model", "state", "questions"}
    options = call["body"]["questions"]["recipe"]["criteria"]
    assert set(options) == {row["id"] for row in music_recipes.recipes()}


def test_a_confident_match_is_applied_and_a_spread_is_only_offered(connected) -> None:
    sure = music_recipes.suggest("x", opener=answering(decision("techno", 0.93), seen=[]))
    assert sure["recipe"] == "techno" and sure["confident"] is True

    spread = {"techno": 0.41, "deep-house": 0.33, "trance": 0.2, "ambient": 0.06}
    unsure = music_recipes.suggest("x", opener=answering(decision("techno", 0.41, spread), seen=[]))
    assert unsure["confident"] is False
    assert [row["id"] for row in unsure["alternatives"]] == ["techno", "deep-house", "trance"]


def test_a_tempo_the_person_typed_is_read_locally_not_asked_of_the_model(connected) -> None:
    answer = music_recipes.suggest("festival house, 128 BPM, big lead",
                                   opener=answering(decision("festival-house", 1.0), seen=[]))
    assert answer["explicit_bpm"] == 128
    assert music_recipes.explicit_bpm("warm lofi, no tempo given") is None
    assert music_recipes.explicit_bpm("recorded in 1985 bpm-less") is None
    assert music_recipes.explicit_bpm("999 bpm") is None


def test_an_answer_this_studio_cannot_read_is_a_refusal_never_a_guess(connected) -> None:
    for payload in (
        {"answers": {}},
        decision("a-recipe-that-does-not-exist", 0.99),
        {"answers": {"recipe": {"choice": "techno", "confidence": "high"}}},
    ):
        with pytest.raises(music_recipes.MusicRecipeError) as refusal:
            music_recipes.suggest("x", opener=answering(payload, seen=[]))
        assert refusal.value.status == 502


def test_a_provider_refusal_carries_its_reason_and_the_key_never_appears(connected) -> None:
    def refusing(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 402, "Payment Required", {},
                                     io.BytesIO(b'{"error": {"message": "Insufficient credits"}}'))
    with pytest.raises(music_recipes.MusicRecipeError) as refusal:
        music_recipes.suggest("x", opener=refusing)
    assert "Insufficient credits" in str(refusal.value)
    assert "sk-test" not in str(refusal.value)


def test_a_document_pasted_into_the_style_box_is_not_sent(connected) -> None:
    seen: list = []
    with pytest.raises(music_recipes.MusicRecipeError):
        music_recipes.suggest("word " * 400, opener=answering(decision("pop", 1.0), seen=seen))
    assert seen == []


# ── the routes ──────────────────────────────────────────────────────────────


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
    assert client.post("/api/accounts/unlock", json={"account_id": 1, "password": "pw"}).status_code == 200
    return client


def test_the_routes_are_owner_only_and_a_refusal_keeps_its_remedy(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    assert len(client.get("/api/music/recipes").json()["recipes"]) >= 30

    refused = client.post("/api/music/suggest", json={"style": "deep house"})
    assert refused.status_code == 409
    assert refused.json()["detail"]["remedy"] == "connect-openrouter"

    client.cookies.clear()
    assert client.get("/api/music/recipes").status_code in (401, 403)
    assert client.post("/api/music/suggest", json={"style": "deep house"}).status_code in (401, 403)
