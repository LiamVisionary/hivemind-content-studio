"""The desktop bundle's dependency split, and the licence gates behind it.

The five packages in the `faceless-webui` extra are about a third of the venv and
no shipped process imports them. That only stays true if nothing reaches for them
at module scope, so the import test here blocks them and walks the engine.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WEBUI_ONLY = ("streamlit", "streamlit_tour", "dashscope", "azure", "redis")


def _pyproject() -> dict:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_webui_only_packages_are_not_in_the_bundled_dependency_list() -> None:
    project = _pyproject()["project"]
    base = " ".join(project["dependencies"])
    extra = " ".join(project["optional-dependencies"]["faceless-webui"])
    for name in ("streamlit", "streamlit-tour", "dashscope", "azure-cognitiveservices-speech", "redis"):
        assert name not in base, f"{name} would ride into the desktop bundle"
        assert name in extra
    assert "desktop" in project["optional-dependencies"]


def test_the_engine_imports_with_every_faceless_webui_package_blocked() -> None:
    """A bundled venv has none of the five. Nothing may import one eagerly.

    Runs in a subprocess: the parent session has already imported some of these,
    and a meta-path finder cannot un-import what is already in `sys.modules`.
    """
    script = (
        "import importlib, importlib.abc, pkgutil, sys\n"
        f"BLOCKED = {WEBUI_ONLY!r}\n"
        "class B(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, fullname, path=None, target=None):\n"
        "        if fullname.split('.')[0] in BLOCKED:\n"
        "            raise ModuleNotFoundError('blocked: ' + fullname)\n"
        "        return None\n"
        "sys.meta_path.insert(0, B())\n"
        "import app\n"
        "bad = []\n"
        "for mod in pkgutil.walk_packages(app.__path__, 'app.'):\n"
        "    if 'webui' in mod.name:\n"
        "        continue\n"
        "    try:\n"
        "        importlib.import_module(mod.name)\n"
        "    except ModuleNotFoundError as exc:\n"
        "        if 'blocked: ' in str(exc):\n"
        "            bad.append(mod.name + ' -> ' + str(exc))\n"
        "    except Exception:\n"
        "        pass\n"
        "for name in ('hivemind_content_studio.faceless_media', 'hivemind_content_studio.control_api',\n"
        "             'hivemind_content_studio.media_studio', 'auto_clipper.cli'):\n"
        "    try:\n"
        "        importlib.import_module(name)\n"
        "    except ModuleNotFoundError as exc:\n"
        "        if 'blocked: ' in str(exc):\n"
        "            bad.append(name + ' -> ' + str(exc))\n"
        "print('EAGER:' + '|'.join(bad))\n"
    )
    env = dict(os.environ)
    # This tree's own sources, so a worktree tests itself rather than whatever
    # checkout the editable install happens to point at.
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT), str(ROOT / "src"), env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
        env=env,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    line = [row for row in result.stdout.splitlines() if row.startswith("EAGER:")]
    assert line, result.stdout[-2000:] + result.stderr[-2000:]
    assert line[0] == "EAGER:", line[0]


def test_third_party_notices_carries_no_open_distribution_gate() -> None:
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    assert "No open distribution gate remains." in notices
    # The three gates the audit named, each now carrying a decision line.
    assert notices.count("**Decision (2026-09-03, LiamVisionary)") >= 4
    assert "Confirm that all contributed prompts/code may be distributed" not in notices
    assert "Review before commercial redistribution." not in notices


def test_embedded_package_licences_name_a_holder() -> None:
    mobile = (ROOT / "packages" / "comfyui-mobile" / "LICENSE").read_text(encoding="utf-8")
    assert "Copyright (c) 2026\n" not in mobile, "an MIT notice with a blank holder"
    assert "cosmicbuffalo" in mobile
    assert "modifications" in mobile

    import json

    mobile_pkg = json.loads((ROOT / "packages" / "comfyui-mobile" / "package.json").read_text(encoding="utf-8"))
    assert mobile_pkg["license"] == "MIT"

    opengen_pkg = json.loads((ROOT / "packages" / "open-generative-ai" / "package.json").read_text(encoding="utf-8"))
    assert opengen_pkg["license"] == "AGPL-3.0-or-later"
    readme = (ROOT / "packages" / "open-generative-ai" / "README.md").read_text(encoding="utf-8")
    assert "AGPL-3.0-or-later" in readme
    assert "DESIGN.md" in readme and "AGENTS.md" in readme
    # The donor's marketing copy is gone.
    assert "no content filters" not in readme


def test_release_document_names_every_shipped_process_and_the_three_decisions() -> None:
    release = (ROOT / "docs" / "RELEASE.md").read_text(encoding="utf-8")
    for process in ("control_api.py", "app.py", "server.js", "hosted-server.js", "media-studio-mcp.mjs"):
        assert process in release, process
    for port in ("8765", "8787", "8788", "8794", "8796", "8188"):
        assert port in release, port
    assert "tauri://localhost" in release
    assert "CONTENT_STUDIO_WEBAUTHN_ORIGINS" in release
    assert "HIVEMIND_STUDIO_TARGET" in release
    assert "App Sandbox" in release
    assert "studio-v0.x" in release
    assert "tauri-plugin-updater" in release
    assert "~/.hivemindos/media-studio" in release
    assert "~/.comfy-private.noindex" in release
    assert "scripts/generate_notices.py" in release


def test_notices_bundle_covers_every_ecosystem_the_bundle_carries() -> None:
    # The shape the About panel reads. Every set here is lockfile-derived, so it
    # is the same on any machine — it used to enumerate the running interpreter's
    # installed distributions, which meant the release gate
    # (`scripts/generate_notices.py --check`, RELEASE_CHECKLIST §4) could not be
    # green locally and in CI at once, and the panel over-reported the bundle by
    # a third.
    import json

    notices = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    assert notices["schema_version"] == 2
    assert notices["scope"] == "runtime"
    assert notices["project"]["license"] == "AGPL-3.0-or-later"
    assert notices["python"]["packages"], "no Python distributions recorded"
    assert "uv.lock" in notices["python"]["source"], "the Python set must come from the lock, not the machine"
    for relative in ("packages/open-generative-ai", "packages/comfyui-mobile", "packages/media-gateway"):
        assert notices["npm"][relative], relative
    # The crates are statically linked into the shipped binary, and MIT and
    # Apache-2.0 both ask for their notices to travel with it.
    assert notices["rust"]["source"].endswith("Cargo.lock")
    assert len(notices["rust"]["packages"]) > 100, "regenerate: Cargo.lock has hundreds of crates"
    assert all(row["name"] and row["version"] for row in notices["rust"]["packages"])
    # The three binaries the DMG carries that are in no lockfile at all.
    bundled = {row["name"] for row in notices["bundled"]}
    assert any("CPython" in name for name in bundled), bundled
    assert any("Node" in name for name in bundled), bundled
    assert any("ffmpeg" in name for name in bundled), bundled
    assert isinstance(notices["unresolved"], list)


def test_the_python_notices_are_the_set_the_bundle_installs() -> None:
    """Not the developer's venv: the packages `--extra desktop` pins.

    `scripts/build_desktop_python.py` freezes that same set into the bundle, so
    the two have to agree or the About panel is describing a different app than
    the one the user downloaded.
    """
    import json

    notices = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    recorded = {row["name"] for row in notices["python"]["packages"]}
    # The dev-only tools are the tell: they are installed on every developer
    # machine and ship in nothing.
    assert not recorded & {"pytest", "ruff", "coverage"}, "dev tools are not part of the bundle"
    # And the five the faceless-webui extra holds back.
    assert not recorded & {"streamlit", "dashscope", "redis"}, "the Streamlit stack is not in the desktop set"
    assert "fastapi" in recorded and "uvicorn" in recorded


def _generate_notices():
    import importlib.util

    spec = importlib.util.spec_from_file_location("generate_notices", ROOT / "scripts" / "generate_notices.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_notices_file_is_the_same_on_any_machine() -> None:
    """`--check` has to be able to be green locally and in CI at once.

    It could not be while the Python half enumerated installed distributions:
    the developer venv answered 128 packages and a CI sync answered ~101, so the
    committed file was stale for whichever machine did not write it. The sets
    come from lockfiles now and the licences are carried forward from the
    committed file, so regenerating changes nothing until a lock does.
    """
    import json
    import shutil

    if shutil.which("uv") is None:
        import pytest

        pytest.skip("uv is not on PATH; the Python set is read from uv.lock through it")

    module = _generate_notices()
    fresh = module.build_notices()
    committed = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    for key in fresh:
        if key == "generated_at":  # moves every day; not a staleness signal
            continue
        assert fresh[key] == committed.get(key), f"docs/notices.json is stale in {key}"


def test_a_bundled_binary_cannot_be_staged_without_a_licence(tmp_path: Path) -> None:
    """The ffmpeg pair is fetched from a repository variable, not from this tree.

    Which build it is decides the licence of the whole DMG, so the release
    workflow asks this before staging it rather than leaving it to a human.
    """
    import json

    module = _generate_notices()
    notices = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    binary = tmp_path / "ffmpeg"
    binary.write_text("#!/bin/sh\necho 'configuration: --enable-gpl --enable-libx264'\n", encoding="utf-8")
    binary.chmod(0o755)

    unrecorded = tmp_path / "notices-unrecorded.json"
    unrecorded.write_text(json.dumps(notices), encoding="utf-8")
    problems = module.check_ffmpeg(binary, unrecorded)
    assert problems and "no licence" in problems[0], problems

    lgpl = json.loads(json.dumps(notices))
    for row in lgpl["bundled"]:
        if "ffmpeg" in row["name"]:
            row["license"] = "LGPL-2.1-or-later"
    recorded = tmp_path / "notices-lgpl.json"
    recorded.write_text(json.dumps(lgpl), encoding="utf-8")
    problems = module.check_ffmpeg(binary, recorded)
    assert problems and "--enable-gpl" in problems[0], problems

    gpl = json.loads(json.dumps(lgpl))
    for row in gpl["bundled"]:
        if "ffmpeg" in row["name"]:
            row["license"] = "GPL-3.0-or-later"
    agrees = tmp_path / "notices-gpl.json"
    agrees.write_text(json.dumps(gpl), encoding="utf-8")
    assert module.check_ffmpeg(binary, agrees) == []
