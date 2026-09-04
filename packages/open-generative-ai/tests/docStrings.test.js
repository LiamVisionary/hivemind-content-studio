// The guide quotes the app. This checks it still does.
//
// docs/GUIDE.md, docs/TROUBLESHOOTING.md and README.md were written in one
// worktree while the key table (src/lib/i18n.js) was rewritten in another, at
// the same time. The guide went on quoting sentences the app had stopped
// saying — "Retry now" for a button that says "Try again", "This computer" for
// a lane that says "This Mac", "Advanced options" for a section titled
// "Advanced" — and a guide that sends someone to a control by the wrong name is
// worse than no guide, because it costs the reader the time to find out.
//
// THE EXTRACTION RULE (the whole point of this file: it has to be precise
// enough to be useful and loose enough not to be noise).
//
// 1. A QUOTED UI STRING is a double-quoted span wrapped in markdown emphasis —
//    *"…"*, **"…"** or _"…"_ — or a heading that is entirely one quoted
//    sentence. That is the convention the three documents already use for "this
//    is what the app says". A bare double-quoted span in running prose is the
//    author's own phrasing ("the same \"where does this run and what does it
//    cost\" answer") and is deliberately NOT checked: quoting the app is marked
//    up, quoting yourself is not.
//
// 2. A CONTROL NAME is a **bold** span in the two user-facing guides. Doc
//    scaffolding is excluded by shape rather than by a list that would go
//    stale: a colon ("**You see:**"), a markdown link, a trailing . ? or !, a
//    digit or a standalone N (an interpolated value — "Test 2s", "Resume from
//    chunk N"), or more than five words. README's bold is prose lead-ins
//    ("**From this checkout**"), so control names are checked in GUIDE and
//    TROUBLESHOOTING only.
//
// 3. Both sides are NORMALISED before comparing: curly quotes and apostrophes
//    become straight, … becomes ..., em and en dashes become -, and runs of
//    whitespace collapse. A doc hard-wraps at 78 columns; the source does not.
//
// 4. A quote is SPLIT on the three things the app substitutes or joins with:
//    `...` (a value filled in at runtime — "Needs … — turn on …"), and the two
//    separators runTargets.readoutText assembles a readout from, " · " and
//    " — ". Every resulting piece of four or more characters must appear
//    verbatim in the source. Splitting only ever weakens the check, never
//    breaks it: a whole sentence still matches piece by piece.
//
// 5. The SOURCE is every .js/.jsx under packages/open-generative-ai/src plus
//    every .py under src/hivemind_content_studio — the control plane serves the
//    first-run, passkey and recovery screens itself, so half the sentences in
//    section 1 of the guide live in Python. Comments are stripped: a sentence
//    that survives only in a code comment ("This computer" in i18n.js, saying
//    what the Restore lanes USED to be called) is not a sentence the app shows,
//    and counting it is exactly how this drift went unnoticed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');
const CORPUS_ROOTS = [
  { dir: path.join(REPO, 'packages', 'open-generative-ai', 'src'), match: /\.(js|jsx)$/ },
  { dir: path.join(REPO, 'src', 'hivemind_content_studio'), match: /\.py$/ },
];
const QUOTE_DOCS = ['docs/GUIDE.md', 'docs/TROUBLESHOOTING.md', 'README.md'];
const NAME_DOCS = ['docs/GUIDE.md', 'docs/TROUBLESHOOTING.md'];

