"""Prompt text must never reach disk or the network inside a workflow graph.

The gateway redacts the top-level prompt field, but job records also carry the
full workflow graph, which embeds the same prompt in text widgets and runtime
defaults. These tests pin the scrubbing so that regression cannot return.
"""

import importlib.util
import json
from pathlib import Path


def _load_gateway():
    spec = importlib.util.spec_from_file_location("gwapp", str(Path(__file__).with_name("app.py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SECRET = "a very private scene description that must never touch disk"
NEGATIVE = "blurry, low quality, watermark artifacts everywhere"


def _workflow():
    return {
        "extra": {
            "name": "LTX 2.3 Eros",
            "nativeMlxLtx": {
                "variant": "eros-q8",
                "defaults": {"prompt": SECRET, "negative_prompt": NEGATIVE, "seed": 1234},
            },
        },
        "nodes": [
            {
                "id": 7,
                "type": "CLIPTextEncode",
                "widgets_values": [SECRET],
                "inputs": {"text": SECRET},
            },
            {
                "id": 4,
                "type": "CheckpointLoaderSimple",
                "widgets_values": ["wai-anima/couple-turbo.safetensors", "euler_ancestral", 25, 3.5],
            },
        ],
        "links": [[1, 4, 0, 7, 0, "CLIP"]],
    }


def test_scrubber_removes_prompt_text_but_keeps_graph_structure():
    gw = _load_gateway()
    scrubbed = gw.scrub_workflow_prompt_text(_workflow())
    blob = json.dumps(scrubbed)

    assert SECRET not in blob, "positive prompt survived scrubbing"
    assert NEGATIVE not in blob, "negative prompt survived scrubbing"

    # Structure the clients rely on must remain intact.
    assert scrubbed["extra"]["nativeMlxLtx"]["variant"] == "eros-q8"
    assert scrubbed["extra"]["nativeMlxLtx"]["defaults"]["seed"] == 1234
    assert scrubbed["nodes"][0]["type"] == "CLIPTextEncode"
    assert scrubbed["nodes"][1]["widgets_values"][0] == "wai-anima/couple-turbo.safetensors"
    assert scrubbed["nodes"][1]["widgets_values"][1] == "euler_ancestral"
    assert scrubbed["nodes"][1]["widgets_values"][2] == 25
    assert scrubbed["links"] == [[1, 4, 0, 7, 0, "CLIP"]]


def test_persisted_and_served_records_carry_no_prompt_text():
    gw = _load_gateway()
    record = {
        "id": "job-1",
        "prompt": SECRET,
        "comfy_prompt": [0, "job-1", {}, {"extra_pnginfo": {"workflow": _workflow()}}, []],
        "workflow": _workflow(),
        "outputs": [],
    }

    at_rest = json.dumps(gw.private_rec(record))
    assert SECRET not in at_rest and NEGATIVE not in at_rest
    assert gw.PRIVATE_PROMPT_LABEL in at_rest

    # /api/history serves live in-memory jobs that never pass through private_rec.
    served = json.dumps(gw.public_record(record))
    assert SECRET not in served and NEGATIVE not in served


def test_tuple_builders_scrub_at_the_source():
    gw = _load_gateway()
    for build in (
        lambda: gw._comfy_history_prompt_tuple("job-1", _workflow()),
        lambda: gw._comfy_history_prompt_tuple_for_native_ltx("job-1", _workflow(), "mlx-ltx-eros-video"),
    ):
        blob = json.dumps(build())
        assert SECRET not in blob and NEGATIVE not in blob
        assert "CLIPTextEncode" in blob, "graph structure should survive"
