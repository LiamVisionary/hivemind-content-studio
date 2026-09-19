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

import { dropDrafts, readDraft, writeDraft } from './draftVault.js';

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
// Each tab's own SETTINGS travel with its id, so a reload brings back the strip
// as it stood rather than N copies of the studio-wide preferences. Before this,
// only ids were written and every restored tab re-read the same one blob — so
// three tabs set up three different ways came back identical.
//
// What is deliberately NOT written here is text a person typed. Prompts, the
// negative prompt, the stand-in words and the shot timeline go to the draft
// vault instead (lib/draftVault.js), encrypted under a key this browser cannot
// export and never sends anywhere. This store is sessionStorage, which is
// plaintext, so it carries the machine-readable configuration and the output
// the tab is showing, and nothing that reads back as writing.
//
// The two halves are rejoined on the way in, so a restored tab boots with its
// own words. That is the whole trick: the split is a storage detail, and a tab
// that comes back is the tab that left. See stripPrivateSnapshotFields (what
// sessionStorage may keep) and takePrivateSnapshotFields (what it may not).
const TAB_STATE_PREFIX = 'studio.tabs.';
const TAB_INSTANCE_KEY = 'studio.tabs.instance';
// A corrupt or hostile blob here MOUNTS STUDIOS, one per entry, so the restore
// is capped well above any plausible strip.
const MAX_RESTORED_TABS = 24;

const tabStateKey = (studioType) => `${TAB_STATE_PREFIX}${String(studioType || 'studio')}`;

// Text a person wrote never reaches sessionStorage. Everything listed here is
// already persisted encrypted in the composer and comes back on hydrate; what is
// left in a snapshot is model/params/geometry, which is what the studio-wide
// preferences have always kept in plaintext too.
export const PRIVATE_SNAPSHOT_FIELDS = {
  image: ['prompt', 'negativePrompt'],
  // cast + standIns already ride the encrypted composer draft (rememberCast);
  // shotTimeline holds a line of prompt per shot.
  video: ['standIns', 'shotTimeline', 'cast'],
};

// The same secrets as PRIVATE_SNAPSHOT_FIELDS, written as paths so the ones
// buried inside `setup`, a Map of per-model tuning, or the result tile can be
// LIFTED OUT and put back rather than only blanked. `*` walks every entry of an
// object or a Map. Kept beside the strip list on purpose: a field added to one
// and not the other is a leak or a loss, and they read as one rule here.
const PRIVATE_SNAPSHOT_PATHS = {
  image: [
    ['prompt'],
    ['negativePrompt'],
    ['result', 'prompt'],
    ['modelSettingsById', '*', 'negativePrompt'],
    ['persistedImagePreferences', 'modelSettings'],
  ],
  video: [
    ['standIns'],
    ['shotTimeline'],
    ['cast'],
    ['setup', 'prompt'],
    ['result', 'prompt'],
  ],
};

// Always returns a MIRROR of the path ({a:{b:value}}), never a bare leaf, so
// the merge below can walk the payload and the snapshot in lockstep.
function takePath(source, path) {
  const [head, ...rest] = path;
  if (head === '*') {
    const entries = source instanceof Map ? [...source] : Object.entries(source || {});
    const out = {};
    for (const [key, entry] of entries) {
      const taken = takePath(entry, rest);
      if (taken !== undefined) out[key] = taken;
    }
    return Object.keys(out).length ? out : undefined;
  }
  const value = source instanceof Map ? source.get(head) : source?.[head];
  if (value === undefined || value === null || value === '') return undefined;
  if (!rest.length) return { [head]: value };
  const nested = takePath(value, rest);
  return nested === undefined ? undefined : { [head]: nested };
}

