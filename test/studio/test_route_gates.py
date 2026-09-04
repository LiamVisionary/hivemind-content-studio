"""Every route the control API actually declares, swept for its gate.

The suite already had gate tests, and every one of them was a hand-written list
of paths — test_restore_api's ten restore routes, test_private_access's handful.
A list drifts: a route added tomorrow is in no list, so no test asks anything
about it, and 24 of the API's routes were in that position when this file was
written (all ten /api/passbook/*, both money routes, the SAM3 trio).

So the list comes from the app object. `app.routes` is what FastAPI will serve;
this walks it, calls every method of every route with no session at all, and
requires each one either to be named in PUBLIC below — with a reason — or to
refuse. Adding a route without a gate fails here on the day it is added.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from starlette.routing import Mount, Route

from hivemind_content_studio.approval_ledger import ApprovalLedger
from hivemind_content_studio.control_api import build_control_app
from hivemind_content_studio.orchestrator import ContentOrchestrator
from hivemind_content_studio.private_access import OwnerAccess, PrivateFieldCipher
from hivemind_content_studio.run_store import RunStore

# Routes reachable with no session, each with the reason it has to be.
#
# Whole-path entries are public for every method; a (method, path) pair is
# public for that method alone. Anything not here must refuse.
PUBLIC_PATHS = {
    # Liveness. The shell that launches this process polls both before anyone
    # has signed in, and neither says anything an unlocked studio does not.
    "/healthz",
    "/readyz",
    # The sign-in doors themselves, including first-run setup and the two
    # forgotten-password routes (throttled exactly like unlock, and neither
    # hands out the passphrase-wrapped master key).
    "/api/accounts",
    "/api/accounts/setup",
    "/api/accounts/unlock",
    "/api/accounts/recovery/challenge",
    "/api/accounts/recovery/reset",
    "/api/accounts/webauthn/authenticate/options",
    "/api/accounts/webauthn/authenticate",
    # Whether this browser is signed in, and signing out. Both must answer
    # before there is a session — that is what they are for.
    "/api/owner/session",
    "/api/owner/lock",
    # The HivemindOS app completing a link the owner started here: it has no
    # studio session and cannot be given one. Guarded by a single-use nonce
    # this studio minted minutes ago for a link the owner asked for.
    "/api/hivemindos/models/link-callback",
    # One file the owner staged for a Civitai post, fetched by civitai.com's
    # composer from the BROWSER — cross-origin, so it carries no cookie of
    # ours. The unguessable staging token stands in for the session.
    "/civitai/staged/{token}/{filename}",
}

# The five GETs `_machine_route_allowed` opens for agents and the MCP, which
# reach the studio with no browser session. Pinned exactly, so a sixth cannot
# join them quietly: today the middleware admits these on the PATH alone — the
# bearer token it describes decides whose workspace they resolve to, not
# whether they are answered — so anything that can reach 127.0.0.1:8765 can
# read them.
MACHINE_LANE = {
    ("GET", "/api/catalog"),
    ("GET", "/api/providers"),
    ("GET", "/api/runtime"),
    ("GET", "/api/runs"),
    ("GET", "/api/telemetry/generations"),
}

# The frontend. The gate middleware answers these itself: an unauthenticated
# GET for a page gets the standalone sign-in page (200, and deliberately NOT
# the app shell), everything else 401s.
PUBLIC_FRONTEND = {"/"}

# Placeholder for a path parameter. Deliberately a value nothing can resolve:
# the assertion is about the gate, which runs long before a lookup.
PROBE = "gate-probe"


def _locked_client(tmp_path: Path, monkeypatch) -> tuple[TestClient, object]:
    monkeypatch.setenv("CONTENT_STUDIO_RUNS_DIR", str(tmp_path / "runs"))
    cipher = PrivateFieldCipher.from_secret(b"test-private-state-secret")
    app = build_control_app(
        orchestrator=ContentOrchestrator(RunStore(tmp_path / "state.sqlite3")),
        approvals=ApprovalLedger(
            tmp_path / "approvals.sqlite3", signing_secret="s" * 64, operator_token="operator-secret"),
        control_token="control-secret",
        operator_token="operator-secret",
        owner_access=OwnerAccess.for_testing(password="test-owner-password", cipher=cipher),
        private_cipher=cipher,
    )
    return TestClient(app), app


def _fill(path: str) -> str:
    """`/api/runs/{run_id}` → `/api/runs/gate-probe`."""
    return re.sub(r"\{[^}]+\}", PROBE, path)


def _declared_routes(app) -> list[tuple[str, str]]:
    """(method, path template) for everything the app will serve."""
    found: list[tuple[str, str]] = []
    for route in app.routes:
        if isinstance(route, Mount):
            # A mount (the /assets bundle) has no methods of its own; it is
            # probed as a path below.
            found.append(("GET", route.path + "/" + PROBE))
            continue
        if not isinstance(route, (APIRoute, Route)):
            continue
        for method in sorted(set(route.methods or []) - {"HEAD", "OPTIONS"}):
            found.append((method, route.path))
    return found


def test_the_sweep_actually_sees_the_api(tmp_path: Path, monkeypatch) -> None:
    """The guard on the guard: a sweep that enumerates nothing passes silently."""
    _, app = _locked_client(tmp_path, monkeypatch)
    routes = _declared_routes(app)
    assert len(routes) > 120, f"expected the control API's routes, saw {len(routes)}"
    paths = {path for _, path in routes}
    for expected in ("/api/runs", "/api/settings", "/api/accounts/unlock"):
        assert expected in paths, f"the sweep did not see {expected}"


def test_every_control_route_is_public_on_purpose_or_refuses_a_stranger(tmp_path: Path, monkeypatch) -> None:
    client, app = _locked_client(tmp_path, monkeypatch)
    ungated: list[str] = []
    for method, path in _declared_routes(app):
        if path in PUBLIC_PATHS or path in PUBLIC_FRONTEND or (method, path) in MACHINE_LANE:
            continue
        response = client.request(method, _fill(path), json={} if method != "GET" else None)
        # 401/403 is the gate. 404/405 means there is nothing there to reach,
        # which is equally not a leak. Anything else answered a stranger.
        if response.status_code not in (401, 403, 404, 405):
            ungated.append(f"{method} {path} answered {response.status_code}")
    assert ungated == [], (
        "these routes answered an unauthenticated request. Gate them, or add the path to "
        "PUBLIC_PATHS in this file with the reason it must be reachable:\n  " + "\n  ".join(ungated)
    )


def test_the_machine_lane_is_exactly_these_five_reads(tmp_path: Path, monkeypatch) -> None:
    """What a caller with no session and no token can read, named one by one.

    These are reads an agent on this machine makes without a browser session.
    The point of pinning them is that the list cannot grow by accident: a route
    added to `_machine_route_allowed` fails here until someone writes down why
    a stranger on this port may read it.
    """
    client, _ = _locked_client(tmp_path, monkeypatch)
    answered = {
        (method, path)
        for method, path in MACHINE_LANE
        if client.request(method, path).status_code == 200
    }
    assert answered == MACHINE_LANE, f"the machine lane moved: {sorted(MACHINE_LANE ^ answered)}"


def test_the_public_list_names_only_routes_that_still_exist(tmp_path: Path, monkeypatch) -> None:
    """A public exemption for a deleted route is an exemption nobody notices."""
    _, app = _locked_client(tmp_path, monkeypatch)
    declared = {path for _, path in _declared_routes(app)}
    stale = sorted(
        path for path in PUBLIC_PATHS | PUBLIC_FRONTEND | {path for _, path in MACHINE_LANE}
        if path not in declared
    )
    assert stale == [], f"PUBLIC lists routes the app no longer serves: {stale}"


def test_the_sweep_fails_when_a_route_is_let_through(tmp_path: Path, monkeypatch) -> None:
    """Prove the sweep can fail, by opening the gate the way a mistake would.

    The realistic way a route goes ungated here is not a forgotten dependency —
    the middleware refuses everything by default — it is someone widening
    `_machine_route_allowed` for one caller and taking a neighbour with it. So
    that is what this simulates, and the sweep has to notice.
    """
    from hivemind_content_studio import control_api

    real = control_api._machine_route_allowed
    monkeypatch.setattr(
        control_api,
        "_machine_route_allowed",
        lambda path, method: real(path, method) or path == "/api/about",
    )
    client, app = _locked_client(tmp_path, monkeypatch)
    leaked = [
        f"{method} {path}"
        for method, path in _declared_routes(app)
        if path not in PUBLIC_PATHS and path not in PUBLIC_FRONTEND and (method, path) not in MACHINE_LANE
        and client.request(method, _fill(path), json={} if method != "GET" else None).status_code
        not in (401, 403, 404, 405)
    ]
    assert leaked == ["GET /api/about"], f"the sweep missed a route that was let through: {leaked}"


def test_an_unauthenticated_page_request_gets_the_sign_in_page_not_the_app(tmp_path: Path, monkeypatch) -> None:
    client, _ = _locked_client(tmp_path, monkeypatch)
    page = client.get("/", headers={"accept": "text/html"})
    assert page.status_code == 200
    assert "Who's working?" in page.text
    # The app bundle lives under the gated /assets, so a shell served here
    # would load a script that 401s and render nothing.
    assert "/assets/index" not in page.text
