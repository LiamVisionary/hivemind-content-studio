from __future__ import annotations

import json

from auto_clipper.transcripts import parse_subtitle_file, prepare_podcli_transcript


def test_vtt_converts_to_podcli_json(tmp_path):
    vtt = tmp_path / "sample.vtt"
    vtt.write_text(
        "WEBVTT\n\n"
        "1\n"
        "00:00:01.000 --> 00:00:03.000\n"
        "Hello <c>world</c>\n\n"
        "2\n"
        "00:00:03.000 --> 00:00:06.000\n"
        "Second cue here\n",
        encoding="utf-8",
    )

    payload = parse_subtitle_file(vtt, total_duration=12)

    assert payload["duration"] == 12
    assert len(payload["segments"]) == 2
    assert payload["segments"][0]["text"] == "Hello world"
    assert payload["words"][0]["start"] == 1.0


def test_prepare_podcli_transcript_writes_json(tmp_path):
    vtt = tmp_path / "sample.vtt"
    vtt.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTiny sample\n", encoding="utf-8")

    converted = prepare_podcli_transcript(vtt, tmp_path / "out", total_duration=1)

    assert converted is not None
    data = json.loads(converted.read_text(encoding="utf-8"))
    assert data["segments"][0]["text"] == "Tiny sample"