function applyPath(target, source, path) {
  if (!target || typeof target !== 'object' || !source || typeof source !== 'object') return;
  const [head, ...rest] = path;
  if (head === '*') {
    for (const key of Object.keys(source)) {
      // Only into entries the restored snapshot still has: a model whose tuning
      // was dropped since must not be resurrected by its old negative prompt.
      const child = target instanceof Map ? target.get(key) : target[key];
      if (child === undefined) continue;
      applyPath(child, source[key], rest);
    }
    return;
  }
  const value = source[head];
  if (value === undefined) return;
  if (!rest.length) {
    if (target instanceof Map) target.set(head, value);
    else target[head] = value;
    return;
  }
  applyPath(target instanceof Map ? target.get(head) : target[head], value, rest);
}

function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      deepAssign(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Everything stripPrivateSnapshotFields takes away, on its own — the half of a
 * tab's snapshot that goes to the encrypted draft vault instead of to
 * sessionStorage. Plain JSON: the Map keys come back as object keys.
 */
export function takePrivateSnapshotFields(studioType, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const out = {};
  for (const path of PRIVATE_SNAPSHOT_PATHS[String(studioType)] || []) {
    const taken = takePath(snapshot, path);
    if (taken !== undefined) deepAssign(out, taken);
  }
  return out;
}

/** Put a decrypted draft back into the snapshot it was taken out of. */
export function mergePrivateSnapshotFields(studioType, snapshot, draft) {
  if (!snapshot || typeof snapshot !== 'object' || !draft || typeof draft !== 'object') return snapshot;
  for (const path of PRIVATE_SNAPSHOT_PATHS[String(studioType)] || []) {
    applyPath(snapshot, draft, path);
  }
  return snapshot;
}

/** Where one tab's typed text is filed in the draft vault. */
export function draftScope(studioType, tabId) {
  return `${String(studioType || 'studio')}:${Number(tabId) || 0}`;
}

export function stripPrivateSnapshotFields(studioType, snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const out = cloneTabValue(snapshot);
  for (const key of PRIVATE_SNAPSHOT_FIELDS[String(studioType)] || []) delete out[key];
  // The video studio keeps its prompt INSIDE the setup object, which is
  // otherwise the whole configuration and has to survive.
  if (out.setup && typeof out.setup === 'object' && 'prompt' in out.setup) out.setup = { ...out.setup, prompt: '' };
  // Per-model tuning caches carry their own negative prompt.
  if (out.modelSettingsById instanceof Map) {
    out.modelSettingsById = new Map([...out.modelSettingsById].map(([key, entry]) => [
      key,
      entry && typeof entry === 'object' ? { ...entry, negativePrompt: '' } : entry,
    ]));
  }
  if (out.persistedImagePreferences?.modelSettings) {
    out.persistedImagePreferences = { ...out.persistedImagePreferences, modelSettings: undefined };
  }
  // The result a tab is showing: its URL and how it was made, never its words.
  if (out.result && typeof out.result === 'object') {
    const { prompt: _dropped, ...rest } = out.result;
    out.result = rest;
  }
  return out;
}

// Maps and Sets do not survive JSON. The studio engines keep two of them
// (loraSelectionsByModel, modelSettingsById), so they are tagged on the way out
// and rebuilt on the way in — the same job cloneTabValue does for a duplicate,
// which stays in memory and needs none of this.
function toStorable(value) {
  if (value instanceof Map) return { __map: [...value].map(([k, v]) => [k, toStorable(v)]) };
  if (value instanceof Set) return { __set: [...value].map(toStorable) };
  if (Array.isArray(value)) return value.map(toStorable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStorable(v)]));
  }
  return value;
}

function fromStorable(value) {
  if (Array.isArray(value)) return value.map(fromStorable);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.__map)) return new Map(value.__map.map(([k, v]) => [k, fromStorable(v)]));
    if (Array.isArray(value.__set)) return new Set(value.__set.map(fromStorable));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromStorable(v)]));
  }
  return value;
}

