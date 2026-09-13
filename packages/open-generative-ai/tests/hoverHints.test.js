// Hover hints — the studio's own tooltip, and the rail that depends on it.
//
// The clipping this guards against was reproduced in the browser: in the image
// result modal the last button's hint rendered as "Down…", cut at the dialog's
// edge.
//
// Deliberately textual: a hint exists only while a pointer hovers. It is
// portalled to the body, positioned against the viewport and re-placed on
// scroll; none of that survives a static render.
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

test('the hint is clamped to the viewport and flips when it must', () => {
    const kit = read('src/ui/kit.jsx');
    // Above by default, below when the top of the window is in the way.
    assert.match(kit, /above >= HINT_MARGIN \? above : target\.bottom \+ HINT_GAP/);
    // Beside for a vertical stack, and to the LEFT when the right edge is in
    // the way — a bubble that runs off the window says nothing.
    assert.match(kit, /placement === 'right'/);
    assert.match(kit, /target\.left - bubble\.width - HINT_GAP/);
    // Both axes are clamped: the rail's last button sits against the bottom of
    // the window, and its hint must not hang off it.
    assert.match(kit, /const clamp = \(value, limit\) => Math\.min\(Math\.max\(value, HINT_MARGIN\), Math\.max\(HINT_MARGIN, limit\)\)/);
    assert.match(kit, /window\.innerHeight - bubble\.height - HINT_MARGIN/);
    assert.match(kit, /window\.innerWidth - bubble\.width - HINT_MARGIN/);
    // Fixed coordinates don't track the anchor by themselves.
    assert.match(kit, /addEventListener\('scroll', place, true\)/);
    assert.match(kit, /addEventListener\('resize', place\)/);
});

test('hints stay on hover-capable pointers and keep the caller handlers', () => {
    const kit = read('src/ui/kit.jsx');
    // Touch keeps the visible label instead; :hover latches there after a tap.
    assert.match(kit, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
    assert.match(kit, /if \(canHover\(\)\) setAnchor\(event\.currentTarget\)/);
    // The hook's own listeners must not swallow the caller's — including the
    // press, which is how a rail button still navigates while hinted.
    for (const handler of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur', 'onClick']) {
        assert.match(kit, new RegExp(`handlers\\.${handler}\\?\\.\\(e\\)`), `${handler} forwards to the caller`);
    }
    // Focus only reveals it for keyboard focus, not for a click that focuses.
    assert.match(kit, /matches\(':focus-visible'\)/);
});

test('the collapsed sidebar labels its icons with the studio bubble, not the OS tooltip', () => {
    const shell = read('src/app/Shell.jsx');
    const account = read('src/app/AccountRow.jsx');
    // A rail of a dozen unlabelled glyphs is unreadable without hover labels,
    // and `title` is the browser's own: a second of delay, drawn in the OS's
    // colours. Every railed control takes the bubble instead — and must DROP
    // its title, or a hovered button shows two tooltips.
    assert.match(shell, /useHint\('right'\)/);
    assert.match(account, /useHint\('right'\)/);
    for (const [file, source] of [['Shell.jsx', shell], ['AccountRow.jsx', account]]) {
        assert.doesNotMatch(
            source,
            /title=\{(?:railed|collapsed) \? (?!undefined)/,
            `${file}: the railed state must not carry a native title`,
        );
    }
    // The nav rows, the search, the brand, the rail toggle, Settings, Lock, the
    // account avatar and the build line — every glyph on the rail.
    assert.match(shell, /\{\.\.\.\(collapsed \? hint\.bind\(\{ onClick: press \}\) : null\)\}/);
    assert.match(shell, /hint=\{railed \? 'right' : ''\}/);
    assert.match(account, /\{\.\.\.hint\.bind\(\{ onClick: onOpenAccount \}\)\}/);
    // The label is still on the element for assistive tech: the bubble is a
    // drawing, and a screen reader must not depend on a pointer to hear it.
    assert.match(shell, /aria-label=\{collapsed \? label : undefined\}/);
});

test('an icon-only control keeps its native title until it opts into the bubble', () => {
    const kit = read('src/ui/kit.jsx');
    // IconButton is used all over the app; the swap is per-call-site, so a
    // button that has not asked for a bubble must keep the tooltip it had.
    assert.match(kit, /title=\{hint \? undefined : label\}/);
    assert.match(kit, /\{\.\.\.\(hint \? bubble\.bind\(rest\) : null\)\}/);
    assert.match(kit, /aria-label=\{label\}/);
});
