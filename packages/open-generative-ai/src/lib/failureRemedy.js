// Running the repair a failure named, in a studio that has no producer picker.
//
// useModelSources.runRemedy is the same idea for the Story producer, where the
// picker is on screen and "Add key" can just open its inline field. Image,
// Video, Sprite and Restore have no such panel: their failures come from a
// canvas callout, so a remedy has to reach a mechanism that exists WITHOUT one
// — this studio's own MUAPI key dialog, this studio's size dial, the HivemindOS
// checkout, the sign-in tab, or the page that owns the setting.
//
// A button that visibly does nothing is worse than no button, which is why
// every branch below ends in something observable and the studio-local ones are
// handed in rather than guessed at.
import toast from 'react-hot-toast';

import { t } from './i18n.js';
import { startCreditTopUp } from './localProducer.js';
import { startOAuthLogin } from './providerReadiness.js';
function openPage(page) {
  try {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page } }));
  } catch { /* no window (tests) */ }
}

/**
 * Run `remedy` (from describeFailure) with the studio-local handlers it may
 * need. `onMuapiKey` opens this studio's key dialog, `onLowerResolution` steps
 * its size dial, `onRetry` re-presses Generate.
 */
export async function runFailureRemedy(remedy, handlers = {}) {
  const action = String(remedy?.action || '');
  if (!action) return;
  if (action === 'lower-resolution') { handlers.onLowerResolution?.(); return; }
  if (action === 'refresh') { handlers.onRetry?.(); return; }
  if (action === 'models') { openPage('models'); return; }
  if (action === 'key') {
    // The MUAPI key has a field in this studio; everything else is set where
    // the shared store is edited.
    if (/^MUAPI_/.test(String(remedy?.key || '')) && handlers.onMuapiKey) { handlers.onMuapiKey(); return; }
    openPage('passbook');
    return;
  }
  if (action === 'oauth') {
    try {
      window.open(await startOAuthLogin(String(remedy?.provider || '')), '_blank', 'noopener,noreferrer');
      toast(t('failure.finishSignIn'), { duration: 10000 });
    } catch {
      // The sign-in could not even be started — the Providers page is where the
      // connection lives, so send them there rather than repeating the failure.
      openPage('providers');
    }
    return;
  }
  if (action === 'top-up') {
    try {
      const { checkoutUrl } = await startCreditTopUp();
      if (!checkoutUrl) throw new Error('no checkout');
      window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
      toast(t('failure.finishCheckout'), { duration: 10000 });
    } catch {
      openPage('providers');
    }
    return;
  }
  // 'connect', 'accounts', 'open' and anything a future server adds: the
  // Providers page is where an account is connected.
  openPage('providers');
}