function walk(dir, match, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

// Comments only. A JSX attribute can carry `/*` inside a string (accept="image/*"),
// so an unanchored block-comment strip would swallow real markup up to the next
// `*/` — hence only whole-line comments and the `{/* … */}` JSX form.
function stripComments(text, file) {
  if (file.endsWith('.py')) return text.replace(/^[ \t]*#.*$/gm, ' ');
  return text
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, ' ');
}

function normalize(text) {
  return String(text)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const CORPUS = normalize(
  CORPUS_ROOTS
    .flatMap(({ dir, match }) => walk(dir, match))
    .map((file) => stripComments(fs.readFileSync(file, 'utf8'), file))
    .join('\n'),
);

const readDoc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/^>[ \t]?/gm, '');

/** Every emphasis-wrapped quoted span, plus fully-quoted headings. */
function quotedStrings(markdown) {
  const found = [];
  // Non-greedy up to a `"` that is immediately followed by the same emphasis
  // marker, so a nested quote ("Needs … — turn on "Unload others first" …")
  // does not cut the span in half.
  for (const m of markdown.matchAll(/(\*{1,2}|_)["“]([\s\S]{3,400}?)["”]\1/g)) found.push(normalize(m[2]));
  for (const m of markdown.matchAll(/^#{1,6}\s+["“]([^"”]{3,400})["”]/gm)) found.push(normalize(m[1]));
  return found;
}

/** Every **bold** span that reads as the name of a control, tab or page. */
function controlNames(markdown) {
  const found = new Set();
  for (const m of markdown.matchAll(/\*\*([^*]{2,60})\*\*/g)) {
    const name = normalize(m[1]);
    if (/["“:[\]]/.test(name)) continue;      // "You see:", a markdown link, a quoted sentence
    if (/[.?!]$/.test(name)) continue;             // a sentence, not a name
    if (/\d/.test(name) || /\bN\b/.test(name)) continue; // "Test 2s", "Resume from chunk N"
    if (name.split(' ').length > 5) continue;      // prose emphasis
    found.add(name);
  }
  return [...found];
}

/** The pieces of `quoted` that have to appear in the source, in order. */
function piecesOf(quoted) {
  return quoted.split(/\.\.\.| · | - /).map((piece) => piece.trim()).filter((piece) => piece.length >= 4);
}

function missingQuotes(markdown, corpus = CORPUS) {
  return quotedStrings(markdown).filter((quoted) => {
    const pieces = piecesOf(quoted);
    return pieces.length === 0 || !pieces.every((piece) => corpus.includes(piece));
  });
}

function missingNames(markdown, corpus = CORPUS) {
  return controlNames(markdown).filter((name) => !corpus.includes(name));
}

/* ---------------- the corpus is really there ---------------- */

// A guard that reads an empty corpus passes everything. If the layout moves,
// this is the test that says so rather than the ones below going quiet.
test('the source corpus is read', () => {
  assert.ok(CORPUS.length > 500000, `corpus is only ${CORPUS.length} chars — did a root move?`);
  assert.ok(CORPUS.includes("'place.thisMac': 'This Mac'"), 'the key table is not in the corpus');
  assert.ok(CORPUS.includes('Name your studio and set a passphrase'), 'the control plane is not in the corpus');
});

/* ---------------- the extractor still sees the documents ---------------- */

// A rewrite that drops the emphasis convention would leave nothing to check and
// the guard would pass by finding nothing. These counts are floors, not exact.
test('the documents still mark up what the app says', () => {
  const quotes = QUOTE_DOCS.flatMap((doc) => quotedStrings(readDoc(doc)));
  assert.ok(quotes.length >= 40, `only ${quotes.length} quoted UI strings found across the guides`);
  const names = NAME_DOCS.flatMap((doc) => controlNames(readDoc(doc)));
  assert.ok(names.length >= 100, `only ${names.length} control names found across the guides`);
});

/* ---------------- every quoted string is one the app says ---------------- */

for (const doc of QUOTE_DOCS) {
  test(`${doc} quotes only strings the app has`, () => {
    const missing = missingQuotes(readDoc(doc));
    assert.deepEqual(missing, [], `${doc} quotes strings no source file contains:\n  ${missing.join('\n  ')}`);
  });
}

/* ---------------- every control it sends you to exists ---------------- */

for (const doc of NAME_DOCS) {
  test(`${doc} names only controls the app has`, () => {
    const missing = missingNames(readDoc(doc));
    assert.deepEqual(missing, [], `${doc} names controls no source file contains:\n  ${missing.join('\n  ')}`);
  });
}

/* ---------------- the guard actually catches drift ---------------- */

test('a quoted string the app does not say is caught', () => {
  const doc = 'The card says *"Retry now, before the kettle boils"* and means it.\n';
  assert.deepEqual(missingQuotes(doc), ['Retry now, before the kettle boils']);
});

test('a renamed control is caught', () => {
  assert.deepEqual(missingNames('Open **Advanced options** and press **Generate**.\n'), ['Advanced options']);
});

test('a runtime value in a quote is a wildcard, not a mismatch', () => {
  // "Needs 14.2 GB — …" can never match: the size is computed. The doc writes
  // the ellipsis the app fills in, and the rest still has to be exact.
  const good = 'It says *"Needs … — turn on "Unload others first" to make room."*\n';
  const bad = 'It says *"Needs … — turn on "Unload every other model" to make room."*\n';
  assert.deepEqual(missingQuotes(good), []);
  assert.equal(missingQuotes(bad).length, 1);
});

test('prose in bare quotes is the author, not the app', () => {
  const doc = 'the same "where does this run and what does it cost" answer\n';
  assert.deepEqual(quotedStrings(doc), []);
});

test('a sentence that survives only in a comment does not count', () => {
  const jsx = ['// The lanes used to say "This computer".', 'const label = t(\'place.thisMac\');', ''].join('\n');
  assert.ok(!stripComments(jsx, 'x.jsx').includes('This computer'));
  const py = ['# The card said "Reset your password" before 2026.', 'TITLE = "Use your recovery key"', ''].join('\n');
  assert.ok(!stripComments(py, 'x.py').includes('Reset your password'));
  assert.ok(stripComments(py, 'x.py').includes('Use your recovery key'));
});
