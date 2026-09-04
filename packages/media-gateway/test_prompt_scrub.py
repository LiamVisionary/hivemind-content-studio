"""Prompt text must never reach disk or the network inside a workflow graph.

The gateway redacts the top-level prompt field, but job records also carry the
full workflow graph, which embeds the same prompt in text widgets and runtime
defaults. These tests pin the scrubbing so that regression cannot return.
"""

import importlib.util
import sys
import json
from pathlib import Path


def _load_gateway():
    # A fresh world per load: the gateway's state lives in the modules under
    # gateway/, so a cached one would carry the previous test's caches and
    # threads into this one.
    for _cached in [n for n in sys.modules if n == 'gateway' or n.startswith('gateway.')]:
        del sys.modules[_cached]
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
    scrubbed = gw.history.scrub_workflow_prompt_text(_workflow())
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

    at_rest = json.dumps(gw.history.private_rec(record))
    assert SECRET not in at_rest and NEGATIVE not in at_rest
    assert gw.history.PRIVATE_PROMPT_LABEL in at_rest

    # /api/history serves live in-memory jobs that never pass through private_rec.
    served = json.dumps(gw.history.public_record(record))
    assert SECRET not in served and NEGATIVE not in served


def test_tuple_builders_scrub_at_the_source():
    gw = _load_gateway()
    for build in (
        lambda: gw.graphs._comfy_history_prompt_tuple("job-1", _workflow()),
        lambda: gw.native_mlx._comfy_history_prompt_tuple_for_native_ltx("job-1", _workflow(), "mlx-ltx-eros-video"),
    ):
        blob = json.dumps(build())
        assert SECRET not in blob and NEGATIVE not in blob
        assert "CLIPTextEncode" in blob, "graph structure should survive"


def test_runner_console_output_is_not_persisted_or_served():
    """Native runners take the prompt on argv, so a traceback or an argparse
    echo in their console can carry it — and the job record used to persist
    4 KB of stdout AND stderr into history.jsonl and serve both to any
    token-bearing caller. private_rec (the persistence AND serving chokepoint)
    drops stdout and keeps three path-scrubbed stderr lines."""
    gw = _load_gateway()
    record = {
        "id": "job-2",
        "status": "error",
        "prompt": SECRET,
        "outputs": [],
        "runner_stdout": "progress 1\nprogress 2\nusage: runner --prompt " + SECRET,
        "runner_stderr": (
            "Traceback (most recent call last):\n"
            '  File "/Users/liam/comfy/ltx-2-mlx/run.py", line 9, in <module>\n'
            "    main(" + SECRET + ")\n"
            "FileNotFoundError: /Users/liam/Library/Application Support/models/ltx.safetensors\n"
        ),
    }
    at_rest = gw.history.private_rec(record)
    assert "runner_stdout" not in at_rest
    stderr_lines = at_rest["runner_stderr"].splitlines()
    assert len(stderr_lines) == 3
    assert "/Users/liam" not in at_rest["runner_stderr"]
    assert "ltx.safetensors" in stderr_lines[-1]
    # The prompt rode on argv and the traceback echoed it: redacted too.
    assert SECRET not in json.dumps(at_rest)
    assert gw.history.PRIVATE_PROMPT_LABEL in at_rest["runner_stderr"]
    served = json.dumps(gw.history.public_record(record))
    assert "runner_stdout" not in served and "/Users/liam" not in served
    assert "progress 1" not in served and SECRET not in served
    # A record without console output is untouched.
    assert "runner_stderr" not in gw.history.private_rec({"id": "job-3", "outputs": []})
    assert gw.history.runner_output_tail("") == ""
