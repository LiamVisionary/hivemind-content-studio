"""The Story studio's producer: what it asks for, and what it refuses to accept.

The model is a local llama-server that is sometimes an 8B. Every test here is
named after the thing that reaches the studio when the rule below it is
missing — a blank field rendered as an answer, four panels with one action, a
character quietly redescribed after its sheet was already drawn.
"""

from __future__ import annotations

import pytest

from hivemind_content_studio import story_producer


class FakeRuntime:
    """A llama-server that says whatever the test hands it, in order."""

    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)
        self.calls: list[list[dict]] = []

    def chat(self, *, model_id: str, messages: list[dict], **_: object) -> str:
        self.calls.append(messages)
        if not self.answers:
            raise AssertionError("the producer asked more times than the test expected")
        return self.answers.pop(0)


CONCEPTS = (
    '{"concepts": [{"id": "A", "title": "Late Service", "pair": "a driver and a moth", '
    '"hook": "it lands on the fare machine", "friction": "he never looks up", '
    '"reward": "company", "signature": "a torn wingtip"}, '
    '{"id": "B", "title": "Low Tide", "pair": "a fisher and a crab", "hook": "a dropped ring", '
    '"friction": "the tide", "reward": "it is returned", "signature": "one white claw"}]}'
)


def test_every_declared_task_has_an_instruction_a_shape_and_a_check() -> None:
    # A task with no check is a task whose answer is rendered unvalidated, which
    # is how a blank field reaches the studio looking like an answer.
    for task_id in story_producer.task_ids():
        task = story_producer.TASKS[task_id]
        assert task.instruction.strip()
        assert task.schema.strip().startswith("{")
        assert callable(task.check)


def test_the_instruction_forbids_reusing_an_existing_character() -> None:
    prompt = story_producer.system_prompt(story_producer.TASKS["concepts"])

    assert "original IP" in prompt
    assert "Never reuse a named character" in prompt
    assert "JSON only" in prompt


def test_a_fenced_answer_is_repaired_rather_than_rejected() -> None:
    # Told "JSON only", a small model still fences it about a third of the time.
    # Rejecting that would cost the user a retry for a slip with one right answer.
    assert story_producer.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert story_producer.extract_json('Sure — here it is:\n{"a": 1}\nHope that helps') == {"a": 1}


def test_an_answer_with_no_json_at_all_says_so_and_shows_what_came_instead() -> None:
    # "did not answer with JSON" told the owner nothing they could act on.
    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.extract_json("I would rather talk about the weather.")

    assert "prose, not JSON" in str(excinfo.value)
    assert "weather" in str(excinfo.value)


def test_a_brace_inside_a_string_does_not_make_a_whole_answer_look_truncated() -> None:
    # A depth count that is not string-aware unbalances on prose like this and
    # reports a perfectly good answer as cut off.
    answer = story_producer.extract_json('{"hook": "a { in the sign", "n": 1}')

    assert answer["hook"] == "a { in the sign"


# ── truncation: the failure that cost several minutes and reported nothing ──


def test_an_unclosed_think_block_is_not_mined_for_a_half_drafted_answer() -> None:
    """local_llm strips <think>…</think>; an opener with no close survives it.

    Whatever follows is the model still reasoning — often a JSON draft, which a
    brace scan would happily return as the answer.
    """
    with pytest.raises(story_producer.ProducerTruncated) as excinfo:
        story_producer.extract_json('<think>Let me draft {"concepts": [{"id": "A"')

    assert "reasoning" in str(excinfo.value)


def test_a_closed_think_block_before_the_answer_is_dropped_not_parsed() -> None:
    answer = story_producer.extract_json('<think>maybe {"a": 1}</think>\n{"concepts": []}')

    assert answer == {"concepts": []}


def test_a_cut_off_answer_is_reported_as_cut_off_rather_than_as_malformed() -> None:
    with pytest.raises(story_producer.ProducerTruncated) as excinfo:
        story_producer.extract_json('{"beats": [{"from": 0, "to": 5, "action": "she wai')

    assert "ran out of room" in str(excinfo.value)


