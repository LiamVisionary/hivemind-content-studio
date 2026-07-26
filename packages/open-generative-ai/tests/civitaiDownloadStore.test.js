const test = require('node:test');
const assert = require('node:assert/strict');

const LORA_RESULT = {
    filename: 'look.safetensors',
    baseModel: 'SDXL',
    modelType: 'LORA',
    directory: '/Users/x/ComfyUI/models/loras',
};

// One fake gateway per download id, so several can be in flight at once.
function fakeApi({ fail = false, result = LORA_RESULT, name = 'Look LoRA · v2', jobId = 'job-1', holdAt = null } = {}) {
    let pollCount = 0;
    let cancelled = false;
    const api = {
        cancelCalls: [],
        startCivitaiDownload: async (url, options) => {
            api.lastOptions = options;
            return { id: jobId, status: 'queued', name };
        },
        getCivitaiDownloadJob: async () => {
            pollCount += 1;
            if (cancelled) return { id: jobId, status: 'cancelled', name, error: 'Download cancelled' };
            // holdAt keeps a download running so concurrency is observable.
            if (holdAt !== null && pollCount >= holdAt) {
                return { id: jobId, status: 'running', name, percent: 50, downloaded_bytes: 2560, total_bytes: 5120 };
            }
            if (pollCount === 1) {
                return { id: jobId, status: 'running', name, percent: 40, downloaded_bytes: 2048, total_bytes: 5120 };
            }
            return fail
                ? { id: jobId, status: 'error', error: 'Civitai returned 404.' }
                : { id: jobId, status: 'success', percent: 100, name, result };
        },
        cancelCivitaiDownload: async (id) => {
            api.cancelCalls.push(id);
            cancelled = true;
            return { id, status: 'cancelled' };
        },
    };
    return api;
}

// Bounded waits: a download that never settles is a bug, not a reason to hang the
// suite until the runner's timeout.
async function waitFor(predicate, what, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 10));
    }
}

async function started(store, key) {
    // Cancelling needs the gateway's job id, which arrives on the first poll.
    await waitFor(() => store.getCivitaiDownload(key)?.job?.id, `job id for ${key}`);
    return store.getCivitaiDownload(key);
}

async function settled(store, key) {
    await waitFor(() => store.getCivitaiDownload(key)?.status !== 'running', `${key} to settle`);
    return store.getCivitaiDownload(key);
}

async function cancelAndSettle(store, api, key) {
    await started(store, key);
    await store.cancelCivitaiDownload(api, key);
    return settled(store, key);
}

async function freshStore() {
    const store = await import('../src/lib/civitaiDownloadStore.js');
    store.clearSettledCivitaiDownloads();
    return store;
}

test('several downloads run at once, each with its own card state', async () => {
    const store = await freshStore();
    const first = fakeApi({ jobId: 'job-a', name: 'First', holdAt: 2 });
    const second = fakeApi({ jobId: 'job-b', name: 'Second' });

    const keyA = store.startCivitaiDownload(first, 'https://civitai.com/models/1');
    const keyB = store.startCivitaiDownload(second, 'https://civitai.com/models/2');

    assert.notEqual(keyA, keyB);
    assert.equal(store.getCivitaiDownloads().length, 2);

    // The second finishes while the first is still going — no queueing, no clobbering.
    await settled(store, keyB);
    assert.equal(store.getCivitaiDownload(keyB).status, 'success');
    assert.equal(store.getCivitaiDownload(keyA).status, 'running');
    assert.equal(store.civitaiDownloadName(store.getCivitaiDownload(keyA)), 'First');
    assert.equal(store.pendingCivitaiDownloads().length, 2); // two cards in the grid

    await cancelAndSettle(store, first, keyA);
    store.clearSettledCivitaiDownloads();
    assert.deepEqual(store.getCivitaiDownloads(), []);
});

test('the same URL is joined, not started twice', async () => {
    const store = await freshStore();
    const api = fakeApi({ jobId: 'job-dupe', holdAt: 2 });

    const first = store.startCivitaiDownload(api, 'https://civitai.com/models/7');
    const second = store.startCivitaiDownload(api, ' https://civitai.com/models/7 ');

    assert.equal(second, first); // a double click joins the download in flight
    assert.equal(store.getCivitaiDownloads().length, 1);

    await cancelAndSettle(store, api, first);
    store.clearSettledCivitaiDownloads();
});

