import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  clearLegacyUnlockNeeded,
  clearWorkflowEncryptionKey,
  getVaultKeyHandles,
  getWorkflowEncryptionUnlockExpiresAt,
  isLegacyUnlockNeeded,
  isWorkflowEncryptionUnlocked,
  setVaultKeyHandles,
  setWorkflowEncryptionKey,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';
import type { VaultKeyHandles } from '@/utils/workflowEncryption';
import { isTrustedOwnerParentEvent } from '@/utils/trustedOwnerParent';

function formatUnlockExpiry(expiresAt: number | null): string {
  if (!expiresAt) return 'for up to 24 hours';
  const remainingMs = Math.max(0, expiresAt - Date.now());
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes >= 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return minutes ? `for ${hours}h ${minutes}m` : `for ${hours} hours`;
  }
  return `for ${remainingMinutes} minutes`;
}

function isVaultKeyHandles(value: unknown): value is VaultKeyHandles {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.masterKey instanceof CryptoKey && record.privateKey instanceof CryptoKey;
}

/**
 * Canvas's private-content unlock — an offer, never a wall.
 *
 * The studio shell hands this frame the open owner vault (non-extractable
 * CryptoKeys over postMessage), so in the normal case nothing is rendered but
 * the unlocked badge and the passphrase is never asked for. The form below is
 * the fallback for the two cases the vault cannot cover: a standalone tab with
 * no shell to hand anything over, and content sealed under the OLD
 * PBKDF2-over-passphrase scheme, which is stamped into images already on disk
 * and so can never be re-keyed. It is raised by a dismissible prompt when such
 * content is actually opened, rather than blocking the app on the chance.
 */
