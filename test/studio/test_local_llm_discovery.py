"""What the prompt helper's model picker will and will not offer.

A model directory is mostly symlinks into build dirs that come and go. A dead
one first crashed the entire scan — the picker listed nothing at all, for every
workflow — and then, once that was caught, silently vanished from a list the
user reads as "the models I have". Both failures are covered here.
"""
from __future__ import annotations

import json
import struct
from collections import deque
from pathlib import Path

from hivemind_content_studio import local_llm


class _LiveProcess:
    """Stands in for a running llama-server child in state-only assertions.

    poll() must return None: the runtime reaps entries whose process has
    exited, so a "dead" stand-in silently removes the very entry under test.
    """

    pid = 0

    def poll(self):
        return None

    def terminate(self):  # the atexit sweep kills whatever is still registered
        return None

    def wait(self, timeout=None):
        return 0


def _write_gguf(path: Path, architecture: str | None, name: str = "test-model") -> None:
    """A GGUF header just real enough for the metadata reader.

    Diffusion GGUFs in the same directory carry no architecture at all, which
    is exactly the case that must not reach llama-server.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    entries: list[tuple[str, str]] = []
    if architecture:
        entries = [("general.architecture", architecture), ("general.name", name)]
    blob = b"GGUF" + struct.pack("<IQQ", 3, 0, len(entries))
    for key, value in entries:
        blob += struct.pack("<Q", len(key)) + key.encode()
        blob += struct.pack("<I", 8)  # string
        blob += struct.pack("<Q", len(value)) + value.encode()
    path.write_bytes(blob + b"\0" * 256)


def test_a_dead_symlink_is_reported_not_silently_dropped(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "models"
    _write_gguf(root / "real" / "good.gguf", "qwen3", "Good Model")
    (root / "hive").mkdir(parents=True)
    (root / "hive" / "vanished.gguf").symlink_to(tmp_path / "deleted-build-dir" / "model.gguf")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])

    runnable, unavailable = local_llm.scan_models()

    assert [m.name for m in runnable] == ["Good Model"], "one dead link must not blank the picker"
    assert len(unavailable) == 1
    assert unavailable[0].id == "hive/vanished.gguf"
    assert "target is gone" in unavailable[0].reason


def test_a_gguf_that_is_not_a_language_model_is_refused_with_a_reason(tmp_path: Path, monkeypatch) -> None:
    """The local-AI runtime keeps a quantized DIFFUSION model beside the chat
    models. Offering it would produce a load that fails a minute later."""
    root = tmp_path / "models"
    _write_gguf(root / "chat.gguf", "qwen3", "Chat Model")
    _write_gguf(root / "z_image_turbo-Q4_K.gguf", None)
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])

    runnable, unavailable = local_llm.scan_models()

    assert [m.name for m in runnable] == ["Chat Model"]
    assert [u.id for u in unavailable] == ["z_image_turbo-Q4_K.gguf"]
    assert "not a text model" in unavailable[0].reason


def test_projectors_and_later_shards_stay_silent(tmp_path: Path, monkeypatch) -> None:
    """These are not models the user thinks they have, so listing them as
    'unavailable' would be noise rather than an answer."""
    root = tmp_path / "models"
    _write_gguf(root / "chat.gguf", "qwen3", "Chat Model")
    _write_gguf(root / "mmproj-F32.gguf", "clip")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])

    runnable, unavailable = local_llm.scan_models()

    assert [m.name for m in runnable] == ["Chat Model"]
    assert unavailable == []


def test_the_projector_beside_a_model_is_found(tmp_path: Path, monkeypatch) -> None:
    """Discovery skips mmproj files because they are not loadable alone, which
    is exactly what makes them invisible when vision needs one."""
    home = tmp_path / "models" / "scout"
    _write_gguf(home / "scout-Q4.gguf", "gemma4", "Scout")
    _write_gguf(home / "mmproj-scout-bf16.gguf", "clip")
    assert local_llm._projector_for(home / "scout-Q4.gguf") == home / "mmproj-scout-bf16.gguf"
    # A model with no sibling projector reports none rather than guessing.
    solo = tmp_path / "models" / "solo"
    _write_gguf(solo / "solo-Q4.gguf", "qwen3", "Solo")
    assert local_llm._projector_for(solo / "solo-Q4.gguf") is None


def test_vision_is_reported_from_the_running_server_not_the_directory(tmp_path: Path, monkeypatch) -> None:
    """A projector file is a promise; it is broken whenever the running
    llama-server cannot parse that projector type (Homebrew's b9430 rejects
    Scout's "gemma4uv"). Once loaded, the server's answer is the truth."""
    root = tmp_path / "models"
    _write_gguf(root / "scout" / "scout-Q4.gguf", "gemma4", "Scout")
    _write_gguf(root / "scout" / "mmproj-scout-bf16.gguf", "clip")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])
    runtime = local_llm.LocalLlmRuntime()

    # Not loaded: the projector on disk is the best available guess.
    assert runtime.model_sees_images("scout/scout-Q4.gguf") is True

    # Loaded WITHOUT the projector, because the binary refused it.
    runtime._loaded["scout/scout-Q4.gguf"] = local_llm.LoadedModel(
        model_id="scout/scout-Q4.gguf", port=1, process=_LiveProcess(), api_key="k",
        started_at=0.0, estimated_bytes=0, context_tokens=8192, stderr=deque(), vision=False,
    )
    assert runtime.model_sees_images("scout/scout-Q4.gguf") is False
    assert [m["vision"] for m in runtime.snapshot()["models"]] == [False]


def test_a_llama_server_override_wins(monkeypatch, tmp_path: Path) -> None:
    binary = tmp_path / "llama-server"
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    monkeypatch.setenv("HIVEMIND_LLAMA_SERVER", str(binary))
    assert local_llm._llama_binaries()[0] == str(binary)
    monkeypatch.setenv("HIVEMIND_LLAMA_SERVER", str(tmp_path / "absent"))
    assert str(tmp_path / "absent") not in local_llm._llama_binaries()


def test_the_studios_own_bundled_model_is_in_scope() -> None:
    """The app ships a small instruct model with its local-AI runtime; without
    this root the helper's only offers were 18-36GB loads."""
    roots = [str(root) for root in local_llm.DEFAULT_MODEL_ROOTS]
    assert any(root.endswith("open-generative-ai/local-ai/models") for root in roots)
    assert any(root.endswith(".lmstudio/models") for root in roots)


def test_snapshot_carries_the_unavailable_list(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "models"
    _write_gguf(root / "chat.gguf", "qwen3", "Chat Model")
    (root / "vanished.gguf").symlink_to(tmp_path / "gone.gguf")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])

    snapshot = local_llm.LocalLlmRuntime().snapshot()

    assert [m["name"] for m in snapshot["models"]] == ["Chat Model"]
    assert [u["id"] for u in snapshot["unavailable"]] == ["vanished.gguf"]


