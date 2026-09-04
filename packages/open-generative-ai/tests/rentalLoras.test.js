// Rental-LoRA registry: the dev-mode "Use in rentals" flow and the Rented-mode
// catalog filter. The store logic is exercised directly; the wiring around it
// is asserted on the source.
//
// Deliberately textual: registry filtering and the SFW/NSFW confirm are store
// wiring around the pure helpers exercised above.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('filterRentalLoras shows only uploaded entries, and fails open on an unknown registry', async () => {
    const { filterRentalLoras } = await import('../src/lib/rentalLoras.js');
    const loras = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const entries = {
        a: { status: 'ready', rating: 'sfw' },
        b: { status: 'uploading', rating: 'sfw' },   // half-uploaded: not on any box
        c: { status: 'ready', rating: 'nsfw' },
    };
    assert.deepEqual(filterRentalLoras(loras, entries).map((l) => l.id), ['a', 'c']);
    // The future NSFW mode is a flag flip, not a migration: ratings already gate.
    assert.deepEqual(filterRentalLoras(loras, entries, { includeNsfw: false }).map((l) => l.id), ['a']);
    // Registry unknown (control API unreachable, locked vault): never blank the
    // collection — that would read as data loss.
    assert.deepEqual(filterRentalLoras(loras, null), loras);
});

test('rentalLoraUploadPercent reserves 100% for the server saying ready', async () => {
    const { rentalLoraUploadPercent } = await import('../src/lib/rentalLoras.js');
    assert.equal(rentalLoraUploadPercent(null), 0);
    assert.equal(rentalLoraUploadPercent({ status: 'ready', size_bytes: 10, uploaded_bytes: 10 }), 0);
    assert.equal(rentalLoraUploadPercent({ status: 'uploading', size_bytes: 200, uploaded_bytes: 50 }), 25);
    assert.equal(rentalLoraUploadPercent({ status: 'uploading', size_bytes: 200, uploaded_bytes: 200 }), 99);
    assert.equal(rentalLoraUploadPercent({ status: 'uploading', size_bytes: 0, uploaded_bytes: 5 }), 0);
});

test('addRentalLora posts the rating with base + context, and primes the store', async () => {
    const mod = await import('../src/lib/rentalLoras.js');
    mod.resetRentalLorasForTests();
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        if (options?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({}) };
        return {
            ok: true,
            status: 201,
            json: async () => ({ id: 'ltx/glow.safetensors', status: 'uploading', rating: 'nsfw', size_bytes: 2048 }),
        };
    };
    try {
        const entry = await mod.addRentalLora(
            { id: 'ltx/glow.safetensors', baseModel: 'LTXV 2.3', displayName: 'Glow', name: 'glow.safetensors' },
            'nsfw',
            ['LTXV'],
        );
        assert.equal(entry.status, 'uploading');
        const body = JSON.parse(calls[0].options.body);
        assert.deepEqual(body, {
            id: 'ltx/glow.safetensors',
            rating: 'nsfw',
            baseModel: 'LTXV 2.3',
            displayName: 'Glow',
            contextBaseModels: ['LTXV'],
        });
        // The card flips to "uploading" from the POST response, not a later poll.
        assert.equal(mod.getRentalLoras().entries['ltx/glow.safetensors'].status, 'uploading');

        // Withdrawal keeps the id's subdirectory slashes for the :path route.
        await mod.removeRentalLora('ltx/glow.safetensors');
        assert.equal(calls[1].url, '/api/gpu-rentals/loras/ltx/glow.safetensors');
        assert.equal(mod.getRentalLoras().entries['ltx/glow.safetensors'], undefined);
    } finally {
        mod.resetRentalLorasForTests();
        global.fetch = originalFetch;
    }
});

test('a failed add surfaces the control API detail instead of a bare status', async () => {
    const mod = await import('../src/lib/rentalLoras.js');
    mod.resetRentalLorasForTests();
    const originalFetch = global.fetch;
    global.fetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({ detail: "no rental tier serves LoRAs for base model 'Flux.2 Klein 9B'" }),
    });
    try {
        await assert.rejects(
            () => mod.addRentalLora({ id: 'klein.safetensors' }, 'sfw', []),
            /no rental tier serves LoRAs/,
        );
        assert.equal(mod.getRentalLoras().entries, null);
    } finally {
        mod.resetRentalLorasForTests();
        global.fetch = originalFetch;
    }
});

test('the LoRA panel renders the registry-filtered catalog in Rented mode', () => {
    const section = read('src/studios/image/LoraSection.jsx');
    // The same selector UI serves local and rented — the rented difference is
    // one filter over the same catalog, not a second component.
    assert.match(section, /filterRentalLoras\(loras, rentalEntries\)/);
    assert.match(section, /visibleLoras\.map/);
    // The registry is read on relevance, not behind a ?dev=1 URL a packaged
    // window has no address bar to type; it reports 'unsupported' (and the
    // affordance stays unrendered) on a stack without the routes.
    assert.match(section, /useRentalLoras\(true\)/);
    assert.match(section, /const canManageRentals = rentalRegistry\.status === 'ready'/);
    assert.doesNotMatch(section, /devMode/);
    // Both studios pass their own Rented-source flag.
    assert.match(read('src/studios/ImageStudio.jsx'), /rentedOnly: Boolean\(s\.rentedOnly\),/);
    assert.match(read('src/studios/VideoStudio.jsx'), /rentedOnly=\{Boolean\(s\.setup\.rentedOnly\)\}/);
});

test('the rental control asks SFW or NSFW before anything is registered', () => {
    const control = read('src/studios/image/LoraRentalControl.jsx');
    // The rating question is the add flow — there is no unrated add path.
    assert.match(control, /rate it first/i);
    assert.match(control, /\['sfw', 'nsfw'\]\.map/);
    assert.match(control, /addRentalLora\(lora, rating, baseModels\)/);
    assert.match(control, /Remove from rentals/);
});
