// One-time E2E vault recovery-key modal — step two of first-run setup.
//
// Shows for EVERY emitted key, ack gated by an explicit checkbox. There is
// deliberately no persisted "already acknowledged" flag: a key is announced
// exactly once per vault creation, and vault identity is per account — a
// global flag set by workspace A used to swallow workspace B's only recovery
// path on the same browser profile, unseen. The key itself arrives via the
// module-level buffer registered before React mounts.
//
// On a fresh studio the app creates the vault deliberately after the gate's
// setup card (see lib/firstRun.js), so this is the numbered second step of
// setting the studio up rather than a modal that lands on a loading studio.
import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { subscribeRecoveryKey, clearBufferedRecoveryKey, bufferedRecoveryReason } from './recoveryKeyBuffer.js';
import { saveBytes } from '../lib/downloadMedia.js';
import { clearFirstRunSetup, isFirstRunSetup } from '../lib/firstRun.js';
import { zh } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Button } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

const RECOVERY_FILENAME = 'hivemind-vault-recovery-key.txt';

export function VaultRecoveryModal() {
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  // Read once, at mount: acknowledging clears the flag, and the heading must not
  // change out from under the person reading it.
  const [firstRun] = useState(isFirstRunSetup);

  useEffect(() => subscribeRecoveryKey(setRecoveryKey), []);

  if (!recoveryKey) return null;

  // A replacement key is a different sentence from a first one: the old key
  // stopped working the moment this one was stored, and nothing was re-encrypted.
  const rotated = bufferedRecoveryReason() === 'rotated';

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Common over plain http on a LAN/tailnet IP — and this is the one screen
      // where a silent no-op is catastrophic. The key stays selectable.
      toast.error(zh() ? '复制失败 — 请手动选中密钥并复制' : 'Copy failed — select the key and copy it manually');
    }
  };

  // Through saveBytes: in the packaged desktop shell an anchor click writes
  // nothing, and this is the one button in the product where a person would
  // walk away believing a file exists that does not.
  const download = async () => {
    const blob = new Blob(
      [`Hivemind Content Studio — vault recovery key\n\n${recoveryKey}\n\nStore this offline. It is the ONLY way to recover your encrypted media and drafts if you forget your passphrase.\n`],
      { type: 'text/plain' },
    );
    const result = await saveBytes(blob, RECOVERY_FILENAME);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      if (result.method === 'clipboard') {
        toast.success(zh() ? '无法写入文件 — 密钥已复制到剪贴板' : 'Could not write a file — the key is on your clipboard instead');
      }
      return;
    }
    if (result.cancelled) return;
    toast.error(zh()
      ? '无法保存文件 — 请点击“复制密钥”并粘贴到密码管理器中'
      : 'Could not save a file — press Copy key and paste it into your password manager');
  };

  const acknowledge = () => {
    clearFirstRunSetup();
    clearBufferedRecoveryKey();
    setRecoveryKey(null);
  };

  const title = rotated
    ? (zh() ? '保存你的新恢复密钥' : 'Save your new recovery key')
    : firstRun
      ? (zh() ? '第 2 步，共 2 步 · 保存你的恢复密钥' : 'Step 2 of 2 — save your recovery key')
      : (zh() ? '保存你的恢复密钥' : 'Save your recovery key');

  return (
    <Modal open title={title} size="md" dismissable={false}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/10 px-3.5 py-3">
          <Icon name="shield" size={18} className="mt-0.5 shrink-0 text-warn" />
          {/* Three lines, in this order: what it is, where to put it, and that
              it cannot be shown again. The mechanics (PBKDF, wrapping, what is
              never sent to a server) belong in Settings → Privacy, not on the
              screen where someone has thirty seconds to keep a key. */}
          <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink1">
            <p>
              {rotated
                ? (zh()
                  ? '这是你的新恢复密钥，旧密钥已失效。忘记口令时，它是打开你加密媒体与草稿的唯一途径。'
                  : 'This is your new recovery key, and the old one stopped working. If you forget your passphrase, it is the only thing that opens your encrypted media and drafts.')
                : (zh()
                  ? '这是你的恢复密钥：忘记口令时，它是打开你加密媒体与草稿的唯一途径。'
                  : 'This is your recovery key. If you forget your passphrase, it is the only thing that opens your encrypted media and drafts.')}
            </p>
            <p>
              {zh()
                ? '把它保存到密码管理器，或打印出来与你的重要文件放在一起 — 不要只留在这台电脑上。'
                : 'Put it in your password manager, or print it and keep it with your documents — not only on this computer.'}
            </p>
            <p className="text-ink2">
              {zh()
                ? '本工作室无法再次显示它，也没有任何人可以为你重置。'
                : 'The studio cannot show it to you again, and nobody can reset it for you.'}
            </p>
          </div>
        </div>
        <code className="select-all break-all rounded-md border border-line1 bg-bg0 px-4 py-3.5 text-center font-mono text-[15px] font-semibold tracking-wider text-honey">
          {recoveryKey}
        </code>
        <div className="flex items-center justify-center gap-2">
          <Button icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? (zh() ? '已复制' : 'Copied') : (zh() ? '复制密钥' : 'Copy key')}</Button>
          <Button icon={saved ? 'check' : 'download'} onClick={download}>
            {saved ? (zh() ? '已保存' : 'Saved') : (zh() ? '保存为 .txt' : 'Save as .txt')}
          </Button>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
          <input
            type="checkbox"
            checked={stored}
            onChange={(e) => setStored(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--honey)]"
          />
          <span className="text-[13px] leading-relaxed text-ink2">
            {zh() ? '我已把密钥妥善保存（密码管理器、打印件或离线笔记）。' : 'I stored this key somewhere safe (password manager, printed copy, offline note).'}
          </span>
        </label>
        <Button variant="primary" size="lg" disabled={!stored} onClick={acknowledge} className="w-full">
          {zh() ? '继续进入工作室' : 'Continue to the studio'}
        </Button>
      </div>
    </Modal>
  );
}
