// What the prompt helper decides before it writes anything: which local models
// are safe to load, and which model a press runs on.
//
// Deliberately textual: the three blocks below that grep PromptHelperDialog.jsx
// are claims about WIRING, and this dialog has no rendered form to assert on —
// its whole body is inside ui/Modal.jsx's createPortal, which react-dom/server
// refuses, and every behaviour here (the two reads landing, a press held until
// they do) exists only inside effects a server render never runs. The decision
// itself is tested for real against the function that makes it, in
// textModels.test.js; these three check that the dialog is still plugged into
// it, which is the half a logic test cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    blockedReason,
    canSelect,
    describeWritingFor,
    externalHold,
    formatBytes,
    lastUsedModelId,
    modelStatus,
    preferredModelId,
    refineSuggestions,
    rememberModelId,
    sortModels,
    writingForChips,
} from '../src/lib/promptHelperRuntime.js';

const model = (fit, extra = {}) => ({ id: `m-${fit}`, fit, estimatedLoadBytes: 21 * 1024 ** 3, ...extra });

test('a model that fits is always selectable', () => {
    assert.equal(canSelect(model('fits'), { unloadOthers: false }), true);
    assert.equal(canSelect(model('fits'), { unloadOthers: true }), true);
});

test('an already-loaded model stays selectable', () => {
    assert.equal(canSelect(model('loaded'), { unloadOthers: false }), true);
});

test('a model needing room is selectable only when unloading others is on', () => {
    assert.equal(canSelect(model('needs_unload'), { unloadOthers: false }), false);
    assert.equal(canSelect(model('needs_unload'), { unloadOthers: true }), true);
});

test('a model too big for the machine is never selectable', () => {
    // The whole point of the guard: no toggle should be able to talk the user
    // into a load that cannot fit even with everything unloaded.
    assert.equal(canSelect(model('insufficient'), { unloadOthers: true }), false);
    assert.equal(canSelect(model('insufficient'), { unloadOthers: false }), false);
});

test('blocked models explain themselves, selectable ones stay quiet', () => {
    assert.equal(blockedReason(model('fits')), '');
    assert.match(blockedReason(model('needs_unload'), { unloadOthers: false }), /Unload others first/);
    assert.match(blockedReason(model('insufficient')), /more than this machine can free/);
});

test('an estimate is marked approximate until a real load measures it', () => {
    assert.equal(modelStatus(model('fits', { measured: false })), '~21.0 GB in RAM');
    assert.equal(modelStatus(model('fits', { measured: true })), '21.0 GB in RAM');
    assert.equal(modelStatus(model('loaded')), 'Loaded');
});

test('formatBytes switches units and survives junk', () => {
    assert.equal(formatBytes(0), '0 GB');
    assert.equal(formatBytes(null), '0 GB');
    assert.equal(formatBytes(512 * 1024 ** 2), '512 MB');
    assert.equal(formatBytes(7.38 * 1024 ** 3), '7.4 GB');
});

test('memory held outside the studio is reported so the RAM figure adds up', () => {
    assert.equal(externalHold({ external: [] }), null);
    assert.deepEqual(externalHold({ external: [{ id: 'qwen3.6-27b' }] }), { count: 1, names: ['qwen3.6-27b'] });
});

