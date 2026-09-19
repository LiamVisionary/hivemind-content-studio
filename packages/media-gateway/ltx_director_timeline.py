"""LTX Director timeline: one validated data model for Extend, Keyframes and Timeline.

Translated from Mix-Studio's `lib/ltx-director-workflows.js` (L1-330, the
normalization half) — BlackMixture/Mix-Studio, GPL-3.0. See THIRD_PARTY_NOTICES.md.

The `LTXDirector` node takes a flat bundle of scalars (`timeline_data` JSON,
`local_prompts` joined by ' | ', `segment_lengths`, `guide_strength`) that only
make sense together. Deriving them from a checked project object is what keeps a
malformed timeline from reaching the sampler as a confusing node error — the
donor learned this the hard way and their normalizer is the durable part.

Two deliberate departures:

* Their `extensionSource` accepts either a file in the input dir OR a
  `{itemId, videoId}` pair pointing into their plaintext media library. We have
  no such library — our outputs are sealed envelopes — so only the input-file
  form is accepted here. The library form is rejected rather than silently
  ignored, so a caller that sends one gets told.
* Segment prompts are timeline content, not settings. Nothing here writes to
  disk; callers hold the project and send it per request.

Frame math worth stating once: the timeline is a fixed 24 fps grid, the render
window is capped at 20 seconds, and the sampler wants 8n+1 frames — so the
delivered length is `ceil((window - 1) / 8) * 8 + 1`, which is why a 5.0s ask
comes back as 121 frames rather than 120.
"""

import json
import os
import posixpath

DIRECTOR_VERSION = 1
DIRECTOR_FPS = 24
DIRECTOR_MAX_SECONDS = 1000
DIRECTOR_MAX_FRAMES = DIRECTOR_FPS * DIRECTOR_MAX_SECONDS
# The node samples one window at a time; 20s is the ceiling it was built for.
DIRECTOR_MAX_WINDOW_FRAMES = DIRECTOR_FPS * 20
DIRECTOR_MAX_SEGMENTS = 256
DIRECTOR_MAX_PROMPT = 4000

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".webm", ".mov"})
AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"})

RESIZE_METHODS = ("maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop")
RESAMPLE_MODES = ("nearest", "bilinear", "bicubic")


class DirectorProjectError(ValueError):
    """A timeline the node would reject, refused here where the message is useful."""


def _finite_int(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):
        return fallback
    return int(round(number))


def _clamp(value, low, high):
    return max(low, min(high, value))


def _prompt_text(value, label="Prompt"):
    text = str(value or "").strip()
    if len(text) > DIRECTOR_MAX_PROMPT:
        raise DirectorProjectError(f"{label} is too long")
    return text


def normalize_asset_name(value, kind):
    """A media name that stays inside the input directory.

    Absolute paths, drive letters, '..', embedded newlines and unknown
    extensions are all refused — this string is handed to a node that will
    happily open whatever it is given.
    """
    name = str(value or "").strip().replace("\\", "/")
    if not name:
        raise DirectorProjectError(f"{kind} segment is missing its media file")
    if len(name) > 512 or name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        raise DirectorProjectError(f"{kind} segment has an invalid media file")
    if any(ch in name for ch in ("\0", "\r", "\n")):
        raise DirectorProjectError(f"{kind} segment has an invalid media file")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise DirectorProjectError(f"{kind} segment has an invalid media file")
    extension = posixpath.splitext(name)[1].lower()
    allowed = {
        "image": IMAGE_EXTENSIONS,
        "video": VIDEO_EXTENSIONS,
        "audio": AUDIO_EXTENSIONS,
    }[kind]
    if extension not in allowed:
        raise DirectorProjectError(f"{kind} segment uses an unsupported file type")
    return name


def _normalize_bounds(segment, duration_frames, label):
    start = _finite_int(segment.get("start"), 0)
    length = _finite_int(segment.get("length"), 1)
    if start < 0 or length < 1 or start >= duration_frames or start + length > duration_frames:
        raise DirectorProjectError(f"{label} segment falls outside the project timeline")
    return start, length


def _normalize_id(value, prefix, index):
    raw = str(value or f"{prefix}-{index + 1}").strip()
    cleaned = "".join(ch if (ch.isalnum() or ch in "_-") else "-" for ch in raw)[:80]
    return cleaned or f"{prefix}-{index + 1}"


def _reject_overlaps(segments, label):
    for previous, current in zip(segments, segments[1:]):
        if current["start"] < previous["start"] + previous["length"]:
            raise DirectorProjectError(f"{label} segments cannot overlap")


def _sorted_segments(segments):
    return sorted(segments, key=lambda s: (s["start"], s["id"]))


def _file_label(value, fallback):
    return (str(value).strip() if value else "") [:255] or fallback


