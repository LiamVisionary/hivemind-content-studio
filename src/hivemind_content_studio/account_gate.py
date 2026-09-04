"""The sign-in gate: a Netflix-style workspace picker with passkeys first.

Standalone on purpose. The studio's React bundle lives under `/assets`, which is
gated, so a gate built inside the app would load a script that 401s and render
nothing — and it would hand the whole application to anyone who can reach the
port. This page is self-contained: it talks only to `/api/accounts` and the
WebAuthn routes, all of which are reachable before sign-in by design and none of
which return anything an attacker can work on offline.

Layout is adapted from Mix-Studio's profile gate (`public/index.html`'s
"profile gate (sign-in, Netflix-style)" block and the `.profile-tiles` /
`.profile-avatar-lg` rules in `public/style.css`, GPL-3.0 — see
THIRD_PARTY_NOTICES.md), restyled onto the palette the previous lock screen
used. What is NOT from the donor is everything behind it: their profiles are a
`profileId` column over shared plaintext with an optional PIN, and these are
separate accounts with separate zero-knowledge vaults.

## The handoff, and what it costs

Unlocking the vault needs key material the SERVER must never see, so the gate
passes it to the app through tab-scoped `sessionStorage` with a short expiry —
the same mechanism (and the same key) the previous owner lock screen already
used for the passphrase. Two shapes go through it:

  * password sign-in hands over the passphrase, exactly as before;
  * passkey sign-in hands over the WebAuthn PRF secret when the authenticator
    produced one, which is what lets Face ID actually decrypt rather than merely
    open the door.

Both are readable by any script running in this origin for the life of the tab.
That is a real exposure and it is why the window is short and the storage is
per-tab; it is not worse than the status quo, and the alternative — asking for
the passphrase again inside the app after already proving identity — is what
made people reuse a weak one.
"""

from __future__ import annotations

import os

from .gate_style import GATE_CSS

# The PRF salt is fixed per account and derived from a constant label, so the
# same passkey yields the same secret on every sign-in and on every device that
# syncs it. Changing this string would strand every PRF-wrapped vault.
PRF_SALT_LABEL = "hivemind-content-studio/vault-prf/v1"

# The env var the packaged desktop shell sets (docs/RELEASE.md). It changes two
# things on this page and nothing else: a solo workspace goes straight to its
# passkey, and adding a workspace moves behind Settings, because a desktop app
# for one person should not open on a chooser with one thing to choose.
DESKTOP_ENV = "CONTENT_STUDIO_DESKTOP"


def desktop_shell() -> bool:
    """True when this gate is being served inside the packaged desktop app."""
    return os.environ.get(DESKTOP_ENV, "").strip().lower() in {"1", "true", "yes", "on"}