test('two updates can replace two different LoRAs at the same time', async () => {
    const store = await freshStore();
    const a = fakeApi({ jobId: 'job-u1', holdAt: 2 });
    const b = fakeApi({ jobId: 'job-u2', holdAt: 2 });

    const keyA = store.startCivitaiDownload(a, 'https://civitai.com/models/1?modelVersionId=11', { replaces: 'one.safetensors' });
    const keyB = store.startCivitaiDownload(b, 'https://civitai.com/models/2?modelVersionId=22', { replaces: 'two.safetensors' });
    await started(store, keyA);
    await started(store, keyB);

    // Each card finds its own download, and neither owns a pending card.
    assert.equal(store.civitaiDownloadReplacing('one.safetensors').key, keyA);
    assert.equal(store.civitaiDownloadReplacing('two.safetensors').key, keyB);
    assert.equal(store.civitaiDownloadReplacing('other.safetensors'), null);
    assert.deepEqual(store.pendingCivitaiDownloads(), []);

    // Replacing the same LoRA twice joins the update already running.
    assert.equal(
        store.startCivitaiDownload(a, 'https://civitai.com/models/1?modelVersionId=99', { replaces: 'one.safetensors' }),
        keyA,
    );

    await cancelAndSettle(store, a, keyA);
    await cancelAndSettle(store, b, keyB);
    store.clearSettledCivitaiDownloads();
});

test('cancelling one download leaves the others running', async () => {
    const store = await freshStore();
    const doomed = fakeApi({ jobId: 'job-x', holdAt: 2 });
    const survivor = fakeApi({ jobId: 'job-y', holdAt: 2 });

    const keyX = store.startCivitaiDownload(doomed, 'https://civitai.com/models/3');
    const keyY = store.startCivitaiDownload(survivor, 'https://civitai.com/models/4');
    await cancelAndSettle(store, doomed, keyX);

    assert.deepEqual(doomed.cancelCalls, ['job-x']);
    assert.deepEqual(survivor.cancelCalls, []); // untouched
    assert.equal(store.getCivitaiDownload(keyX).status, 'cancelled');
    assert.equal(store.getCivitaiDownload(keyX).error, null); // a cancel is not an error
    assert.equal(store.getCivitaiDownload(keyY).status, 'running');

    // Dismissing a settled entry drops only that one.
    store.clearCivitaiDownload(keyX);
    assert.equal(store.getCivitaiDownload(keyX), null);
    assert.equal(store.getCivitaiDownloads().length, 1);
    // A running download cannot be dismissed out from under its own poll loop.
    store.clearCivitaiDownload(keyY);
    assert.equal(store.getCivitaiDownload(keyY).status, 'running');

    await cancelAndSettle(store, survivor, keyY);
    store.clearSettledCivitaiDownloads();
});

test('a download reports completion, naming and destination to its subscriber', async () => {
    const store = await freshStore();
    const seen = [];
    const unsubscribe = store.subscribeCivitaiDownloads(list => seen.push(list.length));
    let completedWith = null;

    const key = store.startCivitaiDownload(fakeApi(), ' https://civitai.com/models/123 ', {
        onComplete: job => { completedWith = job.result.filename; },
    });
    const done = await settled(store, key);

    assert.equal(completedWith, 'look.safetensors');
    assert.equal(done.status, 'success');
    assert.equal(done.url, 'https://civitai.com/models/123'); // trimmed
    assert.equal(store.isCivitaiDownloadRunning(), false);
    assert.equal(store.civitaiDownloadType(done), 'LoRA'); // raw type is "LORA"
    assert.equal(store.civitaiDownloadName(done), 'Look LoRA · v2');
    assert.equal(store.describeCivitaiDownload(done), 'look.safetensors downloaded · LoRA · SDXL · models/loras');
    assert.ok(seen.length > 1); // subscribers saw the progression

    unsubscribe();
    store.clearSettledCivitaiDownloads();
});

test('onStarted fires once, as soon as the gateway hands back a job id', async () => {
    const store = await freshStore();
    const started = [];

    const key = store.startCivitaiDownload(fakeApi(), 'https://civitai.com/models/123', {
        onStarted: (job, context) => started.push([job.id, context.replaces]),
    });
    await settled(store, key);

    // One handoff for the whole download, not one per poll — the dialog closes once.
    assert.deepEqual(started, [['job-1', '']]);
    store.clearSettledCivitaiDownloads();
});

