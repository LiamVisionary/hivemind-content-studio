"""LTX Director timeline model — adapted from Mix-Studio's ltx-director tests
(BlackMixture/Mix-Studio, GPL-3.0). Their graph assertions are covered
separately; these exercise the normalization half we translated."""

import json
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from ltx_director_timeline import (
    DIRECTOR_MAX_WINDOW_FRAMES,
    DirectorProjectError,
    director_asset_names,
    director_missing_assets,
    director_output_frames,
    director_prompt_inputs,
    director_timeline_data,
    director_window_project,
    normalize_director_project,
    normalize_extension_source,
)


def project(**overrides):
    base = {
        "version": 1,
        "durationFrames": 480,
        "range": {"startFrame": 0, "lengthFrames": 120},
        "globalPrompt": "a quiet street",
        "segments": [],
    }
    base.update(overrides)
    return base


class ProjectValidationTest(unittest.TestCase):
    def test_a_project_must_declare_its_version_and_fps(self):
        with self.assertRaises(DirectorProjectError):
            normalize_director_project({"durationFrames": 120})
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(version=2))
        # The node's timeline grid is fixed; a project claiming 30 fps would
        # place every segment at the wrong second.
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(fps=30))
        self.assertEqual(normalize_director_project(project(fps=24))["fps"], 24)

    def test_the_render_window_may_not_exceed_twenty_seconds_or_leave_the_project(self):
        ok = normalize_director_project(
            project(range={"startFrame": 0, "lengthFrames": DIRECTOR_MAX_WINDOW_FRAMES})
        )
        self.assertEqual(ok["range"]["lengthFrames"], 480)
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(
                project(durationFrames=1000, range={"startFrame": 0, "lengthFrames": 481})
            )
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(range={"startFrame": 400, "lengthFrames": 120}))

    def test_a_project_with_nothing_to_say_is_refused(self):
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(globalPrompt=""))
        # A segment prompt alone is enough.
        got = normalize_director_project(project(
            globalPrompt="",
            segments=[{"start": 0, "length": 60, "prompt": "a door opens"}],
        ))
        self.assertEqual(got["segments"][0]["prompt"], "a door opens")

    def test_segments_are_sorted_and_may_not_overlap(self):
        got = normalize_director_project(project(segments=[
            {"id": "b", "start": 60, "length": 60, "prompt": "second"},
            {"id": "a", "start": 0, "length": 60, "prompt": "first"},
        ]))
        self.assertEqual([s["id"] for s in got["segments"]], ["a", "b"])
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(segments=[
                {"start": 0, "length": 60, "prompt": "first"},
                {"start": 30, "length": 60, "prompt": "overlaps"},
            ]))

    def test_media_names_may_not_escape_the_input_directory(self):
        for bad in ("../secrets.png", "/etc/passwd.png", "C:/x.png", "a\nb.png", "deep/../x.png"):
            with self.assertRaises(DirectorProjectError, msg=bad):
                normalize_director_project(project(segments=[
                    {"type": "image", "start": 0, "length": 60, "prompt": "", "imageFile": bad},
                ]))
        # Wrong extension for the track is refused too — an .mp4 is not a guide image.
        with self.assertRaises(DirectorProjectError):
            normalize_director_project(project(segments=[
                {"type": "image", "start": 0, "length": 60, "prompt": "", "imageFile": "clip.mp4"},
            ]))
        ok = normalize_director_project(project(segments=[
            {"type": "image", "start": 0, "length": 60, "prompt": "", "imageFile": "shots/a.png"},
        ]))
        self.assertEqual(ok["segments"][0]["imageFile"], "shots/a.png")
        self.assertEqual(ok["segments"][0]["fileName"], "a.png")

    def test_a_media_slice_longer_than_its_source_is_corrected(self):
        got = normalize_director_project(project(audioSegments=[
            {"start": 0, "length": 120, "trimStart": 48, "audioFile": "vo.wav", "sourceFrames": 10},
        ]))
        # 48 trimmed + 120 used cannot come out of a 10-frame file.
        self.assertEqual(got["audioSegments"][0]["audioDurationFrames"], 168)

    def test_override_audio_needs_a_real_video_not_a_still(self):
        still = normalize_director_project(project(
            motionSegments=[{"start": 0, "length": 60, "videoFile": "ref.png", "isStaticImage": True}],
            settings={"overrideAudio": True},
        ))
        self.assertFalse(still["settings"]["overrideAudio"], "a still frame carries no soundtrack")
        moving = normalize_director_project(project(
            motionSegments=[{"start": 0, "length": 60, "videoFile": "ref.mp4"}],
            settings={"overrideAudio": True},
        ))
        self.assertTrue(moving["settings"]["overrideAudio"])
        self.assertEqual(moving["motionSegments"][0]["videoAttentionStrength"], 0.65)
        self.assertEqual(moving["motionSegments"][0]["resampleMode"], "nearest")


class ExtensionSourceTest(unittest.TestCase):
    def test_only_the_input_file_form_is_accepted(self):
        got = normalize_extension_source({"inputName": "prev.mp4", "sourceSeconds": 5})
        self.assertEqual(got["inputName"], "prev.mp4")
        self.assertEqual(got["fileName"], "prev.mp4")
        self.assertTrue(got["continueAudio"])
        # Their media-library form points into plaintext storage we do not have,
        # so it is refused loudly rather than ignored.
        with self.assertRaises(DirectorProjectError):
            normalize_extension_source({"itemId": "abc", "videoId": "def"})
        self.assertIsNone(normalize_extension_source(None))

    def test_source_dimensions_and_duration_are_bounded_and_paired(self):
        with self.assertRaises(DirectorProjectError):
            normalize_extension_source({"inputName": "p.mp4", "sourceSeconds": 25})
        with self.assertRaises(DirectorProjectError):
            normalize_extension_source({"inputName": "p.mp4", "sourceWidth": 8})
        with self.assertRaises(DirectorProjectError):
            normalize_extension_source({"inputName": "p.mp4", "sourceWidth": 1024})