export function WorkflowUnlockGate() {
  const [unlocked, setUnlocked] = useState(() => isWorkflowEncryptionUnlocked());
  const [expiresAt, setExpiresAt] = useState(() => getWorkflowEncryptionUnlockExpiresAt());
  const [legacyNeeded, setLegacyNeeded] = useState(() => isLegacyUnlockNeeded());
  const [formOpen, setFormOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeWorkflowEncryptionStatus(() => {
    setUnlocked(isWorkflowEncryptionUnlocked());
    setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
    setLegacyNeeded(isLegacyUnlockNeeded());
  }), []);

  useEffect(() => {
    const onOwnerAccess = (event: MessageEvent) => {
      if (!isTrustedOwnerParentEvent(event)) return;
      if (event.data?.type === 'hivemind-owner-lock') {
        clearWorkflowEncryptionKey();
        setUnlocked(false);
        setExpiresAt(null);
        return;
      }
      if (event.data?.type !== 'hivemind-owner-unlock') return;
      try {
        // Either half may be absent: a freshly signed-in browser still has the
        // passphrase and may not have finished opening the vault; every browser
        // after that has the vault and no passphrase at all. Take what came.
        if (isVaultKeyHandles(event.data.vaultKeys)) setVaultKeyHandles(event.data.vaultKeys);
        if (typeof event.data.passphrase === 'string') setWorkflowEncryptionKey(event.data.passphrase);
        if (!isVaultKeyHandles(event.data.vaultKeys) && typeof event.data.passphrase !== 'string') return;
        setUnlocked(isWorkflowEncryptionUnlocked());
        setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to unlock private workflows');
      }
    };
    window.addEventListener('message', onOwnerAccess);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'hivemind-owner-unlock-ready' }, '*');
    }
    return () => window.removeEventListener('message', onOwnerAccess);
  }, []);

  useEffect(() => {
    if (!unlocked) return undefined;
    const interval = window.setInterval(() => {
      setUnlocked(isWorkflowEncryptionUnlocked());
      setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [unlocked]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setWorkflowEncryptionKey(passphrase);
      setPassphrase('');
      setError(null);
      setFormOpen(false);
      clearLegacyUnlockNeeded();
      setUnlocked(true);
      setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock private workflows');
    }
  };

  // Whether the badge should offer to forget anything. A vault handed over by
  // the shell is the shell's to lock, not this frame's: dropping it here would
  // read as "locked" while the studio around it stayed open, and the very next
  // message would hand it straight back.
  const vaultHeld = Boolean(getVaultKeyHandles());

  if (unlocked && !formOpen) {
    return (
      <button
        type="button"
        onClick={() => {
          if (vaultHeld) return;
          clearWorkflowEncryptionKey();
          setUnlocked(false);
          setExpiresAt(null);
        }}
        disabled={vaultHeld}
        className="fixed right-3 top-[calc(var(--top-bar-offset,69px)+8px)] z-[2600] rounded-full border border-[#f6b21b]/40 bg-[#f6b21b]/15 px-3 py-1.5 text-xs font-semibold text-[#ffc94a] shadow-lg backdrop-blur disabled:cursor-default"
        title={vaultHeld
          ? 'Unlocked by your Hivemind Content Studio session — lock the studio to lock this'
          : 'Forget the in-browser workflow unlock key for this browser'}
      >
        {vaultHeld ? 'Private workflows unlocked' : `Private workflows unlocked · ${formatUnlockExpiry(expiresAt)}`}
      </button>
    );
  }

  // Locked, and nothing has actually needed a key yet — stay out of the way.
  if (!formOpen && !legacyNeeded) return null;

  if (!formOpen) {
    return (
      <button
        type="button"
        onClick={() => setFormOpen(true)}
        className="fixed right-3 top-[calc(var(--top-bar-offset,69px)+8px)] z-[2600] rounded-full border border-white/15 bg-[#17171b]/90 px-3 py-1.5 text-xs font-semibold text-[#a3a3ac] shadow-lg backdrop-blur transition hover:border-[#f6b21b]/40 hover:text-[#ffc94a]"
        title="Some older private items were saved under your passphrase rather than your vault"
      >
        Unlock older private items
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-[#0c0c0e]/95 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-[14px] border border-white/10 bg-[#111114] p-6 shadow-2xl"
      >
        <div className="mb-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#f6b21b]">
            User-only unlock
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-[#f2f2f3]">Unlock older private items</h1>
          <p className="mt-3 text-sm leading-6 text-[#a3a3ac]">
            Items saved before this browser started using your vault were sealed with the passphrase you use in Hivemind Content Studio. They are encrypted into the saved files themselves, so they can only be reopened with it. Everything saved from now on opens with your vault and will not ask again. The passphrase is still never sent to the backend or derived from the URL token.
          </p>
        </div>

        <label className="block text-xs font-medium text-[#a3a3ac]" htmlFor="workflow-unlock-passphrase">
          Unlock passphrase
        </label>
        <input
          id="workflow-unlock-passphrase"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          className="mt-2 w-full rounded-[10px] border border-white/10 bg-[#17171b] px-4 py-3 text-base text-[#f2f2f3] outline-none ring-[#f6b21b]/30 transition focus:border-[#f6b21b] focus:ring-2"
          placeholder="Your private workflow passphrase"
        />

        {error && (
          <div className="mt-3 rounded-[10px] border border-[#f26d5f]/40 bg-[#f26d5f]/10 px-4 py-3 text-sm text-[#f26d5f]">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="mt-5 w-full rounded-[10px] bg-[#f6b21b] px-4 py-3 text-base font-semibold text-[#1a1205] transition hover:bg-[#ffc94a] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!passphrase.trim()}
        >
          Unlock older items for 24 hours
        </button>

        <button
          type="button"
          onClick={() => { setFormOpen(false); setError(null); setPassphrase(''); }}
          className="mt-2 w-full rounded-[10px] px-4 py-2.5 text-sm font-medium text-[#a3a3ac] transition hover:text-[#f2f2f3]"
        >
          Not now
        </button>

        <p className="mt-3 text-xs leading-5 text-[#6b6b74]">
          Reloading the page keeps the unlock until the 24-hour TTL expires. Tapping the unlocked badge forgets it immediately.
        </p>
      </form>
    </div>
  );
}
