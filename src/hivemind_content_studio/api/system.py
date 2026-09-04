"""What this machine is doing: runtime, doctor, diagnostics, version, providers.

Moved out of control_api.py unchanged (2026-09-04).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from ..about import about_payload
from ..doctor import collect_report as doctor_report
from ..generation_telemetry import generation_telemetry_snapshot
from ..identity import version_payload
from ..media_studio import sanitize_error_detail
from ..observability import diagnostics_bundle
from ..providers import provider_report


def register(app, ctx) -> None:
    """Register the runtime, doctor, diagnostics, version, about and provider routes."""
    router = APIRouter()
    cp = ctx.control_api
    app_version = ctx.app_version
    require_owner = ctx.require_owner
    runs = ctx.runs

    @router.get("/api/telemetry/generations")
    def generation_telemetry(limit: int = 100) -> dict:
        return generation_telemetry_snapshot(runs.store, limit=limit)

    # `unified_runtime_snapshot()` probes all three engines live, each with a
    # 1.5s ceiling, and this is a POLLED route — the supervisor asks it for
    # readiness and the shell's status views ask it too, so several callers a
    # second could each pay three probes for an answer that cannot have changed.
    # Same {payload, at} shape as the catalog cache above.
    runtime_cache: dict[str, Any] = {"payload": None, "at": 0.0}
    RUNTIME_TTL_SECONDS = 5.0

    @router.get("/api/runtime")
    def runtime() -> dict:
        # The build number rides along so a bug report names one: this is the
        # route the supervisor and the shell already poll.
        cached = runtime_cache["payload"]
        if cached is None or time.time() - runtime_cache["at"] > RUNTIME_TTL_SECONDS:
            cached = cp.unified_runtime_snapshot()
            runtime_cache.update(payload=cached, at=time.time())
        return {**cached, "version": app_version}

    @router.get("/api/doctor", dependencies=[Depends(require_owner)])
    def doctor() -> dict:
        """One answer to "what is this machine, and what can it run?".

        The CLI's `content-studio doctor` checks, the live engine snapshot and
        this box's hardware, merged — because the Models page has to put a
        hardware-fit line on every card ("fits your 36 GB Mac" / "needs a
        rented GPU") and asking three routes for it would be three round trips
        and three different moments in time.

        Owner-gated and secret-free by construction: every part of it reports
        whether something is PRESENT (a binary on PATH, a key configured, a
        port answering), never what it holds. `doctor.collect_report` builds to
        a deadline so a hung probe cannot hold the page.
        """
        # `ok` is the doctor's own verdict, not "the request worked" — a machine
        # missing ffmpeg answers 200 and says so.
        return {**doctor_report(), "version": app_version}

    @router.get("/api/diagnostics/bundle", dependencies=[Depends(require_owner)])
    def diagnostics_zip() -> Response:
        """One file the owner can attach to a report, by hand.

        Nothing leaves the machine on its own — this is an owner-run,
        local-first app, and a button that transmitted a log would be data
        leaving without being asked for. The log tail, the runtime snapshot
        and the health answer, with private paths reduced to basenames.
        """
        health: dict[str, Any] = {"ok": True, "service": "hivemind-content-studio", "owner_lock": True}
        try:
            snapshot: Any = cp.unified_runtime_snapshot()
        except Exception as exc:  # noqa: BLE001 — a bundle is worth more than its runtime page
            snapshot = {"error": sanitize_error_detail(str(exc)) or "runtime snapshot unavailable"}
        return Response(
            content=diagnostics_bundle(snapshot, health),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="studio-diagnostics.zip"'},
        )

    @router.get("/api/version")
    def version() -> dict:
        # Unauthenticated on purpose: the About panel and the AGPL's "offer the
        # source" obligation both need this before anyone signs in, and the
        # payload is the product's own name, tag and source URL — nothing about
        # the machine it runs on.
        return version_payload()

    @router.get("/api/about")
    def about() -> dict:
        # Unauthenticated for the same reason /api/version is: the licence, the
        # source offer and the third-party notices are what the AGPL requires an
        # interactive program to show, and requiring a sign-in to read them would
        # defeat the point. It adds the generated dependency notices and the
        # recent changelog headlines to the same payload so the About page is one
        # request rather than three.
        return about_payload()

    @router.get("/api/providers")
    def providers() -> dict:
        return {"ok": True, "providers": provider_report()}

    app.include_router(router)
