// Angle-variation prompts + sequence normalization (Mix-Studio edit-angle /
// edit-sequence ports, GPL-3.0). Donor test semantics kept for the dialects.
const test = require('node:test');
const assert = require('node:assert/strict');

test('klein dialect is a full instruction with anti-collage clauses', async () => {
    const { kleinEditAnglePrompt, editAnglePrompt } = await import('../src/lib/editAngles.js');
    const prompt = kleinEditAnglePrompt({ view: 'back-right', elevation: 'low-angle', distance: 'medium shot' });
    assert.match(prompt, /^Re-render the same subject from a back-right quarter view, using a low-angle shot, with medium shot framing/);
    assert.match(prompt, /do not make a collage, split screen, turntable, or duplicate subject/);
    // User guidance rides after the instruction.
    assert.match(editAnglePrompt('klein', { view: 'front' }, 'keep the neon sign visible'), /\. keep the neon sign visible$/);
});

test('qwen dialect is the terse trigger-token form', async () => {
    const { qwenEditAnglePrompt } = await import('../src/lib/editAngles.js');
    assert.equal(
        qwenEditAnglePrompt({ view: 'front-right', elevation: 'low-angle', distance: 'medium shot' }),
        '<sks> front-right quarter view low-angle shot medium shot',
    );
});

test('angles normalize strictly and label compactly', async () => {
    const { normalizeEditAngle, angleLabel } = await import('../src/lib/editAngles.js');
    assert.deepEqual(normalizeEditAngle({ view: 'left', elevation: 'elevated' }), { view: 'left', elevation: 'elevated' });
    assert.equal(normalizeEditAngle({ view: 'diagonal' }), null);
    assert.equal(normalizeEditAngle({}), null);
    assert.equal(angleLabel({ view: 'left', distance: 'close-up' }), 'left · close-up');
});

test('model dialect detection covers klein and qwen/anima families', async () => {
    const { angleDialectForModel } = await import('../src/lib/editAngles.js');
    assert.equal(angleDialectForModel({ backend: 'comfy-bigloves-klein3-edit' }), 'klein');
    assert.equal(angleDialectForModel({ family: 'flux-2-klein', id: 'mlx-bigloves-klein3-edit' }), 'klein');
    assert.equal(angleDialectForModel({ id: 'wai-anima-4b-aligned' }), 'qwen');
    assert.equal(angleDialectForModel({ id: 'z-image-turbo' }), null);
    assert.equal(angleDialectForModel(null), null);
});

test('sequences normalize from text, cap steps, and need at least two', async () => {
    const { normalizeSequentialPrompts, normalizeEditSequence, MAX_SEQUENCE_STEPS } = await import('../src/lib/editSequence.js');
    assert.deepEqual(
        normalizeSequentialPrompts('add a scarf\n\n  make it snow  \n'),
        ['add a scarf', 'make it snow'],
    );
    const overflow = normalizeSequentialPrompts(Array.from({ length: 20 }, (_, i) => `step ${i}`));
    assert.equal(overflow.length, MAX_SEQUENCE_STEPS);
    assert.equal(normalizeEditSequence({ prompts: ['only one'] }), null);
    const seq = normalizeEditSequence({ prompts: ['a', 'b', 'c'], index: 99 });
    assert.deepEqual(seq, { prompts: ['a', 'b', 'c'], index: 2, total: 3 });
});
