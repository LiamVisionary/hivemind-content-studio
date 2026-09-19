"""The music lane: registry slots, and the mastering that stops a song clipping."""

import importlib.util
import json
import subprocess
import shutil
import sys
from pathlib import Path

import pytest


def _load_gateway():
    for _cached in [n for n in sys.modules if n == 'gateway' or n.startswith('gateway.')]:
        del sys.modules[_cached]
    spec = importlib.util.spec_from_file_location("gwapp", str(Path(__file__).with_name("app.py")))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REGISTRY = Path(__file__).with_name("workflow-registry.json")
WORKFLOWS = Path(__file__).with_name("workflows")
GRAPH = WORKFLOWS / "ace-step-1.5-turbo.api.json"


_RESOLVED = []


def _rows():
    """The registry as the gateway reads it: `inherits` folded in.

    The raw JSON stopped being enough when the instrumental YuE2 lane arrived as
    a child of yue2-3b - its slots, limits and licence live on the parent, and a
    test reading the raw row would be checking a lane nobody ever runs.
    """
    if not _RESOLVED:
        _RESOLVED.extend(_load_gateway().dependencies.load_registry(REGISTRY).values())
    return _RESOLVED


def _entry(workflow_id="ace-step-1.5-turbo"):
    return next(row for row in _rows() if row["id"] == workflow_id)


def _audio_entries():
    """Every music lane. Parametrising on this means a lane added later is
    checked by these tests without anyone remembering to add it."""
    return [row for row in _rows() if row.get("media_type") == "audio"]


AUDIO_IDS = [row["id"] for row in _audio_entries()]


@pytest.mark.parametrize("workflow_id", AUDIO_IDS)
def test_the_registry_entry_and_its_graph_agree(workflow_id):
    """Every slot must address a node and a widget that really exist.

    A slot pointed at a node id the graph does not have fails silently — the
    option is simply never applied and the render quietly ignores what the user
    asked for. This is the check that turns that into a test failure.
    """
    entry = _entry(workflow_id)
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    for name, target in entry["slots"].items():
        for item in (target if isinstance(target, list) else [target]):
            node = graph.get(item["node"])
            assert node, f"slot {name} points at missing node {item['node']}"
            assert item["input"] in node["inputs"], (
                f"slot {name} points at {item['node']}.{item['input']}, which that "
                f"{node['class_type']} does not have"
            )
            assert not isinstance(node["inputs"][item["input"]], list), (
                f"slot {name} points at a LINK ({item['node']}.{item['input']}), not a widget"
            )


@pytest.mark.parametrize("workflow_id", AUDIO_IDS)
def test_every_accepted_option_can_actually_reach_the_graph(workflow_id):
    """`accepts` is the promise the UI reads; `slots` is what delivers it."""
    entry = _entry(workflow_id)
    for option in entry["accepts"]:
        assert option in entry["slots"], f"'{option}' is advertised in accepts but has no slot"


@pytest.mark.parametrize("workflow_id", AUDIO_IDS)
def test_the_declared_checkpoint_is_a_bare_basename(workflow_id):
    """A folder-relative path installs flat and then reports itself satisfied
    under a name the graph cannot resolve — the false-satisfied installer trap."""
    for dep in _entry(workflow_id)["model_dependencies"]:
        assert "/" not in dep["relativePath"], dep["relativePath"]
        assert dep["bytes"] > 0 and len(dep["sha256"]) == 64


@pytest.mark.parametrize("workflow_id", AUDIO_IDS)
def test_the_graph_loads_the_checkpoint_the_registry_installs(workflow_id):
    entry = _entry(workflow_id)
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    loader = next(n for n in graph.values() if n["class_type"] == "CheckpointLoaderSimple")
    assert loader["inputs"]["ckpt_name"] == entry["model_dependencies"][0]["relativePath"]


