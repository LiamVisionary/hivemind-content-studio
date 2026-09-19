"""What the .app actually contains, asserted without building one.

`cargo tauri build` bundles only what `bundle.resources` names. The block used to
name nothing at all, so the produced .app held the Rust shell, the boot screen,
and none of the interpreter, Node, ffmpeg, application or frontends it needs —
and every gate in the pipeline passed. These tests are the ones that would have
said so:

* every runtime the shell resolves is declared as a bundle resource, and a new
  one cannot be added to the shell without being bundled (`runtime.json` and
  `ShellConfig` are held to each other);
* the release workflow stages those resources *before* the bundle step, and
  refuses to ship the committed placeholders;
* the updater plugin is a dependency, registered, and permitted — not merely
  configured;
* the save pair every Download button needs is a dependency and permitted on the
  loopback origin the window actually loads;
* the hardened-runtime entitlements exist, and the App Sandbox is not among them.

Nothing here builds, signs, notarizes or downloads anything.
"""

from __future__ import annotations

import importlib.util
import json
import plistlib
import re
import sys
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[2]
TAURI_DIR = ROOT / "desktop" / "src-tauri"
TAURI_CONFIG = TAURI_DIR / "tauri.conf.json"
CARGO_TOML = TAURI_DIR / "Cargo.toml"
CAPABILITY = TAURI_DIR / "capabilities" / "default.json"
ENTITLEMENTS = TAURI_DIR / "Entitlements.plist"
SERVICES_RS = TAURI_DIR / "src" / "services.rs"
LIB_RS = TAURI_DIR / "src" / "lib.rs"
BUILD_WORKFLOW = ROOT / ".github" / "workflows" / "release-desktop.yml"
DOWNLOAD_MEDIA = ROOT / "packages" / "open-generative-ai" / "src" / "lib" / "downloadMedia.js"


def _module(relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # Registered before it executes: `@dataclass` under `from __future__ import
    # annotations` resolves its field types through sys.modules.
    sys.modules.setdefault(spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def staging():
    return _module("scripts/stage_desktop_resources.py")


def _config() -> dict:
    return json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))


def _macos_steps() -> list[dict]:
    document = yaml.safe_load(BUILD_WORKFLOW.read_text(encoding="utf-8"))
    return document["jobs"]["macos"]["steps"]


def _step_index(predicate) -> int:
    for index, step in enumerate(_macos_steps()):
        if predicate(step):
            return index
    return -1


# ---------------------------------------------------------------------------
# What the bundle carries
# ---------------------------------------------------------------------------


def test_the_bundle_declares_every_runtime_the_app_needs(staging) -> None:
    """A resource the config does not name is a resource the .app does not have."""
    declared = staging.declared_resources()
    assert declared, (
        "bundle.resources is empty, so the .app would contain the shell and the boot screen and "
        "nothing else."
    )
    for part in staging.PARTS:
        assert declared.get(f"resources/{part.name}") == part.name, f"{part.name} is not bundled: {part.purpose}"
    assert declared.get(f"resources/{staging.RUNTIME_NAME}") == staging.RUNTIME_NAME


def test_every_declared_resource_path_exists_in_the_checkout(staging) -> None:
    """`tauri-build` refuses to compile when one does not, so this is the shell's own gate."""
    for source in staging.declared_resources():
        assert (TAURI_DIR / source).exists(), (
            f"{source} is declared in bundle.resources but not in the tree, so `cargo test` in "
            "desktop/src-tauri cannot even compile. Run `python3 scripts/stage_desktop_resources.py "
            "--skeleton`."
        )


def test_nothing_is_declared_that_no_part_fills(staging) -> None:
    expected = {f"resources/{part.name}" for part in staging.PARTS} | {f"resources/{staging.RUNTIME_NAME}"}
    assert set(staging.declared_resources()) == expected


def test_the_three_built_frontends_are_named_one_by_one(staging) -> None:
    """A bundle with the servers and no pages is the same boot screen with extra steps."""
    required = set(staging.part("studio").required)
    assert "packages/open-generative-ai/dist/index.html" in required
    assert "packages/comfyui-mobile/dist/index.html" in required
    assert "packages/media-gateway/.next/BUILD_ID" in required
    # And the shell's window still loads the boot screen, not one of these: the
    # studio is served by the control API over loopback (docs/RELEASE.md §2.1).
    assert _config()["build"]["frontendDist"] == "splash"


