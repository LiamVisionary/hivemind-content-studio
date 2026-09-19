// The music lane — the browser half of local text-to-music (ACE-Step 1.5).
//
// Pure of React on purpose, the same way workflowDependencies.js is: every
// branch below is reachable from node, and the studio that renders it holds no
// logic of its own beyond what is on screen.
//
// WHY THIS TALKS TO /local-ai DIRECTLY instead of going through
// localInferenceClient's `window.localAI`. That bridge is the desktop preload
// surface, method by method, and the browser build fills it in from
// public/hosted-local-ai.js — a file this studio does not own. Music needs three
// endpoints the preload surface does not name, and every one of them is a plain
// same-origin GET/POST that the studio's own host already proxies (the `apiBase`
// rule below is lifted from hosted-local-ai.js verbatim, so the two agree about
// where /local-ai lives). The preflight installer is the exception and stays on
// the bridge, because `checkWorkflowDependencies` IS a named method there and a
// second implementation of it would be a second answer to "what is missing".
//
// WHAT THE ROW DECIDES. Everything the composer renders comes off the model row
// — `accepts` says which controls exist at all, `limits` bounds them, `defaults`
// seeds them, `samplers`/`schedulers` fill the two selects. An audio graph has
// no skeleton to infer any of that from (no dimensions, a duration that lives in
// two nodes at once, a "prompt" that is a style-tag list sitting beside separate
// lyrics), so the registry row is the contract and this module never guesses
// past it.

// Where /local-ai answers. Copied from public/hosted-local-ai.js: the studio is
// served at "/" by its own host and at "/open-gen" behind the control plane, and
// the second mounts its bridge one path segment deeper.
function apiBase() {
    try {
        return window.location.pathname.startsWith('/open-gen') ? '/open-gen-api' : '';
    } catch {
        return '';
    }
}

