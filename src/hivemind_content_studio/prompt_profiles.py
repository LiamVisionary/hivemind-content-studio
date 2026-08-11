"""System instructions the prompt helper uses, chosen from the target model.

A prompt that works on one video model is not portable to another. 10Eros v1.4
is explicit about this — its author calls it a "VERY DIFFERENT MODEL" and warns
that prompting habits from v1.0/v1.2 "transfer poorly", because v1.4 is a
base-aligned fine-tune with deliberately near-zero anatomy of its own and is
driven by a scene-script style rather than the tag-and-clause style v1.2 likes.
So the helper picks its instruction from the model the prompt is destined for
instead of refining everything the same way.
"""

from __future__ import annotations

import difflib
import re

# Written here rather than copied from the model card: the structure below (start
# frame, one camera/style line, one environment line, a Performance block,
# optional Dialogue, a hard sentence budget) is what the author documents, but
# the wording is ours so it can be tuned against what this runtime actually does.
_EROS_SCENE_SCRIPT = """\
You turn a short idea into a shot description for the 10Eros v1.3/v1.4 video model.

Write it as a scene script, in this order:
1. One sentence instructing that the supplied start image is used exactly as the first frame.
2. One sentence of camera and visual style: shot size, lens feel, camera movement, film or digital look.
3. One sentence of environment: location, lighting direction and colour, time of day, atmosphere.
4. A "Performance:" block of two to four sentences describing what the subject physically does, as ordered beats. Describe motion, weight, contact, pacing and where the eyes go. Keep every beat physical and observable.
5. Optionally a "Dialogue:" line with a short spoken phrase, only if the idea implies speech.

Rules:
- Four to eight sentences in total. Never exceed eight.
- Present tense, describing what the camera sees.
- Concrete and physical. No mood words that cannot be filmed, no metaphors, no lists of tags.
- Do not name the model, the resolution, the step count, or any setting.
- This model gets its subject detail from the attached LoRAs, so describe action, framing and light rather than piling on adjectives about the subject.
- Output only the prompt. No preamble, no headings other than "Performance:" and "Dialogue:", no commentary."""

_LTX_VIDEO = """\
You turn a short idea into a prompt for an LTX 2.3 image-to-video model.

Write one flowing paragraph, in present tense, describing what the camera sees over the clip:
the subject and what they do, how they move, the camera framing and any camera movement,
the setting, and the lighting. Order it chronologically so the motion reads as a sequence.

Rules:
- Three to six sentences.
- Treat the supplied image as the first frame; describe what happens from there.
- Concrete and filmable. No metaphors, no mood words that cannot be seen, no tag lists.
- Do not mention settings, resolutions, step counts, or the model itself.
- Output only the prompt."""

