const test = require('node:test');
const assert = require('node:assert/strict');

// These drive the REAL crypto path — node exposes WebCrypto as globalThis.crypto,
// so the store seals with actual AES-GCM and the fake server below records exactly
// the bytes a real server would receive. That is what makes the zero-knowledge
// assertion meaningful rather than a restatement of the mock.

const PROMPT = 'a very private prompt about my unreleased project';
const GROUP_NAME = 'Anime portrait stack';

const vault = { blobs: new Map(), identity: null, putBodies: [], failGet: null, failPut: null };

global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
global.sessionStorage = {
    getItem: () => JSON.stringify({ password: 'owner-passphrase', expiresAt: Date.now() + 60_000 }),
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
        if (method === 'GET') {
            // What control_api.get_vault_blob does: a blob that was never written
            // is 200 + ciphertext null, NOT a 404 — so every non-OK read is a real
            // failure (a lapsed session, a server error).
            if (vault.failGet) return reply(vault.failGet.body, vault.failGet.status);
            return reply({ ok: true, ciphertext: vault.blobs.has(ref) ? vault.blobs.get(ref) : null });
        }
        if (vault.failPut) return reply(vault.failPut.body, vault.failPut.status);
        vault.putBodies.push({ ref, raw: String(options.body) });
        vault.blobs.set(ref, JSON.parse(options.body).ciphertext);
        return reply({ ok: true });
    }
    return reply({}, 404);
};

const storePromise = import('../src/lib/savedLibraryStore.js');

// A clean library per test. The vault IDENTITY persists so the session stays
// unlocked — only the stored blobs are cleared.
async function store() {
    const mod = await storePromise;
    mod.__resetLibraryCache();
    vault.blobs.clear();
    vault.putBodies.length = 0;
    vault.failGet = null;
    vault.failPut = null;
    return mod;
}

test('a saved entry round-trips through the owner vault', async () => {
    const lib = await store();
    await lib.saveLibraryEntry(lib.LIBRARIES.prompts, {
        name: 'Night portrait',
        data: { section: 'image', prompt: PROMPT, context: { seed: 42, steps: 28 } },
    });

    lib.__resetLibraryCache();                      // force a real decrypt, not the cache
    const entries = await lib.loadLibrary(lib.LIBRARIES.prompts);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Night portrait');
    assert.equal(entries[0].data.prompt, PROMPT);
    assert.equal(entries[0].data.context.seed, 42);
    assert.ok(entries[0].savedAt);
});

test('the server never receives the name or the prompt in a readable form', async () => {
    const lib = await store();
    vault.putBodies.length = 0;
    await lib.saveLibraryEntry(lib.LIBRARIES.loraGroups, {
        name: GROUP_NAME,
        data: { baseLabel: 'Krea 2', loras: [{ id: 'anime.safetensors', strength: 0.8, enabled: true }] },
    });

    assert.ok(vault.putBodies.length > 0, 'nothing was sent');
    for (const { raw } of vault.putBodies) {
        assert.ok(!raw.includes(GROUP_NAME), 'the entry name reached the server in the clear');
        assert.ok(!raw.includes('anime.safetensors'), 'a LoRA filename reached the server in the clear');
        assert.ok(!raw.includes('Krea 2'), 'the base model reached the server in the clear');
    }
    // …and the same holds for what the server ends up storing.
    for (const ciphertext of vault.blobs.values()) {
        assert.ok(!ciphertext.includes(GROUP_NAME));
        assert.ok(!ciphertext.includes(PROMPT));
        assert.match(ciphertext, /^v1\./, 'blobs must be sealed envelopes');
    }
    // The server does learn the namespace/key, which are fixed and content-free.
    assert.deepEqual([...new Set(vault.putBodies.map((item) => item.ref))], ['library/lora_groups_v1']);
});

test('saving under an existing name updates that entry instead of duplicating it', async () => {
    const lib = await store();
    const first = await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Reused', data: { prompt: 'one' } });
    const second = await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: '  reused  ', data: { prompt: 'two' } });

    assert.equal(second.id, first.id, 'a same-name save must not mint a second entry');
    const matching = lib.peekLibrary(lib.LIBRARIES.prompts).filter((entry) => /reused/i.test(entry.name));
    assert.equal(matching.length, 1);
    assert.equal(matching[0].data.prompt, 'two');
});

test('entries can be renamed, and a clashing rename is refused', async () => {
    const lib = await store();
    const a = await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Alpha', data: { prompt: 'a' } });
    await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Beta', data: { prompt: 'b' } });

    await lib.renameLibraryEntry(lib.LIBRARIES.prompts, a.id, 'Alpha renamed');
    assert.ok(lib.findLibraryEntryByName(lib.LIBRARIES.prompts, 'Alpha renamed'));

    await assert.rejects(
        () => lib.renameLibraryEntry(lib.LIBRARIES.prompts, a.id, 'beta'),
        /already have/,
    );
});

