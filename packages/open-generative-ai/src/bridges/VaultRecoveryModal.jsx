// One-time E2E vault recovery-key modal.
//
// Shows for EVERY emitted key, ack gated by an explicit checkbox. There is
// deliberately no persisted "already acknowledged" flag: a key is announced
// exactly once per vault creation, and vault identity is per account — a
// global flag set by workspace A used to swallow workspace B's only recovery
// path on the same browser profile, unseen. The key itself arrives via the
// module-level buffer registered before React mounts.
import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { subscribeRecoveryKey, clearBufferedRecoveryKey } from './recoveryKeyBuffer.js';
import { getLang } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Button } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

const zh = () => getLang() === 'zh-CN';

export function VaultRecoveryModal() {
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeRecoveryKey(setRecoveryKey), []);

  if (!recoveryKey) return null;

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

  const download = () => {
    const blob = new Blob(
      [`Hivemind Content Studio — vault recovery key\n\n${recoveryKey}\n\nStore this offline. It is the ONLY way to recover your encrypted media and drafts if you forget your passphrase.\n`],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hivemind-vault-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const acknowledge = () => {
    clearBufferedRecoveryKey();
    setRecoveryKey(null);
  };

  return (
    <Modal open title={zh() ? '保存你的恢复密钥' : 'Save your recovery key'} size="md" dismissable={false}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/10 px-3.5 py-3">
          <Icon name="shield" size={18} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-[13px] leading-relaxed text-ink1">
            {zh()
              ? <>你的私人保险库刚刚创建。此密钥<strong>只显示一次</strong> — 如果你忘记口令，它是恢复加密媒体和草稿的唯一途径。任何内容都不会以明文发送到服务器。</>
              : <>Your private vault was just created. This key is shown <strong>only once</strong> — it is the only
                way to recover your encrypted media and drafts if you forget your passphrase. Nothing is ever sent
                to a server in plain text.</>}
          </p>
        </div>
        <code className="select-all break-all rounded-md border border-line1 bg-bg0 px-4 py-3.5 text-center font-mono text-[15px] font-semibold tracking-wider text-honey">
          {recoveryKey}
        </code>
        <div className="flex items-center justify-center gap-2">
          <Button icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? (zh() ? '已复制' : 'Copied') : (zh() ? '复制密钥' : 'Copy key')}</Button>
          <Button icon="download" onClick={download}>{zh() ? '下载 .txt' : 'Download .txt'}</Button>
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
