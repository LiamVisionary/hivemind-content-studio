// The copy rules, guarded.
//
// Four rules in DESIGN.md kept regressing because nothing in the suite checked
// them: a `t()` key that exists in one dictionary renders as its own key string
// in the other (i18n.js falls back to the key, silently); `window.confirm` puts
// a native OS dialog in the middle of a designed app; an emoji as an icon
// renders in whatever the OS font decides and breaks the one-stroke-family
// look; and `toast.error(error.message)` is how a Python traceback, an absolute
// path or another product's error body reaches a person.
//
// This walks src/ as text on purpose — the rules are about what is WRITTEN, and
// a runtime check would only see the branches a test happens to take.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

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
const readAll = () => FILES.map((file) => [rel(file), fs.readFileSync(file, 'utf8')]);

/* ---------------- every key exists in both dictionaries ---------------- */

// The two dictionaries, read out of i18n.js as text. They are module-private
// (nothing imports `translations`), and exporting them just so a test can look
// would widen the module's surface for the test's convenience.
function dictionaries() {
  const source = fs.readFileSync(path.join(SRC, 'lib/i18n.js'), 'utf8');
  const lines = source.split('\n');
  const start = (marker) => lines.findIndex((line) => line.trimEnd() === marker);
  const bounds = (marker) => {
    const from = start(marker);
    assert.ok(from > 0, `i18n.js has no ${marker}`);
    const to = lines.findIndex((line, index) => index > from && line.trimEnd() === '    },');
    assert.ok(to > from, `${marker} is not closed`);
    return lines.slice(from + 1, to);
  };
  const keysIn = (block) => new Set(
    block.map((line) => /^\s*'([^']+)'\s*:/.exec(line)).filter(Boolean).map((match) => match[1]),
  );
  return { en: keysIn(bounds('    en: {')), zh: keysIn(bounds('    zh: {')) };
}

test('every t()/tf() key the app uses exists in BOTH dictionaries', () => {
  const { en, zh } = dictionaries();
  assert.ok(en.size > 100 && zh.size > 100, 'both dictionaries were read');

  const used = new Map();
  for (const [name, source] of readAll()) {
    if (name === 'lib/i18n.js') continue;
    for (const match of source.matchAll(/\bt(?:f)?\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
      if (!used.has(match[1])) used.set(match[1], name);
    }
  }
  assert.ok(used.size > 100, `expected the app to use many keys, saw ${used.size}`);

  const missing = [];
  const unknown = [];
  for (const [key, where] of used) {
    // A dotted key is an i18n key by construction (`t('image.steps')`); a bare
    // word is one of the local `t` helpers this codebase also has.
    if (!key.includes('.')) continue;
    if (!en.has(key)) { unknown.push(`${key} (used in ${where})`); continue; }
    // A key English knows and Chinese does not renders as its own NAME in the
    // Chinese UI — silently, because t() falls back to the key.
    if (!zh.has(key)) missing.push(`${key} (used in ${where})`);
  }
  assert.deepEqual(missing, [], 'keys present in English but missing in zh-CN');
  assert.deepEqual(unknown, [], 'keys used by the app that no dictionary defines');
});

/* ---------------- native dialogs are banned ---------------- */

const isComment = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
};

