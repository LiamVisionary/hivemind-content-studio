"""The route table has to answer exactly what the if-chain answered.

Dispatch used to be a 1,100-line if/elif over `parsed.path` inside do_GET and
do_POST. It is now a table, which is only an improvement if every path that
reached a block then reaches the same code now - so the mapping below was read
off the chain that was replaced, and is asserted rather than trusted.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent


def load_app():
    for _cached in [n for n in sys.modules if n == 'gateway' or n.startswith('gateway.')]:
        del sys.modules[_cached]
    spec = importlib.util.spec_from_file_location('zimg_app_routes', BASE / 'app.py')
    app = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app)
    return app


# (method, path, the Handler method it must reach). Every row of the table is
# covered, parameterised paths included.
EXPECTED = [
    ('GET', '/healthz', 'get_health'),
    ('GET', '/health', 'get_health'),
    ('GET', '/workflow-key', 'get_workflow_key'),
    ('GET', '/api/e2e/vault-identity', 'get_api_e2e_vault_identity'),
    ('GET', '/workflow-for-output', 'get_workflow_for_output'),
    ('GET', '/ws', 'get_ws'),
    ('GET', '/', 'get_frontend'),
    ('GET', '/history', 'get_frontend'),
    ('GET', '/models', 'get_frontend'),
    ('GET', '/workbench', 'get_frontend'),
    ('GET', '/favicon.ico', 'get_frontend'),
    ('GET', '/_next/static/chunk.js', 'get_frontend'),
    ('GET', '/api/models', 'get_api_models'),
    ('GET', '/api/library', 'get_api_library'),
    ('GET', '/api/model-preview', 'get_api_model_preview'),
    ('GET', '/api/loras/preview', 'get_api_loras_preview'),
    ('GET', '/api/loras', 'get_api_loras'),
    ('GET', '/api/civitai/lora-updates', 'get_api_civitai_lora_updates'),
    ('GET', '/api/civitai/base-models', 'get_api_civitai_base_models'),
    ('GET', '/api/civitai/images', 'get_api_civitai_images'),
    ('GET', '/api/civitai/search', 'get_api_civitai_search'),
    ('GET', '/api/civitai/download/9271', 'get_api_civitai_download'),
    ('GET', '/api/comfy/prompt-by-client/client-42', 'get_api_comfy_prompt_by_client'),
    ('GET', '/comfy/view', 'get_comfy_view'),
    ('GET', '/view', 'get_comfy_view'),
    ('GET', '/output', 'get_output'),
    ('GET', '/mobile', 'get_mobile_app'),
    ('GET', '/mobile/', 'get_mobile_app'),
    ('GET', '/mobile/index.html', 'get_mobile_app'),
    ('GET', '/assets/index.js', 'get_mobile_app'),
    ('GET', '/comfy/object_info', 'get_mobile_app'),
    ('GET', '/api/restore/projects', 'get_api_restore_projects'),
    ('GET', '/api/restore/capabilities', 'get_api_restore_capabilities'),
    ('GET', '/api/restore/project/p-1', 'get_api_restore_project'),
    ('GET', '/api/restore/source/s-1', 'get_api_restore_source'),
    ('GET', '/api/history', 'get_api_history'),
    ('GET', '/api/job/j-1', 'get_api_job'),
    ('GET', '/job/j-1', 'get_job'),
    ('GET', '/image/frame.png', 'get_image'),

    ('POST', '/api/job/j-1/cancel', 'post_job_cancel'),
    ('POST', '/api/cancel/j-1', 'post_api_cancel'),
    ('POST', '/api/delete-output', 'post_api_delete_output'),
    ('POST', '/api/lanes/resolve', 'post_api_lanes_resolve'),
    ('POST', '/api/delete-input', 'post_api_delete_input'),
    ('POST', '/api/interpolate', 'post_api_interpolate'),
    ('POST', '/api/smart-mask', 'post_api_smart_mask'),
    ('POST', '/api/ltx-director', 'post_api_ltx_director'),
    ('POST', '/api/episode', 'post_api_episode'),
    ('POST', '/api/upscale', 'post_api_upscale'),
    ('POST', '/api/restore/upload', 'post_api_restore_upload'),
    ('POST', '/api/restore', 'post_api_restore'),
    ('POST', '/api/restore/plan', 'post_api_restore_plan'),
    ('POST', '/api/restore/finish', 'post_api_restore_finish'),
    ('POST', '/api/restore/cancel/p-1', 'post_api_restore_cancel'),
    ('POST', '/api/restore/delete/p-1', 'post_api_restore_delete'),
    ('POST', '/api/models/equip', 'post_api_models_equip_or_unequip'),
    ('POST', '/api/models/unequip', 'post_api_models_equip_or_unequip'),
    ('POST', '/api/loras/select', 'post_api_loras_select'),
    ('POST', '/api/civitai/download', 'post_api_civitai_download'),
    ('POST', '/api/civitai/cancel-download/9271', 'post_api_civitai_cancel_download'),
    ('POST', '/comfy/prompt', 'post_comfy'),
    ('POST', '/mobile/queue', 'post_comfy'),
    ('POST', '/generate', 'post_generate'),
    ('POST', '/api/generate', 'post_generate'),

    ('DELETE', '/comfy/queue', 'delete_comfy'),
    ('DELETE', '/mobile/queue', 'delete_comfy'),
]


class RouteTableTests(unittest.TestCase):
    def setUp(self):
        self.app = load_app()
        self.routes = self.app.routes

    def test_every_path_the_gateway_answered_reaches_the_same_handler(self):
        for method, path, handler in EXPECTED:
            with self.subTest(method=method, path=path):
                _, route = self.routes.match(method, path)
                self.assertIsNotNone(route, f"{method} {path} reaches no route")
                self.assertEqual(route.handler, handler)

    def test_the_table_covers_every_route_and_the_test_covers_every_row(self):
        """A row nothing exercises is a route nobody checked when it moved."""
        covered = {(method, handler) for method, _, handler in EXPECTED}
        for route in self.routes.ROUTES:
            with self.subTest(route=repr(route)):
                self.assertIn((route.method, route.handler), covered)

    def test_every_route_names_a_handler_the_request_handler_actually_has(self):
        for route in self.routes.ROUTES:
            with self.subTest(route=repr(route)):
                self.assertTrue(callable(getattr(self.app.http.Handler, route.handler, None)))

    def test_only_the_health_probe_answers_without_the_token(self):
        """Every other path - including one no route claims - is behind the
        token, so an unauthenticated caller cannot map the surface."""
        open_paths = sorted(
            path for route in self.routes.ROUTES if not route.auth for path in route.exact
        )
        self.assertEqual(open_paths, ['/health', '/healthz'])
        self.assertEqual([r.prefixes for r in self.routes.ROUTES if not r.auth], [()])

    def test_order_decides_when_two_rows_claim_one_path(self):
        # /comfy/view is a private output first and a ComfyUI path second; the
        # exact row sits above the /comfy/ proxy, and says NEXT when the name
        # is not one of ours.
        index, route = self.routes.match('GET', '/comfy/view')
        self.assertEqual(route.handler, 'get_comfy_view')
        _, following = self.routes.match('GET', '/comfy/view', start=index + 1)
        self.assertEqual(following.handler, 'get_mobile_app')

    def test_a_path_no_row_claims_has_no_route(self):
        for method in ('GET', 'POST', 'DELETE'):
            with self.subTest(method=method):
                _, route = self.routes.match(method, '/api/not-a-real-route')
                self.assertIsNone(route)

    def test_a_method_the_gateway_does_not_serve_matches_nothing(self):
        _, route = self.routes.match('PUT', '/api/models')
        self.assertIsNone(route)

    def test_every_row_is_reachable_by_one_of_its_own_paths(self):
        """An unreachable row is a route that quietly stopped answering."""
        for index, route in enumerate(self.routes.ROUTES):
            samples = list(route.exact) + [
                prefix + ('sample' + (route.suffix or '')) for prefix in route.prefixes
            ]
            with self.subTest(route=repr(route)):
                hits = [self.routes.match(route.method, path)[0] for path in samples]
                self.assertIn(index, hits)

    def test_lane_refresh_is_declared_for_every_method_the_table_serves(self):
        for route in self.routes.ROUTES:
            self.assertIn(route.method, self.routes.REFRESHES_LANES)


if __name__ == '__main__':
    unittest.main()
