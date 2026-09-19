// Scene-chaining prompt continuity — the scaffold keeps the scene description
// in the prompt (the pinned frames only carry motion; live-verified 2026-08-10).
const test = require('node:test');
const assert = require('node:assert/strict');

test('arming appends the continuity scaffold after the existing description', async () => {
    const { armChainPrompt, CHAIN_CONTINUITY_PHRASE } = await import('../src/lib/chainPrompt.js');
    const armed = armChainPrompt('A knight in blue armor on a castle wall, cel-shaded video game style.');
    assert.ok(armed.startsWith('A knight in blue armor'), 'keeps the scene description first');
    assert.ok(armed.includes(CHAIN_CONTINUITY_PHRASE), 'carries the scaffold');
    assert.match(armed, /then: $/, 'ends ready for the next beat');
});

test('arming is idempotent and tolerates an empty composer', async () => {
    const { armChainPrompt, CHAIN_CONTINUITY_PHRASE } = await import('../src/lib/chainPrompt.js');
    const once = armChainPrompt('A knight.');
    const twice = armChainPrompt(`${once}he steps down from the ledge.`);
    assert.equal(
        twice.split(CHAIN_CONTINUITY_PHRASE).length, 2,
        're-arming never stacks a second scaffold',
    );
    const empty = armChainPrompt('');
    assert.ok(empty.startsWith(CHAIN_CONTINUITY_PHRASE), 'empty prompt gets just the scaffold');
    assert.doesNotMatch(empty, /^\n/, 'no stray leading whitespace');
});
