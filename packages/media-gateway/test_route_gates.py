"""Every path the gateway answers, swept for its token gate.

The gateway is not a framework app, so this sweep used to recover the route
list from the request handler's syntax tree — the only way that could not
drift while dispatch was a long if/elif chain. That chain is now a declarative
table (``gateway/routes.py``), which is a better source than any parse of one:
each row names its method, its paths and whether it is reachable without a
token, and a row added tomorrow is swept by construction.

Two things are asserted, and the second is the one that matters. First, that
the table declares exactly the health checks as public — a new ``auth=False``
row fails this test and has to be argued for here. Second, that the
declaration is TRUE: every other path is requested over a real socket with no
token at all and has to refuse. A table that says ``auth=True`` while the
handler answers anyway is precisely the bug a declarative table can hide, so
the socket half is not optional.
"""

from __future__ import annotations

import json
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app

# Reachable without the token, and why.
#
# The two health names are one endpoint. It answers before the gate because the
# supervisor, the MCP status tool and the studio's catalog all poll it before
# anybody has a token — and it is written to say only that this process is up
# and which lanes are degraded. The lane URLs (where a rented machine lives)
# stay behind the gate inside that same handler.
PUBLIC = {"/healthz", "/health"}


def _paths(route) -> set[str]:
    """Every concrete path this row would answer.

    A prefix row is probed at the prefix itself: that is the shortest thing a
    caller can send, and the gate has to hold there as much as it does deeper.
    """
    return {path for path in route.exact + route.prefixes if path.startswith("/")}


class RouteGates(unittest.TestCase):
    """The gateway's own routes, read out of its table and then requested."""

    def test_the_sweep_reads_real_routes_out_of_the_table(self):
        methods = {route.method for route in app.routes.ROUTES}
        self.assertEqual(methods, {"GET", "POST", "DELETE"})
        paths = {path for route in app.routes.ROUTES for path in _paths(route)}
        self.assertGreater(len(paths), 40, f"expected the gateway's paths, saw {len(paths)}")
        for expected in ("/healthz", "/api/generate", "/api/delete-output"):
            self.assertIn(expected, paths, f"the sweep did not see {expected}")

    def test_nothing_but_the_health_check_is_declared_public(self):
        declared = {path for route in app.routes.ROUTES if not route.auth for path in _paths(route)}
        self.assertEqual(
            declared, PUBLIC,
            "the route table declares these reachable without a token: "
            f"{sorted(declared - PUBLIC)}. Gate it, or add it to PUBLIC in this "
            "file with the reason it must answer.",
        )

    def test_every_gateway_path_refuses_a_request_with_no_token(self):
        # A real socket on an ephemeral port, torn down in the same test: the
        # gate lives in the handler, so nothing short of an actual request
        # proves the table's `auth` flag is telling the truth.
        probes = sorted({path for route in app.routes.ROUTES for path in _paths(route)} - PUBLIC)
        self.assertGreater(len(probes), 40)

        server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        answered = []
        with patch.object(app.config, "TOKEN", "sweep-token"):
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                for path in probes:
                    for verb in ("GET", "POST", "DELETE"):
                        request = Request(
                            base + path,
                            data=json.dumps({}).encode("utf-8") if verb != "GET" else None,
                            headers={"Content-Type": "application/json"},
                            method=verb,
                        )
                        try:
                            with urlopen(request, timeout=5) as response:
                                answered.append(f"{verb} {path} answered {response.status}")
                        except HTTPError as exc:
                            # 401 is the gate; 404/405 is nothing to reach.
                            if exc.code not in (401, 404, 405):
                                answered.append(f"{verb} {path} answered {exc.code}")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        self.assertEqual(answered, [], "these gateway paths answered a request with no token: " + "; ".join(answered))

    def _health(self, query: str = "") -> dict:
        server = app.runtime.ThreadingHTTPServer(("127.0.0.1", 0), app.http.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        with patch.object(app.config, "TOKEN", "sweep-token"):
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                with urlopen(base + "/healthz" + query, timeout=5) as response:
                    return json.loads(response.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_the_health_check_answers_without_a_token_but_hides_the_lane_urls(self):
        payload = self._health()
        self.assertTrue(payload["ok"])
        # An unauthenticated caller learns that a lane is degraded, never where
        # a rented machine lives.
        for lane in payload.get("lanes", {}).values():
            self.assertNotIn("url", lane)

    def test_the_health_check_discloses_no_path_and_nothing_about_this_machine(self):
        # Same reasoning as the lane URLs, one step further. ``comfy`` was an
        # absolute filesystem path with the account name in it, handed to any
        # caller with no token; the version, the build flag and the accelerator
        # answers fingerprint the machine. None of that is liveness. The
        # project's norm for an unauthenticated health answer is written in
        # lib/canvas-gate.js: liveness "and nothing else — no lane list, no
        # version, no paths", and lane liveness is the argued exception.
        payload = self._health()
        for field in ("comfy", "version", "runner", "ui", "accelerator_profile", "native_mlx_ltx"):
            self.assertNotIn(
                field, payload,
                f"/health hands {field} to a caller with no token; move it into the authed branch",
            )
        rendered = json.dumps(payload)
        self.assertNotIn("/Users/", rendered)
        self.assertNotIn(str(app.config.COMFY), rendered)

    def test_the_same_answer_with_the_token_still_says_where_ComfyUI_is(self):
        # Nothing is lost, only gated: the fields moved behind the same token
        # the lane URLs are behind.
        payload = self._health("?token=sweep-token")
        self.assertEqual(payload["comfy"], str(app.config.COMFY))
        self.assertEqual(payload["version"], app.config.GATEWAY_VERSION)
        self.assertIn("accelerator_profile", payload)


if __name__ == "__main__":  # pragma: no cover - parity with the other suites here
    unittest.main()
