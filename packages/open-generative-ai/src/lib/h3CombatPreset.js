// The fight preset — MiniMax H3 tuned for combat, and untuned again.
//
// Every other H3 door here writes WORDS. This one moves the dials, which is a
// different contract and the reason it carries a snapshot: a preset that
// changes six settings and cannot put them back is a trap, so arming records
// what each dial held and disarming writes exactly that back. Nothing is
// guessed on the way out — a dial the preset never touched is never restored.
//
// WHERE THE RECIPE COMES FROM. A community write-up of H3 combat/continuity
// tests (2026-09-19, PlagueKind workflow + Kijai's 4-step fastvideo distill on
// a 5070 Ti), read against what this studio's own lanes can actually do:
//
//   "Realism is improved via prompt and generation MP. The higher the better."
//      -> resolution to Max, H3's own trained canvas (~1 MP), which is also
//         where resolutionsFor() stops. The studio has no MP slider; Max IS it.
//   "able to produce better overall quality videos at higher MP in less time"
//      -> fast high-res. That report bought its speed with a distilled 4-step
//         checkpoint we do not ship; the equivalent lever we DO have is the
//         two-pass latent upscale, which samples most steps on a fraction of
//         the rows and lifts the result. It is also why Max and fast high-res
//         arm together: below the registry's min_upscale_factor (1.3) the two
//         passes are not worth their overhead and the compiler drops back to
//         the single-pass graph, so at Standard this switch does nothing.
//   "Normal motion is handled great, fast motion is a limitation … Frame
//    interpolation can help a lot with smoothing frame jitter out with almost
//    no extra cost to gen time."
//      -> interpolation 2x. The node has been sitting in every H3 graph since
//         the lane shipped (FrameInterpolate, multiplier 1 = off) and nothing
//         in the studio had ever turned it on.
//   "Combat requires patience and a LORA or two."
//      -> patience is Spectrum OFF. The forecaster predicts roughly half the
//         sampling steps instead of computing them, which the registry's own
//         note says softens fine detail and blooms highlights — the two things
//         a contact frame is made of. The LoRA is arm-if-installed: this can
//         only select what the lane reports (lib/loraSelection.js), never
//         conjure a file, so when none matches the menu says so and names the
//         source rather than arming a preset that quietly did four of five
//         things.
//
// TWO FINDINGS DELIBERATELY NOT AUTOMATED, because both are things only the
// person writing the shot can do, and a preset that pretended otherwise would
// be worse than the sentence that tells them:
//   - wide shots lose faces (the write-up's fix is a FaceRefine node this
//     studio's lanes do not carry, and it only works single-subject anyway);
//   - expressions and set continuity come from attaching an extra reference —
//     an expression still, a crop of the destroyed wall — and calling it out.
//     The References panel already writes a retention_analysis line per
//     attached reference (h3References.js); what it cannot do is decide which
//     picture to take.
// Both ride in `COMBAT_NOTES`, which the menu prints.
//
// The lane decides what applies. The dials below are capability-gated exactly
// the way the send path gates them (videoLogic.supportsSpectrum and friends,
// derived in ONE place from the registry's `accepts`), so the same preset arms
// four things on a rented 5090, three on the hosted lane, and a different set
// on the Apple-silicon h3.c lane, which has no Spectrum, no two-pass and no
// interpolation node but does have its own speed shortcuts to switch off.
import { stripPhrase, appendPhrase } from './h3PromptPhrase.js';

/* ---------------- the direction sentence ---------------- */

// Same replace-not-stack contract as the performance and style phrases, and
// the same two dialects for the same reason: H3 renders the audio too, so a
// punch with no sound comes back mimed. Impersonal on purpose — which body is
// fighting is a fact only the prompt knows.
export const COMBAT_PHRASE_PROSE = 'Fight direction: the exchange runs at real-time speed with no slow motion and no ramping. Each strike carries body weight through the hips and shoulders, contact visibly moves the body it lands on, and the recovery between beats is short and off-balance rather than reset and clean.';

