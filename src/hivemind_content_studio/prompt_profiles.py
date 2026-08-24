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

# The composer half of this is ugcSubject() in src/lib/ugcMode.js, which stopped
# writing an invented person into the brief when references are attached. The
# helper has to be told the same thing, or it puts one back: "one real person
# filming themselves" reads as an invitation to describe one, and a described
# person beats an attached picture of somebody else — a persona of a woman came
# back as a man in his early 30s (2026-08-13).
_UGC_REFERENCE_CLAUSE = """
- The person on camera is ALREADY FIXED by the reference pictures. Describe what they \
do, never what they look like: no age, no gender, no hair, no build, no face, and no \
clothing beyond what the clip itself changes. If you write an appearance here it \
overrides the references and the clip comes back as somebody else."""

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


# The cast: WHO is in the shot, one entry per <Subject N>, the way the studio's
# own compiler sees it (castPrompt.js). Two kinds, and the difference is only
# whether a member brings media:
#
#   persona   — a real person defined by attached reference pictures/clips. It
#               is addressed ONLY by its label; its name is sealed to the
#               owner's vault and never reaches this host, so any name that
#               arrives for one is discarded unread.
#   character — a name H3 already knows ("SpongeBob SquarePants"). Public, and
#               written by that name.
#
# Without this the helper knows at most one persona's gender and nothing about
# anybody else in the shot, so a two-person cast comes back as one woman and a
# stranger it invented — or the cartoon gets the woman's lines.
_CAST_LIMIT = 9
_CAST_TEXT_LIMIT = 300
_CAST_KINDS = ("persona", "character")
# The English a cast line needs, keyed like personaGenderWords() in
# personaId.js: the noun, the pronoun pair to print, and the possessive
# determiner ("her lines"). Unset reads as non-binary here — "a person",
# they/them — because the helper must not guess a gender the studio left open.
_CAST_WORDS = {
    "female": {"noun": "woman", "pronouns": "she/her", "her": "her"},
    "male": {"noun": "man", "pronouns": "he/him", "her": "his"},
    "nonbinary": {"noun": "person", "pronouns": "they/them", "her": "their"},
    "": {"noun": "person", "pronouns": "they/them", "her": "their"},
}


def _cast_text(value: Any) -> str:
    """Free text from a cast member, made safe to sit inside an instruction:
    one line, no angle brackets (a look that reads "<Subject 3>" would mint a
    label), capped so a runaway field cannot crowd out the format rules."""
    if not isinstance(value, str):
        return ""
    text = " ".join(re.sub(r"[<>]", "", value).split())
    return text[:_CAST_TEXT_LIMIT]


def _cast_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or "").strip().lower() in ("true", "1", "yes")


def _possessive(name: str) -> str:
    """SpongeBob SquarePants' voice, but Willow's voice — the same rule as
    characterVoiceText() in h3Characters.js, so the helper's tag and the
    studio's tag read the same."""
    return f"{name}'" if name.endswith("s") or name.endswith("S") else f"{name}'s"


def normalize_cast(cast: Any) -> list[dict]:
    """The cast as the clause reads it, or [] when nothing usable was sent.

    Defensive on purpose: this is client-supplied JSON that lands inside an
    instruction. An item that is not a dict, has no known ``kind``, or is a
    character without a name is dropped rather than repaired; ``subject`` is
    kept when it is a real 1..9 integer and otherwise derived from the
    member's position among the kept members; strings are trimmed, flattened
    and capped; a persona's ``name`` is discarded unread (it is vault-sealed
    and must never be written into a prompt on this host); at most nine
    members survive, because H3 has nine subject slots."""
    if not isinstance(cast, list):
        return []
    members: list[dict] = []
    for item in cast:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower() if isinstance(item.get("kind"), str) else ""
        if kind not in _CAST_KINDS:
            continue
        name = "" if kind == "persona" else _cast_text(item.get("name"))
        if kind == "character" and not name:
            continue
        subject = item.get("subject")
        if isinstance(subject, bool) or not isinstance(subject, int) or not 1 <= subject <= _CAST_LIMIT:
            subject = len(members) + 1
        members.append({
            "subject": subject,
            "kind": kind,
            "gender": normalize_persona_gender(item.get("gender") if isinstance(item.get("gender"), str) else None),
            "name": name,
            "voice": _cast_flag(item.get("voice")),
            "look": _cast_text(item.get("look")),
        })
        if len(members) >= _CAST_LIMIT:
            break
    return members


