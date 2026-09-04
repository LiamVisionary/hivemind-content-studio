#!/usr/bin/env python3
"""Generate the sign-in gate's stylesheet from the app's design tokens.

The gate is a server-rendered page (`account_gate.py`) because the studio's
bundle lives behind the same gate it would have to render — so it cannot import
`src/styles/variables.css`, `kit.jsx` or anything else from the React app. It
used to carry its own hardcoded palette instead, which drifted: six avatar
gradients in violet, teal, rose, sky and lime, on a design system whose first
rule is one honey accent and "never cyan/violet" (`DESIGN.md`).

So the tokens are copied, once, by this script rather than by a person:

    python3 scripts/generate_gate_css.py            # writes gate_style.py
    python3 scripts/generate_gate_css.py --check    # fails if it is stale

`_RULES` below is the gate's CSS with every colour, radius, control height and
easing written as `var(--token)`. The generator reads the real values out of
`variables.css`, emits the subset the gate actually uses as a `:root` block, and
writes both into `src/hivemind_content_studio/gate_style.py` as one string the
gate inlines. A colour that is not a token cannot get into the gate without
failing `test/studio/test_gate_style.py`.

No network, no dependencies.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKENS_CSS = ROOT / "packages" / "open-generative-ai" / "src" / "styles" / "variables.css"
OUTPUT = ROOT / "src" / "hivemind_content_studio" / "gate_style.py"

# The tokens the gate uses. Listed rather than copied wholesale so the inlined
# stylesheet stays small, and so adding a colour to the gate is a deliberate line
# here instead of a hex literal in a template.
USED_TOKENS = (
    "honey",
    "honey-bright",
    "honey-deep",
    "honey-tint",
    "honey-tint-strong",
    "on-honey",
    "danger",
    "bg-0",
    "bg-1",
    "bg-2",
    "bg-3",
    "ink-1",
    "ink-2",
    "ink-3",
    "line-1",
    "line-2",
    "r-sm",
    "r-md",
    "r-lg",
    "ctl-md",
    "ctl-lg",
    "shadow-overlay",
    "ease-swift",
    "t-fast",
    "font-ui",
)

# Avatar tiles: the honey accent and two neutrals, which is the whole palette the
# design system allows. `accounts.TILE_COLOURS` must name exactly these, and the
# gate's script falls back to `amber` for a colour stored by an older build.
_RULES = """
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg-0);color:var(--ink-1);
  font-family:var(--font-ui);-webkit-font-smoothing:antialiased}
main{width:min(860px,100%);display:grid;gap:28px;justify-items:center}
.mark{width:40px;height:40px;display:grid;place-items:center;border-radius:var(--r-md);background:var(--honey-tint);color:var(--honey)}
.eyebrow{margin:0;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--honey);text-align:center}
h1{margin:6px 0 0;font-size:28px;font-weight:650;letter-spacing:-0.02em;text-align:center}
p.lede{margin:8px 0 0;color:var(--ink-2);font-size:13px;line-height:1.55;text-align:center;max-width:46ch}
.tiles{display:flex;flex-wrap:wrap;gap:22px;justify-content:center;padding:0;margin:0;list-style:none}
.tile{display:grid;gap:10px;justify-items:center;background:none;border:0;padding:0;cursor:pointer;font:inherit;color:inherit}
.avatar{width:118px;height:118px;border-radius:var(--r-lg);display:grid;place-items:center;font-size:40px;font-weight:600;
  color:var(--on-honey);border:3px solid transparent;transition:border-color var(--t-fast),transform var(--t-fast)}
.tile:hover .avatar,.tile:focus-visible .avatar{border-color:var(--ink-1);transform:scale(1.05)}
.avatar.add{background:var(--bg-1);border:3px dashed var(--line-2);color:var(--ink-3);font-size:44px;font-weight:400}
.tile:hover .avatar.add,.tile:focus-visible .avatar.add{border-color:var(--ink-1);color:var(--ink-1)}
.tile:focus-visible{outline:none}
.tile-name{font-size:14px;color:var(--ink-2);transition:color var(--t-fast)}
.tile:hover .tile-name,.tile:focus-visible .tile-name{color:var(--ink-1)}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3)}
.c-amber{background:linear-gradient(140deg,var(--honey),var(--honey-deep))}
.c-sand{background:linear-gradient(140deg,var(--honey-bright),var(--honey))}
.c-stone{background:linear-gradient(140deg,var(--ink-1),var(--ink-2))}
.c-slate{background:linear-gradient(140deg,var(--ink-2),var(--ink-3))}
.card{width:min(400px,100%);display:grid;gap:14px;padding:30px;border:1px solid var(--line-1);border-radius:var(--r-lg);
  background:var(--bg-1);box-shadow:var(--shadow-overlay)}
