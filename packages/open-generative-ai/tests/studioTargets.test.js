// The send-target registry: where another studio can send work. See
// src/lib/studioTargets.js.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = async () => {
    const mod = await import('../src/lib/studioTargets.js');
    mod.resetSendTargets();
    return mod;
};

const tab = (tabId, overrides = {}) => ({
    section: 'video', tabId, index: tabId, label: `Tab ${tabId}`, active: false, current: 'local',
    sources: { local: { available: true, modelId: 'a', modelName: 'A' }, api: { available: false }, rented: { available: false } },
    ...overrides,
});

test('targets come back in tab order however they were published', async () => {
    const { publishSendTarget, listSendTargets } = await load();
    publishSendTarget('video:3', tab(3));
    publishSendTarget('video:1', tab(1));
    publishSendTarget('video:2', tab(2));
    assert.deepEqual(listSendTargets('video').map((entry) => entry.tabId), [1, 2, 3]);
});

test('a tab that unmounts stops being a target', async () => {
    const { publishSendTarget, listSendTargets } = await load();
    const off = publishSendTarget('video:1', tab(1));
    publishSendTarget('video:2', tab(2));
    off();
    assert.deepEqual(listSendTargets('video').map((entry) => entry.tabId), [2]);
    // Idempotent: a second unpublish is not an error and changes nothing.
    off();
    assert.equal(listSendTargets('video').length, 1);
});

test('republishing the same key replaces rather than duplicates', async () => {
    const { publishSendTarget, listSendTargets } = await load();
    publishSendTarget('video:1', tab(1));
    publishSendTarget('video:1', tab(1, { current: 'rented' }));
    assert.equal(listSendTargets('video').length, 1);
    assert.equal(listSendTargets('video')[0].current, 'rented');
});

test('sections do not see each other', async () => {
    const { publishSendTarget, listSendTargets } = await load();
    publishSendTarget('video:1', tab(1));
    publishSendTarget('image:1', tab(1, { section: 'image' }));
    assert.equal(listSendTargets('video').length, 1);
    assert.equal(listSendTargets('image').length, 1);
});

test('subscribers hear every change, and one that throws does not silence the rest', async () => {
    const { publishSendTarget, subscribeSendTargets } = await load();
    let good = 0;
    const offBad = subscribeSendTargets(() => { throw new Error('a bad listener'); });
    const offGood = subscribeSendTargets(() => { good += 1; });
    const off = publishSendTarget('video:1', tab(1));
    assert.equal(good, 1);
    off();
    assert.equal(good, 2, 'unpublish is a change too');
    offBad();
    offGood();
    publishSendTarget('video:2', tab(2));
    assert.equal(good, 2, 'an unsubscribed listener stops hearing');
});