def test_the_concepts_that_finished_survive_an_answer_that_did_not() -> None:
    """Six concepts out of eight is real work. Discarding it to report a parse
    failure — after minutes of local inference — is the worst outcome."""
    cut = (
        '{"concepts": [{"id": "A", "pair": "a driver and a moth", "hook": "h", "friction": "f", '
        '"reward": "r", "signature": "s"}, {"id": "B", "pair": "a mudlark and a crab", "hook": "h", '
        '"friction": "f", "reward": "r", "signature": "s"}, {"id": "C", "pair": "a porter and a c'
    )

    with pytest.raises(story_producer.ProducerTruncated) as excinfo:
        story_producer.extract_json(cut, list_key="concepts")

    assert len(excinfo.value.salvaged["concepts"]) == 2
    assert excinfo.value.salvaged["concepts"][1]["id"] == "B"


def test_salvage_needs_the_task_to_name_its_list() -> None:
    # Without a list_key there is nothing to recover from, and guessing which
    # array mattered would be how the wrong half of an answer gets kept.
    with pytest.raises(story_producer.ProducerTruncated) as excinfo:
        story_producer.extract_json('{"concepts": [{"id": "A", "pair": "p", "hook": "h"')

    assert excinfo.value.salvaged is None


def test_locked_facts_ride_along_labelled_as_facts_not_folded_into_the_question() -> None:
    messages = story_producer.build_messages(
        story_producer.TASKS["board"],
        "Build a four panel board.",
        {"characters": [{"name": "Rell", "never": "the cuff stripe stays on one arm"}]},
    )

    user = messages[1]["content"]
    assert user.startswith("Already locked — preserve these exactly:")
    assert "the cuff stripe stays on one arm" in user
    assert user.rstrip().endswith("Build a four panel board.")


def test_context_with_no_brief_still_produces_a_usable_turn() -> None:
    messages = story_producer.build_messages(story_producer.TASKS["contract"], "", {"concept": {"id": "A"}})

    assert "Already locked" in messages[1]["content"]


def test_a_good_answer_comes_back_parsed() -> None:
    runtime = FakeRuntime(CONCEPTS)

    answer = story_producer.produce(model_id="m", task_id="concepts", brief="two ideas", runtime=runtime)

    assert len(answer.payload["concepts"]) == 2
    assert answer.payload["concepts"][0]["signature"] == "a torn wingtip"
    assert answer.notes == ()
    assert len(runtime.calls) == 1


def test_a_salvaged_answer_comes_back_with_a_note_and_costs_no_second_run() -> None:
    """Two usable concepts beat five more minutes of inference for eight."""
    cut = (
        '{"concepts": [{"id": "A", "pair": "p", "hook": "h", "friction": "f", "reward": "r", '
        '"signature": "s"}, {"id": "B", "pair": "p", "hook": "h", "friction": "f", "reward": "r", '
        '"signature": "s"}, {"id": "C", "pair": "a porter and'
    )
    runtime = FakeRuntime(cut)

    answer = story_producer.produce(model_id="m", task_id="concepts", brief="", runtime=runtime)

    assert len(answer.payload["concepts"]) == 2
    assert "ran out of room" in answer.notes[0]
    assert len(runtime.calls) == 1


def test_a_cut_off_answer_is_asked_for_SHORTER_not_asked_for_again() -> None:
    """Repeating the same ask at the same size runs out of room in the same place."""
    runtime = FakeRuntime('{"concepts": [{"id": "A", "pair": "a driver and a mo', CONCEPTS)

    answer = story_producer.produce(model_id="m", task_id="concepts", brief="", runtime=runtime)

    assert len(runtime.calls) == 2
    ask = runtime.calls[1][-1]["content"]
    assert "cut off" in ask
    assert "at most half" in ask
    # Not the pointed-complaint retry: the model's own broken answer is NOT
    # replayed back at it, because re-reading it costs context it needs.
    assert all(turn["role"] != "assistant" for turn in runtime.calls[1])
    assert "asked for shorter" in answer.notes[0]


def test_each_task_gets_a_budget_that_fits_its_answer() -> None:
    """The shared default is 2048. Eight concepts of six prose fields do not fit
    it, and overrunning does not error — it returns truncated text after minutes."""
    for task_id in story_producer.task_ids():
        assert story_producer.TASKS[task_id].max_tokens > 2048

    # The two biggest answers this studio asks for.
    assert story_producer.TASKS["concepts"].max_tokens >= 6000
    assert story_producer.TASKS["board"].max_tokens >= 6000