.card h2{margin:0;font-size:19px;font-weight:640;letter-spacing:-0.01em}
.card .who{display:flex;align-items:center;gap:12px}
.card .who .avatar{width:46px;height:46px;border-radius:var(--r-md);font-size:19px;border-width:0}
.card .who .avatar.add{border-width:2px;font-size:22px}
button{min-height:var(--ctl-lg);border:0;border-radius:var(--r-md);font:600 14px inherit;cursor:pointer;
  transition:background var(--t-fast),border-color var(--t-fast)}
.primary{background:var(--honey);color:var(--on-honey);display:flex;align-items:center;justify-content:center;gap:9px}
.primary:hover{background:var(--honey-bright)}
.primary:disabled{opacity:.55;cursor:default}
.secondary{background:var(--bg-2);color:var(--ink-1);border:1px solid var(--line-1)}
.secondary:hover{border-color:var(--line-2)}
.divider{display:flex;align-items:center;gap:12px;color:var(--ink-3);font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line-1)}
form{display:grid;gap:10px}
label{display:grid;gap:6px;font-size:12px;font-weight:500;color:var(--ink-2)}
input{width:100%;height:var(--ctl-md);padding:0 14px;border:1px solid var(--line-1);border-radius:var(--r-md);background:var(--bg-2);
  color:var(--ink-1);font:inherit;font-size:14px;outline:0;transition:border-color var(--t-fast)}
input:hover{border-color:var(--line-2)}
input:focus{border-color:var(--honey);box-shadow:0 0 0 3px var(--honey-tint-strong)}
.error{margin:0;color:var(--danger);font-size:12px;line-height:1.5}
.error:empty{display:none}
.back{background:none;border:0;color:var(--ink-3);font:inherit;font-size:12px;cursor:pointer;padding:4px;min-height:0}
.back:hover{color:var(--ink-2)}
.note{margin:0;color:var(--ink-3);font-size:12px;line-height:1.5;text-align:center}
.sealing{display:grid;gap:6px;padding:12px 14px;border:1px solid var(--line-1);border-radius:var(--r-sm);background:var(--bg-3)}
[hidden]{display:none !important}
@media (prefers-reduced-motion:reduce){.avatar,.tile-name{transition:none}.tile:hover .avatar{transform:none}}
"""

_HEADER = '''"""The sign-in gate's stylesheet — GENERATED, do not edit.

Written by `scripts/generate_gate_css.py` from
`packages/open-generative-ai/src/styles/variables.css`, so the first screen of
the product is on the same palette, typeface and radii as everything behind it.
Change the tokens or the rules in that script and run it again;
`test/studio/test_gate_style.py` fails when this file has drifted.
"""

GATE_CSS = """\\
'''


def read_tokens(path: Path = TOKENS_CSS) -> dict[str, str]:
    """Every `--name: value;` declared on the app's `:root`."""
    text = path.read_text(encoding="utf-8")
    root = re.search(r":root\s*\{(.*?)\}", text, re.DOTALL)
    if not root:  # pragma: no cover - the token file always has a :root
        raise SystemExit(f"{path} declares no :root block")
    body = re.sub(r"/\*.*?\*/", "", root.group(1), flags=re.DOTALL)
    return {
        name: value.strip()
        for name, value in re.findall(r"--([a-z0-9-]+)\s*:\s*([^;]+);", body)
    }


def render(tokens: dict[str, str]) -> str:
    """The gate stylesheet: the used tokens, then the rules that read them."""
    missing = [name for name in USED_TOKENS if name not in tokens]
    if missing:
        raise SystemExit(
            "variables.css no longer defines: " + ", ".join(missing)
            + " — update USED_TOKENS or the rules that use them."
        )
    declarations = "".join(f"--{name}:{tokens[name]};" for name in USED_TOKENS)
    return f":root{{color-scheme:dark;{declarations}}}\n{_RULES.strip()}\n"


def build(tokens_css: Path = TOKENS_CSS) -> str:
    """The whole generated module, ready to compare or write."""
    css = render(read_tokens(tokens_css))
    # The CSS carries no backslashes or triple quotes; assert rather than escape,
    # so a rule that would need escaping is caught here instead of at import.
    if '"""' in css or "\\" in css:
        raise SystemExit("the gate CSS must contain no backslashes or triple quotes")
    return f'{_HEADER}{css}"""\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the generated file is stale")
    args = parser.parse_args(argv)

    generated = build()
    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != generated:
            print(
                f"{OUTPUT.relative_to(ROOT)} is out of date — run "
                "`python3 scripts/generate_gate_css.py`",
                file=sys.stderr,
            )
            return 1
        print(f"{OUTPUT.relative_to(ROOT)} is up to date")
        return 0

    OUTPUT.write_text(generated, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(generated)} bytes)")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
