"""The extension tail: cutting an LTX extend result down to the frames it added.

`ltx-2-mlx extend` regenerates the SOURCE plus the new frames as one continuous
file — that is how the soundtrack carries across the join, because the model
holds the source's audio latent clean and denoises only the tail. A sequence
wants one shot per press, not a clip that contains every shot before it, so the
runner trims the source's span off before the output is sealed and filed.

Real ffmpeg clips and a real trim: the claim is about frame-accurate cutting and
keeping the audio stream, neither of which a mocked ffmpeg could settle.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from gateway.native_mlx import (
    LTX_EXTENSION_MIN_TAIL_SECONDS,
    _probe_media_duration,
    trim_ltx_extension_tail,
)


def have_ffmpeg():
    return bool(shutil.which('ffmpeg') and shutil.which('ffprobe'))


def make_clip(path, seconds, frequency, *, silent=False):
    """A testsrc clip, scored unless asked otherwise."""
    cmd = [
        'ffmpeg', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', f'testsrc2=size=320x240:rate=24:duration={seconds}',
    ]
    if not silent:
        cmd += ['-f', 'lavfi', '-i', f'sine=frequency={frequency}:duration={seconds}']
    cmd += ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']
    if not silent:
        cmd += ['-c:a', 'aac']
    cmd += [str(path)]
    subprocess.run(cmd, check=True, timeout=120)


def stream_kinds(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', str(path)],
        capture_output=True, text=True, timeout=30,
    ).stdout
    return [s.get('codec_type') for s in json.loads(out or '{}').get('streams', [])]


@unittest.skipUnless(have_ffmpeg(), 'ffmpeg/ffprobe required')
class LtxExtensionTailTests(unittest.TestCase):
    def test_keeps_only_the_added_span_and_its_sound(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, grown = root / 'source.mp4', root / 'grown.mp4'
            make_clip(source, 3, 300)
            make_clip(grown, 5, 600)

            detail = trim_ltx_extension_tail(grown, source)
            self.assertTrue(detail['applied'], detail)
            self.assertEqual(detail['source_seconds'], 3.0)
            self.assertEqual(detail['total_seconds'], 5.0)

            # The tail is what the extension ADDED — the source's span is gone.
            # Tolerance is one AAC frame (~21ms): the audio grid, not slippage
            # in the cut, is what keeps this off a round 2.0.
            kept = _probe_media_duration(grown)
            self.assertAlmostEqual(kept, 2.0, delta=0.05)
            # The sound is the whole point of extending rather than re-opening
            # on a still frame. A video-only tail would be a silent shot.
            self.assertEqual(stream_kinds(grown), ['video', 'audio'])

    def test_a_silent_source_still_trims(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, grown = root / 'source.mp4', root / 'grown.mp4'
            make_clip(source, 2, 0, silent=True)
            make_clip(grown, 4, 0, silent=True)

            detail = trim_ltx_extension_tail(grown, source)
            self.assertTrue(detail['applied'], detail)
            self.assertAlmostEqual(_probe_media_duration(grown), 2.0, delta=0.05)
            self.assertEqual(stream_kinds(grown), ['video'])

    def test_refuses_rather_than_handing_back_an_empty_clip(self):
        """A clip with too much in it is recoverable; a deleted one is not."""
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, grown = root / 'source.mp4', root / 'same.mp4'
            make_clip(source, 3, 300)
            shutil.copy(source, grown)

            detail = trim_ltx_extension_tail(grown, source)
            self.assertFalse(detail['applied'])
            self.assertIn('nothing to keep', detail['error'])
            # Untouched: the caller keeps the full clip and says the trim failed.
            self.assertAlmostEqual(_probe_media_duration(grown), 3.0, delta=0.05)

    def test_unreadable_media_is_a_detail_not_a_crash(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source.mp4'
            make_clip(source, 2, 300)
            detail = trim_ltx_extension_tail(root / 'missing.mp4', source)
            self.assertFalse(detail['applied'])
            self.assertIn('could not measure', detail['error'])

    def test_the_floor_is_small_enough_to_keep_a_real_shot(self):
        # A one-frame guard would let a useless sliver through; a generous one
        # would reject a legitimately short beat. 0.2s is under any duration the
        # composer can ask for.
        self.assertGreater(LTX_EXTENSION_MIN_TAIL_SECONDS, 0)
        self.assertLess(LTX_EXTENSION_MIN_TAIL_SECONDS, 1.0)


if __name__ == '__main__':
    unittest.main()
