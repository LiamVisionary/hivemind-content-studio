const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// MiniMax H3 quality controls: the 15s duration ceiling, the refinement-steps
// preset gate, and the family helper they both hang off. The measured facts
// behind them (15s identity ceiling, 0.8-1.0MP quality knee, 30-32 step
// motion/audio gain) live in the workflow registry + server tiers; these tests
// pin the client-side plumbing that surfaces them.

function stubBrowserGlobals() {
    const originals = {
        window: global.window,
        localStorage: global.localStorage,
        sessionStorage: global.sessionStorage,
    };
    const eventTarget = new EventTarget();
    eventTarget.location = { search: '?hivemindStudio=1', origin: 'https://studio.test' };
    eventTarget.parent = { postMessage() {} };
    global.window = eventTarget;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    return () => {
        global.window = originals.window;
        global.localStorage = originals.localStorage;
        global.sessionStorage = originals.sessionStorage;
    };
}

function catalogWith(models) {
    return {
        ok: true,
        media: { video: [{ id: 'media-studio-mcp', label: 'Media Studio', available: true, detail: 'ready', models }] },
    };
}

test('minimax workflows get the 15s duration ceiling; other families keep 10s', async () => {
    const restore = stubBrowserGlobals();
    try {
        const studio = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=minimax-durations`);
        const [h3, ltx] = studio.mapHivemindWorkflowModels(catalogWith([
            { id: 'minimax-h3', label: 'MiniMax H3', family: 'minimax', accepts: ['prompt', 'steps', 'spectrum'], defaults: {}, default_duration_seconds: 5, default_steps: 15 },
            { id: 'ltx23-eros-fast', label: 'LTX 2.3 Eros Fast', family: 'ltx-2.3', accepts: ['prompt'], default_duration_seconds: 4 },
        ]));
        assert.equal(h3.durations.length, 15);
        assert.equal(h3.durations[h3.durations.length - 1], 15);
        assert.deepEqual(ltx.durations, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        // The registered step default reaches the client so the refinement
        // presets can be labeled truthfully and turbo lanes excluded.
        assert.equal(h3.defaultSteps, 15);
        assert.equal(ltx.defaultSteps, null);
    } finally {
        restore();
    }
});

test('isMinimaxFamilyModel follows the registry family with an id fallback', async () => {
    const restore = stubBrowserGlobals();
    try {
        const tasks = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/videoTasks.js')).href}?test=minimax-family`);
        assert.equal(tasks.isMinimaxFamilyModel({ modelFamily: 'minimax', modelId: 'hivemind-media:minimax-h3' }), true);
        assert.equal(tasks.isMinimaxFamilyModel({ modelFamily: 'ltx-2.3', modelId: 'hivemind-media:ltx23-eros-fast' }), false);
        // Setups persisted before modelFamily existed fall back to the id.
        assert.equal(tasks.isMinimaxFamilyModel({ modelId: 'hivemind-media:minimax-h3-turbo' }), true);
        assert.equal(tasks.isMinimaxFamilyModel({ modelId: 'hivemind-media:ltx23-eros-fast' }), false);
    } finally {
        restore();
    }
});

