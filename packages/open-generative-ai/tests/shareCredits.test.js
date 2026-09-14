// Sharing credits between workspaces, and the row that says whose they are.
//
// Reported: whichever workspace was signed in, the account row showed the same
// name — the account store was machine-wide while the library and settings
// were scoped. Every workspace holds its own account now, and the one thing
// a workspace may hand another is the right to SPEND its credits. What the
// browser adds is the sentence over the balance and the sheet that writes
// the policy; both are asserted here.
//
// The sheet itself goes through ui/Modal.jsx, which `createPortal`s into
// `document.body`, and the render harness stubs the document as plain
// objects — so, as creditsSheet.test.js records, there is no rendered form
// of the dialog to assert on. The rules it turns on are pure functions and
// are tested as such; the card, which is not a portal, is RENDERED.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { importComponent, renderComponent } = require('./helpers/render.js');

const SHEET = path.join(__dirname, '..', 'src', 'dialogs', 'CreditsDialog.jsx');
const SHARE = path.join(__dirname, '..', 'src', 'dialogs', 'ShareCreditsDialog.jsx');
const ROW = path.join(__dirname, '..', 'src', 'app', 'AccountRow.jsx');
const read = (file) => fs.readFileSync(file, 'utf8');

const siblings = [
  { id: 2, name: 'Second', colour: 'sand', isOwner: false, shared: true },
  { id: 3, name: 'Third', colour: 'stone', isOwner: false, shared: false },
];

test('the line over the balance says whose credits these are, in four states', async () => {
  await importComponent('src/dialogs/CreditsDialog.jsx', 'CreditsDialog');
  const { shareLine } = await import(pathToFileURL(SHEET).href);
  const { t, tf } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'i18n.js')).href);

  // Spending a sibling's: the sibling is named, whatever else is set.
  assert.equal(
    shareLine({ sharedFrom: { id: 1, name: 'Owner', isOwner: true }, workspaces: siblings, all: true }),
    tf('credits.sharedFrom', 'Owner'),
  );
  // Lent to everyone beats the picks — the rule covers workspaces added later.
  assert.equal(shareLine({ sharedFrom: null, workspaces: siblings, all: true, with: [2] }), t('credits.shareAll'));
  // Lent to the named ones only.
  assert.equal(shareLine({ sharedFrom: null, workspaces: siblings, all: false, with: [2] }), tf('credits.shareWith', 'Second'));
  // Lent to nobody.
  const nobody = siblings.map((workspace) => ({ ...workspace, shared: false }));
  assert.equal(shareLine({ sharedFrom: null, workspaces: nobody, all: false, with: [] }), t('credits.shareNone'));
  // Alone on this Mac there is nobody to share with, and nothing to say.
  assert.equal(shareLine({ sharedFrom: null, workspaces: [], all: false, with: [] }), '');
  assert.equal(shareLine(null), '');
});

test('turning the rule on keeps the picks, so turning it off gives them back', async () => {
  await importComponent('src/dialogs/ShareCreditsDialog.jsx', 'ShareCreditsDialog');
  const { shareSelection } = await import(pathToFileURL(SHARE).href);
  assert.deepEqual(shareSelection({ everyone: true, chosen: new Set([3, 2]) }), { everyone: true, workspaces: [2, 3] });
  assert.deepEqual(shareSelection({ everyone: false, chosen: new Set() }), { everyone: false, workspaces: [] });
});

test('a workspace card is a pressed toggle with the name on it, locked under the rule', async () => {
  const on = await renderComponent('src/dialogs/ShareCreditsDialog.jsx', 'WorkspaceCard', {
    workspace: siblings[0], on: true, locked: false, onToggle: () => {},
  });
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /Second/);
  assert.doesNotMatch(on, /disabled=""/);
  const locked = await renderComponent('src/dialogs/ShareCreditsDialog.jsx', 'WorkspaceCard', {
    workspace: { ...siblings[1], isOwner: true }, on: true, locked: true, onToggle: () => {},
  });
  // Every card is lit and none can be pressed while "always share" is on: the
  // sheet does not offer a choice it would ignore.
  assert.match(locked, /aria-pressed="true"/);
  assert.match(locked, /disabled=""/);
  assert.match(locked, /Third/);
});

test('the credits sheet draws the sharing row under the balance and opens the share sheet from it', () => {
  // Deliberately textual: the sheet is a portal (see the header). The row sits
  // directly under the balance card, only once the overview has loaded, and
  // the wallet rail knows the third reason it can be refused — that this is
  // not the owner's workspace.
  const body = read(SHEET);
  assert.match(body, /<BalanceCard loaded=\{loaded\} credits=\{credits\} drafts=\{drafts\} \/>\s*\{loaded \? <SharingRow sharing=\{sharing\} onShare=\{\(\) => setSharingOpen\(true\)\} \/> : null\}/);
  assert.match(body, /'other-workspace': t\('credits\.walletOtherWorkspace'\)/);
  assert.match(body, /<ShareCreditsDialog\s+sharing=\{sharing\}/);
  // A sibling spending lent credits sees whose they are and gets no share
  // button: the credits are not its to lend onward.
  assert.match(body, /\{lent \? null : \(\s*<Button variant="neutral" size="sm" icon="share" onClick=\{onShare\}>/);
});

test('the account row names whose credits a lent workspace is spending', () => {
  // Same reason: the row's subline is decided by a pure function and read
  // through the overview. With no account of its own but a sibling lending
  // to it, the balance one row down is real and the subline says whose.
  const body = read(ROW);
  assert.match(body, /if \(!identity\?\.connected\) \{\s*return sharing\?\.sharedFrom \? tf\('account\.usingShared', sharing\.sharedFrom\.name\) : t\('account\.noAccountYet'\);/);
  assert.match(body, /sublineFor\(\{ known, failed, identity, sharing: overview\?\.sharing \}\)/);
});
