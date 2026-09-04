"""The sign-in gate's stylesheet — GENERATED, do not edit.

Written by `scripts/generate_gate_css.py` from
`packages/open-generative-ai/src/styles/variables.css`, so the first screen of
the product is on the same palette, typeface and radii as everything behind it.
Change the tokens or the rules in that script and run it again;
`test/studio/test_gate_style.py` fails when this file has drifted.
"""

GATE_CSS = """\
:root{color-scheme:dark;--honey:#f6b21b;--honey-bright:#ffc94a;--honey-deep:#c88a0a;--honey-tint:rgba(246, 178, 27, 0.12);--honey-tint-strong:rgba(246, 178, 27, 0.22);--on-honey:#1a1205;--danger:#f26d5f;--bg-0:#0c0c0e;--bg-1:#111114;--bg-2:#17171b;--bg-3:#1e1e24;--ink-1:#f2f2f3;--ink-2:#a3a3ac;--ink-3:#6b6b74;--line-1:rgba(255, 255, 255, 0.08);--line-2:rgba(255, 255, 255, 0.16);--r-sm:6px;--r-md:10px;--r-lg:14px;--ctl-md:36px;--ctl-lg:44px;--shadow-overlay:0 24px 64px -24px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.06);--ease-swift:cubic-bezier(0.2, 0.9, 0.3, 1);--t-fast:120ms var(--ease-swift);--font-ui:'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif;}
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
