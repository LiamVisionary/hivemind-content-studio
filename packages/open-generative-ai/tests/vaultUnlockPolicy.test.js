// One rule for what an unlock screen shows, and the proof that both screens
// still obey the same copy of it.
//
// The bug this exists to prevent already happened: the sign-in gate led with
// the passkey and the in-app modal never mentioned one, so the same workspace
// offered Touch ID on one screen and demanded typing on the other. The two
// could not import from each other — the gate is a standalone page because
// /assets is behind the gate it guards — and nothing compared them.
//
// So the rule is authored once, in src/lib/vaultUnlockPolicy.js, between two
// markers, and account_gate.py carries that block verbatim. The first test
// below compares them character by character; the rest run the shipped source
// through every combination of (passkey, password, WebAuthn) there is.
//
// Deliberately textual: the claim is about which SOURCE each screen decides
// from, not about what one render happens to paint. A render can agree by
// coincidence — that is exactly how the two drifted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'lib', 'vaultUnlockPolicy.js');
const GATE = path.join(__dirname, '..', '..', '..', 'src', 'hivemind_content_studio', 'account_gate.py');
const MODAL = path.join(ROOT, 'src', 'bridges', 'VaultUnlockModal.jsx');

const OPEN = '// >>> vault-unlock-policy';
const CLOSE = '// <<< vault-unlock-policy';

function block(file) {
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf(OPEN);
    const end = source.indexOf(CLOSE);
    assert.ok(start >= 0 && end > start, `${path.basename(file)} still marks the shared policy block`);
    return source.slice(start, end + CLOSE.length);
}

/** The shipped source, evaluated — not a re-implementation of it. */
function policyFrom(file) {
    // eslint-disable-next-line no-new-func — evaluating what ships is the test
    return new Function(`${block(file)}\nreturn { vaultUnlockOptions, vaultPrfSalt, VAULT_PRF_SALT_LABEL };`)();
}

const OPTION_KEYS = ['passkey', 'password', 'divider', 'enrol', 'enrolDefault', 'stuck'];

const workspace = (has_passkey, has_password) => ({ id: 1, has_passkey, has_password });

test('the gate carries the module\'s policy block verbatim', () => {
    assert.equal(
        block(GATE),
        block(MODULE),
        'account_gate.py and lib/vaultUnlockPolicy.js have drifted — copy the module\'s block over the gate\'s',
    );
});

test('both copies answer identically for every workspace a person can meet', () => {
    const fromModule = policyFrom(MODULE).vaultUnlockOptions;
    const fromGate = policyFrom(GATE).vaultUnlockOptions;
    for (const hasPasskey of [true, false]) {
        for (const hasPassword of [true, false]) {
            for (const webauthn of [true, false, undefined, null, {}]) {
                const account = workspace(hasPasskey, hasPassword);
                assert.deepEqual(
                    fromModule(account, webauthn),
                    fromGate(account, webauthn),
                    `(passkey ${hasPasskey}, password ${hasPassword}, webauthn ${String(webauthn)})`,
                );
            }
        }
    }
});

test('a workspace with a passkey always shows BOTH ways in', () => {
    const { vaultUnlockOptions } = policyFrom(MODULE);
    const both = vaultUnlockOptions(workspace(true, true), {});
    assert.equal(both.passkey, true, 'the passkey is offered');
    assert.equal(both.password, true, 'and the password is never taken away for it');
    assert.equal(both.divider, true, 'with the divider that only two things earn');
    assert.equal(both.enrol, false, 'nothing to add — it already has one');
    assert.equal(both.stuck, false);
});

test('a passkey the browser cannot run never hides the password', () => {
    const { vaultUnlockOptions } = policyFrom(MODULE);
    const noWebauthn = vaultUnlockOptions(workspace(true, true), undefined);
    assert.equal(noWebauthn.passkey, false, 'a button that could only refuse is not shown');
    assert.equal(noWebauthn.password, true, 'and the way in that does work still is');
    assert.equal(noWebauthn.divider, false, 'nothing on one side of it');
    assert.equal(noWebauthn.enrol, false, 'no enrolling either — the ceremony needs WebAuthn');
});

