// Adopting an existing output from the durable History view into a studio
// session ("Load in Studio" hands the clip over with its settings).
const test = require('node:test');
const assert = require('node:assert/strict');

const SESSION = {
    history: [],
    modelId: 'hivemind-media:minimax-h3',
    aspectRatio: '16:9',
    duration: 5,
};

test('a restored clip becomes a strip entry carrying the model it was made with', async () => {
    const { restoredHistoryEntry } = await import('../src/lib/restoredOutput.js');
    const entry = restoredHistoryEntry(
        { url: '/api/canvas/history/abc/media', id: 'abc', timestamp: '2026-08-10T22:31:00Z' },
        { prompt: 'a knight on a castle wall' },
        SESSION,
    );
    // The model is what makes Continue scene resolvable on a restored clip.
    assert.equal(entry.model, 'hivemind-media:minimax-h3');
    assert.equal(entry.url, '/api/canvas/history/abc/media');
    assert.equal(entry.id, 'abc');
    assert.equal(entry.timestamp, '2026-08-10T22:31:00Z');
    assert.equal(entry.aspect_ratio, '16:9');
    assert.equal(entry.duration, 5);
    assert.equal(entry.restored, true);
});

test('loading the same clip twice does not duplicate the tile', async () => {
    const { restoredHistoryEntry } = await import('../src/lib/restoredOutput.js');
    const output = { url: '/api/canvas/history/abc/media', id: 'abc' };
    const first = restoredHistoryEntry(output, null, SESSION);
    assert.ok(first, 'first load adds a tile');
    const second = restoredHistoryEntry(output, null, { ...SESSION, history: [first] });
    assert.equal(second, null, 'second load adds nothing — the canvas still updates');
});

test('a payload with no clip is ignored', async () => {
    const { restoredHistoryEntry } = await import('../src/lib/restoredOutput.js');
    assert.equal(restoredHistoryEntry(null, null, SESSION), null);
    assert.equal(restoredHistoryEntry({ url: '   ' }, null, SESSION), null);
    assert.equal(restoredHistoryEntry({}, null, SESSION), null);
});

test('missing session fields degrade to nulls instead of throwing', async () => {
    const { restoredHistoryEntry } = await import('../src/lib/restoredOutput.js');
    const entry = restoredHistoryEntry({ url: '/api/x/media' }, null, {});
    assert.equal(entry.model, null);
    assert.equal(entry.prompt, '');
    assert.ok(entry.id.startsWith('restored-'));
    assert.ok(entry.timestamp, 'stamps a fallback timestamp');
});
