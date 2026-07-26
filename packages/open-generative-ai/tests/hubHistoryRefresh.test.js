const test = require('node:test');
const assert = require('node:assert/strict');

// The History view polls every 10s while it is open, but that poll only ever
// re-fetches PAGE 1. Publishing page 1 as the whole list truncated everything the
// infinite scroller had already loaded: those cards unmounted, a playing <video>
// lost its decrypted blob and snapped back to the "Load video" button, and the
// sentinel — now near the shortened list's end — re-appended the same pages a
// moment later. Repeat every 10 seconds, which made videos unplayable.

let instance = 0;
// Fresh module instance per test: hubState is a module singleton.
function freshHub() {
    instance += 1;
    return import(`../src/hub/hubData.js?case=${instance}`);
}

// The feed is newest-first, so a lower id must carry a LATER timestamp; id 99
// stands in for a generation that just finished.
function entry(id) {
    const minute = String(Math.max(0, 100 - id)).padStart(2, '0');
    return { history_id: id, created_at: `2026-07-22T00:${minute}:00Z`, media_url: `/api/canvas/output/${id}.mp4`, media_type: 'video/mp4', encrypted_at_rest: true };
}

// Serves /api/simple/prompts plus a paginated /api/canvas/history over `all`.
function stubApi(all, pageSize) {
    return async (path) => {
        const json = () => {
            if (path.startsWith('/api/simple/prompts')) return { prompts: [] };
            const page = Number(new URL(path, 'http://x').searchParams.get('page') || 1);
            const start = (page - 1) * pageSize;
            const slice = all.slice(start, start + pageSize);
            return {
                history: slice,
                pagination: { page, total: all.length, has_more: start + pageSize < all.length },
                filters: { formats: ['mp4'], models: [] },
            };
        };
        return { ok: true, headers: { get: () => 'application/json' }, json: async () => json() };
    };
}

async function setup(total, pageSize) {
    const hub = await freshHub();
    const all = Array.from({ length: total }, (_, i) => entry(i + 1));
    global.fetch = stubApi(all, pageSize);
    hub.hubState.canvasPageSize = pageSize;
    return { hub, all };
}

test('a background refresh keeps every page the infinite scroller already loaded', async () => {
    const { hub } = await setup(6, 2);

    await hub.loadPrompts();                 // page 1
    await hub.loadMoreCanvasHistory();       // page 2
    await hub.loadMoreCanvasHistory();       // page 3
    assert.equal(hub.hubState.canvasHistory.length, 6);
    assert.equal(hub.hubState.canvasPage, 3);

    await hub.loadPrompts({ quiet: true });  // the 10s poll

    assert.equal(hub.hubState.canvasHistory.length, 6, 'poll truncated the list back to page 1');
    assert.deepEqual(hub.hubState.canvasHistory.map((item) => item.history_id), [1, 2, 3, 4, 5, 6]);
    // The cursor must not rewind, or the next sentinel hit re-fetches page 2.
    assert.equal(hub.hubState.canvasPage, 3);
    assert.equal(hub.hubState.canvasHasMore, false);
});

test('an unchanged background refresh publishes nothing at all', async () => {
    const { hub } = await setup(6, 2);
    await hub.loadPrompts();
    await hub.loadMoreCanvasHistory();

    let renders = 0;
    hub.subscribeHub(() => { renders += 1; });
    await hub.loadPrompts({ quiet: true });

    assert.equal(renders, 0, 'an idle poll re-rendered the whole archive');
});

test('a background refresh surfaces a new output without dropping later pages', async () => {
    const { hub, all } = await setup(6, 2);
    await hub.loadPrompts();
    await hub.loadMoreCanvasHistory();
    await hub.loadMoreCanvasHistory();

    all.unshift(entry(99));                  // a generation just finished
    global.fetch = stubApi(all, 2);

    let renders = 0;
    hub.subscribeHub(() => { renders += 1; });
    await hub.loadPrompts({ quiet: true });

    assert.equal(renders, 1, 'a changed poll must publish exactly once');
    assert.deepEqual(
        hub.hubState.canvasHistory.map((item) => item.history_id),
        [99, 1, 2, 3, 4, 5, 6],
        'the new output leads and every loaded page survives',
    );
});

test('a background refresh drops a row deleted from inside the first page', async () => {
    const { hub, all } = await setup(6, 2);
    await hub.loadPrompts();
    await hub.loadMoreCanvasHistory();
    await hub.loadMoreCanvasHistory();

    all.shift();                             // the newest output was deleted elsewhere
    global.fetch = stubApi(all, 2);
    await hub.loadPrompts({ quiet: true });

    assert.deepEqual(
        hub.hubState.canvasHistory.map((item) => item.history_id),
        [2, 3, 4, 5, 6],
        'a deleted row must not linger just because it fell outside the fresh page',
    );
});

test('a background refresh keeps provenance the Canvas bridge discovered client-side', async () => {
    const { hub } = await setup(4, 2);
    await hub.loadPrompts();
    // inspectCanvasHistoryEntry writes models/seeds onto the entry and echoes them
    // to the server; a refresh that races that POST must not blank them.
    hub.hubState.canvasHistory[0].models = ['ltx23-eros'];

    await hub.loadPrompts({ quiet: true });

    assert.deepEqual(hub.hubState.canvasHistory[0].models, ['ltx23-eros']);
});

test('an explicit load restarts pagination from page 1', async () => {
    const { hub } = await setup(6, 2);
    await hub.loadPrompts();
    await hub.loadMoreCanvasHistory();
    assert.equal(hub.hubState.canvasHistory.length, 4);

    await hub.loadPrompts();                 // e.g. a filter change

    assert.equal(hub.hubState.canvasHistory.length, 2, 'a filter change must not merge stale pages');
    assert.equal(hub.hubState.canvasPage, 1);
    assert.equal(hub.hubState.canvasHasMore, true);
});