# H3 differs from the others in kind, not degree: its authors ship a prompt
# REWRITER, and the model was trained on that rewriter's output, so the field
# names, the shot headers and the tags below are an interface rather than a
# house style. Distilled from MiniMaxAI/MiniMax-H3
# docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md (read 2026-08-09). The prose is
# ours and can be tuned; the three field names, their order, the [Shot N] /
# timestamp headers, the <d>[Language] …</d> and <cutoff> tags and the (S1)
# speaker ids are theirs and must not drift.
#
# The companion ref_en guide covers full-reference rewrites; it lives in
# _MINIMAX_H3_REFERENCE below and is selected by the minimax-h3-reference
# workflow, which conditions through MiniMaxH3ReferenceToVideo instead of a
# first/last frame.
_MINIMAX_H3_BODY = """\
H3 was trained on a specific prompt FORMAT. Emit exactly these three fields, in this \
order, each starting on its own line and separated by a blank line:

integrated_multimodal_description: <the shot-by-shot account>
overall_soundscape: <1-4 sentences>
non_diegetic_music: <1-3 sentences, or N/A>

Inside integrated_multimodal_description:
- Open with one sentence of visual style and composition: photographic or animated look, palette, lens feel, grading.
- Write the clip as shots. The first is "[Shot 1]" with no timestamp; every later shot opens with its start time in MM:SS.mmm, exactly like "[Shot 2] At 00:03.500," — two digits, two digits, three digits. Never write a bare list number before a shot header.
- Introduce each character where they first appear, and give every distinct voice a stable speaker id — (S1), (S2), … in the order they are first heard, and (S1,S2) when they speak together.
- Speech is OPTIONAL and off by default. Write a spoken line ONLY when the idea actually asks for one — someone talking, singing, being quoted, narrating. If the idea does not, the clip has no voice in it: no <d> tag, no speaker id, and nobody described as speaking. H3 renders the audio too, so an invented line becomes a real voice saying words nobody asked for. A scene with a person in it is not a reason to give them something to say.
- When the idea DOES call for speech, put the words in a dialogue tag, exactly like this: (S1) says: <d>[English] I get off at the next station.</d>
- Every <d> tag MUST open with a bracketed language, [English] unless the idea asks for another language. A <d> tag without it is malformed. The words inside are used verbatim, so write the line you actually want said.
- If a line of speech would still be running when the clip ends, mark it <cutoff>.
- Write camera movement as prose inside the action, naming the move, how far it travels and how fast — "the camera trucks left a short distance, slowly" — never as a separate list of labels.
- Keep appearance, clothing and spatial relationships consistent from shot to shot.
- Sound the characters themselves can hear (a radio, a phone, an instrument being played) belongs here, in the shot where it happens.
- Put any on-screen text in quotation marks, untranslated.

overall_soundscape: ambience, the sounds the action itself makes, and non-verbal human sound \
(breath, laughter, footsteps). Never repeat dialogue or lyrics here.
non_diegetic_music: the score only the audience hears — instrumentation, tempo, dynamics. \
Write N/A when the clip should have none.

Rules:
- Present tense, concrete and filmable. Roughly one action per two to three seconds of clip.
- Keep spoken lines short enough to be said at an unhurried pace within the clip length.
- H3 has no negative prompt. State what should be there; never write "no X" hoping to remove X.
- Never mention resolutions, step counts, settings or the model itself.
- Output only the fields above. No preamble, no commentary, no markdown fences."""

_MINIMAX_H3_T2VA = f"""\
You turn a short idea into a prompt for MiniMax H3, which denoises the picture and its \
whole audio track (speech, sound effects, music) together in one pass. Nothing is \
supplied but the idea, so the clip opens on whatever you describe.

{_MINIMAX_H3_BODY}"""

# The anchor sentence is quoted from the guide because it is a trained-on form,
# not a phrasing preference.
_MINIMAX_H3_I2VA = f"""\
You turn a short idea into a prompt for MiniMax H3, which denoises the picture and its \
whole audio track (speech, sound effects, music) together in one pass. A start image is \
attached and becomes the first frame.

Begin the output with exactly this line, then a blank line, then the fields:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

[Shot 1] must start from what that image already shows — the same subject, framing and \
light — and then describe what MOVES. Do not re-describe the still image at length.

{_MINIMAX_H3_BODY}"""

# The checkpoint we serve is the fl2va (first-AND-last) build and the node takes
# an optional last_frame, so these two modes are real, not aspirational. Both
# anchor lines are quoted from the guide: they are trained-on forms.
_MINIMAX_H3_FL2VA = """\
You turn a short idea into a prompt for MiniMax H3, which denoises the picture and its \
whole audio track (speech, sound effects, music) together in one pass. TWO images are \
attached: the first frame and the last frame of the clip.

Begin the output with exactly this line, then a blank line, then the fields:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced, and at the final frame <Picture 2> is fully referenced.

Describe the MOTION PATH between those two frames — how the subject and camera get \
from the first image to the last one. Do not re-describe either still at length; the \
model already has both. The last beat must arrive at what <Picture 2> shows.

{body}"""