def test_the_budget_and_a_workable_timeout_actually_reach_the_model() -> None:
    class RecordingRuntime(FakeRuntime):
        def chat(self, *, model_id, messages, **kwargs):
            self.kwargs = kwargs
            return super().chat(model_id=model_id, messages=messages)

    runtime = RecordingRuntime(CONCEPTS)
    story_producer.produce(model_id="m", task_id="concepts", brief="", runtime=runtime)

    assert runtime.kwargs["max_tokens"] == story_producer.TASKS["concepts"].max_tokens
    # 180s (the shared default) is not enough for a 6000-token answer from a
    # reasoning model, and a timeout reads to the user exactly like a hang.
    assert runtime.kwargs["timeout"] >= 600


def test_the_retry_names_what_was_wrong_instead_of_asking_again_blindly() -> None:
    # A blind retry of a model that just returned prose returns prose again.
    runtime = FakeRuntime("here are some lovely ideas", CONCEPTS)

    story_producer.produce(model_id="m", task_id="concepts", brief="two ideas", runtime=runtime)

    assert len(runtime.calls) == 2
    complaint = runtime.calls[1][-1]["content"]
    assert "could not be used" in complaint
    assert story_producer.TASKS["concepts"].schema in complaint


def test_two_bad_answers_raise_with_the_reason_the_owner_can_act_on() -> None:
    runtime = FakeRuntime("nope", "still nope")

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="concepts", brief="", runtime=runtime)

    # The message has to carry the evidence. "The producer did not answer with
    # JSON" was true, unactionable, and indistinguishable from four other causes.
    assert "prose, not JSON" in str(excinfo.value)
    assert "still nope" in str(excinfo.value)


def test_a_concept_missing_its_signature_detail_is_refused() -> None:
    # The signature is the whole point of the concept stage: without one there
    # is nothing to lock, and the sheet stage has nothing to hold on to.
    bad = '{"concepts": [{"pair": "a driver and a moth", "hook": "x", "friction": "y", "reward": "z", "signature": ""}, {"pair": "b", "hook": "x", "friction": "y", "reward": "z", "signature": "s"}]}'
    runtime = FakeRuntime(bad, CONCEPTS)

    story_producer.produce(model_id="m", task_id="concepts", brief="", runtime=runtime)

    assert "signature" in runtime.calls[1][-1]["content"]


def test_a_contract_with_a_blank_part_is_refused_before_it_reaches_the_studio() -> None:
    blank = ('{"contract": {"pressure": "a", "who": "b", "goal": "c", "other": "d", '
             '"behavior": "", "reward": "f"}, "characters": [{"name": "n", "silhouette": "s", '
             '"face": "f", "signature": "g", "never": "h"}]}')
    runtime = FakeRuntime(blank, blank)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="contract", brief="", runtime=runtime)

    assert "behavior" in str(excinfo.value)


def test_a_character_with_no_never_change_list_is_refused() -> None:
    missing = ('{"contract": {"pressure": "a", "who": "b", "goal": "c", "other": "d", '
               '"behavior": "e", "reward": "f"}, "characters": [{"name": "n", "silhouette": "s", '
               '"face": "f", "signature": "g", "never": ""}]}')
    runtime = FakeRuntime(missing, missing)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="contract", brief="", runtime=runtime)

    assert "never" in str(excinfo.value)


def test_a_location_with_nothing_that_can_move_is_refused() -> None:
    still = ('{"directions": [{"place": "a shelter", "time": "dusk", "depth": "a to b", '
             '"lights": "one lamp", "motion": []}, {"place": "a pier", "time": "dawn", '
             '"depth": "c to d", "lights": "two", "motion": ["mist"]}]}')
    runtime = FakeRuntime(still, still)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="location", brief="", runtime=runtime)

    assert "nothing that can move" in str(excinfo.value)


def test_four_panels_with_one_repeated_action_is_refused() -> None:
    # This is the exact failure the board stage exists to prevent: four panels
    # that are one held frame with cuts in it.
    same = ('{"panels": [{"job": "Hook", "verb": "she waits", "reason": "a"}, '
            '{"job": "Turn", "verb": "she waits", "reason": "b"}]}')
    runtime = FakeRuntime(same, same)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="board", brief="", runtime=runtime)

    assert "same action" in str(excinfo.value)


