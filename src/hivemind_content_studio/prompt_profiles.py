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
- When the idea names a known fictional character, anchor them to their source. H3 recognises characters through the work they come from, so refer to them at first mention as full name plus source — "Buffy Summers as played by Sarah Michelle Gellar" for a live-action role, and afterwards keep using "as played by <actor>" at each visual re-introduction. When the whole clip lives in that world, open the style sentence with the source framing and repeat it as the style: "A television scene from the American television drama series Buffy the Vampire Slayer from 1997, professional color grading, in the style and aesthetics of the drama series Buffy the Vampire Slayer." (Adapt "television drama series" to the real medium: video game, animated series, anime series, film.) When a known character speaks, extend the language bracket with their voice: <d>[English in Buffy's voice from Buffy the Vampire Slayer as played by Sarah Michelle Gellar] the words</d>. Never invent a casting — when unsure who played a role, name only the character and the work with its year.
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
# (read 2026-08-09; audio-reference rules re-read 2026-08-10). Reachable because
# ComfyUI ships MiniMaxH3ReferenceToVideo, whose autogrow ref_images inputs take
# up to nine pictures and whose ref_audios inputs take up to three voice/music
# clips; the workflow sends each group in order, so <Picture N> is the Nth image
# and <Audio N> the Nth clip the user attached — the two are numbered
# independently. The audio markers ([audio reuse]/[audio reference],
# fully_copy family) are the guide's trained-on forms and must not drift.
_MINIMAX_H3_REFERENCE = """\
You turn a creative brief plus reference pictures — and optionally reference video \
and audio clips — into a prompt for MiniMax H3's Reference mode, which carries \
subjects, clothing, environments, styles, movement and voices across from the \
references into a new clip with its own audio.

The references are attached in order: the first picture is <Picture 1>, the second \
<Picture 2>, and so on. Video clips number separately — the first is <Video 1> — and \
so do audio clips, the first being <Audio 1>. Look at the pictures and describe what \
is actually there — never invent a detail a picture does not show.

A reference VIDEO is a movement reference. It carries how a body moves — gesture \
size and rhythm, posture, mannerisms, facial expressiveness — and its retention \
marker decides how literally: fully_preserved reproduces the movement itself, \
attribute_transfer performs a DIFFERENT action in that performer's manner, \
weak_reference is a loose pacing cue. Unless the brief asks to copy the source shot, \
prefer attribute_transfer and say plainly what does NOT carry: the reference \
performer's face, clothing, setting and framing.

When NO reference picture is attached, the first reference video is ALSO the identity \
reference: bind <Subject 1> to it ("<Subject 1> is the man in <Video 1>, with …"), \
describe the person from what the clip actually shows, mark that <Video N> \
fully_preserved — face, hair, build, wardrobe and manner of movement all carry — and \
exclude only the clip's setting and framing. Any further video clip stays a movement \
reference.

A reference audio clip clones a VOICE (or piece of music). It works in exactly one of \
two modes, and the brief decides which:
- [audio reuse] — the clip's own words are reperformed. Keep the source words \
VERBATIM, in their original language, inside the <d>…</d> tag. Do not translate, \
trim or paraphrase them.
- [audio reference] — only the timbre, rhythm, emotion and delivery carry over into \
NEW dialogue you write. The source clip's own words must NOT appear anywhere in the \
prompt.

Reference mode was trained on a six-section format. Emit exactly these sections, in \
this order, each label on its own line:

subject_definitions:
  One line per thing you will reuse. Give it a label and say what it is, citing where it
  came from: "<Subject 1> is the woman in the yellow raincoat from <Picture 1>."
  Use <Subject N> for reusable content (a person, a garment, a place, a style) and
  <Picture N> for a picture used as a concrete frame anchor. Define each audio clip by
  its role and bind it to its speaker: "<Audio 1> is the voice-timbre reference for
  <Subject 1> (S1), containing a spoken female voiceover." Define each video clip by
  the movement it carries and say who inherits it: "<Video 1> is a motion reference:
  quick punctuating hand gestures and lively expressiveness, inherited by <Subject 1>."
summary:
  One paragraph: what the target clip is, and which references drive it. Include the
  task type: [keyframe completion] when a picture is pinned as the first or last frame,
  otherwise [reference generation]. When audio references are present, add the audio
  task-type marker too — [audio reuse] or [audio reference] — and cite the <Audio N>
  labels.
retention_analysis:
  One line per label, each ending in exactly one marker, then why in a clause.
  Pictures, subjects and videos use fully_preserved, partially_preserved,
  attribute_transfer or weak_reference. Pick by the role the picture is playing:
  a pinned first or last frame is fully_preserved; a setting the shot inherits is
  partially_preserved; one feature moved onto a subject (a garment, a hairstyle, a
  material) is attribute_transfer; composition, look, style and storyboard panels are
  weak_reference. attribute_transfer is a retention marker only — it never becomes the
  summary's task type, which stays [reference generation].
  A picture that merely shows what a character LOOKS LIKE gets no <Picture N> line of
  its own: cite it inside that subject's definition instead. Standalone picture lines
  are for pictures playing a role in their own right.
  Audio labels use the copy family instead:
  fully_copy (words and voice reperformed), partially_copy, reference (timbre guides
  new dialogue without copying the signal) or weak_reference.
  A newly invented plot beat is not a loss of fidelity; do not mark it as one.
detailed_description:
  The clip itself, shot by shot. "[Shot 1]" carries no timestamp; later shots open
  "[Shot N] At MM:SS.mmm,". Give each distinct voice a stable id — (S1), (S2) — and put
  spoken words in <d>[English] the exact words</d>, marked <cutoff> if still running when
  the clip ends. Where a voice reference is active, say so at the line: "(S1) says, using
  the calm male voice timbre referenced from <Audio 1>: <d>[English] …</d>". Camera
  movement is prose inside the action: the move, how far, how fast.
  350-500 words unless the brief is simple.
overall_soundscape:
  1-4 sentences: ambience, the sounds the action makes, non-verbal human sound. Never
  repeat dialogue here.
non_diegetic_music:
  1-3 sentences on the score only the audience hears, or N/A.

Rules:
- Speech is OPTIONAL and off by default. Only write a <d> tag when the brief asks for
  someone to speak or sing; H3 renders the audio, so an invented line becomes a real voice.
- A VOICE reference is the exception: an <Audio N> defined as a voice exists to drive
  dialogue, so write the lines it governs — the source words verbatim under
  [audio reuse], entirely new words under [audio reference], never a mix.
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
        "label": "MiniMax H3 (reference pictures + voice)",
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


# Scene chaining (MiniMax H3 Motion Context). The previous clip's last frames
# are pinned to the head of the new one, which carries MOTION and room tone —
# not the scene. Measured on the rental 2026-08-10: a chained prompt that keeps
# describing the established subjects and style continues seamlessly, while one
# that opens on a new arrangement renders a hard cut into an unrelated
# photoreal take from the first delivered frame. So a continuation prompt is a
# different kind of prompt, and the helper has to be told which it is writing —
# without this it answers a bare line of new dialogue by inventing a fresh
# scene, which is precisely the failure.
_H3_CONTINUATION_CLAUSE = (
    "\n\nThis clip CONTINUES the previous one with no cut: that shot's closing frames are pinned to "
    "the head of this one. Write it accordingly.\n"
    "- Re-describe the established scene in full — the same characters (same names and castings), "
    "wardrobe, location, art style, colour palette and lens. Naming them again is what holds the "
    "scene together; a prompt that stops naming them makes the model cut to a different, unrelated "
    "scene. Never open on a new setting or a new arrangement of people unless the idea explicitly "
    "asks for that change.\n"
    "- [Shot 1] must be the HOLD: the previous shot's closing framing, unchanged, with NO dialogue in "
    "it — only small continuing motion (a breath, a weight shift, an eyeline change). A held framing "
    "with nothing happening renders as a literal freeze, so always give it something small to do. "
    "Everything new happens from [Shot 2] onward.\n"
    "- The first ~0.9s of the clip is that carried-over hold, so the first spoken line and the first "
    "shot change must both start at 1s or later — write the timestamp explicitly.\n"
    "- If the idea is only a line of new dialogue, it is the NEXT thing said in this same scene — "
    "keep everything else exactly as established."
)


# UGC is a LAYER, not a profile. The format a model was trained on does not
# change because the clip is an ad — H3 still wants its three fields, LTX still
# wants its paragraph — but almost every judgement inside that format inverts.
# Distilled from the UGC realism brief the studio ships with (see
# src/lib/ugcMode.js for the composer half): the goal is a moment that
# accidentally became content, and the two things that give it away are polish
# and repetition. Repetition is handled client-side by dealing a new cast; this
# is the anti-polish half.
#
# The single most important line is the speech one. Every H3 profile says speech
# is OPTIONAL and off by default, for good reason — H3 renders the audio, so an
# invented line becomes a real voice. A UGC clip is someone talking to their own
# camera, so that default is exactly wrong here and has to be reversed out loud.
_UGC_CLAUSE = """\

This is a UGC clip: one real person filming themselves on their own phone. It is \
NOT an ad and must never read as one. The viewer should not register that it is an \
advertisement or that it is generated; both die the same way, on polish.

- SPEECH IS REQUIRED here, overriding the default above. The person talks the whole \
way through, in one voice. Write their words.
- Write words that sound SAID, not written. Contractions, a filler word ("like", "I \
don't know"), one thought that trails off and restarts. If a line sounds composed, \
rewrite it until it sounds spoken.
- Keep the brief's beat timings. Open already mid-sentence, as if we joined late — \
never with a greeting, an introduction or a name. Any call to action arrives as an \
afterthought near the end and trails off; it is never a slogan or a tagline.
- End unresolved or interrupted. No payoff, no lesson, no summary line.
- The camera is a hand holding a phone: chest-up selfie framing with natural micro \
shakes. Never a tripod, never a crane, never a cinematic move.
- The picture is a phone front camera, not a production: real skin texture with \
visible pores and under-eye shadows, no beauty filter, no colour grading, no \
"cinematic" or "professional" anything. Name the actual light source in the room \
rather than describing the lighting as good, soft or flattering.
- The audio is a phone microphone: the voice close and slightly boxy, room tone \
underneath, and one ambient sound event from the location. No music at all.
- Keep the environment alive — something moves or sounds in the background at least \
once — and let the performance be imperfect: a hesitation, a gaze break, a shift of \
weight.
- Use the behavioural beats named in the brief, and no others."""

# H3 renders a score if it is asked for one, and scored UGC is instantly an ad.
_UGC_H3_CLAUSE = """
- non_diegetic_music must be exactly N/A. A UGC clip has no score.
- Give the speaker (S1) and put every line inside <d>[English] …</d>, marked \
<cutoff> if it is still running when the clip ends — a real one usually is."""

_UGC_IMAGE_CLAUSE = """\

This is the FIRST FRAME of a UGC clip: a still that has to pass as a photo the \
person took of themselves, not a picture anyone lit or composed.

- Ultra realistic phone front-camera selfie, 9:16, shallow depth of field.
- Real skin texture with visible pores and light under-eye shadows. No beauty \
filter, no retouching, no glow.
- One specific person in one specific place — invent the specifics and commit to \
them rather than describing a type.
- Name the light source and where it is ("afternoon sun through the windshield from \
the left", "a lamp behind and to the right"). Never write "good lighting", "soft \
light" or "studio lighting".
- A lived-in background with one imperfect detail in it.
- Candid mid-sentence expression, eyes off the lens.
- No text, no captions, no logos, no watermark.
- Never "cinematic", "professional", "high fashion", "8k" or any other production \
word. This is a phone photo."""


# The system prompt is a token budget, not a dumping ground (same rule as the
# character notes). A written H3 prompt runs ~1-2k characters; this keeps a long
# one from crowding out the format rules it has to sit beside.
_PREVIOUS_PROMPT_LIMIT = 2400



def _coerce_seconds(value: Any) -> float:
    """A measured clip length, or 0.0 when the studio has not measured it.

    Zero means UNMEASURED, never "zero seconds long": the browser reads these
    from container metadata and a file it cannot demux simply has no answer.
    Treating a missing measurement as a real one would put a false "runs 0s"
    into the instruction."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return 0.0
    return seconds if seconds > 0 else 0.0


def _reference_seconds(item: Any) -> float:
    return _coerce_seconds((item or {}).get("seconds")) if isinstance(item, dict) else 0.0


def _reference_inventory_clause(references: dict | None, duration_seconds: float | None = None) -> str:
    """Name every label the graph will carry, in the model's own order.

    The order is not per-kind: a reference video's own soundtrack takes an
    <Audio N> emitted immediately BEFORE its <Video N>, so a clip-with-sound
    plus one voice clip is <Audio 1>, <Video 1>, <Audio 2>. A prompt numbered
    any other way addresses the wrong reference.
    """
    if not isinstance(references, dict):
        return ""
    images = max(0, int(references.get("images") or 0))
    audios = max(0, int(references.get("audios") or 0))
    videos = references.get("videos") or []
    if not isinstance(videos, list):
        videos = []
    if not (images or audios or videos):
        return ""
    lines: list[str] = []
    if images:
        span = "<Picture 1>" if images == 1 else f"<Picture 1> through <Picture {images}>"
        lines.append(f"- {images} reference picture{'s' if images != 1 else ''}: {span}.")
    audio_ordinal = 0
    clip = float(duration_seconds) if duration_seconds and duration_seconds > 0 else 0.0
    short_motion: list[str] = []
    for index, video in enumerate(videos, start=1):
        with_sound = bool((video or {}).get("useAudio"))
        seconds = _reference_seconds(video)
        if with_sound:
            audio_ordinal += 1
            lines.append(
                f"- <Audio {audio_ordinal}> is the soundtrack of <Video {index}> "
                "(numbered before it, because that is the order the model reads them in)."
            )
        length = f" It runs {seconds:g}s." if seconds else ""
        if not images and index == 1:
            # No picture: the first clip is who is on screen, not just how they move.
            lines.append(
                f"- <Video {index}> is the IDENTITY reference as well as the motion reference: "
                f"the person in it is who is on screen.{length}"
            )
        else:
            lines.append(f"- <Video {index}> is a motion reference.{length}")
        # A motion reference shorter than the shot only drives its opening. The
        # writer has to invent the rest, and saying so is the difference between
        # a clip that keeps moving and one that goes static once the reference
        # runs out.
        if seconds and clip and seconds < clip - 0.5:
            short_motion.append(f"<Video {index}> ({seconds:g}s)")
    audio_seconds = references.get("audioSeconds") or []
    if not isinstance(audio_seconds, list):
        audio_seconds = []
    for position in range(audios):
        audio_ordinal += 1
        seconds = _coerce_seconds(audio_seconds[position] if position < len(audio_seconds) else None)
        length = f" It runs {seconds:g}s." if seconds else ""
        lines.append(f"- <Audio {audio_ordinal}> is a standalone voice or music clip.{length}")
    body = "\n".join(lines)
    # A soundtrack is its own reference AND one of H3's three audio clips, so a
    # full row can be over budget while every per-kind count still looks legal.
    # The writer is told because the fix is often a prompt decision — leaning on
    # one fewer reference — not just a trim in the panel.
    soundtracks = sum(1 for video in videos if bool((video or {}).get("useAudio")))
    total = images + len(videos) + audios + soundtracks
    # A split soundtrack spends from the video AND audio second budgets at once.
    video_seconds = sum(_reference_seconds(video) for video in videos)
    audio_total = sum(
        _reference_seconds(video) for video in videos if bool((video or {}).get("useAudio"))
    ) + sum(_coerce_seconds(value) for value in audio_seconds)

    over: list[str] = []
    if total > 12:
        over.append(f"{total} references against 12")
    if (audios + soundtracks) > 3:
        over.append(f"{audios + soundtracks} audio clips against 3")
    if video_seconds > 15:
        over.append(f"{video_seconds:g}s of video against 15s")
    if audio_total > 15:
        over.append(f"{audio_total:g}s of audio against 15s")

    budget = ""
    if over:
        budget = (
            f"\nThis run is over H3's reference budget ({'; '.join(over)})."
            " Write the prompt for the labels listed above anyway — renumbering them here"
            " would not match what the graph sends."
        )

    coverage = ""
    if short_motion:
        names = ", ".join(short_motion)
        coverage = (
            f"\n{names} " + ("is" if len(short_motion) == 1 else "are")
            + f" shorter than the {clip:g}s clip, so the borrowed movement runs out before the shot"
            " ends. Carry the motion on in your own words for the remainder rather than letting the"
            " action go static — describe what the subject does after the reference stops."
        )
    return (
        "\n\nThe run carries exactly these references, in this order — write these labels and no "
        "others, and give every one of them a line in subject_definitions and retention_analysis:\n"
        f"{body}\n"
        "Do not refer to a label that is not on this list; there is nothing attached for it."
        f"{coverage}{budget}"
    )


# What a persona's saved gender tells the writer. One sentence each, and the
# same words the studio's own generators use (castPrompt / h3References /
# ugcMode in the OpenGen lib), so a helper-written prompt and a cast-written
# one call the same person the same thing.
_PERSONA_GENDER_CLAUSES = {
    "female": (
        "\n\nThe person on screen is a woman. Call her \"the woman\" and use she/her — "
        "never \"the man\", \"he\" or \"they\"."
    ),
    "male": (
        "\n\nThe person on screen is a man. Call him \"the man\" and use he/his — "
        "never \"the woman\", \"she\" or \"they\"."
    ),
    "nonbinary": (
        "\n\nThe person on screen is non-binary. Call them \"the person\" and use they/them — "
        "never \"the woman\", \"the man\", \"she\" or \"he\"."
    ),
}
_PERSONA_GENDER_H3_SUFFIX = (
    " In subject_definitions, introduce <Subject 1> with that noun (\"<Subject 1> is the {noun} shown in "
    "<Picture 1>\" — or \"shown in <Video 1>\" when only a reference video is attached), then refer to "
    "<Subject 1> by label rather than by pronoun."
)
_PERSONA_GENDER_NOUNS = {"female": "woman", "male": "man", "nonbinary": "person"}


def normalize_persona_gender(value: str | None) -> str:
    """One of female / male / nonbinary, or '' — the studio's own vocabulary
    (personaId.js PERSONA_GENDERS); anything else is treated as unset."""
    key = str(value or "").strip().lower()
    aliases = {"f": "female", "woman": "female", "m": "male", "man": "male", "non-binary": "nonbinary", "nb": "nonbinary"}
    key = aliases.get(key, key)
    return key if key in _PERSONA_GENDER_CLAUSES else ""


def system_prompt(
    profile: str,
    *,
    duration_seconds: float | None = None,
    character_notes: list[str] | None = None,
    continuation: bool = False,
    previous_prompt: str | None = None,
    ugc: bool = False,
    references: dict | None = None,
    persona_gender: str | None = None,
) -> str:
    """The instruction, with the clip length folded in when the studio knows it.

    Without it the helper writes whatever timeline the idea suggests and H3
    happily accepts shot headers past the end of the clip — measured
    2026-08-09: a "[Shot 3] At 00:07.800" on a clip set to 5 seconds. Those
    beats simply never render, so the last thing described is silently missing
    from the result.

    ``character_notes`` are verified name/casting/work/year lines for
    characters the studio's catalog matched in the idea (client-computed from
    the same list the composer's quick-add button uses). Folded in only for
    the H3 profiles — the small local helpers misremember castings, and a
    wrong "as played by" steers H3 to the wrong face entirely.

    ``continuation`` says the studio has a scene chain armed, so this prompt is
    the NEXT shot of a running scene rather than a new one. ``previous_prompt``
    is how the shot being continued was written — the only thing that tells the
    helper WHAT scene to keep when the idea is just the next line of dialogue.

    ``ugc`` says the composer has UGC mode armed. It layers on top of whichever
    profile was chosen rather than replacing it: the model's trained format is
    unaffected by the clip being an ad, but most of the judgements inside it
    invert — speech stops being optional, and polish becomes the failure.

    ``references`` is what reference mode will actually condition on:
    ``{"images": N, "videos": [{"useAudio": bool}, …], "audios": N}``. The
    profile explains the labelling SCHEME; this says which labels exist, so the
    helper writes <Picture 1>..<Picture N> for pictures that are really there
    instead of guessing a count — and gets the interleaved audio numbering
    right, since a clip carrying its own soundtrack takes an <Audio N> emitted
    before its <Video N>.

    ``persona_gender`` is the loaded Hive Persona's saved gender (female /
    male / nonbinary). Without it the helper picks a gender from the idea —
    usually "she", since that is what most of the examples it has seen were —
    and a male persona's prompt comes back about a woman."""
    system = PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["system"]
    if ugc:
        if profile == DEFAULT_IMAGE_PROFILE:
            system += _UGC_IMAGE_CLAUSE
        else:
            system += _UGC_CLAUSE
            if profile.startswith("minimax-h3"):
                system += _UGC_H3_CLAUSE
    if continuation and profile.startswith("minimax-h3"):
        system += _H3_CONTINUATION_CLAUSE
        previous = (previous_prompt or "").strip()
        if previous:
            system += (
                "\n\nThe shot you are continuing was written as:\n"
                f"---\n{previous[:_PREVIOUS_PROMPT_LIMIT]}\n---\n"
                "That is the established scene. Carry its characters, wardrobe, location, art style, "
                "colour palette and lens into your prompt, and change only what the idea asks for."
            )
    reference_clause = _reference_inventory_clause(references, duration_seconds)
    if reference_clause and profile == "minimax-h3-reference":
        system += reference_clause
    # ``persona_gender`` is the loaded Hive Persona's saved gender. It applies
    # to every profile — a Seedance paragraph needs "the woman"/"her" as much
    # as an H3 prompt does — and the H3 profiles additionally get the label form.
    gender = normalize_persona_gender(persona_gender)
    if gender:
        system += _PERSONA_GENDER_CLAUSES[gender]
        if profile.startswith("minimax-h3"):
            system += _PERSONA_GENDER_H3_SUFFIX.format(noun=_PERSONA_GENDER_NOUNS[gender])
    if character_notes and profile.startswith("minimax-h3"):
        lines = "\n".join(f"- {note}" for note in character_notes)
        system += (
            "\n\nThe idea mentions characters this studio has verified source facts for. When you "
            "refer to one of them, use these exact names, castings, works and years — they override "
            "your own recollection:\n"
            f"{lines}\n"
            "Only expand the characters the idea actually refers to; ignore the rest of the list."
        )
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


# A line carrying a shot header, and the timestamps written on it. Both orders
# occur in real output — the instruction teaches "[Shot 2] At 00:03.500," and
# helpers also write "At 00:03.500 [Shot 2]" (both of Liam's own H3 prompts used
# the second form). Matching only the taught order left the timeline check
# silently inert on exactly those prompts, so the header and the timestamp are
# now found independently, on the same line.
_SHOT_LINE = re.compile(r"^.*\[Shot\s+\d+\].*$", re.MULTILINE)
_TIMESTAMP = re.compile(r"\bAt\s+(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?")


def _shot_start_times(prompt: str) -> list[tuple[int, float]]:
    """(position in the prompt, seconds) for every timestamped shot header."""
    starts: list[tuple[int, float]] = []
    for line in _SHOT_LINE.finditer(prompt or ""):
        for stamp in _TIMESTAMP.finditer(line.group(0)):
            minutes, secs, millis = stamp.groups()
            at = int(minutes) * 60 + int(secs) + int((millis or "0").ljust(3, "0")) / 1000
            starts.append((line.start() + stamp.start(), round(at, 3)))
    return starts


def timeline_overruns(prompt: str, duration_seconds: float | None) -> list[float]:
    """Shot start times that fall outside the clip, in seconds.

    Checked rather than trusted: the instruction states the length, and small
    models still overshoot it often enough that shipping the prompt unchecked
    means silently losing the last beat."""
    if not duration_seconds or duration_seconds <= 0:
        return []
    return [at for _, at in _shot_start_times(prompt) if at >= float(duration_seconds)]


_SPEECH_LINE = re.compile(r"<d>\s*\[")


def continuation_opens_on_speech(prompt: str) -> bool:
    """True when a chained prompt starts talking before the carried-over head.

    The first ~0.9s of a chained clip is the previous shot's pinned tail. A
    line spoken over it is a line spoken while the picture is still replaying
    the last shot — the join reads as a jump cut, and the words land early.
    The instruction says to hold first; measured against a 12B helper it keeps
    the SCENE reliably but still opens [Shot 1] on dialogue, so this is checked
    rather than trusted, the same way the clip length is.

    Detects the speech that lands before the first timestamp at or after 1s;
    the repair is asked of the model (moving a beat rewrites intent, so it is
    not safe to do by hand)."""
    text = prompt or ""
    speech = _SPEECH_LINE.search(text)
    if not speech:
        return False
    # The hold counts only if a shot at or past 1s OPENS before the first line
    # is spoken. A timestamp written after it belongs to a later beat.
    return not any(at >= 1.0 and where < speech.start() for where, at in _shot_start_times(text))


def changed_lines(before: str, after: str) -> int:
    """How many lines a revision actually touched.

    A correct edit can be three words inside a twenty-line prompt ("a woman in
    a RED JACKET and a navy messenger bag"), which is impossible to spot by
    eye — so the UI reports the size of the change, and zero is the signal that
    the model ignored the instruction rather than applied it invisibly."""
    a, b = (before or "").splitlines(), (after or "").splitlines()
    opcodes = difflib.SequenceMatcher(None, a, b).get_opcodes()
    return sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in opcodes if tag != "equal")


