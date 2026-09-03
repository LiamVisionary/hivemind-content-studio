// The recovery key can never be swallowed.
//
// The modal used to persist a GLOBAL "acknowledged" flag in localStorage. Vault
// identity is per account, so on any browser where workspace A had acknowledged
// its key, workspace B's key — announced once, on its first sign-in — was
// buffered, filtered out by the flag, and never shown. That was the second
// person on a shared Mac losing their only recovery path without seeing it.
//
// The buffer is in-memory and the key is announced exactly once per vault
// creation, so the flag protected nothing; the modal now shows every key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// recoveryKeyBuffer.js registers its listener on `window` at import time.
global.window = new EventTarget();

const announce = (recoveryKey, accountId) =>
    window.dispatchEvent(new CustomEvent('hivemind-vault-recovery-key', { detail: { recoveryKey, accountId } }));

test('two workspaces on one browser: the second key reaches a fresh subscriber after the first was acknowledged', async () => {
    const buffer = await import('../src/bridges/recoveryKeyBuffer.js');

    // Workspace A signs in for the first time; the modal is mounted and acknowledges.
    const seenByA = [];
    const unsubscribeA = buffer.subscribeRecoveryKey((key) => seenByA.push(key));
    announce('AAAA-AAAA-AAAA-AAAA', 1);
    assert.deepEqual(seenByA, ['AAAA-AAAA-AAAA-AAAA']);
    buffer.clearBufferedRecoveryKey(); // what Continue does
    unsubscribeA();

    // Workspace B signs in on the same profile; a fresh modal subscribes.
    const seenByB = [];
    buffer.subscribeRecoveryKey((key) => seenByB.push(key));
    announce('BBBB-BBBB-BBBB-BBBB', 2);
    assert.deepEqual(seenByB, ['BBBB-BBBB-BBBB-BBBB'], 'workspace B sees its own key');
});

test('a key announced before the modal mounts is still delivered', async () => {
    const buffer = await import('../src/bridges/recoveryKeyBuffer.js');
    buffer.clearBufferedRecoveryKey();
    announce('CCCC-CCCC-CCCC-CCCC', 3);
    const seen = [];
    buffer.subscribeRecoveryKey((key) => seen.push(key));
    assert.deepEqual(seen, ['CCCC-CCCC-CCCC-CCCC']);
});

test('the modal keeps no persisted ack, and the dead banner that carried the same flag is gone', () => {
    const src = path.join(__dirname, '..', 'src');
    const modal = fs.readFileSync(path.join(src, 'bridges', 'VaultRecoveryModal.jsx'), 'utf8');
    assert.doesNotMatch(modal, /localStorage/, 'no storage-backed ack in the modal');
    assert.doesNotMatch(modal, /recoveryAck|ACK_KEY|alreadyAcked/, 'no global ack flag');
    // The subscriber sets whatever key arrives — no filter in front of it.
    assert.match(modal, /subscribeRecoveryKey\(setRecoveryKey\)/);
    // Continue still clears the buffer so the same key is not re-shown on remount.
    assert.match(modal, /clearBufferedRecoveryKey\(\);\s*\n\s*setRecoveryKey\(null\)/);

    assert.equal(fs.existsSync(path.join(src, 'lib', 'vaultRecoveryBanner.js')), false, 'vaultRecoveryBanner.js is deleted');
    const importers = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(jsx?|tsx?)$/.test(entry.name) && /vaultRecoveryBanner/.test(fs.readFileSync(full, 'utf8'))) importers.push(full);
        }
    };
    walk(src);
    assert.deepEqual(importers, [], 'nothing references the banner');
});