test('loaded models sort first, then largest', () => {
    const rows = sortModels([
        { id: 'small', fit: 'fits', sizeBytes: 5 },
        { id: 'big', fit: 'fits', sizeBytes: 50 },
        { id: 'live', fit: 'loaded', sizeBytes: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.id), ['live', 'big', 'small']);
});

test('a model is preselected when nothing is loaded', () => {
    // The dialog only auto-selected a model already in RAM. After a page
    // reload — or a stack restart that killed the server — nothing is loaded,
    // so nothing was selected, and every action returned silently: "Apply
    // change does nothing". The fallback is the first model that fits.
    const models = [
        { id: 'huge.gguf', name: 'Huge', fit: 'insufficient', estimatedLoadBytes: 9e10 },
        { id: 'scout.gguf', name: 'Swarm Scout 12B', fit: 'fits', estimatedLoadBytes: 1e10 },
    ];
    assert.equal(preferredModelId(models), 'scout.gguf');
    // A model already in RAM wins over the top row — it costs nothing to use.
    const withLive = [...models, { id: 'live.gguf', name: 'Live', fit: 'loaded', estimatedLoadBytes: 2e10 }];
    assert.equal(preferredModelId(withLive, { loadedId: 'live.gguf' }), 'live.gguf');
    // Nothing usable at all stays empty rather than selecting the unusable.
    assert.equal(preferredModelId([models[0]]), '');
});

test('the last used model wins the preselection', () => {
    const models = [
        { id: 'big.gguf', name: 'Big', fit: 'fits', sizeBytes: 5e10, estimatedLoadBytes: 5e10 },
        { id: 'scout.gguf', name: 'Scout', fit: 'fits', sizeBytes: 1e10, estimatedLoadBytes: 1e10 },
        { id: 'huge.gguf', name: 'Huge', fit: 'insufficient', estimatedLoadBytes: 9e10 },
    ];
    // Over the sort order — the picker is largest-first, which is why a fresh
    // page kept re-offering a model the owner had already passed over.
    assert.equal(preferredModelId(models, { lastUsedId: 'scout.gguf' }), 'scout.gguf');
    // And over whatever happens to be in RAM: the owner chose this one.
    assert.equal(
        preferredModelId(models, { lastUsedId: 'scout.gguf', loadedId: 'big.gguf' }),
        'scout.gguf',
    );
    // A remembered model that is gone from disk, or too big to load now, gives
    // way rather than leaving the dialog pointed at something unusable.
    assert.equal(preferredModelId(models, { lastUsedId: 'deleted.gguf', loadedId: 'big.gguf' }), 'big.gguf');
    assert.equal(preferredModelId(models, { lastUsedId: 'huge.gguf' }), 'big.gguf');
});

test('the remembered id survives a browser with no localStorage', () => {
    // node:test has no localStorage; the helpers must degrade to "nothing
    // remembered" instead of throwing on the way into the picker.
    assert.equal(lastUsedModelId(), '');
    assert.doesNotThrow(() => rememberModelId('scout.gguf'));
});

// The "Writing for:" line — what the helper has been told, so the user can see
// it knows the cast and the attached media rather than having to trust it.
test('describeWritingFor names each subject and counts the references', () => {
    assert.equal(describeWritingFor({
        cast: [
            { subject: 1, kind: 'persona', gender: 'female', name: '', voice: false, look: 'red coat' },
            { subject: 2, kind: 'character', gender: 'male', name: 'Willow', voice: true, look: '' },
        ],
        references: { images: 3, videos: [{ useAudio: false }], audios: 0 },
    }), 'Subject 1 (woman, look set) · Subject 2 Willow (known character, voice) · 3 pictures, 1 clip');
    // A persona's name never appears — only the gender word and whether a look is set.
    assert.doesNotMatch(describeWritingFor({ cast: [{ subject: 1, kind: 'persona', gender: 'male', name: 'Liam' }] }), /Liam/);
    assert.equal(describeWritingFor({ cast: [{ subject: 1, kind: 'persona', gender: 'male', name: 'Liam' }] }), 'Subject 1 (man)');
    assert.equal(describeWritingFor({ references: { images: 1, videos: [], audios: 2 } }), '1 picture, 2 voice clips');
    assert.equal(describeWritingFor({}), '');
    assert.equal(describeWritingFor({ cast: [], references: { images: 0, videos: [], audios: 0 } }), '');
});

test('the local helper slot reads as a server, not a RAM estimate', () => {
    const mtplx = (fit) => ({ id: 'qwen38-speed', provider: 'mtplx', fit, estimatedLoadBytes: 20 * 1024 ** 3 });
    assert.equal(modelStatus(mtplx('loaded')), 'Running in the local helper');
    assert.equal(modelStatus(mtplx('loading')), 'Starting the local helper…');
    assert.match(modelStatus(mtplx('fits')), /in the local helper/);
    // Serving and fits rows are selectable like any other; loading is not yet.
    assert.equal(canSelect(mtplx('loaded')), true);
    assert.equal(canSelect(mtplx('fits')), true);
    assert.equal(canSelect(mtplx('loading')), false);
    assert.match(blockedReason(mtplx('loading')), /Still loading/);
});


test('the chips say exactly what the sentence says, one fact each', () => {
    const context = {
        cast: [
            { subject: 1, kind: 'persona', gender: 'female', name: '', voice: true, look: 'red coat' },
            { subject: 2, kind: 'character', gender: 'male', name: 'Willow', voice: false, look: '' },
        ],
        references: { images: 3, videos: [{ useAudio: false }], audios: 0 },
    };
    assert.deepEqual(writingForChips(context), [
        'Subject 1 · woman, look set, voice',
        'Subject 2 Willow · known character',
        '3 pictures, 1 clip',
    ]);
    // Same source as the sentence, so the two can never disagree about the cast.
    assert.equal(writingForChips(context).length, describeWritingFor(context).split(' · ').length);
    // A persona's name is vault-sealed and never reaches a chip either.
    assert.deepEqual(writingForChips({ cast: [{ subject: 1, kind: 'persona', gender: 'male', name: 'Liam' }] }), ['Subject 1 · man']);
    assert.deepEqual(writingForChips({}), []);
});

test('a press that outruns the model list waits for it, instead of being told to pick a model', () => {
    // Reported 2026-09-13: the helper opened, Generate was pressed, and it said
    // "Pick a model first." and flung the picker open — then, a second later,
    // selected the model this browser had been using all along. The dialog was
    // not missing a choice, it was still reading the list; saying so is the
    // whole fix.
    const dialog = readFileSync(new URL('../src/dialogs/PromptHelperDialog.jsx', import.meta.url), 'utf8');
    const run = /const run = async \(\{ refine = null \} = \{\}\) => \{([\s\S]*?)\n        const ticket =/.exec(dialog);
    assert.ok(run, 'the dialog no longer has a run() to guard');
    const held = run[1].indexOf('pendingRunRef.current = { refine }');
    const complaint = run[1].indexOf("promptHelper.pickModelFirst");
    assert.ok(held >= 0, 'a press made before the reads answer is not held anywhere');
    assert.ok(complaint > held, '"pick a model first" must come after the guard that waits for the list');
    // What the OWNER controls is still answered immediately: an empty box is an
    // empty box whether or not the list has arrived.
    assert.ok(run[1].indexOf("promptHelper.writeBeforeHelper") < held);
    // The held press is released by the effect that watches for a model...
    assert.match(dialog, /void runRef\.current\(queued\)/);
    // ...and never survives a close, or it would write a prompt into a dialog
    // nobody is looking at.
    assert.match(dialog, /if \(pendingRunRef\.current\) \{ pendingRunRef\.current = null; setBusy\(''\); \}/);
});

test('the model the dialog starts on is decided once, by both reads together', () => {
    const dialog = readFileSync(new URL('../src/dialogs/PromptHelperDialog.jsx', import.meta.url), 'utf8');
    // Preselecting inside the runtime scan is what lost a remembered cloud
    // model — that scan cannot see one, so it read it as gone.
    const refresh = /const refresh = useCallback\(async \(\) => \{([\s\S]*?)\n    \}, \[\]\);/.exec(dialog);
    assert.ok(refresh, 'the dialog no longer has a runtime refresh');
    assert.doesNotMatch(refresh[1], /setSelected\(/, 'the local scan must not preselect a model on its own');
    // One decision, from both answers, derived rather than stored.
    assert.match(dialog, /const modelChoiceSettled = sources\.catalog !== null && runtimeAnswered;/);
    assert.match(dialog, /const activeId = selected \|\| \(modelChoiceSettled/);
    assert.match(dialog, /startingModelIdWithRuntime\(sources\.catalog, \{/);
    // A scan that FAILED still settles the dialog, or the pill would say
    // "checking…" and every press would wait forever.
    assert.match(dialog, /\} finally \{[\s\S]*?setRuntimeAnswered\(true\);/);
});

test('every one-press refinement the runtime offers has a name in the dialog', () => {
    // The two lists are joined by id: a suggestion added to promptHelperRuntime
    // with no matching label used to reach `SUGGESTION_LABEL[id]()` and throw.
    const dialog = readFileSync(new URL('../src/dialogs/PromptHelperDialog.jsx', import.meta.url), 'utf8');
    const block = /const SUGGESTION_LABEL = \{([\s\S]*?)\n\};/.exec(dialog);
    assert.ok(block, 'the dialog no longer declares SUGGESTION_LABEL');
    const named = new Set([...block[1].matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]));
    const offered = refineSuggestions({ mediaType: 'video', chained: true }).map((entry) => entry.id);
    // matchShot names a shot number, so it goes through tf() at the call site.
    const missing = offered.filter((id) => id !== 'matchShot' && !named.has(id));
    assert.deepEqual(missing, [], 'a suggestion with no label renders as its own id');
});

test('every one-press refinement is offered only where it can land', () => {
    const video = refineSuggestions({ mediaType: 'video' });
    // The three the server turns into a craft sentence of its own.
    assert.equal(video.find((entry) => entry.id === 'moreDetail').detail, 'enrich');
    assert.equal(video.find((entry) => entry.id === 'anotherShot').shots, 'more');
    assert.equal(video.find((entry) => entry.id === 'singleStill').shots, 'single');
    // Every entry is a complete wire payload — normalize_refine reads all three
    // fields, and a missing one would collapse to a default the caller did not
    // choose rather than the one it meant.
    for (const entry of video) {
        assert.equal(typeof entry.detail, 'string');
        assert.equal(typeof entry.shots, 'string');
        assert.equal(typeof entry.guidance, 'string');
    }
    // `shots` is ignored outside video, so the presses that are nothing but a
    // shot knob are not offered there — a press that does nothing is worse than
    // no press.
    const image = refineSuggestions({ mediaType: 'image' });
    assert.deepEqual(image.map((entry) => entry.id), ['moreDetail', 'tighten']);
    assert.ok(image.every((entry) => entry.shots === 'keep'));
    // Matching the previous shot needs there to BE one.
    assert.ok(!refineSuggestions({ mediaType: 'video', chained: false }).some((entry) => entry.id === 'matchShot'));
    const chained = refineSuggestions({ mediaType: 'video', chained: true });
    assert.ok(chained.find((entry) => entry.id === 'matchShot').guidance.includes('previous shot'));
});