def test_freeing_comfy_memory_asks_comfy_and_reports_the_gain(monkeypatch) -> None:
    """ComfyUI is the helper's real competitor for unified memory. Without this
    the picker could only report that a model did not fit."""
    sent = {}

    class _Response:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def fake_urlopen(request, timeout=None):
        sent["url"] = request.full_url
        sent["body"] = json.loads(request.data)
        return _Response()

    monkeypatch.setenv("COMFY_HTTP_DEFAULT", "http://127.0.0.1:8188")
    monkeypatch.setattr(local_llm.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(local_llm.time, "sleep", lambda _s: None)
    sizes = iter([10 * 1024**3, 26 * 1024**3])
    monkeypatch.setattr(local_llm, "_available_memory_bytes", lambda: next(sizes))

    result = local_llm.free_comfy_memory()

    assert sent["url"] == "http://127.0.0.1:8188/free"
    # Both flags: unload_models drops the weights, free_memory releases the cache.
    assert sent["body"] == {"unload_models": True, "free_memory": True}
    assert result["freedBytes"] == 16 * 1024**3


def test_a_missing_comfy_is_a_message_not_a_crash(monkeypatch) -> None:
    def refuse(request, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(local_llm.urllib.request, "urlopen", refuse)
    try:
        local_llm.free_comfy_memory()
    except local_llm.LocalLlmError as exc:
        assert "Could not reach ComfyUI" in str(exc)
    else:
        raise AssertionError("a refused connection must surface as a helper error")
