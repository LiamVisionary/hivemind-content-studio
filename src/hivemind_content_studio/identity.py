"""The product's identity, in one place.

Before this module the shipped shell carried the donor's name: an electron
bundle id of `ai.generative.open`, a window titled "Open Generative AI", crash
dialogs that named a different product than the window, and a support folder at
`~/Library/Application Support/open-generative-ai`. Those strings are what macOS
and the user see, so they cannot be spread across four files that drift.

Everything that needs to name the product reads it from here:

* `unified_runtime.py` — the product row of the source-provenance catalog.
* `control_api.py` — `GET /api/version`.
* `packages/open-generative-ai/electron/identity.json` — generated from this
  module (`python -m hivemind_content_studio.identity --write`) and required by
  `electron/main.js`, `hosted-server.js` and `electron-builder.config.cjs`, so
  the JavaScript side has no second copy of the bundle id to forget.

`test/studio/test_identity.py` fails if the generated JSON drifts from these
constants, or if the bundle id is typed anywhere else in the tree.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from functools import lru_cache
from pathlib import Path

from . import __version__

PRODUCT_NAME = "Hivemind Content Studio"
BUNDLE_ID = "ai.hivemindos.content-studio"
COPYRIGHT_HOLDER = "LiamVisionary"
COPYRIGHT = f"Copyright © 2026 {COPYRIGHT_HOLDER}"
# The per-user folder the desktop shell owns. On macOS it is a directory under
# ~/Library/Application Support; the JS side joins the platform prefix itself.
SUPPORT_DIR_NAME = "Hivemind Content Studio"
# The folder the Electron shell used before this module existed. Kept so the
# bridge can keep serving a model a user already downloaded instead of asking
# them to fetch it again.
LEGACY_SUPPORT_DIR_NAME = "open-generative-ai"
SOURCE_URL = "https://github.com/LiamVisionary/hivemind-content-studio"
LICENSE = "AGPL-3.0-or-later"
MAINTAINER = "LiamVisionary <vibe@withami.ai>"

# Written by the release build next to the package so a shipped app can answer
# /api/version without a git checkout.
BUILD_INFO_FILENAME = "build-info.json"

IDENTITY_JSON_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "open-generative-ai"
    / "electron"
    / "identity.json"
)


def identity() -> dict[str, str]:
    """The naming facts, with no build- or checkout-dependent fields."""
    return {
        "productName": PRODUCT_NAME,
        "bundleId": BUNDLE_ID,
        "copyright": COPYRIGHT,
        "copyrightHolder": COPYRIGHT_HOLDER,
        "supportDirName": SUPPORT_DIR_NAME,
        "legacySupportDirName": LEGACY_SUPPORT_DIR_NAME,
        "sourceUrl": SOURCE_URL,
        "license": LICENSE,
        "maintainer": MAINTAINER,
    }


def _build_info() -> dict[str, str]:
    path = Path(__file__).resolve().parent / BUILD_INFO_FILENAME
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {str(key): str(value) for key, value in loaded.items() if isinstance(loaded, dict)}


def _git(*args: str) -> str | None:
    """Best-effort git read. A packaged app has no checkout; that is not an error."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = result.stdout.strip()
    return value if result.returncode == 0 and value else None


@lru_cache(maxsize=1)
def build_stamp() -> dict[str, str | None]:
    """Commit and build date, whichever of the three sources answers first."""
    info = _build_info()
    commit = os.environ.get("CONTENT_STUDIO_COMMIT", "").strip() or info.get("commit") or _git("rev-parse", "HEAD")
    build_date = (
        os.environ.get("CONTENT_STUDIO_BUILD_DATE", "").strip()
        or info.get("build_date")
        or _git("log", "-1", "--format=%cI")
    )
    return {"commit": commit, "build_date": build_date}


def version_payload() -> dict[str, str | None]:
    """The body of GET /api/version. No secrets, no paths, no machine names."""
    stamp = build_stamp()
    return {
        "product": PRODUCT_NAME,
        "version": __version__,
        "commit": stamp["commit"],
        "license": LICENSE,
        "source_url": SOURCE_URL,
        "build_date": stamp["build_date"],
    }


def render_identity_json() -> str:
    payload = {
        "_generated": "python -m hivemind_content_studio.identity --write",
        "_source": "src/hivemind_content_studio/identity.py",
        **identity(),
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Print or regenerate the shared identity JSON.")
    parser.add_argument("--write", action="store_true", help="write packages/open-generative-ai/electron/identity.json")
    args = parser.parse_args(argv)
    rendered = render_identity_json()
    if args.write:
        IDENTITY_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
        IDENTITY_JSON_PATH.write_text(rendered, encoding="utf-8")
        print(f"wrote {IDENTITY_JSON_PATH}")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":  # pragma: no cover - module entry point
    raise SystemExit(main())