test('deleting removes the entry from the sealed blob, not just the cache', async () => {
    const lib = await store();
    const doomed = await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Temporary', data: { prompt: 'x' } });
    await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Keeper', data: { prompt: 'y' } });

    await lib.deleteLibraryEntry(lib.LIBRARIES.prompts, doomed.id);
    lib.__resetLibraryCache();
    const entries = await lib.loadLibrary(lib.LIBRARIES.prompts);

    assert.deepEqual(entries.map((entry) => entry.name), ['Keeper']);
});

test('without an owner vault it refuses to save rather than falling back to plaintext', async () => {
    const lib = await store();
    window.__HIVEMIND_STUDIO__ = 0;                 // standalone: no owner vault exists
    try {
        const before = vault.putBodies.length;
        await assert.rejects(
            () => lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Nope', data: { prompt: PROMPT } }),
            (error) => error.locked === true,
        );
        assert.equal(vault.putBodies.length, before, 'a locked save must write nothing anywhere');
    } finally {
        window.__HIVEMIND_STUDIO__ = 1;
    }
});

test('an unnamed save is refused', async () => {
    const lib = await store();
    await assert.rejects(
        () => lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: '   ', data: { prompt: 'x' } }),
        /name/i,
    );
});

// ---- failure paths: a read or write the server refused must never look like
// an empty library or a successful save, because the next save would then
// replace the real, unread library with one entry.

test('a failed READ throws and caches nothing — the library is not shown as empty', async () => {
    const lib = await store();
    await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Keeper', data: { prompt: PROMPT } });
    lib.__resetLibraryCache();

    vault.failGet = { status: 401, body: { detail: 'Sign in to a workspace' } };
    await assert.rejects(() => lib.loadLibrary(lib.LIBRARIES.prompts), /Sign in to a workspace/);
    assert.equal(lib.isLibraryLoaded(lib.LIBRARIES.prompts), false, 'a failed read must not mark the library loaded');
    assert.deepEqual(lib.peekLibrary(lib.LIBRARIES.prompts), [], 'nothing is cached');

    // A save while the read is failing must not PUT a one-entry blob over the real one.
    const putsBefore = vault.putBodies.length;
    await assert.rejects(() => lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Intruder', data: { prompt: 'x' } }));
    assert.equal(vault.putBodies.length, putsBefore, 'no write happened');

    // Once the server answers again, the real library is intact.
    vault.failGet = null;
    const entries = await lib.loadLibrary(lib.LIBRARIES.prompts);
    assert.deepEqual(entries.map((entry) => entry.name), ['Keeper']);
});

test('a failed WRITE throws and leaves the cache (and the server) as they were', async () => {
    const lib = await store();
    await lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Keeper', data: { prompt: PROMPT } });

    vault.failPut = { status: 500, body: { detail: 'disk full' } };
    await assert.rejects(
        () => lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Lost', data: { prompt: 'y' } }),
        /disk full/,
    );
    assert.deepEqual(lib.peekLibrary(lib.LIBRARIES.prompts).map((entry) => entry.name), ['Keeper'],
        'the cache must not advance past what the server kept');

    // A non-OK write with no JSON body still throws, with the status in the message.
    vault.failPut = { status: 502, body: undefined };
    await assert.rejects(
        () => lib.deleteLibraryEntry(lib.LIBRARIES.prompts, lib.peekLibrary(lib.LIBRARIES.prompts)[0].id),
        /502/,
    );
    assert.equal(lib.peekLibrary(lib.LIBRARIES.prompts).length, 1, 'the entry was not dropped locally');
});

test('a blob this key cannot open is listed empty but refuses writes until confirmed', async () => {
    const lib = await store();
    // Sealed under some OTHER key: looks like a vault envelope, will not decrypt.
    vault.blobs.set('library/prompts_v1', 'v1.not-for-this-key.AAAA.BBBB');

    const entries = await lib.loadLibrary(lib.LIBRARIES.prompts);
    assert.deepEqual(entries, []);
    assert.equal(lib.isLibraryUnreadable(lib.LIBRARIES.prompts), true);

    const putsBefore = vault.putBodies.length;
    await assert.rejects(
        () => lib.saveLibraryEntry(lib.LIBRARIES.prompts, { name: 'Replacement', data: { prompt: 'z' } }),
        (error) => error.unreadable === true,
    );
    assert.equal(vault.putBodies.length, putsBefore, 'an unconfirmed save must not overwrite');

    // With consent, the replacement goes through and the flag clears.
    const saved = await lib.saveLibraryEntry(
        lib.LIBRARIES.prompts, { name: 'Replacement', data: { prompt: 'z' } }, { overwriteUnreadable: true },
    );
    assert.equal(saved.name, 'Replacement');
    assert.equal(lib.isLibraryUnreadable(lib.LIBRARIES.prompts), false);
    lib.__resetLibraryCache();
    assert.deepEqual((await lib.loadLibrary(lib.LIBRARIES.prompts)).map((entry) => entry.name), ['Replacement']);
});
