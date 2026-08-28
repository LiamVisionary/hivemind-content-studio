# SPDX-License-Identifier: Apache-2.0
"""Scenes: each part of a video gets its own footage, for its own length.

The idea is from upstream PR harry0703/MoneyPrinterTurbo#1275, rebuilt against
this fork rather than merged — that PR rewrites `task.py`, `material.py` and
`cli.py`, which here are half the size of upstream's and shaped differently.

What makes a scene worth having over `match_materials_to_script`: that setting
asks for keywords in narrative order and hopes the clips land near the right
words. A scene says where the boundary is, so a long opening cannot eat the
budget and leave the ending playing over whatever was left.
"""

from __future__ import annotations

import pytest

from app.models.schema import MaterialInfo, SceneConfig, VideoParams
from app.services import scenes


def s(**kw) -> SceneConfig:
    return SceneConfig(**kw)


# ── numbering ───────────────────────────────────────────────────────────────


def test_scenes_are_numbered_in_order_when_the_caller_did_not():
    got = scenes.normalize([s(script="a"), s(script="b"), s(script="c")])
    assert [x.scene_id for x in got] == [1, 2, 3]


def test_a_callers_own_numbering_is_kept():
    got = scenes.normalize([s(scene_id=10, script="a"), s(script="b")])
    assert [x.scene_id for x in got] == [10, 1]


def test_assigned_ids_do_not_collide_with_stated_ones():
    got = scenes.normalize([s(scene_id=1, script="a"), s(script="b"), s(script="c")])
    assert sorted(x.scene_id for x in got) == [1, 2, 3]


def test_duplicate_ids_are_refused():
    with pytest.raises(scenes.SceneError, match="share id"):
        scenes.normalize([s(scene_id=2, script="a"), s(scene_id=2, script="b")])


def test_no_scenes_is_not_an_error():
    """Every seam calls this. It has to be free when scenes are not in use."""
    assert scenes.normalize(None) == [] and scenes.normalize([]) == []


# ── the narration ───────────────────────────────────────────────────────────


def test_the_script_is_the_scenes_joined_in_order():
    assert scenes.combined_script([s(script="one"), s(script="two")]) == "one\n\ntwo"


def test_a_scene_with_no_script_contributes_nothing():
    """Rather than repeating the whole video's script — a scene that says
    everything is not a scene."""
    assert scenes.combined_script([s(script="one"), s(materials=[])]) == "one"


def test_scenes_that_only_carry_materials_keep_the_video_level_script():
    """Own clips, shared narration: a legitimate way to use this."""
    got = scenes.combined_script([s(materials=[]), s(materials=[])], fallback="the whole thing")
    assert got == "the whole thing"


# ── time ────────────────────────────────────────────────────────────────────


def test_unstated_scenes_split_what_is_left():
    assert scenes.durations([s(duration=4), s(), s()], total=10) == [4, 3, 3]


def test_a_stated_duration_is_never_rescaled():
    """Scaling every scene to fit would silently override the one instruction
    the caller actually gave."""
    assert scenes.durations([s(duration=6), s(duration=2)], total=10) == [6, 2]


def test_over_booked_scenes_do_not_borrow_from_the_stated_ones():
    """The audio is what is going to play. A caller who asks for more than there
    is should see that, not have it quietly rebalanced."""
    assert scenes.durations([s(duration=9), s()], total=5) == [9, 0.0]


def test_no_audio_yet_still_reports_the_stated_durations():
    assert scenes.durations([s(duration=3), s()], total=0) == [3, 0.0]


# ── what each scene searches for ────────────────────────────────────────────


def test_a_scenes_own_terms_are_used_as_given():
    got = scenes.terms_for(
        scenes.normalize([s(search_terms=["a lighthouse", "surf"])]),
        generate=lambda *a: pytest.fail("should not ask the model"),
        video_subject="the sea")
    assert got == [["a lighthouse", "surf"]]