def test_slots_drive_both_duration_inputs_together():
    """ACE-Step carries the length twice: the text encoder plans an arrangement
    for it and the latent reserves it. If they disagree the song stops mid-bar."""
    gw = _load_gateway()
    graph = json.loads(GRAPH.read_text())
    applied = gw.graphs.apply_registry_slots(graph, _entry(), {"seconds": 45.0})
    assert "seconds" in applied
    assert graph["2"]["inputs"]["duration"] == 45.0
    assert graph["5"]["inputs"]["seconds"] == 45.0


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")
def test_mastering_removes_the_clipping_ace_step_produces(tmp_path):
    """The real failure this guards.

    ACE-Step decodes to float and ComfyUI's save_audio does not clamp, so a
    render can sit above full scale — measured at peak 1.3389 on the first real
    render here. Encoded to any integer format that is audible hard clipping.
    """
    gw = _load_gateway()
    source = tmp_path / "loud.wav"
    # A 2 s tone pushed past full scale to ~1.35, the same overshoot measured on
    # the first real render. lavfi's sine emits 0.125 amplitude, so the gain is
    # 10.8x rather than the 1.35x the peak suggests.
    subprocess.run([
        shutil.which("ffmpeg"), "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=220:duration=2:sample_rate=48000",
        "-af", "volume=10.8", "-c:a", "pcm_f32le", str(source),
    ], check=True)

    peak_before = _peak(source)
    assert peak_before > 1.0, f"fixture is not clipping ({peak_before})"

    mastered, info = gw.runners.master_audio_output(source)
    assert info["mastered"] is True, info
    assert mastered.suffix == ".mp3" and mastered.is_file()
    peak_after = _peak(mastered)
    assert peak_after <= 1.0, f"still clipping after mastering: {peak_after}"


