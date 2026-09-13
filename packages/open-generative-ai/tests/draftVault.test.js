// The draft vault: typed text that survives a reload, readable only by the
// browser that wrote it.
//
// Node has WebCrypto but no IndexedDB and no localStorage, so both are stood up
// here — IndexedDB as the thin get/put the module actually uses, holding the
// CryptoKey OBJECT (which is the point: the real one persists the key by
// structured clone, never as bytes).

import test from 'node:test';
import assert from 'node:assert/strict';

function installStorage() {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
    };
    return store;
}

// Minimal IndexedDB: one database, one store, get/put/delete by key. Values are
// held by reference, so a CryptoKey goes in and the same CryptoKey comes out —
// which is what the browser guarantees for a non-extractable key.
function installIndexedDb(records = new Map()) {
    const request = (run) => {
        const req = {};
        queueMicrotask(() => {
            try {
                req.result = run();
                req.onsuccess?.();
            } catch (error) {
                req.error = error;
                req.onerror?.();
            }
        });
        return req;
    };
    const objectStore = {
        get: (key) => request(() => records.get(key)),
        put: (value, key) => request(() => { records.set(key, value); return undefined; }),
        delete: (key) => request(() => { records.delete(key); return undefined; }),
    };
    globalThis.indexedDB = {
        open: () => {
            const req = { result: { objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {}, transaction: () => ({ objectStore: () => objectStore }) } };
            queueMicrotask(() => req.onsuccess?.());
            return req;
        },
    };
    return records;
}

// Past the write debounce AND the encrypt that follows it. Deliberately not a
// peek at module internals: what these tests assert is what a real page leaves
// behind, so they wait for it the way a real page would.
const settle = () => new Promise((resolve) => setTimeout(resolve, 420));

async function freshModule() {
    // A cache-busting import gives each test its own module state without
    // reaching into the module's internals for a reset.
    return import(`../src/lib/draftVault.js?t=${Math.random()}`);
}

test('a draft written in one page life is readable in the next', async () => {
    const storage = installStorage();
    const records = installIndexedDb();

    const first = await freshModule();
    await first.hydrateDrafts();
    first.writeDraft('image:1', { prompt: 'a red fox in snow' });
    await settle();

    // Same browser: same localStorage, same IndexedDB, new page.
    installStorage.store = storage;
    installIndexedDb(records);
    const second = await freshModule();
    assert.equal(second.hasStoredDrafts(), true);
    await second.hydrateDrafts();
    assert.deepEqual(second.readDraft('image:1'), { prompt: 'a red fox in snow' });
});

test('what lands in storage is ciphertext, not the words', async () => {
    const storage = installStorage();
    installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('video:2', { setup: { prompt: 'a whale breaches at dusk' }, cast: [{ name: 'Ada' }] });
    await settle();

    const raw = storage.get('hivemind.drafts.v1');
    assert.ok(raw, 'nothing was persisted at all');
    for (const secret of ['whale', 'breaches', 'dusk', 'Ada']) {
        assert.doesNotMatch(raw, new RegExp(secret, 'i'), `"${secret}" is readable in storage`);
    }
    assert.match(raw, /^v1\./, 'not the versioned envelope');
});

test('the key is non-extractable, so the words cannot be lifted out of the store', async () => {
    installStorage();
    const records = installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('image:1', { prompt: 'secret' });
    await settle();

    const key = records.get('draft-key-v1').key;
    assert.equal(key.extractable, false);
    await assert.rejects(() => crypto.subtle.exportKey('raw', key));
});

test('a browser that cannot hold a key persists nothing — it never falls back to plaintext', async () => {
    const storage = installStorage();
    globalThis.indexedDB = undefined;
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('image:1', { prompt: 'a red fox in snow' });
    await settle();
    assert.equal(storage.get('hivemind.drafts.v1'), undefined);
});

test('a blob no key can open is dropped, but one this browser merely cannot reach today is kept', async () => {
    // Cleared site data: the ciphertext outlives the key that wrote it.
    const storage = installStorage();
    installIndexedDb();
    const first = await freshModule();
    await first.hydrateDrafts();
    first.writeDraft('image:1', { prompt: 'gone' });
    await settle();
    const ciphertext = storage.get('hivemind.drafts.v1');

    installIndexedDb(new Map()); // a fresh profile: new key, same blob
    const second = await freshModule();
    await second.hydrateDrafts();
    assert.equal(second.readDraft('image:1'), null);
    assert.equal(storage.get('hivemind.drafts.v1'), undefined, 'undecryptable bytes were kept');

    // IndexedDB switched off is a different case: the draft may open later.
    storage.set('hivemind.drafts.v1', ciphertext);
    globalThis.indexedDB = undefined;
    const third = await freshModule();
    await third.hydrateDrafts();
    assert.equal(storage.get('hivemind.drafts.v1'), ciphertext, 'a recoverable draft was thrown away');
});

test('clearing a text input stops it being remembered', async () => {
    installStorage();
    installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('image:1', { prompt: 'something' });
    await settle();
    vault.writeDraft('image:1', {});
    await settle();
    assert.equal(vault.readDraft('image:1'), null);
});

test('forgetting drafts destroys the key as well as the ciphertext', async () => {
    const storage = installStorage();
    const records = installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('image:1', { prompt: 'a red fox' });
    await settle();

    await vault.forgetDrafts();
    assert.equal(storage.get('hivemind.drafts.v1'), undefined);
    assert.equal(records.has('draft-key-v1'), false, 'the key outlived the drafts it opened');
});

test('the store is bounded, and it is the oldest drafts that go', async () => {
    installStorage();
    installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    for (let i = 1; i <= 70; i += 1) vault.writeDraft(`image:${i}`, { prompt: `draft ${i}` });
    await settle();
    assert.equal(vault.readDraft('image:70').prompt, 'draft 70');
    assert.equal(vault.readDraft('image:1'), null, 'the oldest draft was kept over the newest');
});

test('dropDrafts forgets the scopes a predicate rejects', async () => {
    installStorage();
    installIndexedDb();
    const vault = await freshModule();
    await vault.hydrateDrafts();
    vault.writeDraft('image:1', { prompt: 'kept' });
    vault.writeDraft('image:2', { prompt: 'closed' });
    vault.writeDraft('video:1', { setup: { prompt: 'another studio' } });
    await settle();

    vault.dropDrafts((scope) => !scope.startsWith('image:') || scope === 'image:1');
    assert.ok(vault.readDraft('image:1'));
    assert.equal(vault.readDraft('image:2'), null);
    assert.ok(vault.readDraft('video:1'), 'another studio lost a draft it still owns');
});
