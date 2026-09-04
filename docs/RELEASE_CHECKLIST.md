# Release checklist

The list that has to be green before a desktop build is dispatched, and the
manual steps no suite can do. [`RELEASE.md`](RELEASE.md) is the *why* — what the
bundle contains and the decisions behind it; this is the *what to run*, in order.

Steps 1–7 are the gate. A failure at any of them stops the release; none of them
is skipped because "it passed yesterday".

Nothing in this document signs, notarizes or publishes anything. Building is
[`release-desktop.yml`](../.github/workflows/release-desktop.yml); delivering is
[`release-desktop-promote.yml`](../.github/workflows/release-desktop-promote.yml),
and it is a separate, human step.

---

## 1. The five suites

Run from the repository root unless a command says otherwise. `$PWD/src` on
`PYTHONPATH` is what makes a worktree test its own sources rather than whatever
the editable install points at.

| # | Suite | Command | Expected |
|---|---|---|---|
| 1 | Studio frontend | `cd packages/open-generative-ai && node --test tests/*.test.js` | 1216 pass |
| 2 | Canvas (comfyui-mobile) | `cd packages/comfyui-mobile && npx vitest run` | 945 pass, 129 files |
| 3 | Studio control plane | `PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q test/studio` | 1218 pass |
| 4 | Faceless engine | `PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q test --ignore=test/studio` | 634 pass, 9 skipped |
| 5 | Media gateway | `cd packages/media-gateway && ../../.venv/bin/python -m pytest -q .` | 423 pass, 1 skipped |

Counts as of 2026-09-04. They are here so a suite that silently stops collecting
is visible: "green" with 300 fewer tests is not green.

Two of these need something built or installed first — see
[`../test/README.md`](../test/README.md) for the prerequisites and the
environment-dependent skips. In particular, suite 3 fails four tests unless the
studio frontend has been built (step 3 below), because those tests assert the
served page *is* the studio.

## 2. The lint gate

```bash
.venv/bin/ruff check .                                  # 0 errors, whole tree
cd packages/open-generative-ai && npm run lint          # 0 errors, 0 warnings
cd packages/comfyui-mobile && npx tsc --noEmit -p tsconfig.app.json
```

The ruff line used to name a path list, and two of its entries (`main.py`,
`webui`) moved under `archive/moneyprinterturbo/` — so the documented gate had
been answering `E902 No such file or directory` instead of linting. It is the
whole tree now; the vendored trees are excluded by name in `pyproject.toml`.

`npm run build:mobile` runs `tsc -b` first, so a type error here is a release
that cannot be built at all.

## 3. The frontend build

```bash
npm run build:embedded    # studio dist/, Canvas dist/, gateway Next build
```

Then re-run suite 3: the owner-gate and static-asset tests read the built bundle.

## 4. Notices, identity and the updater

```bash
python3 scripts/generate_notices.py --check
python3 -m hivemind_content_studio.identity --write && git diff --exit-code \
  packages/open-generative-ai/electron/identity.json
python3 scripts/check_updater_config.py
python3 scripts/build_desktop_python.py            # dependency split + size
```

`THIRD_PARTY_NOTICES.md` must carry no open distribution gate. The build script
prints the desktop dependency set, what the `faceless-webui` split leaves out,
and the size of each; it exits non-zero if `streamlit`, `streamlit-tour`,
`azure-cognitiveservices-speech`, `dashscope` or `redis` has crept back into the
bundled set.

## 5. Cold boot to the sign-in gate

On a machine (or a fresh account) with no running stack:

```bash
npm run stack:start
open http://127.0.0.1:8765
```

* The page reaches the sign-in gate — on a first run, the "Name your studio"
  card, not a blank window and not a raw error.
* `curl -fsS http://127.0.0.1:8765/healthz` answers, and `/readyz` reports every
  sidecar it supervises.
* The Models page shows lanes that are not set up as **not set up**, not as
  errors.

`npm run stack:stop` when finished. On a developer machine that is already
running the stack, this step belongs on the second machine in step 7 instead —
do not restart someone's working stack to tick a box.

## 6. The manual smoke: owner gate and vault

No suite can do these, because they are about what a person sees.

1. **Sign in** at the gate with the owner passkey. A second, unenrolled browser
   profile must be refused, and must be told what to do about it.
2. **Lock the vault** (Settings → the vault card). Sealed media in the library
   turns into the locked placeholder with an Unlock action next to it — never a
   broken thumbnail and never a provider error string.
3. **Unlock**, and confirm a sealed output opens: pick a generation from before
   the lock and check it renders and downloads.
4. **Quit and reopen.** The session survives; a locked vault stays locked.
5. **Confirm no ComfyUI process was killed.** `pgrep -fl comfy` before and after.
   The packaged app attaches to the user's lanes and never reaps them.

## 7. Packaging

1. Dispatch **Release desktop (build only)** with the version (semver, no
   prefix — the tag it names is `studio-v<version>`). Preflight refuses a tag
   that already exists, a stale notices file, a drifted identity, an updater
   config that disagrees with `tauri.conf.json`, and a desktop dependency set
   that carries the Streamlit stack.
2. Download the artifact. Its name ends in `signed` or `UNSIGNED`; an
   `UNSIGNED.txt` inside says which secrets were absent
   (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
   for signing; `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for notarization;
   `TAURI_SIGNING_PRIVATE_KEY` for the updater). Unsigned builds are for the
   person who built them: macOS refuses to open one, and promotion rejects it.
3. Smoke-test the DMG on a **second** machine — install, launch, sign in, one
   hosted generation, one restore, quit — and check again that no ComfyUI
   process was killed on quit.
4. Dispatch **Release desktop (promote)** with the build's run id and the
   approval string `promote-<run id>`. It refuses an unsigned or un-notarized
   candidate, publishes the release at the tag, and only then writes
   `latest.json`.
5. A **pre-release** publishes a downloadable build and does **not** write
   `latest.json`. No existing install updates from it. That is the whole point:
   a candidate that fails step 3 was never delivered to anyone.

Rollback is editing `latest.json` on the release — one file, not un-shipping a
build. The tag itself is the AGPL source offer and is never moved or deleted.

---

## Secrets

Every one of these is referenced by name and **unset** in this repository. None
of them is ever printed, written into an artifact, or committed in any form.

| Name | Used for | Absent means |
|---|---|---|
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID signing | The build is labelled UNSIGNED and cannot be promoted |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | `notarytool` and stapling | Signed but not notarized; first launch is still blocked |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The signed update manifest | No updater artifacts; nothing can be delivered to an install |

The updater's **public** key is a config value in
[`../src-tauri/updater.json`](../src-tauri/updater.json) and ships inside the
app; `tauri.conf.json` must agree with it, which
`scripts/check_updater_config.py` enforces. Get the pair from
`cargo tauri signer generate`, commit only the public half, and store the
private half as the repository secret above.