def _references_attached(references: dict | None) -> bool:
    if not isinstance(references, dict):
        return False
    videos = references.get("videos") or []
    return bool(
        int(references.get("images") or 0) > 0
        or int(references.get("audios") or 0) > 0
        or (isinstance(videos, list) and len(videos) > 0)
    )


def _cast_member_line(member: dict, *, reference_mode: bool, h3: bool) -> str:
    words = _CAST_WORDS[member["gender"]]
    noun, pronouns, her = words["noun"], words["pronouns"], words["her"]
    label = f"<Subject {member['subject']}>"
    look = member["look"]
    if member["kind"] == "persona":
        if reference_mode:
            line = (
                f"- {label} is a {noun} ({pronouns}): a real person, defined only by the attached "
                "reference pictures and clips."
            )
            if member["voice"]:
                line += (
                    f" A reference clip carries {her} voice, so {her} lines take the plain language tag — "
                    f"\"{label} (Sx) says: <d>[English] …</d>\" — and the timbre comes from the clip."
                )
            else:
                kind = f", in a {noun}'s voice" if member["gender"] in ("female", "male") else ""
                line += (
                    f" Nothing carries {her} voice: a line for {label} is written only if the brief asks, "
                    f"under the plain tag \"<d>[English] …</d>\"{kind}."
                )
            if look:
                line += (
                    f" Use this only for how {label} is lit and framed, never to re-describe or contradict "
                    f"the references: {look}."
                )
            return line
        # Text mode: no pictures are attached, so the person cannot be
        # rendered from references and is written from what the studio said.
        if look:
            line = (
                f"- Subject {member['subject']}: a {noun} ({pronouns}), described as \"{look}\" — a real person "
                "whose reference pictures are NOT attached to this run, so write this person from that "
                "description and nothing else."
            )
        else:
            line = (
                f"- Subject {member['subject']}: a {noun} ({pronouns}) — a real person whose reference pictures "
                f"are NOT attached to this run, so write this person simply as \"a {noun}\" / \"the {noun}\"."
            )
        return line + " Never give this person a name."
    # A known character: public name, written into the scene by that name.
    # Its voice is named inside the dialogue language tag, never referenced —
    # dialogueTag() in castPrompt.js, and characterVoiceText() for the form.
    name = member["name"]
    who = f"{name} ({pronouns})" if member["gender"] else name
    speaker = label if reference_mode else name
    if member["voice"]:
        voice = (
            f" When {speaker} speaks, name the character's own voice inside the language tag — "
            f"\"{label + ' (Sx) says: ' if reference_mode else ''}<d>[English in {_possessive(name)} voice from …] …</d>\", "
            f"filling in the work after \"from\" (and the performer when the facts give one), or "
            f"\"[English in {_possessive(name)} voice]\" when the work is unknown."
        )
    else:
        voice = f" {_possessive(speaker)} lines take the plain tag \"<d>[English] …</d>\" — do not name a voice."
    if reference_mode:
        line = f"- {label} is {who}: a character the model already knows, written under that label." + voice
    else:
        line = (
            f"- Subject {member['subject']}: {who} — a character the model already knows. Write {name} by full "
            "name plus the work it comes from at first mention, and keep that character in the scene."
        )
        if h3:
            line += voice
    if look:
        line += f" Appearance: {look}."
    return line


# The closing rules for a cast in reference mode. The persona line is the
# same rule _UGC_REFERENCE_CLAUSE enforces for UGC, for the same measured
# reason: a described person beats an attached picture of somebody else.
_CAST_REFERENCE_RULES = (
    "\nRules for the cast:\n"
    "- A persona is addressed ONLY by its label. Never give it a name, an age, a face, a hairstyle, "
    "a build or clothing: the references decide what the person looks like, and a description written "
    "here overrides them — the clip comes back as somebody else.\n"
    "- subject_definitions and retention_analysis are the studio's: it rewrites them from the cast, "
    "so one short line per label is enough there.\n"
    "- summary, detailed_description, overall_soundscape and non_diegetic_music are yours, and every "
    "<Subject N> listed above appears in them with something to do — nobody stands in the background "
    "unused.\n"
    "- Pronouns follow the gender given per member; give each speaking member its own (Sx) id in the "
    "order first heard, and write every spoken line as \"<Subject N> (Sx) says: <d>[…] …</d>\"."
)


