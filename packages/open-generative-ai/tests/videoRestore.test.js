// The Restore Studio's arithmetic. It is a restatement of the gateway's plan
// maths (packages/media-gateway/video_restore.py) so the panel can say "14
// chunks, 2560x1440" before a byte is uploaded — which makes DIVERGENCE the
// failure worth testing for. test/studio/test_restore_plan_parity.py runs the
// same cases through both copies and compares; these are the properties that
// have to hold on this side regardless.
const test = require('node:test');
const assert = require('node:assert/strict');

const lib = () => import('../src/lib/videoRestore.js');

test('every batch the picker can produce is one the model accepts', async () => {
    const { snapBatchSize } = await lib();
    for (let value = 1; value < 60; value += 1) {
        const snapped = snapBatchSize(value);
        assert.equal((snapped - 1) % 4, 0, `${value} snapped to ${snapped}`);
        assert.ok(snapped <= value);
    }
    // Nonsense never becomes zero frames per batch.
    assert.equal(snapBatchSize(0), 1);
    assert.equal(snapBatchSize('x'), 5);
});

test('the output size is the short edge, with the long edge capped on request', async () => {
    const { targetDimensions } = await lib();
    assert.deepEqual(targetDimensions(640, 360, 1440), { width: 2560, height: 1440 });
    assert.deepEqual(targetDimensions(360, 640, 1440), { width: 1440, height: 2560 });
    // 21:9 would be 3360 wide at a 1440 short edge; the cap pulls both back.
    const capped = targetDimensions(2560, 1080, 1440, 2560);
    assert.equal(capped.width, 2560);
    assert.ok(capped.height < 1440);
});

test('the chunks cover every source frame exactly once', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({ frames: 487, fps: 24, width: 640, height: 360, settings: {} });
    const covered = [];
    for (const chunk of plan.chunks) {
        const start = chunk.sourceStart + chunk.context;
        for (let frame = start; frame < start + chunk.outputLength; frame += 1) covered.push(frame);
    }
    assert.equal(covered.length, 487);
    assert.equal(covered[0], 0);
    assert.equal(covered[486], 486);
});

test('the first chunk has no lead-in and later ones re-read the boundary', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({ frames: 480, fps: 24, width: 640, height: 360, settings: { chunkSeconds: 2 } });
    assert.equal(plan.chunks[0].context, 0);
    assert.equal(plan.chunks[1].context, plan.contextFrames);
    assert.equal(
        plan.chunks[1].sourceStart,
        plan.chunks[1].index * plan.chunkFrames - plan.contextFrames,
    );
});

test('a clip with only one chunk has no seam to dissolve', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({ frames: 40, fps: 24, width: 640, height: 360, settings: { chunkSeconds: 30 } });
    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.seamFrames, 0);
});

test('a dissolve can never be longer than the overlap that feeds it', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({
        frames: 480, fps: 24, width: 640, height: 360,
        settings: { batchSize: 5, contextFrames: 5, seamFrames: 30 },
    });
    assert.ok(plan.seamFrames <= plan.contextFrames);
});

test('a preview is one chunk at the playhead and never runs past the end', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({
        frames: 200, fps: 24, width: 640, height: 360, settings: {},
        previewFrames: 120, previewStartFrame: 190,
    });
    assert.equal(plan.preview, true);
    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunks[0].sourceStart, 190);
    assert.equal(plan.chunks[0].context, 0);
    assert.equal(plan.seamFrames, 0);
});

test('a playhead in the last frames slides back rather than overrunning', async () => {
    const { planRestore } = await lib();
    const plan = planRestore({
        frames: 200, fps: 24, width: 640, height: 360,
        settings: { batchSize: 5 }, previewFrames: 60, previewStartFrame: 199,
    });
    assert.equal(plan.chunks[0].sourceStart, 195);
    assert.ok(plan.chunks[0].sourceStart + plan.chunks[0].sourceLength <= 200);
});

test('the lead-in is charged for: a render is longer than its footage', async () => {
    const { planRestore, contextOverhead } = await lib();
    const plan = planRestore({ frames: 480, fps: 24, width: 640, height: 360, settings: { chunkSeconds: 2 } });
    // Not a rounding artefact — the context frames are real diffusion work, and
    // the panel says so rather than promising a render as long as the clip.
    assert.ok(contextOverhead(plan) > 1);
    assert.ok(contextOverhead(plan) < 1.5);
});

