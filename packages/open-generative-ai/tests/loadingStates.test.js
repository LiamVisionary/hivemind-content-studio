// A page that is waiting must not look like a page that found nothing.
//
// The two pictures were identical, and that is the whole bug this file pins.
// The inspiration finder answered `state.status === 'loading'` with `null` and
// a 14px spinner parked in the toolbar; the model browser next door did the
// same. So a slow Civitai search — and Civitai's /images feed is genuinely slow
// and genuinely flaky — drew an empty body, which is exactly what "no results"
// draws. There is no way for a person to tell those apart, so they read the
// slow one as broken.
//
// What is asserted here, and what is not. LoadingState and CardGridSkeleton are
// pure, so they are RENDERED and read.
//
// Deliberately textual: the last two blocks read source. The views that own
// these waits reach their loading state only through an effect, and a server
// render runs no effects (helpers/render.js says why there is no jsdom here),
// so "this view no longer answers loading with null" has no rendered form to
// assert on — the render would show the IDLE state either way. Both blocks
// therefore check the one narrow source shape that regressed, which is a weaker
// claim than a render and is labelled as one rather than dressed up as one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importComponent, renderElement, root, textOf } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('a page-level wait claims the space the content will claim', async () => {
    const LoadingState = await importComponent('src/ui/kit.jsx', 'LoadingState');
    const { markup } = renderElement(LoadingState, { label: 'Searching Civitai…' });

    // The size IS the fix. `flex-1` covers the flex-column parents and the
    // min-height covers the scroll containers that are plain blocks, where
    // flex-1 does nothing at all — both are needed, so both are pinned.
    assert.match(markup, /min-h-\[55vh\]/, 'the wait fills the majority of an empty page');
    assert.match(markup, /flex-1/);
    assert.match(markup, /aria-busy="true"/, 'a wait announces itself as one');
    assert.match(textOf(markup), /Searching Civitai/, 'and says what it is waiting for');

    // A spinner big enough to read as the subject of the page rather than as
    // decoration on a toolbar.
    const size = markup.match(/width="(\d+)"/);
    assert.ok(size && Number(size[1]) >= 40, `page spinner is ${size?.[1]}px, too small to read as the page's state`);
});

test('a grid-shaped surface waits in the shape of its grid', async () => {
    const CardGridSkeleton = await importComponent('src/ui/kit.jsx', 'CardGridSkeleton');
    const { markup } = renderElement(CardGridSkeleton, { count: 12, label: 'Searching Civitai…' });

    // Over-filling a screen is the point: an under-filled skeleton reads as
    // "this is the whole result", which is the same lie as an empty body.
    assert.equal((markup.match(/animate-pulse/g) || []).length, 12 * 3, 'twelve cards, three bones each');
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /aria-label="Searching Civitai/);
    assert.match(markup, /grid-template-columns:repeat\(auto-fill,\s*minmax\(180px,\s*1fr\)\)/);
});

test('a spinner inside a labelled wait is decorative, not a second announcement', async () => {
    const Spinner = await importComponent('src/ui/kit.jsx', 'Spinner');

    const announced = renderElement(Spinner, {}).markup;
    assert.match(announced, /role="status"/, 'a bare spinner is still the announcement');
    assert.match(announced, /aria-label="Loading"/);

    // Nested live regions make a screen reader say "Loading, Searching Civitai"
    // over one spinner. LoadingState owns the label; the glyph inside it does not.
    const decorative = renderElement(Spinner, { label: null }).markup;
    assert.doesNotMatch(decorative, /role="status"/);
    assert.match(decorative, /aria-hidden="true"/);
});

// SOURCE, not render — see the header. The shape below is the exact regression:
// a ternary that tests the loading status and yields `null`, leaving the body
// of the page empty while the request is in flight.
test('no Civitai surface answers "loading" with an empty page', () => {
    const surfaces = [
        'src/hub/views/InspoView.jsx',
        'src/hub/views/models/CivitaiBrowser.jsx',
    ];
    for (const relative of surfaces) {
        const source = read(relative);
        assert.doesNotMatch(
            source,
            /!==\s*'loading'\s*\?[\s\S]{0,600}?\)\s*:\s*null\}/,
            `${relative} renders nothing while it loads, which is what "no results" renders`,
        );
        assert.match(source, /CardGridSkeleton/, `${relative} should wait in the shape of its grid`);
    }
});

// The other half of the reported bug: what the page says when the wait ends
// badly. DESIGN.md §4 — no dead ends — and "HTTP Error 503: Service
// Unavailable" was both a dead end and a sentence about nobody in particular.
test('a failed Civitai search offers the way out, and never quotes a status line', () => {
    for (const relative of ['src/hub/views/InspoView.jsx', 'src/hub/views/models/CivitaiBrowser.jsx']) {
        const source = read(relative);
        const errorBranch = source.slice(source.indexOf("state.status === 'error'"));
        assert.match(errorBranch, /action=\{state\.status === 'error'/, `${relative} leaves a failed search with no retry`);
    }
    // The sentence itself is minted gateway-side (see the media-gateway's
    // CivitaiFeedResilienceTests); what is checked here is that no studio
    // string re-introduces the raw shape.
    const strings = read('src/lib/i18n.js');
    assert.doesNotMatch(strings, /HTTP Error \d+/, 'a status line is not a sentence a person can act on');
});