def _cast_clause(cast: Any, references: dict | None = None, *, reference_mode: bool | None = None, h3: bool = True) -> str:
    """Who is in the shot, for the writer — or '' when no usable cast was sent.

    ``reference_mode`` says the shot is conditioned on reference media, so a
    persona is a <Subject N> the studio binds to its pictures and the helper
    addresses only by label; defaults to whether ``references`` carries
    anything. In text mode a persona has no pictures, so it is written from
    its look and gender in prose, and a character by full name plus source.
    ``h3`` gates the parts that only mean something in H3's format (the <d>
    tag, (Sx) ids)."""
    members = normalize_cast(cast)
    if not members:
        return ""
    if reference_mode is None:
        reference_mode = _references_attached(references)
    count = len(members)
    lines = "\n".join(_cast_member_line(member, reference_mode=reference_mode, h3=h3) for member in members)
    if reference_mode:
        head = (
            f"\n\nThe cast — who is in this shot — is fixed by the studio: {count} member"
            f"{'s' if count != 1 else ''}, already labelled. Address every one of them ONLY by its label:\n"
        )
        return head + lines + _CAST_REFERENCE_RULES
    head = (
        f"\n\nThe cast — who is in this shot — is fixed by the studio: {count} member"
        f"{'s' if count != 1 else ''}. Every one of them appears in the scene with something to do:\n"
    )
    return head + lines


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
    cast: list | None = None,
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
    and a male persona's prompt comes back about a woman.

    ``cast`` is who is in the shot, one entry per <Subject N> —
    ``{"subject": 1, "kind": "persona" | "character", "gender": "", "name":
    "", "voice": bool, "look": ""}`` — the same cast the studio's own compiler
    (castPrompt.js) allocates. It supersedes ``persona_gender``, which only
    ever knew about one person: with a cast present the per-member genders
    carry, and the single-persona clause is not written. A persona's name is
    never used (it is vault-sealed); a character's is public and written."""
    system = PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["system"]
    if ugc:
        if profile == DEFAULT_IMAGE_PROFILE:
            system += _UGC_IMAGE_CLAUSE
        else:
            system += _UGC_CLAUSE
            if isinstance(references, dict) and int(references.get("images") or 0) > 0:
                system += _UGC_REFERENCE_CLAUSE
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
    # The cast, when the studio sent one, is the fuller truth: every member's
    # kind, gender and voice, not just one persona's gender. So it wins over
    # ``persona_gender``, which stays for a client that only knows the one.
    # Reference mode is the reference profile or attached references; the
    # H3-only parts (<d> tags, (Sx) ids) are gated on the profile family.
    members = normalize_cast(cast)
    if members:
        system += _cast_clause(
            members, references,
            reference_mode=(profile == "minimax-h3-reference" or _references_attached(references)),
            h3=profile.startswith("minimax-h3"),
        )
    # ``persona_gender`` is the loaded Hive Persona's saved gender. It applies
    # to every profile — a Seedance paragraph needs "the woman"/"her" as much
    # as an H3 prompt does — and the H3 profiles additionally get the label form.
    gender = normalize_persona_gender(persona_gender)
    if gender and not members:
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


# ---------------------------------------------------------------------------
# Persona look: a person described from their reference pictures
# ---------------------------------------------------------------------------
#
# A Hive Persona carries a saved LOOK — hair, face, build, wardrobe in a line
# or two — that the cast writes into <Subject N>'s definition (personaId.js,
# _cast_member_line above). Typing it by hand is the step owners skip, and a
# blank look is what lets a prompt re-describe the person as a stranger. So the
# helper can write it from the persona's own pictures: one instruction, shaped
# around what a video model needs to keep a person consistent and nothing else.
# Told in the negative as much as the positive because a vision model's habit
# is to describe the PHOTO (the smile, the beach, the bokeh) and to identify
# people it thinks it recognises — both useless here, the second unwanted.
LOOK_DESCRIPTION_SYSTEM_PROMPT = """\
You describe how a person looks, for a video model that must keep that person consistent from shot to shot.

You are shown one to three photos of the SAME person. Write ONE compact description of that person — about 25 to 60 words, one line or two, with no line breaks, no lists, no headings and no preamble — covering, where visible: hair (colour, length, style, and facial hair if any); the notable features of the face (beard, moustache, glasses, freckles, piercings, dimples, a strong jaw, eye colour when clear); build; skin tone when it is clear; and the wardrobe as seen (garments, their colours, anything distinctive such as a hat, jewellery or a logo). Those are the things the video model needs to keep the person consistent, so they come first and nothing else is added.

Rules:
- Never name the person or guess who they are, even if you think you recognise them.
- Do not mention the photos, the camera, the lighting, the background, the setting, the pose or what the person is doing. Describe the person only.
- Age only as a broad band when it is obvious ("{age_band}"), never a number.
- Where a noun is needed write "{noun} with …" (at most once, at the start), and otherwise avoid pronouns: describe features directly ("short dark hair, a trimmed beard, a navy crew-neck sweater").
- When the photos disagree (a hat in one and not the others), describe what is constant and mark the variable item as occasional ("sometimes a grey beanie").
- Output only the description text: no label such as "Description:", no quotes, no markdown, no explanation."""

