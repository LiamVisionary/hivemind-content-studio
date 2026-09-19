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

    def test_per_view_prompt_replaces_the_shared_one(self):
        views = resolve_character_sheet_views({'views': [
            {'id': 'head', 'prompt': 'black camisole top'},
            'front',
        ]})
        head, front = views
        shared = 'black camisole and wide-leg trousers with flat shoes'
        head_prompt = character_sheet_view_prompt(head, shared)
        front_prompt = character_sheet_view_prompt(front, shared)
        # The close-up describes only what it shows; the body view gets the
        # shared head-to-toe description.
        self.assertIn('black camisole top', head_prompt)
        self.assertNotIn('flat shoes', head_prompt)
        self.assertIn('flat shoes', front_prompt)

    def test_close_up_views_reassert_framing_last(self):
        view = resolve_character_sheet_views({'views': ['head']})[0]
        prompt = character_sheet_view_prompt(view, 'wide-leg trousers and black flat shoes')
        # The wardrobe clause is present, but framing gets the final word — this
        # is what stops a head-and-shoulders view rendering as a full body.
        self.assertIn('black flat shoes', prompt)
        self.assertTrue(prompt.rstrip().endswith('cropped at the chest.'))
        self.assertLess(prompt.index('flat shoes'), prompt.index('cropped at the chest'))

    def test_full_body_views_get_no_framing_guard(self):
        view = resolve_character_sheet_views({'views': ['back']})[0]
        prompt = character_sheet_view_prompt(view, 'red cloak')
        self.assertTrue(prompt.rstrip().endswith('red cloak'))
        self.assertNotIn('Framing:', prompt)

    def test_framing_guard_stays_off_when_nothing_was_described(self):
        view = resolve_character_sheet_views({'views': ['head']})[0]
        # No wardrobe text means nothing can drag the framing, so the donor
        # template is left exactly as it was.
        self.assertNotIn('Framing:', character_sheet_view_prompt(view))

    def test_per_view_prompt_survives_a_preset_free_mixed_sheet(self):
        views = resolve_character_sheet_views({'views': [
            {'id': 'face', 'prompt': 'gold drop earrings'},
            {'id': 'front', 'prompt': 'full outfit head to toe'},
            'left',
        ]})
        self.assertEqual([v['id'] for v in views], ['face', 'front', 'left'])
        self.assertEqual(views[0]['prompt'], 'gold drop earrings')
        self.assertNotIn('prompt', views[2])

    def test_dict_and_string_view_entries_dedupe_together(self):
        views = resolve_character_sheet_views({'views': [
            {'id': 'front', 'prompt': 'first wins'}, 'front', {'id': 'front'},
        ]})
        self.assertEqual(len(views), 1)
        self.assertEqual(views[0]['prompt'], 'first wins')

    def test_unknown_view_id_still_rejected_in_dict_form(self):
        with self.assertRaises(ValueError):
            resolve_character_sheet_views({'views': [{'id': 'elbow'}]})


class GridTest(unittest.TestCase):
    def test_turnaround_stays_a_strip(self):
        self.assertEqual(character_sheet_grid(4), {'rows': 1, 'cols': 4, 'square': False})

    def test_larger_sets_pack_square(self):
        grid = character_sheet_grid(9)
        self.assertTrue(grid['square'])
        self.assertEqual(grid['rows'], 1)  # sheet_layout repacks from count


if __name__ == '__main__':
    unittest.main()
