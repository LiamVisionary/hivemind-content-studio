# SPDX-License-Identifier: Apache-2.0
"""A real render, proving each scene's transition reaches the frames.

Everything else about scenes is unit-tested against stubs, which can prove the
right value was passed and nothing about what came out. This renders two source
clips through the actual composition path twice — once with per-scene
transitions, once with none — and measures the difference between the two
outputs frame by frame.

It is skipped without ffmpeg, Pillow and numpy, because a test that cannot run
should say so rather than fail.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

pytest.importorskip("PIL", reason="frame measurement needs Pillow")
pytest.importorskip("numpy", reason="frame measurement needs numpy")
pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="rendering needs ffmpeg"
)


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", *args, "-y"], check=True)


def _frame_mean_abs_diff(first: str, second: str, at: str, tmp) -> float:
    import numpy as np
    from PIL import Image

    out = []
    for tag, src in (("a", first), ("b", second)):
        png = str(tmp / f"{tag}-{at}.png")
        _ffmpeg("-ss", at, "-i", src, "-frames:v", "1", png)
        out.append(np.asarray(Image.open(png).convert("L"), dtype=float))
    return float(np.abs(out[0] - out[1]).mean())


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    """Two renders of the same footage: per-scene transitions, and none."""
    from app.models.schema import VideoAspect, VideoConcatMode, VideoTransitionMode
    from app.services import video

    tmp = tmp_path_factory.mktemp("scene-transitions")
    storm, calm = str(tmp / "storm.mp4"), str(tmp / "calm.mp4")
    audio = str(tmp / "narration.wav")
    # Patterned, not solid: a zoom of a flat colour looks like no zoom at all.
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=s=540x960:d=3:r=24", "-pix_fmt", "yuv420p", storm)
    _ffmpeg("-f", "lavfi", "-i", "smptebars=s=540x960:d=3:r=24", "-pix_fmt", "yuv420p", calm)
    _ffmpeg("-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "5", audio)

    def render(name, path_transitions):
        out = str(tmp / name)
        video.combine_videos(
            combined_video_path=out, video_paths=[storm, calm], audio_file=audio,
            video_aspect=VideoAspect.portrait,
            video_concat_mode=VideoConcatMode.sequential,
            video_transition_mode=VideoTransitionMode.none,
            max_clip_duration=3, threads=2, path_transitions=path_transitions,
        )
        return out

    treated = render("per-scene.mp4", {
        storm: VideoTransitionMode.fade_in,
        calm: VideoTransitionMode.zoom_out,
    })
    control = render("control.mp4", None)
    return treated, control, tmp


def test_both_renders_produced_a_playable_file(rendered):
    treated, control, _ = rendered
    for path in (treated, control):
        assert os.path.getsize(path) > 10_000, path


def test_the_first_scenes_fade_in_reaches_the_frames(rendered):
    """Its opening frame is near black where the control is fully lit."""
    treated, control, tmp = rendered
    assert _frame_mean_abs_diff(treated, control, "0.04", tmp) > 80


def test_the_fade_stops_when_it_is_over(rendered):
    """A one-second fade must be one second. Past it the two renders are the
    same footage, so any lasting difference would be the effect leaking."""
    treated, control, tmp = rendered
    assert _frame_mean_abs_diff(treated, control, "1.5", tmp) < 5


def test_the_second_scene_still_differs_after_the_first_has_settled(rendered):
    """The point of per-scene transitions, and the thing a single global mode
    cannot do: scene one's effect is finished while scene two's is running."""
    treated, control, tmp = rendered
    settled_scene_one = _frame_mean_abs_diff(treated, control, "1.5", tmp)
    running_scene_two = _frame_mean_abs_diff(treated, control, "3.04", tmp)
    assert running_scene_two > settled_scene_one + 5


def test_the_second_scenes_zoom_converges_rather_than_persisting(rendered):
    """A zoom settles. If the gap did not close, the clip would be permanently
    scaled rather than transitioning into place."""
    treated, control, tmp = rendered
    early = _frame_mean_abs_diff(treated, control, "3.04", tmp)
    late = _frame_mean_abs_diff(treated, control, "4.5", tmp)
    assert late < early, f"zoom did not converge: {early:.1f} -> {late:.1f}"
