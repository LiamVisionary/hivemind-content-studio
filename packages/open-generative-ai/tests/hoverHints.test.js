// ActionButton hover hints.
//
// kit.jsx is JSX, which node:test cannot import, so these assert the shape of the
// source the way the other studio tests do. The clipping this guards against was
// reproduced in the browser: in the image result modal the last button's hint
// rendered as "Down…", cut at the dialog's edge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('the hint renders outside the button so a dialog cannot clip it', () => {
    const kit = read('src/ui/kit.jsx');
    // Modal panels are overflow-hidden (rounded corners + scrolling body), so a
    // bubble anchored inside a footer button loses its tail at the panel edge.
    assert.match(kit, /createPortal\(/);
    assert.match(kit, /document\.body,/);
    assert.match(kit, /position: 'fixed'/);

    const css = read('src/styles/base.css');
    // The pseudo-element tooltip it replaces must be gone, or both would show.
    assert.doesNotMatch(css, /\[data-hint\]:hover::after/);
    assert.doesNotMatch(css, /content: attr\(data-hint\)/);
    // The label collapse stays in CSS — it depends on the pointer, not the button.
    assert.match(css, /\.hive-hint-label \{ display: none; \}/);
});

test('the hint is clamped to the viewport and flips below when it must', () => {
    const kit = read('src/ui/kit.jsx');
    assert.match(kit, /Math\.min\(Math\.max\(centered, margin\), rightmost\)/);
    assert.match(kit, /above >= margin \? above : target\.bottom \+ 6/);
    // Fixed coordinates don't track the anchor by themselves.
    assert.match(kit, /addEventListener\('scroll', place, true\)/);
    assert.match(kit, /addEventListener\('resize', place\)/);
});

test('hints stay on hover-capable pointers and keep the caller handlers', () => {
    const kit = read('src/ui/kit.jsx');
    // Touch keeps the visible label instead; :hover latches there after a tap.
    assert.match(kit, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
    assert.match(kit, /if \(canHover\(\)\) setAnchor\(event\.currentTarget\)/);
    // ActionButton's own listeners must not swallow a caller's.
    for (const handler of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur']) {
        assert.match(kit, new RegExp(`rest\\.${handler}\\?\\.\\(e\\)`), `${handler} forwards to the caller`);
    }
    // Focus only reveals it for keyboard focus, not for a click that focuses.
    assert.match(kit, /matches\(':focus-visible'\)/);
});
