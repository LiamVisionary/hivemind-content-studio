"""The prompt helper's instruction has to match the model being prompted.

MiniMax H3 is the strict case: its authors ship a prompt rewriter and the model
was trained on that rewriter's OUTPUT, so the field names, shot headers and tags
are an interface. A helper that writes good freeform English at H3 is writing in
the wrong format, and nothing downstream would ever complain.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import control_api, local_llm, prompt_profiles
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


def _client(tmp_path: Path, monkeypatch) -> TestClient:
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


@pytest.fixture
def captured_system(monkeypatch) -> list[str]:
    """Run the real route against a stand-in model, keeping its system prompt."""
    seen: list[str] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            seen.append(messages[0]["content"])
            return "written prompt"

    monkeypatch.setattr(local_llm, "runtime", FakeRuntime)
    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    return seen


@pytest.mark.parametrize("model_id", [
    "minimax-h3",
    "minimax-h3-turbo",
    "MiniMax-H3",
    # The studio falls back to the raw picker id when the hivemind prefix is
    # not stripped; the profile must survive that form too.
    "hivemind-media:minimax-h3",
])
def test_every_h3_lane_gets_the_h3_format(model_id: str) -> None:
    assert prompt_profiles.profile_for(model_id) == "minimax-h3-t2v"
    assert prompt_profiles.profile_for(model_id, first_frame=True) == "minimax-h3-i2v"


def test_a_start_frame_is_a_different_h3_task_not_a_detail() -> None:
    """I2VA opens with an anchor line the model was trained on; T2VA must not
    carry it, or the prompt promises a reference image that was never sent."""
    anchor = "at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced"
    with_frame = prompt_profiles.system_prompt("minimax-h3-i2v")
    without = prompt_profiles.system_prompt("minimax-h3-t2v")
    assert anchor in with_frame
    assert anchor not in without


@pytest.mark.parametrize("profile", ["minimax-h3-t2v", "minimax-h3-i2v"])
def test_the_h3_instruction_carries_the_trained_on_interface(profile: str) -> None:
    system = prompt_profiles.system_prompt(profile)
    # The three fields, in the documented order.
    positions = [system.index(field) for field in
                 ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music")]
    assert positions == sorted(positions)
    # Shot headers, speaker ids and the tag vocabulary. The timestamp is taught
    # with a WORKED example, not just the MM:SS.mmm pattern: given the pattern
    # alone the 26B helper wrote "At 03:500," (2026-08-09).
    assert "[Shot 1]" in system and "MM:SS.mmm" in system
    assert "[Shot 2] At 00:03.500," in system
    assert "(S1)" in system and "(S2)" in system
    assert "<d>[English]" in system and "</d>" in system
    assert "<cutoff>" in system
    # The two length limits the guide states.
    assert "1-4 sentences" in system and "1-3 sentences" in system
    # H3 has no negative lane; the helper must never invent one.
    assert "no negative prompt" in system.lower()


@pytest.mark.parametrize("profile", ["minimax-h3-t2v", "minimax-h3-i2v"])
def test_speech_is_off_unless_the_idea_asks_for_it(profile: str) -> None:
    """Measured 2026-08-09: teaching the <d> tag thoroughly and never saying it
    was optional made the helper invent a spoken line for a silent idea (a
    lighthouse keeper muttering "Another one coming"). H3 renders audio too, so
    that becomes a real voice saying words nobody asked for."""
    system = prompt_profiles.system_prompt(profile)
    assert "Speech is OPTIONAL and off by default" in system
    assert "no <d> tag, no speaker id" in system
    # The instruction must still teach the tag for when speech IS wanted.
    assert "<d>[English]" in system


def test_other_video_models_keep_their_own_shape() -> None:
    """H3's format is H3's. Nothing else should have picked it up."""
    for model_id, expected in (
        ("ltx23-eros-dmd", "ltx-eros-scene-script"),
        ("ltx23-eros-dmd-v12", "ltx-video"),
        ("ltx23-i2v", "ltx-video"),
    ):
        assert prompt_profiles.profile_for(model_id, first_frame=True) == expected
    assert prompt_profiles.profile_for("minimax-h3", media_type="image") == "image"
    for profile in ("ltx-video", "ltx-eros-scene-script", "image"):
        assert "integrated_multimodal_description" not in prompt_profiles.system_prompt(profile)


def test_the_helper_does_not_care_where_the_generation_will_run() -> None:
    """A rented machine changes which Comfy lane serves the job, never the
    workflow id — so the helper is identical in Local and Rented mode. This is
    the guard against ever keying guidance on the source instead."""
    for first_frame in (False, True):
        assert (prompt_profiles.profile_for("minimax-h3", first_frame=first_frame)
                == prompt_profiles.profile_for("minimax-h3", first_frame=first_frame))
        assert prompt_profiles.profile_for("minimax-h3", first_frame=first_frame).startswith("minimax-h3")


def test_the_route_sends_the_h3_format_to_the_local_model(tmp_path: Path, monkeypatch, captured_system) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a courier waits for a train",
        "targetModel": "minimax-h3", "mediaType": "video", "hasFirstFrame": True,
    })

    assert response.status_code == 200
    body = response.json()
    assert body["profile"] == "minimax-h3-i2v"
    assert body["profileLabel"] == "MiniMax H3 (start frame)"
    assert "integrated_multimodal_description" in captured_system[0]
    assert "<Picture 1> (from [Shot 1]) is fully referenced" in captured_system[0]


def test_the_route_defaults_to_text_to_video_when_no_frame_is_attached(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a courier waits for a train",
        "targetModel": "minimax-h3",
    })

    assert response.json()["profile"] == "minimax-h3-t2v"
    assert "<Picture 1>" not in captured_system[0]


def test_the_language_tag_a_small_model_forgets_is_repaired() -> None:
    """Measured on a 26B Q4 helper: it writes the fields and shot headers but
    drops the required [English] from <d> tags. Mechanical and unambiguous."""
    raw = "[Shot 1] (S1) says: <d>I get off at the next station.</d>"
    fixed = prompt_profiles.normalize("minimax-h3-t2v", raw)
    assert fixed == "[Shot 1] (S1) says: <d>[English] I get off at the next station.</d>"
    # A tag that already declares a language is left exactly alone.
    tagged = "<d>[Mandarin] 下一站下车。</d>"
    assert prompt_profiles.normalize("minimax-h3-i2v", tagged) == tagged


def test_speech_written_without_the_tag_is_wrapped() -> None:
    """Seen live: the helper wrote the language but dropped <d> entirely.
    Untagged, H3 reads the line as description and never says it."""
    raw = "(S1) says: [English] I'm getting off at the next station.<cutoff> The train arrives."
    assert prompt_profiles.normalize("minimax-h3-i2v", raw) == (
        "(S1) says: <d>[English] I'm getting off at the next station.</d><cutoff> The train arrives."
    )


def test_wrapping_never_swallows_a_shot_header() -> None:
    """A shot header is also bracketed text followed by a sentence, so the
    repair is anchored on the speech verb — the one thing that separates them."""
    raw = "[Shot 2] At 00:03.500, the camera pans to the platform edge."
    assert prompt_profiles.normalize("minimax-h3-t2v", raw) == raw
    anchor = ("For the target video, at 0.00 seconds into the target video, "
              "<Picture 1> (from [Shot 1]) is fully referenced.")
    assert prompt_profiles.normalize("minimax-h3-i2v", anchor) == anchor


def test_list_numbering_is_stripped_from_shot_headers() -> None:
    raw = "1. [Shot 1] She waits.\n2. [Shot 2] At 00:03.500, the train arrives."
    assert prompt_profiles.normalize("minimax-h3-i2v", raw) == (
        "[Shot 1] She waits.\n[Shot 2] At 00:03.500, the train arrives."
    )


def test_a_field_written_as_a_heading_gets_its_colon_back() -> None:
    """Seen on Swarm Scout 12B: it laid the fields out as headings. The colon
    is the token H3 was trained to read, so a heading is not the same thing."""
    raw = "overall_soundscape\nDistant city hum and rain.\n\nnon_diegetic_music\nA muted piano."
    assert prompt_profiles.normalize("minimax-h3-t2v", raw) == (
        "overall_soundscape:\nDistant city hum and rain.\n\nnon_diegetic_music:\nA muted piano."
    )
    # A field that already has its colon, or is mentioned mid-sentence, is left alone.
    fine = "overall_soundscape: Distant city hum.\nThe overall_soundscape is calm."
    assert prompt_profiles.normalize("minimax-h3-t2v", fine) == fine


def test_normalize_leaves_other_models_untouched() -> None:
    """Only H3 has this format; an eros scene script containing "<d>" (it will
    not, but the rule must be scoped anyway) must pass through verbatim."""
    raw = "Performance: she turns. <d>whatever</d>"
    assert prompt_profiles.normalize("ltx-eros-scene-script", raw) == raw
    assert prompt_profiles.normalize("minimax-h3-t2v", "") == ""


def test_the_route_returns_the_repaired_prompt(tmp_path: Path, monkeypatch) -> None:
    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            return "[Shot 1] (S1) says: <d>I get off at the next station.</d>"

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
    }).json()

    assert "<d>[English] I get off at the next station.</d>" in body["prompt"]


def test_the_clip_length_reaches_the_instruction() -> None:
    """Without it the helper writes whatever timeline the idea suggests —
    measured: a "[Shot 3] At 00:07.800" beat on a clip set to 5 seconds."""
    plain = prompt_profiles.system_prompt("minimax-h3-t2v")
    timed = prompt_profiles.system_prompt("minimax-h3-t2v", duration_seconds=5)
    assert "5 seconds long" in timed and "seconds long" not in plain
    assert "before 5s" in timed
    # An image prompt has no timeline to bound.
    assert prompt_profiles.system_prompt("image", duration_seconds=5) == prompt_profiles.system_prompt("image")


def test_shots_past_the_end_of_the_clip_are_detected() -> None:
    prompt = (
        "[Shot 1] She waits.\n"
        "[Shot 2] At 00:03.500, the train arrives.\n"
        "[Shot 3] At 00:07.800, she steps aboard.\n"
    )
    assert prompt_profiles.timeline_overruns(prompt, 5) == [7.8]
    assert prompt_profiles.timeline_overruns(prompt, 10) == []
    # Exactly at the end is still past it: nothing can start on the last frame.
    assert prompt_profiles.timeline_overruns("[Shot 2] At 00:05.000, x.", 5) == [5.0]
    # No duration known, nothing to check against.
    assert prompt_profiles.timeline_overruns(prompt, None) == []
    # A bare timestamp that is not a shot header is not a beat.
    assert prompt_profiles.timeline_overruns("the clock reads At 09:30, and she leaves.", 5) == []


def test_an_overrunning_timeline_is_rewritten_once(tmp_path: Path, monkeypatch) -> None:
    """The corrective pass is worth its latency: moving a beat by hand would
    rewrite the story, so the model is asked to compress it instead."""
    calls: list[list[dict]] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            calls.append(messages)
            if len(calls) == 1:
                return "[Shot 1] She waits.\n[Shot 2] At 00:07.800, the train arrives."
            return "[Shot 1] She waits.\n[Shot 2] At 00:03.500, the train arrives."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3", "durationSeconds": 5,
    }).json()

    assert "00:03.500" in body["prompt"] and "00:07.800" not in body["prompt"]
    assert body["warnings"] == []
    assert len(calls) == 2, "one corrective pass, not a loop"
    assert "never render" in calls[1][-1]["content"]


def test_a_timeline_that_stays_too_long_is_flagged_not_hidden(tmp_path: Path, monkeypatch) -> None:
    class StubbornRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            return "[Shot 1] She waits.\n[Shot 2] At 00:09.000, the train arrives."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", StubbornRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3", "durationSeconds": 5,
    }).json()

    assert body["prompt"], "the prompt is still returned — the user decides"
    assert any("runs past the 5s clip" in w for w in body["warnings"])


def test_an_image_sent_to_a_blind_model_is_reported(tmp_path: Path, monkeypatch) -> None:
    """Silently dropping it would produce a prompt describing a frame the model
    never saw, which reads exactly like one that did."""
    seen = {}

    class BlindRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            seen["image"] = image
            return "[Shot 1] She waits."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", BlindRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "hasFirstFrame": True, "imageBase64": "data:image/png;base64,AAAA",
    }).json()

    assert seen["image"] is None
    assert body["sawImage"] is False
    assert any("no vision projector" in w for w in body["warnings"])


def test_the_image_reaches_a_model_that_can_see(tmp_path: Path, monkeypatch) -> None:
    seen = {}

    class SeeingRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            seen["image"] = image
            return "[Shot 1] She waits."

        def model_sees_images(self, model_id):
            return True

    monkeypatch.setattr(control_api.local_llm, "runtime", SeeingRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "hasFirstFrame": True, "imageBase64": "data:image/png;base64,AAAA",
    }).json()

    assert seen["image"] == "data:image/png;base64,AAAA"
    assert body["sawImage"] is True and body["warnings"] == []


def test_a_revision_carries_the_draft_and_the_note(tmp_path: Path, monkeypatch) -> None:
    """Editing replays the whole conversation, so the format rules and the clip
    length still apply to whatever comes back."""
    seen: list[list[dict]] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            seen.append(messages)
            return "[Shot 1] She waits at night. (S1) says: <d>[English] Hello.</d>"

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier waits", "targetModel": "minimax-h3",
        "durationSeconds": 5,
        "currentPrompt": "[Shot 1] She waits in daylight.",
        "revision": "make it night",
    }).json()

    conversation = seen[0]
    assert conversation[0]["role"] == "system" and "5 seconds long" in conversation[0]["content"]
    assert conversation[1]["content"] == "a courier waits"
    assert conversation[2] == {"role": "assistant", "content": "[Shot 1] She waits in daylight."}
    assert "make it night" in conversation[3]["content"]
    assert "night" in body["prompt"]


def test_a_revision_is_repaired_like_any_other_prompt(tmp_path: Path, monkeypatch) -> None:
    """A note like "make it night" must not quietly cost the <d> tags."""
    class SloppyRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            return "[Shot 1] Night. (S1) says: <d>Hello.</d>"

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", SloppyRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier waits", "targetModel": "minimax-h3",
        "currentPrompt": "[Shot 1] Daylight.", "revision": "make it night",
    }).json()

    assert "<d>[English] Hello.</d>" in body["prompt"]


def test_asking_for_changes_with_nothing_to_change_is_refused(tmp_path: Path, monkeypatch, captured_system) -> None:
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "revision": "make it night",
    })
    assert response.status_code == 400
    assert "Write a prompt before" in response.json()["detail"]


def test_a_change_is_measured_in_lines() -> None:
    """A correct edit can be three words inside twenty lines, which reads on
    screen as nothing happening."""
    before = "[Shot 1] A woman in a navy bag waits.\n[Shot 2] At 00:02.500, she speaks."
    after = "[Shot 1] A woman in a red jacket and a navy bag waits.\n[Shot 2] At 00:02.500, she speaks."
    assert prompt_profiles.changed_lines(before, after) == 1
    assert prompt_profiles.changed_lines(before, before) == 0
    assert prompt_profiles.changed_lines("", "") == 0


def test_a_revision_the_model_ignored_is_pushed_once_then_reported(tmp_path: Path, monkeypatch) -> None:
    """Handing back the draft unchanged is indistinguishable from a subtle
    correct edit, so it gets one firm retry and then says which happened."""
    replies = iter([
        "[Shot 1] A woman waits.",           # ignored the note
        "[Shot 1] A woman in a red jacket waits.",  # applied on the push
    ])
    prompts: list[str] = []

    class StubbornRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            prompts.append(messages[-1]["content"])
            return next(replies)

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", StubbornRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "currentPrompt": "[Shot 1] A woman waits.", "revision": "she is wearing a red jacket",
    }).json()

    assert "red jacket" in body["prompt"]
    assert body["changedLines"] == 1
    assert body["warnings"] == []
    assert "did not apply the change" in prompts[-1], "the retry names the failure"


def test_a_revision_ignored_twice_is_said_out_loud(tmp_path: Path, monkeypatch) -> None:
    class DeafRuntime:
        def chat(self, *, model_id, messages, image=None, **_kw):
            return "[Shot 1] A woman waits."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", DeafRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "currentPrompt": "[Shot 1] A woman waits.", "revision": "she is wearing a red jacket",
    }).json()

    assert body["changedLines"] == 0
    assert any("did not apply that change" in w for w in body["warnings"])


def test_a_fresh_write_reports_no_change_count(tmp_path: Path, monkeypatch, captured_system) -> None:
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
    }).json()
    assert body["changedLines"] is None


def test_the_registry_guidance_agrees_with_the_helper() -> None:
    """Agents call the MCP directly and never see the helper's instruction, so
    the registry carries the same contract. Two sources, one format."""
    import json

    registry = json.loads(
        (Path(__file__).resolve().parents[2] / "packages/media-gateway/workflow-registry.json")
        .read_text(encoding="utf-8")
    )
    entries = {w["id"]: w for w in registry["workflows"]} if isinstance(registry.get("workflows"), list) else {}
    guidance = entries["minimax-h3"]["prompt_contract"]["guidance"]
    for token in ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music",
                  "[Shot N] At MM:SS.mmm", "<d>[English]", "<cutoff>", "<Picture 1>"):
        assert token in guidance


def test_character_notes_reach_the_h3_instruction_only() -> None:
    """Verified castings override the local model's recollection — but only
    for H3, whose community-tested form hangs a character on its source
    ("Buffy Summers as played by Sarah Michelle Gellar from the television
    series Buffy the Vampire Slayer (1997)"). Other models' instructions never
    asked for character facts."""
    notes = [
        "Buffy Summers — played by Sarah Michelle Gellar — from the television "
        "series Buffy the Vampire Slayer (1997)",
    ]
    with_notes = prompt_profiles.system_prompt("minimax-h3-t2v", character_notes=notes)
    assert notes[0] in with_notes
    assert "override" in with_notes
    assert notes[0] not in prompt_profiles.system_prompt("ltx-video", character_notes=notes)
    # Notes and the clip length are independent clauses; both must survive.
    with_both = prompt_profiles.system_prompt(
        "minimax-h3-t2v", duration_seconds=5, character_notes=notes)
    assert notes[0] in with_both and "5 seconds long" in with_both
    # The body itself teaches the source form, so characters the studio's
    # catalog does not know still get expanded from the model's own knowledge.
    assert "as played by" in prompt_profiles.system_prompt("minimax-h3-t2v")
    assert "in the style and aesthetics of" in prompt_profiles.system_prompt("minimax-h3-t2v")


def test_the_route_folds_character_notes_into_the_system_prompt(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "buffy walks through a cemetery at night",
        "targetModel": "minimax-h3",
        "characterNotes": [
            "Buffy Summers — played by Sarah Michelle Gellar — from the television "
            "series Buffy the Vampire Slayer (1997)",
            "   ",
            "y" * 500,
        ],
    })

    assert response.status_code == 200
    assert "Sarah Michelle Gellar" in captured_system[0]
    # Sanitised at the route: blank lines dropped, runaway lines capped.
    assert "y" * 201 not in captured_system[0]


def test_continuation_clause_tells_the_helper_to_keep_the_established_scene():
    """A chained shot is a different writing job from a fresh one.

    The pinned frames carry motion and room tone, NOT the scene: measured on
    the rental 2026-08-10, a chained prompt that stops describing the
    established subjects and style renders a hard cut into an unrelated take.
    Without this clause the helper answered a bare line of new dialogue by
    inventing a whole new scene (a Batcave shot became a noir alley, and
    Batman became "a man in a dark coat"), which is exactly that failure.
    """
    plain = prompt_profiles.system_prompt("minimax-h3-t2v")
    chained = prompt_profiles.system_prompt("minimax-h3-t2v", continuation=True)
    assert chained.startswith(plain), "the continuation rules are additive"
    assert "CONTINUES the previous one" in chained
    # The three rules that make a join hold: keep the scene, open on a held
    # framing, and leave room for the carried-over head.
    assert "colour palette" in chained
    assert "must be the HOLD" in chained
    assert "1s or later" in chained
    # A line of new dialogue is the next thing said, not a new scene — the
    # exact case that failed.
    assert "only a line of new dialogue" in chained

    # It composes with the other clauses rather than replacing them.
    with_all = prompt_profiles.system_prompt(
        "minimax-h3-t2v", duration_seconds=8, continuation=True,
        character_notes=["Batman — from the DC comics (1939)"],
    )
    assert "CONTINUES the previous one" in with_all
    assert "8 seconds long" in with_all
    assert "Batman" in with_all

    # Chaining is a MiniMax H3 capability; other lanes have their own
    # continuation mechanism (LTX extends inside the graph) and must not be
    # handed H3's rules.
    assert "CONTINUES the previous one" not in prompt_profiles.system_prompt(
        "ltx-video", continuation=True)
    assert "CONTINUES the previous one" not in prompt_profiles.system_prompt(
        "image", continuation=True)


def test_profile_label_says_when_a_scene_is_being_continued():
    assert prompt_profiles.profile_label("minimax-h3-t2v") == "MiniMax H3 (text to video)"
    assert prompt_profiles.profile_label("minimax-h3-t2v", continuation=True) == (
        "MiniMax H3 (text to video) · continuing a scene"
    )
    # Not an H3 lane: no chaining, so no claim about one.
    assert "continuing" not in prompt_profiles.profile_label("ltx-video", continuation=True)


def test_continuation_opening_on_dialogue_is_detected():
    """The carried-over head is picture from the PREVIOUS shot.

    A line spoken over it lands early and reads as a jump cut. The instruction
    asks for a silent hold first; a 12B helper keeps the scene but still opens
    on dialogue, so the result is checked (and one repair asked) rather than
    trusted — same contract as the clip-length check.
    """
    opens_talking = (
        "[Shot 1] Batman speaks. (S1) says: <d>[English] We have to find him.</d>\n"
        "At 00:04.000 [Shot 2] The camera pulls back."
    )
    assert prompt_profiles.continuation_opens_on_speech(opens_talking)

    holds_first = (
        "[Shot 1] Batman holds the closing framing, breathing, cape settling.\n"
        "At 00:01.500 [Shot 2] He turns to the console. (S1) says: <d>[English] We have to find him.</d>"
    )
    assert not prompt_profiles.continuation_opens_on_speech(holds_first)

    # A hold that is too short still opens over the pinned frames.
    assert prompt_profiles.continuation_opens_on_speech(
        "[Shot 1] Batman breathes.\n"
        "At 00:00.400 [Shot 2] (S1) says: <d>[English] Now.</d>"
    )
    # No speech at all is fine — nothing can land early.
    assert not prompt_profiles.continuation_opens_on_speech(
        "[Shot 1] Batman holds still.\nAt 00:02.000 [Shot 2] He stands up."
    )
    assert not prompt_profiles.continuation_opens_on_speech("")


def test_shot_timestamps_are_read_in_both_written_orders():
    """The instruction teaches "[Shot 2] At 00:03.500," and helpers also write
    "At 00:03.500 [Shot 2]" — both of Liam's own H3 prompts used the second
    form. Reading only the taught order left the overrun check inert on exactly
    those prompts, so a beat past the end of an 8s clip shipped unflagged."""
    taught = "[Shot 2] At 00:09.000, the camera pulls back."
    also_written = "At 00:09.000 [Shot 2] The camera pulls back."
    assert prompt_profiles.timeline_overruns(taught, 8) == [9.0]
    assert prompt_profiles.timeline_overruns(also_written, 8) == [9.0]
    # In-range beats in either order are not flagged.
    assert prompt_profiles.timeline_overruns("At 00:03.200 [Shot 2] Cut in.", 8) == []
    # A bare timestamp with no shot header is prose, not a beat.
    assert prompt_profiles.timeline_overruns("The clock reads At 09:00.", 8) == []


def test_the_route_tells_the_helper_when_it_is_continuing_a_scene(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    """The studio knows a chain is armed; the helper did not.

    Reproduced against the loaded 12B on 2026-08-10 with Liam's own request: a
    line of new Batman dialogue, answered with a brand-new scene (no Batman, no
    Batcave) — which is exactly what makes the chained render cut away. With
    the flag and the previous shot's prompt, the same model kept the character,
    the location, the palette and the soundscape.
    """
    client = _client(tmp_path, monkeypatch)
    previous = "[Shot 1] Batman sits at a workstation in the Batcave, blue-and-shadow palette."

    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf",
        "idea": "He's in hiding. We've got to find him. Now.",
        "targetModel": "minimax-h3",
        "isContinuation": True,
        "previousPrompt": previous,
    })

    assert response.status_code == 200
    system = captured_system[0]
    assert "CONTINUES the previous one" in system
    assert previous in system, "the helper is told WHAT scene to keep"
    # Visible in the dialog, so a continuation prompt is not mistaken for a fresh one.
    assert response.json()["profileLabel"] == "MiniMax H3 (text to video) · continuing a scene"


def test_a_fresh_shot_is_not_handed_the_continuation_rules(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    client = _client(tmp_path, monkeypatch)
    client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a courier waits for a train",
        "targetModel": "minimax-h3",
    })
    assert "CONTINUES the previous one" not in captured_system[0]


# --- UGC mode ----------------------------------------------------------------
#
# UGC is a LAYER, not a profile: the format a model was trained on does not
# change because the clip is an ad, but nearly every judgement inside it does.
# These pin the inversion (speech becomes required, polish becomes the failure)
# and the mechanical checks that catch a helper reverting to its habits.


def test_ugc_layers_onto_the_model_format_rather_than_replacing_it() -> None:
    """The H3 field interface has to survive UGC mode.

    A UGC clip is still an H3 clip. Losing integrated_multimodal_description to
    a realism instruction would produce a beautifully un-produced prompt in a
    format H3 was never trained to read.
    """
    system = prompt_profiles.system_prompt("minimax-h3-t2v", ugc=True)
    assert "integrated_multimodal_description:" in system
    assert "overall_soundscape:" in system
    assert "UGC clip" in system


def test_ugc_reverses_the_speech_default_out_loud() -> None:
    """Every H3 profile says speech is optional and off by default — correct in
    general, and exactly wrong for a clip whose whole content is someone
    talking. The reversal has to be explicit or the older, longer rule wins."""
    plain = prompt_profiles.system_prompt("minimax-h3-i2v")
    ugc = prompt_profiles.system_prompt("minimax-h3-i2v", ugc=True)
    assert "Speech is OPTIONAL and off by default" in plain
    assert "SPEECH IS REQUIRED here, overriding the default above" in ugc
    # H3 renders a score if asked for one, and scored UGC is instantly an ad.
    assert "non_diegetic_music must be exactly N/A" in ugc


def test_a_ugc_first_frame_gets_the_image_stack_not_the_clip_rules() -> None:
    system = prompt_profiles.system_prompt("image", ugc=True)
    assert "phone front-camera selfie" in system
    assert "visible pores" in system
    assert "Never write \"good lighting\"" in system
    # Clip-only instructions would be noise on a still.
    assert "phone microphone" not in system


def test_ugc_with_reference_pictures_forbids_describing_the_person() -> None:
    """The composer stops writing an invented person into the brief once
    references are attached; the helper has to stop putting one back.

    "One real person filming themselves" reads as an invitation to describe
    one, and a described person beats an attached picture of somebody else —
    a persona of a woman came back as a man in his early 30s (2026-08-13).
    """
    refs = {"images": 4, "videos": [], "audios": 1}
    bound = prompt_profiles.system_prompt("minimax-h3-reference", ugc=True, references=refs)
    assert "ALREADY FIXED by the reference pictures" in bound
    assert "no age, no gender" in bound
    # Still a UGC clip in every other respect.
    assert "SPEECH IS REQUIRED here, overriding the default above" in bound

    # Nothing attached: inventing one specific person is exactly right, and the
    # prohibition would leave the helper with nobody to describe at all.
    unbound = prompt_profiles.system_prompt("minimax-h3-t2v", ugc=True)
    assert "ALREADY FIXED by the reference pictures" not in unbound
    assert prompt_profiles.system_prompt(
        "minimax-h3-reference", ugc=True, references={"images": 0, "videos": [], "audios": 2},
    ).count("ALREADY FIXED") == 0

    # And it is a UGC rule, not a reference rule — an ordinary reference prompt
    # still describes its subjects, because that is how H3 is conditioned.
    assert "ALREADY FIXED by the reference pictures" not in prompt_profiles.system_prompt(
        "minimax-h3-reference", references=refs,
    )


def test_ugc_off_leaves_every_profile_exactly_as_it_was() -> None:
    for profile in ("minimax-h3-t2v", "ltx-video", "ltx-eros-scene-script", "image"):
        assert prompt_profiles.system_prompt(profile) == prompt_profiles.system_prompt(profile, ugc=False)
        assert "UGC" not in prompt_profiles.system_prompt(profile)


def test_ugc_composes_with_the_continuation_rules() -> None:
    """A chained UGC shot is both things at once — the same person still
    talking, in the same room, after the cut."""
    system = prompt_profiles.system_prompt(
        "minimax-h3-t2v", ugc=True, continuation=True, previous_prompt="[Shot 1] a woman in a car",
    )
    assert "CONTINUES the previous one" in system
    assert "SPEECH IS REQUIRED here" in system
    assert prompt_profiles.profile_label("minimax-h3-t2v", continuation=True, ugc=True) == (
        "MiniMax H3 (text to video) · continuing a scene · UGC"
    )


def test_polish_tells_are_the_words_a_helper_reaches_for_by_habit() -> None:
    """These are what a video prompt normally WANTS, which is why the check is
    code rather than one more line competing with the format rules."""
    found = prompt_profiles.ugc_polish_tells(
        "A cinematic handheld shot with soft film grain and flawless skin, shot on a gimbal."
    )
    assert found == ["cinematic", "film grain", "flawless skin", "gimbal"]
    assert prompt_profiles.ugc_polish_tells(
        "She talks to her phone in a parked car, afternoon sun through the windshield."
    ) == []


def test_a_silent_ugc_clip_is_caught_only_where_speech_is_checkable() -> None:
    silent = "[Shot 1] A woman sits in a parked car, moving her hands as she thinks."
    talking = "[Shot 1] (S1) says: <d>[English] no but the weird part is</d>"
    assert prompt_profiles.ugc_missing_speech("minimax-h3-t2v", silent) is True
    assert prompt_profiles.ugc_missing_speech("minimax-h3-t2v", talking) is False
    # LTX carries dialogue as prose, so there is no tag to check for.
    assert prompt_profiles.ugc_missing_speech("ltx-video", silent) is False


def test_a_scored_ugc_clip_is_caught() -> None:
    assert prompt_profiles.ugc_has_music("non_diegetic_music: N/A") is False
    assert prompt_profiles.ugc_has_music("non_diegetic_music: None.") is False
    assert prompt_profiles.ugc_has_music(
        "non_diegetic_music: A warm lo-fi beat rises under the final line."
    ) is True
    # No field at all (a non-H3 prompt) is not a music problem.
    assert prompt_profiles.ugc_has_music("she keeps talking") is False


def test_the_route_pushes_back_once_on_a_prompt_that_reads_as_produced(
    tmp_path: Path, monkeypatch,
) -> None:
    """The repair is asked for, not applied: deleting "cinematic" from a
    sentence by hand leaves the sentence broken, and the beats around it are the
    model's business. One push, then say what survived."""
    drafts = [
        "integrated_multimodal_description: A cinematic shot on a gimbal.\nnon_diegetic_music: A warm beat.",
        "integrated_multimodal_description: [Shot 1] (S1) says: <d>[English] ok so</d>\n"
        "non_diegetic_music: N/A",
    ]
    asks: list[str] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            asks.append(messages[-1]["content"])
            return drafts[min(len(asks) - 1, len(drafts) - 1)]

    monkeypatch.setattr(local_llm, "runtime", FakeRuntime)
    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)

    response = _client(tmp_path, monkeypatch).post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a sleep tracker", "targetModel": "minimax-h3", "ugc": True,
    })

    assert response.status_code == 200
    body = response.json()
    # Every fault was named in the push-back, so the model knows what to fix.
    assert "cinematic" in asks[1] and "gimbal" in asks[1]
    assert "nobody speaks in it" in asks[1]
    assert "non_diegetic_music must be N/A" in asks[1]
    # The corrected draft is what comes back, and nothing is warned about.
    assert body["prompt"] == drafts[1]
    assert body["warnings"] == []
    assert body["profileLabel"] == "MiniMax H3 (text to video) · UGC"