def test_beats_without_a_named_force_are_refused() -> None:
    # "Everything moves a bit" is what the animated-poster failure looks like.
    forceless = '{"force": "", "beats": [{"from": 0, "to": 5, "action": "she waits"}]}'
    runtime = FakeRuntime(forceless, forceless)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="beats", brief="", runtime=runtime)

    assert "force" in str(excinfo.value)


def test_a_beat_with_no_numeric_timing_is_refused() -> None:
    untimed = '{"force": "wind", "beats": [{"from": "start", "to": "later", "action": "she waits"}]}'
    runtime = FakeRuntime(untimed, untimed)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="beats", brief="", runtime=runtime)

    assert "numeric" in str(excinfo.value)


def test_an_unknown_task_is_refused_before_a_model_is_asked_anything() -> None:
    runtime = FakeRuntime()

    with pytest.raises(story_producer.StoryProducerError):
        story_producer.produce(model_id="m", task_id="storyboard", brief="", runtime=runtime)

    assert runtime.calls == []


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


def test_the_route_returns_the_parsed_answer(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    runtime = FakeRuntime(CONCEPTS)
    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: runtime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/story/producer", json={
        "modelId": "gguf", "task": "concepts", "brief": "a driver and a moth",
    }).json()

    assert body["ok"] is True
    assert body["task"] == "concepts"
    assert len(body["result"]["concepts"]) == 2


def test_the_route_hands_a_salvaged_answer_over_with_the_note_attached(tmp_path, monkeypatch) -> None:
    """The studio has to be able to say "six of eight" rather than showing six
    as if they were what was asked for."""
    from hivemind_content_studio import control_api

    cut = (
        '{"concepts": [{"id": "A", "pair": "p", "hook": "h", "friction": "f", "reward": "r", '
        '"signature": "s"}, {"id": "B", "pair": "p", "hook": "h", "friction": "f", "reward": "r", '
        '"signature": "s"}, {"id": "C", "pair": "a porter and'
    )
    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: FakeRuntime(cut))
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/story/producer", json={
        "modelId": "gguf", "task": "concepts", "brief": "x",
    }).json()

    assert len(body["result"]["concepts"]) == 2
    assert "ran out of room" in body["notes"][0]


def test_the_route_reports_a_cut_off_answer_as_cut_off(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api.local_llm, "runtime",
                        lambda: FakeRuntime('<think>still thinking', '<think>still thinking'))
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/story/producer", json={"modelId": "gguf", "task": "concepts", "brief": "x"})

    assert response.status_code == 400
    # Actionable: it names what to change, not just that something went wrong.
    assert "reasoning" in response.json()["detail"]


def test_the_route_refuses_an_unknown_task_and_says_which_are_known(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    runtime = FakeRuntime()
    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: runtime)
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/story/producer", json={"modelId": "gguf", "task": "vibes"})

    assert response.status_code == 400
    assert "concepts" in response.json()["detail"]
    # Nothing was asked of a model, so nothing was loaded to answer a typo.
    assert runtime.calls == []


def test_a_producer_failure_is_a_400_the_owner_can_act_on(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: FakeRuntime("prose", "more prose"))
    client = _client(tmp_path, monkeypatch)

    response = client.post("/api/story/producer", json={"modelId": "gguf", "task": "concepts", "brief": "x"})

    assert response.status_code == 400
    assert "JSON" in response.json()["detail"]


def test_the_route_needs_the_owner(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: FakeRuntime(CONCEPTS))
    client = _client(tmp_path, monkeypatch)
    client.cookies.clear()

    response = client.post("/api/story/producer", json={"modelId": "gguf", "task": "concepts"})

    assert response.status_code in (401, 403)


# ── fill: writing named blanks from everything already written ───────────────


def test_the_fill_instruction_forbids_contradicting_a_locked_decision() -> None:
    prompt = story_producer.system_prompt(story_producer.TASKS["fill"])

    # The whole point of the contract and the never-change lists is that later
    # stages quote them. A fill that overrides one is worse than a blank.
    assert "never-change" in prompt
    assert "Never contradict" in prompt
    # And the value itself, not a sentence about the value.
    assert "no field name" in prompt


