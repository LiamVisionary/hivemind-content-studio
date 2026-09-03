"""The Restore Studio's plan maths exists twice, and the copies must agree.

The gateway (packages/media-gateway/video_restore.py) decides the plan; the
browser (packages/open-generative-ai/src/lib/videoRestore.js) restates it so the
panel can say "14 chunks, 2560x1440, about 40 minutes" while the file is still
in the picker, before anything is uploaded.

Two copies of an arithmetic is one copy to forget when it changes, and the copy
that loses is always the one the render actually uses. So this runs the same
cases through both and compares chunk for chunk. A divergence here is not a
rounding curiosity: it is the panel promising a plan the gateway will not
execute.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = ROOT / "packages" / "media-gateway"
BROWSER_LIB = ROOT / "packages" / "open-generative-ai" / "src" / "lib" / "videoRestore.js"


def _load_gateway_module(name: str):
    """Import one gateway module BY PATH, without putting its directory on
    sys.path — packages/media-gateway/app.py would otherwise shadow this
    repo's own `app` package for every test collected afterwards."""
    spec = importlib.util.spec_from_file_location(f"_gateway_{name}", GATEWAY / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


video_restore = _load_gateway_module("video_restore")

# Every case is a shape that has actually caused trouble somewhere: a clip that
# does not divide evenly, an off-lattice batch, a vertical source, a clip
# shorter than one chunk, a capped long edge, and a preview parked near the end.
CASES = [
    {"name": "even", "frames": 480, "fps": 24, "width": 640, "height": 360, "settings": {}},
    {"name": "ragged", "frames": 487, "fps": 24, "width": 640, "height": 360, "settings": {"chunk_seconds": 2}},
    {"name": "off-lattice batch", "frames": 300, "fps": 30, "width": 1280, "height": 720, "settings": {"batch_size": 7}},
    {"name": "vertical", "frames": 240, "fps": 24, "width": 1080, "height": 1920, "settings": {"resolution": "1080p"}},
    {"name": "shorter than a chunk", "frames": 17, "fps": 24, "width": 320, "height": 240, "settings": {"chunk_seconds": 30}},
    {"name": "capped long edge", "frames": 200, "fps": 25, "width": 2560, "height": 1080,
     "settings": {"resolution": "1440p", "max_resolution": 2560}},
    {"name": "wide context", "frames": 600, "fps": 24, "width": 854, "height": 480,
     "settings": {"batch_size": 9, "context_frames": 18, "seam_frames": 6, "chunk_seconds": 3}},
    {"name": "preview at the end", "frames": 200, "fps": 24, "width": 640, "height": 360,
     "settings": {"preview_frames": 120, "preview_start_frame": 190}},
]

# The two libraries name the same fields differently on the wire; this is the
# whole of the translation, kept in one place so a rename shows up as a failing
# test rather than a silent skip.
SETTING_NAMES = {
    "batch_size": "batchSize",
    "chunk_seconds": "chunkSeconds",
    "context_frames": "contextFrames",
    "seam_frames": "seamFrames",
    "max_resolution": "maxResolution",
    "resolution": "resolution",
    "color_correction": "colorCorrection",
}

BRIDGE = """
import { readFileSync } from 'node:fs';
import { planRestore } from %(lib)s;
const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = cases.map((item) => {
  const plan = planRestore(item);
  return {
    frames: plan.frames,
    width: plan.width,
    height: plan.height,
    batch_size: plan.batchSize,
    chunk_frames: plan.chunkFrames,
    context_frames: plan.contextFrames,
    seam_frames: plan.seamFrames,
    chunks: plan.chunks.map((chunk) => [chunk.index, chunk.sourceStart, chunk.sourceLength, chunk.context, chunk.outputLength]),
  };
});
process.stdout.write(JSON.stringify(out));
"""


def _python_plan(case):
    plan = video_restore.restore_plan(
        frames=case["frames"], fps=case["fps"], width=case["width"], height=case["height"],
        options=case["settings"],
    )
    return {
        "frames": plan["frames"],
        "width": plan["width"],
        "height": plan["height"],
        "batch_size": plan["batch_size"],
        "chunk_frames": plan["chunk_frames"],
        "context_frames": plan["context_frames"],
        "seam_frames": plan["seam_frames"],
        "chunks": [
            [c["index"], c["source_start"], c["source_length"], c["context"], c["output_length"]]
            for c in plan["chunks"]
        ],
    }


def _browser_case(case):
    settings = {
        SETTING_NAMES[key]: value
        for key, value in case["settings"].items()
        if key in SETTING_NAMES
    }
    return {
        "frames": case["frames"], "fps": case["fps"],
        "width": case["width"], "height": case["height"],
        "settings": settings,
        "previewFrames": case["settings"].get("preview_frames", 0),
        "previewStartFrame": case["settings"].get("preview_start_frame", 0),
    }


class RestorePlanParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("node"):
            raise unittest.SkipTest("node is required to compare the browser's copy of the plan")
        script = BRIDGE % {"lib": json.dumps(BROWSER_LIB.as_uri())}
        result = subprocess.run(
            [shutil.which("node"), "--input-type=module", "-e", script],
            input=json.dumps([_browser_case(case) for case in CASES]),
            capture_output=True, text=True, timeout=120, cwd=str(BROWSER_LIB.parent),
        )
        if result.returncode != 0:
            raise AssertionError(f"the browser plan bridge failed: {result.stderr[-2000:]}")
        cls.browser = json.loads(result.stdout)

    def test_both_copies_plan_the_same_render(self):
        for case, browser in zip(CASES, self.browser, strict=True):
            with self.subTest(case["name"]):
                self.assertEqual(_python_plan(case), browser)

    def test_the_cases_actually_exercise_more_than_one_chunk(self):
        # A parity suite that only ever compared single-chunk plans would pass
        # while the chunk loop diverged.
        multi = [case for case in CASES if len(_python_plan(case)["chunks"]) > 3]
        self.assertGreaterEqual(len(multi), 3)

    def test_every_case_still_covers_its_source_exactly(self):
        for case in CASES:
            with self.subTest(case["name"]):
                plan = _python_plan(case)
                if case["settings"].get("preview_frames"):
                    continue
                covered = []
                for _, start, _, context, body in plan["chunks"]:
                    covered.extend(range(start + context, start + context + body))
                self.assertEqual(covered, list(range(case["frames"])))


if __name__ == "__main__":
    unittest.main()
