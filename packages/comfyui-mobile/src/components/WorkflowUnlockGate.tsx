import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  clearWorkflowEncryptionKey,
  getWorkflowEncryptionUnlockExpiresAt,
  isWorkflowEncryptionUnlocked,
  setWorkflowEncryptionKey,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';

function formatUnlockExpiry(expiresAt: number | null): string {
  if (!expiresAt) return 'for at least 4 hours';
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
        className="fixed right-3 top-[calc(var(--top-bar-offset,69px)+8px)] z-[2600] rounded-full border border-emerald-400/30 bg-emerald-500/12 px-3 py-1.5 text-xs font-semibold text-emerald-100 shadow-lg backdrop-blur"
        title="Forget the in-browser workflow unlock key for this browser"
      >
        Private workflows unlocked · {formatUnlockExpiry(expiresAt)}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-slate-950/96 px-4 backdrop-blur-xl">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-3xl border border-white/12 bg-slate-900/95 p-6 shadow-2xl"
      >
        <div className="mb-5">
          <div className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200/80">
            User-only unlock
          </div>
          <h1 className="text-2xl font-bold text-white">Unlock private workflows</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Enter the same passphrase you use in Z-Image Studio. ComfyUI Mobile will remember this browser unlock for 4 hours, then forget it automatically. The passphrase is still never sent to the backend or derived from the URL token.
          </p>
        </div>

        <label className="block text-sm font-semibold text-slate-200" htmlFor="workflow-unlock-passphrase">
          Unlock passphrase
        </label>
        <input
          id="workflow-unlock-passphrase"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          className="mt-2 w-full rounded-2xl border border-white/15 bg-slate-950 px-4 py-3 text-base text-white outline-none ring-cyan-400/30 transition focus:border-cyan-300 focus:ring-4"
          placeholder="Your private workflow passphrase"
        />

        {error && (
          <div className="mt-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="mt-5 w-full rounded-2xl bg-cyan-300 px-4 py-3 text-base font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!passphrase.trim()}
        >
          Unlock ComfyUI Mobile for 4 hours
        </button>

        <p className="mt-4 text-xs leading-5 text-slate-400">
          Reloading the page keeps the unlock until the 4-hour TTL expires. Tapping the unlocked badge forgets it immediately.
        </p>
      </form>
    </div>
  );
}
