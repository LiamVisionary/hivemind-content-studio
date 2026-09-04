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
import { zh } from '../lib/i18n.js';
import { changeWorkspacePassword, mintNewRecoveryKey } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, SectionLabel, TextInput } from '../ui/kit.jsx';

// One sentence per failure, each one naming what to do next. Server text never
// reaches this screen: these are the only five outcomes either call has.
function reasonText(reason) {
  if (reason === 'password') {
    return zh()
      ? '当前密码不正确。请重新输入后再试。'
      : 'That is not this workspace’s current password. Type it again and retry.';
  }
  if (reason === 'novault') {
    return zh()
      ? '此工作区尚未创建保险库。请重新加载工作室后再试。'
      : 'This workspace has not created its vault yet. Reload the studio once, then try again.';
  }
  if (reason === 'refused') {
    return zh()
      ? '登录状态已过期。请重新登录后再试。'
      : 'This session has expired. Sign in again, then retry.';
  }
  if (reason === 'offline') {
    return zh()
      ? '无法连接到工作室。请检查连接后重试。'
      : 'Could not reach the studio. Check the connection and try again.';
  }
  return zh()
    ? '没有任何更改 — 当前密码仍然有效。请重试。'
    : 'Nothing was changed and your current password still works. Try again.';
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
      setError(zh() ? '两次输入的新密码不一致。' : 'Those two new passwords are different. Type the new one twice.');
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
    toast.success(zh() ? '密码已更改' : 'Password changed');
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
        <SectionLabel>{zh() ? '工作区密码' : 'Workspace password'}</SectionLabel>
        <VaultNote>
          {zh()
            ? '密码同时解锁此工作区和它的加密库。更改密码不会重新加密任何内容，已注册的通行密钥和此浏览器记住的解锁方式仍然有效。'
            : 'Your password opens this workspace and decrypts its library. Changing it re-seals one copy of the key, so nothing is re-encrypted and any passkey — or this browser’s remembered unlock — keeps working.'}
        </VaultNote>
        <form onSubmit={changePassword} className="flex flex-col gap-3">
          <Field label={zh() ? '当前密码' : 'Current password'}>
            <TextInput
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <Field label={zh() ? '新密码' : 'New password'}>
            <TextInput
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              disabled={Boolean(busy)}
            />
          </Field>
          <Field label={zh() ? '再次输入新密码' : 'Type the new one again'} error={error}>
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
              {zh() ? '更改密码' : 'Change password'}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel>{zh() ? '恢复密钥' : 'Recovery key'}</SectionLabel>
        <VaultNote>
          {zh()
            ? '恢复密钥是忘记密码后唯一的进入方式 — 服务器从未持有你的密钥，无法为你重置。生成新密钥会立即使旧密钥失效，你的内容不受影响。'
            : 'A recovery key is the only way back in if you forget your password — the server has never held your key and cannot reset it for you. Minting a new one retires the old key immediately and leaves everything you have made untouched.'}
        </VaultNote>
        <form onSubmit={rotateRecovery} className="flex flex-col gap-3">
          <Field
            label={zh() ? '当前密码' : 'Current password'}
            error={rotateError}
            hint={zh() ? '新密钥只会显示一次。' : 'The new key is shown once, and then only you have it.'}
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
              {zh() ? '生成新的恢复密钥' : 'Show a new recovery key'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
