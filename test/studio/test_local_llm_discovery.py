"""What the prompt helper's model picker will and will not offer.

A model directory is mostly symlinks into build dirs that come and go. A dead
one first crashed the entire scan — the picker listed nothing at all, for every
workflow — and then, once that was caught, silently vanished from a list the
user reads as "the models I have". Both failures are covered here.
"""
from __future__ import annotations

import json
import os
import struct
import time
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


def _loaded_entry(model_id: str, *, vision: bool = True) -> local_llm.LoadedModel:
    return local_llm.LoadedModel(
        model_id=model_id, port=1, process=_LiveProcess(), api_key="k",
        started_at=0.0, estimated_bytes=0, context_tokens=8192, stderr=deque(), vision=vision,
    )


def test_loaded_model_ids_is_the_cheap_truth_about_what_is_up() -> None:
    """The describe-look route picks "whatever is loaded" from this, without
    the model-root scan and LM Studio probe that snapshot() pays for."""
    runtime = local_llm.LocalLlmRuntime(binary="/bin/true")
    assert runtime.loaded_model_ids() == []
    runtime._loaded["a/one.gguf"] = _loaded_entry("a/one.gguf")
    runtime._loaded["b/two.gguf"] = _loaded_entry("b/two.gguf")
    assert runtime.loaded_model_ids() == ["a/one.gguf", "b/two.gguf"]

    # A server that died on its own is reaped, not reported.
    class _Dead(_LiveProcess):
        def poll(self):
            return 1

    runtime._loaded["b/two.gguf"].process = _Dead()
    assert runtime.loaded_model_ids() == ["a/one.gguf"]
    runtime.unload_all()


def test_chat_carries_every_picture_on_the_last_user_turn(monkeypatch) -> None:
    """Several ``images`` land as ONE multi-part user message — text first,
    then the pictures in order — and a single ``image`` still works the way the
    start-frame caller expects. Exercised against a fake server, so this is the
    request body llama-server would receive, not a guess at it."""
    runtime = local_llm.LocalLlmRuntime(binary="/bin/true")
    runtime._loaded["m"] = _loaded_entry("m")
    sent: list[dict] = []

    class _Response:
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    def fake_urlopen(request, timeout=None):
        sent.append(json.loads(request.data))
        return _Response()

    monkeypatch.setattr(local_llm.urllib.request, "urlopen", fake_urlopen)
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    jpeg, png = "data:image/jpeg;base64,/9j/AAAA", "data:image/png;base64,iVBORw0KGgo="

    assert runtime.chat(model_id="m", messages=messages, images=[jpeg, png]) == "ok"
    content = sent[-1]["messages"][-1]["content"]
    assert content[0] == {"type": "text", "text": "u"}
    assert [part["image_url"]["url"] for part in content[1:]] == [jpeg, png]
    assert all(part["type"] == "image_url" for part in content[1:])
    assert sent[-1]["messages"][0] == {"role": "system", "content": "s"}

    assert runtime.chat(model_id="m", messages=messages, image=png) == "ok"
    content = sent[-1]["messages"][-1]["content"]
    assert [part["image_url"]["url"] for part in content[1:]] == [png]

    assert runtime.chat(model_id="m", messages=messages) == "ok"
    assert sent[-1]["messages"][-1] == {"role": "user", "content": "u"}
    # The caller's list was never mutated by the attach.
    assert messages[-1] == {"role": "user", "content": "u"}
    runtime.unload_all()


def test_an_empty_completion_is_its_own_error_type(monkeypatch) -> None:
    runtime = local_llm.LocalLlmRuntime(binary="/bin/true")
    runtime._loaded["m"] = _loaded_entry("m")

    class _Response:
        def read(self):
            return json.dumps({"choices": [{"message": {"content": "  "}, "finish_reason": "stop"}]}).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    monkeypatch.setattr(local_llm.urllib.request, "urlopen", lambda request, timeout=None: _Response())
    try:
        runtime.chat(model_id="m", messages=[{"role": "user", "content": "u"}])
    except local_llm.LocalLlmEmptyAnswer as exc:
        assert isinstance(exc, local_llm.LocalLlmError), "still caught by every existing handler"
    else:
        raise AssertionError("an empty answer must raise")
    runtime.unload_all()


# ── loading is not loaded ───────────────────────────────────────────────────