def test_faults_that_survive_the_push_back_are_reported_not_shipped_quietly(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    # captured_system's stand-in returns "written prompt" every time — a clip
    # with nobody talking in it, twice.
    response = _client(tmp_path, monkeypatch).post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a sleep tracker", "targetModel": "minimax-h3", "ugc": True,
    })

    assert response.status_code == 200
    warnings = response.json()["warnings"]
    assert any("nobody speaks in it" in warning for warning in warnings), warnings
    assert all(warning.startswith("Reads as produced rather than filmed:") for warning in warnings)


def test_a_non_ugc_prompt_is_never_checked_for_polish(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    """A silent cinematic clip is a perfectly good ordinary prompt."""
    response = _client(tmp_path, monkeypatch).post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "a courier waits for a train", "targetModel": "minimax-h3",
    })
    assert response.json()["warnings"] == []
    assert "UGC" not in captured_system[0]


def test_picture_roles_carry_a_marker_decision_rule():
    """Listing the four retention markers is not the same as saying which to use.

    The markers were always named; what decided a reference's fate — which one a
    given picture ROLE takes — was left to the model to guess.
    """
    body = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={"images": 2, "videos": [], "audios": 0},
    )
    for role, marker in [
        ("first or last frame", "fully_preserved"),
        ("setting", "partially_preserved"),
        ("attribute_transfer", "attribute_transfer"),
        ("storyboard", "weak_reference"),
    ]:
        assert role in body, f"{role} role is described"
        assert marker in body

    # attribute_transfer is a retention marker, never a summary task type.
    assert "attribute_transfer is a retention marker only" in body
    # The visual task types, which previously only existed for audio.
    assert "[keyframe completion]" in body
    assert "[reference generation]" in body
    # A picture that only shows a likeness belongs inside the subject's line.
    assert "no <Picture N> line of" in body


