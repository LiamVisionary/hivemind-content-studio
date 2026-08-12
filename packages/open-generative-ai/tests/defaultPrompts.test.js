// Default (shipped) prompt library — selection rules, the split-at-the-model's-
// ceiling contract, and the format checks that decide whether a starter actually
// renders on the model it targets.
const test = require('node:test');
const assert = require('node:assert/strict');

const H3_MODEL = { modelId: 'hivemind-media:minimax-h3', modelFamily: 'minimax' };
const LTX_MODEL = { modelId: 'hivemind-media:ltx23-regular-fp8', modelFamily: 'ltx-2.3' };
const SEEDANCE_MODEL = { modelId: 'seedance-v2.0-t2v' };
const SEEDANCE_25_MODEL = { modelId: 'seedance-2.5-text-to-video' };

test('every starter is fully described and targets a known family', async () => {
    const { DEFAULT_PROMPTS, PROMPT_FAMILIES } = await import('../src/lib/defaultPrompts.js');
    assert.ok(DEFAULT_PROMPTS.length >= 4);
    for (const entry of DEFAULT_PROMPTS) {
        assert.ok(entry.id && entry.name && entry.summary, `${entry.id} labelled`);
        assert.ok(PROMPT_FAMILIES[entry.family], `${entry.id} targets a known family`);
        assert.ok(['image', 'video'].includes(entry.section), `${entry.id} belongs to a studio section`);
        // The format decides which shape check below applies to it; an unknown
        // one would silently skip every check a starter has.
        assert.ok(['prose', 'paragraph', 'h3-fields', 'h3-reference'].includes(entry.format),
            `${entry.id} declares a known format`);
        assert.ok(entry.parts.length >= 1, `${entry.id} has at least one part`);
        for (const part of entry.parts) {
            assert.ok(part.label, `${entry.id} part labelled`);
            assert.ok(part.durationSeconds > 0, `${entry.id}/${part.label} declares its length`);
            assert.ok(part.prompt.trim().length > 200, `${entry.id}/${part.label} carries a real prompt`);
        }
    }
    // Ids are how the menu keys rows; a duplicate would silently drop one.
    assert.equal(new Set(DEFAULT_PROMPTS.map((entry) => entry.id)).size, DEFAULT_PROMPTS.length);
});

test('only the starters written for the selected model are listed', async () => {
    const { defaultPromptsFor, promptFamilyOf } = await import('../src/lib/defaultPrompts.js');

    assert.equal(promptFamilyOf(H3_MODEL), 'minimax');
    assert.equal(promptFamilyOf({ modelId: 'hivemind-media:minimax-h3-reference', modelFamily: 'minimax' }), 'minimax');
    assert.equal(promptFamilyOf(LTX_MODEL), 'ltx');
    assert.equal(promptFamilyOf(SEEDANCE_MODEL), 'seedance');
    assert.equal(promptFamilyOf({ modelId: 'seedance-lite-t2v' }), 'seedance');
    // 2.5 is its own family: it is the only one that renders 30s in one pass.
    assert.equal(promptFamilyOf(SEEDANCE_25_MODEL), 'seedance-2.5');
    assert.equal(promptFamilyOf({ modelId: 'seedance-2.5-image-to-video-480p' }), 'seedance-2.5');
    // 10Eros shares LTX's registry family but wants scene-script prompting.
    assert.equal(promptFamilyOf({ modelId: 'hivemind-media:ltx23-eros-v14-comfy', modelFamily: 'ltx' }), '');
    // A cloud model nothing is written for, and the no-model case.
    assert.equal(promptFamilyOf({ modelId: 'kling-v2.5-turbo-pro-t2v' }), '');
    assert.equal(promptFamilyOf(null), '');

    // Each model sees its own variants and nobody else's — an H3 prompt pasted
    // into a Seedance box is not a rough draft, it is field names in a text box.
    for (const [model, family] of [[H3_MODEL, 'minimax'], [LTX_MODEL, 'ltx'],
        [SEEDANCE_MODEL, 'seedance'], [SEEDANCE_25_MODEL, 'seedance-2.5']]) {
        const listed = defaultPromptsFor('video', model);
        assert.ok(listed.length, `${family} has starters`);
        assert.ok(listed.every((entry) => entry.family === family),
            `${family} sees only its own starters`);
    }
    // A model nothing is written for shows no starter section at all.
    assert.deepEqual(defaultPromptsFor('video', { modelId: 'kling-v2.5-turbo-pro-t2v' }), []);
    assert.deepEqual(defaultPromptsFor('video', { modelId: 'hivemind-media:ltx23-eros-v14-comfy', modelFamily: 'ltx' }), []);
    assert.deepEqual(defaultPromptsFor('video', null), []);
    // The image studio has no starters yet and must not be handed the video ones.
    assert.deepEqual(defaultPromptsFor('image', H3_MODEL), []);
});