test('a workspace with no passkey always offers to add one, and the offer starts off', () => {
    const { vaultUnlockOptions } = policyFrom(MODULE);
    const none = vaultUnlockOptions(workspace(false, true), {});
    assert.equal(none.enrol, true, 'the offer is always there');
    assert.equal(none.enrolDefault, false, 'and always off: a biometric prompt is asked for, never defaulted to');
    assert.equal(none.passkey, false, 'there is none to unlock with yet');
    assert.equal(none.password, true);
});

test('a passkey-only workspace in a browser without WebAuthn says so instead of showing a dead form', () => {
    const { vaultUnlockOptions } = policyFrom(MODULE);
    const stuck = vaultUnlockOptions(workspace(true, false), false);
    assert.equal(stuck.stuck, true);
    assert.equal(stuck.password, false, 'an account with no password gets no password field');
    assert.equal(stuck.passkey, false);
    // …and the same workspace in a browser that CAN is not stuck at all.
    assert.equal(vaultUnlockOptions(workspace(true, false), {}).stuck, false);
});

test('an absent workspace resolves to every flag off rather than throwing', () => {
    const { vaultUnlockOptions } = policyFrom(MODULE);
    // Both screens compute options while the account is still being read.
    for (const absent of [null, undefined]) {
        const options = vaultUnlockOptions(absent, {});
        assert.deepEqual(Object.keys(options).sort(), [...OPTION_KEYS].sort());
        assert.equal(options.passkey, false);
        assert.equal(options.password, false);
        assert.equal(options.enrol, false);
    }
});

test('the PRF salt is the same bytes on both screens, and is bound to the account', async () => {
    const fromModule = policyFrom(MODULE);
    const fromGate = policyFrom(GATE);
    assert.equal(fromModule.VAULT_PRF_SALT_LABEL, 'hivemind-content-studio/vault-prf/v1');
    assert.equal(fromGate.VAULT_PRF_SALT_LABEL, fromModule.VAULT_PRF_SALT_LABEL);

    const hex = (bytes) => Buffer.from(bytes).toString('hex');
    const mine = await fromModule.vaultPrfSalt(7);
    assert.equal(mine.length, 32, 'SHA-256, as the wrap expects');
    assert.equal(hex(mine), hex(await fromGate.vaultPrfSalt(7)), 'a passkey enrolled on one screen unlocks on the other');
    // Bound to the account: one workspace's PRF wrap must not open another's.
    assert.notEqual(hex(mine), hex(await fromModule.vaultPrfSalt(8)));
});

test('neither screen decides any of this for itself', () => {
    const modal = fs.readFileSync(MODAL, 'utf8');
    const gate = fs.readFileSync(GATE, 'utf8');

    assert.match(modal, /vaultUnlockOptions\(/, 'the modal asks the policy');
    assert.match(gate, /const options = vaultUnlockOptions\(account, window\.PublicKeyCredential\);/,
        'and so does the gate\'s sign-in card');

    // The shape of the old bug: the screen that lays out the sign-in controls
    // reading the server's flags itself and drawing its own conclusion. The
    // gate's other `has_passkey` readers are asking different questions — a
    // tile's "Passkey" badge, whether the OWNER can approve a new workspace —
    // and are none of this rule's business.
    const choose = gate.slice(gate.indexOf('function choose(account) {'));
    assert.ok(choose, 'the gate still lays its sign-in card out in choose()');
    const body = choose.slice(0, choose.indexOf('\n}\n') + 1);
    assert.doesNotMatch(body, /has_passkey|has_password/, 'choose() decides nothing for itself');
    assert.doesNotMatch(modal, /has_passkey|has_password/, 'and neither does the modal');

    // The toggle's default comes from the policy too — a `useState(false)` here
    // would be a second place for "off by default" to live and to change.
    assert.match(modal, /enrolDefault/, 'the modal takes the toggle default from the policy');
    assert.match(gate, /el\('enrol-after'\)\.checked = options\.enrolDefault;/, 'and so does the gate');
});
