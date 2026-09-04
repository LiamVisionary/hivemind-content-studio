// One readiness answer, and one repair, for every studio that offers a model.
//
// lib/providerReadiness.js already says WHETHER a row can run and WHAT fixes it
// when it cannot. This is the other half — the credentials fetched once, the
// busy flag while a sign-in is in flight, and the dispatch from a readiness
// action to the door that repairs it — and it exists because the Story studio
// had grown all three privately, so the four studios that did not copy it
// showed greyed rows with no sentence and no button at all.
//
// The dispatch is deliberately NOT a new mechanism: a repair that names a key
// or an account goes to lib/failureRemedy.js, the same runner the failure
// callouts use, so "Add key" opens the same place whether the studio learned
// about the missing key before the press or after it. A studio that has a
// closer door — the MUAPI dialog it already owns, the producer picker's inline
// key field — hands it in.
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { fetchOAuthStatus, readinessFor, refreshMuapiKeyLocation, startOAuthLogin } from './providerReadiness.js';
import { runFailureRemedy } from './failureRemedy.js';
import { t } from './i18n.js';

/** The MUAPI key's name in the shared store, for the studios with no dialog of
 *  their own: PassBook is where it is added, and naming it is the difference
 *  between "Add key" and "Add which key". */
export const MUAPI_KEY_NAME = 'MUAPI_API_KEY';

/**
 * @param {object} options
 * @param {function|null} options.onMuapiKey this studio's own MUAPI key dialog
 * @param {function|null} options.onKey this studio's own inline key field
 * @returns {{readinessFor: function, onFixReadiness: function, busyAction: string,
 *            oauth: object|null, refreshReadiness: function}}
 */
export function useProviderReadiness({ onMuapiKey = null, onKey = null } = {}) {
  const [oauth, setOauth] = useState(null);
  const [busyAction, setBusyAction] = useState('');

  const refreshReadiness = useCallback(async () => {
    // Both credentials a picker can act on, in one pass: which accounts are
    // connected, and whether this machine already holds the MUAPI key.
    const [status] = await Promise.all([fetchOAuthStatus(), refreshMuapiKeyLocation()]);
    setOauth(status);
    return status;
  }, []);

  useEffect(() => { void refreshReadiness(); }, [refreshReadiness]);

  const rowReadiness = useCallback((row) => readinessFor(row, { oauth }), [oauth]);

  /**
   * Repair whatever a row said was wrong, from the row itself.
   *
   * The authorize URL is OPENED rather than printed: a link somebody has to
   * copy out of a message is the same dead end as an error they have to
   * interpret.
   */
  const onFixReadiness = useCallback(async (action) => {
    if (!action) return;
    if (action.kind === 'muapi-key') {
      if (onMuapiKey) { onMuapiKey(); return; }
      await runFailureRemedy({ action: 'key', key: MUAPI_KEY_NAME });
      return;
    }
    if (action.kind === 'key') {
      if (onKey) { onKey(action); return; }
      await runFailureRemedy({ action: 'key', key: action.key }, { onMuapiKey });
      return;
    }
    if (action.kind !== 'oauth') {
      // Anything a future readiness state adds still lands somewhere real
      // rather than on a button that does nothing.
      await runFailureRemedy({ ...action, action: action.kind }, { onMuapiKey });
      return;
    }
    const key = `oauth:${action.provider}`;
    setBusyAction(key);
    try {
      window.open(await startOAuthLogin(action.provider), '_blank', 'noopener,noreferrer');
      toast(t('failure.finishSignIn'), { duration: 9000 });
    } catch (error) {
      // The reason AND what to do about it. "Could not start the sign-in" on
      // its own is the kind of message this studio is not allowed to ship.
      toast.error(
        error?.instruction
          ? `${error.message}\n\n${error.instruction}`
          : (error?.message || t('failure.signInFailed')),
        { duration: 14000 },
      );
    } finally {
      setBusyAction('');
      await refreshReadiness();
    }
  }, [onKey, onMuapiKey, refreshReadiness]);

  return { oauth, readinessFor: rowReadiness, onFixReadiness, busyAction, refreshReadiness };
}
