// The manual timeline model — capture, drop-plan and continuation rules. These
// are the arithmetic behind the strip's feel (where a generation lands, what a
// drop means, which clip the next shot continues from), invisible in a
// screenshot and easy to get subtly wrong.
const test = require('node:test');
const assert = require('node:assert/strict');

const lib = () => import('../src/lib/videoTimeline.js');

const seg = (id, url = '', model = '') => ({ id, url, model });

test('opening seeds shot 1 from the canvas, or an empty slot from nothing', async () => {
    const { openTimeline } = await lib();
    const seeded = openTimeline('/api/x/clip1.mp4', 'minimax-h3');
    assert.equal(seeded.segments.length, 1);
    assert.equal(seeded.segments[0].url, '/api/x/clip1.mp4');
    assert.equal(seeded.segments[0].model, 'minimax-h3');
    assert.equal(seeded.selectedId, seeded.segments[0].id);

    const blank = openTimeline('', '');
    assert.equal(blank.segments.length, 1);
    assert.equal(blank.segments[0].url, '');
    // A model label without a clip would be a lie about what the slot holds.
    const labelled = openTimeline('', 'minimax-h3');
    assert.equal(labelled.segments[0].model, '');
});

test('a finished generation fills the selected empty slot, and never silently replaces', async () => {
    const { captureIntoTimeline } = await lib();
    // Empty selected slot → filled in place, selection unchanged.
    const filled = captureIntoTimeline([seg('a', 'u1'), seg('b')], 'b', { url: 'u2', model: 'm' });
    assert.deepEqual(filled.segments.map((item) => item.url), ['u1', 'u2']);
    assert.equal(filled.selectedId, 'b');
    assert.equal(filled.segment.id, 'b');

    // Filled selected slot → a NEW segment lands right after it, selected.
    const inserted = captureIntoTimeline([seg('a', 'u1'), seg('b', 'u2')], 'a', { url: 'u3', model: 'm' });
    assert.deepEqual(inserted.segments.map((item) => item.url), ['u1', 'u3', 'u2']);
    assert.equal(inserted.selectedId, inserted.segments[1].id);

    // No selection resolvable → appended at the end.
    const appended = captureIntoTimeline([seg('a', 'u1')], 'missing', { url: 'u2', model: 'm' });
    assert.deepEqual(appended.segments.map((item) => item.url), ['u1', 'u2']);
});

test('removing a segment moves the selection to its neighbour', async () => {
    const { removeTimelineSegment } = await lib();
    const three = [seg('a', 'u1'), seg('b', 'u2'), seg('c', 'u3')];
    // The one that slid into its slot…
    assert.equal(removeTimelineSegment(three, 'b', 'b').selectedId, 'c');
    // …or the new last when the last one went…
    assert.equal(removeTimelineSegment(three, 'c', 'c').selectedId, 'b');
    // …and an unrelated selection stays put.
    assert.equal(removeTimelineSegment(three, 'a', 'c').selectedId, 'c');
    assert.equal(removeTimelineSegment([seg('a')], 'a', 'a').selectedId, '');
});

test('the drop plan resolves every gesture, and a no-op drop stays a no-op', async () => {
    const { timelineDropPlan } = await lib();
    const list = [seg('a', 'u1'), seg('b'), seg('c', 'u3')];
    const clip = { kind: 'clip', url: 'uNew', model: 'm' };

    // Onto an empty card → fill; onto a filled card → replace, behind a confirm.
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'on' }, clip), { action: 'fill', id: 'b' });
    assert.deepEqual(timelineDropPlan(list, { id: 'a', region: 'on' }, clip), { action: 'replace', id: 'a', needsConfirm: true });
    // The same clip back onto its own card changes nothing.
    assert.equal(timelineDropPlan(list, { id: 'a', region: 'on' }, { kind: 'clip', url: 'u1' }), null);

    // Into the gaps → insert there; onto the "+" card → append.
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'before' }, clip), { action: 'insert', index: 1 });
    assert.deepEqual(timelineDropPlan(list, { id: 'b', region: 'after' }, clip), { action: 'insert', index: 2 });
    assert.deepEqual(timelineDropPlan(list, { region: 'end' }, clip), { action: 'append' });

    // A card dragged between its siblings moves — with the index measured in
    // the list WITHOUT itself, which is what a gap drop produces.
    assert.deepEqual(timelineDropPlan(list, { id: 'c', region: 'before' }, { kind: 'segment', id: 'a' }), { action: 'move', id: 'a', index: 1 });
    assert.deepEqual(timelineDropPlan(list, { region: 'end' }, { kind: 'segment', id: 'a' }), { action: 'move', id: 'a', index: 2 });
    // Dropped back beside itself → nothing moves, so nothing rebuilds.
    assert.equal(timelineDropPlan(list, { id: 'a', region: 'after' }, { kind: 'segment', id: 'a' }), null);
    assert.equal(timelineDropPlan(list, { id: 'b', region: 'before' }, { kind: 'segment', id: 'a' }), null);
});

