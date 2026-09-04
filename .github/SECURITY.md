# Security Policy

## Reporting a vulnerability

**Use this repository's private vulnerability reporting:**
[Report a vulnerability](https://github.com/LiamVisionary/hivemind-content-studio/security/advisories/new)
(Security → Advisories → Report a vulnerability). That form is private to the
maintainers, and it is the channel — there is no security mailing address to
guess at, and none should be invented.

Please do **not** open a public issue for a suspected vulnerability, and do not
include details, proof-of-concept code, payloads or file paths in one. If the
advisory form is unavailable to you, open an issue that says only that you have
a report and are waiting for a private channel.

Include, in the advisory:

- affected commit, tag or release version (the About page in the app shows both
  the version and the commit; `GET /api/version` returns the same)
- the listener or route involved — the table below names them
- what an attacker gains, and what they need to start with (already on the
  machine? on the same Tailnet? a link the owner clicks?)
- reproduction conditions
- suggested remediation, if you have one

Please allow a reasonable window to investigate and ship a fix before public
disclosure. Once a fix is out, coordinated disclosure is welcome, and the
advisory will credit you unless you ask otherwise.

## Supported versions

Security fixes are applied on a best-effort basis to `main` and to the most
recent published release line. This is a single-maintainer project; there is no
paid support tier and no service-level commitment.

## What this software is

A **local-first, single-owner desktop app.** It runs on the owner's machine,
holds the owner's credentials through
[PassBook](https://github.com/LiamVisionary/passbook), and calls out to model
providers on the owner's own accounts. Its threat model is not a multi-tenant
server's: there is one owner, the data at rest is theirs, and the boundaries
worth attacking are the loopback listeners, the browser origin, and anything
that leaves the machine.

Three properties the product intends to keep, and which a report should be
measured against:

1. **Nothing leaves the machine on its own.** Diagnostics, telemetry and logs
   are local files; the app has no phone-home. Anything that transmits does so
   because the owner asked for a generation, a rental or a publish.
2. **Prompts and outputs are the owner's.** Private media is sealed to the
   owner's vault key, which the server never holds
   (`docs/E2E_ENCRYPTION_DESIGN.md`). A bug that lets the server, a log, or
   another account read that plaintext is a vulnerability.
3. **Credentials are never handled in the browser.** Provider secrets are read
   through PassBook server-side and never enter the frontend, a URL, or a
   provider-catalog response.

## What listens where

Every listener below binds `127.0.0.1` by default. Nothing here is meant to be
reachable from the network, and none of it should be port-forwarded.

| Port | Process | Bind | Authentication |
|---|---|---|---|
| 8765 | Control API (`control_api.py`) | `127.0.0.1` | **Owner session cookie or passkey**, plus `Authorization: Bearer $CONTENT_STUDIO_CONTROL_TOKEN` for machine routes. Cross-site requests are refused by Origin; credential writes are owner-only. `/api/version`, `/api/about` and `/healthz` answer unauthenticated on purpose — they carry the licence, the source offer and liveness, and nothing about the machine. |
| 8787 | Media gateway (`packages/media-gateway/app.py`) | `127.0.0.1` (`ZIMG_HOST`) | **Shared token** (`ZIMG_TOKEN`, else `~/.hivemindos/media-studio/secure/zimg-token`), accepted as `Authorization: Bearer`, `X-Token`, a `zimg_token` cookie, or `?token=` on the wrapper page that sets that cookie. |
| 8788 | Canvas / gateway frontend (`packages/media-gateway/server.js`) | `127.0.0.1` (`HOST`) | **None of its own.** It is the iframe the studio frames and a ComfyUI HTTP/WS proxy; it relies on being loopback-only, and on 8787 holding the token for anything that touches state. |
| 8794 | Local-inference bridge (`hosted-server.js`) | `127.0.0.1` (`OGA_HOST`) | **None.** Loopback-only by design, so the browser can reach on-machine engines without ever seeing a provider token. |
| 8796 | Media Studio MCP (`bin/media-studio-mcp.mjs --http`) | `127.0.0.1` (`MEDIA_STUDIO_MCP_HOST`) | **Bearer token** — an agent presents `Authorization: Bearer <token>` from the configured list. |
| 8188 / 8198 / 8199 | ComfyUI lanes | `127.0.0.1` | **None.** Not ours: the user's own ComfyUI checkout. The app attaches to whatever answers and never starts or stops it. A lane on another machine is reached with a per-lane bearer token (`COMFY_LANE_TOKENS`). |
| 8789 | Tailscale HTTPS proxy | Tailnet address | **Off by default, and developer/fleet only** — not in the desktop bundle. When it is running it publishes 8765 and 8788 over HTTPS to the owner's *Tailnet*, which means every device and every user the Tailnet ACLs admit, not just the owner's laptop. Turning it on is the one action here that widens the audience of everything above. |
| 8791 | Swift MLX engines (optional) | `127.0.0.1` | **None.** Attach-only, launched by the user. |

Ports 8765, 8787, 8788, 8794 and 8796 are supervised by
`scripts/hivemind-studio-stack` (developer) or by the desktop shell; the ComfyUI
lanes and MLX engines are attached to, never spawned. `docs/RELEASE.md` §1 is
the full process tree.

## In scope

- Anything that reads or writes another account's data across the account gate
  (`accounts.py`, `account_scope.py`), or that recovers vault plaintext without
  the owner's key.
- Anything that gets a credential value out of PassBook, into the browser, into
  a log, a diagnostics bundle, an error message, or a URL.
- Anything reachable cross-origin from a page the owner merely visits: CSRF
  against 8765, DNS rebinding onto any loopback listener, a WebAuthn origin or
  relying-party confusion.
- Path traversal or SSRF through the media gateway's proxy and file routes.
- Command or prompt injection that turns agent-supplied text into a process on
  the machine.
- Anything that makes the app spend money — a rental, a paid generation — without
  passing the approval ledger.

## Out of scope

- Attacks that require the attacker to already be running code as the owner on
  the owner's machine. That is the trust boundary this app sits inside.
- The ComfyUI lanes' own code, custom nodes and models: upstream projects,
  attached and never redistributed here.
- Model output. A model saying something wrong, unsafe or infringing is a model
  problem; report it upstream.
- Exposing a loopback listener to the network deliberately (a port-forward, a
  reverse proxy, `ZIMG_HOST=0.0.0.0`) and then reporting that it is exposed. The
  defaults are loopback and the Tailscale proxy is off; overriding them is a
  configuration choice, and this policy names its consequences above.
- Missing hardening on an unreleased branch, and findings from an automated
  scanner with no demonstrated impact.