export const COMBAT_PHRASE_H3 = 'Fight direction: the exchange runs at real-time speed with no slow motion and no ramping. Each strike carries body weight through the hips and shoulders and lands on a short dry impact sound with the breath forced out of the body it hits; feet scuff and clothing snaps with the movement. Contact visibly moves the body it lands on, and the recovery between beats is short and off-balance rather than reset and clean.';

export function combatPhrase({ h3 = false } = {}) {
  return h3 ? COMBAT_PHRASE_H3 : COMBAT_PHRASE_PROSE;
}

/** Whether either dialect of the direction is already written into `prompt`. */
export function combatPhraseInPrompt(prompt) {
  const source = String(prompt || '');
  return source.includes(COMBAT_PHRASE_PROSE) || source.includes(COMBAT_PHRASE_H3);
}

/**
 * Arm (`armed`) or clear the direction. Both dialects are stripped first,
 * because the model can change under an applied phrase — arm the preset on a
 * rented H3 lane, switch to a cloud model, and the phrase in the box is the H3
 * one.
 */
export function applyCombatPrompt(prompt, armed, { h3 = false } = {}) {
  let base = stripPhrase(String(prompt || ''), COMBAT_PHRASE_PROSE);
  base = stripPhrase(base, COMBAT_PHRASE_H3).trim();
  return armed ? appendPhrase(base, combatPhrase({ h3 })) : base;
}

/* ---------------- the LoRA ---------------- */

// Named by what it IS, not by a file this machine may or may not hold. The
// studio lists whatever the lane has installed and this picks the first row
// that reads like a fight LoRA; `source` is what the menu offers when nothing
// matches, and it is a link for a person to follow, never a download this
// arms on its own.
export const COMBAT_LORA = Object.freeze({
  match: /\b(combat|fight|fighting|melee|punch|impact|brawl)\b/i,
  label: 'a combat / fight-motion LoRA',
  source: 'https://civitai.com/models/2853878',
  sourceLabel: 'MiniMax H3 Combat Base (Civitai)',
});

/**
 * The installed LoRA the preset would arm, or null. Rows already selected are
 * fine to return — the caller reconciles, so re-arming never double-adds.
 */
export function combatLoraFrom(available) {
  const rows = Array.isArray(available) ? available : [];
  return rows.find((lora) => COMBAT_LORA.match.test(
    `${lora?.displayName || ''} ${lora?.name || ''} ${lora?.id || ''}`,
  )) || null;
}

/* ---------------- the dials ---------------- */

