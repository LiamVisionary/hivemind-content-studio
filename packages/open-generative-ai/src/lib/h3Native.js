// MiniMax H3 (Apple Silicon) — what the studio needs to draw its panel.
//
// The panel's whole vocabulary comes from two places and neither is this file:
// the REGISTRY says what the engine can do (the Effort presets, the dials
// behind them, their ranges, the sentence about token reduction), and the
// GATEWAY says what this Mac is (chip, memory, whether the engine is built,
// whether the checkpoint is there, which preset to start on). This module
// fetches the second and normalises the pair into the shape the panel renders.
//
// It deliberately holds no preset values of its own. A default written here
// would be a second copy of the registry's, and the two would drift the first
// time upstream's measured recipe changed.

// One profile per session, shared by every tab: it describes the machine, and
// the machine does not change between tabs. A failure is cached too, as null
// with a reason, so a studio on a box with no gateway does not re-ask on every
// render — `refreshH3NativeProfile` is the way back.
let profileCache = null;
let profileInFlight = null;

export function cachedH3NativeProfile() {
    return profileCache;
}

export async function loadH3NativeProfile({ refresh = false } = {}) {
    if (!refresh && profileCache) return profileCache;
    if (!refresh && profileInFlight) return profileInFlight;
    profileInFlight = (async () => {
        try {
            const response = await fetch(`/local-ai/h3-native/profile${refresh ? '?refresh=1' : ''}`, {
                credentials: 'same-origin',
                cache: 'no-store',
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data || data.ok === false) {
                // The lane's own readiness is the interesting failure; a
                // gateway that will not answer at all is reported as exactly
                // that, rather than as "MiniMax H3 is not installed".
                profileCache = { ok: false, unreachable: true, machine: null, presets: [], limits: null };
                return profileCache;
            }
            profileCache = { ok: true, unreachable: false, ...data };
            return profileCache;
        } catch {
            profileCache = { ok: false, unreachable: true, machine: null, presets: [], limits: null };
            return profileCache;
        } finally {
            profileInFlight = null;
        }
    })();
    return profileInFlight;
}

export function refreshH3NativeProfile() {
    profileCache = null;
    return loadH3NativeProfile({ refresh: true });
}

// Testing and sign-out both need the machine forgotten.
export function clearH3NativeProfile() {
    profileCache = null;
    profileInFlight = null;
}

/** The presets in ladder order, each with its dial values, from the registry. */
export function h3PresetLadder(nativeH3) {
    const order = Array.isArray(nativeH3?.preset_order) ? nativeH3.preset_order : [];
    const presets = nativeH3?.presets && typeof nativeH3.presets === 'object' ? nativeH3.presets : {};
    return order
        .filter((name) => presets[name])
        .map((name) => ({ name, ...presets[name] }));
}

/**
 * Which stop the slider sits on, and whether any dial has been moved off it.
 *
 * `setup` holds only what the person CHANGED — an untouched studio has no
 * preset and no dials, which is not "draft" but "whatever this Mac recommends".
 * That distinction is the whole reason the slider can start in the right place
 * on a 128 GB M5 and a different right place on a 16 GB Air.
 */
export function resolveH3Preset(setup, nativeH3, profile) {
    const ladder = h3PresetLadder(nativeH3);
    const recommended = String(profile?.machine?.recommended?.preset || '');
    const fallback = String(nativeH3?.default_preset || '');
    const chosen = String(setup?.preset || '');
    const name = [chosen, recommended, fallback].find((candidate) => ladder.some((item) => item.name === candidate))
        || (ladder[0]?.name || '');
    const preset = ladder.find((item) => item.name === name) || null;
    const index = Math.max(0, ladder.findIndex((item) => item.name === name));
    return { ladder, name, preset, index, explicit: Boolean(chosen), recommended };
}

/** The dials in effect: the preset's values, with anything overridden on top. */
export function effectiveH3Dials(setup, preset) {
    const base = preset || {};
    const read = (key) => (setup?.[key] === undefined || setup?.[key] === null ? base[key] : setup[key]);
    return {
        steps: read('steps'),
        layers: read('layers'),
        reuse: read('reuse'),
        core_reuse: read('core_reuse'),
        render_scale: read('render_scale'),
    };
}

/** Has anything been moved off the preset? Drives the "Custom" readout. */
export function h3DialsAreCustom(setup, preset) {
    if (!preset) return false;
    return ['steps', 'layers', 'reuse', 'core_reuse', 'render_scale']
        .some((key) => setup?.[key] !== undefined && setup?.[key] !== null && setup[key] !== preset[key]);
}

/**
 * The request payload, or null when there is nothing to say.
 *
 * Only what was actually chosen travels. An empty object here means the
 * gateway resolves the preset from the machine and every dial from the preset,
 * which is what makes "I did not touch anything" mean the right thing on every
 * different Mac rather than pinning one machine's answer into the request.
 */
export function h3NativeRequest(setup) {
    if (!setup || typeof setup !== 'object') return null;
    const payload = {};
    const preset = String(setup.preset || '').trim();
    if (preset) payload.preset = preset;
    for (const key of ['steps', 'layers', 'reuse', 'core_reuse']) {
        if (Number.isFinite(Number(setup[key])) && setup[key] !== null && setup[key] !== '') {
            payload[key] = Math.round(Number(setup[key]));
        }
    }
    if (Number.isFinite(Number(setup.render_scale)) && setup.render_scale !== null && setup.render_scale !== '') {
        payload.render_scale = Number(setup.render_scale);
    }
    for (const key of ['token_reduction', 'ssd_streaming', 'int8_row_fc2']) {
        if (typeof setup[key] === 'boolean') payload[key] = setup[key];
    }
    return Object.keys(payload).length ? payload : null;
}

/**
 * Whether token reduction can be armed at all with these dials.
 *
 * Upstream's own warning: paired tokens over a thinned, heavily reused
 * transformer is where the doubled frames come from, and the gateway refuses
 * that combination outright. The switch says so instead of silently doing
 * nothing.
 */
export function tokenReductionBlocked(dials) {
    return Number(dials?.layers) <= 40 && Number(dials?.reuse) >= 3;
}

/** The machine, said the way a person would say it. '' when unknown. */
export function h3MachineSummary(profile) {
    const machine = profile?.machine;
    if (!machine) return '';
    const memory = Number(machine.memory_gb);
    return [machine.chip, memory ? `${Math.round(memory)} GB unified memory` : '']
        .filter(Boolean).join(' · ');
}
