"""The hivemind_privacy node is the rented box's whole privacy surface.

It ships as a source file provisioning writes onto an unpatched ComfyUI, so
nothing else in this repo executes it — which is how it came to patch only one
of two queue accessors and serve the running prompt at /queue for a whole
generation (measured on pinned ComfyUI e377e263, 2026-08-07). These tests load
the real file against a stub ComfyUI and assert the redaction it promises.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
PRIVACY_NODE = ROOT / "packages/gpu-rentals/provisioning/hivemind_privacy.py"
PROVISIONING_SH = ROOT / "packages/gpu-rentals/provisioning/comfyui-hivemind.sh"

# One queued item, in ComfyUI's tuple shape: (number, prompt_id, graph, extra, outputs).
PROMPT_TEXT = "a private prompt the customer typed"
QUEUE_ITEM = (
    0,
    "prompt-1",
    {"104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"prompt": PROMPT_TEXT}}},
    {"client_id": "studio", "extra_pnginfo": {"workflow": {"nodes": [PROMPT_TEXT]}}},
    ["92"],
)


class _StubPromptQueue:
    """Stands in for ComfyUI's PromptQueue, with BOTH queue accessors the
    pinned server exposes: /queue reads the volatile one, the websocket status
    reads the other. A node that patches one and not the other still leaks."""

    def get_history(self, *args, **kwargs):
        return {"prompt-1": {"prompt": QUEUE_ITEM, "outputs": {}, "status": {"completed": True}}}

    def get_current_queue(self, *args, **kwargs):
        return ([QUEUE_ITEM], [])

    def get_current_queue_volatile(self, *args, **kwargs):
        return ([QUEUE_ITEM], [])


@pytest.fixture()
def privacy_node(monkeypatch):
    execution = ModuleType("execution")
    execution.PromptQueue = _StubPromptQueue
    monkeypatch.setitem(sys.modules, "execution", execution)
    # The route/middleware half needs a live PromptServer; absent one, the
    # module must still install its redaction and import cleanly.
    monkeypatch.setitem(sys.modules, "server", ModuleType("server"))
    sys.modules["server"].PromptServer = SimpleNamespace(instance=None)
    monkeypatch.setitem(sys.modules, "folder_paths", ModuleType("folder_paths"))
    monkeypatch.delenv("COMFY_PRIVATE_HISTORY_PROMPTS", raising=False)

    spec = importlib.util.spec_from_file_location("hivemind_privacy_under_test", PRIVACY_NODE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, execution.PromptQueue()


def test_every_queue_accessor_is_redacted(privacy_node):
    _, queue = privacy_node
    for accessor in ("get_current_queue", "get_current_queue_volatile"):
        running, _pending = getattr(queue, accessor)()
        assert PROMPT_TEXT not in repr(running), f"{accessor} served the prompt graph"
        assert running[0][2] == {}, f"{accessor} kept the graph"
        # Identity and timing stay: the gateway routes and bills on them.
        assert running[0][1] == "prompt-1"
        assert running[0][3]["client_id"] == "studio"


def test_history_is_redacted_too(privacy_node):
    _, queue = privacy_node
    entry = queue.get_history()["prompt-1"]
    assert PROMPT_TEXT not in repr(entry)
    assert entry["prompt"][2] == {}


def test_redaction_can_be_turned_off_for_a_debug_lane(privacy_node, monkeypatch):
    _, queue = privacy_node
    monkeypatch.setenv("COMFY_PRIVATE_HISTORY_PROMPTS", "0")
    running, _ = queue.get_current_queue_volatile()
    assert running[0][2] != {}


def test_encrypted_workflow_envelopes_survive_redaction(privacy_node):
    module, _ = privacy_node
    envelope = {
        "encrypted": True,
        "format": "comfyui-mobile-encrypted-workflow",
        "iterations": 310000,
        "salt": "s", "iv": "i", "data": "d",
    }
    kept = module._redact_extra_data({"extra_pnginfo": {"workflow": envelope}})
    # Client-sealed, so it is not ours to read and not a leak to keep: the
    # gateway's workflow index needs it to survive the history read.
    assert kept["extra_pnginfo"]["workflow"] == envelope


def test_provisioning_script_ships_the_same_node(privacy_node):
    # comfyui-hivemind.sh embeds this module for template boots while
    # gpu_rentals embeds it for Machines-UI boots. Two copies, one behaviour.
    lines = PROVISIONING_SH.read_text(encoding="utf-8").splitlines(keepends=True)
    start = next(i for i, line in enumerate(lines) if "<<'HIVEMIND_PRIVACY_EOF'" in line)
    end = next(i for i, line in enumerate(lines) if line.rstrip("\n") == "HIVEMIND_PRIVACY_EOF" and i > start)
    assert "".join(lines[start + 1:end]) == PRIVACY_NODE.read_text(encoding="utf-8")
