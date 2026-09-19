// In-app vault unlock. A tab can hold a valid owner-session cookie while its
// per-tab key is absent (the gate only runs when the cookie is missing),
// leaving the E2E vault locked: sealed media can't decrypt and shows "vault
// locked" tiles. Any of those affordances dispatches VAULT_UNLOCK_REQUEST_EVENT
// and this modal runs the gate's own flow.
//
// "The gate's own flow" used to mean only half of it. The gate leads with the
// passkey and offers the password underneath; this modal asked for a password
// and never mentioned a passkey at all, so the same workspace opened with Touch
// ID on one screen and refused to say so on the other. Both screens now read
// `vaultUnlockOptions` (lib/vaultUnlockPolicy.js) — one rule, carried verbatim
// into the gate because it cannot import this bundle — so a workspace with a
// passkey always shows both ways in, and a workspace without one always carries
// the offer to add one, off until someone asks.
//
// It does NOT reload. The shell keeps every studio mounted so navigation never
// costs a composer, and a reload here threw exactly that away to answer a
// question the running page can answer itself: retry the bootstrap, forget the
// stale "sealed" verdicts, and tell the surfaces holding a locked tile to
// resolve again. The reload survives only as the fallback for a bootstrap that
// did not take after a proven password, where a fresh boot really is the
// repair. A passkey that signs in without opening the vault is NOT that case —
// it has a name and a fix, and says both.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useWindowEvent } from '../hooks/hooks.js';
import { clearMediaSealFailures } from '../lib/e2eMedia.js';
import { assertPasskey, passkeysAvailable, registerPasskey } from '../lib/vaultPasskey.js';
import {
  announceVaultUnlocked,
  currentWorkspace,
  retryVaultBootstrap,
  stashVaultHint,
  unlockOwnerSession,
  VAULT_UNLOCK_REQUEST_EVENT,
} from '../lib/vaultSession.js';
import { vaultUnlockOptions } from '../lib/vaultUnlockPolicy.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, Spinner, TextInput, Toggle } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

