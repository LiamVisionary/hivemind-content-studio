// Settings → Privacy & vault: the two things a signed-in person can do to the
// keys that protect their library.
//
// Both re-wrap ONE copy of a master key that never changes, which is why
// neither costs a re-encryption and why passkeys and this browser's remembered
// unlock keep working afterwards — they all wrap the same master key. Both ask
// for the current password, because that is the only secret in the browser that
// can produce the master key in a form we can re-wrap, and asking for it is
// what stops a borrowed session from rotating either one.
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { changeWorkspacePassword, mintNewRecoveryKey } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, SectionLabel, TextInput } from '../ui/kit.jsx';
import { t } from '../lib/i18n.js';

// One sentence per failure, each one naming what to do next. Server text never
// reaches this screen: these are the only five outcomes either call has.
function reasonText(reason) {
  if (reason === 'password') {
    return 'That is not this workspace’s current password. Type it again and retry.';
  }
  if (reason === 'novault') {
    return 'This workspace has not created its vault yet. Reload the studio once, then try again.';
  }
  if (reason === 'refused') {
    return 'This session has expired. Sign in again, then retry.';
  }
  if (reason === 'offline') {
    return 'Could not reach the studio. Check the connection and try again.';
  }
  return 'Nothing was changed and your current password still works. Try again.';
}

function VaultNote({ children }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
      <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-honey" />
      <p className="text-[13px] leading-relaxed text-ink2">{children}</p>
    </div>
  );
}

export function PrivacyVaultPanel({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [rotateWith, setRotateWith] = useState('');
  const [rotateError, setRotateError] = useState('');

  const changePassword = async (event) => {
    event.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('Those two new passwords are different. Type the new one twice.');
      return;
    }
    setBusy('password');
    const result = await changeWorkspacePassword(current, next);
    setBusy('');
    if (!result.ok) {
      setError(reasonText(result.reason));
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    toast.success('Password changed');
    onDone?.();
  };

  const rotateRecovery = async (event) => {
    event.preventDefault();
    setRotateError('');
    setBusy('recovery');
    const result = await mintNewRecoveryKey(rotateWith);
    setBusy('');
    if (!result.ok) {
      setRotateError(reasonText(result.reason));
      return;
    }
    setRotateWith('');
    // The key is announced to the one-time modal, which is mounted above this
    // dialog — so get out of its way rather than stacking two modals.
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <SectionLabel>{t('vault.workspacePassword')}</SectionLabel>
        <VaultNote>
          {t('vault.workspacePasswordBlurb')}
        </VaultNote>
        <form onSubmit={changePassword} className="flex flex-col gap-3">
          <Field label={t('vault.currentPassword')}>
            <TextInput
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <Field label={t('vault.newPassword')}>
            <TextInput
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <Field label={t('vault.confirmPassword')} error={error}>
            <TextInput
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              variant="primary"
              type="submit"
              loading={busy === 'password'}
              disabled={Boolean(busy) || !current || !next || !confirm}
            >
              {t('vault.changePassword')}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel>{t('vault.recoveryKey')}</SectionLabel>
        <VaultNote>
          {t('vault.recoveryKeyBlurb')}
        </VaultNote>
        <form onSubmit={rotateRecovery} className="flex flex-col gap-3">
          <Field
            label={t('vault.currentPassword')}
            error={rotateError}
            hint={t('vault.recoveryShownOnce')}
          >
            <TextInput
              type="password"
              value={rotateWith}
              onChange={(e) => setRotateWith(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <div className="flex justify-end">
            <Button
              type="submit"
              loading={busy === 'recovery'}
              disabled={Boolean(busy) || !rotateWith}
            >
              {t('vault.showNewRecoveryKey')}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
