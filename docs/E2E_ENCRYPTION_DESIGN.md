# Client-side end-to-end encryption (owner vault)

Goal: content is decryptable **only inside the owner's browser**. The server
stores ciphertext and wrapped key material, and holds **no key that can decrypt
anything on its own**. Owner-session auth still gates the API, but auth is no
longer sufficient to read plaintext — only the passphrase-derived key (held in
the browser) can.

## Vault identity (created once, in the browser)

All values below are generated with WebCrypto in the browser. The server only
ever receives the *public* / *wrapped* forms.

- `MK` — random AES-256-GCM master key. Never leaves the browser in the clear.
- `salt` — 16 random bytes for the passphrase KDF.
- `PK = PBKDF2-SHA256(passphrase, salt, 600_000)` — passphrase-derived wrapping key.
- `wrapped_mk_pass = AES-GCM(PK, MK)` — MK sealed under the passphrase.
- `RK` — random 32-byte recovery key, shown to the owner exactly once (base32).
- `wrapped_mk_recovery = AES-GCM(RK, MK)` — MK sealed under the recovery key.
- `(PUB, PRIV)` — RSA-OAEP-2048 keypair for server-side media sealing.
- `wrapped_priv = AES-GCM(MK, PRIV)` — private key sealed under MK.

The server persists only: `salt`, `wrapped_mk_pass`, `wrapped_mk_recovery`,
`PUB`, `wrapped_priv`. It can reconstruct **none** of `MK`, `PK`, `RK`, `PRIV`.

## Unlock

Browser fetches the vault identity, runs `PBKDF2(passphrase, salt)` to get `PK`,
unwraps `MK`, then unwraps `PRIV`. `MK`/`PRIV` live only in browser memory for
the session. A wrong passphrase fails the GCM tag — no oracle on the server.
Forgotten passphrase → unlock with `RK` instead (unwraps the recovery copy).

## Data at rest

- **Client-authored state** (composer draft: prompt, reference selection, upload
  grid, preferences): browser encrypts each blob with `MK` (AES-GCM, random
  nonce) before PUT; decrypts after GET. Server stores opaque ciphertext.
  *(Phase 1 — implemented + tested.)*
- **Server-generated media** (images/videos): at generation the server has the
  plaintext once (it made the pixels). Instead of encrypting under a server-held
  key, it: generates a random per-file DEK, AES-GCM encrypts the file, then seals
  the DEK to `PUB` (RSA-OAEP). Stores `ciphertext + rsa_wrapped_dek`. The server
  can **encrypt** new outputs anytime (public key) but can **never decrypt**
  them. Viewing: browser fetches ciphertext + wrapped DEK, RSA-unwraps the DEK
  with `PRIV`, AES-decrypts in-page, renders via a blob URL.
  *(Phase 2 — crypto is asymmetric-by-design so background generation keeps
  working; wiring it into the live gateway sweeper + mobile canvas + Comfy
  output handling + migrating existing `.zenc` is a separate, higher-risk step.)*

## What this removes

Today the AES key is a macOS Keychain secret readable by any process running as
the user (`security find-generic-password -w` returns it silently). Under the
vault, no such key exists: at rest there is only ciphertext + material sealed to
keys that live only in the browser. A local process, a backup, disk theft, or an
authenticated-but-not-unlocked API caller all get ciphertext.

Residual, unavoidable: the server generates the pixels, so plaintext exists in
server memory/disk for the instant between generation and sealing.

## Phase 2 status and remaining integration

**Proven (this repo):** the seal ↔ unseal crypto is implemented and
cross-language interop-tested — `packages/media-gateway/media_seal.py` seals to
the vault public key, and `e2eVault.decryptMedia` recovers it in the browser;
a different vault cannot (`tests/mediaSealInterop.test.js`). `media_seal`
also reads the owner public key from the studio vault DB.

**Remaining wiring (not yet landed — needs coordination + real-browser verify):**
1. **Gateway sweeper** (`packages/media-gateway/app.py`, `encrypt_output_file`):
   when a vault public key exists, seal new outputs with `media_seal.seal` into
   the E2E envelope format instead of the openssl/Keychain `.zenc`. Keep both
   formats readable during transition.