def test_the_writer_is_told_when_a_run_is_over_the_reference_budget():
    """A split soundtrack is its own reference AND one of the three audio clips.

    Nine pictures plus three clips is exactly twelve; switch the soundtracks on
    and the run is at seventeen with five audio clips, while every per-kind count
    still looks legal on its own.
    """
    over = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={
            "images": 9,
            "videos": [{"useAudio": True}, {"useAudio": True}, {"useAudio": True}],
            "audios": 2,
        },
    )
    assert "over H3's reference budget" in over
    assert "17 references against 12" in over
    assert "5 audio clips against 3" in over
    # It must NOT renumber: the labels have to match what the graph sends.
    assert "renumbering them here" in over

    # A run within budget says nothing about it at all.
    fine = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={"images": 2, "videos": [{"useAudio": True}], "audios": 1},
    )
    assert "reference budget" not in fine


def test_measured_reference_lengths_reach_the_writer():
    """Counts alone cannot say what the borrowed movement actually covers."""
    body = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        duration_seconds=10,
        references={
            "images": 1,
            "videos": [{"useAudio": False, "seconds": 3}],
            "audios": 1,
            "audioSeconds": [4],
        },
    )
    assert "<Video 1> is a motion reference. It runs 3s." in body
    assert "<Audio 1> is a standalone voice or music clip. It runs 4s." in body

    # A motion reference shorter than the shot only drives its opening, so the
    # writer is told to carry the movement past where the reference stops —
    # otherwise the action goes static for the remainder.
    assert "shorter than the 10s clip" in body
    assert "Carry the motion on in your own words" in body

    # A reference that covers the whole clip says nothing about coverage.
    covered = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        duration_seconds=4,
        references={"images": 1, "videos": [{"useAudio": False, "seconds": 8}], "audios": 0},
    )
    assert "Carry the motion on" not in covered