def _peak(path):
    raw = subprocess.run(
        [shutil.which("ffmpeg"), "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-"],
        capture_output=True, check=True,
    ).stdout
    import array
    samples = array.array("f")
    samples.frombytes(raw[: len(raw) // 4 * 4])
    return max(abs(s) for s in samples) if samples else 0.0


def test_mastering_returns_the_raw_render_when_ffmpeg_is_missing(tmp_path, monkeypatch):
    """A missing ffmpeg must cost loudness, never the song."""
    gw = _load_gateway()
    source = tmp_path / "song.flac"
    source.write_bytes(b"not really a flac, never opened on this path")
    monkeypatch.setattr(gw.runners.shutil, "which", lambda _name: None)
    out, info = gw.runners.master_audio_output(source)
    assert out == source and info["mastered"] is False and "ffmpeg" in info["reason"]


def test_progress_phases_name_real_counting_nodes_and_leave_room_at_the_end():
    """The bar's shares are measured, and they must not claim the whole job.

    Decode, save and mastering happen after the last counter stops, so phases
    summing to 1.0 would park the bar at 100% while the user still waits.
    """
    entry = _entry()
    graph = json.loads(GRAPH.read_text())
    phases = entry["progress_phases"]
    assert phases, "the music lane needs measured phases or its bar resets mid-render"
    for phase in phases:
        assert phase["node"] in graph, f"phase points at missing node {phase['node']}"
        assert 0 < phase["share"] < 1
    total = sum(p["share"] for p in phases)
    assert total < 1.0, f"phases claim {total} of the job, leaving nothing for decode/save"


def test_the_expensive_phase_is_the_one_that_writes_the_music():
    """Measured on an M5 Max: the LM is 81% of the wall time and the 8-step
    sampler only 15%. Anyone re-weighting these should have to re-measure, and
    a reversed pair would put the bar's slowest stretch in the wrong place."""
    phases = {p["node"]: p["share"] for p in _entry()["progress_phases"]}
    assert phases["2"] > phases["6"] * 3


@pytest.mark.parametrize("workflow_id", AUDIO_IDS)
def test_every_music_lane_states_its_commercial_terms(workflow_id):
    """Whether a track may be sold is a fact about the MODEL, and the only
    place the app can learn it is here. ACE-Step is MIT/MIT; YuE2's weights are
    CC BY-NC 4.0 even though its code is Apache-2.0 — a difference that is
    invisible from the repo licence alone and expensive to discover late.
    """
    licence = _entry(workflow_id).get("license")
    assert licence, f"{workflow_id} does not say whether its output can be sold"
    assert isinstance(licence.get("commercial"), bool)
    assert licence.get("weights"), "the WEIGHTS licence is the one that governs the output"


def test_a_slot_aimed_at_a_linked_input_is_refused_not_silently_dropped():
    """YuE2's latent length is a LINK from the performer's own seconds output —
    the DiT refuses a latent that disagrees with it. A registry that aimed the
    `seconds` slot at that node would look right and do nothing, so this pins
    the applier's refusal AND that the YuE2 row aims elsewhere.
    """
    gw = _load_gateway()
    entry = _entry("yue2-3b")
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    assert isinstance(graph["5"]["inputs"]["seconds"], list), "seconds must stay linked"

    applied = gw.graphs.apply_registry_slots(graph, entry, {"seconds": 45.0})
    assert "seconds" in applied
    assert graph["3"]["inputs"]["max_duration"] == 45.0
    assert graph["5"]["inputs"]["seconds"] == ["3", 1], "the link must survive untouched"


def test_the_score_writer_and_the_performer_are_told_the_same_song():
    """YuE2 drafts an ABC score in one node and performs it in another. If only
    one of them receives the prompt, the score describes one song and the
    performance another — which renders fine and sounds wrong."""
    gw = _load_gateway()
    entry = _entry("yue2-3b")
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    gw.graphs.apply_registry_slots(graph, entry, {"prompt": "sea shanty", "lyrics": "heave away", "seed": 5})
    for node in ("2", "3"):
        assert graph[node]["inputs"]["style"] == "sea shanty"
        assert graph[node]["inputs"]["lyrics"] == "heave away"
        assert graph[node]["inputs"]["seed"] == 5
    assert graph["6"]["inputs"]["seed"] == 5


INSTRUMENTAL = "yue2-3b-instrumental"


def test_the_instrumental_lora_sits_on_the_planner_and_nowhere_else():
    """YuE2's AR planner is ComfyUI's CLIP slot. The LoRA has to be in front of
    BOTH generate nodes - a score written with it and performed without it is
    two different songs - and must leave the sampler's model alone."""
    entry = _entry(INSTRUMENTAL)
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    loaders = {key: node for key, node in graph.items() if node["class_type"] == "LoraLoader"}
    assert len(loaders) == 1
    (lora_id, lora), = loaders.items()
    assert lora["inputs"]["strength_clip"] == 1.0
    assert lora["inputs"]["strength_model"] == 0.0
    for node in graph.values():
        if node["class_type"] in ("YuE2GenerateABC", "YuE2GenerateMusic"):
            assert node["inputs"]["clip"] == [lora_id, 1]
            assert node["inputs"]["mode"] == "full", "the LoRA is meant to run score-first"
    sampler = next(node for node in graph.values() if node["class_type"] == "KSampler")
    assert sampler["inputs"]["model"] == ["1", 0]


def test_the_instrumental_lane_installs_the_lora_its_graph_names():
    entry = _entry(INSTRUMENTAL)
    graph = json.loads((WORKFLOWS / entry["workflow_file"]).read_text())
    lora = next(node for node in graph.values() if node["class_type"] == "LoraLoader")
    declared = {dep["folder"]: dep for dep in entry["model_dependencies"]}
    assert declared["loras"]["relativePath"] == lora["inputs"]["lora_name"]
    # The repo's other two files name unfused q/k/v keys ComfyUI never matches.
    assert declared["loras"]["relativePath"].endswith("_comfyui.safetensors")
    assert "checkpoints" in declared, "a child's model_dependencies replaces its parent's"


def test_the_instrumental_lane_pins_the_mode_instead_of_offering_it():
    entry = _entry(INSTRUMENTAL)
    assert "mode" not in entry["accepts"]
    assert entry["lyrics_format"] == "section-plan"
    assert entry["license"]["commercial"] is False


def test_an_empty_lyrics_field_means_what_the_lane_says_it_means():
    gw = _load_gateway()
    plan = "[intro]\n[verse]\n[outro]"
    assert gw.graphs.fill_empty_lyrics(_entry(INSTRUMENTAL), {"lyrics": "  "})["lyrics"] == "[instrumental]"
    assert gw.graphs.fill_empty_lyrics(_entry(INSTRUMENTAL), {})["lyrics"] == "[instrumental]"
    assert gw.graphs.fill_empty_lyrics(_entry(INSTRUMENTAL), {"lyrics": plan})["lyrics"] == plan
    # Base YuE2 and ACE-Step declare nothing: there, empty already IS the instruction.
    assert gw.graphs.fill_empty_lyrics(_entry("yue2-3b"), {"lyrics": ""})["lyrics"] == ""