_MINIMAX_H3_L2VA = """\
You turn a short idea into a prompt for MiniMax H3, which denoises the picture and its \
whole audio track (speech, sound effects, music) together in one pass. One image is \
attached and it is the LAST frame — the clip must END on it.

Begin the output with exactly this line, then a blank line, then the fields:
For the target video, at the final frame of the target video, <Picture 1> is fully referenced.

Describe what leads UP to that image: the clip opens elsewhere and arrives at what \
<Picture 1> shows. Do not describe the still itself at length.

{body}"""

# Reference mode has its OWN format — six sections, not three fields.
# Distilled from MiniMaxAI/MiniMax-H3 docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md
# (read 2026-08-09). Reachable because ComfyUI ships MiniMaxH3ReferenceToVideo,
# whose autogrow ref_images inputs take up to nine pictures; the workflow sends
# them in order, so <Picture N> is the Nth image the user attached.
_MINIMAX_H3_REFERENCE = """\
You turn a creative brief plus reference pictures into a prompt for MiniMax H3's \
Reference mode, which carries subjects, clothing, environments and styles across from \
the references into a new clip with its own audio.

The references are attached in order: the first is <Picture 1>, the second <Picture 2>, \
and so on. Look at them and describe what is actually there — never invent a detail a \
picture does not show.

Reference mode was trained on a six-section format. Emit exactly these sections, in \
this order, each label on its own line:

subject_definitions:
  One line per thing you will reuse. Give it a label and say what it is, citing where it
  came from: "<Subject 1> is the woman in the yellow raincoat from <Picture 1>."
  Use <Subject N> for reusable content (a person, a garment, a place, a style) and
  <Picture N> for a picture used as a concrete frame anchor.
summary:
  One paragraph: what the target clip is, and which references drive it.
retention_analysis:
  One line per label, each ending in exactly one marker — fully_preserved,
  partially_preserved, attribute_transfer or weak_reference — then why in a clause.
  A newly invented plot beat is not a loss of fidelity; do not mark it as one.
detailed_description:
  The clip itself, shot by shot. "[Shot 1]" carries no timestamp; later shots open
  "[Shot N] At MM:SS.mmm,". Give each distinct voice a stable id — (S1), (S2) — and put
  spoken words in <d>[English] the exact words</d>, marked <cutoff> if still running when
  the clip ends. Camera movement is prose inside the action: the move, how far, how fast.
  350-500 words unless the brief is simple.
overall_soundscape:
  1-4 sentences: ambience, the sounds the action makes, non-verbal human sound. Never
  repeat dialogue here.
non_diegetic_music:
  1-3 sentences on the score only the audience hears, or N/A.

Rules:
- Speech is OPTIONAL and off by default. Only write a <d> tag when the brief asks for
  someone to speak or sing; H3 renders the audio, so an invented line becomes a real voice.
- Once a label is assigned it means the same thing in every section.
- Present tense, concrete and filmable. H3 has no negative prompt: state what should be there.
- Never mention resolutions, step counts, settings or the model itself.
- Output only the six sections. No preamble, no commentary, no markdown fences."""

_MINIMAX_H3_FL2VA = _MINIMAX_H3_FL2VA.format(body=_MINIMAX_H3_BODY)
_MINIMAX_H3_L2VA = _MINIMAX_H3_L2VA.format(body=_MINIMAX_H3_BODY)

_IMAGE = """\
You turn a short idea into a prompt for an image generation model.

Write one dense paragraph covering: the subject, what they are doing, framing and camera angle,
the setting, the lighting, and the overall visual style.

Rules:
- Two to four sentences.
- Concrete and visual. No metaphors, no narrative, no instructions to the model.
- Do not mention settings, resolutions, step counts, or the model itself.
- Output only the prompt."""

