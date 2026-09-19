"""Take a finished clip's sound apart: dialogue, effects, music, and each voice.

A generated video comes back with one soundtrack, and that is rarely what an
editor wants. They want the line without the score under it, or the score
without the line, or the two people who talk over each other on two tracks they
can level separately. This pack is the model half of that: two separators from
TIGER (Kai Li et al., MIT), vendored under ./tiger.

  HivemindSplitSoundtrack   AUDIO -> dialogue, effects, music   (TIGER-DnR, 44.1 kHz)
  HivemindSplitVoices       AUDIO -> voice_1, voice_2           (TIGER-speech, 16 kHz mono)
  HivemindPreviewStemWav    AUDIO -> a 16-bit WAV in ComfyUI's TEMP directory

Why vendored rather than installed from the node packs that wrap the same
models: billwuhao/ComfyUI_AudioTools imports every node it ships at load - a
subtitle burner, a recorder, a watermarker that pulls a package from git, a
layer file that needs `torch_complex`, which nothing installs - so on this
stack the pack does not import at all and the two nodes worth having go down
with the rest. The model itself is five files and needs only torch.

Why the output node is ours: the stems are handed back to the person who asked
and are never an output of the studio (see gateway run_audio_split), so they
leave through the temp directory the way a smart-select mask does. Core
PreviewAudio writes FLAC there; an editor's timeline wants WAV, and several
still refuse FLAC outright. `wave` is in the standard library, so this costs no
dependency.

The weights are not downloaded here. The gateway installs them - pinned to a
revision, checked against a SHA-256 - before it queues the graph, because it is
the process that can tell the person what it is doing while it does it. A lane
asked to run without them says which file is missing and stops.
"""

from __future__ import annotations

import os
import uuid
import wave

import torch

import comfy.model_management
import folder_paths

from .tiger import TIGER, TIGERDNR

# The constructor arguments each checkpoint was trained with - the contents of
# the config.json beside it on Hugging Face, fixed here because a checkpoint
# pinned by hash cannot change shape, and one less file to fetch is one less
# file to be wrong.
SOUNDTRACK_MODEL = {
    "folder": "TIGER-DnR",
    "sample_rate": 44100,
    "args": dict(
        out_channels=132, in_channels=256, num_blocks=8, upsampling_depth=5,
        att_n_head=4, att_hid_chan=4, att_kernel_size=8, att_stride=1,
        win=2048, stride=512, num_sources=3, sample_rate=44100,
    ),
}
VOICES_MODEL = {
    "folder": "TIGER-speech",
    "sample_rate": 16000,
    "args": dict(
        out_channels=128, in_channels=256, num_blocks=8, upsampling_depth=5,
        att_n_head=4, att_hid_chan=4, att_kernel_size=8, att_stride=1,
        win=640, stride=160, num_sources=2, sample_rate=16000,
    ),
}
MODELS_SUBDIR = "audio_separation"

# TIGER-speech attends across the whole clip at once, so its memory grows with
# the square of the duration, and cutting the clip into windows is not a way
# out: the model has no idea which of its two outputs was "voice 1" in the
# window before, so the speakers would swap tracks at every seam. A generated
# clip is seconds long; this is the ceiling that keeps a mistaken hour-long
# upload from taking the lane down instead of answering.
MAX_VOICE_SECONDS = 300

_loaded: "dict[str, torch.nn.Module]" = {}


def _weights_path(spec) -> str:
    return os.path.join(folder_paths.models_dir, MODELS_SUBDIR, spec["folder"], "model.safetensors")


def _model(spec, cls):
    key = spec["folder"]
    model = _loaded.get(key)
    if model is None:
        path = _weights_path(spec)
        if not os.path.isfile(path):
            raise RuntimeError(
                f"The sound separator's weights are not on this lane: {MODELS_SUBDIR}/{key}/model.safetensors. "
                "Split the sound from the studio once and it installs them."
            )
        from safetensors.torch import load_file

        model = cls(**spec["args"])
        model.load_state_dict(load_file(path), strict=True)
        model.eval()
        _loaded[key] = model
    return model


def _resampled(waveform, source_rate, target_rate):
    if int(source_rate) == int(target_rate):
        return waveform
    import torchaudio.functional as AF

    return AF.resample(waveform, int(source_rate), int(target_rate))


def _audio(waveform, sample_rate):
    # ComfyUI's AUDIO is (batch, channels, samples) on the CPU.
    return {"waveform": waveform.detach().to("cpu", torch.float32).unsqueeze(0), "sample_rate": int(sample_rate)}


