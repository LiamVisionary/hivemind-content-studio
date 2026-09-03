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


def test_notices_bundle_exists_and_covers_the_three_npm_packages() -> None:
    # Not an equality check against a fresh run: the Python half describes
    # whichever interpreter generated it, so a dev box and CI legitimately
    # differ. `scripts/generate_notices.py --check` is the release-time gate
    # (docs/RELEASE.md §7); this asserts the shape the About panel will read.
    import json

    notices = json.loads((ROOT / "docs" / "notices.json").read_text(encoding="utf-8"))
    assert notices["schema_version"] == 1
    assert notices["scope"] == "runtime"
    assert notices["project"]["license"] == "AGPL-3.0-or-later"
    assert notices["python"]["packages"], "no Python distributions recorded"
    for relative in ("packages/open-generative-ai", "packages/comfyui-mobile", "packages/media-gateway"):
        assert notices["npm"][relative], relative
    assert isinstance(notices["unresolved"], list)