// One row per dial the preset can move, in the order the menu lists them.
// `applies` reads the CAPABILITY the send path reads, never the model id: a
// lane that cannot compile the two-pass graph must not be told it will.
const DIALS = Object.freeze([
  Object.freeze({
    key: 'resolution',
    label: 'Size',
    to: 'Max',
    why: 'H3’s own trained canvas (~1 MP). Realism climbs with megapixels and stops climbing here.',
    applies: ({ resolutions }) => (resolutions || []).includes('Max'),
    read: (setup) => String(setup.resolution || ''),
    same: (setup) => setup.resolution === 'Max',
    write: (setup) => ({ ...setup, resolution: 'Max' }),
    shows: (setup) => String(setup.resolution || ''),
  }),
  Object.freeze({
    key: 'fastHighRes',
    label: 'Fast high-res',
    to: true,
    why: 'Pays for the bigger canvas: most steps sample small, then the picture is lifted to full size.',
    applies: ({ capabilities }) => Boolean(capabilities.fastHighRes),
    read: (setup) => setup.fastHighRes === true,
    same: (setup) => setup.fastHighRes === true,
    write: (setup) => ({ ...setup, fastHighRes: true }),
    shows: (setup) => (setup.fastHighRes === true ? 'on' : 'off'),
  }),
  Object.freeze({
    key: 'spectrum',
    label: 'Spectrum',
    to: false,
    why: 'Off. Forecasting predicts about half the steps, which softens fine detail and blooms highlights — what a contact frame is made of.',
    applies: ({ capabilities }) => Boolean(capabilities.spectrum),
    read: (setup) => setup.spectrum,
    same: (setup) => setup.spectrum === false,
    write: (setup) => ({ ...setup, spectrum: false }),
    shows: (setup) => (setup.spectrum === false ? 'off' : 'on'),
  }),
  Object.freeze({
    key: 'interpolate',
    label: 'Motion smoothing',
    to: 2,
    why: '2×. Fast motion is where H3 jitters; interpolating the decoded frames smooths it for almost no render time.',
    applies: ({ capabilities }) => Boolean(capabilities.interpolation),
    read: (setup) => setup.interpolate,
    same: (setup) => Number(setup.interpolate) === 2,
    write: (setup) => ({ ...setup, interpolate: 2 }),
    shows: (setup) => (Number(setup.interpolate) >= 2 ? `${Math.round(Number(setup.interpolate))}×` : 'off'),
  }),
  Object.freeze({
    key: 'h3Native',
    label: 'Engine shortcuts',
    // h3.c's presets buy their speed by dropping transformer blocks and reusing
    // the velocity field between steps. Reuse is the one that matters here: it
    // assumes the step-to-step change is small, which is the assumption fast
    // motion breaks. Marked INFERRED from the engine's own description — this
    // pairing has not been A/B'd on a fight clip.
    why: 'Every transformer block, no velocity reuse, full internal canvas. The speed shortcuts assume little changes between steps, which is the assumption fast motion breaks.',
    applies: ({ capabilities }) => Boolean(capabilities.nativeH3),
    read: (setup) => (setup.h3Native ? { ...setup.h3Native } : null),
    same: (setup) => {
      const h3 = setup.h3Native || {};
      return h3.preset === 'balanced' && h3.reuse === 1 && h3.render_scale === 1 && h3.token_reduction === false;
    },
    write: (setup) => ({
      ...setup,
      h3Native: {
        ...(setup.h3Native || {}),
        preset: 'balanced',
        reuse: 1,
        render_scale: 1,
        token_reduction: false,
      },
    }),
    shows: (setup) => (setup.h3Native?.preset ? String(setup.h3Native.preset) : 'machine default'),
  }),
]);

/** What the preset will not touch, and the one thing to do about each. */
export const COMBAT_NOTES = Object.freeze([
  'Keep the take short and put the action early — H3 spreads whatever it is given over the whole timeline, which is what makes a long fight read as slow motion.',
  'Wide shots lose faces. Frame closer, or keep one fighter in the shot.',
  'For a hit that has to match the last shot — the same broken wall, the same positions — attach a crop of it as a reference picture; the References panel writes its retention line.',
]);

/* ---------------- the plan ---------------- */

/**
 * What arming would do on THIS lane: the dials that will move, the ones that
 * do not apply here, and the LoRA situation. Pure, so the menu and the tests
 * read the same answer.
 *
 * `capabilities` is the model's own — supportsSpectrum / supportsFastHighRes /
 * nativeH3 as videoLogic reads them — plus `interpolation`, which is the same
 * registry `accepts` derivation.
 */
export function combatPlan({ setup = {}, capabilities = {}, resolutions = [], availableLoras = [] } = {}) {
  const context = { capabilities, resolutions };
  const changes = [];
  const alreadySet = [];
  const unavailable = [];
  DIALS.forEach((dial) => {
    if (!dial.applies(context)) {
      unavailable.push({ key: dial.key, label: dial.label });
      return;
    }
    (dial.same(setup) ? alreadySet : changes).push({
      key: dial.key,
      label: dial.label,
      from: dial.shows(setup),
      why: dial.why,
    });
  });
  const lora = combatLoraFrom(availableLoras);
  return {
    changes,
    alreadySet,
    unavailable,
    lora,
    // Nothing to arm at all means the selected lane is not one of H3's: the
    // menu is H3-only, but a lane can still be capability-poor.
    empty: changes.length === 0 && alreadySet.length === 0,
  };
}

