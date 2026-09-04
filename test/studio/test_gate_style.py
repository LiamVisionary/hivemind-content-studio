"""The sign-in gate is on the design system, and stays on it.

The gate cannot import `variables.css` — it is a server-rendered page that has to
work before the bundle it would import from is reachable. So it carried a copy of
the palette, and the copy drifted into six avatar gradients including the violet
and cyan `DESIGN.md` forbids. `scripts/generate_gate_css.py` makes the copy now;
these tests are what stop it drifting again.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts" / "generate_gate_css.py"
TOKENS_CSS = ROOT / "packages" / "open-generative-ai" / "src" / "styles" / "variables.css"


def load_generator():
    spec = importlib.util.spec_from_file_location("generate_gate_css", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def generator():
    return load_generator()


def test_the_shipped_stylesheet_is_what_the_generator_produces(generator):
    """A hand-edit to gate_style.py fails here rather than shipping."""
    shipped = (ROOT / "src" / "hivemind_content_studio" / "gate_style.py").read_text(encoding="utf-8")
    assert shipped == generator.build(), (
        "src/hivemind_content_studio/gate_style.py is stale — run "
        "`python3 scripts/generate_gate_css.py`"
    )
    assert generator.main(["--check"]) == 0


def test_every_value_comes_from_the_apps_tokens(generator):
    """The `:root` the gate inlines carries the app's real values, not a copy."""
    from hivemind_content_studio.gate_style import GATE_CSS

    tokens = generator.read_tokens(TOKENS_CSS)
    root = re.match(r":root\{color-scheme:dark;(.*?)\}\n", GATE_CSS, re.DOTALL)
    assert root, "the gate stylesheet must open with the token block"
    declared = dict(re.findall(r"--([a-z0-9-]+):([^;]+);", root.group(1)))
    assert declared, "no tokens were emitted"
    for name, value in declared.items():
        assert value == tokens[name], f"--{name} has drifted from variables.css"

    # And every token the rules read is one of those — a `var(--x)` with no
    # declaration renders as nothing at all.
    rules = GATE_CSS[root.end():]
    for name in set(re.findall(r"var\(--([a-z0-9-]+)\)", rules)):
        assert name in declared, f"the gate rules use --{name}, which is not emitted"


def test_the_rules_name_no_colour_of_their_own():
    """Below the token block there are no hex literals and no rgb()/hsl() calls."""
    from hivemind_content_studio.gate_style import GATE_CSS

    rules = GATE_CSS.split("\n", 1)[1]
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b", rules), "a hex colour got into the gate rules"
    assert not re.search(r"\b(?:rgba?|hsla?)\(", rules), "a literal colour got into the gate rules"


def test_the_avatar_palette_is_honey_and_neutrals_only():
    """DESIGN.md: one honey accent, never cyan/violet. The tiles obey it."""
    from hivemind_content_studio.accounts import TILE_COLOURS
    from hivemind_content_studio.gate_style import GATE_CSS

    classes = set(re.findall(r"\.c-([a-z]+)\{", GATE_CSS))
    assert classes == set(TILE_COLOURS), "every stored tile colour needs a class, and vice versa"
    assert not classes & {"violet", "teal", "rose", "sky", "lime", "cyan"}

    # Each tile gradient is built from honey or from the neutral ink ramp.
    allowed = {"honey", "honey-bright", "honey-deep", "ink-1", "ink-2", "ink-3"}
    for colour in classes:
        rule = re.search(rf"\.c-{colour}\{{([^}}]*)\}}", GATE_CSS).group(1)
        used = set(re.findall(r"var\(--([a-z0-9-]+)\)", rule))
        assert used and used <= allowed, f".c-{colour} paints with {used - allowed}"


def test_the_gate_page_inlines_the_generated_sheet():
    """The page the user actually gets carries the tokens and the typeface."""
    from hivemind_content_studio.account_gate import account_gate_html
    from hivemind_content_studio.gate_style import GATE_CSS

    html = account_gate_html(desktop=False)
    assert GATE_CSS in html
    assert "--honey:#f6b21b" in html
    assert "Inter" in html
    # The old hand-written palette is gone from the page, not merely unused.
    for dead in ("background:#0c0c0e", "color:#f2f2f3", "c-violet", "c-teal", "c-sky", "c-lime"):
        assert dead not in html


def test_the_desktop_shell_is_marked_on_the_page(monkeypatch):
    """One flag, read from the env the packaged shell sets.

    The gate uses it for two things: a solo workspace goes straight to its
    passkey, and "New workspace" moves behind Settings > Privacy > Workspaces.
    A browser build is unaffected.
    """
    from hivemind_content_studio import account_gate

    monkeypatch.delenv(account_gate.DESKTOP_ENV, raising=False)
    assert account_gate.desktop_shell() is False
    assert 'data-desktop="0"' in account_gate.account_gate_html()

    monkeypatch.setenv(account_gate.DESKTOP_ENV, "1")
    assert account_gate.desktop_shell() is True
    assert 'data-desktop="1"' in account_gate.account_gate_html()


def test_the_lede_promises_only_what_the_code_delivers():
    """Vault blobs and sealed media are per account; run files are not.

    The old sentence — "nothing in one can be opened from another" — covered
    both, and run-side prompt files are written with one process-wide cipher
    this Mac's keychain holds. See `private_access.py` and `run_privacy.py`.
    """
    from hivemind_content_studio.account_gate import account_gate_html

    html = account_gate_html(desktop=False)
    assert "Nothing in one can be opened from another" not in html
    assert "sealed to your own key" in html
    assert "encrypted on this" in html
