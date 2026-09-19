// Emotion / performance direction — the port of the Seedance performance field
// guide, and the two things that make it more than a string list: the H3
// dialect, and where the phrase is allowed to land in an H3 prompt.
const test = require('node:test');
const assert = require('node:assert/strict');

const THREE_FIELD = [
    'integrated_multimodal_description: A woman sits at a table. [Shot 1] She looks up.',
    '',
    'overall_soundscape: Room tone and a distant street.',
    '',
    'non_diegetic_music: N/A',
].join('\n');

test('all 25 studies ship, in both dialects, with their guide metadata', async () => {
    const { EMOTION_DIRECTIONS, EMOTION_FAMILIES, EMOTION_INTENSITIES } = await import('../src/lib/emotionDirection.js');
    assert.equal(EMOTION_DIRECTIONS.length, 25);
    for (const entry of EMOTION_DIRECTIONS) {
        assert.ok(entry.id && entry.label && entry.hint, `${entry.id} labelled`);
        assert.ok(EMOTION_FAMILIES.includes(entry.family), `${entry.id} sits in a known family`);
        assert.ok(EMOTION_INTENSITIES.includes(entry.intensity), `${entry.id} declares an intensity`);
        assert.ok(entry.prompt.length > 120, `${entry.id} carries the guide's own text`);
        assert.ok(entry.h3.length > 120, `${entry.id} carries an H3 rewrite`);
        // The guide's rule, and the reason these append to any scene: visible
        // acting ONLY. A study that named the room, the lens or the wardrobe
        // would fight the prompt it is dropped into.
        assert.doesNotMatch(entry.prompt, /\b(camera|lens|shot|wardrobe|lighting|background|wearing)\b/i,
            `${entry.id} stays performance-only`);
        assert.doesNotMatch(entry.h3, /\b(camera|lens|wardrobe|lighting|background|wearing)\b/i,
            `${entry.id}/h3 stays performance-only`);
    }
    assert.equal(new Set(EMOTION_DIRECTIONS.map((entry) => entry.id)).size, 25, 'ids are unique');
});

test('the H3 dialect names the sound the performance makes', async () => {
    const { EMOTION_DIRECTIONS } = await import('../src/lib/emotionDirection.js');
    // H3 renders the audio as well as the picture, so a study that leaves its
    // sound implicit comes back mimed — a laugh with no laugh. Every rewrite
    // therefore differs from the prose text, and says either what is heard or
    // that nothing is said.
    const HEARD = /\b(audible|audibly|out loud|sobs|hiss|gasp|sigh|exhale|breath|breathing|swallow|laugh|silence|no words|nothing is said|no word spoken)\b/i;
    for (const entry of EMOTION_DIRECTIONS) {
        assert.notEqual(entry.h3, entry.prompt, `${entry.id} has a real rewrite, not a copy`);
        assert.match(entry.h3, HEARD, `${entry.id}/h3 says what is heard`);
    }
});

test('switching a direction replaces the phrase instead of stacking', async () => {
    const { applyEmotionPrompt } = await import('../src/lib/emotionDirection.js');
    const scene = 'A courier waits on the platform.';
    const first = applyEmotionPrompt(scene, null, 'boredom');
    assert.match(first.prompt, /^A courier waits on the platform\. Performance: The eyelids grow heavy/);
    const second = applyEmotionPrompt(first.prompt, first.id, 'relief');
    assert.doesNotMatch(second.prompt, /eyelids grow heavy/);
    assert.equal((second.prompt.match(/Performance:/g) || []).length, 1);
    // Clearing restores the scene exactly — punctuation included.
    const cleared = applyEmotionPrompt(second.prompt, second.id, null);
    assert.equal(cleared.id, null);
    assert.equal(cleared.prompt, scene);
});

test('a direction armed on one model is stripped after the model changes dialect', async () => {
    const { applyEmotionPrompt } = await import('../src/lib/emotionDirection.js');
    // Arm on Seedance, switch the model to H3, re-apply: the phrase already in
    // the prompt is the PROSE one, so stripping only the current dialect would
    // leave it behind and write a second sentence.
    const prose = applyEmotionPrompt('A courier waits.', null, 'crying');
    const h3 = applyEmotionPrompt(prose.prompt, 'crying', 'crying', { h3: true });
    assert.equal((h3.prompt.match(/Performance:/g) || []).length, 1);
    assert.match(h3.prompt, /audible stuttering hitches/);
    assert.doesNotMatch(h3.prompt, /visible stutters/);
});

