"""The Apple-silicon transcription path: shape, engine choice, and fallback.

faster-whisper runs on CTranslate2, which has no Metal or CoreML backend, so on
a Mac it transcribes on CPU cores whatever `whisper.device` says. Measured on a
42.3s speech clip with large-v3 and this module's own settings: 32.27s on
faster-whisper against 3.53s on MLX — the same detected language and the same
transcript text. These tests pin the parts of that swap that can silently rot;
the speed itself is not asserted here because a timing assertion on a shared
machine is a flaky test, not a guarantee.
"""

import sys
import types

import pytest

from app.services import subtitle


def test_the_adapter_gives_mlx_output_the_shape_the_srt_builder_reads():
    """mlx-whisper answers with dicts; the builder uses attribute access.

    The builder's punctuation-splitting decides where subtitles break, so it is
    the part worth not rewriting — the adapter exists to keep it untouched.
    """
    raw = {
        "text": " The studio renders music locally.",
        "start": 0.0,
        "end": 2.5,
        "words": [
            {"word": " The", "start": 0.0, "end": 0.2, "probability": 0.9},
            {"word": " studio.", "start": 0.2, "end": 0.8, "probability": 1.0},
        ],
    }
    segment = subtitle._Segment(raw)
    assert segment.start == 0.0 and segment.end == 2.5
    assert len(segment.words) == 2
    first = segment.words[0]
    # Attribute access, and real floats — mlx-whisper hands back numpy scalars,
    # which format differently and would leak np.float64(...) into a log line.
    assert first.word == " The"
    assert isinstance(first.start, float) and isinstance(first.end, float)
    assert segment.words[1].word.endswith(".")


def test_a_segment_with_no_words_does_not_explode():
    """Whisper emits word-less segments for music and noise; the builder skips
    them, but only if `words` is an empty list rather than None."""
    segment = subtitle._Segment({"text": "", "start": 1.0, "end": 2.0})
    assert segment.words == []


def test_language_confidence_is_reported_as_unknown_not_invented():
    """The log line prints `language_probability:.2f`. mlx-whisper does not
    report one, and claiming 1.0 would make the log assert a confidence nobody
    measured."""
    info = subtitle._Info({"language": "en"})
    assert info.language == "en"
    assert info.language_probability == 0.0


@pytest.mark.parametrize(
    "choice, has_mlx, expected",
    [
        ("faster-whisper", True, False),   # pinned off even when available
        ("mlx", True, True),               # pinned on
        ("auto", False, False),            # not installed -> never chosen
    ],
)
def test_engine_choice_is_honoured(monkeypatch, choice, has_mlx, expected):
    monkeypatch.setattr(subtitle, "engine_choice", choice)
    monkeypatch.setattr(subtitle, "mlx_whisper", object() if has_mlx else None)
    assert subtitle._use_mlx() is expected


def test_auto_picks_mlx_only_on_apple_silicon(monkeypatch):
    monkeypatch.setattr(subtitle, "engine_choice", "auto")
    monkeypatch.setattr(subtitle, "mlx_whisper", object())
    monkeypatch.setattr(subtitle.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(subtitle.platform, "machine", lambda: "arm64")
    assert subtitle._use_mlx() is True
    monkeypatch.setattr(subtitle.platform, "machine", lambda: "x86_64")
    assert subtitle._use_mlx() is False
    monkeypatch.setattr(subtitle.platform, "system", lambda: "Linux")
    monkeypatch.setattr(subtitle.platform, "machine", lambda: "aarch64")
    assert subtitle._use_mlx() is False


def test_a_known_model_size_maps_to_a_real_mlx_repo():
    assert subtitle._mlx_repo_for("large-v3") == "mlx-community/whisper-large-v3-mlx"
    # An unlisted size still produces a plausible repo rather than crashing;
    # a wrong repo is caught at load time and falls back to faster-whisper.
    assert subtitle._mlx_repo_for("tiny.en").startswith("mlx-community/")


def test_mlx_transcribe_compensates_for_the_vad_it_does_not_have(monkeypatch):
    """faster-whisper is called with vad_filter=True and mlx-whisper has no VAD.

    Dropping it silently is the one way this swap makes subtitles WORSE rather
    than faster — Whisper writes confident text over silence. These two options
    are the replacement, so they are pinned: `hallucination_silence_threshold`
    skips silent stretches, and `condition_on_previous_text=False` stops one
    hallucination from seeding the next window.
    """
    captured = {}

    def fake_transcribe(audio, **kwargs):
        captured.update(kwargs)
        return {"segments": [], "language": "en"}

    monkeypatch.setattr(subtitle, "mlx_whisper", types.SimpleNamespace(transcribe=fake_transcribe))
    subtitle._transcribe_mlx("/tmp/whatever.wav")
    assert captured["word_timestamps"] is True, "the threshold below only works with word timings"
    assert captured["condition_on_previous_text"] is False
    assert captured["hallucination_silence_threshold"] > 0
