// Three ways a healthy vault used to present as a locked one.
//
// Each of these produced the same screen: a valid owner session, an "Unlock
// vault" button next to "Lock", and sealed media that would not decrypt — while
// the keys were fine the whole time. The crypto below is real WebCrypto; only
// storage and transport are faked.
const test = require('node:test');
const assert = require('node:assert/strict');

const PASSPHRASE = 'a-real-workspace-passphrase';
const prfSecret = (seed) => new Uint8Array(32).fill(seed);

function toB64url(bytes) {
    return Buffer.from(bytes).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// An in-memory IndexedDB, as in vaultPasskeyUnlock.test.js. `failKeys` makes a
// single record unreadable, which is how a browser with a live wrap but no
// usable device key is reproduced.
function installFakeIndexedDb({ failKeys = new Set() } = {}) {
    const databases = new Map();
    globalThis.indexedDB = {
        open(name) {
            const data = databases.get(name) || new Map();
            databases.set(name, data);
            const request = {};
            queueMicrotask(() => {
                const store = {
                    get(key) {
                        const get = {};
                        queueMicrotask(() => {
                            if (failKeys.has(key)) {
                                get.error = new Error(`unreadable: ${key}`);
                                get.onerror?.();
                                return;
                            }
                            get.result = data.get(key);
                            get.onsuccess?.();
                        });
                        return get;
                    },
                    put(value, key) {
                        const put = {};
                        queueMicrotask(() => { data.set(key, value); put.onsuccess?.(); });
                        return put;
                    },
                    delete(key) {
                        const del = {};
                        queueMicrotask(() => { data.delete(key); del.onsuccess?.(); });
                        return del;
                    },
                };
                request.result = {
                    objectStoreNames: { contains: () => true },
                    createObjectStore: () => store,
                    close: () => {},
                    transaction() {
                        const tx = { objectStore: () => store };
                        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
                        return tx;
                    },
                };
                request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
    return databases.get('hivemind-device-identity') || databases.set('hivemind-device-identity', new Map()).get('hivemind-device-identity');
}

async function freshVault() {
    const vault = await import('../src/lib/e2eVault.js');
    const { identity } = await vault.createVaultIdentity(PASSPHRASE);
    vault.lockVault();
    return { vault, identity };
}

// ── a device wrap that cannot be used is dropped, not kept forever ───────────

test('a wrap sealed to a device key this browser no longer has is deleted', async () => {
    const store = installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    const device = await import('../src/lib/deviceIdentity.js');
    device.__test.reset();

    assert.equal(await vault.rememberOnThisDevice(identity, PASSPHRASE, 1), true);
    // The browser regenerates its device keypair: the wrap is now RSA ciphertext
    // for a private key that no longer exists anywhere.
    store.delete('e2e-device-v1');
    device.__test.reset();
    assert.ok(store.get('vault-mk-wrap-v1:1'), 'the wrap is still on disk');

    assert.equal(await vault.unlockWithDevice(identity, 1), false);
    assert.equal(vault.isVaultUnlocked(), false);
    assert.equal(store.get('vault-mk-wrap-v1:1'), undefined,
        'a wrap that cannot be opened is dropped, so it stops failing on every reload');
});

test('a wrap holding a superseded identity\'s master key is deleted', async () => {
    const store = installFakeIndexedDb();
    const { vault, identity: old } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();
    await vault.rememberOnThisDevice(old, PASSPHRASE, 1);
    vault.lockVault();

    // The vault is recreated: same browser, same device key. The wrap opens —
    // the master key inside simply no longer unwraps the current private key.
    const { identity: current } = await vault.createVaultIdentity(PASSPHRASE);
    vault.lockVault();
    assert.ok(store.get('vault-mk-wrap-v1:1'), 'the stale wrap is still on disk');

    assert.equal(await vault.unlockWithDevice(current, 1), false);
    assert.equal(vault.isVaultUnlocked(), false);
    assert.equal(store.get('vault-mk-wrap-v1:1'), undefined,
        'a wrap that does not fit this identity is dropped rather than retried forever');
    // The passphrase still works — this was a dead shortcut, not a lost vault.
    assert.equal(await vault.unlockWithPassphrase(current, PASSPHRASE), true);
});

test('a wrap is kept when the device key is merely unavailable right now', async () => {
    const store = installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    const device = await import('../src/lib/deviceIdentity.js');
    device.__test.reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);

    // The wrap reads fine; the device keypair does not. That is a browser
    // problem, not a bad wrap — deleting here would destroy a working shortcut.
    installFakeIndexedDbOver(store, new Set(['e2e-device-v1']));
    device.__test.reset();

    assert.equal(await vault.unlockWithDevice(identity, 1), false);
    assert.ok(store.get('vault-mk-wrap-v1:1'), 'the wrap survives a transient device-key failure');
});

// Re-point the fake at the SAME backing map, with some keys made unreadable.
function installFakeIndexedDbOver(store, failKeys) {
    globalThis.indexedDB = {
        open() {
            const request = {};
            queueMicrotask(() => {
                const objectStore = {
                    get(key) {
                        const get = {};
                        queueMicrotask(() => {
                            if (failKeys.has(key)) { get.error = new Error('unreadable'); get.onerror?.(); return; }
                            get.result = store.get(key);
                            get.onsuccess?.();
                        });
                        return get;
                    },
                    put(value, key) {
                        const put = {};
                        queueMicrotask(() => { store.set(key, value); put.onsuccess?.(); });
                        return put;
                    },
                    delete(key) {
                        const del = {};
                        queueMicrotask(() => { store.delete(key); del.onsuccess?.(); });
                        return del;
                    },
                };
                request.result = {
                    objectStoreNames: { contains: () => true },
                    createObjectStore: () => objectStore,
                    close: () => {},
                    transaction() {
                        const tx = { objectStore: () => objectStore };
                        queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
                        return tx;
                    },
                };
                request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        },
    };
}

// ── a passkey can be enrolled for PRF from a device unlock ───────────────────

test('the device wrap can enrol a PRF wrap without the passphrase', async () => {
    installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();
    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    vault.lockVault();

    const wrapped = await vault.wrapMasterKeyForPrfWithDevice(1, prfSecret(3));
    assert.ok(wrapped && wrapped.includes('.'), 'enrolment returns an iv.ciphertext blob');

    // It is the SAME master key: the PRF wrap opens the real vault.
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': wrapped }) };
    assert.equal(await vault.unlockWithPrf(enrolled, 'cred-1', prfSecret(3)), true);
    const blob = await vault.encryptJson({ note: 'sealed after a device unlock' });
    vault.lockVault();
    assert.equal(await vault.unlockWithPassphrase(identity, PASSPHRASE), true);
    assert.deepEqual(await vault.decryptJson(blob), { note: 'sealed after a device unlock' });
});

test('enrolling from a device with nothing remembered yields nothing to store', async () => {
    installFakeIndexedDb();
    const { vault } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();
    assert.equal(await vault.wrapMasterKeyForPrfWithDevice(9, prfSecret(4)), null);
});