test('the request carries the settled batch, not the one that was typed', async () => {
    const { restoreRequestBody } = await lib();
    const body = restoreRequestBody({ batchSize: 7, resolution: '4k', seed: 11 });
    assert.equal(body.batch_size, 5);
    assert.equal(body.resolution, '4k');
    assert.equal(body.seed, 11);
    // Off-by-default dials are omitted, so the gateway's own default stays the
    // single place each one is written down.
    assert.equal('tiled_vae' in body, false);
    // Never sent at all: the gateway refuses it (it crashes chunk two), so the
    // studio does not carry a dial for it.
    assert.equal('torch_compile' in body, false);
    assert.equal('max_resolution' in body, false);
});

test('a resume carries the machine and nothing else', async () => {
    const { restoreRequestBody } = await lib();
    // The plan was settled when the project started and its finished chunks were
    // rendered under it. Re-sending whatever the panel shows now would be dials
    // the gateway is right to ignore — and a user right to expect it to honour.
    const body = restoreRequestBody({ batchSize: 33, resolution: '4k' }, { resume: true, projectId: 'p1', runOn: 'vast:7' });
    assert.deepEqual(body, { project_id: 'p1', run_on: 'vast:7' });
    // …and a fresh start with the same settings still carries them.
    const fresh = restoreRequestBody({ batchSize: 33, resolution: '4k' }, {});
    assert.equal(fresh.batch_size, 33);
    assert.equal(fresh.resolution, '4k');
});

test('a preview request names both the length and where it starts', async () => {
    const { restoreRequestBody } = await lib();
    const body = restoreRequestBody({}, { previewFrames: 48, previewStartFrame: 120 });
    assert.equal(body.preview_frames, 48);
    assert.equal(body.preview_start_frame, 120);
});

test('a reframe is only sent when a ratio was actually chosen', async () => {
    const { finishRequestBody } = await lib();
    assert.equal('aspect' in finishRequestBody({ sharpen: 0.5 }), false);
    const reframed = finishRequestBody({ aspect: 'crop', aspectRatio: '9:16' });
    assert.equal(reframed.aspect, 'crop');
    assert.equal(reframed.aspect_ratio, '9:16');
});

test('a rented machine is described as the paid one, and says why', async () => {
    const { describeLane } = await lib();
    const paid = describeLane({ available: true, paid: true });
    assert.match(paid, /billed by the hour/i);
    // The consequence, not just the price: its seams cannot dissolve.
    assert.match(paid, /hard cuts/i);
    const free = describeLane({ available: true, paid: false });
    assert.match(free, /free/i);
    const missing = describeLane({ available: false, missing: ['SeedVR2VideoUpscaler'] });
    assert.match(missing, /SeedVR2VideoUpscaler/);
});

test('a machine says which of the four TensorRT states it is in', async () => {
    const { describeTensorRt, laneHasTensorRt } = await lib();

    // Working, and with a real measurement behind it.
    const measured = describeTensorRt({ tensorrt: { available: true, speedup: 1.8 } });
    assert.match(measured, /1\.8x/);
    assert.match(measured, /measured/i);

    // Working, nothing built yet — a promise would be a number nobody measured.
    const ready = describeTensorRt({ tensorrt: { available: true, speedup: 0 } });
    assert.match(ready, /first chunk builds/i);
    assert.doesNotMatch(ready, /\dx/);

    // Not working, and the reason is the LANE's own, because it names the
    // fixable thing rather than saying "off".
    const missing = describeTensorRt({
        tensorrt: { available: false, reason: 'this machine does not have the Hivemind TensorRT node' },
    });
    assert.match(missing, /does not have the Hivemind TensorRT node/);
    // Verbatim and capitalised, not wrapped in a second "No TensorRT —" that
    // would leave two dashes and one thought on the row.
    assert.equal(missing, 'This machine does not have the Hivemind TensorRT node');

    // A lane that would not answer still gets a sentence.
    assert.ok(describeTensorRt({ tensorrt: { available: false } }).trim());
    // A lane that was never asked gets none, rather than a guess.
    assert.equal(describeTensorRt({}), '');

    assert.equal(laneHasTensorRt({ tensorrt: { available: true } }), true);
    assert.equal(laneHasTensorRt({ tensorrt: { available: false } }), false);
    assert.equal(laneHasTensorRt(null), false);
});