class NodeInputsTest(unittest.TestCase):
    def test_prompts_join_with_pipes_and_lengths_partition_the_window(self):
        got = director_prompt_inputs(normalize_director_project(project(segments=[
            {"start": 0, "length": 48, "prompt": "she turns"},
            {"start": 48, "length": 72, "prompt": "he answers"},
        ])))
        self.assertEqual(got["localPrompts"], "she turns | he answers")
        self.assertEqual(got["segmentLengths"], "48,72")
        self.assertEqual(sum(int(n) for n in got["segmentLengths"].split(",")), 120)

    def test_a_gap_is_absorbed_rather_than_left_as_a_hole(self):
        # 0-24 empty, 24-48 spoken, 48-120 empty. A hole would shift the prompt.
        got = director_prompt_inputs(normalize_director_project(project(segments=[
            {"start": 24, "length": 24, "prompt": "one line"},
        ])))
        self.assertEqual(got["localPrompts"], "one line")
        self.assertEqual(got["segmentLengths"], "120", "the window is fully covered")

    def test_only_image_segments_inside_the_window_contribute_guide_strength(self):
        got = director_prompt_inputs(normalize_director_project(project(
            durationFrames=480,
            range={"startFrame": 0, "lengthFrames": 120},
            segments=[
                {"type": "image", "start": 0, "length": 60, "prompt": "a",
                 "imageFile": "a.png", "guideStrength": 0.5},
                {"type": "text", "start": 60, "length": 60, "prompt": "b"},
                {"type": "image", "start": 240, "length": 60, "prompt": "c",
                 "imageFile": "c.png", "guideStrength": 2},
            ],
        )))
        self.assertEqual(got["guideStrength"], "0.50", "the out-of-window guide is excluded")

    def test_output_frames_land_on_the_8n_plus_1_lattice(self):
        self.assertEqual(director_output_frames(normalize_director_project(
            project(range={"startFrame": 0, "lengthFrames": 120}))), 121)
        self.assertEqual(director_output_frames(normalize_director_project(
            project(range={"startFrame": 0, "lengthFrames": 121}))), 121)
        self.assertEqual(director_output_frames(normalize_director_project(
            project(range={"startFrame": 0, "lengthFrames": 122}))), 129)

    def test_timeline_data_is_a_json_string_with_the_track_flags(self):
        normalized = normalize_director_project(project(
            audioSegments=[{"start": 0, "length": 60, "audioFile": "vo.wav"}],
        ))
        data = json.loads(director_timeline_data(normalized))
        self.assertTrue(data["mainTrackEnabled"])
        self.assertTrue(data["audioTrackEnabled"])
        self.assertFalse(data["motionTrackEnabled"])
        self.assertEqual(data["global_prompt"], "a quiet street")
        self.assertEqual(data["normalDurationFrames"], 120)


class WindowTest(unittest.TestCase):
    def test_the_window_rebases_to_zero_and_advances_trims(self):
        normalized = normalize_director_project(project(
            durationFrames=480,
            range={"startFrame": 96, "lengthFrames": 120},
            segments=[{"start": 48, "length": 120, "prompt": "spans the window start"}],
            audioSegments=[{"start": 48, "length": 120, "trimStart": 10, "audioFile": "vo.wav"}],
        ))
        windowed = director_window_project(normalized)
        self.assertEqual(windowed["range"], {"startFrame": 0, "lengthFrames": 120})
        self.assertEqual(windowed["segments"][0]["start"], 0)
        self.assertEqual(windowed["segments"][0]["length"], 72, "clipped at the window edge")
        # 48 frames of the clip were consumed before the window opened, so the
        # audio must start 48 frames deeper into the source, not at frame 10.
        self.assertEqual(windowed["audioSegments"][0]["trimStart"], 58)

    def test_segments_entirely_outside_the_window_are_dropped(self):
        normalized = normalize_director_project(project(
            durationFrames=480,
            range={"startFrame": 240, "lengthFrames": 120},
            segments=[
                {"start": 0, "length": 60, "prompt": "before"},
                {"start": 240, "length": 60, "prompt": "inside"},
            ],
        ))
        windowed = director_window_project(normalized)
        self.assertEqual([s["prompt"] for s in windowed["segments"]], ["inside"])


class AssetTest(unittest.TestCase):
    def test_asset_names_are_deduplicated_across_tracks(self):
        normalized = normalize_director_project(project(
            segments=[
                {"type": "image", "start": 0, "length": 60, "prompt": "", "imageFile": "a.png"},
                {"type": "image", "start": 60, "length": 60, "prompt": "", "imageFile": "a.png"},
            ],
            audioSegments=[{"start": 0, "length": 60, "audioFile": "vo.wav"}],
        ))
        self.assertEqual(director_asset_names(normalized), ["a.png", "vo.wav"])

    def test_missing_assets_are_named_before_the_node_ever_runs(self):
        normalized = normalize_director_project(project(
            segments=[{"type": "image", "start": 0, "length": 60, "prompt": "", "imageFile": "a.png"}],
            audioSegments=[{"start": 0, "length": 60, "audioFile": "vo.wav"}],
        ))
        with TemporaryDirectory() as td:
            (Path(td) / "a.png").write_bytes(b"png")
            self.assertEqual(director_missing_assets(normalized, td), ["vo.wav"])
            (Path(td) / "vo.wav").write_bytes(b"wav")
            self.assertEqual(director_missing_assets(normalized, td), [])


if __name__ == "__main__":
    unittest.main()