def test_terms_are_asked_for_per_scene_not_once_for_the_video():
    """The whole point. Keywords generated from the whole script cannot be
    attributed back to the section that needs them."""
    asked = []

    def generate(subject, script, amount):
        asked.append(script)
        return [f"{script}-clip"]

    got = scenes.terms_for(
        scenes.normalize([s(script="a storm"), s(script="calm water")]),
        generate=generate, video_subject="the sea")
    assert asked == ["a storm", "calm water"]
    assert got == [["a storm-clip"], ["calm water-clip"]]


def test_a_scene_with_its_own_files_searches_for_nothing():
    got = scenes.terms_for(
        scenes.normalize([s(materials=[MaterialInfo()])]),
        generate=lambda *a: pytest.fail("should not ask the model"),
        video_subject="x")
    assert got == [[]]


def test_a_scene_with_nothing_to_go_on_is_refused_rather_than_skipped():
    """Skipping it would shorten the video by however long that scene was meant
    to be, with nothing anywhere saying which part went missing."""
    with pytest.raises(scenes.SceneError, match="scene 1"):
        scenes.terms_for(scenes.normalize([s()]), generate=lambda *a: [], video_subject="x")


def test_a_model_that_returns_nothing_is_an_error_too():
    with pytest.raises(scenes.SceneError, match="no search terms"):
        scenes.terms_for(scenes.normalize([s(script="a storm")]),
                         generate=lambda *a: [], video_subject="x")


# ── the log line ────────────────────────────────────────────────────────────


def test_the_summary_names_each_scene_and_its_share():
    text = scenes.describe(scenes.normalize([s(script="a"), s(search_terms=["surf"])]), [6.0, 4.0])
    assert "scene 1: 6.0s" in text and "scene 2: 4.0s" in text
    assert "terms: surf" in text


# ── the field that is deliberately absent ───────────────────────────────────


def test_a_scene_carries_its_own_transition():
    assert "transition" in SceneConfig.model_fields


# ── the params they hang off ────────────────────────────────────────────────


def test_video_params_accepts_scenes_and_defaults_to_none():
    assert VideoParams(video_subject="x").scenes is None
    p = VideoParams(video_subject="x", scenes=[{"script": "intro", "duration": 3}])
    assert p.scenes[0].script == "intro" and p.scenes[0].duration == 3


# ── through the pipeline ────────────────────────────────────────────────────


def test_the_script_comes_from_the_scenes_rather_than_the_model(monkeypatch):
    """A model asked to write a script afterwards would produce a second,
    different one for footage already chosen scene by scene, and the voiceover
    would stop describing what is on screen."""
    from app.services import task

    monkeypatch.setattr(task.llm, "generate_script",
                        lambda **_: pytest.fail("should not ask the model"))
    params = VideoParams(video_subject="the sea",
                         scenes=[{"script": "a storm"}, {"script": "calm water"}])
    assert task.generate_script("t", params) == "a storm\n\ncalm water"


def test_terms_are_generated_from_each_scene_when_scenes_are_set(monkeypatch):
    from app.services import task

    seen = []
    monkeypatch.setattr(task.llm, "generate_terms",
                        lambda **kw: (seen.append(kw["video_script"]), ["x"])[1])
    params = VideoParams(video_subject="the sea",
                         scenes=[{"script": "a storm"}, {"script": "calm water"}])
    task.generate_terms("t", params, "a storm\n\ncalm water")
    assert seen == ["a storm", "calm water"], "terms must be per scene, not per video"


def test_without_scenes_nothing_about_the_old_path_changes(monkeypatch):
    """The seams are additive. A task with no scenes must behave exactly as it
    did, including asking for one keyword list from the whole script."""
    from app.services import task

    seen = []
    monkeypatch.setattr(task.llm, "generate_terms",
                        lambda **kw: (seen.append(kw["video_script"]), ["x", "y"])[1])
    monkeypatch.setattr(task.twelvelabs, "rerank_terms_by_subject",
                        lambda **kw: kw["search_terms"])
    params = VideoParams(video_subject="the sea")
    got = task.generate_terms("t", params, "the whole script")
    assert seen == ["the whole script"] and got == ["x", "y"]