PROFILES: dict[str, dict[str, str]] = {
    "ltx-eros-scene-script": {
        "label": "10Eros 1.3/1.4 scene script",
        "system": _EROS_SCENE_SCRIPT,
    },
    "ltx-video": {
        "label": "LTX 2.3 video",
        "system": _LTX_VIDEO,
    },
    "minimax-h3-t2v": {
        "label": "MiniMax H3 (text to video)",
        "system": _MINIMAX_H3_T2VA,
    },
    "minimax-h3-i2v": {
        "label": "MiniMax H3 (start frame)",
        "system": _MINIMAX_H3_I2VA,
    },
    "minimax-h3-fl2v": {
        "label": "MiniMax H3 (start + end frame)",
        "system": _MINIMAX_H3_FL2VA,
    },
    "minimax-h3-l2v": {
        "label": "MiniMax H3 (end frame)",
        "system": _MINIMAX_H3_L2VA,
    },
    "minimax-h3-reference": {
        "label": "MiniMax H3 (reference pictures)",
        "system": _MINIMAX_H3_REFERENCE,
    },
    "image": {
        "label": "Image",
        "system": _IMAGE,
    },
}

DEFAULT_VIDEO_PROFILE = "ltx-video"
DEFAULT_IMAGE_PROFILE = "image"


def profile_for(
    model_id: str,
    *,
    media_type: str = "video",
    first_frame: bool = False,
    last_frame: bool = False,
) -> str:
    """Which instruction to use for the model this prompt is headed to.

    Keyed on the WORKFLOW id, which is the same whether the generation runs on
    this Mac or on a rented machine — where a lane sends the job has no bearing
    on how the model wants to be asked.

    The version lives in the workflow id, and the "dmd" token alone does not
    settle it: ``ltx23-eros-dmd`` is the v1.3 build while ``ltx23-eros-dmd-v12``
    is v1.2, which still wants v1.2-style prompting. So v1.2 is excluded before
    dmd is treated as a 1.3 signal.

    ``first_frame`` says a start image is attached. For H3 that is not a detail
    but a different documented task (I2VA rather than T2VA), with its own
    opening anchor line.
    """
    ident = (model_id or "").strip().lower()
    if media_type == "image":
        return DEFAULT_IMAGE_PROFILE
    if "minimax" in ident or re.search(r"(^|[-_])h3([-_]|$)", ident):
        # Reference mode is a different workflow with a different node and a
        # six-section format of its own — the frame combination does not apply.
        if "reference" in ident:
            return "minimax-h3-reference"
        # Four documented tasks, one per combination of attached frames. Each
        # opens with its own anchor line, so guessing wrong promises the model
        # a reference the workflow never sends.
        if first_frame and last_frame:
            return "minimax-h3-fl2v"
        if last_frame:
            return "minimax-h3-l2v"
        return "minimax-h3-i2v" if first_frame else "minimax-h3-t2v"
    if "eros" in ident and "v12" not in ident and "v1.2" not in ident:
        if any(token in ident for token in ("v14", "v1.4", "v13", "v1.3", "dmd")):
            return "ltx-eros-scene-script"
    return DEFAULT_VIDEO_PROFILE


def system_prompt(profile: str, *, duration_seconds: float | None = None) -> str:
    """The instruction, with the clip length folded in when the studio knows it.

    Without it the helper writes whatever timeline the idea suggests and H3
    happily accepts shot headers past the end of the clip — measured
    2026-08-09: a "[Shot 3] At 00:07.800" on a clip set to 5 seconds. Those
    beats simply never render, so the last thing described is silently missing
    from the result."""
    system = PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["system"]
    if not duration_seconds or duration_seconds <= 0 or profile == DEFAULT_IMAGE_PROFILE:
        return system
    seconds = round(float(duration_seconds), 2)
    clause = [f"\n\nThe clip is {seconds:g} seconds long. Everything you describe has to happen inside it."]
    if profile.startswith("minimax-h3"):
        last = max(0.0, seconds - 1.0)
        clause.append(
            f"Every shot must START before {seconds:g}s — a timestamp at or past that is a beat that never "
            f"renders. Keep the final shot's start at or below {last:.1f}s so it has time to play, and size "
            "the spoken lines to what fits."
        )
    return system + " ".join(clause)