export function saveTabState(studioType, state, snapshots = null) {
  // The words first, and to the other store: a tab whose snapshot is captured
  // here files its typed text in the draft vault under its own id, so every
  // OPEN tab keeps its own — not just whichever one was in front when the
  // single studio-wide draft was last written.
  for (const tab of state?.tabs || []) {
    if (!snapshots?.[tab.id]) continue;
    writeDraft(draftScope(studioType, tab.id), takePrivateSnapshotFields(studioType, snapshots[tab.id]));
  }
  try {
    sessionStorage.setItem(tabStateKey(studioType), JSON.stringify({
      tabs: (state?.tabs || []).map((tab) => {
        const snapshot = snapshots?.[tab.id]
          ? stripPrivateSnapshotFields(studioType, snapshots[tab.id])
          : null;
        return snapshot ? { id: tab.id, snapshot: toStorable(snapshot) } : { id: tab.id };
      }),
      activeId: state?.activeId,
      nextId: state?.nextId,
    }));
  } catch { /* storage disabled or full — the strip just doesn't survive */ }
}

/**
 * Forget the drafts of tabs that are no longer open in this studio.
 *
 * Closing a tab is a deliberate "I am done with this", so its words go with it
 * rather than waiting to be aged out. Scoped to ONE studio's prefix: the image
 * strip knows nothing about which video tabs are open.
 */
export function pruneClosedTabDrafts(studioType, state) {
  const prefix = `${String(studioType || 'studio')}:`;
  const open = new Set((state?.tabs || []).map((tab) => draftScope(studioType, tab.id)));
  dropDrafts((scope) => !scope.startsWith(prefix) || open.has(scope));
}

// Validated field by field rather than trusted: ids must be distinct positive
// integers, and `nextId` must sit past every one of them, or a tab opened after
// the restore would reuse a live tab's id — and with it that tab's pending job.
export function readTabState(raw, studioType = '') {
  const ids = Array.isArray(raw?.tabs)
    ? raw.tabs.map((tab) => Number(tab?.id)).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  const unique = [...new Set(ids)].slice(0, MAX_RESTORED_TABS);
  if (!unique.length) return newTabState();
  const maxId = Math.max(...unique);
  const wantedNext = Number(raw?.nextId);
  // A restored tab boots from its OWN settings when it has them, and from the
  // studio-wide preferences when it does not (an older strip, or a tab that was
  // never fronted and so never published a snapshot).
  // Each tab's words are rejoined with its settings here, from the decrypted
  // draft cache — which is why hydrateDrafts() is awaited before React mounts
  // (main.jsx). A draft that is missing (another browser, cleared site data, a
  // key this browser cannot hold) simply leaves the prompt empty; the rest of
  // the tab still comes back.
  const saved = new Map(
    (Array.isArray(raw?.tabs) ? raw.tabs : [])
      .filter((tab) => tab && typeof tab.snapshot === 'object' && tab.snapshot)
      .map((tab) => [
        Number(tab.id),
        mergePrivateSnapshotFields(
          studioType, fromStorable(tab.snapshot), readDraft(draftScope(studioType, tab.id)),
        ),
      ]),
  );
  return {
    tabs: unique.map((id) => ({
      id,
      seed: saved.has(id) ? { boot: 'restore', snapshot: saved.get(id) } : null,
    })),
    activeId: unique.includes(Number(raw?.activeId)) ? Number(raw.activeId) : unique[0],
    nextId: Number.isSafeInteger(wantedNext) && wantedNext > maxId ? wantedNext : maxId + 1,
  };
}

export function loadTabState(studioType) {
  try {
    return readTabState(JSON.parse(sessionStorage.getItem(tabStateKey(studioType)) || 'null'), studioType);
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
  'selectedModel', 'selectedModelName', 'selectedProvider', 'runOnAutomatic',
  'useLocalModel', 'rentedMachineId',
  'selectedLocalModel', 'localRuntimeMode',
  'imageMode', 'uploadedImageUrls', 'maxImages',
  // What each reference supplies, the UGC deal counters and the open Custom
  // aspect tile travel with the references they describe.
  'referenceRoles', 'ugcVariantIndex', 'ugcRoomIndex', 'customArOpen',
  'selectedAr', 'selectedResolution', 'guidanceScale', 'steps',
  'seed', 'seedText', 'selectedStyle', 'batchCount',
  'customWidth', 'customHeight', 'sampler', 'scheduler', 'baseSize',
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
