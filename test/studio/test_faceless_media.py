"""Generated visuals for the faceless lane.

Covers the seam between the studio's model routes and the embedded
MoneyPrinterTurbo engine: beats become scene requests, the requests execute
through the shared provider executors, and the results reach the engine as owned
local material without upstream knowing anything new.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hivemind_content_studio import faceless_media
from hivemind_content_studio.manifest import load_manifest
from hivemind_content_studio.planner import plan
from hivemind_content_studio.private_access import read_private_json
from hivemind_content_studio.studio_drafts import StudioRunDraft


def _faceless_brief(tmp_path: Path, *, media_source: str, extra: str = "") -> Path:
    brief = tmp_path / "brief.yaml"
    brief.write_text(
        "id: generated-short\n"
        "lane: faceless\n"
        "title: Generated short\n"
        "runtime_seconds: 20\n"
        "clip_duration_seconds: 5\n"
        f"media_source: {media_source}\n"
        "script: |\n"
        "  A first line. A second line. A third line. A fourth line.\n"
        f"{extra}",
        encoding="utf-8",
    )
    return brief


def test_generated_sources_are_recognised_and_map_to_a_generation_kind() -> None:
    assert faceless_media.is_studio_media_source("studio-image")
    assert faceless_media.is_studio_media_source("studio-video")
    assert not faceless_media.is_studio_media_source("pexels")
    assert not faceless_media.is_studio_media_source("coverr")
    assert not faceless_media.is_studio_media_source(None)

    assert faceless_media.visual_kind("studio-image") == "keyframe"
    assert faceless_media.visual_kind("studio-video") == "motion"


def test_beats_follow_runtime_and_cadence_and_prefer_the_most_specific_source() -> None:
    base = {"runtime_seconds": 20, "clip_duration_seconds": 5}

    # 20s at a 5s cadence is four visuals.
    from_script = faceless_media.plan_visual_beats({**base, "script": "One. Two. Three. Four. Five."})
    assert [beat["prompt"] for beat in from_script] == ["One.", "Two.", "Three.", "Four."]
    assert [beat["scene"] for beat in from_script] == [1, 2, 3, 4]
    assert {beat["duration_seconds"] for beat in from_script} == {5.0}

    # Search terms outrank the narration, and are cycled to fill the runtime.
    from_terms = faceless_media.plan_visual_beats({**base, "script": "One. Two.", "search_terms": ["reef", "kelp"]})
    assert [beat["prompt"] for beat in from_terms] == ["reef", "kelp", "reef", "kelp"]

    # Explicit scenes outrank everything and define their own count.
    from_scenes = faceless_media.plan_visual_beats(
        {**base, "search_terms": ["reef"], "scenes": [{"image_prompt": "a lit harbour"}, {"beat": "a quiet street"}]}
    )
    assert [beat["prompt"] for beat in from_scenes] == ["a lit harbour", "a quiet street"]


def test_a_runaway_runtime_and_cadence_cannot_queue_unbounded_generations() -> None:
    beats = faceless_media.plan_visual_beats(
        {"runtime_seconds": 3600, "clip_duration_seconds": 1, "search_terms": ["a"]}
    )
    assert len(beats) == faceless_media._MAX_VISUALS


def test_a_brief_with_nothing_to_render_from_is_rejected_before_any_generation() -> None:
    with pytest.raises(ValueError, match="subject, script, scenes, or search terms"):
        faceless_media.plan_visual_beats({"runtime_seconds": 10, "clip_duration_seconds": 5})


def test_the_planner_hands_a_generated_source_to_the_engine_as_local_material(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))

    manifest_path = plan(_faceless_brief(tmp_path, media_source="studio-video"))
    manifest = load_manifest(manifest_path)
    params_path = next(item["path"] for item in manifest["artifacts"] if item["role"] == "faceless-params")
    params = read_private_json(Path(params_path))

    # The engine cannot search for something we are about to render, so the
    # params say "local" and render_faceless supplies video_materials.
    assert params["video_source"] == "local"
    assert manifest["brief"]["media_source"] == "studio-video"


def test_a_stock_source_still_reaches_the_engine_unchanged(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))

    manifest_path = plan(_faceless_brief(tmp_path, media_source="coverr"))
    params_path = next(
        item["path"] for item in load_manifest(manifest_path)["artifacts"] if item["role"] == "faceless-params"
    )

    assert read_private_json(Path(params_path))["video_source"] == "coverr"


def test_generated_materials_execute_through_the_shared_route_and_stage_for_the_engine(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    storage = tmp_path / "storage"
    monkeypatch.setattr(
        faceless_media.utils,
        "storage_dir",
        lambda sub_dir="", create=False: str(_ensure(storage / sub_dir if sub_dir else storage)),
    )

    manifest_path = plan(_faceless_brief(tmp_path, media_source="studio-image"))

    class FakeExecutors:
        """Stands in for ProviderExecutors: records the route it was asked for
        and writes the assets the real one would have recorded."""

        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        def generate_keyframes(self, manifest_file, provider):
            self.calls.append(("keyframe", provider))
            manifest = load_manifest(manifest_file)
            requests = read_private_json(
                Path(next(item["path"] for item in manifest["artifacts"] if item["role"] == "keyframe-requests"))
            )
            from hivemind_content_studio.manifest import add_artifact, write_manifest

            for request in requests:
                frame = Path(manifest_file).parent / f"frame-{request['scene']:03d}.png"
                frame.write_bytes(b"\x89PNG\r\n\x1a\n fake pixels")
                add_artifact(manifest, role="keyframe", path=frame, provider=provider)
                manifest["artifacts"][-1]["scene"] = request["scene"]
            write_manifest(Path(manifest_file), manifest)

        def animate_scenes(self, manifest_file, provider):  # pragma: no cover - not this test's path
            raise AssertionError("a still source must not queue video generations")

    executors = FakeExecutors()
    materials = faceless_media.generate_faceless_materials(manifest_path, executors=executors)

    # 20s at a 5s cadence, rendered as stills on the default local route.
    assert executors.calls == [("keyframe", "comfyui")]
    assert len(materials) == 4
    assert [Path(item.url).name for item in materials] == ["001.png", "002.png", "003.png", "004.png"]
    for item in materials:
        staged = Path(item.url)
        assert staged.is_file() and staged.stat().st_size > 0
        # preprocess_video only resolves paths inside storage/local_videos.
        assert (storage / "local_videos") in staged.parents
        assert item.provider == "hivemind-comfyui"
        assert item.duration == 5

    # The request contract is written once, so a resumed run does not re-plan it.
    roles = [item["role"] for item in load_manifest(manifest_path)["artifacts"]]
    assert roles.count("keyframe-requests") == 1


def test_the_picked_route_reaches_the_brief_as_provider_and_model() -> None:
    draft = StudioRunDraft(
        lane="faceless",
        title="Routed short",
        faceless={
            "media_source": "studio-video",
            "media_route": {"provider": "comfyui", "model": "ltx23-eros-fast"},
            "script": "A. B.",
        },
    )
    brief = draft.to_brief()

    assert faceless_media.selected_provider(brief) == "comfyui"
    # The executors read the model from provider_options, keyed by the role the
    # source implies — a clip source is motion, a still source is a keyframe.
    assert brief["provider_options"]["comfyui"]["motion"]["model"] == "ltx23-eros-fast"
    # An image/video model does not fill the stock-library role.
    assert "stock" not in brief.get("providers", {})


def test_an_unrouted_generated_run_defaults_to_the_local_studio_lane() -> None:
    draft = StudioRunDraft(
        lane="faceless",
        title="Unrouted short",
        faceless={"media_source": "studio-image", "script": "A. B."},
    )
    brief = draft.to_brief()

    assert faceless_media.selected_provider(brief) == "comfyui"
    assert brief.get("provider_options", {}) == {}


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path
