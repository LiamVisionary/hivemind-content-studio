"""Word-anchored composition: parsing, alignment, and the re-flow property.

The last test in this file is the one that matters. Everything else exists to
make it trustworthy.
"""

import pytest

from hivemind_content_studio.semantic_time import ScriptError, align, parse_script


def heard(text, *, start=0.0, step=0.5, spoken=0.4):
    """Fake transcription output in the shape mlx-whisper returns."""
    return [
        {"word": word, "start": start + i * step, "end": start + i * step + spoken}
        for i, word in enumerate(text.split())
    ]


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def test_segments_and_roles_split_turns():
    script = parse_script("<exchange><HOST>Let me show you.<GUEST>That looks easier.</exchange>")
    assert [s.name for s in script.segments] == ["exchange"]
    assert script.segment("exchange").dialogue == "HOST: Let me show you.\nGUEST: That looks easier."


def test_dual_text_separates_display_from_pronunciation():
    script = parse_script("<opening><HOST>It uses an <API | A P I> here.</opening>")
    segment = script.segment("opening")
    assert "A P I" in segment.dialogue
    assert "API" in segment.caption_text
    assert "A P I" not in segment.caption_text


def test_dual_text_shorthand_uses_one_wording_for_both():
    script = parse_script("<opening><HOST>We <componentise|> it.</opening>")
    segment = script.segment("opening")
    assert "componentise" in segment.speech
    assert "componentise" in segment.caption_text


def test_dual_text_with_empty_display_is_heard_but_never_captioned():
    script = parse_script("<opening><HOST>Ready < | under his breath> now.</opening>")
    segment = script.segment("opening")
    assert "under his breath" in segment.speech
    assert "under" not in segment.caption_text


def test_punctuation_stays_with_its_word_across_a_marker():
    # A marker takes no time, so it must not turn the comma into its own unit.
    script = parse_script("<hook><HOST>the useful part @{/proof}, and more</hook>".replace("@{/proof}", "@{p}x@{/p}"))
    assert all("," != token.spoken for token in script.spoken_tokens)


def test_word_attributes_attach_to_the_preceding_word():
    script = parse_script("<hook><HOST>This is huge{emphasis,importance=2} today.</hook>")
    huge = next(t for t in script.spoken_tokens if t.display.startswith("huge"))
    assert huge.display == "huge"
    assert huge.attributes == {"emphasis": True, "importance": 2}


def test_cjk_prose_needs_no_spaces():
    script = parse_script("<hook><HOST>把动效组件化。</hook>")
    # Six characters, six units — and the full stop rides on the last one.
    assert [t.spoken for t in script.spoken_tokens] == ["把", "动", "效", "组", "件", "化。"]


def test_escapes_survive_into_the_text():
    script = parse_script("<social><HOST>Follow us \\@hypit.</social>")
    assert "@hypit." in script.segment("social").caption_text


def test_comments_enter_no_projection():
    script = parse_script("<!-- a note --><hook><HOST>Only this.</hook>")
    assert script.segment("hook").speech == "Only this."


def test_wordless_segment_keeps_its_identity():
    script = parse_script("<pause/><hook><HOST>After.</hook>")
    assert [s.name for s in script.segments] == ["pause", "hook"]
    assert script.segment("pause").spoken_tokens == []


@pytest.mark.parametrize(
    "source, message",
    [
        ("<hook><HOST>Unclosed.", "never closed"),
        ("<hook><HOST>Words @{/ghost}.</hook>", "never opened"),
        ("<hook><HOST>@{a}one@{/a} @{a}two@{/a}</hook>", "used twice"),
        ("Stray words", "outside a segment"),
    ],
)
def test_bad_scripts_say_what_is_wrong(source, message):
    with pytest.raises(ScriptError) as error:
        parse_script(source)
    assert message in str(error.value)


# --------------------------------------------------------------------------
# Caption cues
# --------------------------------------------------------------------------


def test_cue_breaks_come_from_author_role_and_segment():
    script = parse_script(
        "<hook><HOST>First part || second part.<GUEST>My turn.</hook><close><HOST>The end.</close>"
    )
    cues = [" ".join(t.display for t in cue) for cue in script.caption_cues()]
    assert cues == ["First part", "second part.", "My turn.", "The end."]


# --------------------------------------------------------------------------
# Alignment
# --------------------------------------------------------------------------


def test_exact_delivery_takes_the_heard_times():
    script = parse_script("<hook><HOST>one two three</hook>")
    take = align(script, heard("one two three"))
    assert [(t.start, t.end) for t in take.tokens] == [(0.0, 0.4), (0.5, 0.9), (1.0, 1.4)]


def test_a_misheard_word_is_interpolated_not_desynced():
    # The voice said "usable"; the script says "useful". Everything after it
    # must still land on its own real time.
    script = parse_script("<hook><HOST>the useful part today</hook>")
    take = align(script, heard("the usable part today"))
    assert take.tokens[0].start == 0.0  # the
    assert take.tokens[2].start == 1.0  # part, still exactly where it was heard
    assert take.tokens[3].start == 1.5  # today, unaffected
    assert 0.4 <= take.tokens[1].start <= 1.0  # useful, placed in the gap


