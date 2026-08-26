// What the Video studio would run — answerable WITHOUT the Video studio.
//
// The Send-to picker used to read a registry that only a mounted studio wrote
// to, so a session that had never opened Video was told to go and open it and
// come back. That is not a fallback, it is homework: everything the answer
// needs is already on disk — the tab strip in sessionStorage, the model in the
// persisted video preferences, the workflow catalog in the shared studio
// context, the rentals in the shared machine cache.
//
// So the resolution lives here, once, and both callers use it: a mounted tab
// passes its LIVE setup (which may differ from what was last persisted), and
// the picker resolves from storage for every tab that is not mounted. Two
// implementations of "which model would this source land on" is exactly the
// drift this module exists to prevent.
import { loadTabState } from '../../lib/studioTabs.js';
import { VIDEO_PREFERENCES_KEY, normalizeVideoPreferences } from '../../lib/videoPreferences.js';
import {
  isHivemindStudioEnabled, loadHivemindStudioContext, referenceWorkflowForHivemindModel,
} from '../../lib/hivemindStudio.js';
import { rentedMachinesState, servedByAnyMachine } from '../../lib/rentedMachines.js';
import { deliveryPlan } from '../../lib/videoDelivery.js';
import { isLocalAIAvailable } from '../../lib/localInferenceClient.js';
import {
  adaptHivemindToVideoEntry, buildCatalogs, buildInitialSetup, generationModelsFor, isLocalVideoModel,
  resolveVideoModel,
} from './videoLogic.js';

const EMPTY_MACHINES = { live: [], idle: [], broken: [], provisioning: [] };

/** The models a source offers — the same list, filtered the same way, that the
 *  studio's own model menu shows for that source. */
export function videoModelsForSource(source, { setup, catalogs, machines = EMPTY_MACHINES, hasSourceToggle = true }) {
  const localMode = source !== 'api';
  const rentedOnly = source === 'rented';
  const live = machines.live || [];
  const probe = { ...setup, localMode, rentedOnly };
  return generationModelsFor(probe, catalogs)
    .filter((model) => !hasSourceToggle || isLocalVideoModel(model.id) === localMode)
    .filter((model) => !(rentedOnly && live.length) || servedByAnyMachine(live, model));
}

/**
 * One source, described: the model it would land on, what that model can be
 * handed, and — when something is in the way — what is actually wrong.
 *
 * A rented machine that is not LIVE is still a rented machine. Saying "no
 * machine is running" over a box that is merely unattached is a different and
 * wrong statement, and refusing the choice hides the one-click fix the Source
 * panel carries. Same vocabulary the generate guard uses, so the two never
 * disagree about what is wrong.
 */
export function videoSourceDescriptor(source, {
  setup, catalogs, machines = EMPTY_MACHINES, hasSourceToggle = true, zh = false,
} = {}) {
  const unavailable = (reason) => ({
    available: false, modelId: '', modelName: '', plan: null, switches: false, note: '', reason,
  });
  let note = '';
  if (source === 'rented') {
    const live = (machines.live || []).length;
    const idle = (machines.idle || []).length;
    const broken = (machines.broken || []).length;
    const provisioning = (machines.provisioning || []).length;
    if (!live && !idle && !broken && !provisioning) {
      return unavailable(zh ? '还没有租用机器' : 'No machine rented yet');
    }
    if (!live) {
      note = broken
        ? (zh ? '连接已断开——在“来源”面板重新连接' : 'connection lost — reconnect in the Source panel')
        : idle
          ? (zh ? '尚未接入本工作室——点“用于本工作室”' : 'not connected to this studio yet — "Use it here"')
          : (zh ? '仍在上线中' : 'still coming online');
    }
  }
  const offered = videoModelsForSource(source, { setup, catalogs, machines, hasSourceToggle });
  const chosen = offered.find((model) => model.id === setup?.modelId) || offered[0] || null;
  if (!chosen) {
    return unavailable(note
      ? `${zh ? '租用机器' : 'Rented machine'} — ${note}`
      : (zh ? '这个来源暂无视频模型' : 'No video model on this source'));
  }
  const entry = resolveVideoModel(chosen.id, catalogs) || chosen;
  return {
    available: true,
    modelId: chosen.id,
    modelName: chosen.name || chosen.id,
    // True when this source does not offer the model loaded now, so choosing it
    // MOVES the tab onto a different one. Said out loud rather than presented
    // as the model already in hand.
    switches: chosen.id !== setup?.modelId,
    note,
    // The catalog is the only authority on what a workflow can be sent, so the
    // lanes are read off the entry rather than inferred from the family.
    plan: deliveryPlan(
      { modelId: chosen.id, modelFamily: String(chosen.workflowFamily || entry.workflowFamily || '') },
      {
        referenceLane: Boolean(referenceWorkflowForHivemindModel(chosen.id)),
        ingredientsLane: Boolean(entry?.supportsIngredientImages),
        endFrame: Boolean(entry?.supportsEndFrame),
      },
    ),
  };
}

export const VIDEO_SOURCES = Object.freeze(['local', 'api', 'rented']);

/** All three sources for one setup. */
export const videoSourceDescriptors = (options) => Object.fromEntries(
  VIDEO_SOURCES.map((source) => [source, videoSourceDescriptor(source, options)]),
);

/** The last configuration the studio saved, or null when it has never run. */
function persistedVideoSetup() {
  try {
    const prefs = normalizeVideoPreferences(JSON.parse(localStorage.getItem(VIDEO_PREFERENCES_KEY) || 'null'));
    if (!prefs?.modelId) return null;
    return {
      modelId: prefs.modelId,
      modelFamily: '',
      // A boot with no saved answer runs on this machine when it can, which is
      // buildInitialSetup's own rule.
      localMode: typeof prefs.localMode === 'boolean'
        ? prefs.localMode
        : (isHivemindStudioEnabled() && isLocalAIAvailable()) || isLocalVideoModel(prefs.modelId),
      rentedOnly: Boolean(prefs.rentedOnly),
      imageMode: false,
    };
  } catch {
    return null;
  }
}

/**
 * Every tab the Video studio would show, described — whether or not it is
 * mounted. Reads only what is already stored, so it is safe to call from
 * another studio and cheap enough to call each time a menu opens.
 */
export async function resolveVideoSendTargets() {
  const { tabs, activeId } = loadTabState('video');
  const [context, machines] = await Promise.all([
    loadHivemindStudioContext().catch(() => null),
    rentedMachinesState().catch(() => EMPTY_MACHINES),
  ]);
  const hivemindI2V = (context?.videoModels || [])
    .filter((model) => !model.routingOnly)
    .map(adaptHivemindToVideoEntry);
  const catalogs = buildCatalogs(hivemindI2V);
  const hasSourceToggle = isLocalAIAvailable();
  // With nothing saved, the answer is whatever a fresh tab WOULD boot into —
  // asked of buildInitialSetup rather than guessed. Guessing it produced a menu
  // that promised minimax-h3 and a studio that came up on a cloud model, so the
  // pictures the row had counted did not travel.
  const setup = persistedVideoSetup() || buildInitialSetup(catalogs);
  return tabs.map((tab) => ({
    section: 'video',
    tabId: tab.id,
    index: tab.id,
    label: `Tab ${tab.id}`,
    active: tab.id === activeId,
    current: setup.rentedOnly ? 'rented' : setup.localMode ? 'local' : 'api',
    sources: videoSourceDescriptors({
      setup, catalogs, machines: machines || EMPTY_MACHINES, hasSourceToggle,
    }),
  }));
}
