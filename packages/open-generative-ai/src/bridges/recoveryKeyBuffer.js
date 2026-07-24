// CRITICAL: the E2E vault emits the owner's recovery key EXACTLY ONCE via the
// 'hivemind-vault-recovery-key' window event, and ensureVaultReady() can run from
// ANY early caller (media resolve, composer hydrate). This module registers the
// listener at import time — main.jsx imports it before rendering anything — so the
// key can never be emitted into the void while React is still mounting.
let bufferedKey = null;
const subscribers = new Set();

window.addEventListener('hivemind-vault-recovery-key', (event) => {
  const key = event?.detail?.recoveryKey;
  if (!key) return;
  bufferedKey = key;
  subscribers.forEach((fn) => fn(key));
});

export function subscribeRecoveryKey(fn) {
  if (bufferedKey) fn(bufferedKey);
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function clearBufferedRecoveryKey() {
  bufferedKey = null;
}
