// The episode timeline behind a chained scene: ordering, lineage across the
// two URLs an output can be known by, dropped shots, and staleness of an
// already-built combined clip.
const test = require('node:test');
const assert = require('node:assert/strict');

// Shot 1 generated, shot 2 chained from it, shot 3 chained from shot 2.
const CHAIN = [
    { id: 'c', url: '/c.mp4', model: 'h3', chainFromUrl: '/b.mp4' },
    { id: 'b', url: '/b.mp4', model: 'h3', chainFromUrl: '/a.mp4' },
    { id: 'a', url: '/a.mp4', model: 'h3' },
];

test('the timeline is the episode in order, oldest shot first', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    const model = chainTimelineModel(CHAIN[0], CHAIN);
    assert.deepEqual(model.shots.map((s) => s.url), ['/a.mp4', '/b.mp4', '/c.mp4']);
    assert.deepEqual(model.shots.map((s) => s.shot), [1, 2, 3]);
    assert.equal(model.canBuild, true);
    assert.equal(model.combined, null, 'nothing is built yet');
});

test('an unchained clip has no episode', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    assert.equal(chainTimelineModel({ id: 'solo', url: '/solo.mp4' }, [{ id: 'solo', url: '/solo.mp4' }]), null);
});

test('a dropped shot leaves the timeline but not the combined clip', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    const model = chainTimelineModel(CHAIN[0], CHAIN, { excludedUrls: ['/b.mp4'] });
    assert.deepEqual(model.shots.map((s) => s.excluded), [false, true, false], 'still shown, marked');
    assert.deepEqual(model.includedUrls, ['/a.mp4', '/c.mp4']);
    assert.equal(model.canBuild, true);
    // Dropping down to one shot is not an episode any more.
    const single = chainTimelineModel(CHAIN[0], CHAIN, { excludedUrls: ['/b.mp4', '/c.mp4'] });
    assert.equal(single.canBuild, false);
});

test('a combined clip built from a different shot set is stale, never current', async () => {
    const { chainTimelineModel, chainKey } = await import('../src/lib/chainTimeline.js');
    const built = { url: 'blob:joined', seconds: 12, key: chainKey(['/a.mp4', '/b.mp4', '/c.mp4']) };
    const fresh = chainTimelineModel(CHAIN[0], CHAIN, { combined: built });
    assert.equal(fresh.combined, built, 'same shots — the built cut is the episode');
    assert.equal(fresh.stale, false);
    // Drop a shot: the built file no longer represents the episode.
    const after = chainTimelineModel(CHAIN[0], CHAIN, { excludedUrls: ['/b.mp4'], combined: built });
    assert.equal(after.combined, null, 'never handed back as current');
    assert.equal(after.stale, true, 'and the UI can say why');
});

test('lineage resolves a shot loaded back from History under its other URL', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    // Shot 1 was reloaded from the History route, so it now lives under
    // /api/canvas/history/<id>/media — while shot 2 still points at the URL
    // shot 1 had when it was generated.
    const restored = { id: 'a', url: '/api/canvas/history/h1/media', model: 'h3', aliasUrls: ['/a.mp4'] };
    const history = [CHAIN[1], restored];
    const model = chainTimelineModel(CHAIN[1], history);
    assert.ok(model, 'the episode is found across both spellings');
    assert.deepEqual(model.shots.map((s) => s.url), ['/api/canvas/history/h1/media', '/b.mp4']);
});

test('a missing earlier shot is reported so it can be fetched from History', async () => {
    const { missingChainParent, collectChainClips } = await import('../src/lib/chainLineage.js');
    const orphan = { id: 'b', url: '/b.mp4', chainFromUrl: '/a.mp4' };
    assert.equal(missingChainParent(orphan, [orphan]), '/a.mp4');
    assert.equal(collectChainClips(orphan, [orphan]).length, 1, 'half an episode, not silently whole');
    // Once the earlier shot is loaded, nothing is missing.
    assert.equal(missingChainParent(orphan, [orphan, { id: 'a', url: '/a.mp4' }]), null);
    // An alias satisfies it too.
    assert.equal(
        missingChainParent(orphan, [orphan, { id: 'a', url: '/hist/a', aliasUrls: ['/a.mp4'] }]),
        null,
    );
});

test('a restored clip carries its lineage forward from the sealed setup', async () => {
    const { restoredHistoryEntry } = await import('../src/lib/restoredOutput.js');
    const entry = restoredHistoryEntry(
        { url: '/api/canvas/history/h2/media', id: 'h2', aliasUrls: ['/b.mp4'] },
        { prompt: 'shot two', motionContextUrl: '/a.mp4', motionContextIndex: 1 },
        { history: [], modelId: 'h3' },
    );
    assert.equal(entry.chainFromUrl, '/a.mp4', 'knows which shot it continued');
    assert.equal(entry.chainShot, 2);
    assert.deepEqual(entry.aliasUrls, ['/b.mp4']);
    // An unchained clip stays unchained.
    const solo = restoredHistoryEntry({ url: '/x.mp4' }, { prompt: 'x' }, { history: [] });
    assert.equal(solo.chainFromUrl, undefined);
});

test('arming a chain shows the episode immediately, with the next shot pending', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    const first = { id: 'a', url: '/a.mp4', model: 'h3' };
    const history = [first];
    // Before "Continue scene": one clip is not an episode.
    assert.equal(chainTimelineModel(first, history), null);
    // Pressing it arms the chain on that clip — the timeline appears at once,
    // which is the feedback that pressing the button did anything at all.
    const armed = chainTimelineModel(first, history, { armedFromUrl: '/a.mp4' });
    assert.ok(armed, 'the episode exists the moment it is armed');
    assert.equal(armed.shots.length, 1);
    assert.equal(armed.pending, true, 'shot 2 is shown as pending');
    assert.equal(armed.canBuild, false, 'but there is nothing to join yet');

    // Arming resolves across the other URL a restored clip carries.
    const restored = { id: 'a', url: '/hist/a', aliasUrls: ['/a.mp4'], model: 'h3' };
    assert.ok(chainTimelineModel(restored, [restored], { armedFromUrl: '/a.mp4' })?.pending);
    // A chain armed on some unrelated clip does not claim this one is pending.
    assert.equal(chainTimelineModel(first, history, { armedFromUrl: '/elsewhere.mp4' }), null);
});

test('a finished episode keeps the pending tile while the chain stays armed', async () => {
    const { chainTimelineModel } = await import('../src/lib/chainTimeline.js');
    const two = [
        { id: 'b', url: '/b.mp4', model: 'h3', chainFromUrl: '/a.mp4' },
        { id: 'a', url: '/a.mp4', model: 'h3' },
    ];
    const model = chainTimelineModel(two[0], two, { armedFromUrl: '/b.mp4' });
    assert.equal(model.shots.length, 2);
    assert.equal(model.pending, true, 'chaining advanced onto shot 2, so shot 3 is next');
    assert.equal(model.canBuild, true, 'and the two finished shots can already be joined');
    // Leaving chain mode drops the placeholder but keeps the episode.
    const done = chainTimelineModel(two[0], two);
    assert.equal(done.pending, false);
    assert.equal(done.canBuild, true);
});
