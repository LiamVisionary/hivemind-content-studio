"""The MTPLX slot in the prompt helper, and the Refine mode.

MTPLX behaviour is a port of HivemindOS's runtime adapter; these tests pin the
contract points that were measured there so a drift here is a failure:
quickstart gets --tool-prompt-mode native and NEVER a thinking-budget flag,
the state file is the shared ~/.hivemindos/mtplx-server.json schema, and a
chat against the server sends no sampling fields (the launch defaults mirror
the model's generation_config, which is the vendor's setting for exactly this
kind of writing turn).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hivemind_content_studio import control_api, local_llm, mtplx_server, prompt_profiles
from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    # Undo the suite-wide MTPLX neutralization (conftest._isolate_mtplx): these
    # tests exercise the real functions against the fake home.
    monkeypatch.setattr(mtplx_server, "read_mtplx_state", _REAL_READ_STATE)
    monkeypatch.setattr(mtplx_server, "mtplx_available", _REAL_AVAILABLE)
    monkeypatch.setattr(mtplx_server, "probe_served_model", _REAL_PROBE)
    monkeypatch.setattr(mtplx_server, "list_mtplx_candidates", _REAL_CANDIDATES)
    monkeypatch.setattr(mtplx_server, "mtplx_owns_model", _REAL_OWNS)
    return tmp_path


_REAL_READ_STATE = mtplx_server.read_mtplx_state
_REAL_AVAILABLE = mtplx_server.mtplx_available
_REAL_PROBE = mtplx_server.probe_served_model
_REAL_CANDIDATES = mtplx_server.list_mtplx_candidates
_REAL_OWNS = mtplx_server.mtplx_owns_model


def _write_state(home: Path, **extra) -> None:
    state = {"port": 8001, "host": "127.0.0.1", "modelRef": "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed",
             "modelId": "qwen38-speed", "profile": "turbo", **extra}
    path = home / ".hivemindos" / "mtplx-server.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state))


# ---------------------------------------------------------------------------
# mtplx_server (the port itself)
# ---------------------------------------------------------------------------


def test_cache_paths_and_refs_compare_equal() -> None:
    assert mtplx_server.normalize_mtplx_ref(
        "/x/hub/models--Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed/snapshots/abc"
    ) == "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed"
    assert mtplx_server.normalize_mtplx_ref("org/name") == "org/name"


def test_the_state_file_is_the_shared_hivemindos_schema(home: Path) -> None:
    _write_state(home)
    state = mtplx_server.read_mtplx_state()
    assert state is not None and state["modelId"] == "qwen38-speed"
    written = mtplx_server.write_mtplx_state(modelId="other")
    assert written["modelRef"] == "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed"
    assert written["profile"] == "turbo"  # patch keeps what it does not name
    assert (home / ".hivemindos" / "mtplx-server.json").exists()


def test_the_model_arg_prefers_the_snapshot_that_carries_weights(home: Path, monkeypatch) -> None:
    hub = home / "hub"
    snaps = hub / "models--org--model" / "snapshots"
    (snaps / "meta-only").mkdir(parents=True)
    (snaps / "meta-only" / "config.json").write_text("{}")
    (snaps / "weighted").mkdir()
    (snaps / "weighted" / "model.safetensors").write_text("w")
    monkeypatch.setenv("HUGGINGFACE_HUB_CACHE", str(hub))
    assert mtplx_server.mtplx_model_arg_for_ref("org/model").endswith("weighted")
    # Not cached at all: the bare ref goes through for mtplx to resolve.
    assert mtplx_server.mtplx_model_arg_for_ref("org/absent") == "org/absent"


def test_quickstart_flags_pin_the_measured_contract(home: Path, monkeypatch) -> None:
    """--tool-prompt-mode native, --yes, the tuned profile for the remembered
    checkpoint — and NEVER any thinking-budget flag (vLLM #44676: on Qwen3.5+
    it corrupts tool-argument JSON; measured no-effect besides)."""
    _write_state(home)
    spawned: list[list[str]] = []
    monkeypatch.setattr(mtplx_server, "mtplx_available", lambda: True)
    monkeypatch.setattr(mtplx_server, "mtplx_cli_path", lambda: "mtplx")
    probes = iter([None])  # nothing serving; after spawn, the served model appears

    def probe(port, timeout=1.5):
        try:
            return next(probes)
        except StopIteration:
            return {"id": "qwen38-speed", "contextLength": 262144}

    monkeypatch.setattr(mtplx_server, "probe_served_model", probe)
    monkeypatch.setattr(mtplx_server, "_spawn_detached", lambda cmd, args, log: spawned.append(args))
    monkeypatch.setattr(mtplx_server.time, "sleep", lambda *_: None)

    result = mtplx_server.mtplx_load_model("Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed")

    assert result["ok"] is True
    args = spawned[0]
    assert args[0] == "quickstart"
    assert "--tool-prompt-mode" in args and args[args.index("--tool-prompt-mode") + 1] == "native"
    assert "--yes" in args
    assert "--profile" in args and args[args.index("--profile") + 1] == "turbo"
    assert not any("thinking-budget" in arg for arg in args)
    # The state remembers what is now serving.
    assert mtplx_server.read_mtplx_state()["modelId"] == "qwen38-speed"


# ---------------------------------------------------------------------------
# The runtime offers, chats with, and unloads the MTPLX slot
# ---------------------------------------------------------------------------


@pytest.fixture
def runtime(home: Path, tmp_path: Path, monkeypatch) -> local_llm.LocalLlmRuntime:
    _write_state(home)
    monkeypatch.setattr(mtplx_server, "mtplx_available", lambda: True)
    monkeypatch.setattr(
        mtplx_server, "probe_served_model",
        lambda port, timeout=1.5: {"id": "qwen38-speed", "contextLength": 262144},
    )
    monkeypatch.setattr(mtplx_server, "list_mtplx_candidates", lambda: [])
    return local_llm.LocalLlmRuntime(state_path=tmp_path / "llm.json")


def test_the_serving_mtplx_model_appears_loaded_in_the_picker(runtime) -> None:
    rows = [m for m in runtime.snapshot()["models"] if m.get("provider") == "mtplx"]
    assert [(m["id"], m["fit"]) for m in rows] == [("qwen38-speed", "loaded")]
    assert rows[0]["maxContext"] == 262144
    assert rows[0]["vision"] is False
    assert "qwen38-speed" in runtime.loaded_model_ids()


def test_chat_reaches_mtplx_with_no_sampling_fields(runtime, monkeypatch) -> None:
    sent: list[dict] = []

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({"choices": [{"message": {
                "content": "<think>plan</think>[Shot 1] A courier waits."}}]}).encode()

    def fake_urlopen(request, timeout=0):
        sent.append(json.loads(request.data.decode()))
        assert "8001" in request.full_url
        return _Response()

    monkeypatch.setattr(local_llm.urllib.request, "urlopen", fake_urlopen)
    out = runtime.chat(model_id="qwen38-speed", messages=[{"role": "user", "content": "x"}])
    assert out == "[Shot 1] A courier waits."  # reasoning stripped
    assert "temperature" not in sent[0] and "top_p" not in sent[0]
    assert sent[0]["model"] == "qwen38-speed"


def test_unload_others_never_stops_the_mtplx_server(runtime, monkeypatch) -> None:
    """MTPLX may be serving another app's chat; only the row's own Unload
    stops it. The llama 'unload others first' sweep must not reach it."""
    stopped = []
    monkeypatch.setattr(mtplx_server, "mtplx_unload_model", lambda: stopped.append(True) or {"ok": True})
    runtime.unload_all()
    assert stopped == []
    runtime.unload("qwen38-speed")
    assert stopped == [True]


# ---------------------------------------------------------------------------
# Refine
# ---------------------------------------------------------------------------


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(tmp_path / "a.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="pw", cipher=cipher),
        private_cipher=cipher,
    )
    client = TestClient(app)
    assert client.post("/api/owner/unlock", json={"password": "pw"}).status_code == 200
    return client


def test_refine_controls_collapse_to_safe_defaults() -> None:
    assert prompt_profiles.normalize_refine({"detail": "MAXIMUM", "shots": 7, "guidance": None}) == {
        "detail": "keep", "shots": "keep", "guidance": "",
    }
    assert prompt_profiles.normalize_refine("nope") is None


def test_a_refine_turn_carries_the_draft_and_the_knobs(tmp_path: Path, monkeypatch) -> None:
    seen: list[list[dict]] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            seen.append(messages)
            return "[Shot 1] Refined."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)

    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier waits", "targetModel": "minimax-h3",
        "currentPrompt": "[Shot 1] A courier waits.",
        "refine": {"detail": "enrich", "shots": "single", "guidance": "focus on the rain"},
    }).json()

    assert body["prompt"].startswith("[Shot 1] Refined")
    turns = seen[0]
    assert turns[-2] == {"role": "assistant", "content": "[Shot 1] A courier waits."}
    ask = turns[-1]["content"]
    assert "Refine the prompt above" in ask
    assert "ONE continuous shot" in ask
    assert "sensory detail" in ask
    assert "focus on the rain" in ask


def test_refine_without_a_prompt_is_a_400(tmp_path: Path, monkeypatch) -> None:
    class FakeRuntime:
        def chat(self, **_kwargs):
            raise AssertionError("must not be called")

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)
    response = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "refine": {"detail": "keep", "shots": "keep", "guidance": ""},
    })
    assert response.status_code == 400
    assert "before refining" in response.json()["detail"]


def test_an_unchanged_plain_refine_is_already_in_shape_not_a_retry(tmp_path: Path, monkeypatch) -> None:
    calls: list[int] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            calls.append(1)
            return "[Shot 1] A courier waits."

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a courier", "targetModel": "minimax-h3",
        "currentPrompt": "[Shot 1] A courier waits.",
        "refine": {"detail": "keep", "shots": "keep", "guidance": ""},
    }).json()
    assert len(calls) == 1  # no push for a legitimate "already in shape"
    assert any("Already in shape" in warning for warning in body.get("warnings", []))


# ---------------------------------------------------------------------------
# Refine must never flatten the prompt's structure (seen live 2026-08-24:
# a six-section reference prompt came back as bare prose because the dialog's
# targetModel guess missed reference mode).
# ---------------------------------------------------------------------------


SIX_SECTION = """subject_definitions:
<Subject 1> is the man shown in <Picture 1>, <Picture 2>: short black hair.
<Subject 1> speaks as S1.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).