# The noun form for each saved gender — the same words the cast uses
# (_CAST_WORDS / personaGenderWords in personaId.js), so the look the helper
# writes and the subject line the cast writes call the person the same thing.
# Unset reads as "a person": the helper must not assign a gender the studio
# left open, and the description has to stay usable when it is set later.
_LOOK_NOUNS = {"female": "a woman", "male": "a man", "nonbinary": "a person", "": "a person"}
_LOOK_AGE_BANDS = {"female": "in her thirties", "male": "in his thirties", "nonbinary": "in their thirties", "": "in their thirties"}
_LOOK_GENDER_CLAUSES = {
    "female": "\n\nThe person is a woman: write \"a woman with …\" where the noun is needed.",
    "male": "\n\nThe person is a man: write \"a man with …\" where the noun is needed.",
    "nonbinary": (
        "\n\nThe person is non-binary: write \"a person with …\" where the noun is needed, and never "
        "\"a woman\" or \"a man\"."
    ),
    "": (
        "\n\nThe person's gender was not given: write \"a person with …\" where the noun is needed, and do "
        "not assert one."
    ),
}


def look_system_prompt(gender: str | None = None) -> str:
    """The look instruction for a persona of the given saved gender.

    ``gender`` is the studio's own vocabulary (female / male / nonbinary, or
    '' / None for unset), normalised the same way the generate route's
    ``persona_gender`` is. It fixes the one noun the description may use —
    "a woman with …" / "a man with …" / "a person with …" — so the helper does
    not read a gender off the pictures that contradicts the saved one."""
    key = normalize_persona_gender(gender)
    return (
        LOOK_DESCRIPTION_SYSTEM_PROMPT.format(noun=_LOOK_NOUNS[key], age_band=_LOOK_AGE_BANDS[key])
        + _LOOK_GENDER_CLAUSES[key]
    )


# What the frontend stores is bounded at PERSONA_LOOK_MAX = 600 (personaId.js);
# the helper's answer is held shorter so a verbose model's third sentence never
# crowds the cast line it lands in.
LOOK_MAX_CHARS = 400
_LOOK_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```$")
# "Description:", "**Look:**", "Appearance -", "Here is the description:" …
_LOOK_LABEL = re.compile(
    r"^(?:here(?:'s| is)(?: the| a| your)?(?: compact| short)? )?"
    r"(?:description|look|appearance|answer|output|person|result)\s*[:\-–—]\s*",
    re.IGNORECASE,
)
_LOOK_WRAPPERS = "\"'`*_“”‘’«»"


def normalize_look(text: str) -> str:
    """The helper's answer as the persona will store it, or '' when nothing is left.

    Small vision models wrap the line in quotes, bold it, fence it, or start it
    with "Description:" even when told not to — each is mechanical to undo and
    each would otherwise land verbatim in a subject definition. Whitespace is
    collapsed to one line (the stored look is one or two lines, never a
    paragraph) and the result is capped at a word boundary."""
    look = _LOOK_FENCE.sub("", (text or "").strip())
    look = " ".join(look.split())
    for _ in range(3):
        before = look
        look = look.strip().strip(_LOOK_WRAPPERS).strip()
        look = look.lstrip("-•· ").strip()
        look = _LOOK_LABEL.sub("", look, count=1).strip()
        if look == before:
            break
    if len(look) > LOOK_MAX_CHARS:
        cut = look[:LOOK_MAX_CHARS]
        # Back up to the last word, then lose a dangling comma or semicolon.
        if " " in cut:
            cut = cut[: cut.rfind(" ")]
        look = cut.rstrip(" ,;:—–-")
    return look
