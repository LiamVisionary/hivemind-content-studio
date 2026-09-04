#!/usr/bin/env python3
"""Hold `src-tauri/tauri.conf.json`'s updater block to `src-tauri/updater.json`.

The updater is the one part of the release that cannot be corrected afterwards.
An app shipped with the wrong public key or a stale endpoint can never be
updated again, and there is no channel left to reach those installs through — so
the endpoint and the key live in one file, and this script is what stops the
copy inside tauri.conf.json from drifting away from it.

It also refuses a private key in the repository. The updater's private key is
read from the signing environment under a secret *name*; a key material blob in
a tracked file is a leak, not a configuration.

    python3 scripts/check_updater_config.py                # drift + hygiene
    python3 scripts/check_updater_config.py --require-key   # also: pubkey is set

`--require-key` is the promotion gate: a build may be unsigned, but an update
that is delivered to someone else's machine may not.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPDATER_CONFIG = ROOT / "src-tauri" / "updater.json"
TAURI_CONFIG = ROOT / "src-tauri" / "tauri.conf.json"

# Anything that looks like key material rather than a name.
PRIVATE_KEY_MARKERS = ("untrusted comment: minisign secret key", "PRIVATE KEY", "RWRT")


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check(*, require_key: bool) -> list[str]:
    problems: list[str] = []
    if not UPDATER_CONFIG.is_file():
        return [
            f"{UPDATER_CONFIG.relative_to(ROOT)} is missing. It is the single source for the updater "
            "endpoint and public key; restore it from git rather than re-typing the key."
        ]

    config = _load(UPDATER_CONFIG)
    endpoints = config.get("endpoints") or []
    pubkey = (config.get("pubkey") or "").strip()
    secret_name = config.get("private_key_secret") or ""

    if not endpoints:
        problems.append(
            f"{UPDATER_CONFIG.name} names no endpoint, so an installed app has nowhere to ask about "
            "updates. Add the release host's latest.json URL."
        )
    if not secret_name:
        problems.append(
            f"{UPDATER_CONFIG.name} must name the signing secret (private_key_secret) so the release "
            "workflow knows which environment variable to read."
        )

    raw = UPDATER_CONFIG.read_text(encoding="utf-8")
    for marker in PRIVATE_KEY_MARKERS:
        if marker in raw:
            problems.append(
                f"{UPDATER_CONFIG.name} appears to contain private key material ({marker!r}). Remove it, "
                "rotate the key, and keep only the secret's name here."
            )

    if require_key and not pubkey:
        problems.append(
            f"{UPDATER_CONFIG.name} has no pubkey, so an update could not be verified by the app that "
            "receives it. Generate a key pair with `cargo tauri signer generate`, put the PUBLIC half "
            f"here, and store the private half as the {secret_name or 'TAURI_SIGNING_PRIVATE_KEY'} "
            "repository secret. Never commit the private half."
        )

    if TAURI_CONFIG.is_file():
        tauri = _load(TAURI_CONFIG)
        updater = (tauri.get("plugins") or {}).get("updater") or {}
        if not updater:
            problems.append(
                "tauri.conf.json declares no `plugins.updater`, so the shipped app would have no updater "
                f"at all. Copy the endpoints and pubkey from {UPDATER_CONFIG.name}."
            )
        else:
            if list(updater.get("endpoints") or []) != list(endpoints):
                problems.append(
                    "tauri.conf.json's updater endpoints differ from "
                    f"{UPDATER_CONFIG.name}. The shipped app asks the endpoint compiled into it, so the "
                    "two must match exactly."
                )
            if (updater.get("pubkey") or "").strip() != pubkey:
                problems.append(
                    "tauri.conf.json's updater pubkey differs from "
                    f"{UPDATER_CONFIG.name}. Whichever is wrong, an install made with it can never be "
                    "updated; fix both to the same value before building."
                )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--require-key",
        action="store_true",
        help="Fail when no public key is configured (the promotion gate).",
    )
    args = parser.parse_args(argv)

    problems = check(require_key=args.require_key)
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return 1

    config = _load(UPDATER_CONFIG)
    state = "configured" if (config.get("pubkey") or "").strip() else "no public key yet (unsigned builds only)"
    print(f"Updater: {state}; endpoint {config['endpoints'][0]}")
    if TAURI_CONFIG.is_file():
        print("tauri.conf.json agrees with src-tauri/updater.json.")
    else:
        print("src-tauri/tauri.conf.json does not exist yet; nothing to compare against.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
