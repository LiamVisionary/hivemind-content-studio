// What the lane-memory panel says, and — mostly — when it says nothing at all.
const test = require('node:test');
const assert = require('node:assert/strict');

const GB = 1024 ** 3;
const snapshot = (lanes, extra = {}) => ({
  lanes,
  availableBytes: 90 * GB,
  kleinAdmissionBytes: 48 * GB,
  holdingThresholdBytes: 3 * GB,
  ...extra,
});

test('nothing to reclaim means no panel at all', async () => {
    const { laneNotice } = await import('../src/lib/laneMemory.js');
    assert.equal(laneNotice(null), null);
    assert.equal(laneNotice(snapshot([])), null);
    // Running and idle is the normal state of every lane; it is not news.
    assert.equal(laneNotice(snapshot([
        { id: 'ltx', label: 'LTX video lane', running: true, rssBytes: 0.9 * GB, holding: false, reclaimable: false },
    ])), null);
});

test('a busy lane is never offered up, however much it holds', async () => {
    const { laneNotice } = await import('../src/lib/laneMemory.js');
    assert.equal(laneNotice(snapshot([
        { id: 'ltx', label: 'LTX video lane', running: true, rssBytes: 16 * GB, holding: true, busy: true, reclaimable: false },
    ])), null);
});

test('a finished lane still holding memory gets one line and a sized button', async () => {
    const { laneNotice } = await import('../src/lib/laneMemory.js');
    const notice = laneNotice(snapshot([
        { id: 'ltx', label: 'LTX video lane', running: true, rssBytes: 14 * GB, holding: true, busy: false, reclaimable: true },
    ]));
    assert.equal(notice.lane, 'ltx');
    assert.equal(notice.action, 'Free 14 GB');
    assert.equal(notice.tone, 'info');
    // Plenty of memory left: state the fact, promise no speed-up.
    assert.match(notice.message, /still holding 14 GB/);
    assert.match(notice.message, /lane stays up/);
});

test('below the admission bar it escalates to why generations are waiting', async () => {
    const { laneNotice } = await import('../src/lib/laneMemory.js');
    const notice = laneNotice(snapshot([
        { id: 'ltx', label: 'LTX video lane', running: true, rssBytes: 30 * GB, holding: true, busy: false, reclaimable: true },
    ], { availableBytes: 20 * GB }));
    assert.equal(notice.tone, 'warn');
    assert.match(notice.message, /below the headroom/);
});

test('the biggest holder is the one offered', async () => {
    const { laneNotice, reclaimableLanes } = await import('../src/lib/laneMemory.js');
    const lanes = [
        { id: 'default', label: 'Image lane', rssBytes: 5 * GB, holding: true, reclaimable: true },
        { id: 'ltx', label: 'LTX video lane', rssBytes: 22 * GB, holding: true, reclaimable: true },
    ];
    assert.deepEqual(reclaimableLanes(snapshot(lanes)).map((l) => l.id), ['ltx', 'default']);
    assert.equal(laneNotice(snapshot(lanes)).lane, 'ltx');
});

test('sizes read naturally on both sides of 10 GB', async () => {
    const { formatGB } = await import('../src/lib/laneMemory.js');
    assert.equal(formatGB(14 * GB), '14 GB');
    assert.equal(formatGB(4.25 * GB), '4.3 GB');
    assert.equal(formatGB(0), '0 GB');
    assert.equal(formatGB(undefined), '0 GB');
    assert.equal(formatGB(-5), '0 GB');
});

test('a snapshot missing its memory numbers never claims the machine is tight', async () => {
    const { isMemoryTight } = await import('../src/lib/laneMemory.js');
    assert.equal(isMemoryTight(null), false);
    assert.equal(isMemoryTight({ lanes: [] }), false);
    assert.equal(isMemoryTight({ availableBytes: 10 * GB, kleinAdmissionBytes: 0 }), false);
});