summary:
[audio reference] A medium shot of <Subject 1> speaking.

retention_analysis:
<Subject 1>: fully_preserved — the same face in every shot.
<Picture 1>: fully_preserved — the face carries.
<Picture 2>: fully_preserved — the face carries.
<Audio 1>: reference — only the timbre carries.

detailed_description:
[Shot 1] A man (S1) sits on a wall. (S1) <d>[English] All you need is peace.</d>

overall_soundscape:
Birdsong and wind.

non_diegetic_music:
N/A"""


def test_the_prompt_being_refined_decides_its_own_profile(tmp_path: Path, monkeypatch) -> None:
    """targetModel without the reference token must NOT flatten a six-section
    prompt: the system prompt has to teach the grammar the prompt is in."""
    seen: list[list[dict]] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            seen.append(messages)
            return SIX_SECTION.replace("sits on a wall", "sits on a low concrete wall")

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a man", "targetModel": "minimax-h3",  # no "reference"
        "currentPrompt": SIX_SECTION,
        "refine": {"detail": "keep", "shots": "keep", "guidance": ""},
    }).json()
    assert body["profile"] == "minimax-h3-reference"
    system = seen[0][0]["content"]
    assert "subject_definitions" in system
    ask = seen[0][-1]["content"]
    assert "skeleton is load-bearing" in ask
    assert "subject_definitions:" in ask


def test_a_flattened_refine_is_retried_then_refused(tmp_path: Path, monkeypatch) -> None:
    answers = iter([
        "A man sits on a wall and finds peace.",   # flattened
        "A man sits on a wall, calm and warm.",    # flattened again
    ])
    asks: list[str] = []

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            asks.append(messages[-1]["content"])
            return next(answers)

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a man", "targetModel": "minimax-h3-reference",
        "currentPrompt": SIX_SECTION,
        "refine": {"detail": "keep", "shots": "keep", "guidance": ""},
    }).json()
    # The retry names what went missing; the final answer keeps the original.
    assert any("dropped structure" in ask for ask in asks)
    assert body["prompt"] == SIX_SECTION
    assert any("nothing\nwas changed" in w or "nothing was changed" in w for w in body["warnings"])


def test_a_structure_keeping_refine_passes_the_guard(tmp_path: Path, monkeypatch) -> None:
    refined = SIX_SECTION.replace("Birdsong and wind.", "Birdsong, wind, and distant traffic.")

    class FakeRuntime:
        def chat(self, *, model_id, messages, **_kwargs):
            return refined

        def model_sees_images(self, model_id):
            return False

    monkeypatch.setattr(control_api.local_llm, "runtime", FakeRuntime)
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/prompt-helper/generate", json={
        "modelId": "gguf", "idea": "a man", "targetModel": "minimax-h3-reference",
        "currentPrompt": SIX_SECTION,
        "refine": {"detail": "keep", "shots": "keep", "guidance": ""},
    }).json()
    assert body["prompt"] == refined
    assert body["changedLines"] == 1
