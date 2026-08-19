// Passkey unlock paths for the E2E vault: the PRF wrap and the device wrap.
//
// These run against real WebCrypto (Node's globalThis.crypto), so a wrap that
// does not actually round-trip fails here rather than on someone's phone. The
// device-wrap tests need IndexedDB, which Node has not got, so the store is
// faked at the smallest possible surface — the crypto is still real.
const test = require('node:test');
const assert = require('node:assert/strict');

// An in-memory IndexedDB just faithful enough for the two consumers here:
// deviceIdentity.js (open → transaction → get/put → db.close()) and the vault's
// own device-wrap store. Values are held as-is, which is what a real
// structured clone does for a CryptoKey — the property that lets a
// non-extractable private key be persisted without ever becoming bytes.
//
// Everything cryptographic below is real; only the storage is faked.
function installFakeIndexedDb() {
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
                        queueMicrotask(() => { get.result = data.get(key); get.onsuccess?.(); });
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
                        // Both consumers resolve off the REQUEST; the vault's
                        // delete path also waits on the transaction, so fire
                        // oncomplete on the next turn once handlers are set.
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
    return databases;
}

const PASSPHRASE = 'a-real-workspace-passphrase';

async function freshVault() {
    const vault = await import('../src/lib/e2eVault.js');
    const { identity } = await vault.createVaultIdentity(PASSPHRASE);
    vault.lockVault();
    return { vault, identity };
}

// A PRF secret is 32 opaque bytes from the authenticator. Its provenance does
// not matter to the vault, only that it is stable — which is exactly what the
// tests below pin down.
const prfSecret = (seed) => new Uint8Array(32).fill(seed);

test('a PRF secret wraps and then unwraps the same master key', async () => {
    const { vault, identity } = await freshVault();
    const wrapped = await vault.wrapMasterKeyForPrf(identity, PASSPHRASE, prfSecret(7));
    assert.ok(wrapped && wrapped.includes('.'), 'enrolment returns an iv.ciphertext blob');

    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': wrapped }) };
    assert.equal(await vault.unlockWithPrf(enrolled, 'cred-1', prfSecret(7)), true);
    assert.equal(vault.isVaultUnlocked(), true);

    // The unlocked session is the SAME vault: something sealed under the
    // passphrase unlock reads back after a PRF unlock.
    const blob = await vault.encryptJson({ note: 'sealed under passkey' });
    vault.lockVault();
    await vault.unlockWithPassphrase(enrolled, PASSPHRASE);
    assert.deepEqual(await vault.decryptJson(blob), { note: 'sealed under passkey' });
});

test('a different PRF secret does not unlock, and reports rather than throws', async () => {
    const { vault, identity } = await freshVault();
    const wrapped = await vault.wrapMasterKeyForPrf(identity, PASSPHRASE, prfSecret(7));
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': wrapped }) };

    assert.equal(await vault.unlockWithPrf(enrolled, 'cred-1', prfSecret(8)), false);
    assert.equal(vault.isVaultUnlocked(), false, 'a failed unwrap leaves the vault locked');
});

test('an unenrolled credential is a clean miss, not an error', async () => {
    const { vault, identity } = await freshVault();
    assert.equal(await vault.unlockWithPrf(identity, 'never-enrolled', prfSecret(1)), false);
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': 'x.y' }) };
    assert.equal(await vault.unlockWithPrf(enrolled, 'cred-2', prfSecret(1)), false);
    // Corrupt JSON in the column must not take the sign-in screen down with it.
    assert.equal(await vault.unlockWithPrf({ ...identity, wrapped_mk_prf: '{oh no' }, 'c', prfSecret(1)), false);
});

test('enrolling with the wrong passphrase yields nothing to store', async () => {
    const { vault, identity } = await freshVault();
    assert.equal(await vault.wrapMasterKeyForPrf(identity, 'not-the-passphrase', prfSecret(7)), null);
});

test('each passkey gets its own wrap of the one master key', async () => {
    const { vault, identity } = await freshVault();
    const first = await vault.wrapMasterKeyForPrf(identity, PASSPHRASE, prfSecret(1));
    const second = await vault.wrapMasterKeyForPrf(identity, PASSPHRASE, prfSecret(2));
    assert.notEqual(first, second);
    const enrolled = { ...identity, wrapped_mk_prf: JSON.stringify({ phone: first, laptop: second }) };
    assert.equal(await vault.unlockWithPrf(enrolled, 'phone', prfSecret(1)), true);
    vault.lockVault();
    assert.equal(await vault.unlockWithPrf(enrolled, 'laptop', prfSecret(2)), true);
    // ...and a credential cannot be unlocked with its sibling's secret.
    vault.lockVault();
    assert.equal(await vault.unlockWithPrf(enrolled, 'phone', prfSecret(2)), false);
});

test('a device remembers the master key and can unlock without the passphrase', async () => {
    installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    const device = await import('../src/lib/deviceIdentity.js');
    device.__test.reset();

    assert.equal(await vault.unlockWithDevice(identity, 1), false, 'nothing remembered yet');
    assert.equal(await vault.rememberOnThisDevice(identity, PASSPHRASE, 1), true);
    vault.lockVault();

    assert.equal(await vault.unlockWithDevice(identity, 1), true);
    assert.equal(vault.isVaultUnlocked(), true);
});

test('a remembered device copy is scoped to one workspace', async () => {
    installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    vault.lockVault();
    // Account 2 has its own key on this same browser; account 1's copy is not it.
    assert.equal(await vault.unlockWithDevice(identity, 2), false);
    assert.equal(vault.isVaultUnlocked(), false);
    assert.equal(await vault.unlockWithDevice(identity, 1), true);
});

test('forgetting the device removes the shortcut but not the account', async () => {
    installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    await vault.rememberOnThisDevice(identity, PASSPHRASE, 1);
    await vault.forgetThisDevice(1);
    vault.lockVault();
    assert.equal(await vault.unlockWithDevice(identity, 1), false);
    // The passphrase still works — forgetting a device is not losing the vault.
    assert.equal(await vault.unlockWithPassphrase(identity, PASSPHRASE), true);
});

test('remembering with the wrong passphrase stores nothing', async () => {
    installFakeIndexedDb();
    const { vault, identity } = await freshVault();
    (await import('../src/lib/deviceIdentity.js')).__test.reset();

    assert.equal(await vault.rememberOnThisDevice(identity, 'wrong', 1), false);
    assert.equal(await vault.unlockWithDevice(identity, 1), false);
});
