from __future__ import annotations

import pytest

from auto_clipper.llm_json import LlmJsonError, parse_json_response, parse_list, parse_object


def test_parses_a_fenced_block():
    assert parse_json_response('```json\n[{"id": "clip-01"}]\n```') == [{"id": "clip-01"}]


def test_parses_a_bare_body():
    assert parse_json_response('[{"id": "clip-01", "score": 0.5}]') == [
        {"id": "clip-01", "score": 0.5}
    ]


def test_strips_preamble_and_trailing_prose():
    raw = (
        "Sure! Here is the JSON you asked for:\n\n"
        '```json\n[{"id": "clip-01", "score": 0.9}]\n```\n\n'
        "Let me know if you want these reordered."
    )
    assert parse_json_response(raw) == [{"id": "clip-01", "score": 0.9}]


def test_falls_back_to_scanning_for_the_outermost_structure():
    raw = 'Scores below.\n[{"id": "clip-01", "score": 0.4}]\nThat is my answer.'
    assert parse_json_response(raw) == [{"id": "clip-01", "score": 0.4}]


def test_strips_control_characters():
    assert parse_json_response('[{"id": "clip-01"\x00}]') == [{"id": "clip-01"}]


def test_unwraps_a_single_list_valued_object():
    assert parse_list('{"clips": [{"id": "clip-01"}]}') == [{"id": "clip-01"}]


def test_drops_non_object_members_of_a_list():
    assert parse_list('["noise", {"id": "clip-01"}]') == [{"id": "clip-01"}]


def test_parse_object_rejects_a_list():
    with pytest.raises(LlmJsonError):
        parse_object('[{"id": "clip-01"}]')


def test_parse_list_rejects_an_object():
    with pytest.raises(LlmJsonError):
        parse_list('{"hook": "a", "caption": "b"}')


@pytest.mark.parametrize("raw", ["", "   ", "I cannot help with that.", "```json\nnot json\n```"])
def test_unparseable_input_raises(raw: str):
    with pytest.raises(LlmJsonError):
        parse_json_response(raw)


def test_already_quoted_keys_survive():
    """The donor's repair pass corrupted this exact shape.

    zhouxiaoka/autoclip rewrites every identifier-followed-by-colon into a
    quoted key without checking whether it is already quoted, turning
    `"start_time":` into `""start_time"":`. We dropped that pass; this test is
    the reason it stays dropped.
    """
    raw = '[{"start_time": "01:10:25,500", "end_time": "01:12:30,800", "id": "clip-01"}]'
    assert parse_json_response(raw) == [
        {"start_time": "01:10:25,500", "end_time": "01:12:30,800", "id": "clip-01"}
    ]
