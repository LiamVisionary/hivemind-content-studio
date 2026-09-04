// A test that asserts on SOURCE TEXT has to say why it is not a render.
//
// The suite grew 130-odd of them, and the reason was usually the same sentence:
// "JSX, which node:test cannot import". That stopped being true when
// tests/helpers/render.js landed — the app mounts here now — so the sentence
// survived as a habit and hid the ones that had a real reason underneath the
// ones that did not.
//
// This is the guard on that. A test block that reads a file out of src/ and
// runs a regex over it is fine — an absence claim over the whole tree, an
// import set, a payload shape and a pointer interaction all genuinely have no
// rendered form — but the file has to say which of those it is. Anything else
// is a proxy, and the proxy is what let a missing import ship for a week.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const RATIONALE = /Deliberately textual|deliberate:|is deliberate/i;

const testFiles = fs.readdirSync(here).filter((name) => name.endsWith('.test.js'));

// Test blocks in one file: everything from one top-level `test(` to the next.
function testBlocks(source) {
    const starts = [...source.matchAll(/\ntest(?:\.skip)?\(/g)].map((match) => match.index);
    return starts.map((start, index) => source.slice(start, index + 1 < starts.length ? starts[index + 1] : source.length));
}

function readsSourceAndGreps(block) {
    return /\bread\(|readFileSync\(/.test(block) && /assert\.(match|doesNotMatch)\(/.test(block);
}

test('this suite still has plenty of tests, and this guard can see them', () => {
    assert.ok(testFiles.length > 100, `expected the suite's test files, saw ${testFiles.length}`);
    const greppers = testFiles.filter((name) => testBlocks(fs.readFileSync(path.join(here, name), 'utf8')).some(readsSourceAndGreps));
    // If this ever reaches zero the guard is measuring nothing and should go.
    assert.ok(greppers.length > 0, 'no source-text tests found — this guard has nothing left to guard');
});

test('every file that asserts on source text says why it is not a render', () => {
    const silent = [];
    for (const name of testFiles) {
        const source = fs.readFileSync(path.join(here, name), 'utf8');
        if (!testBlocks(source).some(readsSourceAndGreps)) continue;
        if (RATIONALE.test(source)) continue;
        silent.push(name);
    }
    assert.deepEqual(silent, [], (
        'these files assert on source text without saying why a render cannot do it.\n'
        + 'Either render the thing (tests/helpers/render.js — three lines) or add a comment\n'
        + 'beginning "Deliberately textual:" with the reason:\n  ' + silent.join('\n  ')
    ));
});

test('nothing claims any more that node:test cannot import a component', () => {
    // The obsolete reason. It is worth failing on, because it is the sentence
    // that made every new source-text test look justified.
    const stale = testFiles.filter((name) => {
        if (name === path.basename(__filename)) return false; // this file quotes it on purpose
        const source = fs.readFileSync(path.join(here, name), 'utf8');
        return /node:test cannot import|node cannot import/.test(source);
    });
    assert.deepEqual(stale, [], `these files still give the retired reason: ${stale.join(', ')}`);
});
