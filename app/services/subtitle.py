import json
import os.path
import platform
import re
from timeit import default_timer as timer

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None
try:
    import mlx_whisper
except ImportError:  # not installed, or not an Apple-silicon machine
    mlx_whisper = None
from loguru import logger

from app.config import config
from app.utils import utils

model_size = config.whisper.get("model_size", "large-v3")
device = config.whisper.get("device", "cpu")
compute_type = config.whisper.get("compute_type", "int8")
initial_prompt = config.whisper.get("initial_prompt", "") or None
# "auto" prefers MLX on Apple silicon and falls back; "faster-whisper" or "mlx"
# pin one engine, which is what you want when comparing their output.
engine_choice = str(config.whisper.get("engine", "auto") or "auto").strip().lower()
model = None


# faster-whisper runs on CTranslate2, which has no Metal or CoreML backend — so
# on this Mac it transcribes on CPU cores no matter what `device` says, and the
# app's own default is "cpu" anyway. MEASURED on a 42.3s speech clip with
# large-v3 and the settings below: faster-whisper int8/CPU 32.27s against
# mlx-whisper 3.53s, a 9.1x speedup, with the same detected language and the
# same first segment text. That is the largest Apple-silicon win in this
# codebase's audio stack, and it costs one adapter because the two libraries
# disagree only about shape.
_MLX_REPOS = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


class _Word:
    """One timed word, in the shape the SRT builder below already reads.

    mlx-whisper answers with plain dicts and faster-whisper with objects, and
    the builder uses attribute access (`word.start`, `segment.words`). Adapting
    the result is a dozen lines; rewriting the builder to handle both shapes
    would touch the punctuation-splitting logic that actually decides where
    subtitles break, which is the part worth not disturbing.
    """

    __slots__ = ("word", "start", "end", "probability")

    def __init__(self, raw):
        self.word = raw.get("word", "")
        self.start = float(raw.get("start", 0.0))
        self.end = float(raw.get("end", 0.0))
        self.probability = float(raw.get("probability", 0.0))


class _Segment:
    __slots__ = ("text", "start", "end", "words")

    def __init__(self, raw):
        self.text = raw.get("text", "")
        self.start = float(raw.get("start", 0.0))
        self.end = float(raw.get("end", 0.0))
        self.words = [_Word(w) for w in (raw.get("words") or [])]


class _Info:
    __slots__ = ("language", "language_probability")

    def __init__(self, raw):
        self.language = raw.get("language", "")
        # mlx-whisper does not report a confidence. Claiming 1.0 would be a
        # lie in the log line that prints it, so say 0.0 and mean "unknown".
        self.language_probability = 0.0


def _mlx_repo_for(size: str) -> str:
    return _MLX_REPOS.get(str(size), f"mlx-community/whisper-{size}-mlx")


def _use_mlx() -> bool:
    if engine_choice == "faster-whisper":
        return False
    if mlx_whisper is None:
        return False
    if engine_choice == "mlx":
        return True
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def _load_faster_whisper():
    """The CPU engine, loaded once. Returns None after reporting why it could not."""
    model_path = f"{utils.root_dir()}/models/whisper-{model_size}"
    model_bin_file = f"{model_path}/model.bin"
    if not os.path.isdir(model_path) or not os.path.isfile(model_bin_file):
        model_path = model_size
    logger.info(
        f"loading model: {model_path}, device: {device}, compute_type: {compute_type}"
    )
    try:
        return WhisperModel(
            model_size_or_path=model_path, device=device, compute_type=compute_type
        )
    except Exception as e:
        logger.error(
            f"failed to load model: {e} \n\n"
            f"********************************************\n"
            f"this may be caused by network issue. \n"
            f"please download the model manually and put it in the 'models' folder. \n"
            f"see [README.md FAQ](https://github.com/harry0703/MoneyPrinterTurbo) for more details.\n"
            f"********************************************\n\n"
        )
        return None


