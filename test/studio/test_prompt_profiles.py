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
