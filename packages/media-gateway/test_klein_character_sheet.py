"""Klein Character Sheet unit tests — view resolution, prompt building, grid
hints. The recipe is assimilated from the Civitai "Flux2 Klein Multi-view
Character Generation" v2.0 workflow; see ASSIMILATION_LOG.md."""

import unittest

from klein_character_sheet import (
    KLEIN_SHEET_PRESETS,
    KLEIN_SHEET_VIEWS,
    MAX_SHEET_VIEWS,
    character_sheet_grid,
    character_sheet_view_prompt,
    resolve_character_sheet_views,
)


class ResolveViewsTest(unittest.TestCase):
    def test_turnaround_preset_uses_rotation_order(self):
        views = resolve_character_sheet_views({'preset': 'turnaround'})
        self.assertEqual([v['id'] for v in views], ['front', 'right', 'back', 'left'])

    def test_every_preset_resolves_to_known_views(self):
        for preset, expected in KLEIN_SHEET_PRESETS.items():
            views = resolve_character_sheet_views({'preset': preset})
            self.assertEqual([v['id'] for v in views], expected)

    def test_explicit_views_win_over_preset_and_keep_caller_order(self):
        views = resolve_character_sheet_views({'preset': 'full', 'views': ['face', 'front']})
        self.assertEqual([v['id'] for v in views], ['face', 'front'])

    def test_duplicates_collapse_to_first_occurrence(self):
        views = resolve_character_sheet_views({'views': ['front', 'FRONT', 'front', 'back']})
        self.assertEqual([v['id'] for v in views], ['front', 'back'])

    def test_unknown_view_raises(self):
        with self.assertRaises(ValueError):
            resolve_character_sheet_views({'views': ['front', 'hologram']})

    def test_unknown_preset_raises(self):
        with self.assertRaises(ValueError):
            resolve_character_sheet_views({'preset': 'everything'})

    def test_empty_request_raises(self):
        with self.assertRaises(ValueError):
            resolve_character_sheet_views({})
        with self.assertRaises(ValueError):
            resolve_character_sheet_views({'views': ['', None]})

    def test_view_count_is_capped(self):
        views = resolve_character_sheet_views({'views': list(KLEIN_SHEET_VIEWS)})
        self.assertLessEqual(len(views), MAX_SHEET_VIEWS)


class ViewPromptTest(unittest.TestCase):
    def test_prompt_pins_white_background_and_consistency(self):
        view = resolve_character_sheet_views({'views': ['left']})[0]
        prompt = character_sheet_view_prompt(view)
        self.assertTrue(prompt.startswith('White background.'))
        self.assertIn('the full-body left side view', prompt)
        self.assertIn('same character', prompt)

    def test_user_prompt_is_appended_verbatim(self):
        view = resolve_character_sheet_views({'views': ['front']})[0]
        prompt = character_sheet_view_prompt(view, '  silver armor, cel shading  ')
        self.assertTrue(prompt.endswith('silver armor, cel shading'))

    def test_empty_user_prompt_leaves_template_untouched(self):
        view = resolve_character_sheet_views({'views': ['front']})[0]
        self.assertEqual(
            character_sheet_view_prompt(view, ''),
            character_sheet_view_prompt(view, None),
        )


class GridTest(unittest.TestCase):
    def test_turnaround_stays_a_strip(self):
        self.assertEqual(character_sheet_grid(4), {'rows': 1, 'cols': 4, 'square': False})

    def test_larger_sets_pack_square(self):
        grid = character_sheet_grid(9)
        self.assertTrue(grid['square'])
        self.assertEqual(grid['rows'], 1)  # sheet_layout repacks from count


if __name__ == '__main__':
    unittest.main()