def test_a_clip_with_no_picture_is_the_identity_reference():
    """With no picture attached the first clip is who is on screen, and the
    writer is told so — otherwise it binds identity to pictures that do not
    exist and forbids the only reference it has from carrying the person."""
    body = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        duration_seconds=5,
        references={"images": 0, "videos": [{"useAudio": False, "seconds": 5}], "audios": 0},
    )
    assert "<Video 1> is the IDENTITY reference as well as the motion reference" in body
    assert "<Video 1> is a motion reference." not in body
    # The profile itself carries the rule, whatever the inventory says.
    assert "the first reference video is ALSO the identity" in body
    # With a picture beside it the same clip is a motion reference again.
    pictured = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        duration_seconds=5,
        references={"images": 1, "videos": [{"useAudio": False, "seconds": 5}], "audios": 0},
    )
    assert "<Video 1> is a motion reference." in pictured
    assert "IDENTITY reference" not in pictured
    # A second clip with no picture stays a motion reference; only the first is the person.
    two = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={"images": 0, "videos": [{"useAudio": False}, {"useAudio": False}], "audios": 0},
    )
    assert "<Video 1> is the IDENTITY reference" in two
    assert "<Video 2> is a motion reference." in two


def test_unmeasured_reference_lengths_are_never_printed_as_zero():
    """A file the browser could not demux has NO length, not a length of zero."""
    for missing in (None, 0, -2, "abc", {}):
        body = prompt_profiles.system_prompt(
            "minimax-h3-reference",
            duration_seconds=10,
            references={"images": 1, "videos": [{"useAudio": False, "seconds": missing}], "audios": 0},
        )
        assert "<Video 1> is a motion reference." in body
        assert "runs 0s" not in body, f"{missing!r} was printed as a measurement"
        assert "It runs" not in body
        # And an unmeasured clip must not claim to be shorter than the shot.
        assert "Carry the motion on" not in body