test('an update-and-replace carries the replaced id to the gateway and to its views', async () => {
    const store = await freshStore();
    const api = fakeApi();
    let completion = null;

    const key = store.startCivitaiDownload(api, 'https://civitai.com/models/1?modelVersionId=2', {
        replaces: 'look-v1.safetensors',
        onComplete: (job, context) => { completion = context.replaces; },
    });
    await settled(store, key);

    assert.deepEqual(api.lastOptions, { replaceId: 'look-v1.safetensors' });
    assert.equal(completion, 'look-v1.safetensors'); // lets a studio swap the selection
    store.clearSettledCivitaiDownloads();
});

test('a plain download declares no replacement', async () => {
    const store = await freshStore();
    const api = fakeApi();

    const key = store.startCivitaiDownload(api, 'https://civitai.com/models/1');
    await settled(store, key);

    assert.deepEqual(api.lastOptions, { replaceId: '' });
    store.clearSettledCivitaiDownloads();
});

test('non-LoRA downloads report their type and destination folder', async () => {
    const store = await freshStore();

    const key = store.startCivitaiDownload(fakeApi({
        result: {
            filename: 'juggernautXL.safetensors',
            baseModel: 'SDXL 1.0',
            modelType: 'Checkpoint',
            directory: '/Users/x/ComfyUI/models/checkpoints',
        },
    }), 'https://civitai.com/models/133005');
    const done = await settled(store, key);

    assert.equal(store.civitaiDownloadType(done), 'Checkpoint');
    assert.equal(store.civitaiDownloadFolder(done), 'checkpoints');
    assert.equal(
        store.describeCivitaiDownload(done),
        'juggernautXL.safetensors downloaded · Checkpoint · SDXL 1.0 · models/checkpoints',
    );
    store.clearSettledCivitaiDownloads();
});

test('failures and invalid URLs settle as errors without blocking new downloads', async () => {
    const store = await freshStore();

    const failing = store.startCivitaiDownload(fakeApi({ fail: true }), 'https://civitai.com/models/123');
    const invalid = store.startCivitaiDownload(fakeApi(), 'https://example.com/models/123');
    await settled(store, failing);
    await settled(store, invalid);

    assert.equal(store.describeCivitaiDownload(store.getCivitaiDownload(failing)), 'Civitai returned 404.');
    assert.equal(store.getCivitaiDownload(invalid).status, 'error');
    assert.equal(store.isCivitaiDownloadRunning(), false);

    // A failed replace still gets a card of its own — nowhere else to report it.
    const badUpdate = store.startCivitaiDownload(fakeApi({ fail: true }), 'https://civitai.com/models/9', { replaces: 'x.safetensors' });
    await settled(store, badUpdate);
    assert.ok(store.pendingCivitaiDownloads().some(d => d.key === badUpdate));

    store.clearSettledCivitaiDownloads();
    assert.deepEqual(store.getCivitaiDownloads(), []);
});

test('progress description covers the in-flight states', async () => {
    const store = await freshStore();

    assert.equal(store.describeCivitaiDownload(null), null);
    assert.equal(store.describeCivitaiDownload({ status: 'running', job: null }), 'Resolving Civitai URL…');
    assert.equal(store.describeCivitaiDownload({ status: 'running', job: { percent: 0 } }), 'Preparing download…');
    assert.equal(
        store.describeCivitaiDownload({ status: 'running', job: { percent: 40, downloaded_bytes: 2048, total_bytes: 5120 } }),
        'Downloading 40% · 2.0 KB / 5.0 KB',
    );
    assert.equal(store.describeCivitaiDownload({ status: 'running', cancelling: true, job: { percent: 40 } }), 'Cancelling…');
    assert.equal(store.civitaiDownloadPercent({ job: { percent: 900 } }), 100);
    assert.equal(store.civitaiDownloadPercent({ job: null }), 0);
    assert.equal(
        store.civitaiDownloadName({ url: 'https://civitai.com/models/1642876?modelVersionId=1', job: null }),
        'Civitai model 1642876',
    );
});

test('model types get display labels, unknown ones pass through', async () => {
    const store = await freshStore();
    const typeOf = modelType => store.civitaiDownloadType({ job: { result: { modelType } } });

    assert.equal(typeOf('LORA'), 'LoRA');
    assert.equal(typeOf('TextualInversion'), 'Embedding');
    assert.equal(typeOf('Controlnet'), 'ControlNet');
    assert.equal(typeOf('Checkpoint'), 'Checkpoint');
    assert.equal(typeOf('Poses'), 'Poses'); // no label needed, used as-is
    assert.equal(typeOf(''), '');
});
