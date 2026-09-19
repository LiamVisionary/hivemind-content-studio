"""What the prompt helper is told about attached references."""

from __future__ import annotations

from hivemind_content_studio import prompt_profiles


def test_the_prompt_helper_is_told_which_reference_labels_exist() -> None:
    """The profile explains the label SCHEME; this says which labels are real.

    Order is not per-kind: a reference video's own soundtrack takes an <Audio N>
    emitted BEFORE its <Video N>, so a clip-with-sound plus one voice clip is
    <Audio 1>, <Video 1>, <Audio 2>. A prompt numbered any other way addresses
    the wrong reference.
    """
    system = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={"images": 9, "videos": [{"useAudio": True}], "audios": 1},
    )
    assert "<Picture 1> through <Picture 9>" in system
    assert "<Audio 1> is the soundtrack of <Video 1>" in system
    assert "<Audio 2> is a standalone voice or music clip" in system
    assert "Do not refer to a label that is not on this list" in system


def test_a_silent_clip_does_not_consume_an_audio_label() -> None:
    quiet = prompt_profiles.system_prompt(
        "minimax-h3-reference",
        references={"images": 2, "videos": [{"useAudio": False}], "audios": 1},
    )
    assert "<Audio 1> is a standalone voice" in quiet
    assert "soundtrack of" not in quiet
    assert "<Picture 1> through <Picture 2>" in quiet


def test_nothing_attached_claims_nothing() -> None:
    plain = prompt_profiles.system_prompt("minimax-h3-reference")
    assert prompt_profiles.system_prompt("minimax-h3-reference", references=None) == plain
    assert prompt_profiles.system_prompt(
        "minimax-h3-reference", references={"images": 0, "videos": [], "audios": 0},
    ) == plain


def test_reference_inventory_only_reaches_the_reference_profile() -> None:
    """A frame-based H3 run has no <Picture N> labels at all — telling it about
    nine of them would promise references the graph never sends."""
    refs = {"images": 9, "videos": [], "audios": 0}
    for profile in ("minimax-h3-t2v", "minimax-h3-i2v", "minimax-h3-fl2v"):
        assert prompt_profiles.system_prompt(profile, references=refs) == \
            prompt_profiles.system_prompt(profile)