test('refinement steps stay gated on a full-step lane end to end', async () => {
    // The capability needs BOTH a registry-mapped steps slot and a full-step
    // default — a distilled turbo build (4-8 steps) must never get the 32-step
    // preset bolted on. Derived in ONE place (the registry mapper), so assert it
    // there, against real workflow shapes rather than against source text.
    const restore = stubBrowserGlobals();
    try {
        const studio = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=steps-gate`);
        const map = (workflows) => studio.mapHivemindWorkflowModels({
            media: { video: [{ id: 'media-studio-mcp', label: 'Media Studio', available: true, models: workflows }] },
        });
        const [full, turbo, noSlot] = map([
            { id: 'minimax-h3', label: 'MiniMax H3', family: 'minimax', accepts: ['steps'], default_steps: 15 },
            { id: 'minimax-h3-turbo', label: 'Turbo', family: 'minimax', accepts: ['steps'], default_steps: 6 },
            { id: 'ltx23-eros-fast', label: 'LTX', family: 'ltx-2.3', accepts: [], default_steps: 30 },
        ]);
        assert.equal(full.supportsQualitySteps, true);
        assert.equal(turbo.supportsQualitySteps, false, 'a distilled lane gets no 32-step override');
        assert.equal(noSlot.supportsQualitySteps, false, 'no registry steps slot, no control');
    } finally {
        restore();
    }

    const videoLogic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.js'), 'utf8');
    // The studio must READ that derivation, never restate it: a second copy of
    // the rule is how the two ended up able to disagree.
    assert.doesNotMatch(videoLogic, /accepts\.includes\('steps'\)/);
    const videoStudio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // The request only carries steps when the SELECTED model passes that gate,
    // so a preference saved on H3 cannot leak into a turbo or LTX graph.
    assert.match(videoStudio, /supportsQualitySteps\(currentModel\(setup, s\.catalogs\)\)/);
});

test('fast high-res is derived from the registry and survives a reload', async () => {
    // The two-pass latent upscale needs an upscaler node on the executing lane,
    // so the switch is registry-gated like every other capability: derived once
    // from `accepts`, read verbatim downstream.
    const restore = stubBrowserGlobals();
    try {
        const studio = await import(`${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=fast-high-res`);
        const [base, reference, ltx] = studio.mapHivemindWorkflowModels({
            media: { video: [{ id: 'media-studio-mcp', label: 'Media Studio', available: true, models: [
                { id: 'minimax-h3', label: 'MiniMax H3', family: 'minimax', accepts: ['steps', 'fast_high_res'] },
                { id: 'minimax-h3-reference', label: 'Reference', family: 'minimax', accepts: ['steps', 'reference_images'] },
                { id: 'ltx23-eros-fast', label: 'LTX', family: 'ltx-2.3', accepts: ['steps'] },
            ] }] },
        });
        assert.equal(base.supportsFastHighRes, true);
        assert.equal(reference.supportsFastHighRes, false, 'the reference lane conditions through a different node');
        assert.equal(ltx.supportsFastHighRes, false);
    } finally {
        restore();
    }

    const videoLogic = fs.readFileSync(path.join(__dirname, '../src/studios/video/videoLogic.js'), 'utf8');
    assert.doesNotMatch(videoLogic, /accepts\.includes\('fast_high_res'\)/, 'the rule lives in the registry mapper only');
    const videoStudio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // Gated on the SELECTED model, so a preference left on from H3 cannot ride
    // along into a graph with no upscaler to compile.
    assert.match(videoStudio, /supportsFastHighRes\(currentModel\(setup, s\.catalogs\)\)/);

    // A speed/quality preference, so it persists — and only as a real boolean.
    const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
    const fast = (value) => normalizeVideoPreferences({ modelId: 'hivemind-media:minimax-h3', fastHighRes: value }).fastHighRes;
    assert.equal(fast(true), true);
    assert.equal(fast(false), false);
    assert.equal(fast(undefined), false, 'off unless it was explicitly turned on');
    assert.equal(fast('true'), false, 'a string is not a choice');
});


test('the persisted steps override round-trips within sane bounds', async () => {
    const { normalizeVideoPreferences } = await import('../src/lib/videoPreferences.js');
    const steps = (value) => normalizeVideoPreferences({ modelId: 'hivemind-media:minimax-h3', steps: value }).steps;
    assert.equal(steps(32), 32);
    assert.equal(steps(15.6), 16, 'rounded to a whole sampler step');
    assert.equal(steps(0), null, 'out of range falls back to the workflow default');
    assert.equal(steps(101), null);
    assert.equal(steps('32'), null, 'a string is not a step count');
    assert.equal(steps(undefined), null);
});

// A motion reference (a reference VIDEO) is trimmed to the generated clip's own
// length, so its cost grows with the clip and rides every sampling step, while
// reference PICTURES cost a flat amount however long the clip is. Measured at
// 36x per frame on a rented 5090, which turns H3's honest 15s range into under
// 6s the moment a motion clip is attached. The studio used to offer all 15
// anyway: the run was accepted, staged its references, and died minutes later
// on a CUDA allocator dump that reached the browser as a bare MediaStudioError.
// A motion reference (a reference VIDEO) is trimmed to the generated clip's own
// length, so its cost grows with the clip and rides every sampling step, while
// reference PICTURES cost a flat amount however long the clip is. Measured at
// 36x per frame on a rented 5090, which turns H3's honest 15s range into under
// 6s the moment a motion clip is attached. The studio used to offer all 15
// anyway: the run was accepted, staged its references, and died minutes later
// on a CUDA allocator dump that reached the browser as a bare MediaStudioError.
//
// The ceiling is computed server-side from the registry budget and the tier
// tables, then published per canvas. videoLogic must read it through the SAME
// module instance that holds the loaded context, so the studio and the guard
// quote one number.
test('a motion reference caps the duration range at the measured ceiling', async () => {
    const restore = stubBrowserGlobals();
    const originalFetch = global.fetch;
    const response = (ok, body) => ({ ok, json: async () => body });
    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return response(true, { prompts: [] });
        return response(true, catalogWith([
            {
                id: 'minimax-h3',
                label: 'MiniMax H3',
                family: 'minimax',
                accepts: ['prompt'],
                defaults: {},
                aspect_ratios: ['9:16', '16:9'],
                default_duration_seconds: 5,
                // Server-computed from the registry budget and the tier tables.
                motion_reference_max_seconds: { 'high|9:16': 10.125, 'max|9:16': 8.0, 'standard|9:16': 25.0 },
            },
            { id: 'minimax-h3-turbo', label: 'Turbo', family: 'minimax', accepts: ['prompt'], defaults: {}, aspect_ratios: ['9:16'] },
        ]));
    };
    try {
        // No ?test= query: videoLogic imports hivemindStudio itself, and a
        // second module instance would hold an empty context.
        const studio = await import('../src/lib/hivemindStudio.js');
        const logic = await import('../src/studios/video/videoLogic.js');
        const context = await studio.loadHivemindStudioContext({ refresh: true });
        const [h3, turbo] = context.videoModels;
        assert.equal(h3.motionReferenceMaxSeconds['high|9:16'], 10.125, 'the capability reaches the client');
        assert.equal(turbo.motionReferenceMaxSeconds, null, 'no measured budget, no capability');

        const setup = (extra) => ({ modelId: h3.id, ar: '9:16', resolution: 'High', duration: 15, referenceVideos: [], ...extra });
        const clip = (seconds) => ({ url: `blob:motion-${seconds}`, durationSeconds: seconds });

        // No motion reference: the full range, untouched.
        assert.equal(logic.motionReferenceLimitFor(setup(), h3.id), null);
        assert.equal(logic.availableDurationsFor(setup(), h3.id).length, 15);

        // A SHORT reference keeps its own length, so it costs only that and the
        // whole range stays open. This is the case the first rule got wrong: it
        // capped the clip whenever any reference was attached, so dropping in a
        // 2s clip still pinned the slider.
        const short = setup({ referenceVideos: [clip(2)] });
        assert.equal(logic.motionReferenceLimitFor(short, h3.id), null);
        assert.equal(logic.availableDurationsFor(short, h3.id).length, 15);
        assert.equal(logic.clampDurationToMotionReference(short, h3.id), 15);

        // A reference at or beyond the clip's length is trimmed down to it, so
        // the CLIP becomes the thing that has to fit: 11s and up stop being
        // offered against the 10.125s ceiling.
        const long = setup({ referenceVideos: [clip(15)] });
        assert.equal(logic.motionReferenceLimitFor(long, h3.id).maxSeconds, 10.125);
        assert.deepEqual(logic.availableDurationsFor(long, h3.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.equal(logic.clampDurationToMotionReference(long, h3.id), 10);
        assert.equal(logic.clampDurationToMotionReference({ ...long, duration: 3 }, h3.id), 3);

        // The LONGEST attached reference decides — a short one alongside it
        // cannot buy back the range.
        const mixed = setup({ referenceVideos: [clip(2), clip(15)] });
        assert.equal(logic.motionReferenceLimitFor(mixed, h3.id).maxSeconds, 10.125);

        // An UNMEASURED reference counts as long, matching the gateway: guessing
        // it short would offer a length the run then refuses.
        const unmeasured = setup({ referenceVideos: [{ url: 'blob:unmeasured' }] });
        assert.equal(logic.motionReferenceLimitFor(unmeasured, h3.id).maxSeconds, 10.125);

        // A reference PICTURE costs the same whatever the length, so it must
        // never narrow anything: only videos carry the per-frame cost.
        assert.equal(logic.motionReferenceLimitFor(setup({ referenceImageUrls: ['blob:pic'] }), h3.id), null);

        // The ceiling follows the canvas: the native tier costs more per frame.
        assert.deepEqual(logic.availableDurationsFor({ ...long, resolution: 'Max' }, h3.id), [1, 2, 3, 4, 5, 6, 7, 8]);
        // An unset resolution must resolve the way the SERVER resolves it
        // (standard), or the studio would quote a ceiling from a canvas the run
        // will not actually use.
        assert.equal(logic.motionReferenceLimitFor({ ...long, resolution: '' }, h3.id), null,
            'the standard tier carries 25s of reference, so a 15s clip needs no cap');

        // An unmeasured workflow keeps the full range: not knowing the ceiling
        // is not the same as knowing the run cannot happen.
        const onTurbo = { modelId: turbo.id, ar: '9:16', resolution: 'High', duration: 12, referenceVideos: [clip(15)] };
        assert.equal(logic.motionReferenceLimitFor(onTurbo, turbo.id), null);
        assert.equal(logic.availableDurationsFor(onTurbo, turbo.id).length, 15);
    } finally {
        global.fetch = originalFetch;
        restore();
    }

    const videoStudio = fs.readFileSync(path.join(__dirname, '../src/studios/VideoStudio.jsx'), 'utf8');
    // The slider's ceiling is the FILTERED list, so an impossible length is not
    // merely discouraged — it cannot be expressed.
    assert.match(videoStudio, /const durationOptions = availableDurationsFor\(/);
    // Attaching a reference re-clamps: the setup funnel, plus the four writes
    // that bypass it — a hand-attached clip, a cast that brings its own, the
    // effect that measures a clip's duration, and a member chip's "+ clip"
    // batch. The measuring one matters in the other direction: learning a
    // reference is SHORT has to give the range back.
    assert.match(videoStudio, /s\.setup = withDurationThatFits\(nextSetup\)/);
    assert.equal((videoStudio.match(/withDurationThatFits\(\{/g) || []).length, 4, 'every non-commit setup write re-clamps');
});

// The published per-canvas ceiling assumes the worst of everything (a reference
// as long as the clip at the node's largest canvas, nine pictures, the full
// voice allowance, soundtrack on) — right for refusing an impossible run, wrong
// for the slider once the user has done the things that make a run fit. When
// the catalog publishes the pricing inputs, the picker prices THIS setup with
// the guard's arithmetic. Measured 2026-08-22: Liam's real job (7 pictures,
// 13.3s phone clip at the full canvas, sound on) is ~144k rows against 85k, and
// the same clip staged compact, trimmed to 6s, sound off, 3 pictures is ~82k —
// it renders at 10s; the old slider still said 5.
test('with pricing published the picker prices the actual attachments, and Compact lifts the ceiling', async () => {
    const restore = stubBrowserGlobals();
    const originalFetch = global.fetch;
    const response = (ok, body) => ({ ok, json: async () => body });
    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return response(true, { prompts: [] });
        return response(true, catalogWith([
            {
                id: 'minimax-h3',
                label: 'MiniMax H3',
                family: 'minimax',
                accepts: ['prompt'],
                defaults: {},
                aspect_ratios: ['16:9', '9:16'],
                default_duration_seconds: 5,
                motion_reference_max_seconds: { 'high|16:9': 5.167, 'high|9:16': 5.167 },
                motion_reference_pricing: {
                    max_packed_rows: 85000,
                    max_packed_rows_by_vram_gb: { '32': 85000, '96': 215000 },
                    frame_grid: { modulus: 17, offset: 5 },
                    frame_rate: 24,
                    output_rows_per_latent_frame: { 'high|16:9': 836, 'high|9:16': 836, 'standard|16:9': 336 },
                    reference_rows_per_latent_frame: { full: 1056, compact: 432 },
                    audio_rows_per_second: 80,
                    reference_video_max_seconds: 15,
                    reference_audio_max_seconds: 15,
                    reference_picture_slots: 9,
                },
            },
        ]));
    };
    try {
        const studio = await import('../src/lib/hivemindStudio.js');
        const logic = await import('../src/studios/video/videoLogic.js');
        const context = await studio.loadHivemindStudioContext({ refresh: true });
        const [h3] = context.videoModels;
        assert.equal(h3.motionReferencePricing.max_packed_rows, 85000, 'the pricing reaches the client');

        const pictures = (n) => Array.from({ length: n }, (_, i) => `blob:pic-${i}`);
        const setup = (extra) => ({ modelId: h3.id, ar: '16:9', resolution: 'High', duration: 15, referenceVideos: [], referenceImageUrls: [], referenceAudios: [], ...extra });

        // No motion clip, but seven pictures still cost rows: at 15s the OUTPUT
        // alone is 90,658 of the 85,000 budget, so the range has to narrow.
        // This assertion used to read `null` — "nothing to price, the full range
        // stays" — and it is what let Liam send a 15s clip with 7 pictures and
        // the motion clip's soundtrack (its picture switched off) to a 5090 on
        // 2026-08-22, where it died at 23.90 + 5.24 GiB of 31.36.
        const picturesOnly = setup({ referenceImageUrls: pictures(7) });
        assert.equal(logic.motionReferencePackedRows(picturesOnly, h3.id, 15), 96510);
        const picturesLimit = logic.motionReferenceLimitFor(picturesOnly, h3.id);
        assert.equal(picturesLimit.maxSeconds, 12);
        assert.equal(picturesLimit.referenceVideoCount, 0);
        assert.equal(picturesLimit.referencePictureCount, 7);

        // Nothing attached at all keeps the whole range: a plain 15s render is
        // 90,658 rows and was measured to run.
        assert.equal(logic.motionReferenceLimitFor(setup(), h3.id), null);

        // Liam's job as sent: 7 pictures, the 13.3s clip at the full canvas, soundtrack on.
        const asSent = setup({ referenceImageUrls: pictures(7), referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, useAudio: true }] });
        assert.equal(logic.motionReferencePackedRows(asSent, h3.id, 5), 77334);
        assert.equal(logic.motionReferencePackedRows(asSent, h3.id, 6), 96366);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id).maxSeconds, 5);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id).priced, true);

        // The same clip staged compact, trimmed to 6s, soundtrack off, three pictures: 10s fits, 11 does not.
        const compact = setup({ referenceImageUrls: pictures(3), referenceVideos: [{ url: 'blob:phone', durationSeconds: 6, useAudio: false, compact: true }] });
        assert.equal(logic.motionReferencePackedRows(compact, h3.id, 10), 81654);
        assert.equal(logic.motionReferencePackedRows(compact, h3.id, 11), 90128);
        assert.equal(logic.motionReferenceLimitFor(compact, h3.id).maxSeconds, 10);
        assert.deepEqual(logic.availableDurationsFor(compact, h3.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        assert.equal(logic.clampDurationToMotionReference(compact, h3.id), 10);

        // Compact but the whole 13.3s clip: 8s is the lattice point that still fits.
        const compactLong = setup({ referenceImageUrls: pictures(3), referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, useAudio: false, compact: true }] });
        assert.equal(logic.motionReferenceLimitFor(compactLong, h3.id).maxSeconds, 8);

        // A motion row switched to SOUND ONLY is a voice clip to the card: no
        // frames, so it costs far less than the same clip as motion — but it is
        // NOT free, and neither are the pictures beside it. This block used to
        // assert `null` ("leaves the full range open"), which is exactly the
        // shape Liam sent on 2026-08-22: 15s, 7 pictures, the phone clip's
        // picture switched off and its audio kept. It OOM'd on a 5090 at
        // 23.90 + 5.24 GiB — 98,116 rows including text, against 85,000.
        const soundOnly = setup({ referenceImageUrls: pictures(7), referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, motion: false, useAudio: true }] });
        const voiceClip = setup({ referenceImageUrls: pictures(7), referenceAudios: [{ url: 'blob:voice', durationSeconds: 13.3 }] });
        assert.equal(logic.motionReferencePackedRows(soundOnly, h3.id, 15), logic.motionReferencePackedRows(voiceClip, h3.id, 15));
        assert.ok(logic.motionReferencePackedRows(soundOnly, h3.id, 15) < logic.motionReferencePackedRows(asSent, h3.id, 15));
        // 90,658 clip + 5,852 pictures + 1,064 soundtrack = 97,574 at 15s.
        assert.equal(logic.motionReferencePackedRows(soundOnly, h3.id, 15), 97574);
        const soundLimit = logic.motionReferenceLimitFor(soundOnly, h3.id);
        assert.equal(soundLimit.maxSeconds, 12, 'the clip is what has to give');
        assert.equal(soundLimit.referenceVideoCount, 0);
        assert.equal(soundLimit.referenceSoundCount, 1);
        assert.equal(soundLimit.referencePictureCount, 7);

        // Compact is held to "full" with no picture attached — the clip is then the
        // character reference and identity needs pixels — so it prices at the full canvas.
        const identityClip = setup({ referenceImageUrls: [], referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, useAudio: false, compact: true }] });
        const withPics = setup({ referenceImageUrls: pictures(1), referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, useAudio: false, compact: true }] });
        assert.ok(logic.motionReferencePackedRows(identityClip, h3.id, 8) > logic.motionReferencePackedRows(withPics, h3.id, 8));

        // The budget is a property of the CARD: the catalog publishes it per card
        // size, the studio already knows which machine a run lands on (this tab's
        // "Run on" pin when Rented is on, else the routing leader among the
        // attached rentals — the gateway's own first-match rule), and the picker
        // prices against THAT card. Liam's as-sent job is capped at 5s on the
        // 5090 and not at all when a 96 GB RTX PRO 6000 leads; an unlisted or
        // unknown card keeps the measured base rather than assuming bigger.
        const pro6000 = { rental_id: 'vast:52', attached: true, priority: 9, models_served: ['minimax_h3'], gpu: 'RTX PRO 6000 WS', vram_gb: 96 };
        const rtx5090 = { rental_id: 'vast:48', attached: true, priority: 1, models_served: ['minimax_h3'], gpu: 'RTX 5090', vram_gb: 32 };
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, [pro6000, rtx5090]), null, 'the PRO 6000 leads: no cap');
        assert.equal(logic.availableDurationsFor(asSent, h3.id, [pro6000, rtx5090]).length, 15);
        assert.equal(logic.clampDurationToMotionReference(asSent, h3.id, [pro6000, rtx5090]), 15);
        const leader5090 = [{ ...pro6000, priority: 0 }, { ...rtx5090, priority: 9 }];
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, leader5090).maxSeconds, 5, 'the 5090 leads: the 32 GB ceiling');
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, leader5090).cardVramGb, 32);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, leader5090).machine.rentalId, 'vast:48');
        // This tab's pin beats the server order; a pin on a machine that is not
        // attached is inert and the leader decides.
        assert.equal(logic.motionReferenceLimitFor({ ...asSent, rentedOnly: true, rentedMachineId: 'vast:52' }, h3.id, leader5090), null);
        assert.equal(logic.motionReferenceLimitFor({ ...asSent, rentedOnly: true, rentedMachineId: 'vast:gone' }, h3.id, leader5090).maxSeconds, 5);
        // A card the table does not list keeps the base; no machines known is
        // exactly the old behaviour.
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, [{ ...pro6000, vram_gb: 24 }]).maxSeconds, 5);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, [{ ...pro6000, vram_gb: 24 }]).cardVramGb, null);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, []).maxSeconds, 5);
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id).maxSeconds, 5);
        // A machine that serves other models only is not the leader for H3.
        assert.equal(logic.motionReferenceLimitFor(asSent, h3.id, [{ ...pro6000, models_served: ['ltx23'] }]).maxSeconds, 5);
        // The table lookup itself: a card reports a little under its size.
        assert.deepEqual(logic.motionReferenceBudgetRows(h3.motionReferencePricing, 94.97), { rows: 215000, vramGb: 96 });
        assert.deepEqual(logic.motionReferenceBudgetRows(h3.motionReferencePricing, 31.36), { rows: 85000, vramGb: 32 });
        assert.deepEqual(logic.motionReferenceBudgetRows(h3.motionReferencePricing, 24), { rows: 85000, vramGb: null });
        assert.deepEqual(logic.motionReferenceBudgetRows(h3.motionReferencePricing, null), { rows: 85000, vramGb: null });

        // An unknown canvas (a tier|aspect the pricing does not list) falls back to
        // the published ceiling rather than guessing.
        const unknownCanvas = setup({ ar: '4:3', referenceImageUrls: pictures(3), referenceVideos: [{ url: 'blob:phone', durationSeconds: 13.3, compact: true }] });
        assert.equal(logic.motionReferenceLimitFor(unknownCanvas, h3.id), null, 'no published ceiling for that canvas either');
    } finally {
        global.fetch = originalFetch;
        restore();
    }
});
