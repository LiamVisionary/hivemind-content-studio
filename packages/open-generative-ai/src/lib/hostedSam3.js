// Hosted SAM3 masking, from the browser.
//
// The head-replacement dialog offers SAM3 tracking everywhere; only the place it
// runs changes. Local first — a lane that carries the SAM3 checkpoint tracks for
// free inside the render itself. When there is no such lane, this is the other
// way: the clip goes to the HivemindOS masking service, which returns a
// white-on-black mask CLIP the inpaint graph loads through its "sequence"
// branch, and charges the same HivemindOS credit balance the studio already
// spends on hosted models and rentals.
//
// TWO THINGS THIS MODULE INSISTS ON, because both are about consent:
//
//   1. The price is fetched and SHOWN before any footage moves. A mask that
//      silently costs money is a mask nobody would have asked for.
//   2. The figure the dialog displayed is sent back as the approved ceiling, so
//      a price that moved between the quote and the submit is refused rather
//      than quietly charged.
//
// This is also the one masking path where footage leaves the machine, which the
// dialog says beside the button rather than in a policy.
import { isHivemindStudioEnabled } from './hivemindStudio.js';

/** Is hosted masking reachable, switched on, and paid for? Never throws. */
export async function hostedSam3Status() {
  if (!isHivemindStudioEnabled()) return { available: false, configured: false, connected: false };
  try {
    const response = await fetch('/api/media-studio/sam3', { credentials: 'same-origin' });
    if (!response.ok) return { available: false, configured: false, connected: false };
    const data = await response.json().catch(() => ({}));
    return {
      available: Boolean(data.available),
      configured: Boolean(data.configured),
      connected: Boolean(data.connected),
    };
  } catch {
    // An unreachable service must not take the dialog down with it.
    return { available: false, configured: false, connected: false };
  }
}

/** What one mask would cost. Null when it cannot be priced — never a guess. */
export async function hostedSam3Quote({ frames, width, height }) {
  try {
    const response = await fetch('/api/media-studio/sam3/quote', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames, width, height }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const price = Number(data?.quote?.consumerPriceUsd);
    return Number.isFinite(price) && price > 0 ? { priceUsd: price, quote: data.quote } : null;
  } catch {
    return null;
  }
}

/** The price as a person reads it. Cents below a dollar, because $0.05 is the price. */
export function describeHostedPrice(priceUsd) {
  const value = Number(priceUsd);
  if (!Number.isFinite(value) || value <= 0) return '';
  return value < 1 ? `${Math.round(value * 100)}¢` : `$${value.toFixed(2)}`;
}

/**
 * Track the subject through the clip and return the mask clip as base64.
 *
 * `approvedUsd` is the figure the dialog SHOWED. It is not a formality: the
 * service refuses rather than charges when its own price exceeds it, which is
 * what makes the number on the button binding.
 */
export async function hostedSam3Mask({
  videoBase64, frames, width, height, prompt, detectionThreshold, maxObjects, detectInterval, approvedUsd,
}) {
  const response = await fetch('/api/media-studio/sam3/mask', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      video_base64: videoBase64,
      frames,
      width,
      height,
      prompt: prompt || 'head',
      detection_threshold: detectionThreshold ?? 0.5,
      max_objects: maxObjects ?? 1,
      detect_interval: detectInterval ?? 1,
      maximum_debit_usd: approvedUsd,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server sends {error, remedy} so the studio can put the ACTION beside
    // the sentence. A "top up" message with nothing to press is a dead end.
    const detail = data?.detail && typeof data.detail === 'object' ? data.detail : {};
    const error = new Error(String(detail.error || data?.detail || data?.error || 'Hosted masking failed.'));
    error.remedy = String(detail.remedy || '');
    throw error;
  }
  const mask = String(data.mask_video_base64 || '');
  if (!mask) throw new Error('The masking service returned no mask.');
  return { maskVideoBase64: mask, chargedUsd: Number(data.charged_usd) || null };
}
