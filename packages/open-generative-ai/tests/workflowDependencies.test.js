// The workflow dependency preflight, browser half (src/lib/workflowDependencies.js).
//
// Liam picked MiniMax H3 Turbo on a Mac whose ComfyUI had none of it and was
// told so by a refusal. The studio now asks the lane first and installs
// inline. These pin the store: several jobs at once, each followed to its
// end, a restart only when a node pack landed, and the report reading that
// decides whether the prompt opens at all.
const test = require('node:test');
const assert = require('node:assert/strict');

let instance = 0;
function fresh() {
    instance += 1;
    return import(`../src/lib/workflowDependencies.js?deps=${instance}`);
}

function fakeApi(script = {}) {
    const calls = [];
    return {
        calls,
        async checkWorkflowDependencies(options) {
            calls.push(['check', options]);
            return script.report || { ok: true, known: true, missing: [], jobs: [] };
        },
        async installWorkflowDependencies(options) {
            calls.push(['install', options]);
            return script.install || { started: [], refused: [] };
        },
        async getWorkflowDependencyJob(id) {
            calls.push(['job', id]);
            const steps = script.jobs?.[id] || [];
            return steps.length > 1 ? steps.shift() : (steps[0] || { id, status: 'success' });
        },
        async cancelWorkflowDependencyJob(id) {
            calls.push(['cancel', id]);
            return { id, status: 'cancelled' };
        },
        async restartWorkflowLane() {
            calls.push(['restart']);
            return { accepted: true };
        },
    };
}

test('a report blocks generation when hardware is unsupported or anything is missing, never when unknown', async () => {
    const { dependenciesBlockGeneration, splitDependencies } = await fresh();
    assert.equal(dependenciesBlockGeneration({ ok: true, known: false, missing: [] }), false);
    assert.equal(dependenciesBlockGeneration({ ok: true, known: true, missing: [] }), false);
    assert.equal(dependenciesBlockGeneration({ ok: false, known: true, missing: [{ id: 'node:X', installable: true }] }), true);
    assert.equal(dependenciesBlockGeneration({ ok: false, known: true, missing: [], hardware: { supported: false } }), true);
    const split = splitDependencies({ missing: [
        { id: 'a', installable: true }, { id: 'b', installable: false }, { id: 'c', installable: true },
    ] });
    assert.deepEqual(split.installable.map((i) => i.id), ['a', 'c']);
    assert.deepEqual(split.blocked.map((i) => i.id), ['b']);
});