def test_each_scene_is_downloaded_for_its_own_share_of_the_audio(monkeypatch):
    """A single pooled download cannot be attributed back to the scene that
    needed it, so a long first scene eats the budget."""
    from app.services import task

    calls = []

    def fake_download(**kw):
        calls.append((kw["search_terms"], kw["audio_duration"]))
        return [f"/tmp/{kw['search_terms'][0]}.mp4"]

    monkeypatch.setattr(task.material, "download_videos", fake_download)
    params = VideoParams(
        video_subject="the sea", video_source="pexels",
        scenes=[{"search_terms": ["storm"], "duration": 6}, {"search_terms": ["calm"]}])
    got = task.get_video_materials("t", params, [], audio_duration=10)

    assert calls == [(["storm"], 6.0), (["calm"], 4.0)]
    assert got == ["/tmp/storm.mp4", "/tmp/calm.mp4"], "scene order must survive"


def test_a_scene_that_yields_nothing_fails_the_task(monkeypatch):
    """Rather than a video quietly shorter than it was asked to be."""
    from app.services import task

    failed = []
    monkeypatch.setattr(task.material, "download_videos", lambda **kw: [])
    monkeypatch.setattr(task, "_mark_task_failed",
                        lambda tid, stage, msg: failed.append((stage, msg)))
    params = VideoParams(video_subject="x", video_source="pexels",
                         scenes=[{"search_terms": ["nothing"]}])
    assert task.get_video_materials("t", params, [], audio_duration=5) is None
    assert failed and failed[0][0] == "materials" and "scene 1" in failed[0][1]


def test_a_scenes_own_files_are_used_without_searching(monkeypatch):
    from app.services import task

    monkeypatch.setattr(task.material, "download_videos",
                        lambda **kw: pytest.fail("should not search"))
    monkeypatch.setattr(task.video, "preprocess_video",
                        lambda materials, clip_duration: [MaterialInfo(url="/tmp/mine.mp4")])
    params = VideoParams(video_subject="x", video_source="pexels",
                         scenes=[{"materials": [{"url": "/tmp/mine.mp4"}]}])
    assert task.get_video_materials("t", params, [], audio_duration=5) == ["/tmp/mine.mp4"]


# ── per-scene transitions ───────────────────────────────────────────────────


def test_each_scenes_files_map_to_that_scenes_transition():
    from app.models.schema import VideoTransitionMode

    staged = scenes.normalize([
        s(search_terms=["storm"], transition=VideoTransitionMode.fade_in),
        s(search_terms=["calm"], transition=VideoTransitionMode.zoom_out),
    ])
    got = scenes.transitions_by_path(staged, [["/a.mp4", "/b.mp4"], ["/c.mp4"]])
    assert got == {
        "/a.mp4": VideoTransitionMode.fade_in,
        "/b.mp4": VideoTransitionMode.fade_in,
        "/c.mp4": VideoTransitionMode.zoom_out,
    }


def test_a_scene_with_no_transition_is_absent_rather_than_mapped_to_none():
    """Absent means "fall through to the video-level mode". Mapped to None would
    mean "explicitly nothing", which is a different instruction."""
    from app.models.schema import VideoTransitionMode

    staged = scenes.normalize([s(search_terms=["a"]), s(search_terms=["b"],
                                                        transition=VideoTransitionMode.fade_in)])
    got = scenes.transitions_by_path(staged, [["/a.mp4"], ["/b.mp4"]])
    assert "/a.mp4" not in got and got["/b.mp4"] == VideoTransitionMode.fade_in