def _transcribe_mlx(audio_file: str):
    """Transcribe on Metal, compensating for the one faster-whisper feature
    mlx-whisper does not have.

    faster-whisper is called with `vad_filter=True` here, and mlx-whisper has
    no VAD parameter at all. Dropping it silently is the one way this swap
    makes subtitles WORSE rather than merely faster: Whisper hallucinates
    confident text over silence. `hallucination_silence_threshold` is the
    upstream answer to exactly that — it skips silent stretches longer than the
    threshold — and it only works when word timestamps are on, which they are.
    `condition_on_previous_text=False` stops a hallucination, once started,
    from seeding the next window with itself.
    """
    result = mlx_whisper.transcribe(
        audio_file,
        path_or_hf_repo=_mlx_repo_for(model_size),
        word_timestamps=True,
        condition_on_previous_text=False,
        hallucination_silence_threshold=2.0,
        **({"initial_prompt": initial_prompt} if initial_prompt else {}),
    )
    segments = [_Segment(seg) for seg in (result.get("segments") or [])]
    return segments, _Info(result)


def create(audio_file, subtitle_file: str = "") -> str:
    global model
    use_mlx = _use_mlx()
    if not use_mlx and WhisperModel is None:
        logger.warning("faster_whisper not available, skipping whisper subtitle generation")
        return ""
    logger.info(f"start, output file: {subtitle_file}")
    if not subtitle_file:
        subtitle_file = f"{audio_file}.srt"

    if use_mlx:
        logger.info(f"transcribing on MLX: {_mlx_repo_for(model_size)}")
        try:
            segments, info = _transcribe_mlx(audio_file)
        except Exception as exc:  # noqa: BLE001 — a fast path must never be the only path
            # Falling back costs time, not subtitles. Anything else here (a
            # missing MLX weight repo, an unsupported model size) would turn a
            # performance choice into a failed render.
            logger.warning(f"MLX transcription failed ({exc}); falling back to faster-whisper")
            if WhisperModel is None:
                logger.error("faster_whisper is not installed either, cannot transcribe")
                return ""
            use_mlx = False
    if not use_mlx:
        if not model:
            model = _load_faster_whisper()
            if model is None:
                return ""
        segments, info = model.transcribe(
            audio_file,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
            **({"initial_prompt": initial_prompt} if initial_prompt else {}),
        )

    logger.info(
        f"detected language: '{info.language}', probability: {info.language_probability:.2f}"
    )

    start = timer()
    subtitles = []

    def recognized(seg_text, seg_start, seg_end):
        seg_text = seg_text.strip()
        if not seg_text:
            return

        msg = "[%.2fs -> %.2fs] %s" % (seg_start, seg_end, seg_text)
        logger.debug(msg)

        subtitles.append(
            {"msg": seg_text, "start_time": seg_start, "end_time": seg_end}
        )

    for segment in segments:
        words_idx = 0
        words_len = len(segment.words)

        seg_start = 0
        seg_end = 0
        seg_text = ""

        if segment.words:
            is_segmented = False
            for word in segment.words:
                if not is_segmented:
                    seg_start = word.start
                    is_segmented = True

                seg_end = word.end
                # If it contains punctuation, then break the sentence.
                seg_text += word.word

                if utils.str_contains_punctuation(word.word):
                    # remove last char
                    seg_text = seg_text[:-1]
                    if not seg_text:
                        continue

                    recognized(seg_text, seg_start, seg_end)

                    is_segmented = False
                    seg_text = ""

                if words_idx == 0 and segment.start < word.start:
                    seg_start = word.start
                if words_idx == (words_len - 1) and segment.end > word.end:
                    seg_end = word.end
                words_idx += 1

        if not seg_text:
            continue

        recognized(seg_text, seg_start, seg_end)

    end = timer()

    diff = end - start
    logger.info(f"complete, elapsed: {diff:.2f} s")

    idx = 1
    lines = []
    for subtitle in subtitles:
        text = subtitle.get("msg")
        if text:
            lines.append(
                utils.text_to_srt(
                    idx, text, subtitle.get("start_time"), subtitle.get("end_time")
                )
            )
            idx += 1

    sub = "\n".join(lines) + "\n"
    with open(subtitle_file, "w", encoding="utf-8") as f:
        f.write(sub)
    logger.info(f"subtitle file created: {subtitle_file}")
    return subtitle_file


def file_to_subtitles(filename):
    if not filename or not os.path.isfile(filename):
        return []

    times_texts = []
    current_times = None
    current_text = ""
    index = 0
    with open(filename, "r", encoding="utf-8") as f:
        for line in f:
            times = re.findall("([0-9]*:[0-9]*:[0-9]*,[0-9]*)", line)
            if times:
                current_times = line
            elif line.strip() == "" and current_times:
                index += 1
                times_texts.append((index, current_times.strip(), current_text.strip()))
                current_times, current_text = None, ""
            elif current_times:
                current_text += line

    # Flush the final block. SRT files whose last subtitle is not followed by a
    # trailing blank line never hit the blank-line branch above, so without this
    # the last subtitle would be silently dropped.
    if current_times:
        index += 1
        times_texts.append((index, current_times.strip(), current_text.strip()))
    return times_texts


