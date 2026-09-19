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

// Deliberately textual: the prompt renders through Modal, which is a
// createPortal call, and react-dom/server refuses portals — there is no markup
// to assert on. So its wiring is read instead: every string it asks i18n for
// exists, the Video studio mounts it behind its open flag with the report, the
// workflow and the pin, and the remedy the server names resolves to an action
// the studio handles. The store above it is exercised, not read.
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

    // The Image studio runs the same preflight. It did not, which is how
    // MiniMax H3 Image — whose weights only exist on a rented box — answered a
    // press on this Mac with ComfyUI's own validation dump. Its prompt is
    // lazily bound, because Image is the landing studio.
    const image = fs.readFileSync(path.join(root, 'studios', 'ImageStudio.jsx'), 'utf8');
    assert.doesNotMatch(image, /^import \{ WorkflowDependencyPrompt \}/m, 'the prompt is in the landing chunk');
    assert.match(image, /const WorkflowDependencyPromptLazy = lazyChunk\(/);
    assert.match(image, /s\.dependencyPromptOpen && s\.dependencyReport && dependencyWorkflowId \? \(\s*<Suspense[\s\S]{0,60}?>\s*<WorkflowDependencyPromptLazy/);
    assert.match(image, /onInstallDependencies: \(\) => void openDependencyPrompt\(\{ force: true \}\)/);
    assert.match(image, /\}, \[dependencyWorkflowId, dependencyRunOn\]\);/);
    // Only a registry workflow has a preflight to ask for; a cloud model has none.
    assert.match(image, /activeLocalModel\?\.provider === 'hosted-media-studio'/);
});

// The lane that started this: H3 Image runs H3's own weights, which only load
// on an NVIDIA card, and the entry said nothing about that — so the studio
// offered it here, sent it to this Mac's ComfyUI, and relayed the refusal raw.
test('the H3 image lane declares the card it needs and where its weights come from', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const registry = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'media-gateway', 'workflow-registry.json'), 'utf8'));
    const entry = registry.workflows.find((item) => item.id === 'minimax-h3-image');
    assert.equal(entry.hardware.accelerator, 'cuda');
    assert.match(entry.hardware.reason, /rented machine/i);
    const graph = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'media-gateway', 'workflows', entry.workflow_file), 'utf8'));
    // Every weight the graph names has a source, or the preflight can only say
    // "missing" and not where it comes from.
    const named = new Set();
    for (const node of Object.values(graph)) {
        for (const value of Object.values(node.inputs || {})) {
            if (typeof value === 'string' && /\.safetensors$/.test(value)) named.add(value);
        }
    }
    assert.ok(named.size >= 4);
    const declared = new Set(entry.model_dependencies.map((item) => path.basename(item.relativePath)));
    for (const file of named) assert.ok(declared.has(file), `${file} has no declared source`);
    for (const item of entry.model_dependencies) {
        assert.match(item.url, /^https:\/\/huggingface\.co\//);
        assert.ok(item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256), `${item.relativePath} is unverifiable`);
    }
    // The node pack that provides H3StudioLoader, pinned the way the rental
    // provisioner pins it (packages/gpu-rentals: _H3_STUDIO_TAG).
    const pack = entry.custom_node_dependencies[0];
    assert.match(pack.repo, /^https:\/\/github\.com\//);
    assert.ok(pack.commit);
    assert.ok(pack.class_types.includes('H3StudioLoader'));
});

/* ---------------- a lane that refuses is a lane to move off ---------------- */

