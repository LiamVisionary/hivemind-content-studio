// One language, one home for `zh`, and no chrome that reloads to change it.
//
// v1 ships English only: zh-CN covered the toolbars and left three studios,
// every dialog and most of the hub in English, so the toggle promised a
// translated app and delivered a bilingual one. The dictionary and the ~1,000
// `zh() ? … : …` branches all stay — LANGS_ENABLED is the switch — which means
// nothing in the source tells you the language is off. These tests do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const FILES = walk(SRC);
const rel = (file) => path.relative(SRC, file);

test('only English ships, and a stored zh-CN choice renders English', async () => {
  const { LANGS_ENABLED, normalizeLang, canonicalLang } = await import('../src/lib/i18n.js');

  assert.deepEqual(LANGS_ENABLED, ['en'], 'v1 ships one language');
  // The whole point: a browser (or a person) asking for Chinese gets English…
  assert.equal(normalizeLang('zh-CN'), 'en');
  assert.equal(normalizeLang('zh'), 'en');
  assert.equal(normalizeLang('zh_CN'), 'en');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang(''), 'en');
  // …while the CHOICE itself is still understood, so re-enabling zh-CN restores
  // the language the person was last on instead of silently dropping it.
  assert.equal(canonicalLang('zh'), 'zh-CN');
  assert.equal(canonicalLang('zh-cn'), 'zh-CN');
  assert.equal(canonicalLang('en-GB'), 'en');
});

test('a stored og_lang is read, never overwritten with the shipping language', async () => {
  const { getLang } = await import('../src/lib/i18n.js');
  const store = new Map([['og_lang', 'zh-CN']]);
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    assert.equal(getLang(), 'en', 'the app renders English');
    assert.equal(store.get('og_lang'), 'zh-CN', 'the stored choice survives the read');
    // A legacy tag is still canonicalised in place.
    store.set('og_lang', 'zh');
    assert.equal(getLang(), 'en');
    assert.equal(store.get('og_lang'), 'zh-CN');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('no language toggle is left in the chrome', () => {
  const shell = read('app/Shell.jsx');
  const settings = read('dialogs/SettingsModal.jsx');
  const code = (source) => source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('{/*'));
  }).join('\n');

  // The two Shell buttons rendered '中文'/'EN' and warned that the page reloads.
  assert.doesNotMatch(code(shell), /web\.switchTo(En|Zh)/, 'Shell renders no language toggle');
  assert.doesNotMatch(code(shell), /'中文'/, 'Shell renders no language toggle');
  // The Settings segmented control was the third copy of the same setting.
  assert.doesNotMatch(code(settings), /setLang\s*\(/, 'Settings has no language control');
  assert.doesNotMatch(code(settings), /Segmented/, 'Settings has no language control');
  // The comment saying where it went stays, so the next reader knows why.
  assert.match(settings, /LANGS_ENABLED/, 'Settings says where the control went');
});

test('`zh` has exactly one home', () => {
  const offenders = [];
  for (const file of FILES) {
    if (rel(file) === 'lib/i18n.js') continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      if (/^\s*(?:export\s+)?const zh\w* = \(\) =>/.test(line)) offenders.push(`${rel(file)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'the language predicate is exported from lib/i18n.js');
  assert.match(read('lib/i18n.js'), /^export const zh = \(\) => getLang\(\) === 'zh-CN';$/m);
  // videoLogic re-exports the same binding; a dozen video panels import it there.
  assert.match(read('studios/video/videoLogic.js'), /export \{ zh \};/);
});

test('unlocking the vault re-resolves in place instead of reloading', () => {
  const modal = read('bridges/VaultUnlockModal.jsx');
  // The success path bootstraps the vault here and tells the surfaces about it…
  assert.match(modal, /retryVaultBootstrap\(\)/);
  assert.match(modal, /clearMediaSealFailures\(\)/);
  assert.match(modal, /announceVaultUnlocked\(\)/);
  // …and reloads only when the bootstrap did not take.
  assert.match(modal, /if \(!ready\) \{[\s\S]*?window\.location\.reload\(\);/);
  assert.equal((modal.match(/window\.location\.reload\(\)/g) || []).length, 1, 'one reload, as the fallback');

  // Lock still reloads: that one has to reset state.
  assert.match(read('app/Shell.jsx'), /location\.reload\(\);/);

  // The listeners that make the no-reload path actually repaint.
  const hooks = read('hooks/hooks.js');
  assert.match(hooks, /export function useVaultUnlockNonce/);
  assert.match(hooks, /useWindowEvent\(VAULT_UNLOCKED_EVENT, read\)/);
  assert.match(read('hub/components/MediaThumb.jsx'), /useVaultUnlockNonce\(\)/);
});

test('a sealed prompt is a sentence with a way out, not a padlock glyph', () => {
  const hubData = read('hub/hubData.js');
  assert.doesNotMatch(hubData, /🔒/, 'no emoji stands in for an icon');
  assert.match(hubData, /export const SEALED_PROMPT_TEXT = 'Sealed prompt — unlock your vault to read it\.';/);

  const history = read('hub/views/HistoryView.jsx');
  assert.match(history, /SEALED_PROMPT_TEXT/, 'PromptCard recognises a sealed prompt');
  assert.match(history, /onClick=\{requestVaultUnlock\}/, 'and offers the unlock');
});

test('no dead i18n key is left in the dictionary', () => {
  const i18n = read('lib/i18n.js');
  const used = new Set();
  for (const file of FILES) {
    if (rel(file) === 'lib/i18n.js') continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt(?:f)?\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(match[1]);
  }
  // Two families are reached by a computed key and can never be seen this way:
  // `video.progress.<stage>` (VideoStudio) and `ar.*` (aspectRatioName, inside
  // i18n.js itself). Everything else has to be named somewhere.
  const dynamic = /^(video\.progress\.|ar\.)/;
  const keys = [...i18n.matchAll(/^ {8}'([^']+)':/gm)].map((match) => match[1]);
  const dead = [...new Set(keys.filter((key) => !dynamic.test(key) && !used.has(key)))];
  assert.deepEqual(dead, [], 'a key nothing renders is translation debt');
});

test('nothing in src still advertises the Electron build or the old domain', () => {
  const offenders = [];
  for (const file of FILES) {
    const source = fs.readFileSync(file, 'utf8');
    if (/electron:build|open-generative-ai\.com/.test(source)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], 'the desktop app is named, never a build command');
});
