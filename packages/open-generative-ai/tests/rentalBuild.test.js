// The rental build page: what a rented machine is provisioned WITH, per tier.
//
// Two things are worth pinning here and they are different in kind. The store
// is exercised directly — it owns the one decision the page reads off
// (`editable`, which is a fact the control API answers rather than a flag a URL
// can set) and the save path that keeps the committed file in step. The page
// and the picker are RENDERED, because the whole point of the request was that
// the picker is the studios' LoRA card grid rather than a second thing that
// looks like it.
//
// Deliberately textual: the "one card component, two callers" claim is an
// identity claim about the source — a render shows two grids of cards whether
// they came from one component or from two that drifted, which is exactly the
// failure this is guarding against.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, textOf } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

function stubFetch(routes) {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, options) => {
        calls.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
        const handler = routes[String(url)] || routes['*'];
        if (!handler) return { ok: false, status: 404, json: async () => ({}) };
        const answer = await handler(options);
        return { ok: answer.ok !== false, status: answer.status || 200, json: async () => answer.body ?? {} };
    };
    return { calls, restore: () => { global.fetch = original; } };
}

test('the build store only reports editable when the control API says there is a checkout', async () => {
    const mod = await import('../src/lib/rentalBuild.js');
    for (const [body, expected] of [
        [{ editable: true, path: '/repo/packages/gpu-rentals/rental-build.json', tiers: [{ tier: 'minimax' }] }, true],
        // A packaged app: the route answers, and the answer is no.
        [{ editable: false, path: '/bundle/rental-build.json', tiers: [] }, false],
    ]) {
        mod.resetRentalBuildForTests();
        const stub = stubFetch({ '/api/gpu-rentals/build': async () => ({ body }) });
        try {
            const state = await mod.refreshRentalBuild();
            assert.equal(state.editable, expected);
            assert.equal(state.status, 'ready');
        } finally {
            stub.restore();
        }
    }

    // No route at all (an older stack, a locked vault, a hosted build): not an
    // error on screen, just a page this install does not have.
    mod.resetRentalBuildForTests();
    const missing = stubFetch({ '/api/gpu-rentals/build': async () => ({ ok: false, status: 404 }) });
    try {
        const state = await mod.refreshRentalBuild();
        assert.equal(state.status, 'unsupported');
        assert.equal(state.editable, false);
    } finally {
        missing.restore();
    }
});

test('saving a tier replaces that row in place and never re-reads the whole payload', async () => {
    const mod = await import('../src/lib/rentalBuild.js');
    mod.resetRentalBuildForTests();
    const stub = stubFetch({
        '/api/gpu-rentals/build': async () => ({
            body: {
                editable: true,
                path: '/repo/x.json',
                tiers: [
                    { tier: 'minimax', pinned_loras: null, weights: [] },
                    { tier: 'minimaxeros', pinned_loras: null, weights: [] },
                ],
            },
        }),
        '/api/gpu-rentals/build/minimax/loras': async () => ({
            body: { editable: true, path: '/repo/x.json', tier: { tier: 'minimax', pinned_loras: ['h3/lain.safetensors'], weights: [] } },
        }),
        // Pinning starts uploads, so the save re-reads the LoRA registry.
        '/api/gpu-rentals/loras': async () => ({ body: { loras: [] } }),
    });
    try {
        await mod.refreshRentalBuild();
        const state = await mod.saveRentalBuildLoras('minimax', ['h3/lain.safetensors']);
        assert.deepEqual(state.tiers.map((row) => row.tier), ['minimax', 'minimaxeros']);
        assert.deepEqual(state.tiers[0].pinned_loras, ['h3/lain.safetensors']);
        // The other tier is untouched — a pin is per machine config.
        assert.equal(state.tiers[1].pinned_loras, null);
        const save = stub.calls.find((call) => call.method === 'PUT');
        assert.deepEqual(JSON.parse(save.body), { ids: ['h3/lain.safetensors'] });
        // The BUILD payload is read once: re-reading it would re-walk the
        // models tree for every tier, which is the expensive half of this page.
        const buildGets = stub.calls.filter((call) => call.method === 'GET' && call.url === '/api/gpu-rentals/build');
        assert.equal(buildGets.length, 1);
        // The registry, though, MUST be re-read: the save started uploads, so
        // every "in the bucket" mark on the page is stale the moment it
        // returns — and the registry's own poll only runs once it has seen an
        // upload in flight, so without this the page sat on a pre-restart
        // failure showing "not in the bucket" for files that had since landed.
        assert.ok(
            stub.calls.some((call) => call.method === 'GET' && call.url === '/api/gpu-rentals/loras'),
            'saving pins did not re-read the LoRA registry',
        );
    } finally {
        stub.restore();
    }
});

