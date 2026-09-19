// Advanced's door is a binder tab on the frame's left edge.
//
// 2026-09-15: the Advanced button in the composer was not wanted. Liam asked
// for a bookmark/binder tab on the left edge that pulls the Advanced section
// out when pressed. The "Advanced →" link after the recipe sentence's full stop
// is gone; StudioFrame draws a tab on the drawer's outer edge instead, and the
// drawer slides out from under it.
//
// Rendered, because the question is what a person and a screen reader are
// given. That each studio wires the tab is asserted beside that studio's own
// mount (imageTiering, videoComposerToolbar, restoreStudioFrame, musicStudio).
const test = require('node:test');
const assert = require('node:assert/strict');
const { React, renderComponent, textOf } = require('./helpers/render.js');

const FRAME = 'src/studios/frame/StudioFrame.jsx';
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const frame = {
    stage: React.createElement('div', null, 'stage'),
    composer: React.createElement('div', null, 'composer'),
    drawer: React.createElement('div', null, 'the tuning bench'),
    drawerTitle: 'Advanced',
    onDrawerToggle: () => {},
    onDrawerClose: () => {},
};

// The tab's opening tag, and what it reads out.
function tabOf(markup) {
    const match = /(<button[^>]*data-drawer-tab[^>]*>)([\s\S]*?)<\/button>/.exec(markup);
    assert.ok(match, 'the frame drew no tab for its drawer');
    return { tag: match[1], label: textOf(match[2]) };
}

test('shut, the tab is all of Advanced that shows, and it says it is shut', async () => {
    const markup = await renderComponent(FRAME, 'StudioFrame', { ...frame, drawerOpen: false });
    const tab = tabOf(markup);
    assert.equal(tab.label, 'Advanced', 'the tab is labelled with the drawer it opens');
    assert.match(tab.tag, /aria-expanded="false"/);
    // The piece carrying the panel and the tab is slid its own width left,
    // which parks the panel off the frame and leaves the tab on its edge.
    assert.match(markup, /class="[^"]*-translate-x-full[^"]*"/, 'a shut drawer is not parked off the frame');
    assert.doesNotMatch(markup, /the tuning bench/, 'a shut drawer painted its body');
    assert.doesNotMatch(markup, /role="dialog"/, 'a shut drawer still announces itself as a dialog');
});

test('open, the tab stays on the drawer edge and names the panel it controls', async () => {
    const markup = await renderComponent(FRAME, 'StudioFrame', { ...frame, drawerOpen: true });
    const tab = tabOf(markup);
    assert.match(tab.tag, /aria-expanded="true"/);
    const controls = /aria-controls="([^"]+)"/.exec(tab.tag);
    assert.ok(controls, 'the tab does not say which panel it opens');
    assert.match(
        markup,
        new RegExp(`<aside[^>]*id="${escapeRe(controls[1])}"[^>]*role="dialog" aria-label="Advanced"`),
        'the tab points at something other than the drawer',
    );
    assert.match(markup, /the tuning bench/);
    assert.doesNotMatch(markup, /-translate-x-full/, 'an open drawer is still parked off the frame');
});

test('a frame with no way to open its drawer draws no tab', async () => {
    const markup = await renderComponent(FRAME, 'StudioFrame', { ...frame, onDrawerToggle: undefined, drawerOpen: false });
    assert.doesNotMatch(markup, /data-drawer-tab/);
});

test('the recipe sentence ends at its full stop, with no door to Advanced after it', async () => {
    const markup = await renderComponent('src/studios/frame/RecipeLine.jsx', 'RecipeLine', {
        parts: [{ text: 'Make' }, { key: 'count', value: '1 image', onClick: () => {} }, { text: '.' }],
    });
    assert.equal(textOf(markup), 'Make 1 image .');
    assert.doesNotMatch(markup, /aria-expanded/, 'the sentence still carries a disclosure door');
});