test('moving a segment lands where the gap said it would', async () => {
    const { moveTimelineSegment } = await lib();
    const list = [seg('a', 'u1'), seg('b', 'u2'), seg('c', 'u3')];
    assert.deepEqual(moveTimelineSegment(list, 'a', 1).map((item) => item.id), ['b', 'a', 'c']);
    assert.deepEqual(moveTimelineSegment(list, 'c', 0).map((item) => item.id), ['c', 'a', 'b']);
    assert.deepEqual(moveTimelineSegment(list, 'missing', 0), list);
});

test('auto-continue picks the mechanism from the model and the clip from the strip', async () => {
    const { timelineContinuationPlan } = await lib();
    const strip = [seg('a', 'u1'), seg('gap'), seg('b', 'u2'), seg('next')];
    const h3 = { supportsMotionContext: true, supportsStartFrame: true };
    const ltx = { supportsMotionContext: false, supportsStartFrame: true };
    const cloud = {};

    // The source is the last FILLED segment before the selected slot — an
    // empty placeholder between them is skipped, not continued from.
    assert.deepEqual(timelineContinuationPlan(h3, strip, 'next'), { mode: 'chain', fromUrl: 'u2', fromIndex: 2 });
    assert.deepEqual(timelineContinuationPlan(ltx, strip, 'next'), { mode: 'frame', fromUrl: 'u2', fromIndex: 2 });
    assert.deepEqual(timelineContinuationPlan(h3, strip, 'gap'), { mode: 'chain', fromUrl: 'u1', fromIndex: 0 });

    // Nothing before it, a filled selection, or a model with no mechanism →
    // nothing to arm.
    assert.equal(timelineContinuationPlan(h3, [seg('only')], 'only'), null);
    assert.equal(timelineContinuationPlan(h3, strip, 'b'), null);
    assert.equal(timelineContinuationPlan(cloud, strip, 'next'), null);
});

test('the persisted strip survives a round trip and a corrupt blob degrades to nothing', async () => {
    const { serializeTimeline, reviveTimeline, MAX_TIMELINE_SEGMENTS } = await lib();
    const state = {
        on: true,
        segments: [seg('a', 'u1', 'minimax-h3'), seg('b')],
        selectedId: 'b',
        extend: true,
        showCombined: true,
    };
    const revived = reviveTimeline(JSON.parse(JSON.stringify(serializeTimeline(state))));
    assert.deepEqual(revived, {
        on: true,
        segments: [
            { id: 'a', url: 'u1', model: 'minimax-h3', excluded: false },
            { id: 'b', url: '', model: '', excluded: false },
        ],
        selectedId: 'b',
        extend: true,
        showCombined: true,
    });

    // A selection pointing at nothing snaps to the first segment; duplicate
    // ids or no segments at all are not a strip.
    assert.equal(reviveTimeline({ segments: [seg('a', 'u')], selectedId: 'zz' }).selectedId, 'a');
    assert.equal(reviveTimeline({ segments: [seg('a'), seg('a')], selectedId: 'a' }), null);
    assert.equal(reviveTimeline({ segments: [] }), null);
    assert.equal(reviveTimeline(null), null);
    assert.equal(reviveTimeline('nonsense'), null);

    // A hostile blob cannot mount hundreds of poster decoders.
    const flood = { segments: Array.from({ length: 200 }, (_, i) => seg(`s${i}`, 'u')), selectedId: 's0' };
    assert.equal(reviveTimeline(flood).segments.length, MAX_TIMELINE_SEGMENTS);
});

test('the combine key is the filled clips in order, and two clips make a cut', async () => {
    const { timelineCombineKey, timelineCanCombine, filledTimelineSegments } = await lib();
    const list = [seg('a', 'u1'), seg('gap'), seg('b', 'u2')];
    assert.equal(timelineCombineKey(list), 'u1 u2');
    assert.equal(timelineCanCombine(list), true);
    assert.equal(timelineCanCombine([seg('a', 'u1'), seg('gap')]), false);
    assert.deepEqual(filledTimelineSegments(list).map((item) => item.id), ['a', 'b']);
    // Reordering changes the key — a built cut for the old order is stale.
    assert.notEqual(timelineCombineKey([list[2], list[0]]), timelineCombineKey(list));
});