/**
 * Arm the preset. Returns the next setup and the snapshot to restore from —
 * only the dials that APPLY on this lane are recorded, so disarming on a lane
 * cannot write back a value that lane never had.
 *
 * `loraIds` is what was selected before; the caller owns the selection list
 * (it lives per model, not on setup) and puts it back the same way.
 */
export function armCombat(setup, { capabilities = {}, resolutions = [], loraIds = [] } = {}) {
  const context = { capabilities, resolutions };
  // The lane the snapshot belongs to. A dial value read on a rented 5090 is not
  // a value the Apple-silicon lane ever held, so switching models under an
  // armed preset re-arms against the new lane instead of carrying a snapshot
  // that would restore the wrong thing (the studio's re-arm effect reads this).
  const snapshot = { modelId: String(setup?.modelId || ''), dials: {}, loraIds: [...loraIds] };
  let next = { ...setup };
  DIALS.forEach((dial) => {
    if (!dial.applies(context)) return;
    // `undefined` is not a value to restore — it is the absence of one, and it
    // would not survive the plaintext settings blob either (JSON drops it), so
    // a dial that was never set is recorded as the null that means "the
    // workflow's own default".
    const held = dial.read(next);
    snapshot.dials[dial.key] = held === undefined ? null : held;
    next = dial.write(next);
  });
  return { setup: { ...next, combat: snapshot }, snapshot };
}

/**
 * Put the dials back exactly as they were. A snapshot key that is absent was
 * never armed and is left alone; `undefined` is not a value to restore, it is
 * the absence of one.
 */
export function disarmCombat(setup, snapshot = null) {
  const saved = snapshot || setup?.combat || null;
  const next = { ...setup, combat: null };
  const dials = saved?.dials || {};
  DIALS.forEach((dial) => {
    if (!Object.prototype.hasOwnProperty.call(dials, dial.key)) return;
    const value = dials[dial.key];
    if (dial.key === 'h3Native') next.h3Native = value ? { ...value } : null;
    else next[dial.key] = value;
  });
  return next;
}

/** The LoRA rows to restore on disarm, or null when none was recorded. */
export function combatRestoredLoraIds(setup, snapshot = null) {
  const saved = snapshot || setup?.combat || null;
  return Array.isArray(saved?.loraIds) ? saved.loraIds : null;
}

/** The lane an armed snapshot was taken on, or '' when it holds none. */
export function combatSnapshotModelId(setup) {
  return String(setup?.combat?.modelId || '');
}

export function isCombatArmed(setup) {
  return Boolean(setup?.combat);
}

/**
 * The snapshot, normalized for the plaintext settings blob. Dial values only —
 * numbers, booleans, short strings and the h3.c bag — and a hard cap on the
 * LoRA ids, so a corrupted or hostile blob cannot ride back in as state.
 */
export function normalizeCombatSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const dials = {};
  const source = (value.dials && typeof value.dials === 'object' && !Array.isArray(value.dials)) ? value.dials : {};
  DIALS.forEach((dial) => {
    if (!Object.prototype.hasOwnProperty.call(source, dial.key)) return;
    const saved = source[dial.key];
    if (dial.key === 'h3Native') {
      dials.h3Native = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? { ...saved } : null;
      return;
    }
    if (saved === null) { dials[dial.key] = null; return; }
    if (typeof saved === 'boolean' || (typeof saved === 'number' && Number.isFinite(saved))) {
      dials[dial.key] = saved;
      return;
    }
    if (typeof saved === 'string' && saved.length <= 64) dials[dial.key] = saved;
  });
  if (!Object.keys(dials).length) return null;
  const loraIds = Array.isArray(value.loraIds)
    ? value.loraIds.filter((id) => typeof id === 'string' && id && id.length <= 256).slice(0, 16)
    : [];
  const modelId = (typeof value.modelId === 'string' && value.modelId.length <= 256) ? value.modelId : '';
  return { modelId, dials, loraIds };
}