def test_a_dropped_word_shares_its_neighbours_gap():
    script = parse_script("<hook><HOST>one two three four</hook>")
    take = align(script, heard("one three four"))  # "two" never transcribed
    two = take.tokens[1]
    assert two.start is not None and two.end is not None
    assert take.tokens[0].end <= two.start <= take.tokens[2].start


def test_alignment_offset_shifts_a_take_onto_the_programme_clock():
    script = parse_script("<hook><HOST>one two</hook>")
    take = align(script, heard("one two"), offset=10.0)
    assert take.tokens[0].start == 10.0


def test_one_segment_can_be_aligned_alone():
    script = parse_script("<a><HOST>one two</a><b><HOST>three four</b>")
    take = align(script, heard("three four"), segment="b", offset=5.0)
    assert [t.spoken for t in take.tokens] == ["three", "four"]
    assert take.tokens[0].start == 5.0


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------


def test_a_selection_spans_exactly_its_words():
    script = parse_script("<hook><HOST>Here is @{proof} the useful part @{/proof} now.</hook>")
    take = align(script, heard("Here is the useful part now."))
    window = take.window(during="selection.proof")
    assert window.start == 1.0  # "the"
    assert window.end == pytest.approx(2.4)  # end of "part"


def test_a_moment_lands_on_its_word():
    script = parse_script("<hook><HOST>and @{verdict!} that is why</hook>")
    take = align(script, heard("and that is why"))
    assert take.instant("moment.verdict") == 0.5  # "that"


def test_a_leading_tilde_moves_a_marker_to_the_previous_words_end():
    script = parse_script("<hook><HOST>one @{~beat!} two</hook>")
    take = align(script, heard("one two"))
    assert take.instant("moment.beat") == 0.4  # end of "one", not start of "two"


def test_windows_take_offsets_and_literal_durations():
    script = parse_script("<hook><HOST>and @{cue!} that is why</hook>")
    take = align(script, heard("and that is why"))
    assert take.instant("moment.cue + 12f", fps=30) == pytest.approx(0.9)
    assert take.window(at="moment.cue", for_="250ms").end == pytest.approx(0.75)
    assert take.window(until="moment.cue", for_="10f", fps=30).start == pytest.approx(0.1666, abs=1e-3)
    plain = take.window(at="2s", for_="1s")
    assert (plain.start, plain.end) == (2.0, 3.0)


def test_program_and_segment_resolve_as_spans():
    script = parse_script("<hook><HOST>one two</hook>")
    take = align(script, heard("one two"))
    assert (take.window(during="program").start, take.window(during="program").end) == (0.0, 0.9)
    assert (take.window(during="segment.hook").start, take.window(during="segment.hook").end) == (0.0, 0.9)


def test_frames_are_end_exclusive_for_a_renderer():
    script = parse_script("<hook><HOST>@{beat} one two @{/beat}</hook>")
    take = align(script, heard("one two"))
    assert take.window(during="selection.beat").frames(30) == (0, 27)


def test_cues_carry_their_own_words_for_a_karaoke_treatment():
    script = parse_script("<hook><HOST>First part || second part.</hook>")
    take = align(script, heard("First part second part."))
    cues = take.cues()
    assert [c["text"] for c in cues] == ["First part", "second part."]
    assert [w["text"] for w in cues[0]["words"]] == ["First", "part"]
    assert cues[0]["start"] == 0.0


def test_an_unknown_name_is_an_error_not_a_zero():
    script = parse_script("<hook><HOST>one two</hook>")
    take = align(script, heard("one two"))
    with pytest.raises(KeyError):
        take.window(during="selection.nothing")


# --------------------------------------------------------------------------
# The point of all of it
# --------------------------------------------------------------------------


def test_rewriting_the_line_moves_every_element_that_pointed_at_it():
    """Change the words; the composition re-times itself.

    This is what a timestamped composition cannot do. Both variants place the
    same overlay with the same one-line source, and it lands on the right words
    in each, because the anchor names meaning rather than a second.
    """
    source = "<hook><HOST>LEAD @{proof} it runs overnight @{/proof} and @{verdict!} that is the point.</hook>"

    short = align(
        parse_script(source.replace("LEAD", "Look:")),
        heard("Look: it runs overnight and that is the point."),
    )
    long = align(
        parse_script(source.replace("LEAD", "Here is the thing I keep having to explain:")),
        heard("Here is the thing I keep having to explain: it runs overnight and that is the point."),
    )

    # The overlay is authored once, against the name.
    short_proof = short.window(during="selection.proof")
    long_proof = long.window(during="selection.proof")

    # It starts much later in the long variant, and nobody edited a timing.
    assert long_proof.start > short_proof.start + 3.0
    # It still covers the same three words, so it is the same length.
    assert long_proof.duration == pytest.approx(short_proof.duration, abs=0.01)
    # And the beat after it moved by the same amount the line grew.
    growth = long_proof.start - short_proof.start
    assert long.instant("moment.verdict") - short.instant("moment.verdict") == pytest.approx(growth, abs=0.01)
