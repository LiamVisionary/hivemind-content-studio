// Studio tabs — pure bookkeeping for the Image/Video studio tab strips, plus the
// snapshot helpers that let a tab be duplicated with its whole configuration.
//
// Why tabs are cheap here: each studio keeps ALL of its state in one mutable
// "engine" object built once per mount (see createEngine in ImageStudio.jsx /
// VideoStudio.jsx). Mounting the studio component N times therefore gives N fully
// independent studios, and App already display-toggles mounted studios rather than
// tearing them down — so a background tab's generation keeps running exactly like a
// background *page* already did.
//
// Two boot modes distinguish a new tab from the original one:
//   'fresh' — ignore persisted preferences entirely: catalog defaults, empty prompt,
//             no LoRAs, no references, no per-model tuning cache.
//   'clone' — start from a snapshot of another tab's engine (config + prompt + LoRAs
//             + references), but none of its run state (history, progress, results).
// A tab with no seed at all is the original tab: it restores persisted preferences
// and owns the session-restore duties (pending-job resume, composer draft).

/* ---------------- tab list ---------------- */

// Tab ids are monotonic and never reused so a closed tab's api ref can't be
// confused with a later tab's. The visible label is the POSITION (1..N), which is
// why closing a middle tab renumbers the strip instead of leaving a gap.
export function newTabState() {
  return { tabs: [{ id: 1, seed: null }], activeId: 1, nextId: 2 };
}

export function addTab(state, seed = null) {
  const id = state.nextId;
  return { tabs: [...state.tabs, { id, seed }], activeId: id, nextId: id + 1 };
}

// A duplicate lands directly after the tab it was copied from — the copy and its
// source stay side by side however many tabs are open.
export function insertTabAfter(state, afterId, seed = null) {
  const id = state.nextId;
  const index = state.tabs.findIndex((tab) => tab.id === afterId);
  const tabs = [...state.tabs];
  tabs.splice(index < 0 ? tabs.length : index + 1, 0, { id, seed });
  return { tabs, activeId: id, nextId: id + 1 };
}

export function selectTab(state, id) {
  if (state.activeId === id || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id };
}

// Closing the active tab focuses its neighbour (the one that slid into its slot,
// or the new last tab). A studio always keeps at least one tab.
export function closeTab(state, id) {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId = state.activeId === id
    ? tabs[Math.min(index, tabs.length - 1)].id
    : state.activeId;
  return { ...state, tabs, activeId };
}

// The seed is consumed by the studio's first render; dropping it afterwards keeps
// duplicated reference images from being held twice for the life of the session.
export function consumeSeed(state, id) {
  if (!state.tabs.some((tab) => tab.id === id && tab.seed)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, seed: null } : tab)) };
}

/* ---------------- engine snapshots ---------------- */

// Structured deep copy that survives the Maps/Sets the studio engines keep
// (loraSelectionsByModel, modelSettingsById). A duplicated tab must share NOTHING
// mutable with its source, or editing one would edit the other.
export function cloneTabValue(value) {
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [key, cloneTabValue(entry)]));
  if (value instanceof Set) return new Set([...value].map(cloneTabValue));
  if (Array.isArray(value)) return value.map(cloneTabValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneTabValue(entry)]));
  }
  return value;
}

export function snapshotTabFields(engine, keys) {
  const snapshot = {};
  keys.forEach((key) => {
    if (!engine || !(key in engine)) return;
    snapshot[key] = cloneTabValue(engine[key]);
  });
  return snapshot;
}

// Image studio: the configuration a duplicate must carry. Deliberately EXCLUDES
// run state — history, gallery, progress/timers, viewer, dialogs, cloud-reference
// approvals, the discovered runtime catalog (each tab rediscovers it) and the
// generation-context store — so a copy starts with an empty canvas, not the
// original's results.
export const IMAGE_TAB_FIELDS = [
  'prompt', 'negativePrompt',
  'selectedModel', 'selectedModelName', 'useLocalModel', 'rentedOnly',
  'selectedLocalModel', 'localRuntimeMode',
  'imageMode', 'uploadedImageUrls', 'maxImages',
  'selectedAr', 'selectedResolution', 'guidanceScale', 'steps',
  'seed', 'seedText', 'selectedStyle', 'batchCount',
  'customWidth', 'customHeight', 'sampler', 'scheduler', 'baseSize', 'referenceStrength',
  'coupleMode', 'coupleDirection', 'coupleSplit', 'couplePair', 'coupleShared', 'coupleA', 'coupleB',
  'characterSheetMode', 'characterSheetPreset',
  'loraSelectionsByModel', 'modelSettingsById', 'loraOpen',
];

// Video studio: `setup` is the whole immutable configuration object, so it carries
// model, mode, duration, aspect, resolution, seed, keyframes and advanced values in
// one field. `catalogs` + the workflow signature come along so the copy is already
// resolved instead of flickering through the boot default while it rediscovers.
export const VIDEO_TAB_FIELDS = [
  'setup', 'catalogs', 'hivemindWorkflowSignature',
  'videoLoraSelectionsByModel', 'loraOpen',
  'sharedIngredientSelections', 'sharedIngredientSheets', 'selectedIngredientSheet',
];
