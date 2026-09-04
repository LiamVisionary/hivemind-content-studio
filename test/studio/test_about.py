"""The About surface: version, licence, source, notices, what's new.

The app is AGPL-3.0-or-later and had no About, no version and no licence anywhere
in the interface. These tests hold the payload that fixed that — and hold it to
the two properties that make it worth anything: it answers before sign-in, and
the commit it names is the commit that is actually checked out.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from hivemind_content_studio import about, identity


ROOT = Path(__file__).resolve().parents[2]


def _git_head() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover - no git on the box
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def test_the_commit_the_about_panel_shows_is_the_commit_that_is_checked_out() -> None:
    head = _git_head()
    if not head:  # pragma: no cover - a packaged build has no checkout
        pytest.skip("not a git checkout")
    assert identity.version_payload()["commit"] == head


def test_about_payload_carries_the_licence_the_source_and_the_notices() -> None:
    payload = about.about_payload()

    assert payload["license"] == "AGPL-3.0-or-later"
    assert payload["source_url"].startswith("https://github.com/")
    assert payload["version"] == identity.version_payload()["version"]
    assert payload["notices"]["available"] is True
    assert payload["notices"]["python"]["packages"], "the generated notices carry no Python packages"
    assert payload["notices"]["npm"], "the generated notices carry no npm packages"


def test_whats_new_reads_the_changelog_headlines_newest_first() -> None:
    entries = about.whats_new(limit=3)

    assert entries, "CHANGELOG.md produced no headlines"
    assert len(entries) <= 3
    for entry in entries:
        assert entry["date"] and entry["title"]
        # The headline, not the engineering body underneath it.
        assert "\n" not in entry["title"]
    assert [entry["date"] for entry in entries] == sorted((e["date"] for e in entries), reverse=True)


def test_a_build_without_generated_notices_still_answers(tmp_path: Path, monkeypatch) -> None:
    # A build that forgot `scripts/generate_notices.py` must degrade to "the
    # dependency list is missing", never to a 500 that takes the licence and the
    # source offer down with it.
    monkeypatch.setenv("CONTENT_STUDIO_DOCS_DIR", str(tmp_path))

    payload = about.about_payload()

    assert payload["notices"]["available"] is False
    assert payload["notices"]["python"]["packages"] == []
    assert payload["whats_new"] == []
    assert payload["license"] == "AGPL-3.0-or-later"


def test_about_route_answers_before_sign_in(tmp_path: Path, monkeypatch) -> None:
    from test_control_api import _client  # noqa: PLC0415 — the shared harness

    client, _, _ = _client(tmp_path, monkeypatch)

    response = client.get("/api/about")

    assert response.status_code == 200
    body = response.json()
    assert body["product"] == "Hivemind Content Studio"
    assert body["license"] == "AGPL-3.0-or-later"
    assert "notices" in body and "whats_new" in body
    # Nothing about the machine or the person: this route is unauthenticated.
    serialized = json.dumps(body)
    assert "/Users/" not in serialized