test('a 30s idea is split at each model\'s own ceiling, and adds back up', async () => {
    const { DEFAULT_PROMPTS, defaultPromptTotalSeconds } = await import('../src/lib/defaultPrompts.js');
    const byFamily = Object.fromEntries(DEFAULT_PROMPTS
        .filter((entry) => entry.idea === 'korean-home-video')
        .map((entry) => [entry.family, entry]));

    // Every variant of an idea tells the same length of story.
    for (const entry of Object.values(byFamily)) {
        assert.equal(defaultPromptTotalSeconds(entry), 30, `${entry.id} covers the whole idea`);
    }
    // Only 2.5 does it in one generation. The ceilings are the studio's own:
    // H3 offers 1-15s, other local workflows 1-10s (hivemindStudio.js), and
    // Seedance 2.0 caps its duration enum at 15.
    assert.equal(byFamily['seedance-2.5'].parts.length, 1);
    assert.ok(byFamily.seedance.parts.every((part) => part.durationSeconds <= 15));
    assert.ok(byFamily.minimax.parts.every((part) => part.durationSeconds <= 15));
    assert.ok(byFamily.ltx.parts.every((part) => part.durationSeconds <= 10));

    // Every part after the first is a continuation, and says how to reach it.
    for (const entry of Object.values(byFamily)) {
        entry.parts.forEach((part, index) => {
            if (index === 0) return;
            assert.ok(part.continuation, `${entry.id} part ${index + 1} is marked a continuation`);
            assert.ok(part.note, `${entry.id} part ${index + 1} says how to arm it`);
        });
    }
});

test('continuations re-describe the scene instead of assuming it', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    // A prompt that stops naming the subject makes the model cut to an unrelated
    // take — the failure chainPrompt.js exists to prevent.
    for (const entry of DEFAULT_PROMPTS) {
        for (const part of entry.parts.slice(1)) {
            assert.match(part.prompt, /ponytail/i, `${entry.id}/${part.label} restates her hair`);
            assert.match(part.prompt, /crop top/i, `${entry.id}/${part.label} restates her wardrobe`);
            assert.match(part.prompt, /camcorder/i, `${entry.id}/${part.label} restates the look`);
        }
    }
});

