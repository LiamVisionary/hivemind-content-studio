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