async function localAiJson(path, options = {}) {
    const response = await fetch(`${apiBase()}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        // Shaped failures first: the host writes the sentence a person is shown
        // and sometimes the repair beside it. `error` is the older key.
        const failure = new Error(data.message || data.error || data.detail || `HTTP ${response.status}`);
        if (data.remedy) failure.remedy = data.remedy;
        failure.status = response.status;
        throw failure;
    }
    return data;
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

/** Statuses a music catalogue fetch can land on, mirroring the image one. */
export const MUSIC_CATALOG_STATUSES = Object.freeze(['loading', 'ready', 'empty', 'unreachable']);

/**
 * The rows this machine can offer, and why there are none when there are none.
 *
 * Never rejects. "The host did not answer" and "there is no music model" are
 * different sentences on screen, and an empty array cannot tell them apart —
 * the same mistake localInferenceClient.listModels was fixed for.
 */
export async function listMusicModels() {
    let rows;
    try {
        rows = await localAiJson('/local-ai/audio-models');
    } catch (error) {
        return { models: [], status: 'unreachable', error };
    }
    const models = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id);
    return { models, status: models.length ? 'ready' : 'empty' };
}

/** The row a fresh studio opens on: the declared default, else the first. */
export function defaultMusicModel(models = []) {
    return models.find((model) => model.isDefault) || models[0] || null;
}

/* ------------------------------------------------------------------ */
/* The composer's setup                                                */
/* ------------------------------------------------------------------ */

/** Does this row take this control at all? Nothing else may render one. */
export function accepts(model, key) {
    return Array.isArray(model?.accepts) && model.accepts.includes(key);
}

/** The seconds a row allows, as [min, max]. Ten minutes is ACE-Step's own cap. */
export function secondsRange(model) {
    const limit = model?.limits?.seconds || {};
    const min = Number(limit.min) > 0 ? Number(limit.min) : 10;
    const max = Number(limit.max) > 0 ? Number(limit.max) : 600;
    return [min, Math.max(min, max)];
}

export function clampSeconds(model, value) {
    const [min, max] = secondsRange(model);
    const seconds = Math.round(Number(value) || 0);
    return Math.max(min, Math.min(max, seconds));
}

/**
 * What the composer starts with: the row's own defaults, bounded by its limits.
 *
 * `prompt` and `lyrics` are deliberately not here — they are what a person
 * types, and this is what the machine suggests.
 */
export function defaultMusicSetup(model) {
    const defaults = model?.defaults || {};
    return {
        seconds: clampSeconds(model, defaults.seconds ?? 60),
        bpm: Number(defaults.bpm) || 120,
        timesignature: String(defaults.timesignature || '4'),
        language: String(defaults.language || 'en'),
        keyscale: String(defaults.keyscale || 'C major'),
        steps: Number(defaults.steps) || 8,
        cfg: Number(defaults.cfg ?? 1),
        seed: Number.isFinite(Number(defaults.seed)) ? Number(defaults.seed) : -1,
        // What is IN the seed box, kept beside the number the request uses. An
        // input bound straight to the number fights the person typing in it:
        // clearing the box to type a new value reads as Number('') === 0, which
        // is a pinned seed nobody asked for. Same split, and the same parser, as
        // the Image studio's seed field.
        seedText: Number(defaults.seed) >= 0 ? String(Number(defaults.seed)) : '',
        samplerName: String(defaults.samplerName || model?.samplers?.[0] || ''),
        scheduler: String(defaults.scheduler || model?.schedulers?.[0] || ''),
        generateAudioCodes: defaults.generateAudioCodes !== false,
        // YuE2 writes the song out as a score before performing it, and `mode`
        // decides whether that score carries chords too. Only that family takes
        // it, so it is gated by `accepts` like every other control.
        mode: String(defaults.mode || model?.modes?.[0]?.id || 'full'),
    };
}

/**
 * The generate body, built from the row rather than from a hard-coded list.
 *
 * Only a key the row `accepts` is sent. The gateway echoes the options it
 * actually applied, and a key it never asked for arriving in the payload is how
 * a graph ends up with a setting nobody can see in the UI that made it.
 */
export function musicRequest(model, setup = {}, { prompt = '', lyrics = '' } = {}) {
    const body = {
        // The host resolves the row by ID before it forwards anything — its
        // audio branch looks up `model` in the music catalogue, exactly as the
        // image branch does. Sending only backend+workflow_file gets a 400 that
        // names the wrong catalogue.
        model: String(model?.id || ''),
        backend: String(model?.backend || ''),
        workflow_file: String(model?.workflowFile || ''),
    };
    const put = (key, value) => { if (accepts(model, key)) body[key] = value; };
    put('prompt', String(prompt || '').trim());
    put('lyrics', String(lyrics || ''));
    put('seconds', clampSeconds(model, setup.seconds));
    put('bpm', Math.round(Number(setup.bpm) || 0));
    put('timesignature', String(setup.timesignature || ''));
    put('language', String(setup.language || ''));
    put('keyscale', String(setup.keyscale || ''));
    put('generate_audio_codes', setup.generateAudioCodes !== false);
    put('mode', String(setup.mode || ''));
    put('steps', Math.round(Number(setup.steps) || 0));
    put('cfg', Number(setup.cfg));
    put('sampler_name', String(setup.samplerName || ''));
    put('scheduler', String(setup.scheduler || ''));
    // -1 is not a missing seed, it is the request "pick one for me" — the server
    // resolves it and the record carries what it chose.
    put('seed', Number.isFinite(Number(setup.seed)) ? Number(setup.seed) : -1);
    return body;
}

/* ------------------------------------------------------------------ */
/* The section plan — what an instrumental lane reads instead of words */
/* ------------------------------------------------------------------ */

// WHY THIS IS A BUILDER AND NOT A TEXT BOX. The instrumental YuE2 lane takes the
// lyrics FIELD but not lyrics: its LoRA was trained on exactly three caption
// shapes, in equal thirds — a bare `[instrumental]`, a list of section tags, or
// the same list with an `m:ss-m:ss` range in each bracket — over six tag names
// and nothing else. Its card is explicit that production notes, sung words and a
// literal "\n" all pull the output away from what it learned. A free textarea
// invites every one of those, so the plan is assembled here from choices and the
// person never types inside a bracket.

/** The three shapes the LoRA was trained on, in the order of how much they steer. */
export const SECTION_PLAN_MODES = Object.freeze([
    { id: 'bare', label: 'Let the model decide', note: 'It chooses the sections and the length itself.' },
    { id: 'untimed', label: 'Set the order', note: 'You choose the order of the sections; it chooses how long each runs.' },
    { id: 'timed', label: 'Set the order and the timing', note: 'Each section is given a start and an end, shared out across the track length. The strongest steer — it follows the order and the proportions better than the exact end.' },
]);

// How long a section of each kind runs relative to the others — the proportions
// of the worked example on the LoRA's own card (15s intro, 30s verse, 25s
// chorus, 30s bridge, 25s outro). Only the RATIOS matter: they are scaled to
// whatever track length the composer is set to.
const SECTION_WEIGHTS = Object.freeze({ intro: 15, verse: 30, 'pre-chorus': 15, chorus: 25, bridge: 30, outro: 25 });

/** Does this row read a section plan where another would read lyrics? */
export function usesSectionPlan(model) {
    return model?.lyricsFormat === 'section-plan' && accepts(model, 'lyrics');
}

/** The tag names this row was trained on. Nothing else may go in a bracket. */
export function sectionTags(model) {
    const declared = Array.isArray(model?.sectionTags) ? model.sectionTags.map(String).filter(Boolean) : [];
    return declared.length ? declared : Object.keys(SECTION_WEIGHTS);
}

/** What a fresh plan looks like: the order from the card, the model on timing. */
export function defaultSectionPlan() {
    return { mode: 'untimed', sections: ['intro', 'verse', 'chorus', 'bridge', 'chorus', 'outro'] };
}

const clockTime = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * Share a track length out across a section order: `[{ tag, start, end }]`.
 *
 * Boundaries are rounded CUMULATIVELY, not per section, so the ranges tile the
 * track exactly — each start is the previous end, and the last end is the track
 * length — instead of drifting by a second per rounded section.
 */
export function sectionTimings(sections = [], seconds = 0) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const weights = sections.map((tag) => SECTION_WEIGHTS[tag] || 25);
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!sum || !total) return [];
    let run = 0;
    let start = 0;
    return sections.map((tag, index) => {
        run += weights[index];
        const end = index === sections.length - 1 ? total : Math.round((run / sum) * total);
        const row = { tag, start, end };
        start = end;
        return row;
    });
}

/**
 * The text that goes in the lyrics field for a plan. One tag per line, real line
 * breaks, nothing else — the three shapes the LoRA's card documents, verbatim.
 *
 * A tag the row does not name is dropped rather than sent: a plan can outlive a
 * model swap, and an unknown bracket is precisely the untrained input the
 * builder exists to keep out. An order with nothing left in it is the bare form.
 */
export function sectionPlanLyrics(model, plan, seconds) {
    const allowed = new Set(sectionTags(model));
    const sections = (Array.isArray(plan?.sections) ? plan.sections : []).filter((tag) => allowed.has(tag));
    if (plan?.mode === 'bare' || !sections.length) return '[instrumental]';
    if (plan?.mode === 'timed') {
        return sectionTimings(sections, clampSeconds(model, seconds))
            .map((row) => `[${row.tag} ${clockTime(row.start)}-${clockTime(row.end)}]`)
            .join('\n');
    }
    return sections.map((tag) => `[${tag}]`).join('\n');
}

/* ------------------------------------------------------------------ */
/* Submitting and polling                                              */
/* ------------------------------------------------------------------ */

/** Queue a track. Resolves to the 202 record: `{ id, status, backend, ... }`. */
export async function startMusicJob(body) {
    const queued = await localAiJson('/local-ai/generate', { method: 'POST', body: JSON.stringify(body) });
    if (!queued?.id) throw new Error('The studio queued nothing — there is no job to follow.');
    return queued;
}

/** One poll of a running track. */
export function fetchMusicJob(id) {
    return localAiJson(`/local-ai/job/${encodeURIComponent(String(id || ''))}`);
}

export const MUSIC_TERMINAL = new Set(['success', 'error', 'cancelled']);

/**
 * Where the finished track lives.
 *
 * `url` is the host's own inlined copy (a data: URL, sealed or not — the same
 * thing the image lane reads); `image_urls` is the gateway's field name for
 * EVERY backend's outputs, audio included, and is the fallback when the host
 * did not inline. Both go through resolveMediaSrc downstream, which is what
 * turns a sealed envelope into a playable blob.
 */
export function musicOutputUrl(job) {
    if (typeof job?.url === 'string' && job.url) return job.url;
    const first = Array.isArray(job?.image_urls) ? job.image_urls[0] : '';
    return typeof first === 'string' ? first : '';
}

/* ------------------------------------------------------------------ */
/* Progress, which the gateway has already weighted                    */
/* ------------------------------------------------------------------ */

// WHO WEIGHTS THE PASSES. ACE-Step renders in two counted passes and each
// ComfyUI node counts from zero — a language model writes the audio codes (300
// steps on the measured 60-second track), then an 8-step sampler renders them.
// A bar wired to a single node's raw fraction therefore fills, resets and fills
// again. That is fixed at the GATEWAY, not here: workflow-registry.json declares
// `progress_phases` for this workflow (node 2 "writing the music", share 0.81;
// node 6 "rendering the audio", share 0.15 — both measured on an M5 Max), and
// graphs.poll_local_comfy_progress maps each counting node into its own span and
// writes `progress = max(previous, offset + fraction * share) * 100` plus the
// phase's own label in `progress_phase`.
//
// So what arrives on the record is ALREADY a whole-job, already-monotonic
// percent: 0 -> 81 across the LM pass, 81 -> 96 across the sampler. Re-scaling
// it here (dividing by a pass count, adding a phase index) would apply the
// registry's weighting a second time and misstate the render in both
// directions. This module's job is to carry it through unchanged and to name
// the pass with the gateway's own word rather than a guess made from a change in
// the step count — which is also the only way the label can stay true when
// "write audio codes first" is switched off and the LM pass does not run at all.

/** A fresh fold state. One per run. */
export function newMusicProgress() {
    return { percent: 0, step: 0, steps: 0, phase: '', status: '', queuePosition: 0 };
}

/**
 * Fold one poll into the run's progress.
 *
 * Every field is carried forward when a poll does not carry it: a record that is
 * still `queued` has no `progress`, no counters and no phase, and must not reset
 * a run that had already started counting.
 */
export function foldMusicProgress(state, job) {
    const previous = state || newMusicProgress();
    if (!job || typeof job !== 'object') return previous;
    const reported = Number(job.progress);
    const steps = Number(job.total_steps) || 0;
    const step = Number(job.current_step) || 0;
    const phase = String(job.progress_phase || '').trim();
    const status = String(job.status || '') || previous.status;
    const queued = Math.max(0, Math.round(Number(job.queue_position) || 0));
    return {
        // The gateway already clamps this monotonic; the max here only defends
        // against two polls landing out of order.
        percent: Number.isFinite(reported)
            ? Math.max(previous.percent, Math.max(0, Math.min(100, reported)))
            : previous.percent,
        step: steps > 0 ? step : previous.step,
        steps: steps > 0 ? steps : previous.steps,
        phase: phase || previous.phase,
        status,
        // A job that has started is not behind anything any more.
        queuePosition: status === 'queued' ? (queued || previous.queuePosition) : 0,
    };
}

/**
 * The fraction of the WHOLE render the engine has counted, 0..1.
 *
 * One division, because `percent` is already the whole job — see the note above.
 * The studio feeds this to genProgress.computeSmoothProgress as its real signal.
 */
export function musicCountedFraction(progress) {
    const percent = Number(progress?.percent);
    if (!Number.isFinite(percent) || percent <= 0) return 0;
    return Math.max(0, Math.min(1, percent / 100));
}

/** What the readout calls the pass that is running — the gateway's own word. */
export function musicPhaseLabel(progress) {
    const reported = String(progress?.phase || '').trim();
    if (reported) return reported.charAt(0).toUpperCase() + reported.slice(1);
    // Before the first counter lands there is no phase to name. A job that is
    // waiting for the accelerator says so; anything else is simply working.
    return String(progress?.status || '') === 'queued' ? 'Waiting for the GPU' : 'Rendering';
}

/**
 * Why a render that has not started yet has not started, or ''.
 *
 * This machine renders one job at a time (gateway jobs._acquire_gpu_slot), so a
 * track queued behind an image is waiting, not stalled. Saying which place it is
 * in is what keeps a motionless bar from reading as a hang — the same sentence
 * the Video studio shows for the same state.
 */
export function musicQueueNote(progress) {
    if (String(progress?.status || '') !== 'queued') return '';
    const position = Math.max(0, Math.round(Number(progress?.queuePosition) || 0));
    if (position > 0) {
        const ahead = position === 1 ? 'one render' : `${position} renders`;
        return `Waiting behind ${ahead} — this one starts by itself when the GPU is free.`;
    }
    return 'Waiting for the GPU — this one starts by itself when the machine is free.';
}

/* ------------------------------------------------------------------ */
/* What the studio says out loud                                       */
/* ------------------------------------------------------------------ */

// The share of the render the audio-code language model owns. MEASURED and
// recorded in workflow-registry.json as this workflow's first progress phase
// (node 2, share 0.81 — 19.4s of a 24.1s render), and said again in the row's
// own description: turning the pass off "is about four fifths of the render".
// The row the host serves carries `benchmarkSeconds` but not the phase table,
// so the number lives here as the ONE first-run fallback; from the first
// completed render onward the studio estimates from what this machine measured.
export const MUSIC_LM_SHARE = 0.81;

/**
 * Seconds of render per second of finished audio, or 0 when nothing is measured.
 *
 * `benchmarkSeconds` is the one measured number on the row and the registry
 * records it against a 60-second track WITH audio codes, so the rate for a
 * request that skips that pass is the remaining fifth.
 */
export function musicFallbackRate(model, generateAudioCodes = true) {
    const benchmark = Number(model?.benchmarkSeconds) || 0;
    if (benchmark <= 0) return 0;
    const perSecond = benchmark / 60;
    return generateAudioCodes === false ? perSecond * (1 - MUSIC_LM_SHARE) : perSecond;
}

/**
 * The key and the work units this request is timed under.
 *
 * Same store and same shape as the Image lane (genProgress.recordGenerationSeconds
 * / estimateGenerationSeconds): the key names everything that changes the COST
 * PROFILE and never the words, and the work is the length of the track, which is
 * what the cost is very nearly linear in. Without this a second render still
 * quotes the registry's warm number on a machine that took twice as long — and
 * the first render of all loads a 10 GB checkpoint the benchmark never paid for.
 */
export function musicTimingProfile(model, setup = {}) {
    const codes = setup?.generateAudioCodes !== false;
    return {
        key: `music|${model?.id || ''}|codes=${codes ? 1 : 0}`
            + `|steps=${Math.round(Number(setup?.steps) || 0)}|sampler=${setup?.samplerName || ''}`,
        work: clampSeconds(model, setup?.seconds),
        fallbackRate: musicFallbackRate(model, codes),
    };
}

/** "1:00", "0:45", "10:00" — a length, in the form a player prints it. */
export function formatTrackLength(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The licence, as one sentence a person can act on.
 *
 * Worth saying plainly and worth saying only when it is true: ACE-Step 1.5
 * ships MIT code AND MIT weights, so what comes out belongs to whoever made it.
 * A row whose weights are licensed differently gets the row's own note instead.
 */
export function musicLicenceLine(model) {
    const licence = model?.license;
    if (!licence) return '';
    if (licence.note) return String(licence.note);
    const code = licence.code ? `${licence.code} code` : '';
    const weights = licence.weights ? `${licence.weights} weights` : '';
    const pair = [code, weights].filter(Boolean).join(' and ');
    if (!pair) return '';
    return licence.commercial ? `${pair}; the music is yours to use commercially.` : pair;
}

/**
 * The one line a person needs when a model's weights forbid selling the result.
 *
 * Separate from `musicLicenceLine` on purpose. That one is a description and
 * lives in the empty state; this is a RESTRICTION and has to travel with the
 * finished track, because the moment it matters is the moment somebody
 * downloads a song and puts it behind an ad. "CC BY-NC 4.0" is not a sentence
 * most people can act on, so this says the consequence instead of the name.
 *
 * Returns '' unless the registry explicitly says commercial use is not allowed
 * — an unknown licence is not asserted to be either way.
 */
export function musicUsageRestriction(model) {
    const licence = model?.license;
    if (!licence || licence.commercial !== false) return '';
    const named = licence.weights ? `${licence.weights} weights` : 'a non-commercial licence';
    return `Personal and non-commercial use only — ${named}. This track cannot be sold or used to promote a business.`;
}


/**
 * Why this row cannot run yet, said in the words the studio will print.
 *
 * Returns `{ reason, title, detail }`, or null when the row is ready. The
 * caller pairs it with the install prompt — a missing checkpoint is the one
 * first-run state that repairs itself from inside the page.
 */
export function musicReadiness(model) {
    if (!model) return null;
    if (model.ready !== false) return null;
    if (model.readyReason === 'missing-weights') {
        const names = Array.isArray(model.missingWeights) ? model.missingWeights : [];
        return {
            reason: 'missing-weights',
            title: `${model.name} needs its checkpoint downloaded before it can play anything.`,
            detail: names.join(', '),
        };
    }
    if (model.readyReason === 'engine-offline') {
        return {
            reason: 'engine-offline',
            title: 'The engine that renders music is not answering on this machine.',
            detail: '',
        };
    }
    return { reason: String(model.readyReason || 'not-ready'), title: `${model.name} is not ready on this machine.`, detail: '' };
}