test('an ETA is only ever what this project measured', async () => {
    const { describeEta } = await lib();
    assert.equal(describeEta({ eta_seconds: 0 }), '');
    assert.equal(describeEta(null), '');
    assert.match(describeEta({ eta_seconds: 600 }), /10 min/);
    assert.match(describeEta({ eta_seconds: 7800 }), /2h 10m/);
});

test('chunk clip urls come back in playback order, and skip what is missing', async () => {
    const { chunkOutputUrls } = await lib();
    const project = {
        plan: { chunks: [{ index: 0 }, { index: 1 }, { index: 2 }] },
        chunks: { 0: { output: 'a.mp4' }, 2: { output: 'c.mp4' } },
    };
    assert.deepEqual(chunkOutputUrls(project), [
        '/api/media-studio/gateway/a.mp4',
        '/api/media-studio/gateway/c.mp4',
    ]);
});

// --- the hosted lane, where a button press moves money -----------------------
//
// The other two lanes cost electricity or bill a box you already rented. This
// one charges per render, so the properties worth testing are the ones that
// keep a price honest: it is never invented here, it is never absent while
// still looking like an offer, and the figure shown is the figure sent back.

test('a hosted render is described as per-render, and as the one that leaves this machine', async () => {
    const { describeLane, CLOUD_LANE } = await lib();
    const hosted = describeLane({ lane: CLOUD_LANE, paid: true, available: true });
    assert.match(hosted, /per render/i);
    assert.match(hosted, /credits/i);
    // The disclosure belongs beside the button, not in a policy.
    assert.match(hosted, /leaves this computer/i);
    // And the rented lane still says the thing that is true of IT.
    const rented = describeLane({ lane: 'gpu-1', paid: true, available: true });
    assert.match(rented, /by the hour/i);
    assert.doesNotMatch(rented, /per render/i);
});

test('a hosted price is the service’s total, or nothing at all', async () => {
    const { describeCloudPrice } = await lib();
    assert.match(describeCloudPrice({ totalUsd: 2.4, chunks: [1, 2, 3] }), /\$2\.40/);
    assert.match(describeCloudPrice({ totalUsd: 2.4, chunks: [1, 2, 3] }), /3 chunks/);
    // Under a dollar reads in cents, because 6¢ is the price.
    assert.match(describeCloudPrice({ totalUsd: 0.06, chunks: [1] }), /6¢/);
    assert.match(describeCloudPrice({ totalUsd: 0.06, chunks: [1] }), /1 chunk\b/);
    // Never a guess: no quote is an empty string, which the panel turns into
    // "could not be priced" rather than into silence.
    assert.equal(describeCloudPrice(null), '');
    assert.equal(describeCloudPrice({}), '');
    assert.equal(describeCloudPrice({ totalUsd: 0 }), '');
});

test('the approval is the shown figure plus a little headroom, and zero when unpriced', async () => {
    const { approvedSpendUsd } = await lib();
    // A chunk that prices a cent over the quote should finish the render rather
    // than stop it — but a price that genuinely moved must not slip through.
    assert.equal(approvedSpendUsd({ totalUsd: 2.0 }), 2.2);
    assert.equal(approvedSpendUsd({ totalUsd: 0.05 }), 0.06);
    // No quote means no approval, which is what stops the render being started.
    assert.equal(approvedSpendUsd(null), 0);
    assert.equal(approvedSpendUsd({ totalUsd: -1 }), 0);
});

test('the approved ceiling travels with a start AND with a resume', async () => {
    const { restoreRequestBody } = await lib();
    const fresh = restoreRequestBody({ model: 'm' }, { runOn: 'cloud', maxSpendUsd: 2.2 });
    assert.equal(fresh.run_on, 'cloud');
    assert.equal(fresh.max_spend_usd, 2.2);
    // A resume is a fresh decision at that day's price; the chunks already paid
    // for are recorded on the project rather than charged again.
    const resumed = restoreRequestBody({}, { resume: true, projectId: 'r1', runOn: 'cloud', maxSpendUsd: 1.1 });
    assert.deepEqual(resumed, { project_id: 'r1', run_on: 'cloud', max_spend_usd: 1.1 });
    // And a free render carries no ceiling at all, rather than a zero the
    // gateway would have to interpret.
    assert.ok(!('max_spend_usd' in restoreRequestBody({ model: 'm' }, {})));
});