def test_a_fill_that_writes_nothing_is_refused() -> None:
    empty = '{"values": {"location.time": "", "location.weather": "   "}}'
    runtime = FakeRuntime(empty, empty)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="fill", brief="", runtime=runtime)

    assert "empty" in str(excinfo.value)


def test_a_fill_drops_the_blanks_and_keeps_what_was_written() -> None:
    runtime = FakeRuntime('{"values": {"location.time": "2am", "location.weather": ""}}')

    answer = story_producer.produce(model_id="m", task_id="fill", brief="", runtime=runtime)

    assert answer.payload["values"] == {"location.time": "2am"}


def test_a_fill_with_no_values_object_is_refused_rather_than_read_as_empty() -> None:
    bad = '{"location.time": "2am"}'
    runtime = FakeRuntime(bad, bad)

    with pytest.raises(story_producer.StoryProducerError) as excinfo:
        story_producer.produce(model_id="m", task_id="fill", brief="", runtime=runtime)

    assert "values" in str(excinfo.value)


def test_what_is_already_written_rides_as_facts_to_preserve(tmp_path, monkeypatch) -> None:
    from hivemind_content_studio import control_api

    runtime = FakeRuntime('{"values": {"location.time": "2am"}}')
    monkeypatch.setattr(control_api.local_llm, "runtime", lambda: runtime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/story/producer", json={
        "modelId": "gguf", "task": "fill",
        "brief": "Write this one field:\n- location.time (Time): Time of day.",
        "context": {"contract.behavior": "landing on the ticket he never printed"},
    }).json()

    assert body["result"]["values"] == {"location.time": "2am"}
    user_turn = runtime.calls[0][1]["content"]
    assert "preserve these exactly" in user_turn
    assert "landing on the ticket he never printed" in user_turn
    assert "location.time" in user_turn


def test_a_cut_off_fill_keeps_the_fields_that_finished() -> None:
    """The reported failure: a section fill of seventeen fields ran for minutes
    and left every box empty. The fields that DID finish are independent of each
    other and of the one that was mid-sentence — throwing them away is the worst
    of both outcomes."""
    cut = (
        '{"values": {"motion.force": "a draught under the shutter", '
        '"motion.layers.subject": "she leans into it and holds still", '
        '"motion.layers.cloth": "the coat hem lifts and set'
    )
    runtime = FakeRuntime(cut)

    answer = story_producer.produce(model_id="m", task_id="fill", brief="", runtime=runtime)

    assert answer.payload["values"] == {
        "motion.force": "a draught under the shutter",
        "motion.layers.subject": "she leans into it and holds still",
    }
    # Asked once, not twice: a second ask at the same size runs out in the same
    # place, and the caller can ask again for only what is still blank.
    assert len(runtime.calls) == 1
    assert answer.notes and "ran out of room" in answer.notes[0]


def test_salvage_stops_at_the_pair_that_was_being_written() -> None:
    body = '{"values": {"a": "one", "b": "tw'
    assert story_producer.salvage_pairs(body, "values") == {"a": "one"}

    # A value that is not a string, and a key with nothing behind it, end the
    # scan rather than being guessed at.
    assert story_producer.salvage_pairs('{"values": {"a": "one", "b": 3, "c": "three"}}', "values") == {"a": "one"}
    assert story_producer.salvage_pairs('{"values": {"a": "one", "b"', "values") == {"a": "one"}
    assert story_producer.salvage_pairs('{"other": {"a": "one"}}', "values") == {}
    assert story_producer.salvage_pairs('{"values": {"a": "one"}}', "") == {}


def test_a_shorter_retry_never_asks_a_fill_to_drop_fields() -> None:
    """"Give at most half as many entries" is right for eight concepts and wrong
    for a fill, where dropping half the fields IS the failure being retried."""
    cut = '{"values": {"a": "unfinis'
    runtime = FakeRuntime(cut, '{"values": {"a": "one", "b": "two"}}')

    story_producer.produce(model_id="m", task_id="fill", brief="", runtime=runtime)

    retry = runtime.calls[1][-1]["content"]
    assert "half as many" not in retry
    assert "do not drop any of them" in retry