class HivemindSplitSoundtrack:
    """One soundtrack in; its dialogue, its effects and its music out."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("AUDIO", "AUDIO", "AUDIO")
    RETURN_NAMES = ("dialogue", "effects", "music")
    FUNCTION = "split"
    CATEGORY = "hivemind/audio"
    DESCRIPTION = "Split a soundtrack into dialogue, effects and music (TIGER-DnR)."

    def split(self, audio):
        rate = SOUNDTRACK_MODEL["sample_rate"]
        waveform = _resampled(audio["waveform"][0].to(torch.float32), audio["sample_rate"], rate)
        if waveform.shape[-1] == 0:
            raise RuntimeError("That clip has no sound to split.")
        device = comfy.model_management.get_torch_device()
        model = _model(SOUNDTRACK_MODEL, TIGERDNR).to(device)
        try:
            with torch.no_grad():
                # (1, channels, samples): the model windows a long clip itself
                # (12 s windows, 4 s apart), so memory does not grow with length.
                dialogue, effects, music = model(waveform.to(device)[None])
        finally:
            model.to("cpu")
            comfy.model_management.soft_empty_cache()
        return (_audio(dialogue, rate), _audio(effects, rate), _audio(music, rate))


class HivemindSplitVoices:
    """Two people talking, even over each other, onto a track each."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("AUDIO", "AUDIO")
    RETURN_NAMES = ("voice_1", "voice_2")
    FUNCTION = "split"
    CATEGORY = "hivemind/audio"
    DESCRIPTION = "Separate two speakers into a track each (TIGER-speech, 16 kHz mono)."

    def split(self, audio):
        rate = VOICES_MODEL["sample_rate"]
        waveform = audio["waveform"][0].to(torch.float32)
        if waveform.shape[-1] == 0:
            raise RuntimeError("That clip has no sound to split.")
        mono = _resampled(waveform.mean(dim=0, keepdim=True), audio["sample_rate"], rate)
        if mono.shape[-1] > MAX_VOICE_SECONDS * rate:
            raise RuntimeError(
                f"Voices can be separated in clips up to {MAX_VOICE_SECONDS // 60} minutes long. "
                "Trim the clip and split it again."
            )
        device = comfy.model_management.get_torch_device()
        model = _model(VOICES_MODEL, TIGER).to(device)
        try:
            with torch.no_grad():
                voices = model(mono.to(device))[0]  # (speakers, samples)
        finally:
            model.to("cpu")
            comfy.model_management.soft_empty_cache()
        voices = voices[..., : mono.shape[-1]]
        return (_audio(voices[0:1], rate), _audio(voices[1:2], rate))


def _level_db(samples) -> float:
    """RMS in dBFS. A separator asked for two voices always returns two tracks;
    when only one person spoke, the other is near-silence, and this is how the
    studio knows not to offer it as a voice."""
    if samples.numel() == 0:
        return -120.0
    rms = float(samples.to(torch.float32).pow(2).mean().sqrt())
    return round(20.0 * torch.log10(torch.tensor(max(rms, 1e-6))).item(), 1)


class HivemindPreviewStemWav:
    """Write a stem to ComfyUI's temp directory as 16-bit PCM WAV."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "hivemind/audio"
    DESCRIPTION = "Hand a stem back through the temp directory as WAV; it never becomes an output."

    def save(self, audio):
        waveform = audio["waveform"][0].detach().to("cpu", torch.float32)
        # A separator's estimate can overshoot full scale by a hair where the
        # mix itself was hot. Clamped, not normalised: the stems of one clip
        # have to keep their levels relative to each other, or laying them back
        # together no longer gives the soundtrack they came from.
        pcm = (waveform.clamp(-1.0, 1.0) * 32767.0).round().to(torch.int16)
        directory = folder_paths.get_temp_directory()
        os.makedirs(directory, exist_ok=True)
        # Random, not a counter: nothing about the clip is in the name, and two
        # splits running at once cannot collide.
        filename = f"hivemind-stem-{uuid.uuid4().hex}.wav"
        with wave.open(os.path.join(directory, filename), "wb") as handle:
            handle.setnchannels(int(pcm.shape[0]))
            handle.setsampwidth(2)
            handle.setframerate(int(audio["sample_rate"]))
            handle.writeframes(pcm.transpose(0, 1).contiguous().numpy().tobytes())
        return {
            "ui": {
                "audio": [{"filename": filename, "subfolder": "", "type": "temp"}],
                "level_db": [_level_db(waveform)],
                "seconds": [round(pcm.shape[-1] / float(audio["sample_rate"]), 3)],
            }
        }


NODE_CLASS_MAPPINGS = {
    "HivemindSplitSoundtrack": HivemindSplitSoundtrack,
    "HivemindSplitVoices": HivemindSplitVoices,
    "HivemindPreviewStemWav": HivemindPreviewStemWav,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "HivemindSplitSoundtrack": "Split Soundtrack: dialogue / effects / music (Hivemind)",
    "HivemindSplitVoices": "Split Voices (Hivemind)",
    "HivemindPreviewStemWav": "Preview Stem as WAV (Hivemind)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