// One sentence per outcome, each naming what to do next. Server text never
// reaches this screen.
function passwordError(status) {
  if (status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (status === 0) return 'Could not reach the studio. Check the connection and try again.';
  return 'Wrong password. Try again.';
}

function passkeyError(reason, hasPassword) {
  if (reason === 'cancelled') return 'Passkey unlock was cancelled.';
  if (reason === 'unsupported') return 'This browser cannot run a passkey here. Use your password below.';
  if (reason === 'offline') return 'Could not reach the studio. Check the connection and try again.';
  if (reason === 'mismatch') return 'That passkey opens a different workspace. Reload the studio to sign in to that one.';
  return hasPassword
    ? 'That passkey did not open this workspace. Use your password below.'
    : 'That passkey did not open this workspace.';
}

// A passkey CAN prove who you are and still not decrypt: the authenticator had
// no PRF extension to derive a key from, and this browser holds no remembered
// copy either. That is a real state with a real repair, not a failure.
const PASSKEY_CANNOT_DECRYPT =
  'That passkey signed you in, but it cannot decrypt on this device yet. '
  + 'Enter your password once — this browser opens with the passkey alone after that.';

function enrolError(reason) {
  if (reason === 'cancelled') return 'Unlocked. The passkey was not added — setup was cancelled.';
  if (reason === 'keytype') return 'Unlocked. This authenticator uses a key type the studio cannot read, so no passkey was added.';
  return 'Unlocked. The passkey could not be added — try again from this screen next time.';
}

export function VaultUnlockModal() {
  const [open, setOpen] = useState(false);
  // null while the workspace is being read; then { ok, account, status }.
  const [workspace, setWorkspace] = useState(null);
  const [password, setPassword] = useState('');
  // Two slots, not one: a passkey's "cancelled" under the Studio password label
  // reads as a password problem, and the sentence that says "use your password"
  // has to sit above the field it is pointing at.
  const [error, setError] = useState('');
  const [passkeyFailure, setPasskeyFailure] = useState('');
  const [busy, setBusy] = useState('');
  const [enrol, setEnrol] = useState(false);
  const bodyRef = useRef(null);

  useWindowEvent(VAULT_UNLOCK_REQUEST_EVENT, useCallback(() => setOpen(true), []));

  const load = useCallback(async () => {
    setWorkspace(null);
    const current = await currentWorkspace();
    setWorkspace(current);
    // Where the toggle starts is the policy's call, not this file's — a default
    // written here is a second place for the rule to live.
    setEnrol(vaultUnlockOptions(current.account, passkeysAvailable()).enrolDefault);
  }, []);

  useEffect(() => {
    if (!open) return;
    load();
  }, [open, load]);

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setError('');
    setPasskeyFailure('');
  };

  // The vault is open in this tab: forget the stale "sealed" verdicts and tell
  // the surfaces holding a locked tile to resolve again. Reset inline rather
  // than through close(), whose guard reads `busy` from this render's closure —
  // still true here, which would leave the modal open over an unlocked vault.
  const settle = () => {
    clearMediaSealFailures();
    announceVaultUnlocked();
    setBusy('');
    setPassword('');
    setError('');
    setPasskeyFailure('');
    setOpen(false);
  };

  const account = workspace?.account || null;
  const options = vaultUnlockOptions(account, passkeysAvailable());

  // Focus the way in the policy leads with, once there IS one. Modal's own
  // autofocus cannot do it here: it queries the panel at open time, when this
  // body is still a spinner, settles on the panel itself, and its rAF then
  // takes focus BACK off whatever mounted in between. So nothing was ever
  // focused — not the passkey button, and not the password field either, which
  // has carried an `autoFocus` that never won since the day it was written.
  useEffect(() => {
    if (!open || workspace === null) return undefined;
    const raf = requestAnimationFrame(() => {
      try { bodyRef.current?.querySelector('[data-autofocus]')?.focus({ preventScroll: true }); } catch { /* detached */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, workspace]);

  const unlockWithPasskey = async () => {
    if (busy || !account) return;
    setBusy('passkey');
    setError('');
    setPasskeyFailure('');
    const proved = await assertPasskey(account.id);
    if (!proved.ok) {
      setBusy('');
      setPasskeyFailure(passkeyError(proved.reason, options.password));
      return;
    }
    stashVaultHint({ accountId: proved.accountId, credentialId: proved.credentialId, prf: proved.prf });
    const ready = await retryVaultBootstrap();
    if (!ready) {
      setBusy('');
      setPasskeyFailure(PASSKEY_CANNOT_DECRYPT);
      return;
    }
    settle();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!password || busy || !account) return;
    setBusy('password');
    setError('');
    setPasskeyFailure('');
    const result = await unlockOwnerSession(password, account);
    if (!result.ok) {
      setBusy('');
      setError(passwordError(result.status));
      return;
    }
    // The one moment this tab holds both a proven password and an open session,
    // which is exactly what enrolling a passkey against the vault needs: the
    // credential is registered here and its PRF secret handed to the bootstrap,
    // which wraps the master key for it a few lines below. Enrolment must never
    // cost the unlock, so a failure is carried out and said afterwards.
    let enrolFailure = '';
    if (enrol && options.enrol) {
      const added = await registerPasskey(account.id);
      if (added.ok) {
        stashVaultHint({ accountId: account.id, credentialId: added.credentialId, prf: added.prf });
      } else {
        // Said even when it was cancelled: the toggle was ticked, so silence
        // would read as "added" on a screen that is about to disappear.
        enrolFailure = enrolError(added.reason);
      }
    }
    // The passphrase is stashed exactly as the gate leaves it; now spend it here
    // instead of on a reload.
    const ready = await retryVaultBootstrap();
    if (!ready) {
      // The password was right and the vault still did not open in this tab. A
      // full boot re-runs the gate's own handoff, which is the one path left —
      // better than leaving the person looking at locked tiles.
      window.location.reload();
      return;
    }
    settle();
    if (enrolFailure) toast(enrolFailure);
  };

  if (!open) return null;

  const loading = workspace === null;
  const unreachable = !loading && !workspace.ok;

  return (
    <Modal open title="Unlock your vault" size="sm" onClose={close} dismissable={!busy}>
      <div ref={bodyRef} className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-honey" />
          <p className="text-[13px] leading-relaxed text-ink2">
            {<>Your media is end-to-end encrypted and the key lives only in an unlocked tab. This tab doesn&rsquo;t have it yet — unlock to decrypt here.</>}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-ink3">
            <Spinner size={14} />
            <span>Reading this workspace&rsquo;s sign-in methods…</span>
          </div>
        ) : null}

        {unreachable ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-ink2">
              {workspace.status === 0
                ? 'Could not reach the studio to see how this workspace signs in. It is usually still starting — give it a moment.'
                : 'This tab is not signed in to a workspace any more. Reload the studio to sign in again.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" onClick={load}>Try again</Button>
            </div>
          </div>
        ) : null}

        {options.passkey ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              icon="key"
              className="w-full"
              onClick={unlockWithPasskey}
              loading={busy === 'passkey'}
              disabled={Boolean(busy)}
              data-autofocus
            >
              Unlock with passkey
            </Button>
            {passkeyFailure ? (
              <p className="text-xs leading-relaxed text-danger" role="alert">{passkeyFailure}</p>
            ) : null}
          </div>
        ) : null}

        {options.divider ? (
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-ink3">
            <span className="h-px flex-1 bg-line1" />
            <span>or</span>
            <span className="h-px flex-1 bg-line1" />
          </div>
        ) : null}

        {options.password ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label="Studio password"
              error={error}
              hint="Sealed media in this tab opens as soon as you unlock — nothing you have open is lost."
            >
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                data-autofocus={options.passkey ? undefined : ''}
                disabled={Boolean(busy)}
              />
            </Field>
            {options.enrol ? (
              <Field
                label="Add a passkey after unlocking"
                hint="Next time this workspace opens with Touch ID or Face ID instead of a password, on this device."
              >
                <Toggle
                  checked={enrol}
                  onChange={setEnrol}
                  label="Add a passkey after unlocking"
                  disabled={Boolean(busy)}
                />
              </Field>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={Boolean(busy)}>Cancel</Button>
              <Button variant="primary" type="submit" loading={busy === 'password'} disabled={!password || Boolean(busy)}>
                Unlock
              </Button>
            </div>
          </form>
        ) : null}

        {!options.password && !loading && !unreachable ? (
          <>
            {passkeyFailure ? (
              <p className="text-xs leading-relaxed text-danger" role="alert">{passkeyFailure}</p>
            ) : null}
            {options.stuck ? (
              <p className="text-[13px] leading-relaxed text-ink2">
                This workspace opens with a passkey, and this browser cannot run one. Open the studio
                in Safari or Chrome on a device that holds the passkey.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close} disabled={Boolean(busy)}>Cancel</Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
