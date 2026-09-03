// The catalog, and every repair a source can offer, in one place.
//
// The Story producer and the prompt helper both need the same six things: the
// catalog, which tab is open, which account narrows it, the key field a "not
// connected" account opens, and the two HivemindOS account actions. Duplicating
// that in the dialog is how the two drift — which is what the dialog being
// local-only was in the first place.
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import {
  ACCOUNTS, APP_ROUTE, HIVEMINDOS, LINK_POLL_MS, LINK_WAIT_MS, remedyFor, routeOf, sourceState,
} from './textModels.js';
import {
  connectHivemindosAccount, hivemindosLinkState, requestHivemindosLink, saveProviderKey,
  startCreditTopUp, textModelCatalog,
} from './localProducer.js';
import { startOAuthLogin } from './providerReadiness.js';

/**
 * `onOpen`, when the caller keeps the picker in a popover: a repair that
 * switches sections ("Connect an account", "Add key") also has to bring the
 * picker into view, or the button appears to do nothing.
 */
export function useModelSources({ enabled = true, onOpen = null } = {}) {
  const [catalog, setCatalog] = useState(null);
  const [tab, setTab] = useState('');
  const show = useCallback((section) => { setTab(section); onOpen?.(true); }, [onOpen]);
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState('');
  const [keyField, setKeyField] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [linking, setLinking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCatalog(await textModelCatalog());
    } catch {
      // A catalog that cannot be read is a catalog with no models, not a crash.
      setCatalog({ models: [], sources: {} });
    }
  }, []);

  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);

  const saveKey = useCallback(async (name, value) => {
    setSavingKey(true);
    try {
      await saveProviderKey(name, value);
      setKeyField('');
      await refresh();
      toast.success(`${name} saved. Its models are on the Your accounts tab.`);
    } catch (error) {
      toast.error(error?.message || 'That key could not be saved.');
    } finally {
      setSavingKey(false);
    }
  }, [refresh]);

  const connectAccount = useCallback(async (token) => {
    setConnecting(true);
    try {
      const result = await connectHivemindosAccount(token);
      await refresh();
      toast.success(result?.label ? `Connected — ${result.label}.` : 'HivemindOS account connected.');
    } catch (error) {
      toast.error(error?.message || 'That key was not accepted.');
    } finally {
      setConnecting(false);
    }
  }, [refresh]);

  /** Ask the HivemindOS app on this machine to hand its balance over. A custom
   *  scheme that nothing handles fails SILENTLY, so silence is treated as an
   *  answer after a budget rather than waited on forever. */
  const linkThroughApp = useCallback(async () => {
    setLinking(true);
    try {
      const { url, nonce } = await requestHivemindosLink();
      window.location.href = url;
      const deadline = Date.now() + LINK_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LINK_POLL_MS));
        const { state } = await hivemindosLinkState(nonce).catch(() => ({ state: 'pending' }));
        if (state === 'linked') {
          await refresh();
          toast.success('Linked to your HivemindOS balance.');
          return;
        }
        if (state === 'expired') break;
      }
      toast('HivemindOS did not answer. Open it and try again, or paste an account key below.',
        { icon: '🐝', duration: 10000 });
    } catch (error) {
      toast.error(error?.message || 'Could not ask HivemindOS to link.');
    } finally {
      setLinking(false);
    }
  }, [refresh]);

  const runRemedy = useCallback(async (remedy) => {
    const action = typeof remedy === 'string' ? remedy : String(remedy?.action || '');
    if (action === 'accounts') { show(ACCOUNTS); return; }
    if (action === 'key') { show(ACCOUNTS); setKeyField(String(remedy?.key || '')); return; }
    if (action === 'oauth') {
      try {
        window.open(await startOAuthLogin(String(remedy?.provider || '')), '_blank', 'noopener,noreferrer');
        toast('Finish the sign-in in the tab that opened, then press Try again.', { icon: '🔑', duration: 10000 });
      } catch (error) {
        toast.error(error?.instruction ? `${error.message} ${error.instruction}`
          : (error?.message || 'Could not start the sign-in.'));
      }
      return;
    }
    if (action === 'models') {
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }));
      return;
    }
    if (action === 'refresh') { void refresh(); return; }
    if (action === 'connect') { show(HIVEMINDOS); return; }
    if (action === 'top-up') {
      // With the app running, credits belong there — buying a second balance
      // here would split the one the machine already shares.
      if (routeOf(catalog) === APP_ROUTE) {
        const url = sourceState(catalog, HIVEMINDOS).url;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        toast('Add credits in HivemindOS — this studio spends the same balance.', { icon: '🐝', duration: 8000 });
        return;
      }
      try {
        const { checkoutUrl } = await startCreditTopUp();
        if (!checkoutUrl) throw new Error('HivemindOS did not return a checkout page.');
        window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
        toast('Finish the checkout in the tab that opened, then press Try again.', { icon: '💳', duration: 10000 });
      } catch (error) {
        toast.error(error?.message || 'Could not open the HivemindOS checkout.');
      }
      return;
    }
    const url = sourceState(catalog, HIVEMINDOS).url;
    if (!url) { toast('HivemindOS is not installed on this machine yet.', { icon: '🐝' }); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [catalog, refresh, show]);

  /** Everything ModelSourcePicker takes, ready to spread. */
  const pickerProps = {
    catalog, tab, onTab: setTab, query, onQuery: setQuery,
    account, onAccount: setAccount, keyField, onKeySave: saveKey,
    onKeyCancel: () => setKeyField(''), savingKey,
    onRemedy: runRemedy, onConnect: connectAccount, connecting,
    onLink: linkThroughApp, linking,
  };

  return { catalog, refresh, tab, setTab, runRemedy, pickerProps };
}
