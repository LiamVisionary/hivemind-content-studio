// One-time E2E vault recovery-key modal (React port of vaultRecoveryBanner.js).
// Behavior contract preserved: shows once per emitted key, ack gated by an explicit
// checkbox, ack persisted under localStorage 'hivemind.vault.recoveryAck'. The key
// itself arrives via the module-level buffer registered before React mounts.
import { useEffect, useState } from 'react';
import { subscribeRecoveryKey, clearBufferedRecoveryKey } from './recoveryKeyBuffer.js';
import { Icon } from '../ui/icons.jsx';
import { Button } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

const ACK_KEY = 'hivemind.vault.recoveryAck';

function alreadyAcked() {
  try { return localStorage.getItem(ACK_KEY) === '1'; } catch { return false; }
}

export function VaultRecoveryModal() {
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(
    () =>
      subscribeRecoveryKey((key) => {
        if (!alreadyAcked()) setRecoveryKey(key);
      }),
    [],
  );

  if (!recoveryKey) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable — key remains selectable */ }
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
    try { localStorage.setItem(ACK_KEY, '1'); } catch { /* non-critical */ }
    clearBufferedRecoveryKey();
    setRecoveryKey(null);
  };

  return (
    <Modal open title="Save your recovery key" size="md" dismissable={false}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/10 px-3.5 py-3">
          <Icon name="shield" size={18} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-[13px] leading-relaxed text-ink1">
            Your private vault was just created. This key is shown <strong>only once</strong> — it is the only
            way to recover your encrypted media and drafts if you forget your passphrase. Nothing is ever sent
            to a server in plain text.
          </p>
        </div>
        <code className="select-all break-all rounded-md border border-line1 bg-bg0 px-4 py-3.5 text-center font-mono text-[15px] font-semibold tracking-wider text-honey">
          {recoveryKey}
        </code>
        <div className="flex items-center justify-center gap-2">
          <Button icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy key'}</Button>
          <Button icon="download" onClick={download}>Download .txt</Button>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
          <input
            type="checkbox"
            checked={stored}
            onChange={(e) => setStored(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--honey)]"
          />
          <span className="text-[13px] leading-relaxed text-ink2">
            I stored this key somewhere safe (password manager, printed copy, offline note).
          </span>
        </label>
        <Button variant="primary" size="lg" disabled={!stored} onClick={acknowledge} className="w-full">
          Continue to the studio
        </Button>
      </div>
    </Modal>
  );
}