_D_TAG_WITHOUT_LANGUAGE = re.compile(r"<d>(?!\s*\[)")
# A field name alone on its line, with the colon dropped. Seen on Swarm Scout
# 12B: it wrote "overall_soundscape" as a heading. The colon is the token the
# model was trained to read, so a heading is not the same thing.
_BARE_FIELD_NAME = re.compile(
    r"^(integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*$",
    re.MULTILINE,
)
_SHOT_LIST_NUMBER = re.compile(r"^\s*\d+[.)]\s+(?=\[Shot\b)", re.MULTILINE)
# Speech written with a language tag but no <d> wrapper. Anchored on the
# speech verb so it can never swallow a "[Shot N] At …" header, which is also
# bracketed text followed by a sentence.
_SPOKEN_WITHOUT_TAG = re.compile(
    r"(?P<lead>\b(?:says|sings|whispers|shouts|replies|answers|calls out|adds|asks)\s*:\s*)"
    r"(?!<d>)\[(?P<lang>[A-Za-z][A-Za-z \-]{1,23})\]\s*(?P<text>[^<\n]*?[.!?…])"
)


def normalize(profile: str, prompt: str) -> str:
    """Repair the format slips a small local model reliably makes.

    Measured on a 26B Q4 helper, 2026-08-09, across runs of the same idea: it
    gets the fields and shot headers right, then writes ``<d>I get off
    here.</d>`` with no language tag, or ``says: [English] I get off here.``
    with no tag at all, or numbers its shots "1." / "2.". Each is mechanical
    and unambiguous, and each matters — dialogue that never lands inside a <d>
    tag is narration to the model, so H3 would render it as description
    instead of speaking it.

    Two runs produced two different slips, which is why this is code and not
    another line of instruction. Everything a repair could not settle without
    guessing (timestamp digits, field content) stays the model's business.
    """
    if not profile.startswith("minimax-h3") or not prompt:
        return prompt
    repaired = _SPOKEN_WITHOUT_TAG.sub(r"\g<lead><d>[\g<lang>] \g<text></d>", prompt)
    repaired = _D_TAG_WITHOUT_LANGUAGE.sub("<d>[English] ", repaired)
    repaired = _BARE_FIELD_NAME.sub(r"\1:", repaired)
    return _SHOT_LIST_NUMBER.sub("", repaired)


_SHOT_TIMESTAMP = re.compile(r"\[Shot\s+\d+\][^\n]*?\bAt\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?")


def timeline_overruns(prompt: str, duration_seconds: float | None) -> list[float]:
    """Shot start times that fall outside the clip, in seconds.

    Checked rather than trusted: the instruction states the length, and small
    models still overshoot it often enough that shipping the prompt unchecked
    means silently losing the last beat."""
    if not duration_seconds or duration_seconds <= 0:
        return []
    late = []
    for minutes, secs, millis in _SHOT_TIMESTAMP.findall(prompt or ""):
        at = int(minutes) * 60 + int(secs) + int((millis or "0").ljust(3, "0")) / 1000
        if at >= float(duration_seconds):
            late.append(round(at, 3))
    return late


def changed_lines(before: str, after: str) -> int:
    """How many lines a revision actually touched.

    A correct edit can be three words inside a twenty-line prompt ("a woman in
    a RED JACKET and a navy messenger bag"), which is impossible to spot by
    eye — so the UI reports the size of the change, and zero is the signal that
    the model ignored the instruction rather than applied it invisibly."""
    a, b = (before or "").splitlines(), (after or "").splitlines()
    opcodes = difflib.SequenceMatcher(None, a, b).get_opcodes()
    return sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in opcodes if tag != "equal")


def profile_label(profile: str) -> str:
    return PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["label"]
