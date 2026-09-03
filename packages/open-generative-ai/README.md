# open-generative-ai — the studio front end

This package is the React 19 + Vite browser surface of Hivemind Content Studio:
the Image, Video, Story, Sprite and Restore studios, the hub that frames them,
and the local-inference bridge (`hosted-server.js`, port 8794) that lets the
browser reach on-machine engines without ever seeing a token. It is served by
the control API at `http://127.0.0.1:8765`, not opened as a file, and it is not
a standalone product: on its own it has no backend to talk to. `electron/` is
the developer shell that wraps that URL in a window; the shipped desktop shell
is described in [`docs/RELEASE.md`](../../docs/RELEASE.md). Build it with
`npm run vite:build`, test it with `node --test tests/*.test.js`.

Two documents govern changes here and are worth reading before the code.
[`DESIGN.md`](DESIGN.md) is the design system — the token set, the `ui/kit.jsx`
primitives every surface is built from, and the rules about confirmations,
toasts and bilingual strings. [`AGENTS.md`](AGENTS.md) is the privacy boundary:
what may reach `localStorage`, what must stay in memory, and what must never be
logged. On licensing: this directory began as a fork of
[Open Generative AI](https://github.com/Anil-matcha/Open-Generative-AI) and the
donor's MIT notice is preserved in [`LICENSE`](LICENSE) for the code it covers.
Everything the owner has added since — the studios, the hub, the bridge, the
privacy layer — is **AGPL-3.0-or-later**, the same as the umbrella project, and
the package as distributed is AGPL-3.0-or-later. See
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) at the repository root
for the full donor list.
