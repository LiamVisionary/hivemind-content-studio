import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPaletteEntries, filterPaletteEntries, paletteGroupLabel } from '../src/lib/commandPalette.js';

const NAV = [
    { page: 'image', icon: 'image', label: () => 'Image' },
    { page: 'video', icon: 'video', label: () => 'Video' },
    { page: 'history', icon: 'clock', label: () => 'History' },
];

const SOURCES = {
    navItems: NAV,
    studioType: 'video',
    tabs: [
        { id: 1, index: 0, label: 'a lighthouse', busy: true },
        { id: 4, index: 1, label: 'New tab', busy: false },
    ],
    prompts: [
        { id: 'p1', name: 'Night street', data: { prompt: 'a neon street at night', summary: 'H3 · 720p' } },
        { id: 'p2', name: 'No text', data: {} },
    ],
    models: [
        { id: 'krea2', name: 'Krea 2', type: 'image', ready: true },
        { id: 'wan22', name: 'Wan 2.2', type: 'video', ready: false },
    ],
};

test('the palette lists pages, the tabs of this page, saved prompts and installed models', () => {
    const entries = buildPaletteEntries(SOURCES);
    assert.deepEqual(entries.map((entry) => entry.kind), [
        'page', 'page', 'page', 'tab', 'tab', 'prompt', 'model', 'model',
    ]);

    const [image] = entries;
    assert.equal(image.id, 'page:image');
    assert.equal(image.icon, 'image', 'nav entries keep their icon');
    assert.equal(image.hint, '⌘1', 'the first nine pages advertise their shortcut');
    assert.deepEqual(image.payload, { page: 'image' });

    const tab = entries.find((entry) => entry.kind === 'tab');
    assert.equal(tab.label, 'a lighthouse', 'a tab is listed by its derived name');
    assert.deepEqual(tab.payload, { studioType: 'video', tabId: 1 });
    assert.equal(tab.hint, 'Generating');

    const prompt = entries.find((entry) => entry.kind === 'prompt');
    assert.equal(prompt.label, 'Night street');
    assert.equal(prompt.payload.prompt, 'a neon street at night');

    const offline = entries.find((entry) => entry.id === 'model:wan22');
    assert.equal(offline.disabled, true, 'a model that cannot run is listed, not offered');
    assert.equal(offline.payload.model.id, 'wan22', 'the model travels whole, for the openInStudio handoff');
});

test('a prompt with no text, and a model or tab with no id, are not entries', () => {
    const entries = buildPaletteEntries({
        ...SOURCES,
        tabs: [{ id: 'nope', label: 'x' }],
        models: [{ name: 'nameless' }],
    });
    assert.equal(entries.filter((entry) => entry.kind === 'tab').length, 0);
    assert.equal(entries.filter((entry) => entry.kind === 'model').length, 0);
    assert.equal(entries.filter((entry) => entry.kind === 'prompt').length, 1, 'only the prompt with text');
});

test('a page with no tabs contributes none', () => {
    const entries = buildPaletteEntries({ navItems: NAV, studioType: '', tabs: [] });
    assert.equal(entries.every((entry) => entry.kind === 'page'), true);
});

test('typing narrows every group but never re-orders them', () => {
    const entries = buildPaletteEntries(SOURCES);
    const found = filterPaletteEntries(entries, 'night');
    assert.deepEqual(found.map((entry) => entry.label), ['Night street']);

    // Within a group the label match leads and the hint match follows; across
    // groups the order never changes.
    const ne = filterPaletteEntries(entries, 'ne');
    assert.deepEqual(ne.map((entry) => entry.label), ['New tab', 'a lighthouse']);
    assert.deepEqual(ne.map((entry) => entry.kind), ['tab', 'tab']);

    // The label wins over the hint: "video" is a page, a model type, and a word
    // in nothing else here.
    const video = filterPaletteEntries(entries, 'video');
    assert.equal(video[0].label, 'Video');
    assert.equal(video.at(-1).label, 'Wan 2.2', 'the hint still matches, after the labels');

    assert.equal(filterPaletteEntries(entries, 'zzz').length, 0);
    assert.equal(filterPaletteEntries(entries, '   ').length, entries.length, 'an empty query keeps everything');
});

test('a prefix match sorts above a mid-word one', () => {
    const entries = buildPaletteEntries({
        navItems: [
            { page: 'history', icon: 'clock', label: () => 'History' },
            { page: 'story', icon: 'persona', label: () => 'Story' },
        ],
    });
    assert.deepEqual(filterPaletteEntries(entries, 'sto').map((entry) => entry.label), ['Story', 'History']);
});

test('group headings are translated', () => {
    assert.equal(paletteGroupLabel('page'), 'Pages');
    assert.equal(paletteGroupLabel('prompt'), 'Saved prompts');
    assert.equal(paletteGroupLabel('model', true), '模型');
});
