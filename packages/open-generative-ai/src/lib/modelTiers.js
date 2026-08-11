// Lite/Standard model tiers.
//
// A model that ships both a distilled build and a full-step build would show up
// twice in the picker under near-identical names. Entries sharing a `tierGroup`
// collapse into one row that carries both tiers, so the user picks the model
// first and the speed/quality trade second.
//
// Pure helpers live here rather than in videoLogic.js so they stay importable
// from the node:test suite, which cannot load JSX.

/** Collapse Lite/Standard builds of the same model into a single picker row.
 *
 * List order follows the first tier encountered. A group with only one tier
 * present (the other build isn't installed) degrades to an ordinary row, so a
 * switch never renders with nothing to switch to.
 */
export function groupModelTiers(models) {
    const rows = [];
    const groups = new Map();
    for (const model of Array.isArray(models) ? models : []) {
        if (!model?.tierGroup || !model?.tier) {
            rows.push(model);
            continue;
        }
        const existing = groups.get(model.tierGroup);
        if (existing) {
            existing.tiers[model.tier] = model;
            continue;
        }
        const row = { ...model, isTierGroup: true, tiers: { [model.tier]: model } };
        groups.set(model.tierGroup, row);
        rows.push(row);
    }
    return rows.map((row) => {
        if (!row?.isTierGroup) return row;
        const present = Object.values(row.tiers);
        return present.length >= 2 ? row : present[0];
    });
}

/** The tier currently selected in a grouped row, or the default for that row. */
export function activeTierFor(row, selectedId) {
    if (!row?.isTierGroup) return null;
    const match = Object.entries(row.tiers).find(([, model]) => model.id === selectedId);
    if (match) return match[0];
    return row.tiers.lite ? 'lite' : Object.keys(row.tiers)[0];
}

/** Both builds of the selected model, or null when it has no counterpart.
 *
 * Drives the Lite/Standard switch in generation settings: it only renders when
 * the selected model actually has both builds installed.
 */
export function tierPairFor(models, selectedId) {
    const selected = (Array.isArray(models) ? models : []).find((model) => model?.id === selectedId);
    if (!selected?.tierGroup) return null;
    const siblings = models.filter((model) => model?.tierGroup === selected.tierGroup);
    const pair = {};
    for (const model of siblings) {
        if (model?.tier) pair[model.tier] = model;
    }
    return pair.lite && pair.standard ? pair : null;
}