def normalize_extension_source(value):
    """The clip an Extend continues from. Input-file form only — see module docstring."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise DirectorProjectError("Director extension source is invalid")
    if value.get("itemId") or value.get("videoId"):
        raise DirectorProjectError(
            "Director extension source must name a file in the input directory; "
            "library ids are not supported on this stack"
        )
    input_name = normalize_asset_name(value.get("inputName"), "video")

    source_seconds = value.get("sourceSeconds")
    if source_seconds not in (None, ""):
        source_seconds = float(source_seconds)
        if not 0 < source_seconds <= 20:
            raise DirectorProjectError(
                "Director extension source duration must be between 0 and 20 seconds"
            )
    else:
        source_seconds = None

    dimensions = {}
    for key, label in (("sourceWidth", "width"), ("sourceHeight", "height")):
        raw = value.get(key)
        if raw in (None, ""):
            dimensions[key] = None
            continue
        number = _finite_int(raw, None)
        if number is None or not 16 <= number <= 8192:
            raise DirectorProjectError(
                f"Director extension source {label} must be between 16 and 8,192 pixels"
            )
        dimensions[key] = number
    if (dimensions["sourceWidth"] is None) != (dimensions["sourceHeight"] is None):
        raise DirectorProjectError(
            "Director extension source width and height must be provided together"
        )

    return {
        "inputName": input_name,
        "fileName": _file_label(
            value.get("fileName") or value.get("label"), posixpath.basename(input_name)
        ),
        "sourceSeconds": source_seconds,
        "sourceWidth": dimensions["sourceWidth"],
        "sourceHeight": dimensions["sourceHeight"],
        "sourceHasAudio": value.get("sourceHasAudio") is True,
        "continueAudio": value.get("continueAudio") is not False,
    }


def _normalize_main_segments(value, duration_frames):
    source = value if isinstance(value, list) else []
    if len(source) > DIRECTOR_MAX_SEGMENTS:
        raise DirectorProjectError("Director main track has too many segments")
    segments = []
    for index, entry in enumerate(source):
        item = entry if isinstance(entry, dict) else {}
        kind = "image" if item.get("type") == "image" else "text"
        start, length = _normalize_bounds(item, duration_frames, "Main track")
        segment = {
            "id": _normalize_id(item.get("id"), "main", index),
            "type": kind,
            "start": start,
            "length": length,
            "prompt": _prompt_text(item.get("prompt"), "Segment prompt"),
        }
        if kind == "image":
            image_file = normalize_asset_name(
                item.get("imageFile") or item.get("assetName") or item.get("name"), "image"
            )
            segment["imageFile"] = image_file
            segment["fileName"] = _file_label(
                item.get("fileName"), posixpath.basename(image_file)
            )
            guide = item.get("guideStrength")
            segment["guideStrength"] = _clamp(
                float(guide) if isinstance(guide, (int, float)) else 1.0, 0.0, 1.0
            )
            segment["isEndFrame"] = item.get("isEndFrame") is True
        segments.append(segment)
    segments = _sorted_segments(segments)
    _reject_overlaps(segments, "Main track")
    return segments


def _normalize_timed_media(value, duration_frames, *, label, kind, id_prefix):
    """Audio and IC-guidance tracks differ only in which fields they carry."""
    source = value if isinstance(value, list) else []
    if len(source) > DIRECTOR_MAX_SEGMENTS:
        raise DirectorProjectError(f"Director {label.lower()} has too many segments")
    segments = []
    for index, entry in enumerate(source):
        item = entry if isinstance(entry, dict) else {}
        start, length = _normalize_bounds(item, duration_frames, label)
        trim_start = max(0, _finite_int(item.get("trimStart"), 0))
        if kind == "audio":
            media = normalize_asset_name(
                item.get("audioFile") or item.get("assetName") or item.get("name"), "audio"
            )
            declared = _finite_int(
                item.get("audioDurationFrames") or item.get("sourceFrames"), trim_start + length
            )
            segment = {
                "id": _normalize_id(item.get("id"), id_prefix, index),
                "type": "audio",
                "start": start,
                "length": length,
                "trimStart": trim_start,
                # A source shorter than the slice it is asked to fill is a lie
                # the node cannot act on, so the floor wins.
                "audioDurationFrames": max(trim_start + length, declared),
                "audioFile": media,
                "fileName": _file_label(item.get("fileName"), posixpath.basename(media)),
            }
        else:
            is_static = item.get("isStaticImage") is True or item.get("kind") == "image"
            media = normalize_asset_name(
                item.get("videoFile") or item.get("assetName") or item.get("name"),
                "image" if is_static else "video",
            )
            declared = _finite_int(
                item.get("videoDurationFrames") or item.get("sourceFrames"), trim_start + length
            )
            strength = item.get("videoStrength")
            attention = item.get("videoAttentionStrength")
            segment = {
                "id": _normalize_id(item.get("id"), id_prefix, index),
                "type": "motion_video",
                "isStaticImage": is_static,
                "start": start,
                "length": length,
                "trimStart": trim_start,
                "videoDurationFrames": max(trim_start + length, declared),
                "videoFile": media,
                "fileName": _file_label(item.get("fileName"), posixpath.basename(media)),
                "videoStrength": _clamp(
                    float(strength) if isinstance(strength, (int, float)) else 1.0, 0.0, 1.0
                ),
                "videoAttentionStrength": _clamp(
                    float(attention) if isinstance(attention, (int, float)) else 0.65, 0.0, 1.0
                ),
                "resampleMode": item.get("resampleMode")
                if item.get("resampleMode") in RESAMPLE_MODES else "nearest",
            }
        segments.append(segment)
    segments = _sorted_segments(segments)
    _reject_overlaps(segments, label)
    return segments


def _normalize_settings(value, motion_segments):
    settings = value if isinstance(value, dict) else {}
    # The donor rewrites '/' to '\' here, which is a Windows-ism: ComfyUI reports
    # LoRA names with the host separator, and on this stack the node's own combo
    # lists them as 'ltx/2.3/....safetensors'. Backslashes would simply not match.
    ic_lora = str(settings.get("icLoraName") or "").strip().replace("\\", "/")[:512]
    strength = settings.get("icLoraStrength")
    epsilon = settings.get("epsilon")
    return {
        "inpaintAudio": settings.get("inpaintAudio") is not False,
        # Overriding audio only means something when a real motion VIDEO is
        # present; a still cannot carry a soundtrack.
        "overrideAudio": settings.get("overrideAudio") is True
        and any(not s["isStaticImage"] for s in motion_segments),
        "icLoraName": ic_lora,
        "icLoraStrength": _clamp(
            float(strength) if isinstance(strength, (int, float)) else 1.0, -100.0, 100.0
        ),
        "epsilon": _clamp(
            float(epsilon) if isinstance(epsilon, (int, float)) else 0.001, 0.0001, 0.99
        ),
        "resizeMethod": settings.get("resizeMethod")
        if settings.get("resizeMethod") in RESIZE_METHODS else "maintain aspect ratio",
        "imgCompression": _clamp(_finite_int(settings.get("imgCompression"), 18), 0, 100),
    }


def normalize_director_project(value=None):
    """Validate a timeline project and return the canonical form."""
    if not isinstance(value, dict) or _finite_int(value.get("version"), None) != DIRECTOR_VERSION:
        raise DirectorProjectError(f"Director project version {DIRECTOR_VERSION} is required")
    if value.get("fps") is not None and _finite_int(value.get("fps"), None) != DIRECTOR_FPS:
        raise DirectorProjectError("Director projects use a fixed 24 fps timeline")

    duration_frames = _finite_int(value.get("durationFrames"), None)
    if duration_frames is None or not 1 <= duration_frames <= DIRECTOR_MAX_FRAMES:
        raise DirectorProjectError(
            f"Director project length must be between 1 and {DIRECTOR_MAX_FRAMES:,} frames"
        )

    window = value.get("range") if isinstance(value.get("range"), dict) else {}
    start_frame = _finite_int(window.get("startFrame"), 0)
    length_frames = _finite_int(window.get("lengthFrames"), min(120, duration_frames))
    if (
        start_frame < 0
        or length_frames < 1
        or length_frames > DIRECTOR_MAX_WINDOW_FRAMES
        or start_frame + length_frames > duration_frames
    ):
        raise DirectorProjectError(
            "Director generation range must stay inside the project and be no longer "
            "than 20 seconds"
        )

    global_prompt = _prompt_text(value.get("globalPrompt"), "Global prompt")
    segments = _normalize_main_segments(value.get("segments"), duration_frames)
    audio_segments = _normalize_timed_media(
        value.get("audioSegments"), duration_frames,
        label="Audio track", kind="audio", id_prefix="audio",
    )
    motion_segments = _normalize_timed_media(
        value.get("motionSegments"), duration_frames,
        label="IC guidance track", kind="motion", id_prefix="motion",
    )
    if not global_prompt and not any(s["prompt"] for s in segments):
        raise DirectorProjectError("Director needs a global or segment prompt")

    return {
        "version": DIRECTOR_VERSION,
        "fps": DIRECTOR_FPS,
        "durationFrames": duration_frames,
        "range": {"startFrame": start_frame, "lengthFrames": length_frames},
        "globalPrompt": global_prompt,
        "extensionSource": normalize_extension_source(value.get("extensionSource")),
        "segments": segments,
        "audioSegments": audio_segments,
        "motionSegments": motion_segments,
        "settings": _normalize_settings(value.get("settings"), motion_segments),
    }


def director_prompt_inputs(project):
    """The three scalars the node wants: joined prompts, their lengths, guide strengths.

    Gaps between segments are absorbed by the PRECEDING prompt (or the first one,
    when the gap opens the window), because the node reads segment_lengths as a
    partition of the window — a hole would shift every prompt after it.
    """
    start_frame = project["range"]["startFrame"]
    end_frame = start_frame + project["range"]["lengthFrames"]
    prompts, lengths = [], []
    cursor = start_frame
    pending_gap = 0

    for segment in project["segments"]:
        if segment["start"] + segment["length"] <= start_frame:
            continue
        if segment["start"] >= end_frame:
            break
        effective_start = max(segment["start"], start_frame)
        if effective_start > cursor:
            gap = min(effective_start, end_frame) - cursor
            if lengths:
                lengths[-1] += gap
            else:
                pending_gap += gap
        clipped_end = min(segment["start"] + segment["length"], end_frame)
        lengths.append(clipped_end - effective_start + pending_gap)
        prompts.append(segment["prompt"] or "")
        pending_gap = 0
        cursor = max(cursor, segment["start"] + segment["length"])

    clamped = min(cursor, end_frame)
    if lengths and clamped < end_frame:
        lengths[-1] += end_frame - clamped

    strengths = [
        f"{segment['guideStrength']:.2f}"
        for segment in project["segments"]
        if segment["type"] == "image"
        and segment["start"] + segment["length"] > start_frame
        and segment["start"] < end_frame
    ]
    return {
        "localPrompts": " | ".join(prompts),
        "segmentLengths": ",".join(str(n) for n in lengths),
        "guideStrength": ",".join(strengths),
    }


def director_timeline_data(project):
    """The `timeline_data` widget value — a JSON string, not a dict."""
    return json.dumps({
        "mainTrackEnabled": True,
        "audioTrackEnabled": len(project["audioSegments"]) > 0,
        "motionTrackEnabled": len(project["motionSegments"]) > 0,
        "showFilenames": True,
        "overrideAudio": project["settings"]["overrideAudio"],
        "inpaint_audio": project["settings"]["inpaintAudio"],
        "global_prompt": project["globalPrompt"],
        "retakeMode": False,
        "normalStartFrame": project["range"]["startFrame"],
        "normalDurationFrames": project["range"]["lengthFrames"],
        "segments": project["segments"],
        "motionSegments": project["motionSegments"],
        "audioSegments": project["audioSegments"],
    })


def director_asset_names(project):
    """Every input file the project references, de-duplicated, in track order."""
    names = []
    for name in (
        [s["imageFile"] for s in project["segments"] if s["type"] == "image"]
        + [s["audioFile"] for s in project["audioSegments"]]
        + [s["videoFile"] for s in project["motionSegments"]]
    ):
        if name not in names:
            names.append(name)
    return names


def director_output_frames(project):
    """The sampler's 8n+1 lattice — a 120-frame window is delivered as 121."""
    length = project["range"]["lengthFrames"]
    return -(-(length - 1) // 8) * 8 + 1


def director_window_project(project):
    """Re-base the project onto its render window so frame 0 is the window start."""
    range_start = project["range"]["startFrame"]
    range_end = range_start + project["range"]["lengthFrames"]

    def clip(segment):
        start = max(segment["start"], range_start)
        end = min(segment["start"] + segment["length"], range_end)
        if end <= start:
            return None
        clipped = dict(segment)
        clipped["start"] = start - range_start
        clipped["length"] = end - start
        if segment["type"] in ("audio", "motion_video"):
            # Trimming the head of a slice has to advance into the source too,
            # or the media silently restarts partway through the window.
            clipped["trimStart"] = max(0, int(segment.get("trimStart", 0)) + (start - segment["start"]))
        return clipped

    windowed = dict(project)
    windowed["durationFrames"] = project["range"]["lengthFrames"]
    windowed["range"] = {"startFrame": 0, "lengthFrames": project["range"]["lengthFrames"]}
    for key in ("segments", "audioSegments", "motionSegments"):
        windowed[key] = [c for c in (clip(s) for s in project[key]) if c]
    return windowed


def director_missing_assets(project, input_dir):
    """Which referenced files are not actually in the input directory.

    The node reports a missing asset as a mid-sample failure; naming them up
    front is the difference between a fixable message and a stack trace.
    """
    missing = []
    for name in director_asset_names(project):
        if not os.path.isfile(os.path.join(input_dir, name)):
            missing.append(name)
    return missing
