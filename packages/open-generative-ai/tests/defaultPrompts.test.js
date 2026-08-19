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

test('an idea is split at each model\'s own ceiling, and every variant adds back up', async () => {
    const { DEFAULT_PROMPTS, defaultPromptTotalSeconds } = await import('../src/lib/defaultPrompts.js');
    // What the studio will actually offer as a duration, per family: H3 goes to
    // 15s and other local workflows to 10s (hivemindStudio.js), Seedance 2.0 caps
    // its enum at 15, and only Seedance 2.5 reaches 30.
    const CEILING = { 'seedance-2.5': 30, seedance: 15, minimax: 15, ltx: 10 };

    const ideas = new Map();
    for (const entry of DEFAULT_PROMPTS) {
        if (!ideas.has(entry.idea)) ideas.set(entry.idea, []);
        ideas.get(entry.idea).push(entry);
    }

    for (const [idea, variants] of ideas) {
        // Every variant of one idea tells the same length of story — the split
        // is a property of the model, never of the story.
        const lengths = new Set(variants.map(defaultPromptTotalSeconds));
        assert.equal(lengths.size, 1, `${idea} runs the same length on every model (${[...lengths]})`);
        for (const entry of variants) {
            for (const part of entry.parts) {
                assert.ok(part.durationSeconds <= CEILING[entry.family],
                    `${entry.id} keeps every part inside the ${entry.family} ceiling`);
            }
            // Every part after the first is a continuation, and says how to reach it.
            entry.parts.forEach((part, index) => {
                if (index === 0) return;
                assert.ok(part.continuation, `${entry.id} part ${index + 1} is marked a continuation`);
                assert.ok(part.note, `${entry.id} part ${index + 1} says how to arm it`);
            });
        }
    }

    // The two 30s ideas prove the point in both directions: one generation on
    // 2.5, several everywhere else.
    const vlog = Object.fromEntries(ideas.get('travel-vlog').map((entry) => [entry.family, entry]));
    assert.equal(vlog['seedance-2.5'].parts.length, 1);
    assert.equal(vlog.minimax.parts.length, 2);
});

