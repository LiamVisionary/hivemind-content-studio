# SPDX-License-Identifier: Apache-2.0
"""`subtitle.create` has to say whether it made a file.

It used to return `None` when faster-whisper was unavailable and nothing at all
on success, and the caller ignored both — so a machine without whisper ran
`subtitle.correct()` over a path that was never written. That does not raise:
`file_to_subtitles` answers `[]` for a missing file, so the run finishes with no
subtitles, no error, and a log line saying "correcting subtitle" as though it
had worked. A silent nothing is the worst of the available failures.

From upstream PR harry0703/MoneyPrinterTurbo#1244, which is the only one of the
seven open there that still applies to this fork.
"""

from __future__ import annotations

import app.services.subtitle as subtitle


def test_create_returns_empty_when_whisper_is_unavailable(monkeypatch):
    monkeypatch.setattr(subtitle, "WhisperModel", None)
    assert subtitle.create(audio_file="does-not-matter.wav", subtitle_file="out.srt") == ""


def test_create_is_annotated_as_returning_a_path():
    """The annotation is the contract the caller now relies on."""
    assert subtitle.create.__annotations__.get("return") is str


def test_the_caller_stops_rather_than_correcting_a_file_that_was_never_written(monkeypatch, tmp_path):
    """The point of the return value: `correct()` must not run on nothing."""
    from app.services import task

    corrected: list = []
    monkeypatch.setattr(task.subtitle, "create", lambda **_: "")
    monkeypatch.setattr(task.subtitle, "correct", lambda **kw: corrected.append(kw))
    # The provider is read from `config.app`, NOT from params. Setting it on the
    # params stub instead left this test taking the `edge` branch and returning
    # early, so it passed with the fix and without it — a test that guarded
    # nothing while looking like it guarded the thing it was named for.
    monkeypatch.setitem(task.config.app, "subtitle_provider", "whisper")

    params = type("P", (), {"subtitle_enabled": True})()
    result = task.generate_subtitle(
        task_id="t", params=params, video_script="a script",
        sub_maker=None, audio_file=str(tmp_path / "a.wav"))

    assert result == ""
    assert corrected == [], "correct() ran over a subtitle file that was never created"
