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
    "image": {
        "label": "Image",
        "system": _IMAGE,
    },
}

DEFAULT_VIDEO_PROFILE = "ltx-video"
DEFAULT_IMAGE_PROFILE = "image"


def profile_for(model_id: str, *, media_type: str = "video") -> str:
    """Which instruction to use for the model this prompt is headed to.

    The version lives in the workflow id, and the "dmd" token alone does not
    settle it: ``ltx23-eros-dmd`` is the v1.3 build while ``ltx23-eros-dmd-v12``
    is v1.2, which still wants v1.2-style prompting. So v1.2 is excluded before
    dmd is treated as a 1.3 signal.
    """
    ident = (model_id or "").strip().lower()
    if media_type == "image":
        return DEFAULT_IMAGE_PROFILE
    if "eros" in ident and "v12" not in ident and "v1.2" not in ident:
        if any(token in ident for token in ("v14", "v1.4", "v13", "v1.3", "dmd")):
            return "ltx-eros-scene-script"
    return DEFAULT_VIDEO_PROFILE


def system_prompt(profile: str) -> str:
    return PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["system"]


def profile_label(profile: str) -> str:
    return PROFILES.get(profile, PROFILES[DEFAULT_VIDEO_PROFILE])["label"]