test('an H3 phrase lands in the description, never past the end in the music field', async () => {
    const { applyEmotionPrompt } = await import('../src/lib/emotionDirection.js');
    // An H3 prompt ENDS in non_diegetic_music, so a plain append writes acting
    // direction into the music field — the failure the composer weave was built
    // for, and one the Style chip still has.
    const armed = applyEmotionPrompt(THREE_FIELD, null, 'shock', { h3: true });
    const at = (needle) => armed.prompt.indexOf(needle);
    assert.ok(at('Performance:') > at('integrated_multimodal_description:'));
    assert.ok(at('Performance:') < at('overall_soundscape:'));
    // The fields survive the round trip: a strip that tidied whitespace across
    // the whole prompt flattened it onto one line, and the NEXT selection then
    // missed the description and landed past the end again.
    const switched = applyEmotionPrompt(armed.prompt, 'shock', 'relief', { h3: true });
    assert.ok(switched.prompt.indexOf('Performance:') < switched.prompt.indexOf('overall_soundscape:'));
    assert.equal(applyEmotionPrompt(switched.prompt, 'relief', null, { h3: true }).prompt, THREE_FIELD);
});

test('both H3 formats are handled, and a real starter comes back unchanged when cleared', async () => {
    const { applyEmotionPrompt } = await import('../src/lib/emotionDirection.js');
    const { checkH3Prompt } = await import('../src/lib/h3PromptCheck.js');
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    // Never gate on one H3 format: the starters and the helper write
    // three-field, reference mode writes six-section, and code that knew only
    // one has silently swallowed the other before.
    const six = DEFAULT_PROMPTS.find((entry) => entry.id === 'fashion-lookbook-h3').parts[0].prompt;
    const three = DEFAULT_PROMPTS.find((entry) => entry.id === 'korean-home-video-h3').parts[0].prompt;
    for (const [label, starter] of [['six-section', six], ['three-field', three]]) {
        const armed = applyEmotionPrompt(starter, null, 'pride', { h3: true });
        const perf = armed.prompt.indexOf('Performance:');
        assert.ok(perf > 0 && perf < armed.prompt.indexOf('overall_soundscape:'),
            `${label}: the phrase is inside the description`);
        // Arming a performance must not invent a new Prompt Check finding.
        const before = checkH3Prompt({ prompt: starter, durationSeconds: 15 }).findings.map((f) => f.code).sort();
        const after = checkH3Prompt({ prompt: armed.prompt, durationSeconds: 15 }).findings.map((f) => f.code).sort();
        assert.deepEqual(after, before, `${label}: no new Prompt Check finding`);
        assert.equal(applyEmotionPrompt(armed.prompt, 'pride', null, { h3: true }).prompt, starter,
            `${label}: clearing restores the starter byte for byte`);
    }
});

test('the chip can be reconciled with a prompt restored from the composer', async () => {
    const { applyEmotionPrompt, emotionDirectionIdInPrompt } = await import('../src/lib/emotionDirection.js');
    // The id persists in plaintext settings and the phrase persists with the
    // encrypted prompt; if the two disagree after a reload, re-applying stacks.
    assert.equal(emotionDirectionIdInPrompt(''), null);
    assert.equal(emotionDirectionIdInPrompt('A courier waits on the platform.'), null);
    for (const h3 of [false, true]) {
        const armed = applyEmotionPrompt(THREE_FIELD, null, 'eye-roll', { h3 });
        assert.equal(emotionDirectionIdInPrompt(armed.prompt), 'eye-roll', `dialect h3=${h3} is recognised`);
    }
});

test('a preference round-trips the selection id and rejects an unknown one', async () => {
    const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
    // normalizeVideoPreferences refuses a record with no model, so every case
    // carries one.
    const prefs = (extra) => normalizeVideoPreferences({ modelId: 'hivemind-media:minimax-h3', ...extra });
    assert.equal(prefs({ emotionDirectionId: 'rage' }).emotionDirectionId, 'rage');
    assert.equal(prefs({ emotionDirectionId: 'not-an-emotion' }).emotionDirectionId, null);
    assert.equal(prefs({}).emotionDirectionId, null);
});
