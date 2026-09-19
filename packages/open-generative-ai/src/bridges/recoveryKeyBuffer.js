// CRITICAL: the E2E vault emits the owner's recovery key EXACTLY ONCE via the
// 'hivemind-vault-recovery-key' window event, and ensureVaultReady() can run from
// ANY early caller (media resolve, composer hydrate). This module registers the
// listener at import time — main.jsx imports it before rendering anything — so the
// key can never be emitted into the void while React is still mounting.
let bufferedKey = null;
// Which of the two moments this key belongs to: 'created' (a vault has just
// been made) or 'rotated' (Settings minted a replacement). Kept beside the key
// rather than pushed to subscribers so the announcement contract stays "one
// argument, the key"; the modal reads it while rendering, which is only ever
// after the key it was set with. Telling someone their vault was just created
// when they asked for a NEW key would be a lie about what happened to the old one.
let bufferedReason = 'created';
const subscribers = new Set();

window.addEventListener('hivemind-vault-recovery-key', (event) => {
  const key = event?.detail?.recoveryKey;
  if (!key) return;
  bufferedKey = key;
  bufferedReason = event?.detail?.reason === 'rotated' ? 'rotated' : 'created';
  subscribers.forEach((fn) => fn(key));
});

export function subscribeRecoveryKey(fn) {
  if (bufferedKey) fn(bufferedKey);
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function bufferedRecoveryReason() {
  return bufferedReason;
}

export function clearBufferedRecoveryKey() {
  bufferedKey = null;
  bufferedReason = 'created';
}