// Navigating to Image or Video used to open the install modal over an empty
// stage, because the registry's own default lane (MiniMax H3 Image) needs a
// Blackwell card this Mac does not have. Nobody chose that lane, so nothing
// should stop: the studio moves to one that runs and says so in the composer.
// These pin the half that is pure — which lanes are known to refuse, and which
// targets are therefore still candidates.
test('the preflight remembers which lanes refused, and strikes them out of the fallback list', async () => {
    const lib = await fresh();
    const blocked = { ok: false, known: true, missing: [{ id: 'model:a', installable: false }], hardware: { supported: false, reason: 'needs a cuda card' } };
    const clean = { ok: true, known: true, missing: [] };

    const targets = [
        { id: 'minimax-h3-image', source: 'local', provider: 'hosted-media-studio', place: 'this-mac', ready: true },
        { id: 'z-image-turbo', source: 'local', provider: 'hosted-media-studio', place: 'this-mac', ready: true },
        { id: 'gpt-image-2', source: 'cloud', provider: 'hivemindos', place: 'hivemindos', ready: true },
    ];
    const laneOf = (target) => (target.provider === 'hosted-media-studio' ? target.id : '');

    // Nothing asked yet: every row is a candidate.
    assert.deepEqual(lib.targetsWithRunnableLanes(targets, { laneOf }).map((t) => t.id),
        ['minimax-h3-image', 'z-image-turbo', 'gpt-image-2']);

    await lib.checkWorkflowDependencies(fakeApi({ report: blocked }), { workflowId: 'minimax-h3-image' });
    assert.equal(lib.laneIsBlocked('minimax-h3-image'), true);
    // …on THIS pin. The same workflow on a rented box is a different question.
    assert.equal(lib.laneIsBlocked('minimax-h3-image', 'rental-7'), false);
    assert.deepEqual(lib.targetsWithRunnableLanes(targets, { laneOf }).map((t) => t.id),
        ['z-image-turbo', 'gpt-image-2']);
    // A cloud model has no workflow to preflight, so it survives every verdict
    // — which is what makes HivemindOS credits the answer on a machine that
    // can run nothing itself.
    assert.deepEqual(
        lib.targetsWithRunnableLanes(targets, { laneOf: () => 'minimax-h3-image' }).map((t) => t.id),
        [],
    );

    // An install that lands clears it without anyone having to remember to.
    await lib.checkWorkflowDependencies(fakeApi({ report: clean }), { workflowId: 'minimax-h3-image', force: true });
    assert.equal(lib.laneIsBlocked('minimax-h3-image'), false);
    assert.deepEqual(lib.targetsWithRunnableLanes(targets, { laneOf }).map((t) => t.id),
        ['minimax-h3-image', 'z-image-turbo', 'gpt-image-2']);
});

// The studios' half is read as source for the same reason the mount above is:
// both hang off a Modal, which react-dom/server refuses to render.
test('both studios move off a lane nobody chose, and put Cancel back where it was', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', 'src');
    for (const file of ['ImageStudio.jsx', 'VideoStudio.jsx']) {
        const studio = fs.readFileSync(path.join(root, 'studios', file), 'utf8');
        // A refusal is answered by the prompt only when a PERSON picked the
        // lane; otherwise the ladder picks again from the rows that are left.
        assert.match(studio, /const fallback = force \|\| chosen \? null : runnableFallbackTarget\(\);/, file);
        assert.match(studio, /targetsWithRunnableLanes\(targets, \{ runOn: dependencyRunOn, laneOf: laneOfTarget \}\)/, file);
        assert.match(studio, /pickRunTarget\('(image|video)', \{ catalog: candidates, machines, readiness \}\)/, file);
        // The fallback and the revert are the studio answering, never a pick.
        assert.match(studio, /chooseRunTarget\(fallback, \{ chosen: false, automatic: s\.(setup\.)?runOnAutomatic \}\)/, file);
        assert.match(studio, /chooseRunTarget\(snapshot\.target, \{ automatic: snapshot\.automatic, chosen: false \}\)/, file);
        // Cancelling the prompt never leaves the tab on a lane whose Generate
        // could only refuse.
        assert.match(studio, /if \(revert && dependenciesBlockGeneration\(s\.dependencyReport\)\) restoreSelection\(revert\);/, file);
        // The move is said in the composer, in the notice tone — not in red,
        // and not in a modal.
        assert.match(studio, /<FailureCallout\s+tone="notice"/, file);
        assert.match(studio, /tf\('deps\.movedTitle', s\.dependencyMoved\.from, s\.dependencyMoved\.to\)/, file);
        assert.match(studio, /onRemedy=\{\(\) => setUpMovedLane\(\)\}/, file);
        // Pinning a box is a choice like picking a model is: it gets the
        // prompt, and Cancel puts the pin back.
        assert.match(studio, /s\.dependencyChosen = true;\n\s+s\.dependencyRevert = currentSelectionSnapshot\(\);\n\s+s\.dependencyMoved = null;\n\s+(s\.rentedMachineId = next|commit\(\{ \.\.\.s\.setup, rentedMachineId: next \}\))/, file);
        // "Use in Studio" asked for THAT box; moving off it would undo the
        // handoff that was pressed.
        assert.match(studio, /s\.dependencyChosen = true;\n\s+set(Source|LocalMode)\(true\);/, file);
    }
    // The notice's three sentences live in the key table, because two studios
    // say them.
    const i18n = fs.readFileSync(path.join(root, 'lib', 'i18n.js'), 'utf8');
    for (const key of ['deps.movedTitle', 'deps.movedItems', 'deps.setUpAnyway']) {
        assert.ok(i18n.includes(`'${key}'`), `${key} is missing from i18n.js`);
    }
});