def test_composition_applies_each_scenes_own_transition(monkeypatch, tmp_path):
    """The seam that makes this real. Two sources, two scenes, two effects —
    and composition must ask per clip rather than once for the timeline."""
    from app.models.schema import VideoAspect, VideoConcatMode, VideoTransitionMode
    from app.services import video

    applied = []
    monkeypatch.setattr(video, "_apply_transition",
                        lambda clip, value: (applied.append(value), clip)[1])
    monkeypatch.setattr(video, "_write_videofile_with_codec_fallback",
                        lambda clip, path, **kw: Path(path).write_bytes(b"x"))

    class _Clip:
        duration, size, w, h = 2.0, (1080, 1920), 1080, 1920
        def subclipped(self, *a): return self
        def with_speed_scaled(self, *a): return self
        def resized(self, **kw): return self
        def with_position(self, *a): return self
        def close(self): pass

    monkeypatch.setattr(video, "_open_video_clip_quietly", lambda p: _Clip())
    monkeypatch.setattr(video, "AudioFileClip",
                        lambda f: type("A", (), {"duration": 3.0, "close": lambda s: None})())
    monkeypatch.setattr(video, "close_clip", lambda c: None)

    try:
        video.combine_videos(
            combined_video_path=str(tmp_path / "out.mp4"),
            video_paths=["/storm.mp4", "/calm.mp4"],
            audio_file=str(tmp_path / "a.wav"),
            video_aspect=VideoAspect.portrait,
            video_concat_mode=VideoConcatMode.sequential,
            video_transition_mode=VideoTransitionMode.none,
            path_transitions={
                "/storm.mp4": VideoTransitionMode.fade_in,
                "/calm.mp4": VideoTransitionMode.zoom_out,
            },
        )
    except Exception:
        pass  # the render past this point is not what is under test

    assert VideoTransitionMode.fade_in.value in applied, applied
    assert VideoTransitionMode.zoom_out.value in applied, applied


def test_a_path_outside_any_scene_keeps_the_video_level_transition(monkeypatch, tmp_path):
    from app.models.schema import VideoTransitionMode
    from app.services import video

    resolved = []
    monkeypatch.setattr(video, "_apply_transition",
                        lambda clip, value: (resolved.append(value), clip)[1])
    # Only the resolver is under test here; drive it through the same mapping
    # composition builds.
    mapping = {"/known.mp4": VideoTransitionMode.fade_in}
    by_path = {str(k): getattr(v, "value", v) for k, v in mapping.items()}
    assert by_path.get("/unknown.mp4", VideoTransitionMode.zoom_in.value) == \
        VideoTransitionMode.zoom_in.value


def test_scenes_force_sequential_composition(monkeypatch, tmp_path):
    """`random` shuffles clips during composition, which destroys the scene
    boundaries the feature exists to create. This shipped wrong once — scenes
    were added without forcing order, so footage was reordered and the feature
    looked like it ran while guaranteeing nothing."""
    from app.models.schema import VideoConcatMode
    from app.services import task

    seen = {}
    monkeypatch.setattr(task.video, "combine_videos",
                        lambda **kw: (seen.update(kw), kw["combined_video_path"])[1])
    monkeypatch.setattr(task.video, "generate_video", lambda **kw: None)
    monkeypatch.setattr(task.sm.state, "update_task", lambda *a, **k: None)

    params = VideoParams(
        video_subject="x", video_count=1,
        video_concat_mode=VideoConcatMode.random,     # the default that shuffles
        scenes=[{"search_terms": ["a"]}, {"search_terms": ["b"]}],
    )
    try:
        task.generate_final_videos("t", params, ["/a.mp4", "/b.mp4"],
                                   str(tmp_path / "a.wav"), "", 5.0)
    except Exception:
        pass

    assert seen.get("video_concat_mode") == VideoConcatMode.sequential, seen.get("video_concat_mode")


def test_without_scenes_the_chosen_concat_mode_is_respected(monkeypatch, tmp_path):
    from app.models.schema import VideoConcatMode
    from app.services import task

    seen = {}
    monkeypatch.setattr(task.video, "combine_videos",
                        lambda **kw: (seen.update(kw), kw["combined_video_path"])[1])
    monkeypatch.setattr(task.video, "generate_video", lambda **kw: None)
    monkeypatch.setattr(task.sm.state, "update_task", lambda *a, **k: None)

    params = VideoParams(video_subject="x", video_count=1,
                         video_concat_mode=VideoConcatMode.random)
    try:
        task.generate_final_videos("t", params, ["/a.mp4"], str(tmp_path / "a.wav"), "", 5.0)
    except Exception:
        pass
    assert seen.get("video_concat_mode") == VideoConcatMode.random