def test_seconds_budget_counts_a_split_soundtrack_twice():
    """A split soundtrack spends from the video AND audio second budgets."""
    body = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        duration_seconds=12,
        references={
            "images": 1,
            "videos": [{"useAudio": True, "seconds": 12}],
            "audios": 1,
            "audioSeconds": [5],
        },
    )
    # 12s video is inside the 15s video budget on its own...
    assert "of video against 15s" not in body
    # ...but its soundtrack plus the 5s clip is 17s of audio.
    assert "17s of audio against 15s" in body


def test_the_persona_gender_tells_the_writer_what_to_call_the_subject() -> None:
    """Without it the helper picks a gender from the idea — usually "she", since
    that is what most of the examples it has seen were — and a male persona's
    prompt comes back about a woman. Applies to every profile; the H3 ones also
    get the label form, since there the subject is <Subject 1>."""
    plain = prompt_profiles.system_prompt("minimax-h3-reference")
    assert "The person on screen is" not in plain

    him = prompt_profiles.system_prompt("minimax-h3-reference", persona_gender="male")
    assert 'The person on screen is a man. Call him "the man" and use he/his' in him
    assert '<Subject 1> is the man shown in <Picture 1>' in him

    her = prompt_profiles.system_prompt("ltx-video", persona_gender="female")
    assert 'The person on screen is a woman. Call her "the woman" and use she/her' in her
    # Only the H3 profiles talk in labels.
    assert "<Subject 1> is the woman shown in" not in her

    them = prompt_profiles.system_prompt("minimax-h3-t2v", persona_gender="nonbinary")
    assert 'use they/them' in them
    assert '<Subject 1> is the person shown in <Picture 1>' in them

    # The studio's own spellings and a few aliases; anything else is unset.
    assert prompt_profiles.normalize_persona_gender("Woman") == "female"
    assert prompt_profiles.normalize_persona_gender("non-binary") == "nonbinary"
    assert prompt_profiles.normalize_persona_gender("dragon") == ""
    assert prompt_profiles.system_prompt("minimax-h3-reference", persona_gender="dragon") == plain
    assert prompt_profiles.system_prompt("minimax-h3-reference", persona_gender=None) == plain


