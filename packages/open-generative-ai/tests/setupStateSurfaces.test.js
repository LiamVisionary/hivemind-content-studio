// The first screen has something to press.
//
// Source scans, because these are JSX render paths with no headless renderer in
// this suite. Each one guards a specific regression the audit found: an empty
// state whose only action opened an empty library, a Video empty state that
// explained LTX ingredient references to someone who had made nothing, a
// Planner that accepted a prompt with no brain to serve it, and a PassBook link
// that named a key and then made you find it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the Image empty state offers starter tiles, not just Open Library', async () => {
  const source = read('studios/ImageStudio.jsx');

  assert.match(source, /data-starter-tiles/);
  assert.match(source, /QUICK_PROMPTS\.slice\(0, STARTER_TILE_COUNT\)/);
  // A tile fills the box AND runs — filling it alone leaves the press to be
  // discovered, which is the homework this replaces.
  assert.match(source, /const runStarter = \(prompt\) => \{\s*setPromptValue\(prompt\);/);
  assert.match(source, /onClick=\{\(\) => runStarter\(q\.prompt\)\}/);
  // The sixth tile is the one that starts from a picture instead of from words.
  assert.match(source, /'Edit a photo'/);
  assert.match(source, /openReferencePicker/);
  // Open Library survives as a text link rather than as the only action.
  assert.match(source, /'Open Library'/);
  // And the signature sentence replaced the instruction.
  assert.match(source, /Your first picture goes here — describe it below\./);
});

test('the Image studio shows what a run will cost before the press', async () => {
  const source = read('studios/ImageStudio.jsx');

  assert.match(source, /const pendingEtaSeconds = s\.generating \? null : \(\(\) => \{/);
  assert.match(source, /return estimateGenerationSeconds\(/);
  assert.match(source, /~\{formatElapsed\(pendingEtaSeconds \* 1000\)\}/);
  // The empty prompt box shows examples, and more than one of them.
  assert.match(source, /PROMPT_EXAMPLES_EN/);
  const examples = source.match(/const PROMPT_EXAMPLES_EN = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(examples, 'expected a frozen list of example prompts');
  assert.ok(examples[1].split('\n').filter((line) => line.trim().startsWith("'")).length >= 3);
});

test('the Video empty state offers three first clips', async () => {
  const source = read('studios/VideoStudio.jsx');

  assert.match(source, /FIRST_CLIP_STARTERS\.map\(\(starter\) =>/);
  assert.match(source, /loadPromptText\(starter\.prompt\)/);
  assert.match(source, /Describe a shot or drop in a starting picture, then press Generate\./);

  const { FIRST_CLIP_STARTERS } = await import('../src/lib/animationStarters.js');
  assert.equal(FIRST_CLIP_STARTERS.length, 3);
  // Selections from the shelf, not new prompt text written here.
  for (const starter of FIRST_CLIP_STARTERS) {
    assert.ok(starter.prompt.length > 200, `${starter.id} lost its prompt`);
    assert.ok(starter.durationSeconds > 0);
  }
});

test('the studio frame renders the Setup state, and only once measured', async () => {
  const source = read('ui/kit.jsx');

  assert.match(source, /const SetupState = lazy\(\(\) => import\('\.\.\/components\/SetupState\.jsx'\)\)/);
  // `ready === false`, never `!ready` — null means "nobody has looked yet", and
  // a Setup screen flashed in front of a working machine is its own bug.
  assert.match(source, /setup\.ready === false \? \(/);
});

test('the Setup state offers three doors, credits first, and never a Settings trip', async () => {
  const source = read('components/SetupState.jsx');

  const link = source.indexOf('Link HivemindOS');
  const accounts = source.indexOf('Use my own accounts');
  const local = source.indexOf('Use models on this Mac');
  assert.ok(link > 0 && accounts > link && local > accounts, 'doors are out of order');

  // The accounts door repairs in place: the key goes to the machine's shared
  // store, and the browser never keeps it.
  assert.match(source, /saveProviderKey\(keyName, secret\)/);
  assert.match(source, /type="password"/);
  // And a "key not set" remedy can still reach the row itself.
  assert.match(source, /openPassBookForKey\(keyName/);
  // No dismissal, and no flag to remember one.
  assert.doesNotMatch(source, /setupSeen/);
  assert.doesNotMatch(source, /localStorage/);
});

test('the topbar carries the same doors while nothing is ready', async () => {
  const source = read('app/Shell.jsx');

  assert.match(source, /function SetupPill\(\)/);
  assert.match(source, /if \(setup\.ready !== false\) return null;/);
  assert.match(source, /<SetupDoors compact \/>/);
});

test('the Planner names its two fixes instead of taking a prompt it cannot serve', async () => {
  const source = read('hub/views/PlannerView.jsx');

  assert.match(source, /const noBrain = Boolean\(s\.simpleCatalog\) && routePickerProviders\('brain'\)\.length === 0;/);
  assert.match(source, /'Connect HivemindOS'/);
  assert.match(source, /'Use a local model'/);
  // The composer is out of the way until one of them lands.
  assert.match(source, /cx\('shrink-0 border-t border-line1 bg-bg1 p-3', noBrain && 'hidden'\)/);
});

test('a PassBook link names a key and lands on it', async () => {
  const helper = read('lib/passbookLink.js');
  assert.match(helper, /searchParams\.set\(PASSBOOK_KEY_PARAM, key\)/);
  assert.match(helper, /detail: \{ page: 'passbook' \}/);

  const view = read('hub/views/PassBookView.jsx');
  assert.match(view, /useState\(requestedPassBookKey\)/);
  assert.match(view, /focus=\{Boolean\(focusKey\) && row\.key === focusKey\}/);
  assert.match(view, /node\.focus\(\);/);
  // The page stopped calling itself the first-run screen — the Setup state is.
  assert.doesNotMatch(view, /first-run screen for a machine/);
});

test('the two vaguest progress stages were renamed', async () => {
  const i18n = read('lib/i18n.js');
  assert.doesNotMatch(i18n, /Queued with provider/);
  assert.doesNotMatch(i18n, /Preparing playback/);
  assert.match(i18n, /'video\.progress\.queued': 'In line'/);
  assert.match(i18n, /'video\.progress\.finishing': 'Almost there'/);
});

test('every studio that lands empty says one thing in the same voice', async () => {
  assert.match(read('studios/LipSyncStudio.jsx'), /Give a face something to say — add a portrait and a voice\./);
  assert.match(read('hub/views/HistoryView.jsx'), /Everything you make lands here, encrypted, in order\./);
});
