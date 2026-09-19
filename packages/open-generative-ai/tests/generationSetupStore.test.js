const test = require('node:test');
const assert = require('node:assert/strict');

// Real crypto (node exposes WebCrypto as globalThis.crypto) against an in-memory
// stand-in for the vault API, so these exercise the actual seal → store → look-up
// path rather than a mock of it.

const vault = { blobs: new Map(), identity: null };

global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
global.sessionStorage = {
    getItem: () => JSON.stringify({ password: 'test-only-passphrase', expiresAt: Date.now() + 60_000 }),
    setItem() {},
    removeItem() {},
};
global.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/vault/identity') {
        if (method === 'GET') return reply(vault.identity ? { exists: true, identity: vault.identity } : { exists: false });
        vault.identity = JSON.parse(options.body).identity;
        return reply({ ok: true });
    }
    const match = /^\/api\/vault\/blob\/([^/]+)\/([^/]+)$/.exec(url);
    if (match) {
        const ref = `${match[1]}/${match[2]}`;
        if (method === 'GET') return vault.blobs.has(ref) ? reply({ ciphertext: vault.blobs.get(ref) }) : reply({}, 404);
        vault.blobs.set(ref, JSON.parse(options.body).ciphertext);
        return reply({ ok: true });
    }
    return reply({}, 404);
};

const storePromise = import('../src/lib/generationSetupStore.js');

// A reference big enough to be worth omitting (the budget is 128 KB).
const FAT_REFERENCE = `data:image/png;base64,${'A'.repeat(200 * 1024)}`;
const SMALL_REFERENCE = 'data:image/png;base64,AAAABBBBCCCC';

test('an oversized inline reference is not sealed, but every setting is', async () => {
    const { compactContextForSeal } = await storePromise;

    const compacted = compactContextForSeal({
        prompt: 'a moonlit alley',
        seed: 42,
        steps: 28,
        loras: [{ id: 'anime.safetensors', strength: 0.8 }],
        referenceImages: [FAT_REFERENCE, SMALL_REFERENCE],
    });

    assert.equal(compacted.prompt, 'a moonlit alley');
    assert.equal(compacted.seed, 42);
    assert.deepEqual(compacted.loras, [{ id: 'anime.safetensors', strength: 0.8 }]);
    assert.equal(compacted.omittedReferences, 1);
    // The small one survives verbatim; the fat one became a marker.
    assert.equal(compacted.referenceImages[1], SMALL_REFERENCE);
    assert.ok(!compacted.referenceImages[0].includes('AAAA'));
    assert.ok(JSON.stringify(compacted).length < 64 * 1024, 'the sealed payload must stay small');
});

test('omitted references are stripped on the way out, never handed to a studio', async () => {
    const { compactContextForSeal, rehydrateSealedContext } = await storePromise;

    const restored = rehydrateSealedContext(compactContextForSeal({
        prompt: 'p',
        referenceImages: [FAT_REFERENCE, SMALL_REFERENCE],
        ingredientImages: [{ image: FAT_REFERENCE, description: 'front' }, { image: SMALL_REFERENCE, description: 'side' }],
        imageUrl: FAT_REFERENCE,
    }));

    assert.deepEqual(restored.referenceImages, [SMALL_REFERENCE], 'a marker must not survive as a reference');
    assert.deepEqual(restored.ingredientImages, [{ image: SMALL_REFERENCE, description: 'side' }]);
    assert.equal(restored.imageUrl, '', 'a scalar marker becomes empty, not a broken src');
    assert.equal(restored.omittedReferences, 3);
});

test('nested objects deep in a context are compacted too', async () => {
    const { compactContextForSeal } = await storePromise;
    const compacted = compactContextForSeal({
        advancedValues: { nested: { frame: FAT_REFERENCE } },
        ingredientSheets: [{ image: FAT_REFERENCE }],
    });
    assert.ok(!JSON.stringify(compacted).includes('AAAA'));
    assert.equal(compacted.omittedReferences, 2);
});

test('a context with no oversized media is sealed unchanged', async () => {
    const { compactContextForSeal } = await storePromise;
    const context = { prompt: 'p', seed: 1, referenceImages: [SMALL_REFERENCE] };
    const compacted = compactContextForSeal(context);
    assert.deepEqual(compacted, context);
    assert.equal(compacted.omittedReferences, undefined, 'no omissions means no marker field');
});

test('filename variants cover the shapes a Downloads folder produces', async () => {
    const { basenameVariants } = await storePromise;

    assert.deepEqual(basenameVariants('krea2-abc123.jpg'), ['krea2-abc123.jpg', 'krea2-abc123']);
    // Browser duplicate-download suffix.
    assert.deepEqual(
        basenameVariants('krea2-abc123 (1).jpg'),
        ['krea2-abc123 (1).jpg', 'krea2-abc123.jpg', 'krea2-abc123 (1)', 'krea2-abc123'],
    );
    assert.deepEqual(basenameVariants(''), []);
});

test('a downloaded file re-dropped under a rewritten name still resolves', async () => {
    const { rememberGenerationSetup, resolveGenerationSetup } = await storePromise;

    await rememberGenerationSetup({
        url: '/api/media-studio/generated/opaque-name.png',
        section: 'image',
        mediaType: 'image/*',
        context: { prompt: 'restored by filename', seed: 7 },
        downloadName: 'krea2-abc123.jpg',
    });

    // Dragged straight from Downloads, second copy, extension rewritten by the OS.
    for (const dropped of ['krea2-abc123.jpg', 'krea2-abc123 (2).jpg', 'krea2-abc123.png']) {
        const hit = await resolveGenerationSetup({ url: null, basename: dropped });
        assert.ok(hit?.context, `no match for ${dropped}`);
        assert.equal(hit.context.prompt, 'restored by filename');
        assert.equal(hit.context.seed, 7);
    }
});

test('a genuinely unknown file resolves to null, not a false positive', async () => {
    const { resolveGenerationSetup } = await storePromise;
    assert.equal(await resolveGenerationSetup({ url: null, basename: 'someone-elses-photo.jpg' }), null);
});

test('a restored fat-reference generation reports what to re-attach', async () => {
    const { rememberGenerationSetup, resolveGenerationSetup } = await storePromise;

    await rememberGenerationSetup({
        url: '/api/media-studio/generated/with-refs.png',
        section: 'image',
        mediaType: 'image/*',
        context: { prompt: 'had references', referenceImages: [FAT_REFERENCE] },
        downloadName: 'wai-anima-xyz.jpg',
    });

    const hit = await resolveGenerationSetup({ url: null, basename: 'wai-anima-xyz.jpg' });
    assert.equal(hit.context.prompt, 'had references');
    assert.deepEqual(hit.context.referenceImages, []);
    assert.equal(hit.omittedReferences, 1);
    assert.equal(hit.fidelity, 'settings');
});
