// In-app vault unlock. A tab can hold a valid owner-session cookie while its
// per-tab passphrase is absent (the lock screen only runs when the cookie is
// missing), leaving the E2E vault locked: sealed media can't decrypt and shows
// "vault locked" tiles. Any of those affordances dispatches
// VAULT_UNLOCK_REQUEST_EVENT; this modal re-runs the gate's own flow — verify
// the password at /api/owner/unlock, stash it per-tab, reload so every module
// (vault, hub passphrase snapshot, tool surfaces) bootstraps with the key.
import { useCallback, useState } from 'react';
import { useWindowEvent } from '../hooks/hooks.js';
import { getLang } from '../lib/i18n.js';
import { unlockOwnerSession, VAULT_UNLOCK_REQUEST_EVENT } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

const zh = () => getLang() === 'zh-CN';

export function VaultUnlockModal() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useWindowEvent(VAULT_UNLOCK_REQUEST_EVENT, useCallback(() => setOpen(true), []));

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setError('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const result = await unlockOwnerSession(password);
    if (result.ok) {
      // Reload with the passphrase stashed — the same handoff the lock screen
      // does — so the vault and every sealed tile come back decrypted.
      window.location.reload();
      return;
    }
    setBusy(false);
    setError(result.status === 429
      ? (zh() ? '尝试次数过多。请稍等一分钟再试。' : 'Too many attempts. Wait a minute and try again.')
      : result.status === 0
        ? (zh() ? '无法连接到工作室。请检查连接后重试。' : 'Could not reach the studio. Check the connection and try again.')
        : (zh() ? '密码错误。请重试。' : 'Wrong password. Try again.'));
  };

  if (!open) return null;

  return (
    <Modal open title={zh() ? '解锁你的保险库' : 'Unlock your vault'} size="sm" onClose={close} dismissable={!busy}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-honey" />
          <p className="text-[13px] leading-relaxed text-ink2">
            {zh()
              ? '你的媒体是端到端加密的，密钥只存在于已解锁的标签页中。此标签页还没有它 — 输入工作室密码即可在此解密。'
              : <>Your media is end-to-end encrypted and the key lives only in an unlocked tab. This tab doesn&rsquo;t have it yet — enter your studio password to decrypt here.</>}
          </p>
        </div>
        <Field
          label={zh() ? '工作室密码' : 'Studio password'}
          error={error}
          hint={zh() ? '解锁后此标签页会重新加载。' : 'This tab reloads after unlocking.'}
        >
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            disabled={busy}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={busy}>{zh() ? '取消' : 'Cancel'}</Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!password}>
            {zh() ? '解锁' : 'Unlock'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
