// "Open this model in that studio" — a one-shot handoff that survives the
// studio's own boot order.
//
// Writing the studio-wide preferences blob is NOT enough, and that is the whole
// reason this exists. A studio remounts on navigation and each of its tabs
// restores its own snapshot over the top (`VIDEO_TAB_FIELDS` includes `setup`,
// studioTabs.js), so a handoff that only wrote preferences was overwritten by
// whatever the front tab was last used with. Seen 2026-09-14: "Use in Video
// studio" on MiniMax H3 Eros opened the Video studio still on local Wan 2.2.
// The image studio was accidentally immune — it also writes the encrypted
// composer section, which it hydrates from — so this only ever showed on video.
//
// Same shape as requestRentedMode/consumeRentedModeRequest in rentedMachines.js
// (sessionStorage, claimed by the front tab, consumed exactly once); kept
// separate because that one carries a MODE and this carries a MODEL, and a
// studio can be handed either without the other.
const MODEL_HANDOFF_KEY = 'studio_open_model_once';

export function requestStudioModel(page, modelId) {
  const id = String(modelId || '').trim();
  if (!page || !id) return;
  try {
    sessionStorage.setItem(MODEL_HANDOFF_KEY, JSON.stringify({ page, modelId: id }));
  } catch { /* private mode — the preference write is still the fallback */ }
}

/** The model this page was handed, or '' — removed on read, so only one tab takes it. */
export function consumeStudioModelRequest(page) {
  try {
    const raw = sessionStorage.getItem(MODEL_HANDOFF_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    if (parsed?.page !== page) return '';
    sessionStorage.removeItem(MODEL_HANDOFF_KEY);
    return String(parsed.modelId || '');
  } catch {
    // Unparseable is not worth keeping: clear it so a corrupt value cannot
    // wedge every later handoff behind it.
    try { sessionStorage.removeItem(MODEL_HANDOFF_KEY); } catch { /* private mode */ }
    return '';
  }
}