test('no pins and pinned-to-none are different answers', async () => {
    const { tierHasLoraPins, tierLoraPins } = await import('../src/lib/rentalBuild.js');
    // Never pinned: the tier still takes every registered LoRA of its families,
    // which is how every machine rented so far was provisioned.
    assert.equal(tierHasLoraPins({ pinned_loras: null }), false);
    assert.deepEqual(tierLoraPins({ pinned_loras: null }), []);
    // Pinned to none: a decision, and the opposite one.
    assert.equal(tierHasLoraPins({ pinned_loras: [] }), true);
    assert.equal(tierHasLoraPins({ pinned_loras: ['a'] }), true);
    assert.deepEqual(tierLoraPins({ pinned_loras: ['a'] }), ['a']);
});

test('a refused save carries the server sentence, not a status code', async () => {
    const mod = await import('../src/lib/rentalBuild.js');
    mod.resetRentalBuildForTests();
    const detail = 'That checkpoint has no Civitai or Hugging Face metadata, so a rented box has nowhere to fetch it from.';
    const stub = stubFetch({ '*': async () => ({ ok: false, status: 400, body: { detail } }) });
    try {
        await assert.rejects(
            () => mod.saveRentalBuildCheckpoint('minimax', 'diffusion_models/x.safetensors', 'checkpoints/y.safetensors'),
            (error) => error.message === detail && error.status === 400,
        );
    } finally {
        stub.restore();
    }
});

test('the picker draws the studios LoRA card — the same component, not a copy', () => {
    const view = read('src/hub/views/RentalBuildView.jsx');
    const section = read('src/studios/image/LoraSection.jsx');
    // Both mount LoraCard. A second card that looked alike would teach the same
    // click two meanings the first time one of them changed.
    for (const [name, source] of [['the picker', view], ['the studios panel', section]]) {
        assert.match(source, /from '(\.\.\/)*(\.\.\/)?studios\/image\/LoraCard\.jsx'|from '\.\/LoraCard\.jsx'/, `${name} does not import the shared card`);
        assert.match(source, /<LoraCard\b/, `${name} does not render the shared card`);
    }
    // The card owns selection, the outline and the keyboard; a caller that
    // re-implemented the border would be the drift this guards against.
    const card = read('src/studios/image/LoraCard.jsx');
    assert.match(card, /aria-pressed=\{selected\}/);
    assert.match(card, /border-honey bg-honey-tint/);
    assert.doesNotMatch(view, /border-honey bg-honey-tint/, 'the picker re-implements the selected outline');
    assert.doesNotMatch(section, /border-honey bg-honey-tint/, 'the panel re-implements the selected outline');
});

test('the picker asks for LoRAs by base-model family, because a tier is not a workflow', () => {
    const view = read('src/hub/views/RentalBuildView.jsx');
    // The bridge resolves a catalog from declared families when it does not
    // know the id — the same path that keeps MCP-only video workflows working.
    assert.match(view, /localAI\.listLoras\(`rental-\$\{tier\.tier\}`, tier\.lora_base_models\)/);
    // A HYPHEN. The request goes through the control API first, and its
    // /local-ai/* allowlist accepts a dynamic loras/<id> segment only when the
    // id is alphanumeric once -, _ and % are stripped. `rental:<tier>` keeps
    // its colon through that strip, so every request was 404'd by the proxy
    // and the picker reported the local engine as down — with a healthy engine
    // AND a healthy bridge. The other half of this is pinned in Python, where
    // the allowlist lives: test_the_rental_build_lora_id_survives_the_bridge_allowlist.
    assert.doesNotMatch(view, /listLoras\(`[^`]*:/, 'a colon in the id is 404d by the control API proxy');
});