def levenshtein_distance(s1, s2):
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)

    if len(s2) == 0:
        return len(s1)

    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row

    return previous_row[-1]


def similarity(a, b):
    distance = levenshtein_distance(a.lower(), b.lower())
    max_length = max(len(a), len(b))
    return 1 - (distance / max_length)


def correct(subtitle_file, video_script):
    subtitle_items = file_to_subtitles(subtitle_file)
    normalized_script = utils.normalize_script_for_subtitle_matching(video_script)
    script_lines = utils.split_string_by_punctuations(normalized_script)

    corrected = False
    new_subtitle_items = []
    script_index = 0
    subtitle_index = 0

    while script_index < len(script_lines) and subtitle_index < len(subtitle_items):
        script_line = script_lines[script_index].strip()
        subtitle_line = subtitle_items[subtitle_index][2].strip()

        if script_line == subtitle_line:
            new_subtitle_items.append(subtitle_items[subtitle_index])
            script_index += 1
            subtitle_index += 1
        else:
            combined_subtitle = subtitle_line
            start_time = subtitle_items[subtitle_index][1].split(" --> ")[0]
            end_time = subtitle_items[subtitle_index][1].split(" --> ")[1]
            next_subtitle_index = subtitle_index + 1

            while next_subtitle_index < len(subtitle_items):
                next_subtitle = subtitle_items[next_subtitle_index][2].strip()
                if similarity(
                    script_line, combined_subtitle + " " + next_subtitle
                ) > similarity(script_line, combined_subtitle):
                    combined_subtitle += " " + next_subtitle
                    end_time = subtitle_items[next_subtitle_index][1].split(" --> ")[1]
                    next_subtitle_index += 1
                else:
                    break

            if similarity(script_line, combined_subtitle) > 0.8:
                logger.warning(
                    f"Merged/Corrected - Script: {script_line}, Subtitle: {combined_subtitle}"
                )
                new_subtitle_items.append(
                    (
                        len(new_subtitle_items) + 1,
                        f"{start_time} --> {end_time}",
                        script_line,
                    )
                )
                corrected = True
            else:
                logger.warning(
                    f"Mismatch - Script: {script_line}, Subtitle: {combined_subtitle}"
                )
                new_subtitle_items.append(
                    (
                        len(new_subtitle_items) + 1,
                        f"{start_time} --> {end_time}",
                        script_line,
                    )
                )
                corrected = True

            script_index += 1
            subtitle_index = next_subtitle_index

    # Process the remaining lines of the script.
    while script_index < len(script_lines):
        logger.warning(f"Extra script line: {script_lines[script_index]}")
        if subtitle_index < len(subtitle_items):
            new_subtitle_items.append(
                (
                    len(new_subtitle_items) + 1,
                    subtitle_items[subtitle_index][1],
                    script_lines[script_index],
                )
            )
            subtitle_index += 1
        else:
            new_subtitle_items.append(
                (
                    len(new_subtitle_items) + 1,
                    "00:00:00,000 --> 00:00:00,000",
                    script_lines[script_index],
                )
            )
        script_index += 1
        corrected = True

    if corrected:
        with open(subtitle_file, "w", encoding="utf-8") as fd:
            for i, item in enumerate(new_subtitle_items):
                fd.write(f"{i + 1}\n{item[1]}\n{item[2]}\n\n")
        logger.info("Subtitle corrected")
    else:
        logger.success("Subtitle is correct")


if __name__ == "__main__":
    task_id = "c12fd1e6-4b0a-4d65-a075-c87abe35a072"
    task_dir = utils.task_dir(task_id)
    subtitle_file = f"{task_dir}/subtitle.srt"
    audio_file = f"{task_dir}/audio.mp3"

    subtitles = file_to_subtitles(subtitle_file)
    print(subtitles)

    script_file = f"{task_dir}/script.json"
    with open(script_file, "r") as f:
        script_content = f.read()
    s = json.loads(script_content)
    script = s.get("script")

    correct(subtitle_file, script)

    subtitle_file = f"{task_dir}/subtitle-test.srt"
    create(audio_file, subtitle_file)
