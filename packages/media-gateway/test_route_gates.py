"""Every path the gateway answers, swept for its token gate.

The gateway is not a framework app — there is no `app.routes` to read — so the
route list is recovered the only way that cannot drift: from the handler's own
syntax tree. `do_GET`, `do_POST` and `do_DELETE` are parsed, every path literal
each one compares against is collected, and each is then requested over a real
socket with no token at all.

Two things are asserted, and the second is the one that matters. First, that a
path answers 401 unless it is named PUBLIC below with a reason. Second, that
the gate is where it must be: everything a method compares AFTER its
`self.authed(...)` check is gated by construction, so the sweep also records
which paths are reachable BEFORE it, and that set has to stay exactly the
health checks. A path handled above the guard is how a gateway leaks — it does
not look like a missing check, it looks like an early return.
"""

from __future__ import annotations

import ast
import json
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app

APP_SOURCE = Path(__file__).resolve().parent / "app.py"

# Reachable without the token, and why.
#
# The two health names are one endpoint. It answers before the gate because the
# supervisor, the MCP status tool and the studio's catalog all poll it before
# anybody has a token — and it is written to say only that this process is up
# and which lanes are degraded. The lane URLs (where a rented machine lives)
# stay behind the gate inside that same handler.
PUBLIC = {"/healthz", "/health"}


def _handler_methods() -> dict[str, ast.FunctionDef]:
    tree = ast.parse(APP_SOURCE.read_text(encoding="utf-8"))
    handler = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.ClassDef) and node.name == "Handler"
    )
    return {
        node.name: node
        for node in handler.body
        if isinstance(node, ast.FunctionDef) and node.name in {"do_GET", "do_POST", "do_DELETE"}
    }


def _is_parsed_path(node: ast.AST) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "path"
        and isinstance(node.value, ast.Name)
        and node.value.id == "parsed"
    )


def _paths_in(node: ast.AST) -> set[str]:
    """Every literal this subtree matches `parsed.path` against.

    Covers the three shapes the handler uses: `parsed.path == "/x"`,
    `parsed.path in ["/x", "/y"]` and `parsed.path.startswith("/x/")`.
    """
    found: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Compare) and _is_parsed_path(child.left):
            for comparator in child.comparators:
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    found.add(comparator.value)
                elif isinstance(comparator, (ast.List, ast.Tuple, ast.Set)):
                    found.update(
                        element.value for element in comparator.elts
                        if isinstance(element, ast.Constant) and isinstance(element.value, str)
                    )
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr in {"startswith", "endswith"}
            and _is_parsed_path(child.func.value)
        ):
            found.update(
                argument.value for argument in child.args
                if isinstance(argument, ast.Constant) and isinstance(argument.value, str)
            )
    return found


def _guard_index(method: ast.FunctionDef) -> int:
    """Where `if not self.authed(...)` sits in the method body."""
    for index, statement in enumerate(method.body):
        if not isinstance(statement, ast.If):
            continue
        for child in ast.walk(statement.test):
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute) and child.func.attr == "authed":
                return index
    raise AssertionError(f"{method.name} has no self.authed(...) guard at all")


class RouteGates(unittest.TestCase):
    """The gateway's own routes, read out of its handler and then requested."""

    def test_the_sweep_reads_real_routes_out_of_the_handler(self):
        methods = _handler_methods()
        self.assertEqual(set(methods), {"do_GET", "do_POST", "do_DELETE"})
        paths = {path for method in methods.values() for path in _paths_in(method)}
        self.assertGreater(len(paths), 40, f"expected the gateway's paths, saw {len(paths)}")
        for expected in ("/healthz", "/api/generate", "/api/delete-output"):
            self.assertIn(expected, paths, f"the sweep did not see {expected}")

    def test_nothing_but_the_health_check_is_handled_before_the_token_gate(self):
        for name, method in _handler_methods().items():
            guard = _guard_index(method)
            before: set[str] = set()
            for statement in method.body[:guard]:
                before |= _paths_in(statement)
            self.assertLessEqual(
                before, PUBLIC,
                f"{name} answers {sorted(before - PUBLIC)} before checking the token. "
                "A path handled above the guard is not gated at all — move it below, "
                "or add it to PUBLIC in this file with the reason it must answer.",
            )

    def test_every_gateway_path_refuses_a_request_with_no_token(self):
        # A real socket on an ephemeral port, torn down in the same test: the
        # gate lives in the handler, so nothing short of an actual request
        # exercises it.
        methods = _handler_methods()
        probes = sorted(
            {path for method in methods.values() for path in _paths_in(method) if path.startswith("/")}
            - PUBLIC
        )
        self.assertGreater(len(probes), 40)

        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        answered = []
        with patch.object(app, "TOKEN", "sweep-token"):
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

    def test_the_health_check_answers_without_a_token_but_hides_the_lane_urls(self):
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        with patch.object(app, "TOKEN", "sweep-token"):
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                with urlopen(base + "/healthz", timeout=5) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
        self.assertTrue(payload["ok"])
        # An unauthenticated caller learns that a lane is degraded, never where
        # a rented machine lives.
        for lane in payload.get("lanes", {}).values():
            self.assertNotIn("url", lane)


if __name__ == "__main__":  # pragma: no cover - parity with the other suites here
    unittest.main()
