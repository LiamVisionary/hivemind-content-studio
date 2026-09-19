"""Graphs that take a finished clip's sound apart.

A generated video arrives with one soundtrack. This builds the transient ComfyUI
graph that returns it as the pieces an editor actually asks for: the dialogue,
the effects, the music, and — when two people talk — a track for each of them,
even where they talk over each other.

The models are TIGER-DnR and TIGER-speech (Kai Li et al.; code MIT, weights
Apache-2.0), run by this repo's own node pack,
packages/comfyui-custom-nodes/hivemind-audio-split. The pack says why it is
ours rather than one of the community packs that wrap the same models.

Two things are deliberate, and both come from smart_mask.py:

  * The clip goes in as a HANDLE. `HivemindLoadPrivateAudio` fetches the bytes
    from the gateway's memory, and its decoder (PyAV) reads the audio stream of
    an .mp4 as readily as a .wav — so the decrypted video is never a file in
    ComfyUI's input directory, and there is no demux step to write one either.
  * The stems come out through the TEMP directory, not the output directory.
    They are being handed back to the person who asked, to save where they
    like; they are not new creations. An output would be sealed, listed in
    History and claimed for a workspace — five entries of somebody's dialogue,
    forever, for every clip they ever split.

Pure data and one function: no gateway imports, so the contract is testable
without a lane.
"""

from __future__ import annotations

LOADER_CLASS = "HivemindLoadPrivateAudio"
SOUNDTRACK_CLASS = "HivemindSplitSoundtrack"
VOICES_CLASS = "HivemindSplitVoices"
PREVIEW_CLASS = "HivemindPreviewStemWav"
# Every class the graph uses. The runner asks the lane for each before it
# queues, because "node type not found" is ComfyUI's answer to a missing pack
# and it is not a sentence anyone can act on.
REQUIRED_CLASSES = (LOADER_CLASS, SOUNDTRACK_CLASS, VOICES_CLASS, PREVIEW_CLASS)

# Stem keys, in the order the studio lists them. The output slot is the index
# into the splitter node's RETURN_TYPES.
SOUNDTRACK_STEMS = (("dialogue", 0), ("effects", 1), ("music", 2))
VOICE_STEMS = (("voice_1", 0), ("voice_2", 1))

# A track quieter than this holds nothing a person would call a voice. The
# speech separator always returns two tracks; with one speaker the second is
# the residue, and offering it as "Voice 2" would be offering a file of hiss.
# Measured 2026-09-18 on synthetic clips: with two speakers the quieter real
# voice sat at -28.0 dBFS; with one, the empty second track sat at -70.4 and the
# empty effects stem at -61.8. The line goes between, nearer the empty side, so
# a quiet real voice is never the thing that gets hidden.
SILENT_BELOW_DB = -50.0

# Where the pack looks, relative to ComfyUI's models directory.
MODELS_SUBDIR = "audio_separation"

# Pinned to a revision AND a hash. The revision makes the URL immutable; the
# hash is what is actually trusted, because a parallel download that lands the
# wrong bytes under the right name is a failure this repo has already had.
WEIGHTS = (
    {
        "folder": "TIGER-DnR",
        "filename": "model.safetensors",
        "url": "https://huggingface.co/JusperLee/TIGER-DnR/resolve/"
               "b7a59560bbca10febbcd46fb01600f868e587f57/model.safetensors",
        "bytes": 17130568,
        "sha256": "dd1c696e72f6adea0085ef1af640882a8260519ad666422835e387a5b4abdd2a",
    },
    {
        "folder": "TIGER-speech",
        "filename": "model.safetensors",
        "url": "https://huggingface.co/JusperLee/TIGER-speech/resolve/"
               "f0340340b2d9bbf72074edf8c076dcab59a10ba2/model.safetensors",
        "bytes": 3367352,
        "sha256": "7e5fac7a9083c94b3a00c524f323188d4dd19ef09a54c29d1fec12ac114922db",
    },
)


def build_audio_split_prompt(handle, *, voices=True):
    """The graph, and which output node is which stem.

    Returns `(graph, stems)` where `stems` maps an output node id to its stem
    key. The map is the contract the runner reads the history by: ComfyUI
    reports outputs per node id, and the temp filenames are random on purpose.

    Voices are separated from the DIALOGUE stem, not from the mix. The speech
    model was trained on people talking; hand it a soundtrack and it spends one
    of its two outputs on the score.
    """
    key = str(handle or "").strip()
    if not key:
        raise ValueError("an audio split needs a staged input handle")
    graph = {
        "1": {"class_type": LOADER_CLASS, "inputs": {"handle": key}},
        "2": {"class_type": SOUNDTRACK_CLASS, "inputs": {"audio": ["1", 0]}},
    }
    stems = {}
    next_id = 10
    for stem, slot in SOUNDTRACK_STEMS:
        graph[str(next_id)] = {"class_type": PREVIEW_CLASS, "inputs": {"audio": ["2", slot]}}
        stems[str(next_id)] = stem
        next_id += 1
    if voices:
        graph["3"] = {"class_type": VOICES_CLASS, "inputs": {"audio": ["2", 0]}}
        for stem, slot in VOICE_STEMS:
            graph[str(next_id)] = {"class_type": PREVIEW_CLASS, "inputs": {"audio": ["3", slot]}}
            stems[str(next_id)] = stem
            next_id += 1
    return graph, stems