test('no window.confirm and no bare alert() anywhere in src', () => {
  const offenders = [];
  for (const [name, source] of readAll()) {
    for (const line of source.split('\n')) {
      if (isComment(line)) continue;
      if (/\bwindow\.confirm\s*\(/.test(line)) offenders.push(`${name}: window.confirm`);
    }
    // `alert(` as a call, not `.alert` on some object and not the word inside
    // an identifier (`alertTone`) or a comment about the old vanilla studio.
    for (const line of source.split('\n')) {
      if (isComment(line)) continue;
      if (/(?<![\w.])alert\s*\(/.test(line)) offenders.push(`${name}: alert(`);
    }
  }
  assert.deepEqual(offenders, [], 'DESIGN.md §3/§4: use ConfirmModal and toast.error');
});

/* ---------------- a failure is never the provider's own words ---------------- */

test('no toast carries a raw error.message', () => {
  const offenders = [];
  for (const [name, source] of readAll()) {
    for (const line of source.split('\n')) {
      if (isComment(line)) continue;
      // The bare passthrough…
      if (/toast\.error\(\s*(?:error|err|e)\.message\s*\)/.test(line)) offenders.push(`${name}: ${line.trim()}`);
      // …and the concatenated one, which is the same text with a prefix.
      if (/toast\.error\(\s*`[^`]*\$\{\s*(?:error|err|e)\.message\s*\}/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'route it through describeFailure / toastFailure — a person is never shown backend text',
  );
});

/* ---------------- icons come from the icon set ---------------- */

test('no emoji is used as an icon in a .jsx component', () => {
  // Prompt data is content, not chrome: the cloud catalog, the starter prompts
  // and the animation starters describe things a person wrote, and an emoji in
  // a prompt is part of the prompt.
  const CONTENT = /(cloudCatalogFallback|defaultPrompts|animationStarters)/;
  // Emoji and the glyphs DESIGN.md names (✓ ✕ ↻ ↓): pictographs and dingbats,
  // NOT the arrows and the ⌘ this codebase writes in prose and in shortcut
  // labels, and not CJK or the typographic dashes and quotes it uses.
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  const offenders = [];
  for (const [name, source] of readAll()) {
    if (!name.endsWith('.jsx') || CONTENT.test(name)) continue;
    source.split('\n').forEach((line, index) => {
      // A comment may NAME the glyph it removed; the rule is about what renders.
      if (isComment(line)) return;
      if (EMOJI.test(line)) offenders.push(`${name}:${index + 1} ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], 'DESIGN.md §3: icons come from ui/icons.jsx, never emoji or glyphs');
});

/* ---------------- the failure primitive itself ---------------- */

test('describeFailure never leads with a traceback, a path or a JSON body', async () => {
  const { describeFailure, looksTechnical } = await import('../src/lib/describeFailure.js');

  for (const raw of [
    'Traceback (most recent call last):\n  File "/Users/x/a.py", line 3\nValueError: no',
    '/Users/liam/Library/Application Support/thing.png: No such file or directory',
    '{"detail": {"message": "nope"}}',
    'RuntimeError: the lane exploded',
  ]) {
    assert.ok(looksTechnical(raw), `should be demoted: ${raw.slice(0, 30)}`);
    const read = describeFailure(new Error(raw), { operation: 'Generation' });
    assert.equal(read.title, 'Generation failed');
    assert.equal(read.detail, raw, 'the evidence is kept, behind Details');
    assert.doesNotMatch(read.title, /Traceback|\/Users\/|[{[]/);
  }

  // A sentence the server already wrote is left alone.
  const plain = describeFailure(new Error('That model is not available on this machine.'), { operation: 'Generation' });
  assert.equal(plain.title, 'That model is not available on this machine.');
  assert.equal(plain.detail, '');
});

test('the four failures the studios must repair each arrive with a button', async () => {
  const { describeFailure } = await import('../src/lib/describeFailure.js');

  // A MUAPI 401 — the key, not "Open Settings".
  const rejected = describeFailure(new Error('API Request Failed: 401 Unauthorized - {"error":"bad key"}'), { transport: 'muapi' });
  assert.match(rejected.title, /key rejected/i);
  assert.deepEqual(rejected.remedy, { label: 'Add key', action: 'key', key: 'MUAPI_API_KEY' });

  // A HivemindOS 402 — the server names the repair and it survives.
  const broke = new Error('You have no credits left.');
  broke.remedy = 'top-up';
  const outOfCredits = describeFailure(broke, { transport: 'studio' });
  assert.equal(outOfCredits.title, 'You have no credits left.');
  assert.equal(outOfCredits.remedy.action, 'top-up');

  // A bridge 503 — the local engine, with a way to check again.
  const bridge = describeFailure(new Error('Failed to fetch'), { transport: 'local' });
  assert.match(bridge.title, /local engine is not running/);
  assert.equal(bridge.remedy.action, 'refresh');

  // A gateway OOM — a size the caller can actually change, and only then.
  const oom = 'RuntimeError: CUDA out of memory. Requested: 2.00 GiB';
  assert.equal(describeFailure(new Error(oom), { transport: 'local' }).remedy, null);
  const lowerable = describeFailure(new Error(oom), { transport: 'local', canLowerResolution: true });
  assert.match(lowerable.title, /Not enough memory for this size/);
  assert.equal(lowerable.remedy.action, 'lower-resolution');
  assert.equal(lowerable.detail, oom);
});