test('each missing item is described by its size, folder, source and pin', async () => {
    const { describeDependency, describeDependencyJob, dependencyJobPercent } = await fresh();
    assert.equal(
        describeDependency({ kind: 'model', bytes: 5207808496, source: { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/x/resolve/main/f.safetensors' } }),
        '4.85 GB - models/vae - from huggingface.co',
    );
    assert.equal(
        describeDependency({ kind: 'custom_node', source: { repo: 'https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3', commit: '9395bf98fc60a04c5f588de7b2bb33516a0b622f' } }),
        'node pack xmarre/ComfyUI-Spectrum-MiniMax-H3@9395bf9',
    );
    assert.equal(describeDependency({ kind: 'custom_node', class_type: 'MysteryNode', source: null }), 'node class MysteryNode');
    assert.equal(describeDependency({ kind: 'comfyui' }), 'part of a newer ComfyUI');
    assert.equal(describeDependencyJob({ status: 'running', downloaded_bytes: 1024 * 1024, total_bytes: 4 * 1024 * 1024 }), '1.0 MB of 4.0 MB');
    assert.equal(describeDependencyJob({ status: 'running', stage: 'cloning' }), 'cloning...');
    assert.equal(describeDependencyJob({ status: 'error', error: 'git failed' }), 'git failed');
    assert.equal(dependencyJobPercent({ status: 'running', downloaded_bytes: 25, total_bytes: 100 }), 25);
    assert.equal(dependencyJobPercent({ status: 'success' }), 100);
});

test('installDependencies follows every started job concurrently to its end', async () => {
    const lib = await fresh();
    const api = fakeApi({
        install: { started: [
            { id: 'j1', status: 'queued', dependency: 'model:a', workflow_id: 'wf', needs_restart: false },
            { id: 'j2', status: 'queued', dependency: 'node:B', workflow_id: 'wf', needs_restart: true },
        ], refused: [{ id: 'node:C', reason: 'Update ComfyUI' }] },
        jobs: {
            j1: [{ id: 'j1', status: 'running', downloaded_bytes: 5, total_bytes: 10, dependency: 'model:a', workflow_id: 'wf' }, { id: 'j1', status: 'success', dependency: 'model:a', workflow_id: 'wf' }],
            j2: [{ id: 'j2', status: 'success', dependency: 'node:B', workflow_id: 'wf', needs_restart: true }],
        },
    });
    const seen = [];
    lib.subscribeDependencyJobs((jobs) => seen.push(jobs.map((j) => `${j.id}:${j.status}`).join(',')));
    const outcome = await lib.installDependencies(api, { workflowId: 'wf', runOn: 'vast:1' });
    assert.deepEqual(api.calls[0], ['install', { workflowId: 'wf', runOn: 'vast:1', items: undefined }]);
    assert.deepEqual(outcome.refused, [{ id: 'node:C', reason: 'Update ComfyUI' }]);
    assert.equal(lib.isDependencyInstallRunning('wf'), true);
    // Both jobs are polled; neither waits for the other.
    for (let i = 0; i < 40 && lib.isDependencyInstallRunning('wf'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(lib.isDependencyInstallRunning('wf'), false);
    assert.equal(lib.dependencyJobForItem('model:a', 'wf').status, 'success');
    assert.equal(lib.dependencyJobForItem('node:B', 'wf').status, 'success');
    // A node pack landed, so the lane needs a restart; a models-only install would not.
    assert.equal(lib.dependencyInstallNeedsRestart('wf'), true);
    assert.ok(seen.some((line) => line.includes('j1:running')), 'progress reached subscribers');
    lib.clearSettledDependencyJobs('wf');
    assert.deepEqual(lib.dependencyJobsFor('wf'), []);
});

test('a cancel flags the job and the poll settles it; a lost poll becomes an error, not a hang', async () => {
    const lib = await fresh();
    const api = fakeApi({
        install: { started: [{ id: 'j9', status: 'running', dependency: 'model:z', workflow_id: 'wf' }], refused: [] },
        jobs: { j9: [{ id: 'j9', status: 'running', dependency: 'model:z', workflow_id: 'wf' }, { id: 'j9', status: 'cancelled', dependency: 'model:z', workflow_id: 'wf' }] },
    });
    await lib.installDependencies(api, { workflowId: 'wf' });
    await lib.cancelDependencyJob(api, 'j9');
    assert.ok(api.calls.some(([kind, id]) => kind === 'cancel' && id === 'j9'));
    for (let i = 0; i < 40 && lib.isDependencyInstallRunning('wf'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(lib.dependencyJobForItem('model:z', 'wf').status, 'cancelled');
    assert.equal(lib.dependencyInstallNeedsRestart('wf'), false);

    const broken = fakeApi({ install: { started: [{ id: 'j10', status: 'running', dependency: 'model:y', workflow_id: 'wf' }], refused: [] } });
    broken.getWorkflowDependencyJob = async () => { throw new Error('gateway went away'); };
    await lib.installDependencies(broken, { workflowId: 'wf' });
    for (let i = 0; i < 40 && lib.isDependencyInstallRunning('wf'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lost = lib.dependencyJobForItem('model:y', 'wf');
    assert.equal(lost.status, 'error');
    assert.equal(lost.error, 'gateway went away');
});

test('the preflight is cached per workflow and pin, refreshed on force, and adopts reported jobs', async () => {
    const lib = await fresh();
    const report = { ok: false, known: true, missing: [{ id: 'node:X', installable: true }], jobs: [{ id: 'adopted', status: 'success', dependency: 'node:X', workflow_id: 'wf' }] };
    const api = fakeApi({ report });
    const first = await lib.checkWorkflowDependencies(api, { workflowId: 'wf', runOn: '' });
    const second = await lib.checkWorkflowDependencies(api, { workflowId: 'wf', runOn: '' });
    assert.equal(first, second);
    assert.equal(api.calls.filter(([kind]) => kind === 'check').length, 1);
    await lib.checkWorkflowDependencies(api, { workflowId: 'wf', runOn: 'vast:2' });
    assert.equal(api.calls.filter(([kind]) => kind === 'check').length, 2);
    await lib.checkWorkflowDependencies(api, { workflowId: 'wf', runOn: '', force: true });
    assert.equal(api.calls.filter(([kind]) => kind === 'check').length, 3);
    // A settled job the gateway reported is in the store without being polled.
    assert.equal(lib.dependencyJobForItem('node:X', 'wf').status, 'success');
    assert.equal(api.calls.filter(([kind]) => kind === 'job').length, 0);
    // No workflow, no round-trip.
    const none = await lib.checkWorkflowDependencies(api, { workflowId: '' });
    assert.deepEqual(none, { ok: true, known: false, missing: [] });
});

// The prompt is a portalled modal, which react-dom/server cannot render, so
// its wiring is asserted on the source: every string it asks i18n for
// exists, and the Video studio mounts it behind its open flag with the
// report, the workflow and the pin.
test('the prompt asks only for strings i18n has, and the Video studio mounts it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', 'src');
    const prompt = fs.readFileSync(path.join(root, 'components', 'WorkflowDependencyPrompt.jsx'), 'utf8');
    const i18n = fs.readFileSync(path.join(root, 'lib', 'i18n.js'), 'utf8');
    const keys = [...prompt.matchAll(/\btf?\('([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]);
    assert.ok(keys.length > 10, 'the prompt reads its strings from i18n');
    for (const key of new Set(keys)) {
        assert.ok(i18n.includes(`'${key}'`), `${key} is missing from i18n.js`);
    }
    const studio = fs.readFileSync(path.join(root, 'studios', 'VideoStudio.jsx'), 'utf8');
    assert.match(studio, /s\.dependencyPromptOpen && s\.dependencyReport && dependencyWorkflowId \? \(\s*<WorkflowDependencyPrompt/);
    assert.match(studio, /onInstallDependencies: \(\) => void openDependencyPrompt\(\{ force: true \}\)/);
    assert.match(studio, /\}, \[dependencyWorkflowId, dependencyRunOn\]\);/);
    // The remedy the server names resolves to the action the studio handles.
    const textModels = fs.readFileSync(path.join(root, 'lib', 'textModels.js'), 'utf8');
    assert.match(textModels, /'install-dependencies': \{ label: t\('deps\.installWhatIsMissing'\), action: 'install-dependencies' \}/);
    const runner = fs.readFileSync(path.join(root, 'lib', 'failureRemedy.js'), 'utf8');
    assert.match(runner, /action === 'install-dependencies'/);
});