def test_a_model_still_coming_up_is_loading_not_loaded(tmp_path: Path, monkeypatch) -> None:
    """load() registers the entry BEFORE /health answers (up to 240 s), and
    during that window the picker said "loaded" and a Write got urlopen's
    "Connection refused". The entry is now marked loading until health passes:
    fit reads "loading", the cheap loaded list leaves it out, chat refuses with
    a sentence, and a second load answers {status: "loading"} without spawning."""
    root = tmp_path / "models"
    _write_gguf(root / "chat.gguf", "qwen3", "Chat Model")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])
    runtime = local_llm.LocalLlmRuntime(binary="/bin/true")
    runtime._loaded["chat.gguf"] = local_llm.LoadedModel(
        model_id="chat.gguf", port=1, process=_LiveProcess(), api_key="k", started_at=0.0,
        estimated_bytes=0, context_tokens=8192, stderr=deque(), vision=False, loading=True,
    )

    snapshot = runtime.snapshot()
    assert [m["fit"] for m in snapshot["models"]] == ["loading"]
    assert snapshot["loaded"][0]["loading"] is True
    assert runtime.loaded_model_ids() == []
    try:
        runtime.chat(model_id="chat.gguf", messages=[{"role": "user", "content": "u"}])
    except local_llm.LocalLlmError as exc:
        assert str(exc) == "chat.gguf is still loading — try again in a moment."
    else:
        raise AssertionError("a loading model must refuse to chat")

    spawned = {"n": 0}
    monkeypatch.setattr(runtime, "_spawn_locked", lambda *a, **k: spawned.__setitem__("n", spawned["n"] + 1))
    answer = runtime.load("chat.gguf")
    assert answer["status"] == "loading" and spawned["n"] == 0
    assert [m["fit"] for m in answer["models"]] == ["loading"]

    # Once health passes the same entry reads loaded everywhere.
    runtime._loaded["chat.gguf"].loading = False
    assert runtime.load("chat.gguf")["status"] == "loaded"
    assert [m["fit"] for m in runtime.snapshot()["models"]] == ["loaded"]
    assert runtime.loaded_model_ids() == ["chat.gguf"]
    runtime.unload_all()


def test_a_dead_llama_server_is_summarised_without_the_model_path() -> None:
    """llama-server is launched with --model <absolute path> and its loader
    echoes it; the last lines of a failed load named the GGUF under the
    owner's home. The summary prefers the line that says error and keeps
    basenames only."""
    lines = [
        "llama_model_loader: loaded meta data from /Users/liam/.lmstudio/models/q/m.gguf",
        "print_info: arch = qwen3",
        "error loading model: vocab size mismatch (/Users/liam/.lmstudio/models/q/m.gguf)",
        "llama_load_model_from_file: failed to load model",
    ]
    summary = local_llm._llama_stderr_summary(lines)
    assert summary == "error loading model: vocab size mismatch (m.gguf)"
    assert "/Users" not in summary
    assert local_llm._llama_stderr_summary(["", "   "]) == ""
    assert local_llm._llama_stderr_summary(["x" * 500]).endswith("…")


def test_the_model_scan_is_remembered_between_polls(tmp_path: Path, monkeypatch) -> None:
    """Every runtime poll re-walked the model roots and read each GGUF header.
    The scan is now cached for a few seconds, keyed on the roots' mtimes —
    while the loaded set and fit stay live."""
    root = tmp_path / "models"
    _write_gguf(root / "chat.gguf", "qwen3", "Chat Model")
    monkeypatch.setattr(local_llm, "_model_roots", lambda: [root])
    calls = {"n": 0}
    real_scan = local_llm.scan_models

    def counted(measurements=None):
        calls["n"] += 1
        return real_scan(measurements)

    monkeypatch.setattr(local_llm, "scan_models", counted)
    runtime = local_llm.LocalLlmRuntime(binary="/bin/true")
    assert [m["fit"] for m in runtime.snapshot()["models"]] != ["loaded"]
    runtime._loaded["chat.gguf"] = _loaded_entry("chat.gguf")
    # Same scan, fresh fit.
    assert [m["fit"] for m in runtime.snapshot()["models"]] == ["loaded"]
    assert calls["n"] == 1
    # A new top-level entry in a root changes its mtime and invalidates the scan.
    time.sleep(0.02)
    _write_gguf(root / "second.gguf", "qwen3", "Second")
    os.utime(root, None)
    assert sorted(m["name"] for m in runtime.snapshot()["models"]) == ["Chat Model", "Second"]
    assert calls["n"] == 2
    runtime.unload_all()