def test_the_interpreter_and_the_ffmpeg_pair_ride_together(staging) -> None:
    required = set(staging.part("desktop-python").required)
    assert "venv/bin/python" in required
    assert {"bin/ffmpeg", "bin/ffprobe"} <= required
    # A dangling symlink into a build runner's interpreter is not a bundled
    # interpreter; `Path.exists()` is False for one, which is the point.
    assert staging.part("desktop-python").produced_elsewhere.startswith("scripts/build_desktop_python.py")


def test_the_licence_offer_travels_inside_the_app(staging) -> None:
    legal = staging.part("legal")
    sources = {source for source, _ in legal.sources}
    assert {"LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md", "docs/notices.json"} <= sources
    for source in sources:
        assert (ROOT / source).exists(), f"{source} is staged into the bundle but is not in the repository"


# ---------------------------------------------------------------------------
# runtime.json, and the coupling that keeps it honest
# ---------------------------------------------------------------------------


def _shell_config_fields() -> list[str]:
    body = SERVICES_RS.read_text(encoding="utf-8")
    block = re.search(r"pub struct ShellConfig \{(.*?)\n\}", body, re.S)
    assert block, "ShellConfig is no longer where this test looks for it"
    snake = re.findall(r"^\s*pub (\w+):", block.group(1), re.M)
    return ["".join(part.capitalize() if index else part for index, part in enumerate(name.split("_"))) for name in snake]


def test_every_runtime_the_shell_reads_is_written_or_deliberately_left_out(staging) -> None:
    """The gate that fails when a new runtime dependency is added and not bundled.

    Add a field to `ShellConfig` and this test fails until someone either points
    `runtime.json` at something inside the bundle or writes down why the shell's
    own default is right. That is the only mechanical link between "the shell
    looks for X" and "X is in the .app".
    """
    decided = set(staging.RUNTIME_PATHS) | set(staging.DELIBERATELY_UNSET)
    for field in _shell_config_fields():
        assert field in decided, (
            f"ShellConfig.{field} is read by the shell but runtime.json neither sets it nor records why "
            "it is left alone. Add it to RUNTIME_PATHS (and stage what it points at) or to "
            "DELIBERATELY_UNSET in scripts/stage_desktop_resources.py."
        )


def test_every_runtime_path_points_inside_a_bundled_part(staging) -> None:
    parts = {part.name for part in staging.PARTS}
    for key, value in staging.RUNTIME_PATHS.items():
        for path in value if isinstance(value, list) else [value]:
            assert not Path(path).is_absolute(), f"runtime.json's {key} would only work on the build machine"
            assert path.split("/")[0] in parts, f"runtime.json's {key} points outside the bundle: {path}"


def test_the_committed_runtime_json_names_nothing_so_a_checkout_keeps_its_own_paths(staging) -> None:
    runtime = json.loads((staging.RESOURCES / staging.RUNTIME_NAME).read_text(encoding="utf-8"))
    assert runtime["staged"] is False
    for key in staging.RUNTIME_PATHS:
        assert key not in runtime, (
            f"the placeholder runtime.json names {key}, which would send `cargo tauri dev` looking for a "
            "bundle that a checkout does not have"
        )


def test_verify_refuses_the_placeholders_it_ships_with(staging) -> None:
    """The build-time gate, exercised on the state the repository is actually in."""
    with pytest.raises(staging.StagingError) as failure:
        staging.verify()
    message = str(failure.value)
    for part in staging.PARTS:
        assert part.name in message
        assert part.purpose.split(".")[0] in message, "a refusal must say what is missing, not just that something is"