test('H3 starters obey the trained three-field format', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const h3 = DEFAULT_PROMPTS.filter((entry) => entry.format === 'h3-fields');
    assert.ok(h3.length);
    for (const entry of h3) {
        for (const { prompt, label } of entry.parts) {
            const where = `${entry.id}/${label}`;
            assert.match(prompt, /^integrated_multimodal_description: /, `${where} opens on the first field`);
            assert.match(prompt, /\n\noverall_soundscape: /, `${where} carries the soundscape field`);
            assert.match(prompt, /\n\nnon_diegetic_music: /, `${where} carries the music field`);
            assert.match(prompt, /\[Shot 1\] /, `${where} opens shot 1 without a timestamp`);
            // Every later shot header carries MM:SS.mmm — the digits are the format.
            for (const header of prompt.matchAll(/\[Shot (\d+)\]([^[]{0,24})/g)) {
                if (header[1] === '1') continue;
                assert.match(header[2], /^ At \d{2}:\d{2}\.\d{3},/, `${where} shot ${header[1]} is stamped`);
            }
            // Speech only inside a <d> tag, and never a <d> tag without a language.
            const opens = prompt.match(/<d>/g) || [];
            assert.equal(opens.length, (prompt.match(/<\/d>/g) || []).length, `${where} closes every <d>`);
            assert.ok(!/<d>(?!\s*\[)/.test(prompt), `${where} tags every spoken line with its language`);
            // H3 has no negative prompt: "no music" is written as N/A, not forbidden.
            assert.doesNotMatch(prompt, /\bno music\b/i, `${where} states what is there rather than what is not`);
        }
    }
});

test('H3 reference starters obey the six-section format and label media from 1', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const SECTIONS = ['subject_definitions:', 'summary:', 'retention_analysis:',
        'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
    const refs = DEFAULT_PROMPTS.filter((entry) => entry.format === 'h3-reference');
    assert.ok(refs.length);
    for (const entry of refs) {
        // Reference mode needs media attached; a starter that does not say so
        // generates a reaction shot with nothing on the screen.
        assert.ok(entry.requires, `${entry.id} names the media it needs`);
        for (const { prompt, label } of entry.parts) {
            const where = `${entry.id}/${label}`;
            let cursor = -1;
            for (const section of SECTIONS) {
                const at = prompt.indexOf(`\n${section}\n`, cursor) >= 0
                    ? prompt.indexOf(`\n${section}\n`, cursor)
                    : (prompt.startsWith(`${section}\n`) ? 0 : -1);
                assert.ok(at > cursor || (at === 0 && cursor === -1),
                    `${where} carries ${section} on its own line, in order`);
                cursor = at;
            }
            // Labels are 1-based: the first attached video is <Video 1>. <Video 0>
            // points at a slot the graph never fills.
            assert.doesNotMatch(prompt, /<(Picture|Video|Audio) 0>/, `${where} numbers references from 1`);
            assert.match(prompt, /<Video 1>/, `${where} cites the attached clip`);
            // Audio retention comes from the copy family, picture/video retention
            // from the preserved family — mixing them is a malformed marker.
            assert.match(prompt, /<Audio 1>: (fully_copy|partially_copy|reference|weak_reference)\b/,
                `${where} marks its audio with a copy-family marker`);
            assert.match(prompt, /<Video 1>: (fully_preserved|partially_preserved|attribute_transfer|weak_reference)\b/,
                `${where} marks its video with a preserved-family marker`);
            // The task-type marker is what selects reuse over timbre-only.
            assert.match(prompt, /\[audio (reuse|reference)\]/, `${where} declares its audio task type`);
            // Every fill-in is a real hole, and no show name is baked in.
            assert.match(prompt, /\[SHOW NAME\]/, `${where} keeps the show a fill-in`);
            assert.doesNotMatch(prompt, /castlevania|alucard|sypha/i, `${where} names no specific show`);
        }
    }
});

test('a chained H3 part holds through the pinned tail before it moves or speaks', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    // The first ~0.9s of a chained clip replays the previous shot's closing
    // frames. A shot change or a spoken line inside that window reads as a jump
    // cut and lands the words early (prompt_profiles.continuation_opens_on_speech).
    for (const entry of DEFAULT_PROMPTS.filter((e) => e.family === 'minimax')) {
        for (const part of entry.parts.filter((p) => p.continuation)) {
            const stamps = [...part.prompt.matchAll(/At (\d{2}):(\d{2})\.(\d{3})/g)]
                .map((m) => ({ at: Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000, index: m.index }));
            assert.ok(stamps.length, `${entry.id}/${part.label} has timed shots`);
            assert.ok(stamps[0].at >= 1, `${entry.id}/${part.label} holds until 1s before cutting`);
            const speech = part.prompt.indexOf('<d>');
            if (speech >= 0) {
                assert.ok(stamps.some((stamp) => stamp.at >= 1 && stamp.index < speech),
                    `${entry.id}/${part.label} speaks only after the hold`);
            }
        }
    }
});

