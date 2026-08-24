import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  clearWorkflowEncryptionKey,
  getWorkflowEncryptionUnlockExpiresAt,
  isWorkflowEncryptionUnlocked,
  setWorkflowEncryptionKey,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';
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

export function WorkflowUnlockGate() {
  const [unlocked, setUnlocked] = useState(() => isWorkflowEncryptionUnlocked());
  const [expiresAt, setExpiresAt] = useState(() => getWorkflowEncryptionUnlockExpiresAt());
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeWorkflowEncryptionStatus(() => {
    setUnlocked(isWorkflowEncryptionUnlocked());
    setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
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
      if (event.data?.type !== 'hivemind-owner-unlock' || typeof event.data.passphrase !== 'string') return;
      try {
        setWorkflowEncryptionKey(event.data.passphrase);
        setUnlocked(true);
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
      setUnlocked(true);
      setExpiresAt(getWorkflowEncryptionUnlockExpiresAt());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock private workflows');
    }
  };

  if (unlocked) {
    return (
      <button
        type="button"
        onClick={() => {
          clearWorkflowEncryptionKey();
          setUnlocked(false);
          setExpiresAt(null);
        }}
        className="fixed right-3 top-[calc(var(--top-bar-offset,69px)+8px)] z-[2600] rounded-full border border-[#f6b21b]/40 bg-[#f6b21b]/15 px-3 py-1.5 text-xs font-semibold text-[#ffc94a] shadow-lg backdrop-blur"
        title="Forget the in-browser workflow unlock key for this browser"
      >
        Private workflows unlocked · {formatUnlockExpiry(expiresAt)}
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
          <h1 className="text-xl font-semibold tracking-tight text-[#f2f2f3]">Unlock private workflows</h1>
          <p className="mt-3 text-sm leading-6 text-[#a3a3ac]">
            Enter the same passphrase you use in Hivemind Content Studio. Canvas will remember this browser unlock for 24 hours, then forget it automatically. The passphrase is still never sent to the backend or derived from the URL token.
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
          Unlock Canvas for 24 hours
        </button>

        <p className="mt-4 text-xs leading-5 text-[#6b6b74]">
          Reloading the page keeps the unlock until the 24-hour TTL expires. Tapping the unlocked badge forgets it immediately.
        </p>
      </form>
    </div>
  );
}