# --- the cast -----------------------------------------------------------------
#
# Who is in the shot, per <Subject N>, the way the studio's compiler
# (castPrompt.js) sees it. persona_gender only ever knew about one person.

_CAST_TWO = [
    # A persona's name is vault-sealed; one arriving here is a bug upstream and
    # must be discarded unread — so a loud one is sent on purpose.
    {"subject": 1, "kind": "persona", "gender": "female", "name": "SEALED-NAME-MUST-NOT-APPEAR",
     "voice": True, "look": "lit from a window on the left"},
    {"subject": 2, "kind": "character", "gender": "", "name": "SpongeBob SquarePants", "voice": True, "look": ""},
]


def test_the_cast_tells_the_writer_who_is_in_the_shot_in_reference_mode() -> None:
    """Reference mode: every member is a <Subject N> the helper addresses only
    by label; a persona's lines take the plain language tag (the clip carries
    the timbre), a known character's voice is named inside the tag, and the
    bookkeeping sections are left to the studio."""
    references = {"images": 2, "audios": 1, "videos": []}
    body = prompt_profiles.system_prompt("minimax-h3-reference", references=references, cast=_CAST_TWO)
    clause = body[body.index("The cast — who is in this shot"):]

    assert "2 members, already labelled. Address every one of them ONLY by its label" in clause
    assert (
        "<Subject 1> is a woman (she/her): a real person, defined only by the attached reference "
        "pictures and clips. A reference clip carries her voice, so her lines take the plain language "
        'tag — "<Subject 1> (Sx) says: <d>[English] …</d>"'
    ) in clause
    # The look steers light and framing, never identity.
    assert "how <Subject 1> is lit and framed, never to re-describe or contradict the references: lit from a window on the left." in clause
    assert "<Subject 2> is SpongeBob SquarePants: a character the model already knows, written under that label." in clause
    # The possessive follows characterVoiceText(): a name ending in s takes a bare apostrophe.
    assert "<d>[English in SpongeBob SquarePants' voice from …] …</d>" in clause
    assert '"[English in SpongeBob SquarePants\' voice]" when the work is unknown' in clause
    # Section ownership, as compileCastPrompt() divides it.
    assert "subject_definitions and retention_analysis are the studio's" in clause
    assert "summary, detailed_description, overall_soundscape and non_diegetic_music are yours" in clause
    assert "every <Subject N> listed above appears in them with something to do" in clause
    assert "A persona is addressed ONLY by its label. Never give it a name" in clause
    # The reference inventory is still there, before the cast.
    assert "<Picture 1> through <Picture 2>" in body
    assert body.index("The run carries exactly these references") < body.index("The cast — who is in this shot")


def test_a_persona_member_with_no_voice_clip_is_said_so() -> None:
    """castPrompt.js writes "speaks as S1, in a woman's voice" when no clone is
    attached — left unsaid, an unvoiced subject comes back as a generic adult
    male whoever is on screen — so the helper is told the same."""
    cast = [{"subject": 1, "kind": "persona", "gender": "male", "voice": False}]
    body = prompt_profiles.system_prompt("minimax-h3-reference", references={"images": 1}, cast=cast)
    assert "<Subject 1> is a man (he/him)" in body
    assert "Nothing carries his voice: a line for <Subject 1> is written only if the brief asks" in body
    assert "in a man's voice" in body
    # A silent known character keeps the plain tag rather than a named voice.
    quiet = prompt_profiles.system_prompt("minimax-h3-reference", references={"images": 1}, cast=[
        {"subject": 1, "kind": "character", "name": "Willow", "voice": False},
    ])
    assert "<Subject 1>'s lines take the plain tag \"<d>[English] …</d>\" — do not name a voice." in quiet
    assert "Willow's voice" not in quiet


def test_the_cast_in_text_mode_describes_a_persona_and_names_a_character() -> None:
    """No references: a persona cannot be rendered, so it is written from its
    look and gender in prose and never given a name; a character is written by
    full name plus source and must appear. Non-H3 profiles get no <d> tags."""
    body = prompt_profiles.system_prompt("minimax-h3-t2v", cast=_CAST_TWO)
    clause = body[body.index("The cast — who is in this shot"):]
    assert "2 members. Every one of them appears in the scene with something to do" in clause
    assert (
        'Subject 1: a woman (she/her), described as "lit from a window on the left" — a real person whose '
        "reference pictures are NOT attached to this run, so write this person from that description and "
        "nothing else. Never give this person a name."
    ) in clause
    assert "<Subject 1>" not in clause
    assert (
        "Subject 2: SpongeBob SquarePants — a character the model already knows. Write SpongeBob SquarePants "
        "by full name plus the work it comes from at first mention, and keep that character in the scene."
    ) in clause
    assert "<d>[English in SpongeBob SquarePants' voice from …] …</d>" in clause

    # Without a look the persona is simply "a woman" / "the woman".
    bare = prompt_profiles.system_prompt("minimax-h3-t2v", cast=[{"kind": "persona", "gender": "female"}])
    assert 'write this person simply as "a woman" / "the woman"' in bare
    unset = prompt_profiles.system_prompt("minimax-h3-t2v", cast=[{"kind": "persona"}])
    assert "Subject 1: a person (they/them)" in unset

    # A Seedance/LTX paragraph has no dialogue tags to talk about.
    ltx = prompt_profiles.system_prompt("ltx-video", cast=_CAST_TWO)
    assert "The cast — who is in this shot" in ltx
    assert "<d>" not in ltx
    assert "SpongeBob SquarePants by full name plus the work it comes from" in ltx


