// The one fact the sign-in gate's setup card hands forward: this page load is
// the second half of first-run setup.
//
// It exists because vault creation used to be a side effect of whichever caller
// first awaited ensureVaultReady() — a media resolve, a composer hydrate — so
// the one-time recovery key dropped on top of a half-loaded studio with no
// explanation. With this flag the app creates the vault deliberately, right
// after setup, and the key is step two of a two-step setup instead of a
// surprise. sessionStorage because it is scoped to the tab the gate reloaded,
// and because it must not survive into the next launch.
const FIRST_RUN_KEY = 'hivemind.firstRun.once';

/** Marked by the gate immediately before it reloads into the app. */
export function isFirstRunSetup() {
  try {
    return sessionStorage.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Cleared once the recovery key has been acknowledged — setup is over. */
export function clearFirstRunSetup() {
  try {
    sessionStorage.removeItem(FIRST_RUN_KEY);
  } catch { /* private mode: the flag was never readable anyway */ }
}
