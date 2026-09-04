"""The release pipeline's promises, asserted where they can be.

Nothing here builds, signs or publishes anything. These tests hold the four
properties that make the pipeline safe to leave in the repository unsigned:

* it cannot run by accident (dispatch only, never on a push),
* it uses the Rust Tauri CLI at a project path that actually exists here,
* it skips signing cleanly and says so on the artifact rather than pretending,
* and the updater's private key is a secret *name*, never a value.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
BUILD_WORKFLOW = WORKFLOWS / "release-desktop.yml"
PROMOTE_WORKFLOW = WORKFLOWS / "release-desktop-promote.yml"


def _load_workflow(path: Path) -> dict:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    # PyYAML resolves the bare `on:` key to the boolean True.
    document["on"] = document.get("on", document.get(True))
    return document


def _module(relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _steps(workflow: dict, job: str) -> list[dict]:
    return workflow["jobs"][job]["steps"]


# ---------------------------------------------------------------------------
# The workflows
# ---------------------------------------------------------------------------


def test_both_release_workflows_are_dispatch_only() -> None:
    """A release that a push can start is a release that happens by accident."""
    for path in (BUILD_WORKFLOW, PROMOTE_WORKFLOW):
        triggers = _load_workflow(path)["on"]
        assert list(triggers) == ["workflow_dispatch"], f"{path.name} has extra triggers: {list(triggers)}"


def test_the_build_takes_a_required_version_and_a_prerelease_flag() -> None:
    inputs = _load_workflow(BUILD_WORKFLOW)["on"]["workflow_dispatch"]["inputs"]
    assert inputs["version"]["required"] is True
    assert inputs["prerelease"]["default"] is False
    # The flag has to say what it does not do, because "prerelease" alone reads
    # like a publishing detail rather than "no existing install will update".
    assert "NEVER move" in inputs["prerelease"]["description"]


def test_the_build_workflow_never_publishes() -> None:
    workflow = _load_workflow(BUILD_WORKFLOW)
    assert workflow["permissions"] == {"contents": "read"}
    text = BUILD_WORKFLOW.read_text(encoding="utf-8")
    assert "gh release create" not in text
    assert "latest.json" not in text.split("# ---")[0] or "promote" in text
    for step in _steps(workflow, "macos"):
        with_block = step.get("with") or {}
        if step.get("uses", "").startswith("tauri-apps/tauri-action"):
            assert with_block.get("includeUpdaterJson") is False
            assert "releaseId" not in with_block
            assert "tagName" not in with_block


def test_every_tauri_build_uses_the_rust_cli_at_a_real_project_path() -> None:
    """tauri-action defaults to `npm run tauri` at projectPath.

    The root package.json here is a monorepo task runner with no `tauri` script,
    so the default fails on every platform with "Missing script: tauri". Both
    inputs have to be set, and projectPath has to be the directory that contains
    src-tauri.
    """
    workflow = _load_workflow(BUILD_WORKFLOW)
    seen = 0
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if not step.get("uses", "").startswith("tauri-apps/tauri-action"):
                continue
            seen += 1
            with_block = step["with"]
            assert with_block["tauriScript"] == "cargo tauri"
            project_path = ROOT / with_block["projectPath"]
            assert (project_path / "src-tauri").is_dir(), with_block["projectPath"]
    assert seen >= 1, "no tauri-action step at all"


def test_the_rust_tauri_cli_is_installed_before_it_is_used() -> None:
    for job in _load_workflow(BUILD_WORKFLOW)["jobs"].values():
        steps = job.get("steps", [])
        uses_action = [i for i, step in enumerate(steps) if step.get("uses", "").startswith("tauri-apps/tauri-action")]
        if not uses_action:
            continue
        installs = [i for i, step in enumerate(steps) if "cargo install tauri-cli" in (step.get("run") or "")]
        assert installs, "the action is told to run `cargo tauri` but the CLI is never installed"
        assert min(installs) < min(uses_action)


def test_macos_apple_silicon_is_the_only_enabled_lane() -> None:
    jobs = _load_workflow(BUILD_WORKFLOW)["jobs"]
    assert jobs["macos"]["runs-on"].startswith("macos-")
    # Present so the shape does not rot, disabled because v1 is Apple Silicon
    # only (docs/RELEASE.md §3).
    for name in ("windows", "linux"):
        assert jobs[name]["if"] is False, f"{name} lane is enabled"
    text = BUILD_WORKFLOW.read_text(encoding="utf-8")
    assert "Apple Silicon only" in text
    assert "bundled runtimes" in text


def test_signing_is_guarded_and_the_artifact_says_so_when_it_is_skipped() -> None:
    steps = _steps(_load_workflow(BUILD_WORKFLOW), "macos")
    by_name = {step.get("name"): step for step in steps}

    decide = by_name["Decide whether this build can be signed"]
    assert "if" not in decide, "the decision itself must always run"

    for name in ("Import the signing certificate", "Staple the notarization ticket", "Ask Gatekeeper"):
        assert "steps.signing.outputs" in by_name[name]["if"], f"{name} is not guarded by the signing decision"

    collect = by_name["Collect the artifacts"]["run"]
    assert "UNSIGNED" in collect
    assert "UNSIGNED.txt" in collect
    upload = by_name["Upload the build"]
    assert "steps.collect.outputs.label" in upload["with"]["name"], "the artifact name does not carry the label"

    # Gatekeeper is asked, not silenced. (Commentary is allowed to name the flag
    # this pipeline refuses to use; a command is not.)
    commands = "\n".join(
        line for line in BUILD_WORKFLOW.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#")
    )
    assert "spctl --assess" in commands
    assert "--no-assess" not in commands


def test_promotion_is_a_separate_workflow_that_refuses_an_unsigned_candidate() -> None:
    text = PROMOTE_WORKFLOW.read_text(encoding="utf-8")
    assert "UNSIGNED" in text and "never published" in text
    workflow = _load_workflow(PROMOTE_WORKFLOW)
    steps = {step.get("name"): step for step in _steps(workflow, "promote")}
    # A pre-release is downloadable and is never delivered to an install.
    assert steps["Move the update channel"]["if"] == "${{ !inputs.prerelease }}"
    assert steps["Build the update manifest"]["if"] == "${{ !inputs.prerelease }}"
    assert workflow["jobs"]["promote"]["environment"] == "desktop-release"


def test_no_secret_is_ever_written_where_it_could_be_read_back() -> None:
    """Secrets appear as `secrets.NAME` and nowhere else.

    Not a style rule: an echoed secret lands in the run log, and a secret written
    into an artifact ships with the build.
    """
    for path in (BUILD_WORKFLOW, PROMOTE_WORKFLOW):
        text = path.read_text(encoding="utf-8")
        for marker in ("BEGIN PRIVATE KEY", "minisign secret key", "-----BEGIN"):
            assert marker not in text, f"{path.name} looks like it carries key material"
        for line in text.splitlines():
            if "secrets." not in line:
                continue
            assert "echo" not in line and "printf" not in line or "base64 --decode" in line, line


# ---------------------------------------------------------------------------
# The updater
# ---------------------------------------------------------------------------


def test_the_updater_public_key_is_config_and_the_private_key_is_a_name() -> None:
    config = json.loads((ROOT / "src-tauri" / "updater.json").read_text(encoding="utf-8"))
    assert config["endpoints"], "an installed app would have nowhere to ask about updates"
    assert "pubkey" in config, "the public key must be a config value, not a build-time surprise"
    assert config["private_key_secret"] == "TAURI_SIGNING_PRIVATE_KEY"
    # A name, not a value.
    assert len(config["private_key_secret"]) < 64
    raw = (ROOT / "src-tauri" / "updater.json").read_text(encoding="utf-8")
    assert "minisign secret key" not in raw
    assert config["promotion"]["prerelease_moves_updater"] is False


def test_the_updater_check_reports_drift_and_demands_a_key_before_delivery(tmp_path: Path) -> None:
    checker = _module("scripts/check_updater_config.py")

    # As shipped: no key yet, so unsigned builds are fine and promotion is not.
    assert checker.check(require_key=False) == []
    assert any("pubkey" in problem for problem in checker.check(require_key=True))

    # A tauri.conf.json that disagrees with the one source is caught.
    updater = tmp_path / "updater.json"
    updater.write_text(
        json.dumps(
            {
                "endpoints": ["https://example.invalid/latest.json"],
                "pubkey": "PUBLIC",
                "private_key_secret": "TAURI_SIGNING_PRIVATE_KEY",
            }
        ),
        encoding="utf-8",
    )
    tauri = tmp_path / "tauri.conf.json"
    tauri.write_text(
        json.dumps({"plugins": {"updater": {"endpoints": ["https://elsewhere.invalid/latest.json"], "pubkey": "OTHER"}}}),
        encoding="utf-8",
    )
    checker.UPDATER_CONFIG = updater
    checker.TAURI_CONFIG = tauri
    problems = checker.check(require_key=True)
    assert any("endpoints differ" in problem for problem in problems)
    assert any("pubkey differs" in problem for problem in problems)


# ---------------------------------------------------------------------------
# The bundled Python
# ---------------------------------------------------------------------------


def test_the_desktop_set_excludes_the_streamlit_stack() -> None:
    builder = _module("scripts/build_desktop_python.py")
    excluded = builder.excluded_packages()
    for name in ("streamlit", "streamlit-tour", "dashscope", "azure-cognitiveservices-speech", "redis"):
        assert name in excluded


def test_the_builder_reads_a_git_pin_as_something_to_vendor() -> None:
    """A `git+https` requirement means the build would need network and a token.

    The build script has to see it as a direct reference so it can insist on a
    vendored wheel instead.
    """
    builder = _module("scripts/build_desktop_python.py")
    names, lines = builder.parse_requirements(
        "# comment\n"
        "moviepy==2.2.1\n"
        "    # via nothing\n"
        "passbook @ git+https://github.com/LiamVisionary/passbook.git@" + "0" * 40 + "\n"
        "colorama==0.4.6 ; sys_platform == 'win32'\n"
    )
    assert names == ["colorama", "moviepy", "passbook"]
    assert list(builder.direct_reference_lines(lines)) == ["passbook"]


def test_ffmpeg_is_staged_rather_than_resolved_from_path(tmp_path: Path) -> None:
    """`shutil.which("ffmpeg")` all over the engine is why this is staged.

    A bundle that inherits the user's PATH either finds nothing (Finder launch,
    no shell profile) or finds a Homebrew build nobody tested against.
    """
    builder = _module("scripts/build_desktop_python.py")
    with pytest.raises(builder.BuildError) as failure:
        builder._resolve_ffmpeg_dir(str(tmp_path))
    message = str(failure.value)
    assert "ffmpeg" in message and "ffprobe" in message
    # Never present a problem without its fix.
    assert "--ffmpeg-dir" in message and "DESKTOP_FFMPEG_DIR" in message

    source = tmp_path / "static"
    source.mkdir()
    for name in ("ffmpeg", "ffprobe"):
        (source / name).write_bytes(b"#!/bin/sh\n")
    assert builder._resolve_ffmpeg_dir(str(source)) == source
    staged = builder._stage_ffmpeg(source, tmp_path / "bin")
    assert staged == ["ffmpeg", "ffprobe"]
    assert (tmp_path / "bin" / "ffprobe").exists()


# ---------------------------------------------------------------------------
# The documents
# ---------------------------------------------------------------------------


def test_the_release_checklist_names_every_suite_and_the_manual_smoke() -> None:
    checklist = (ROOT / "docs" / "RELEASE_CHECKLIST.md").read_text(encoding="utf-8")
    for command in (
        "node --test tests/*.test.js",
        "npx vitest run",
        "pytest -q test/studio",
        "pytest -q .",
        "ruff check",
        "npm run build:embedded",
    ):
        assert command in checklist, command
    for gate in ("cold boot", "lock", "unlock", "sealed output", "packaging"):
        assert gate in checklist.lower(), gate
    assert "release-desktop.yml" in checklist
    assert "release-desktop-promote.yml" in checklist


def test_the_test_readme_describes_this_project() -> None:
    readme = (ROOT / "test" / "README.md").read_text(encoding="utf-8")
    assert not readme.startswith("# MoneyPrinterTurbo"), "still titled for the donor project"
    for suite in ("test/studio", "packages/media-gateway", "packages/open-generative-ai", "packages/comfyui-mobile"):
        assert suite in readme, suite
    # The environment-dependent ones, so a red run is read correctly.
    for gate in ("MPT_RUN_INTEGRATION_TESTS", "MPT_TEST_REDIS_HOST", "ffmpeg"):
        assert gate in readme, gate