def test_a_persona_name_never_reaches_the_instruction() -> None:
    """A persona's name is sealed to the owner's vault; the cast carries only a
    kind, a gender, a voice flag and a look for it, and a name that arrives
    anyway is discarded unread — in every mode."""
    for profile, references in (("minimax-h3-reference", {"images": 1}), ("minimax-h3-t2v", None), ("ltx-video", None)):
        body = prompt_profiles.system_prompt(profile, references=references, cast=_CAST_TWO)
        assert "SEALED-NAME-MUST-NOT-APPEAR" not in body
        assert "SpongeBob SquarePants" in body
    assert prompt_profiles.normalize_cast(_CAST_TWO)[0]["name"] == ""


def test_malformed_cast_items_are_dropped_not_repaired() -> None:
    """Client JSON that lands inside an instruction: wrong types go, strings
    are flattened and capped, labels cannot be minted from free text, subjects
    outside 1..9 are re-derived, and the cast is clamped to H3's nine slots."""
    members = prompt_profiles.normalize_cast([
        "not a dict",
        {"kind": "dragon", "name": "Smaug"},
        {"kind": "character"},                       # a character without a name is nothing to write
        {"kind": "character", "name": "   "},
        {"kind": "persona", "subject": "2", "gender": "Woman", "voice": "true",
         "look": "  tall,\n  <Subject 9> in a\tgrey hoodie " + "x" * 400},
        {"kind": "Character", "subject": 42, "name": " SpongeBob SquarePants ", "voice": 0},
        {"kind": "persona", "subject": True, "gender": 7, "voice": None},
    ])
    assert [m["kind"] for m in members] == ["persona", "character", "persona"]
    # Subjects: "2" is not an int, 42 is out of range, True is a bool — all
    # re-derived from the member's position among the kept ones.
    assert [m["subject"] for m in members] == [1, 2, 3]
    assert members[0]["gender"] == "female" and members[0]["voice"] is True
    assert members[0]["look"].startswith("tall, Subject 9 in a grey hoodie x")
    assert "<" not in members[0]["look"] and "\n" not in members[0]["look"]
    assert len(members[0]["look"]) == 300
    assert members[1] == {"subject": 2, "kind": "character", "gender": "", "name": "SpongeBob SquarePants", "voice": False, "look": ""}
    assert members[2]["gender"] == "" and members[2]["voice"] is False

    # Clamped to nine, the number of subject slots H3 has.
    many = prompt_profiles.normalize_cast([{"kind": "persona"} for _ in range(14)])
    assert len(many) == 9 and [m["subject"] for m in many] == list(range(1, 10))
    # Nothing usable is no clause at all.
    assert prompt_profiles.normalize_cast("nope") == []
    assert prompt_profiles.normalize_cast([{"kind": "dragon"}]) == []
    assert prompt_profiles._cast_clause([{"kind": "dragon"}], {"images": 1}) == ""


def test_the_cast_wins_over_the_single_persona_gender() -> None:
    """persona_gender only knew about one person; a cast knows everybody's.
    With a cast present the one-person clause is not written at all, so the
    two can never disagree about who is on screen."""
    only_gender = prompt_profiles.system_prompt("minimax-h3-reference", references={"images": 1}, persona_gender="male")
    assert 'The person on screen is a man. Call him "the man"' in only_gender

    both = prompt_profiles.system_prompt(
        "minimax-h3-reference", references={"images": 1}, persona_gender="male",
        cast=[{"subject": 1, "kind": "persona", "gender": "female", "voice": True}],
    )
    assert "The person on screen is" not in both
    assert "<Subject 1> is a woman (she/her)" in both
    # An unusable cast falls back to the single-persona clause, unchanged.
    fallback = prompt_profiles.system_prompt(
        "minimax-h3-reference", references={"images": 1}, persona_gender="male", cast=[{"kind": "dragon"}],
    )
    assert fallback == only_gender


def test_no_cast_leaves_every_instruction_exactly_as_it_was() -> None:
    """The regression guard: the argument defaults to None, and None or an
    empty list must produce the byte-identical instruction the helper wrote
    before the cast existed — for every profile and every other clause."""
    combos = [
        ("minimax-h3-reference", {}),
        ("minimax-h3-reference", {"persona_gender": "female", "duration_seconds": 8,
                                  "references": {"images": 2, "audios": 1, "videos": [{"useAudio": True, "seconds": 4}]}}),
        ("minimax-h3-reference", {"ugc": True, "references": {"images": 1}}),
        ("minimax-h3-t2v", {"persona_gender": "male", "duration_seconds": 6,
                            "character_notes": ["SpongeBob SquarePants — from the animated series SpongeBob SquarePants (1999)"]}),
        ("minimax-h3-i2v", {"ugc": True, "continuation": True, "previous_prompt": "the shot before"}),
        ("ltx-video", {"persona_gender": "nonbinary", "duration_seconds": 5}),
        ("image", {"ugc": True}),
    ]
    for profile, kwargs in combos:
        before = prompt_profiles.system_prompt(profile, **kwargs)
        assert prompt_profiles.system_prompt(profile, cast=None, **kwargs) == before
        assert prompt_profiles.system_prompt(profile, cast=[], **kwargs) == before
        assert "The cast — who is in this shot" not in before


def test_the_route_folds_the_cast_into_the_system_prompt(
    tmp_path: Path, monkeypatch, captured_system,
) -> None:
    """The field rides the generate request and reaches system_prompt; a
    persona's name is discarded before anything is written, and a malformed
    member never reaches the instruction either."""
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "she teases the sponge about his tie",
        "targetModel": "minimax-h3-reference",
        "references": {"images": 1, "videos": [], "audios": 1, "audioSeconds": [3.2]},
        "personaGender": "male",
        "cast": _CAST_TWO + ["garbage", {"kind": "dragon"}],
    })

    assert response.status_code == 200
    system = captured_system[0]
    assert "<Subject 1> is a woman (she/her)" in system
    assert "<Subject 2> is SpongeBob SquarePants" in system
    assert "SEALED-NAME-MUST-NOT-APPEAR" not in system
    assert "dragon" not in system and "garbage" not in system
    # The cast superseded the one-person gender.
    assert "The person on screen is" not in system

    # Absent, the request reads exactly as it always did.
    client.post("/api/prompt-helper/generate", json={
        "modelId": "some-gguf", "idea": "she teases the sponge about his tie",
        "targetModel": "minimax-h3-reference", "references": {"images": 1},
        "personaGender": "male",
    })
    assert "The cast — who is in this shot" not in captured_system[1]
    assert 'The person on screen is a man. Call him "the man"' in captured_system[1]


# ---------------------------------------------------------------------------
# /api/prompt-helper/describe-look — a persona's look, read from its pictures
# ---------------------------------------------------------------------------

_JPEG_URL = "data:image/jpeg;base64,/9j/AAAA"
_PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAA"


class _LookRuntime:
    """A loaded, seeing helper that answers with whatever it was built with."""

    def __init__(self, answer: str, *, loaded=("scout/scout-Q4.gguf",), vision: bool = True) -> None:
        self.answer = answer
        self.loaded = list(loaded)
        self.vision = vision
        self.calls: list[dict] = []

    def loaded_model_ids(self):
        return list(self.loaded)

    def model_sees_images(self, model_id):
        return self.vision

    def chat(self, *, model_id, messages, images=None, image=None, **kwargs):
        self.calls.append({"model_id": model_id, "messages": messages, "images": images,
                           "image": image, **kwargs})
        return self.answer


def _look_client(tmp_path: Path, monkeypatch, runtime) -> TestClient:
    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: runtime)
    return _client(tmp_path, monkeypatch)