_SCRIPT = r"""
const PRF_SALT_LABEL = "__PRF_SALT_LABEL__";
const HANDOFF_KEY = 'hivemind.ownerPassphrase.once';
const VAULT_HINT_KEY = 'hivemind.vaultUnlock.once';
const FIRST_RUN_KEY = 'hivemind.firstRun.once';
const HANDOFF_MS = 24 * 60 * 60 * 1000;
// Set by the packaged desktop shell (CONTENT_STUDIO_DESKTOP); false in a browser.
const DESKTOP = document.documentElement.dataset.desktop === '1';
// The whole avatar palette: the honey accent and two neutrals. A colour stored
// by an older build (violet, teal, rose, sky, lime) resolves to amber rather
// than to a class that does not exist, which used to paint a blank tile.
const TILE_COLOURS = new Set(['amber', 'sand', 'stone', 'slate']);
const tileClass = (colour) => (TILE_COLOURS.has(colour) ? colour : 'amber');

const el = (id) => document.getElementById(id);
const b64url = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text) => {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || 'That did not work. Try again.');
  return payload;
}

// The PRF salt has to be identical on every device that unlocks this vault, so
// it is derived from a constant label plus the account id — never from
// anything device-local.
async function prfSalt(accountId) {
  const material = new TextEncoder().encode(`${PRF_SALT_LABEL}:${accountId}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', material));
}

function handOff(accountId, { passphrase, prf, credentialId }) {
  const expiresAt = Date.now() + HANDOFF_MS;
  if (passphrase) {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ password: passphrase, expiresAt }));
  }
  // credentialId travels with the PRF secret because the wrapped master key is
  // stored per credential — the secret alone does not say which wrap it opens.
  sessionStorage.setItem(VAULT_HINT_KEY, JSON.stringify({
    accountId, method: prf ? 'passkey-prf' : (passphrase ? 'password' : 'passkey'),
    prf: prf || null, credentialId: credentialId || null, expiresAt,
  }));
}

// "Don't ask again" for the post-sign-in passkey offer. Deliberately
// localStorage, not the account: passkeys are per-device, so declining on a
// shared desktop should not silence the offer on a phone.
const offerHiddenKey = (accountId) => `hivemind.passkeyOffer.hidden.${accountId}`;
function passkeyOfferHidden(accountId) {
  try { return localStorage.getItem(offerHiddenKey(accountId)) === '1'; } catch { return false; }
}

let accounts = [];
let chosen = null;

function initial(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

function renderTiles() {
  const list = el('tiles');
  list.replaceChildren();
  for (const account of accounts) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    tile.setAttribute('aria-label', `Open ${account.name}`);
    const avatar = document.createElement('span');
    avatar.className = `avatar c-${tileClass(account.colour)}`;
    avatar.textContent = initial(account.name);
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = account.name;
    tile.append(avatar, name);
    if (account.has_passkey) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Passkey';
      tile.append(badge);
    }
    tile.addEventListener('click', () => choose(account));
    list.append(tile);
  }
  // The dashed "add" tile. Creation is owner-approved server-side, so showing
  // the tile to an unauthenticated visitor gives away nothing they could use.
  // Not in the desktop app: one person on one Mac meets a chooser with a second
  // thing on it every launch for a workspace they will make once, if ever. It
  // lives in Settings > Privacy > Workspaces there, which is also where the
  // "Add a workspace" button comes back to this card from.
  if (DESKTOP && !new URLSearchParams(location.search).has('workspace')) return;
  const add = document.createElement('button');
  add.className = 'tile';
  add.type = 'button';
  add.setAttribute('aria-label', 'Create a new workspace');
  const addAvatar = document.createElement('span');
  addAvatar.className = 'avatar add';
  addAvatar.textContent = '+';
  const addName = document.createElement('span');
  addName.className = 'tile-name';
  addName.textContent = 'New workspace';
  add.append(addAvatar, addName);
  add.addEventListener('click', showCreate);
  list.append(add);
}

// ── first run ────────────────────────────────────────────────────────────────
// A studio nobody has claimed yet has an owner row with no password and no
// passkey. There is nothing to pick between and nothing to sign in with, so the
// setup card replaces the picker until someone names the place.

function showSetup() {
  el('picker').hidden = true;
  el('setup').hidden = false;
  el('setup-name').focus();
}

async function setUpStudio(event) {
  event.preventDefault();
  el('setup-error').textContent = '';
  const name = el('setup-name').value.trim();
  const password = el('setup-password').value;
  if (password !== el('setup-confirm').value) {
    el('setup-error').textContent = 'Those two passphrases are different. Type the same one twice.';
    el('setup-confirm').value = '';
    el('setup-confirm').focus();
    return;
  }
  el('setup-submit').disabled = true;
  let payload;
  try {
    payload = await api('/api/accounts/setup', { name, password });
  } catch (error) {
    el('setup-submit').disabled = false;
    el('setup-error').textContent = error.message || 'Could not set this studio up.';
    return;
  }
  // Setup signed us in, which is exactly what enrolling a passkey needs — so
  // fall into the same offer a first password sign-in gets. The flag tells the
  // app this reload is the second half of setup, so it creates the vault
  // deliberately and shows the recovery key as step two instead of dropping it
  // on top of whatever studio loaded first.
  try { sessionStorage.setItem(FIRST_RUN_KEY, '1'); } catch {}
  chosen = payload.account;
  el('setup').hidden = true;
  if (window.PublicKeyCredential) {
    offerPasskey(chosen, password, { fromSetup: true });
    return;
  }
  handOff(chosen.id, { passphrase: password });
  location.reload();
}

// The post-sign-in passkey offer, shown on the sign-in card with its body
// swapped out. `fromSetup` hides the way back: on a fresh studio there is no
// other workspace to choose.
function offerPasskey(account, password, { fromSetup = false } = {}) {
  pendingPassword = password;
  el('who-avatar').className = `avatar c-${tileClass(account.colour)}`;
  el('who-avatar').textContent = initial(account.name);
  el('who-name').textContent = account.name;
  el('error').textContent = '';
  el('signin-body').hidden = true;
  el('enrol').hidden = false;
  el('back').hidden = fromSetup;
  el('signin').hidden = false;
  el('enrol-add').focus();
}

function choose(account) {
  chosen = account;
  el('back').hidden = false;
  el('picker').hidden = true;
  el('signin').hidden = false;
  el('who-avatar').className = `avatar c-${tileClass(account.colour)}`;
  el('who-avatar').textContent = initial(account.name);
  el('who-name').textContent = account.name;
  el('error').textContent = '';
  el('password').value = '';
  el('enrol').hidden = true;
  el('signin-body').hidden = false;
  // The passkey button only appears once this workspace HAS one. Registration
  // needs an open session, so before then the button could only refuse — the
  // offer to create a passkey comes right after a password sign-in instead,
  // which is the one moment enrolment can actually succeed.
  el('passkey').hidden = !account.has_passkey;
  el('password-form').hidden = !account.has_password;
  el('divider').hidden = !account.has_password || !account.has_passkey;
  if (account.has_passkey) el('passkey').focus(); else el('password').focus();
}

function back() {
  chosen = null;
  el('signin').hidden = true;
  el('create').hidden = true;
  el('picker').hidden = false;
}

function showCreate() {
  chosen = null;
  el('picker').hidden = true;
  el('signin').hidden = true;
  el('create').hidden = false;
  el('create-error').textContent = '';
  el('create-form').reset();
  el('create-submit').disabled = false;
  el('create-passkey').disabled = false;
  const owner = accounts.find((account) => account.is_owner);
  const passkeyApproval = Boolean(owner && owner.has_passkey && window.PublicKeyCredential);
  el('create-passkey').hidden = !passkeyApproval;
  el('create-divider').hidden = !passkeyApproval;
  el('create-name').focus();
}

function createFail(message) {
  el('create-error').textContent = message;
  el('create-submit').disabled = false;
  el('create-passkey').disabled = false;
}

/**
 * Creating a workspace from the gate is a three-step dance: prove the owner
 * approves (which sets the session cookie the create route checks), create,
 * then unlock the NEW workspace so the reload lands in it with its own
 * passphrase handed off for the vault. The approval step exists because the
 * server only lets a signed-in OWNER add workspaces — the picker is reachable
 * unauthenticated, and a gate that let anyone mint themselves a workspace
 * would hand an intruder a foothold. This function is steps two and three,
 * shared by both approval paths.
 */
async function createApproved(name, password) {
  try {
    const created = await api('/api/accounts', { name, password });
    await api('/api/accounts/unlock', { account_id: created.account.id, password });
    handOff(created.account.id, { passphrase: password });
    location.reload();
  } catch (error) {
    // The owner approval left a signed-in session behind. Drop it so the
    // gate's invariant — picker visible means nobody is signed in — holds.
    try { await api('/api/accounts/sign-out', {}); } catch {}
    throw error;
  }
}

async function createWorkspace(event) {
  event.preventDefault();
  el('create-error').textContent = '';
  const owner = accounts.find((account) => account.is_owner);
  if (!owner) {
    el('create-error').textContent = 'No owner workspace exists to approve this.';
    return;
  }
  const name = el('create-name').value.trim();
  const password = el('create-password').value;
  el('create-submit').disabled = true;
  el('create-passkey').disabled = true;
  try {
    await api('/api/accounts/unlock', { account_id: owner.id, password: el('create-owner-password').value });
  } catch (error) {
    createFail(/wrong password/i.test(error.message || '')
      ? "That is not the owner's password." : (error.message || 'Owner approval failed.'));
    return;
  }
  try {
    await createApproved(name, password);
  } catch (error) {
    createFail(error.message || 'Could not create the workspace.');
  }
}

// Owner approval by passkey: the same assertion the sign-in card performs,
// scoped to the owner account, minus the PRF read — approval needs the owner's
// IDENTITY, not their vault key, and the workspace being created gets its own.
async function createWorkspaceWithPasskey() {
  el('create-error').textContent = '';
  const owner = accounts.find((account) => account.is_owner);
  if (!owner) {
    el('create-error').textContent = 'No owner workspace exists to approve this.';
    return;
  }
  // The passkey button bypasses form submission, so the fields it depends on
  // are validated by hand — the browser bubble points at whichever is missing.
  if (!el('create-name').reportValidity() || !el('create-password').reportValidity()) return;
  const name = el('create-name').value.trim();
  const password = el('create-password').value;
  el('create-submit').disabled = true;
  el('create-passkey').disabled = true;
  try {
    const { publicKey } = await api('/api/accounts/webauthn/authenticate/options', { account_id: owner.id });
    const credential = await navigator.credentials.get({
      publicKey: {
        ...publicKey,
        challenge: unb64url(publicKey.challenge),
        allowCredentials: (publicKey.allowCredentials || []).map((entry) => ({
          ...entry, id: unb64url(entry.id),
        })),
      },
    });
    if (!credential) throw new Error('No passkey was offered.');
    await api('/api/accounts/webauthn/authenticate', {
      credential_id: credential.id,
      client_data_json: b64url(credential.response.clientDataJSON),
      authenticator_data: b64url(credential.response.authenticatorData),
      signature: b64url(credential.response.signature),
    });
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      createFail('Owner approval was cancelled.');
      return;
    }
    createFail(error.message || 'Owner approval failed.');
    return;
  }
  try {
    await createApproved(name, password);
  } catch (error) {
    createFail(error.message || 'Could not create the workspace.');
  }
}

function fail(message) {
  el('error').textContent = message;
  el('passkey').disabled = false;
}

async function signInWithPasskey(account) {
  if (!window.PublicKeyCredential) {
    fail('This browser has no passkey support. Use your password below.');
    return;
  }
  if (!account.has_passkey) {
    fail('This workspace has no passkey yet. Sign in with your password once and you can add one.');
    el('password').focus();
    return;
  }
  el('passkey').disabled = true;
  el('error').textContent = '';
  try {
    const { publicKey } = await api('/api/accounts/webauthn/authenticate/options',
      { account_id: account.id });
    const salt = await prfSalt(account.id);
    const credential = await navigator.credentials.get({
      publicKey: {
        ...publicKey,
        challenge: unb64url(publicKey.challenge),
        allowCredentials: (publicKey.allowCredentials || []).map((entry) => ({
          ...entry, id: unb64url(entry.id),
        })),
        // Where the authenticator supports it, this returns a stable secret we
        // can unwrap the vault master key with. Where it does not, the results
        // are simply absent and the app falls back to the device-wrapped copy.
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    if (!credential) { fail('No passkey was offered.'); return; }
    const results = credential.getClientExtensionResults?.() || {};
    const secret = results.prf && results.prf.results && results.prf.results.first;
    const payload = await api('/api/accounts/webauthn/authenticate', {
      credential_id: credential.id,
      client_data_json: b64url(credential.response.clientDataJSON),
      authenticator_data: b64url(credential.response.authenticatorData),
      signature: b64url(credential.response.signature),
    });
    handOff(payload.account.id, {
      prf: secret ? b64url(secret) : null,
      credentialId: credential.id,
    });
    location.reload();
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      fail('Passkey sign-in was cancelled.');
      return;
    }
    fail(error.message || 'Passkey sign-in failed.');
  }
}

async function signInWithPassword(event) {
  event.preventDefault();
  el('error').textContent = '';
  const password = el('password').value;
  let payload;
  try {
    payload = await api('/api/accounts/unlock', { account_id: chosen.id, password });
  } catch (error) {
    fail(error.message || 'Wrong password.');
    return;
  }
  // Signed in. Before handing over, offer to make the NEXT sign-in a passkey —
  // this is the only moment we hold both a proven session and the passphrase,
  // which is exactly what enrolling against the vault needs.
  if (!chosen.has_passkey && window.PublicKeyCredential && !passkeyOfferHidden(chosen.id)) {
    offerPasskey(chosen, password);
    return;
  }
  handOff(payload.account.id, { passphrase: password });
  location.reload();
}

let pendingPassword = null;

function finishWithPassword(extra = {}) {
  handOff(chosen.id, { passphrase: pendingPassword, ...extra });
  location.reload();
}

/**
 * Register a passkey for this workspace, then immediately take one PRF reading.
 *
 * The reading matters: the vault master key can only be wrapped by code that
 * holds it, which lives in the app bundle, not here. So the gate registers the
 * credential and passes the PRF secret forward with the passphrase, and the app
 * does the wrap on its next boot — no second biometric prompt later.
 */
async function addPasskey() {
  el('enrol-error').textContent = '';
  el('enrol-add').disabled = true;
  try {
    // The empty body matters: api() sends GET without one, and a GET here
    // falls through the POST-only route into the static mount's 404.
    const { publicKey } = await api('/api/accounts/webauthn/register/options', {});
    const salt = await prfSalt(chosen.id);
    const created = await navigator.credentials.create({
      publicKey: {
        ...publicKey,
        challenge: unb64url(publicKey.challenge),
        user: { ...publicKey.user, id: unb64url(publicKey.user.id) },
        excludeCredentials: (publicKey.excludeCredentials || []).map((entry) => ({
          ...entry, id: unb64url(entry.id),
        })),
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    if (!created) throw new Error('No passkey was created.');
    const spki = created.response.getPublicKey && created.response.getPublicKey();
    if (!spki) throw new Error('This authenticator uses a key type the studio cannot read.');
    const extensions = created.getClientExtensionResults?.() || {};
    const prfCapable = Boolean(extensions.prf && (extensions.prf.enabled || extensions.prf.results));
    await api('/api/accounts/webauthn/register', {
      credential_id: created.id,
      public_key: b64url(spki),
      algorithm: created.response.getPublicKeyAlgorithm(),
      client_data_json: b64url(created.response.clientDataJSON),
      label: 'This device',
      prf: prfCapable,
    });

    // One assertion now, purely to read the PRF secret out.
    let secret = null;
    if (prfCapable) {
      try {
        const options = await api('/api/accounts/webauthn/authenticate/options', { account_id: chosen.id });
        const assertion = await navigator.credentials.get({
          publicKey: {
            ...options.publicKey,
            challenge: unb64url(options.publicKey.challenge),
            allowCredentials: (options.publicKey.allowCredentials || []).map((entry) => ({
              ...entry, id: unb64url(entry.id),
            })),
            extensions: { prf: { eval: { first: salt } } },
          },
        });
        const results = assertion?.getClientExtensionResults?.() || {};
        secret = results.prf?.results?.first || null;
      } catch {
        // No PRF reading available: the app falls back to the device wrap,
        // which still gives a password-free unlock on this browser.
        secret = null;
      }
    }
    finishWithPassword({ prf: secret ? b64url(secret) : null, credentialId: created.id });
  } catch (error) {
    el('enrol-add').disabled = false;
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      el('enrol-error').textContent = 'Passkey setup was cancelled.';
      return;
    }
    el('enrol-error').textContent = error.message || 'Could not add a passkey.';
  }
}

async function start() {
  let payload;
  try {
    payload = await api('/api/accounts');
    accounts = payload.accounts || [];
  } catch {
    el('lede').textContent = 'This studio is not reachable right now.';
    return;
  }
  if (payload.setup_required) { showSetup(); return; }
  renderTiles();
  // Settings > Workspaces sends people here to add one; the picker is where
  // that lives, so open the create card rather than making them find it.
  if (new URLSearchParams(location.search).has('workspace')) { showCreate(); return; }
  // One workspace with a passkey has nothing to choose between: two clicks and
  // a tile stood between the person and Touch ID on every single launch. Go
  // straight to the prompt; "Choose a different workspace" stays on the card,
  // and a cancelled prompt lands on that card with its password form.
  if (accounts.length === 1 && accounts[0].has_passkey) {
    choose(accounts[0]);
    signInWithPasskey(accounts[0]);
  }
}

el('setup-form').addEventListener('submit', setUpStudio);
el('passkey').addEventListener('click', () => signInWithPasskey(chosen));
el('password-form').addEventListener('submit', signInWithPassword);
el('back').addEventListener('click', back);
el('create-form').addEventListener('submit', createWorkspace);
el('create-passkey').addEventListener('click', createWorkspaceWithPasskey);
el('create-back').addEventListener('click', back);
el('enrol-add').addEventListener('click', addPasskey);
el('enrol-skip').addEventListener('click', () => {
  if (el('enrol-hide').checked) {
    try { localStorage.setItem(offerHiddenKey(chosen.id), '1'); } catch {}
  }
  finishWithPassword();
});
start();
"""