test('a LoRA Civitai serves is marked as such, never as missing from the bucket', () => {
    // It is uploaded nowhere and stored nowhere, so "In bucket" would be a lie
    // and "not in the bucket" would be an alarm about a file that is perfectly
    // reachable. The readiness check stays source-blind: ready is ready.
    const view = read('src/hub/views/RentalBuildView.jsx');
    assert.match(view, /const fromCivitai = entry\?\.source === 'civitai'/);
    assert.match(view, /\? 'Civitai'/);
    assert.doesNotMatch(view, /stuckPins = registry\.entries[\s\S]{0,200}source/,
        'the stuck check must not branch on the transport');
});

test('a pinned LoRA that is not reachable says so, on the card and on the tier', () => {
    // The worst shape this page can take: the card looks chosen, the tier
    // counts it, and the machine gets nothing. An upload can fail (no bucket
    // credential, a dead link) long after the pin was committed, so neither
    // surface may treat "pinned" as "will arrive".
    const view = read('src/hub/views/RentalBuildView.jsx');
    assert.match(view, /const failed = entry\?\.status === 'error'/);
    assert.match(view, /Upload failed/);
    // The tier card reads the registry itself rather than trusting the pin list.
    assert.match(view, /const stuckPins = registry\.entries/);
    assert.match(view, /not reachable/);
    // …and `entries === null` is UNKNOWN, not missing: the registry has not
    // answered yet, and painting every pin red on a slow fetch would be a lie.
    assert.match(view, /registry\.entries\s*\?\s*pins\.filter/);
});

// The store is a module singleton and useRentalBuild seeds its first render
// from it, so answering the route once before rendering is how a server render
// sees a machine's actual answer (effects never run here).
async function withBuild(body) {
    const mod = await import('../src/lib/rentalBuild.js');
    mod.resetRentalBuildForTests();
    const stub = stubFetch({ '/api/gpu-rentals/build': async () => (body ? { body } : { ok: false, status: 404 }) });
    try {
        await mod.refreshRentalBuild();
        return await renderComponent('src/hub/views/RentalBuildView.jsx', 'RentalBuildView', { active: true });
    } finally {
        stub.restore();
        mod.resetRentalBuildForTests();
    }
}

test('the page says there is nothing to edit rather than showing dead controls', async () => {
    // A packaged app, or a stack with no such route: the empty state names the
    // file and the fix instead of drawing controls that cannot write anything.
    const text = textOf(await withBuild(null));
    assert.match(text, /No project checkout to write into/);
    assert.match(text, /rental-build\.json/);
    assert.doesNotMatch(text, /Choose LoRAs/, 'a tier card painted with nothing to write to');
});

test('a checkout draws one card per machine config, with its LoRAs and its base weights', async () => {
    const markup = await withBuild({
        editable: true,
        path: '/repo/packages/gpu-rentals/rental-build.json',
        tiers: [{
            tier: 'minimaxeros',
            label: 'Video \u00b7 MiniMax H3 Eros (NSFW)',
            family: 'Video \u00b7 H3 Eros (NSFW)',
            family_detail: 'H3 with the Eros Max transformer',
            lora_base_models: ['MiniMax H3'],
            pinned_loras: ['h3/lain.safetensors'],
            download_gb: 89.3,
            disk_gb: 145,
            weights: [{
                dest: 'diffusion_models/10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors',
                filename: '10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors',
                subdir: 'diffusion_models',
                size_gb: 20.97,
                origin: 'upstream',
                swap: null,
            }],
        }],
    });
    const text = textOf(markup);
    assert.match(text, /MiniMax H3 Eros \(NSFW\)/);
    assert.match(text, /1 pinned for this machine/);
    assert.match(text, /h3\/lain\.safetensors/);
    assert.match(text, /Choose LoRAs/);
    // The base weight is named, sized, and offered for swapping.
    assert.match(text, /10Eros_Max_h3_TURBO-hybrid_beta5_int8\.safetensors/);
    assert.match(text, /21\.0 GB/);
    assert.match(text, /\bSwap\b/);
    // And the page says where the decision is written, because that is the point.
    assert.match(text, /rental-build\.json/);
});

test('inactive is one hidden root, so the hub can keep it mounted', async () => {
    const markup = await renderComponent('src/hub/views/RentalBuildView.jsx', 'RentalBuildView', { active: false });
    assert.match(markup, /^<div class="[^"]*\bhidden\b[^"]*">/);
});