def test_describe_look_returns_a_cleaned_one_line_look(tmp_path: Path, monkeypatch) -> None:
    """The happy path, with the slips a small vision model makes undone: a
    quoted, labelled, line-broken answer comes back as one plain line."""
    runtime = _LookRuntime('"Description: a man with short dark hair,\n\na trimmed beard\nand glasses."')
    client = _look_client(tmp_path, monkeypatch, runtime)

    response = client.post("/api/prompt-helper/describe-look", json={
        "images": [_JPEG_URL, _PNG_URL], "gender": "male", "modelId": "scout/scout-Q4.gguf",
    })

    assert response.status_code == 200, response.text
    assert response.json() == {
        "ok": True, "look": "a man with short dark hair, a trimmed beard and glasses.",
    }
    # Both pictures rode the ONE user turn, through the same chat() the prompt
    # helper uses; the gendered instruction was the system turn.
    assert len(runtime.calls) == 1
    call = runtime.calls[0]
    assert call["model_id"] == "scout/scout-Q4.gguf"
    assert call["images"] == [_JPEG_URL, _PNG_URL]
    assert call["messages"][0]["role"] == "system"
    assert '"a man with …"' in call["messages"][0]["content"]
    assert call["messages"][-1]["role"] == "user"
    assert "2 photos" in call["messages"][-1]["content"]


def test_describe_look_uses_whatever_is_loaded_when_no_model_is_named(tmp_path: Path, monkeypatch) -> None:
    runtime = _LookRuntime("a woman with a silver bob.", loaded=("big/vision-Q4.gguf",))
    client = _look_client(tmp_path, monkeypatch, runtime)

    response = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})

    assert response.status_code == 200, response.text
    assert response.json()["look"] == "a woman with a silver bob."
    assert runtime.calls[0]["model_id"] == "big/vision-Q4.gguf"
    assert "one photo" in runtime.calls[0]["messages"][-1]["content"]


@pytest.mark.parametrize("images", [
    [],
    [_JPEG_URL, _JPEG_URL, _JPEG_URL, _JPEG_URL],
    ["https://example.com/photo.jpg"],
    ["data:image/jpeg;base64,"],
    [_JPEG_URL, "not a data url"],
])
def test_describe_look_refuses_bad_pictures_before_asking_the_model(
    tmp_path: Path, monkeypatch, images: list[str],
) -> None:
    """Zero pictures, four pictures, or anything that is not an image data
    URL is a 422 — and the model is never asked."""
    runtime = _LookRuntime("should not be reached")
    client = _look_client(tmp_path, monkeypatch, runtime)

    response = client.post("/api/prompt-helper/describe-look", json={"images": images, "gender": "female"})

    assert response.status_code == 422, response.text
    assert runtime.calls == []
    # The refusal never echoes the pictures back.
    assert _JPEG_URL not in response.text


def test_describe_look_says_so_when_nothing_is_loaded(tmp_path: Path, monkeypatch) -> None:
    runtime = _LookRuntime("unreached", loaded=())
    client = _look_client(tmp_path, monkeypatch, runtime)

    nothing = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})
    assert nothing.status_code == 409
    assert "No helper model is loaded" in nothing.json()["detail"]

    # A named model that is not the loaded one is the same refusal, by name.
    named = client.post("/api/prompt-helper/describe-look", json={
        "images": [_JPEG_URL], "modelId": "other/model.gguf",
    })
    assert named.status_code == 409
    assert named.json()["detail"] == "other/model.gguf is not loaded. Load it first."
    assert runtime.calls == []


def test_describe_look_refuses_a_model_that_cannot_see(tmp_path: Path, monkeypatch) -> None:
    """A blind model would happily describe pictures it was never shown, and
    that answer reads exactly like a real one — so it is refused up front."""
    runtime = _LookRuntime("a man with a beard", vision=False)
    client = _look_client(tmp_path, monkeypatch, runtime)

    response = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "The loaded helper model cannot see pictures — load a vision-capable one "
        "(e.g. Swarm Scout or Qwen3.6)"
    )
    assert runtime.calls == []


@pytest.mark.parametrize("answer", ['""', "```\n```", "   ", "**Description:**"])
def test_describe_look_reports_an_empty_answer_as_a_502(tmp_path: Path, monkeypatch, answer: str) -> None:
    client = _look_client(tmp_path, monkeypatch, _LookRuntime(answer))

    response = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})

    assert response.status_code == 502
    assert response.json()["detail"] == "The helper returned nothing — try again or load a larger model"


def test_describe_look_treats_the_runtimes_empty_answer_the_same_way(tmp_path: Path, monkeypatch) -> None:
    """local_llm.chat raises its own typed error for an empty completion; the
    route turns that into the same 502, not the generate route's 400."""
    class EmptyRuntime(_LookRuntime):
        def chat(self, **kwargs):
            raise local_llm.LocalLlmEmptyAnswer("Local model returned an empty prompt.")

    client = _look_client(tmp_path, monkeypatch, EmptyRuntime("unused"))
    response = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})
    assert response.status_code == 502
    assert "returned nothing" in response.json()["detail"]


def test_describe_look_is_owner_gated(tmp_path: Path, monkeypatch) -> None:
    runtime = _LookRuntime("a man with a beard")
    client = _look_client(tmp_path, monkeypatch, runtime)
    assert client.post("/api/owner/lock").status_code in (200, 204)
    response = client.post("/api/prompt-helper/describe-look", json={"images": [_JPEG_URL]})
    assert response.status_code in (401, 403)
    assert runtime.calls == []


def test_the_look_instruction_fixes_the_noun_to_the_saved_gender() -> None:
    """"a woman with …" / "a man with …" / "a person with …": the same nouns the
    cast writes, so the helper's look and the subject line agree. Unset and
    non-binary both read "a person" — the helper must not assign a gender."""
    female = prompt_profiles.look_system_prompt("female")
    male = prompt_profiles.look_system_prompt("male")
    assert '"a woman with …"' in female and '"a man with …"' not in female
    assert '"a man with …"' in male and '"a woman with …"' not in male
    for unset in ("nonbinary", "", None, "dragon"):
        system = prompt_profiles.look_system_prompt(unset)
        assert '"a person with …"' in system
        assert '"a woman with …"' not in system and '"a man with …"' not in system
    # The shape of the job, whatever the gender.
    for system in (female, male, prompt_profiles.look_system_prompt(None)):
        assert "SAME person" in system
        assert "Never name the person" in system
        assert "Do not mention the photos" in system
        assert "no line breaks" in system and "no lists" in system
        assert "25 to 60 words" in system
    assert "in his thirties" in male and "in her thirties" in female


@pytest.mark.parametrize("raw, expected", [
    ('"A woman with long red hair and freckles."', "A woman with long red hair and freckles."),
    ("**Description:** a man with a beard\n\nand glasses.", "a man with a beard and glasses."),
    ("```\nLook: “a person with curly hair”\n```", "a person with curly hair"),
    ("Here is the description: a woman with a bob.", "a woman with a bob."),
    ("- Appearance — a man with a buzz cut", "a man with a buzz cut"),
    ("", ""),
    ("''", ""),
])
def test_the_look_is_unwrapped_and_flattened(raw: str, expected: str) -> None:
    assert prompt_profiles.normalize_look(raw) == expected


def test_the_look_is_capped_at_a_word_boundary() -> None:
    long = " ".join(f"word{i}," for i in range(200))
    look = prompt_profiles.normalize_look(long)
    assert len(look) <= prompt_profiles.LOOK_MAX_CHARS
    assert not look.endswith(",") and look.endswith(("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"))
    assert look.split()[-1].startswith("word")