2. **Serve path** (`send_output_file` / the `/image/` dispatch): for E2E-format
   files the gateway can no longer decrypt — it returns `{ciphertext, wrapped_dek}`
   for the client to decrypt, rather than plaintext bytes. Legacy `.zenc` still
   decrypts server-side until migrated.
3. **Clients decrypt in-page:** the display surfaces that render generated media
   must fetch the envelope and `decryptMedia` → blob URL. Primary surface is the
   `comfyui-mobile` React app (the `..._mobile_` videos) — it needs the vault
   ported in (unlock with the owner password, hold keys) or a decrypting Service
   Worker in front of `/image/` so `<img>/<video>` tags are unchanged.
4. **Migrate existing `.zenc`** to the E2E envelope — LAST, only after 1–3 are
   verified, and only with the plaintext-recoverable originals preserved until a
   client decrypt is confirmed. Re-encrypting before the client path works would
   make existing videos unviewable.

Order matters: 1→2→3 must ship together (E2E media is unservable by legacy
clients), and 4 is destructive so it comes only after end-to-end verification in
the real browser.

## Phase 2 — what is built (flag OFF by default)

- Gateway seal: `media_seal.py` + `app.py` `seal_output_to_e2e` / `encrypt_output_file`
  seal new output to `<name>.e2e` when `ZIMG_E2E_MEDIA=1` AND a vault public key
  exists; otherwise unchanged (legacy `.zenc`). Tested: `test_e2e_media.py`.
- Gateway serve: `send_output_file` returns the `.e2e` envelope with
  `X-E2E-Media: 1`; the gateway holds no key to decrypt it.
- Client decrypt: `e2eMedia.js` `resolveMediaSrc(url)` fetches, and for
  `X-E2E-Media` responses decrypts in-page (`decryptMedia`) → blob URL; strictly
  fail-open for everything else. Wired into OpenGen `showImageInCanvas`. Tested
  cross-language: `tests/e2eMedia.test.js`, `tests/mediaSealInterop.test.js`.

## Enable + verify runbook (do in this order)

1. Open the studio in the browser and unlock (creates the vault; save the
   recovery key). Confirm `sqlite3 data/owner-vault.sqlite3 "select json_extract(identity_json,'$.public_key') from vault_identity"` is non-empty.
2. Set `ZIMG_E2E_MEDIA=1` in the gateway env and restart the stack.
3. Generate ONE new image/video. On disk, confirm it is `*.e2e` (not `.zenc`):
   `ls ~/.comfy-private.noindex/output`. Confirm the gateway CANNOT decrypt it
   (there is no openssl/Keychain path for `.e2e`).
4. Confirm it renders in YOUR browser (OpenGen), and that a shell cannot recover
   it (no `security find-generic-password` decrypt exists for `.e2e`).
5. Wire the SAME `resolveMediaSrc` into the `comfyui-mobile` app (its video
   surface) — until then, `..._mobile_` videos viewed in the mobile canvas show
   the envelope, not the video.
6. ONLY after 3–5 verify: migrate existing `.zenc` → `.e2e`:
   `python packages/media-gateway/migrate_media_to_e2e.py --dry-run` then without
   `--dry-run` (keeps `.zenc` originals). After confirming a migrated file
   decrypts in your browser, re-run with `--delete-originals` to remove the
   machine-decryptable copies. Destructive and irreversible.

## Hard prerequisite (only the owner can do this)

The vault is created in the browser (WebCrypto) so the server never holds the
key — therefore **nothing can be sealed until the owner opens the studio and
unlocks once**, creating the vault public key. The server cannot fabricate it;
that is the E2E guarantee, not a limitation.

## Known remaining gap: the mobile canvas

`comfyui-mobile` authenticates to the gateway with a bearer token, not the owner
password, so it cannot derive the vault key. Making its video surface decrypt
E2E media requires adding an owner-password vault unlock flow to that app plus
routing its media-display sites through `resolveMediaSrc`. Until then, `..._mobile_`
videos viewed in the mobile canvas show the envelope, not the video (they still
view fine in the unified studio once its history display is wired the same way).