def test_staging_copies_the_parts_and_writes_absolute_free_runtime_paths(staging, tmp_path, monkeypatch) -> None:
    """The staging itself, on a miniature checkout rather than the real one.

    The real run copies gigabytes; the mechanics are the same. What matters here
    is that a part with a missing build output is refused rather than staged
    hollow, and that runtime.json comes out with paths that mean something on a
    machine other than the one that built it.
    """
    checkout = tmp_path / "checkout"
    (checkout / "dist").mkdir(parents=True)
    (checkout / "LICENSE").write_text("AGPL", encoding="utf-8")
    node = tmp_path / "node-binary"
    node.write_bytes(b"#!/bin/sh\n")

    resources = tmp_path / "resources"
    tauri_dir = tmp_path / "src-tauri"
    tauri_dir.mkdir()
    (tauri_dir / "tauri.conf.json").write_text(
        json.dumps(
            {
                "bundle": {
                    "resources": {
                        "resources/runtime.json": "runtime.json",
                        "resources/node": "node",
                        "resources/studio": "studio",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    parts = (
        staging.Part(name="node", purpose="The Node binary.", required=("node",)),
        staging.Part(
            name="studio",
            purpose="The application.",
            sources=(("LICENSE", "LICENSE"), ("dist", "dist")),
            required=("LICENSE", "dist/index.html"),
        ),
    )
    monkeypatch.setattr(staging, "ROOT", checkout)
    monkeypatch.setattr(staging, "RESOURCES", resources)
    monkeypatch.setattr(staging, "TAURI_DIR", tauri_dir)
    monkeypatch.setattr(staging, "PARTS", parts)
    monkeypatch.setattr(staging, "RUNTIME_PATHS", {"node": "node/node", "frontendDist": "studio/dist"})

    # The frontend was never built, so the bundle would carry an empty dist.
    with pytest.raises(staging.StagingError, match="dist/index.html"):
        staging.stage(node_binary=node)

    (checkout / "dist" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    staging.stage(node_binary=node)

    assert (resources / "studio" / "dist" / "index.html").is_file()
    assert (resources / "node" / "node").stat().st_mode & 0o111, "the bundled Node must stay executable"
    runtime = json.loads((resources / "runtime.json").read_text(encoding="utf-8"))
    assert runtime["staged"] is True
    assert runtime["node"] == "node/node"
    assert not any(str(value).startswith("/") for value in runtime.values() if isinstance(value, str))


def test_the_workflow_stages_the_resources_before_it_bundles() -> None:
    staged = _step_index(lambda step: "stage_desktop_resources.py --node" in (step.get("run") or ""))
    verified = _step_index(lambda step: "stage_desktop_resources.py --verify" in (step.get("run") or ""))
    bundled = _step_index(lambda step: str(step.get("uses", "")).startswith("tauri-apps/tauri-action"))
    frozen = _step_index(lambda step: "build_desktop_python.py" in (step.get("run") or ""))
    assert staged > 0, "nothing in the release workflow assembles the bundle resources"
    assert frozen < staged, "the frozen Python must exist before the resources are verified"
    assert staged < verified < bundled, "resources staged after the bundle step are not in the bundle"


# ---------------------------------------------------------------------------
# The updater: configured is not the same as present
# ---------------------------------------------------------------------------


def test_the_updater_plugin_is_a_dependency_registered_and_permitted() -> None:
    assert "tauri-plugin-updater" in CARGO_TOML.read_text(encoding="utf-8")
    assert "tauri_plugin_updater" in LIB_RS.read_text(encoding="utf-8")
    permissions = json.loads(CAPABILITY.read_text(encoding="utf-8"))["permissions"]
    assert "updater:default" in permissions


def test_the_updater_check_fails_when_the_plugin_is_only_configured(tmp_path: Path) -> None:
    """A gate that passes on a plugin that is not there is worse than no gate."""
    checker = _module("scripts/check_updater_config.py")
    assert checker.check(require_key=False) == []

    # The state the repository was in: an endpoint, a pubkey slot, and no plugin.
    checker.CARGO_TOML = tmp_path / "Cargo.toml"
    checker.CARGO_TOML.write_text('[dependencies]\ntauri = { version = "2" }\n', encoding="utf-8")
    checker.SHELL_LIB = tmp_path / "lib.rs"
    checker.SHELL_LIB.write_text("tauri::Builder::default().plugin(tauri_plugin_opener::init());\n", encoding="utf-8")
    checker.CAPABILITIES = tmp_path / "capabilities"
    checker.CAPABILITIES.mkdir()
    (checker.CAPABILITIES / "default.json").write_text(json.dumps({"permissions": ["core:default"]}), encoding="utf-8")

    problems = checker.check(require_key=False)
    assert any("does not depend on tauri-plugin-updater" in problem for problem in problems)
    assert any("never registered" in problem for problem in problems)
    assert any("updater:" in problem and "capability" in problem for problem in problems)


# ---------------------------------------------------------------------------
# Download: the save pair, and the origin it has to reach
# ---------------------------------------------------------------------------


def test_the_shell_carries_the_save_pair_every_download_button_needs() -> None:
    """Without these, saveBytes' anchor branch returns ok and writes no file."""
    cargo = CARGO_TOML.read_text(encoding="utf-8")
    assert "tauri-plugin-dialog" in cargo
    assert "tauri-plugin-fs" in cargo
    registered = LIB_RS.read_text(encoding="utf-8")
    assert "tauri_plugin_dialog::init()" in registered
    assert "tauri_plugin_fs::init()" in registered
    # The branch reads the plugin APIs off the global rather than importing
    # @tauri-apps/api, because the same bundle is served to browsers too.
    assert _config()["app"]["withGlobalTauri"] is True


def test_the_capability_grants_exactly_what_saving_a_file_takes() -> None:
    capability = json.loads(CAPABILITY.read_text(encoding="utf-8"))
    permissions = capability["permissions"]
    assert "dialog:allow-save" in permissions
    assert "fs:allow-write-file" in permissions
    # The user picks the path in a native sheet; the app never enumerates, reads
    # or writes a directory of its own, so anything wider is more authority than
    # the feature needs.
    for permission in permissions:
        name = permission if isinstance(permission, str) else permission.get("identifier", "")
        assert not name.startswith("fs:allow-read"), f"{name} is more than saving a file takes"
        assert not name.startswith("fs:scope"), f"{name} grants a directory the save sheet did not"
        assert not name.startswith("dialog:allow-open"), f"{name} is more than saving a file takes"


def test_the_capability_reaches_the_loopback_origin_the_window_loads() -> None:
    """The window loads http://127.0.0.1:<port>, which the ACL treats as remote.

    Without a `remote` block the IPC is denied on the studio page and every
    Download silently falls through to the anchor branch. `ports.rs` proves the
    literal matches every port the shell can choose.
    """
    remote = json.loads(CAPABILITY.read_text(encoding="utf-8")).get("remote") or {}
    assert remote.get("urls"), "the studio page would get no IPC at all"
    for url in remote["urls"]:
        assert url.startswith("http://127.0.0.1"), f"{url} is wider than loopback"


def test_the_save_branch_uses_the_two_plugin_apis_the_capability_grants() -> None:
    """If saveBytes reaches for a third plugin API, the capability has to grow."""
    source = DOWNLOAD_MEDIA.read_text(encoding="utf-8")
    assert "window.__TAURI__" in source
    used = set(re.findall(r"tauri\?\.(\w+)\?\.(\w+)", source))
    assert used == {("dialog", "save"), ("fs", "writeFile")}, (
        f"saveBytes now uses {sorted(used)}; grant the matching permissions in capabilities/default.json "
        "or the new call is denied in the packaged app."
    )


# ---------------------------------------------------------------------------
# Signing: the entitlements, and the one that must never appear
# ---------------------------------------------------------------------------


def test_the_hardened_runtime_entitlements_exist_and_are_pointed_at() -> None:
    assert _config()["bundle"]["macOS"]["entitlements"] == "Entitlements.plist"
    assert ENTITLEMENTS.is_file()
    entitlements = plistlib.loads(ENTITLEMENTS.read_bytes())
    assert set(entitlements) == {
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
    }
    assert all(value is True for value in entitlements.values())


def test_the_app_sandbox_stays_absent() -> None:
    """PassBook refuses a sandboxed HOME: the shared credential store is at
    ~/.hivemindos/.env, and under the sandbox that resolves to a per-app
    container where every key reports absent (docs/RELEASE.md §2.3)."""
    entitlements = plistlib.loads(ENTITLEMENTS.read_bytes())
    assert "com.apple.security.app-sandbox" not in entitlements
    # And the file says why, so the next person does not add it back.
    text = ENTITLEMENTS.read_text(encoding="utf-8")
    assert "app-sandbox" in text and "PassBook" in text
