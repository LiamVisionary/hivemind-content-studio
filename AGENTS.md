# Agent notes for Hivemind Content Studio

Read this before generating, reading, or touching sealed media. It records
what the code enforces about privacy, what it does not, and what went wrong
once so it is not repeated. Everything here was verified against the source
on 2026-09-06; file paths are the places to re-verify.

## The three keys, and what each one opens

Generated media is sealed client-side (`packages/media-gateway/media_seal.py`:
AES-GCM data key, RSA-OAEP-wrapped to one or more recipients, written as
`<name>.e2e`). Who can open a file is decided entirely by which public keys
it was sealed to. There are three.

| key | lives | can an agent use it? | opens |
|---|---|---|---|
| **vault** (the owner's fingerprint) | RSA private key stored *wrapped* under a PBKDF2 passphrase key in `data/accounts/<id>/vault.sqlite3`; reconstructed only inside the owner's browser after unlock | **no** — no passphrase, no key; the wrapped blob is useless | every generation the owner is a recipient of |
| **device** | non-extractable keypair in the *browser's* IndexedDB, per browser profile **and per origin** (`127.0.0.1:8765`, `localhost:8765` and the tailnet URL each get a different one) | **no** — it never leaves the browser | the generating browser's own work, without unlocking the vault |
| **agent** | one machine-wide plaintext PEM, `~/.hivemindos/media-studio/secure/agent-e2e-key.pem` | **yes** — any process running as the user | files sealed to it: `<name>.agent-<fp>.e2e` |

Rules the code now enforces (`packages/media-gateway/gateway/promptroutes.py`
`sealing_recipients_for_route`, `gateway/media.py` `seal_output_to_e2e`):

- **The vault is always a recipient.** The studio sends the account's vault
  key per job as `X-E2E-Owner-Pub` (`src/hivemind_content_studio/media_studio.py`
  `_owner_headers`). A browser losing its device key can never orphan a
  generation again.
- **The second recipient is whoever presented `X-E2E-Requester-Pub`**
  (`gateway/http.py`, the 202 path). A browser-submitted job's second copy is
  sealed to *that browser's* device key. A user's generation is **never**
  sealed to the agent key unless the agent submitted it.
- **Agent generations are workspace-public by design.** The MCP presents the
  agent public key when it submits, so its outputs get `<name>.agent-<fp>.e2e`
  and any agent on the machine can read them. A signed-in workspace also sees
  them without unlocking the vault: on a decrypt failure the browser retries
  with `?reveal=agent`, and the gateway serves the agent copy decrypted
  (`gateway/media.py` `reveal_agent_plaintext`). The guard is structural — the
  gateway will only ever decrypt a file sealed to the agent key it holds, and
  a private clip has no such file.

## Generating privately as an agent

Pass `private: true` to `media_generate_image` or `media_generate_video`.
The job is submitted with **no** requester key and the workspace owner's
vault key as the **only** recipient, so the output is sealed exactly like the
owner's own private generations: only their browser, after unlocking, opens
it. The agent gets no copy and cannot read the result it just made.

It fails closed. If no owner key is configured the call refuses instead of
quietly sealing to the agent. The owner public key (public material — it can
only encrypt *to* the owner) is resolved in this order:

1. `MEDIA_STUDIO_OWNER_PUB` (inline base64url SPKI)
2. `MEDIA_STUDIO_OWNER_PUB_FILE`
3. `owner-e2e-pub` beside `MEDIA_STUDIO_E2E_PUB_FILE` (the agent key file the
   stack already sets), which `scripts/export_owner_pub.py --account <id>`
   writes from the workspace vault. Re-run it after creating or rotating a
   vault.

Today this targets one workspace (the exported key). Per-workspace selection
for a multi-account machine is the planned "agent private generation" feature;
the sealing mechanism is complete and this is the contract it will use.

## Limits that are real, not bugs

- **The agent key is machine-wide, not per-agent.** "Public" means public to
  every process running as the user, including ones nobody intended.
- **Workspace scoping of agent generations is enforced at the studio API
  (`require_owner`), not cryptographically.** The files and the agent PEM on
  disk are workspace-blind; a local process reading them directly sees every
  workspace's agent generations.
- **"Encrypted at rest" (`.zenc`) is not private.** It decrypts with a
  Keychain item any process running as the user can read. Everything that
  should be private must be E2E-sealed. All legacy `.zenc` media was migrated
  to the vault on 2026-09-06 and 2026-09-07
  (`packages/media-gateway/migrate_media_to_e2e.py`,
  `--vault-db data/accounts/<id>/vault.sqlite3`); do not reintroduce `.zenc`.
  A seal with no recipient used to fall through to it — on a machine with two
  workspaces `_default_vault_db()` deliberately refused to choose and returned
  a path that did not exist, so the sweeper and `send_output_file` sealed with
  the machine key instead. The fallback is the OWNER account's vault now
  (`gateway/media.py`), which is the same answer `claim_visible` already gives
  an unclaimed output, and is the only one of the two no agent can open.
- **A reference does not become a file at all on a local lane.** The gateway
  holds the decrypted bytes in memory under a 256-bit handle
  (`gateway/private_inputs.py`), the graph carries the handle where a filename
  used to be, and the loaders in
  `packages/comfyui-custom-nodes/hivemind-private-media` fetch them back over
  loopback. This covers stills, reference video and voice clips:
  `LoadImage` → `HivemindLoadPrivateImage`, `LoadVideo` →
  `HivemindLoadPrivateVideo`, `LoadAudio` → `HivemindLoadPrivateAudio`
  (`graphs.PRIVATE_LOADERS`). VideoHelperSuite's loaders are deliberately NOT
  in that table — `VHS_LoadVideo` returns four values and swapping it for a
  one-output node would break every downstream link. Every local submit goes
  through `graphs.private_prompt_body`, the only place the swap happens;
  `test_private_inputs.py` fails if a runner builds its own body. Gated per
  class on the lane reporting that node. Measured live: the staged plaintext
  existed 0.3 s instead of two hours.
- **A rented lane gets ciphertext, never plaintext.**
  `graphs.stage_private_inputs_on_remote_lane` encrypts each staged input under
  an AES-GCM key made for that job alone, pushes the ciphertext through the
  same upload route, and puts the key in the graph; the node decrypts in
  memory. What this protects is RESIDUE — whoever runs the box can read its
  memory and its ComfyUI history while the job runs, and renting means
  trusting it for that long, but what is left when the machine is recycled to
  the next tenant is ciphertext whose key was never written down. A rental
  without the pack falls back to the old plaintext push, so this is inert
  until rentals are provisioned with it.
- **A native runner gets a path that does not exist.** ltx-2-mlx reads a PATH,
  so the bytes cannot come from memory the way a ComfyUI lane's do — but the
  path does not have to name anything. `_anonymous_input_arguments` copies each
  input into a temporary that is unlinked while still open, so the inode
  survives only as a descriptor, and passes the child `/dev/fd/N` (`pass_fds`).
  The named copy is deleted the moment the nameless one exists, so for the
  whole render there is nothing in any directory to list. Measured end to end
  before shipping: the production command with `--image /dev/fd/3` and the
  named file already gone rendered 25 frames whose first frame is RGB
  (39,118,89) against a keyframe of (40,120,90) — the tool really read it.
  Turn it off with `ZIMG_ANONYMOUS_NATIVE_INPUTS=0`; a path that cannot be made
  nameless keeps its filename, so a failure costs privacy, never the render.
  `run_native_mlx_ltx_video` still clears its staging in a `finally` as the
  backstop: files the job MADE always go, files it was HANDED go only when they
  carry a staging prefix, because one may be a picture the owner uploaded.
- **Staged plaintext lives only while a job could still read it.** Inputs are
  written decrypted into ComfyUI's input dir because `LoadImage` reads files;
  they are deleted once nothing on this machine is running
  (`_nothing_can_be_reading_staged_inputs`), with the old two-hour ceiling kept
  only as a backstop. Do not lengthen either budget, and add any new staging
  prefix to `PRIVATE_INPUT_PREFIXES` — that tuple is both the sweeper's budget
  and the delete route's allowlist, so a name missing from it is undeletable.

## What went wrong once (so it does not again)

From 10 Aug to 6 Sep 2026 the requester key was an output's **sole**
recipient — the vault was cut *out*, not added to — and on 21 Aug the accounts
migration moved the vault file without the gateway's default path following,
so keyless jobs sealed to nothing durable. Browser device keys rotated and
evicted; 69 outputs across six vanished keys became unopenable by anyone. The
fixes are `bf342ee`, `6df66c3`, `890dbe6` and the per-job owner key. If you see
`[e2e-media] WARNING: no vault database`, a job is about to be sealed with no
durable recipient — treat it as data loss in progress, not noise.

Recovery tooling for an owner: `scripts/recover_sealed_media.py --account <id>`
(report), `--reseal` to write a vault copy from any key the machine holds,
including an agent copy. It never deletes and never prints media.

## Operating rules for agents here

- Never open, print, save or transmit the owner's private media. Recovery
  and verification tools stop at "did the key unwrap" — one operation before
  any media exists. Hand the owner tools they run themselves.
- Never run `passbook get`, and never handle passphrases, signing
  certificates or API keys. The agent key PEM is not a secret to protect
  *from* agents, but do not print it either.
- Work on copies of `data/` (with the `-wal`/`-shm` files) for any
  investigation; never modify the live databases.
- Never `pkill`/`killall` by pattern: the stack runs as supervised children
  and a pattern kill boot-loops it. Stop things by exact PID after proving
  what the PID is. Use `zimage-stack restart`, never per-service restarts.
- Prefer the shared skill shelf and existing scripts over new helpers; check
  `scripts/` first.
- **Never submit a graph to a ComfyUI lane directly** (`127.0.0.1:8188`,
  `:8198`, `:8199`; `/prompt` on the lanes has no auth). A file written into
  the output root outside the media gateway has no job record and no
  workspace claim, so the sweeper seals it with the machine key, not a vault,
  and the library files it under the Owner as unclaimed — whatever workspace
  the person was working in. Generate through the studio (`/local-ai/*`,
  `/api/media-studio/*`) or the gateway (`:8787` with `X-E2E-Owner-Pub`), and
  for a diagnostic render use `PreviewImage` into the lane's temp directory,
  never `SaveImage`. On 2026-09-07 a reproduction of the Upscale-button bug
  did exactly this with the owner's own image; the six `repro_*` renders had
  to be re-sealed and re-claimed by hand.
- Do not copy the owner's media, or crops of it, into a scratchpad or any
  other plaintext location, even while debugging. Compare inside the lane
  (temp/preview) or work on a synthetic image.
