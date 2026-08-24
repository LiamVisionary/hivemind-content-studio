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
// A tab with no seed at all boots from persisted preferences. Which tab is the
// PRIMARY one — the one that adopts the composer draft and any ownerless pending
// job — is told to the studio explicitly by StudioTabs, because after a reload
// restores the strip every tab has a null seed and the two stopped being the
// same question.

/* ---------------- tab list ---------------- */

// Tab ids are monotonic and never reused so a closed tab's api ref can't be
// confused with a later tab's. The visible label is the POSITION (1..N), which is
// why closing a middle tab renumbers the strip instead of leaving a gap.
export function newTabState() {
  return { tabs: [{ id: 1, seed: null }], activeId: 1, nextId: 2 };
}

// Opaque scheduler lane sent with local generations. The app-instance token
// prevents Tab 1 in another browser window from sharing a queue; studio type
// keeps Image Tab 1 independent from Video Tab 1.
export function studioLaneId(studioType, instanceId, tabId) {
  const kind = String(studioType || 'studio').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'studio';
  const instance = String(instanceId || 'instance').replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'instance';
  const tab = Number.isSafeInteger(Number(tabId)) ? Number(tabId) : 0;
  return `${kind}:${instance}:${tab}`;
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

/* ---------------- session persistence ---------------- */

// The strip survives a RELOAD, not a new browser session — hence sessionStorage,
// the same store the pending-job registry uses. A reload lands mid-generation,
// and a tab that is not restored is a tab that can never claim the render it
// started: its job would sit in the registry with no owner, so the studio would
// look idle while the machine kept working (see pendingJobs.js).
//
// Only the ids are written. A seed is a CLONE SNAPSHOT — it holds the source
// tab's references and is consumed on first render — and a restored tab is no
// longer a copy of anything on screen, so it boots from persisted preferences
// like the original tab does. What comes back is the strip and the runs, not a
// per-tab configuration the studio never persisted in the first place.
const TAB_STATE_PREFIX = 'studio.tabs.';
const TAB_INSTANCE_KEY = 'studio.tabs.instance';
// A corrupt or hostile blob here MOUNTS STUDIOS, one per entry, so the restore
// is capped well above any plausible strip.
const MAX_RESTORED_TABS = 24;

const tabStateKey = (studioType) => `${TAB_STATE_PREFIX}${String(studioType || 'studio')}`;

export function saveTabState(studioType, state) {
  try {
    sessionStorage.setItem(tabStateKey(studioType), JSON.stringify({
      tabs: (state?.tabs || []).map((tab) => ({ id: tab.id })),
      activeId: state?.activeId,
      nextId: state?.nextId,
    }));
  } catch { /* storage disabled or full — the strip just doesn't survive */ }
}

// Validated field by field rather than trusted: ids must be distinct positive
// integers, and `nextId` must sit past every one of them, or a tab opened after
// the restore would reuse a live tab's id — and with it that tab's pending job.
export function readTabState(raw) {
  const ids = Array.isArray(raw?.tabs)
    ? raw.tabs.map((tab) => Number(tab?.id)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  const unique = [...new Set(ids)].slice(0, MAX_RESTORED_TABS);
  if (!unique.length) return newTabState();
  const maxId = Math.max(...unique);
  const wantedNext = Number(raw?.nextId);
  return {
    tabs: unique.map((id) => ({ id, seed: null })),
    activeId: unique.includes(Number(raw?.activeId)) ? Number(raw.activeId) : unique[0],
    nextId: Number.isSafeInteger(wantedNext) && wantedNext > maxId ? wantedNext : maxId + 1,
  };
}

export function loadTabState(studioType) {
  try {
    return readTabState(JSON.parse(sessionStorage.getItem(tabStateKey(studioType)) || 'null'));
  } catch {
    return newTabState();
  }
}

// The app-instance half of `studioLaneId`, held for the life of the browser tab.
// It used to be minted per mount, which meant a reload moved every restored tab
// onto a fresh scheduler lane — so the next generation would no longer queue
// behind the run it just resumed, and the two would fight over the same GPU.
export function studioInstanceId() {
  try {
    const saved = sessionStorage.getItem(TAB_INSTANCE_KEY);
    if (saved) return saved;
  } catch { /* fall through to a fresh, unpersisted id */ }
  const minted = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try { sessionStorage.setItem(TAB_INSTANCE_KEY, minted); } catch { /* non-critical */ }
  return minted;
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
  'selectedModel', 'selectedModelName', 'useLocalModel', 'rentedOnly', 'rentedMachineId',
  'selectedLocalModel', 'localRuntimeMode',
  'imageMode', 'uploadedImageUrls', 'maxImages',
  // What each reference supplies, the UGC deal counters and the open Custom
  // aspect tile travel with the references they describe.
  'referenceRoles', 'ugcVariantIndex', 'ugcRoomIndex', 'customArOpen',
  'selectedAr', 'selectedResolution', 'guidanceScale', 'steps',
  'seed', 'seedText', 'selectedStyle', 'batchCount',
  'customWidth', 'customHeight', 'sampler', 'scheduler', 'baseSize', 'referenceStrength',
  'coupleMode', 'coupleDirection', 'coupleSplit', 'couplePair', 'coupleShared', 'coupleA', 'coupleB',
  'regionMode', 'regions',
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
  // Who is in the shot, which words of the prompt are still stand-ins, and the
  // Shots timeline — all plain arrays/objects on the tab, all part of "the same
  // setup" a copy is expected to open with.
  'cast', 'standIns', 'shotTimeline',
];
