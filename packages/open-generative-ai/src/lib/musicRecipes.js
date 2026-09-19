// Music recipes — the browser half.
//
// A recipe is how tracks in one style are conventionally built: the order of
// the sections, a typical tempo, the time signature, whether it leans major or
// minor. The library is static data served by the control API
// (music_recipes.py owns it and validates it), and applying a recipe is pure,
// local and reversible — this module is where that happens, and like
// musicLane.js it holds no React so every branch is reachable from node.
//
// SUGGEST IS THE ONE THING HERE THAT LEAVES THE MACHINE. Everything else in the
// Music studio renders locally and treats the style line as privately as a
// prompt. Suggest sends that one line to a hosted decision model on the owner's
// own OpenRouter account, so it is never automatic: it runs on a press, after a
// disclosure the SERVER words (so the sentence and the behaviour cannot drift),
// and consent is remembered per browser, not assumed. The library itself needs
// none of that — picking from the list by hand touches no network beyond this
// studio's own host.
//
// A RECIPE ONLY SETS WHAT THE ROW TAKES. The same rule as the composer: a model
// with no tempo control is not given a tempo, and a model that reads lyrics
// rather than a section plan is not given sections. `applyRecipe` reports what
// it changed in words, because "applied Deep house" with nothing visibly
// different is a button that appears to do nothing.
import { accepts, sectionTags, usesSectionPlan } from './musicLane.js';

async function api(path, body) {
    const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = payload?.detail;
        const structured = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
        const error = new Error(structured?.message || (typeof detail === 'string' ? detail : '') || `Request failed (${response.status})`);
        if (structured?.remedy) error.remedy = String(structured.remedy);
        error.status = response.status;
        throw error;
    }
    return payload;
}

/**
 * The library, and whether Suggest can run. Never rejects: "the studio's API did
 * not answer" and "there are no recipes" are different sentences on screen.
 */
export async function fetchMusicRecipes() {
    try {
        const data = await api('/api/music/recipes');
        const recipes = (Array.isArray(data?.recipes) ? data.recipes : []).filter((row) => row && row.id);
        return {
            status: recipes.length ? 'ready' : 'empty',
            recipes,
            families: Array.isArray(data?.families) ? data.families : [],
            suggest: data?.suggest || { available: false },
        };
    } catch (error) {
        return { status: 'unreachable', recipes: [], families: [], suggest: { available: false }, error };
    }
}

/** Ask the hosted decision model which recipe fits. Sends the style line ONLY. */
export function suggestMusicRecipe(style) {
    return api('/api/music/suggest', { style: String(style || '') });
}

/* ---------------- consent, remembered per browser ---------------- */

const CONSENT_KEY = 'opengen.music.suggestConsent';

export function hasSuggestConsent() {
    try { return window.localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; }
}

export function rememberSuggestConsent() {
    try { window.localStorage.setItem(CONSENT_KEY, '1'); } catch { /* asked again next time, which is the safe failure */ }
}

/** The disclosure, as one sentence, from the server's own words. */
export function suggestDisclosure(suggest) {
    const d = suggest?.disclosure || {};
    if (!d.sends || !d.to) return '';
    return `Suggest sends ${d.sends} to ${d.to}. It never sends ${d.never_sends || 'anything else'}. Everything else in this studio stays on this machine.`;
}

/* ---------------- applying a recipe ---------------- */

// The composer's time-signature control takes the beat count, and only these.
const TIME_SIGNATURE_VALUES = { '4/4': '4', '3/4': '3', '6/8': '6', '5/4': '5' };
// The tempo slider's own bounds (MusicComposer). A recipe outside them is
// clamped rather than producing a value the control cannot show.
const BPM_MIN = 40;
const BPM_MAX = 200;

/** `intro · verse · chorus`, or the words for a style with no repeating sections. */
export function recipeFormLine(recipe) {
    const sections = Array.isArray(recipe?.sections) ? recipe.sections : [];
    return sections.length ? sections.join(' · ') : 'through-composed — no repeating sections';
}

/**
 * Apply `recipe` to the composer: `{ setup, plan, changes }`.
 *
 * Pure. `changes` is a list of short phrases naming what moved, empty when the
 * recipe had nothing this model takes. `explicitBpm` is a tempo the person typed
 * in the style line; it outranks the recipe's typical one, because they said so.
 */
export function applyRecipe(model, setup, plan, recipe, { explicitBpm = null } = {}) {
    const nextSetup = { ...setup };
    let nextPlan = plan;
    const changes = [];
    if (!recipe) return { setup: nextSetup, plan: nextPlan, changes };

    if (usesSectionPlan(model)) {
        const allowed = new Set(sectionTags(model));
        const sections = (Array.isArray(recipe.sections) ? recipe.sections : []).filter((tag) => allowed.has(tag));
        if (sections.length) {
            // A person who had asked for timings keeps them; nobody is moved INTO
            // the strongest steer by a suggestion.
            nextPlan = { mode: plan?.mode === 'timed' ? 'timed' : 'untimed', sections };
            changes.push(`${sections.length} sections`);
        } else {
            nextPlan = { mode: 'bare', sections: Array.isArray(plan?.sections) ? plan.sections : [] };
            changes.push('structure left to the model');
        }
    }
    if (accepts(model, 'bpm')) {
        const bpm = Number(explicitBpm) || Number(recipe.bpm) || 0;
        if (bpm) {
            nextSetup.bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(bpm)));
            changes.push(`${nextSetup.bpm} BPM${explicitBpm ? ' (from your style line)' : ''}`);
        }
    }
    if (accepts(model, 'timesignature')) {
        const value = TIME_SIGNATURE_VALUES[String(recipe.time_signature || '')];
        if (value && value !== String(setup?.timesignature)) {
            nextSetup.timesignature = value;
            changes.push(String(recipe.time_signature));
        }
    }
    if (accepts(model, 'keyscale') && (recipe.tonality === 'major' || recipe.tonality === 'minor')) {
        const [root = 'C', mode = 'major'] = String(setup?.keyscale || 'C major').split(' ');
        if (mode !== recipe.tonality) {
            nextSetup.keyscale = `${root} ${recipe.tonality}`;
            changes.push(`${root} ${recipe.tonality}`);
        }
    }
    return { setup: nextSetup, plan: nextPlan, changes };
}

/** Does this model take ANYTHING a recipe carries? Without it there is no door. */
export function recipesApplyTo(model) {
    return usesSectionPlan(model) || accepts(model, 'bpm') || accepts(model, 'timesignature') || accepts(model, 'keyscale');
}

/** What the door is called: the thing a recipe will actually change here. */
export function recipeDoorLabel(model) {
    return usesSectionPlan(model) ? 'Suggest structure' : 'Suggest tempo and key';
}

/** Recipes grouped by family, in the library's own family order. */
export function recipesByFamily(recipes = [], families = []) {
    const order = families.map((row) => row.id);
    const groups = new Map(families.map((row) => [row.id, { id: row.id, label: row.label, recipes: [] }]));
    for (const recipe of recipes) {
        const id = String(recipe.family || 'other');
        if (!groups.has(id)) { groups.set(id, { id, label: id, recipes: [] }); order.push(id); }
        groups.get(id).recipes.push(recipe);
    }
    return order.map((id) => groups.get(id)).filter((group) => group.recipes.length);
}