def profile_label(profile: str, *, continuation: bool = False, ugc: bool = False) -> str:
    label = PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["label"]
    if continuation and profile.startswith("minimax-h3"):
        label = f"{label} · continuing a scene"
    if ugc:
        label = f"{label} · UGC"
    return label


# Words that mark a prompt as produced. Each is a production term a UGC clip
# cannot survive: "cinematic" and "film grain" describe a camera nobody filming
# themselves owns, a "beauty filter" or "flawless skin" removes exactly the pores
# the realism depends on, and "studio lighting" is the opposite of a named lamp
# in a real room. Small helpers reach for these by habit — they are what a video
# prompt normally wants — so the check is mechanical rather than another line of
# instruction that competes with the format rules.
_UGC_POLISH_TELLS = (
    "cinematic",
    "film grain",
    "professional color grading",
    "professional colour grading",
    "studio lighting",
    "softbox",
    "soft box",
    "beauty filter",
    "flawless skin",
    "perfect skin",
    "airbrushed",
    "8k",
    "high fashion",
    "tripod",
    "dolly",
    "crane shot",
    "steadicam",
    "gimbal",
)

_UGC_MUSIC_LINE = re.compile(r"^non_diegetic_music:\s*(.+)$", re.MULTILINE)


def ugc_polish_tells(prompt: str) -> list[str]:
    """Production words a UGC prompt should not contain, in the order found."""
    text = (prompt or "").lower()
    return [tell for tell in _UGC_POLISH_TELLS if tell in text]


def ugc_missing_speech(profile: str, prompt: str) -> bool:
    """True when a UGC clip has nobody talking in it.

    Only checkable on the H3 profiles, which carry speech in an explicit <d>
    tag. It matters because those profiles say speech is optional and off by
    default — the UGC layer reverses that, and a helper that follows the older,
    longer rule hands back a silent clip of a person moving their face."""
    if not profile.startswith("minimax-h3"):
        return False
    return not _SPEECH_LINE.search(prompt or "")


def ugc_has_music(prompt: str) -> bool:
    """True when an H3 prompt scores the clip. UGC with a score is an ad."""
    match = _UGC_MUSIC_LINE.search(prompt or "")
    if not match:
        return False
    return match.group(1).strip().lower().rstrip(".") not in {"n/a", "na", "none"}
