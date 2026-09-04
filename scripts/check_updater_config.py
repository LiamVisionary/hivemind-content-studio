#!/usr/bin/env python3
"""Hold `desktop/src-tauri/tauri.conf.json`'s updater block to `desktop/src-tauri/updater.json`.

The updater is the one part of the release that cannot be corrected afterwards.
An app shipped with the wrong public key or a stale endpoint can never be
updated again, and there is no channel left to reach those installs through — so
the endpoint and the key live in one file, and this script is what stops the
copy inside tauri.conf.json from drifting away from it.

It also refuses a private key in the repository. The updater's private key is
read from the signing environment under a secret *name*; a key material blob in
a tracked file is a leak, not a configuration.

And it asserts that the plugin the configuration describes is actually in the
build. `plugins.updater` used to be declared while `tauri-plugin-updater` was
not a dependency, `lib.rs` registered only the opener plugin and no capability
granted an `updater:` permission — so this script reported that everything
agreed about an update channel that reached nobody. A gate that passes on a
plugin that is not there is worse than no gate.

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
UPDATER_CONFIG = ROOT / "desktop" / "src-tauri" / "updater.json"
TAURI_CONFIG = ROOT / "desktop" / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT / "desktop" / "src-tauri" / "Cargo.toml"
SHELL_LIB = ROOT / "desktop" / "src-tauri" / "src" / "lib.rs"
CAPABILITIES = ROOT / "desktop" / "src-tauri" / "capabilities"

# The three things that have to be true for a promoted latest.json to reach an
# installed app, none of which the two JSON files can tell you.
PLUGIN_CRATE = "tauri-plugin-updater"
PLUGIN_INIT = "tauri_plugin_updater"
PLUGIN_PERMISSION = "updater:"

# Anything that looks like key material rather than a name.
PRIVATE_KEY_MARKERS = ("untrusted comment: minisign secret key", "PRIVATE KEY", "RWRT")


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _plugin_problems(configured: bool) -> list[str]:
    """The updater config is a promise; these three make the shipped app keep it.

    Checked whether or not the updater is configured, because the failure runs
    both ways: a config with no plugin is a dead channel that every other gate
    calls healthy, and a plugin with no config is dead weight in the binary.
    """
    problems: list[str] = []

    cargo = CARGO_TOML.read_text(encoding="utf-8") if CARGO_TOML.is_file() else ""
    declared = any(
        line.split("=")[0].strip().strip('"') == PLUGIN_CRATE
        for line in cargo.splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    registered = PLUGIN_INIT in (SHELL_LIB.read_text(encoding="utf-8") if SHELL_LIB.is_file() else "")
    granted = []
    if CAPABILITIES.is_dir():
        for path in sorted(CAPABILITIES.glob("*.json")):
            capability = _load(path)
            for permission in capability.get("permissions") or []:
                name = permission if isinstance(permission, str) else permission.get("identifier", "")
                if name.startswith(PLUGIN_PERMISSION):
                    granted.append(f"{path.name}:{name}")

    if not configured:
        if declared or registered or granted:
            problems.append(
                f"{PLUGIN_CRATE} is in the build but tauri.conf.json declares no `plugins.updater`, so the "
                "plugin has no endpoint to ask. Configure it or drop the dependency."
            )
        return problems

    if not declared:
        problems.append(
            f"tauri.conf.json configures the updater but {CARGO_TOML.name} does not depend on "
            f"{PLUGIN_CRATE}, so the shipped app has no updater in it. A promoted latest.json would "
            "reach nobody, and nothing else in this pipeline would say so."
        )
    if not registered:
        problems.append(
            f"{PLUGIN_INIT} is never registered in src/lib.rs. A plugin that is a dependency and not a "
            "`.plugin(...)` line is compiled in and never runs."
        )
    if not granted:
        problems.append(
            "No capability grants an `updater:` permission, so the update check would be denied by the "
            "capability system. Add `updater:default` to desktop/src-tauri/capabilities/default.json."
        )
    return problems


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
        problems.extend(_plugin_problems(bool(updater)))
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
        print("tauri.conf.json agrees with desktop/src-tauri/updater.json.")
        print(f"{PLUGIN_CRATE}: a dependency, registered in lib.rs, and granted an `updater:` permission.")
    else:
        print("desktop/src-tauri/tauri.conf.json does not exist yet; nothing to compare against.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
