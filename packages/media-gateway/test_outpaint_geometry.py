"""Outpaint placement geometry — the offset fractions decide how much of the
new canvas lands BEFORE the source (Mix-Studio outpaint-plan port). Existing
callers (LTX anchor pipeline) keep the centered default."""

import unittest

from krea2_identity_workflow import ltx_anchor_canvas_geometry


class OutpaintPlacementTest(unittest.TestCase):
    def test_default_stays_centered(self):
        g = ltx_anchor_canvas_geometry(640, 640, 1280, 640)
        self.assertEqual(g["mode"], "outpaint")
        self.assertEqual((g["left"], g["right"]), (320, 320))

    def test_start_anchor_grows_after_the_source(self):
        g = ltx_anchor_canvas_geometry(640, 640, 1280, 640, offset_x=0.0)
        self.assertEqual((g["left"], g["right"]), (0, 640))

    def test_end_anchor_grows_before_the_source(self):
        g = ltx_anchor_canvas_geometry(640, 640, 1280, 640, offset_x=1.0)
        self.assertEqual((g["left"], g["right"]), (640, 0))

    def test_vertical_growth_uses_offset_y(self):
        g = ltx_anchor_canvas_geometry(640, 640, 640, 1280, offset_y=0.0)
        self.assertEqual((g["top"], g["bottom"]), (0, 640))
        self.assertEqual((g["left"], g["right"]), (0, 0))

    def test_junk_offsets_fall_back_to_center(self):
        g = ltx_anchor_canvas_geometry(640, 640, 1280, 640, offset_x="sideways")
        self.assertEqual((g["left"], g["right"]), (320, 320))
        g = ltx_anchor_canvas_geometry(640, 640, 1280, 640, offset_x=7.5)
        self.assertEqual((g["left"], g["right"]), (640, 0))  # clamped to 1


if __name__ == "__main__":
    unittest.main()