_KEY_GLYPH = (
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    '<path d="M15.5 8.5a4 4 0 1 0-3.9 4L9 15.1V17H7v2H4.9L3 17.1v-2.2l6.1-6.1a4 4 0 0 0 6.4-.3z"/>'
    '<circle cx="16.5" cy="7.5" r="1"/></svg>'
)

_HIVE_GLYPH = (
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5z"/>'
    '<path d="M12 8.2 15.4 10v4L12 15.8 8.6 14v-4L12 8.2z" fill="currentColor" stroke="none"/></svg>'
)


def account_gate_html(desktop: bool | None = None) -> str:
    """The whole gate: picker, passkey-first sign-in, password underneath.

    `desktop` defaults to the CONTENT_STUDIO_DESKTOP env var the packaged shell
    sets; pass it explicitly in tests.
    """
    is_desktop = desktop_shell() if desktop is None else bool(desktop)
    return f"""<!doctype html>
<html lang="en" data-desktop="{'1' if is_desktop else '0'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex,nofollow">
  <title>Hivemind Content Studio</title>
  <style>{GATE_CSS}</style>
</head>
<body>
  <main>
    <div id="picker">
      <div style="display:grid;justify-items:center;gap:6px;margin-bottom:26px">
        <div class="mark" aria-hidden="true">{_HIVE_GLYPH}</div>
        <p class="eyebrow">Hivemind Content Studio</p>
        <h1>Who's working?</h1>
        <p class="lede" id="lede">Your library and your clips are sealed to your own key —
          another workspace on this Mac cannot open them. Working files live encrypted on this
          computer. Settings &gt; Privacy says exactly which is which.</p>
      </div>
      <ul class="tiles" id="tiles"></ul>
    </div>

    <section class="card" id="setup" hidden aria-labelledby="setup-title">
      <div style="display:grid;justify-items:center;gap:6px">
        <div class="mark" aria-hidden="true">{_HIVE_GLYPH}</div>
        <p class="eyebrow">Hivemind Content Studio</p>
      </div>
      <h2 id="setup-title" style="text-align:center">Name your studio and set a passphrase</h2>
      <p class="lede" style="margin:0 auto">Nobody has opened this studio yet. The name is what you'll
        see on the sign-in screen. The passphrase unlocks your library and encrypts everything in it,
        so keep it somewhere safe — nobody can reset it for you.</p>
      <form id="setup-form">
        <label>Studio name
          <input id="setup-name" type="text" autocomplete="off" maxlength="40" required>
        </label>
        <label>Passphrase
          <input id="setup-password" type="password" autocomplete="new-password" required>
        </label>
        <label>Type it again
          <input id="setup-confirm" type="password" autocomplete="new-password" required>
        </label>
        <button class="primary" id="setup-submit" type="submit">Open the studio</button>
      </form>
      <p class="error" id="setup-error" role="alert"></p>
    </section>

    <section class="card" id="signin" hidden aria-labelledby="signin-title">
      <div class="who">
        <span class="avatar" id="who-avatar" aria-hidden="true"></span>
        <div>
          <h2 id="signin-title">Sign in</h2>
          <p class="lede" style="text-align:left;margin:2px 0 0" id="who-name"></p>
        </div>
      </div>

      <div id="signin-body" style="display:grid;gap:14px">
        <button class="primary" id="passkey" type="button" style="width:100%">
          {_KEY_GLYPH}<span id="passkey-label">Unlock with passkey</span>
        </button>

        <div class="divider" id="divider"><span>or</span></div>

        <form id="password-form">
          <label>Password
            <input id="password" type="password" autocomplete="current-password" required>
          </label>
          <button class="secondary" type="submit">Unlock with password</button>
        </form>
      </div>

      <div id="enrol" hidden style="display:grid;gap:12px">
        <p class="lede" style="text-align:left;margin:0">Signed in. Add a passkey so next time this
          workspace opens with Touch ID or Face ID instead of a password.</p>
        <button class="primary" id="enrol-add" type="button">{_KEY_GLYPH}<span>Add a passkey</span></button>
        <button class="secondary" id="enrol-skip" type="button">Not now</button>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#6f6f78;cursor:pointer">
          <input type="checkbox" id="enrol-hide" style="width:auto;height:auto;margin:0;accent-color:#f6b21b">
          Don't ask again on this device
        </label>
        <p class="error" id="enrol-error" role="alert"></p>
      </div>

      <p class="error" id="error" role="alert"></p>
      <div style="display:grid;justify-items:center">
        <button class="back" id="back" type="button">Choose a different workspace</button>
      </div>
    </section>

    <section class="card" id="create" hidden aria-labelledby="create-title">
      <div class="who">
        <span class="avatar add" aria-hidden="true">+</span>
        <div>
          <h2 id="create-title">New workspace</h2>
          <p class="lede" style="text-align:left;margin:2px 0 0">Its own library, its own key.</p>
        </div>
      </div>
      <form id="create-form">
        <label>Workspace name
          <input id="create-name" type="text" autocomplete="off" maxlength="40" required>
        </label>
        <label>Its password
          <input id="create-password" type="password" autocomplete="new-password" required>
        </label>
        <button class="primary" id="create-passkey" type="button" hidden>
          {_KEY_GLYPH}<span>Approve with owner passkey</span>
        </button>
        <div class="divider" id="create-divider" hidden><span>or</span></div>
        <label>Owner password — adding a workspace needs the owner's approval
          <input id="create-owner-password" type="password" autocomplete="current-password" required>
        </label>
        <button class="secondary" id="create-submit" type="submit">Create workspace</button>
      </form>
      <p class="error" id="create-error" role="alert"></p>
      <div style="display:grid;justify-items:center">
        <button class="back" id="create-back" type="button">Choose a different workspace</button>
      </div>
    </section>
  </main>
  <script>{_SCRIPT.replace("__PRF_SALT_LABEL__", PRF_SALT_LABEL)}</script>
</body>
</html>"""