test('continuations re-describe the scene instead of assuming it', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    // A prompt that stops naming the subject makes the model cut to an unrelated
    // take — the failure chainPrompt.js exists to prevent. Measured as shared
    // DISTINCTIVE vocabulary rather than a keyword list, because what has to
    // carry over differs per scene (wardrobe and camcorder in one, subject
    // definitions and reference labels in another) and a hard-coded list only
    // ever describes the entry it was written against. The real entries score
    // 16-91; a continuation that merely says "she keeps walking" scores ~0.
    const distinctive = (text) => new Set(text.toLowerCase().match(/[a-z]{7,}/g) || []);
    for (const entry of DEFAULT_PROMPTS) {
        if (entry.parts.length < 2) continue;
        const opening = distinctive(entry.parts[0].prompt);
        for (const part of entry.parts.slice(1)) {
            const shared = [...distinctive(part.prompt)].filter((word) => opening.has(word));
            assert.ok(shared.length >= 12,
                `${entry.id}/${part.label} carries the established scene forward (shared ${shared.length})`);
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
            assert.match(prompt, /<(Picture|Video|Audio) 1>/, `${where} cites at least one attached reference`);
            // Retention markers come from the label's own family — audio from the
            // copy family, everything else from the preserved family. Only the
            // labels a prompt actually uses are required to carry one.
            const PRESERVED = '(fully_preserved|partially_preserved|attribute_transfer|weak_reference)';
            for (const kind of ['Picture', 'Video', 'Subject']) {
                if (!prompt.includes(`<${kind} 1>`)) continue;
                assert.match(prompt, new RegExp(`<${kind} 1>: ${PRESERVED}\\b`),
                    `${where} marks its ${kind.toLowerCase()} with a preserved-family marker`);
            }
            if (prompt.includes('<Audio 1>')) {
                assert.match(prompt, /<Audio 1>: (fully_copy|partially_copy|reference|weak_reference)\b/,
                    `${where} marks its audio with a copy-family marker`);
                // The task-type marker is what selects reuse over timbre-only, and
                // it only exists when audio is attached.
                assert.match(prompt, /\[audio (reuse|reference)\]/, `${where} declares its audio task type`);
            }
            // Whatever the brief needs from the user stays a hole, and nothing
            // from the original example is baked back in.
            assert.match(prompt, /\[[A-Z][^\]]*\]/, `${where} keeps its fill-ins`);
            assert.doesNotMatch(prompt, /castlevania|alucard|sypha/i, `${where} names no specific show`);
            if (entry.idea === 'screen-reaction') {
                assert.match(prompt, /\[SHOW NAME\]/, `${where} keeps the show a fill-in`);
            }
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
            // The Seedance variants write their beats as ranges, in two styles:
            // MM:SS–MM:SS and plain 12–20s. Both are timelines the model reads,
            // so both are checked against the length the part will be generated at.
            for (const range of part.prompt.matchAll(/(\d{2}):(\d{2})[–-](\d{2}):(\d{2})/g)) {
                const end = Number(range[3]) * 60 + Number(range[4]);
                assert.ok(end <= part.durationSeconds,
                    `${entry.id}/${part.label} ends ${range[0]} inside ${part.durationSeconds}s`);
            }
            for (const range of part.prompt.matchAll(/\b(\d{1,2})\s*[–—-]\s*(\d{1,2})\s*s\b/g)) {
                assert.ok(Number(range[2]) <= part.durationSeconds,
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

    // Omni Reference takes identity pictures rather than a first frame, so it
    // is a picture LIST and must stay off the start-frame switch below.
    const omni = i2vModels.find((entry) => entry.id === 'seedance-2.5-omni-reference');
    assert.ok(omni, 'omni reference listed for image-to-video');
    assert.equal(omni.imageField, 'images_list');
    assert.ok(omni.maxImages > 1, 'omni reference takes several pictures');
    assert.deepEqual(omni.inputs.duration.enum, [5, 10, 15, 20, 25, 30]);

    // Attaching a start frame switches to the i2v model sharing the t2v's
    // `family`, falling back to the first i2v in the catalog when none matches.
    // Each 2.5 tier must therefore pair with its OWN i2v, or the cheap tier
    // would jump to the one that costs twice as much — and never onto Omni,
    // whose pictures are not a first frame.
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


// The two-fighter starter carries a rule per failed take (2026-08-12/13). They
// read like ordinary prose, so without this an edit "tidying" any one of them
// would silently reintroduce a bug that cost a 14-minute render to find.
test('the fight starter keeps every rule it was bought with', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const entry = DEFAULT_PROMPTS.find((item) => item.id === 'fight-cast-h3');
    assert.ok(entry, 'the fight starter ships');
    const prompt = entry.parts[0].prompt;

    // The subject who owns the voice reference speaks FIRST, so subject and
    // speaker numbering agree. Crossing them swapped the fighters' lines.
    assert.match(prompt, /<Subject 1> speaks as S1\./);
    assert.match(prompt, /<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)\./);
    assert.match(prompt, /not the voice of any other subject/);
    const firstLine = prompt.indexOf('<Subject 1> (S1) says:');
    const secondLine = prompt.indexOf('<Subject 2> (S2) says:');
    assert.ok(firstLine > 0 && secondLine > firstLine, 'the voice owner speaks first');

    // A punch that never retracts follows its target around the frame.
    assert.match(prompt, /rebounds off <Subject 2> and snaps all the way back to guard/);
    assert.match(prompt, /does not stay on <Subject 2>/);
    // A gap between impact and reaction reads as the loser standing still.
    assert.match(prompt, /recoil begins on the very frame of contact with NO pause/);
    // A known character brings its default expression unless told otherwise.
    assert.match(prompt, /NOT smiling and NOT grinning/);
    // Naming a voice is not enough when the model cannot retrieve it.
    assert.match(prompt, /in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny/);
    assert.match(prompt, /voice is high-pitched, nasal, squeaky and childlike/);
    assert.match(prompt, /never deep, gravelly or adult-sounding/);

    // Character noises live in a beat, where a speaker id reaches them. The
    // soundscape is physical sound only — an exhale written there came back as
    // a generic old man over a cartoon.
    const soundscape = prompt.split('overall_soundscape:\n')[1].split('\n\n')[0];
    assert.doesNotMatch(soundscape, /\b(exhale|grunt|gasp|breath|laugh|yelp|scream)/i);

    // Every timed beat lands inside the 8s the starter declares.
    const seconds = [...prompt.matchAll(/At (\d{2}):(\d{2})\.(\d{3})/g)]
        .map((m) => Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000);
    assert.ok(seconds.length >= 5, 'the shot is written as timed beats');
    assert.ok(Math.max(...seconds) < entry.parts[0].durationSeconds,
        'no beat is stamped at or past the end of the clip');

    // Generalized: no trace of the person it was developed against.
    assert.doesNotMatch(prompt, /cheryl/i);
    assert.doesNotMatch(prompt, /\b(she|her|hers|he|him|his)\b/i,
        'pronouns are replaced by <Subject N>, which is both generic and what H3 asks for');
});

// The versus starter is the only one whose ENVIRONMENT is a reference too, and
// the only one with a voice nobody on screen owns. Both are easy to "tidy" back
// into the shape the brief arrived in, which is the shape that fails.
test('the versus starter keeps the arena and the announcer bound to labels', async () => {
    const { DEFAULT_PROMPTS } = await import('../src/lib/defaultPrompts.js');
    const entry = DEFAULT_PROMPTS.find((item) => item.id === 'versus-fight-h3');
    assert.ok(entry, 'the versus starter ships');
    const prompt = entry.parts[0].prompt;

    // Each attachment is claimed by a subject, in the order the user attaches
    // them — the arena included, because a place with no retention marker is
    // redecorated on the first shot change.
    assert.match(prompt, /<Subject 1> is the fighter shown in <Picture 1>/);
    assert.match(prompt, /<Subject 2> is the fighter shown in <Picture 2>/);
    assert.match(prompt, /<Subject 3> is the fighting arena shown in <Picture 3>/);
    assert.match(prompt, /<Subject 3>: fully_preserved/);

    // An unbound voice comes back as a generic read, so the announcer is a
    // subject with a speaker id and every line is spoken by that id.
    assert.match(prompt, /<Subject 4> is an off-screen arcade announcer[^\n]*speaks as S1/);
    for (const line of prompt.matchAll(/([^\n]{0,40})<d>/g)) {
        assert.match(line[1], /\(S1\) says: $/, 'every spoken line carries the announcer id');
    }
    // Non-verbal human sound in the soundscape has no id to carry it either.
    const soundscape = prompt.split('overall_soundscape:\n')[1].split('\n\n')[0];
    assert.doesNotMatch(soundscape, /\b(exhale|grunt|gasp|breath|laugh|yelp|scream|announcer|voice)/i);

    // The HUD is an overlay, or the health bars are built into the arena.
    assert.match(prompt, /composited ON TOP of the photographic image/);
    // A fist that never retracts follows its target around the frame.
    assert.match(prompt, /rebounds instantly back to guard/);
});