test('no part describes a beat past the end of itself', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    // Same rule prompt_profiles.timeline_overruns enforces on generated prompts:
    // a shot stamped at or past the duration is a beat that never renders.
    for (const entry of DEFAULT_PROMPTS) {
        for (const part of entry.parts) {
            for (const stamp of part.prompt.matchAll(/At (\d{1,2}):(\d{2})\.(\d{3})/g)) {
                const at = Number(stamp[1]) * 60 + Number(stamp[2]) + Number(stamp[3]) / 1000;
                assert.ok(at <= part.durationSeconds - 1,
                    `${entry.id}/${part.label} leaves ${stamp[0]} time to render inside ${part.durationSeconds}s`);
            }
            // The Seedance/LTX variants write their beats as MM:SS–MM:SS ranges.
            for (const range of part.prompt.matchAll(/(\d{2}):(\d{2})[–-](\d{2}):(\d{2})/g)) {
                const end = Number(range[3]) * 60 + Number(range[4]);
                assert.ok(end <= part.durationSeconds,
                    `${entry.id}/${part.label} ends ${range[0]} inside ${part.durationSeconds}s`);
            }
        }
    }
});

test('the menu lines name the model, the length, the split and the part', async () => {
    const { DEFAULT_PROMPTS, describeDefaultPrompt, describeDefaultPromptPart } = await import('../src/lib/defaultPrompts.js');
    const h3 = DEFAULT_PROMPTS.find((entry) => entry.id === 'korean-home-video-h3');
    const seedance25 = DEFAULT_PROMPTS.find((entry) => entry.id === 'korean-home-video-seedance-25');
    assert.equal(describeDefaultPrompt(h3), 'MiniMax H3 · 30s in 2 parts · Same six beats in H3 three-field format');
    assert.equal(describeDefaultPrompt(seedance25), 'Seedance 2.5 · 30s · Candid early-2000s camcorder day, six beats');
    assert.equal(describeDefaultPromptPart(h3.parts[1], 1), 'Part 2 · Beats 4-6 · 15s');
});

test('Seedance 2.5 is in the catalog and reaches 30s in one generation', async () => {
    const { t2vModels, i2vModels, getDurationsForModel, getVideoModelById } = await import('../src/lib/modelsData.js');
    // Endpoints confirmed against the live MUAPI catalog 2026-08-11.
    for (const id of ['seedance-2.5-text-to-video', 'seedance-2.5-text-to-video-480p']) {
        const model = t2vModels.find((entry) => entry.id === id);
        assert.ok(model, `${id} listed for text-to-video`);
        assert.equal(model.endpoint, id, `${id} posts to its own endpoint`);
        // A duration RANGE would collapse to the default alone in the picker.
        assert.deepEqual(getDurationsForModel(id), [5, 10, 15, 20, 25, 30]);
        assert.ok(model.inputs.aspect_ratio.enum.includes('9:16'), `${id} offers vertical`);
    }
    for (const id of ['seedance-2.5-image-to-video', 'seedance-2.5-image-to-video-480p']) {
        const model = i2vModels.find((entry) => entry.id === id);
        assert.ok(model, `${id} listed for image-to-video`);
        assert.equal(model.imageField, 'image_url', `${id} takes a single start image`);
        assert.deepEqual(model.inputs.duration.enum, [5, 10, 15, 20, 25, 30]);
    }
    // The 2.0 tier it sits beside is unchanged and still capped at 15s.
    assert.deepEqual(getDurationsForModel('seedance-v2.0-t2v'), [5, 10, 15]);
    assert.equal(getVideoModelById('seedance-2.5-text-to-video').name, 'Seedance 2.5');

    // Attaching a start frame switches to the i2v model sharing the t2v's
    // `family`, falling back to the first i2v in the catalog when none matches.
    // Each 2.5 tier must therefore pair with its OWN i2v, or the cheap tier
    // would jump to the one that costs twice as much.
    for (const [t2v, i2v] of [
        ['seedance-2.5-text-to-video', 'seedance-2.5-image-to-video'],
        ['seedance-2.5-text-to-video-480p', 'seedance-2.5-image-to-video-480p'],
    ]) {
        const family = t2vModels.find((entry) => entry.id === t2v).family;
        const siblings = i2vModels.filter((entry) => entry.family === family);
        assert.equal(siblings.length, 1, `${family} pairs with exactly one i2v model`);
        assert.equal(siblings[0].id, i2v);
    }
});
