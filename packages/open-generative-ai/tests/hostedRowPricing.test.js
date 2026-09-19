// What a hosted row says where its place label used to be.
//
// Liam, on the picker: "i dont like how it doesnt say the credit amount.
// HivemindOS credits is obvious. it shouldn't say that." Every row on the
// Hivemind tab read "HivemindOS credits" — the tab's own name, printed 135
// times, in the one column that could have carried the money.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let instance = 0;
const fresh = () => import(`../src/lib/hostedQuote.js?p=${(instance += 1)}`);

test('credits are spelled out, and a tilde marks a price for a press you are not set up to make', async () => {
    const { formatCredits, creditsForUsd } = await fresh();
    // The ONE conversion both apps use: retail USD x 500, rounded up, so the
    // cheapest model on the rail still costs something rather than reading free.
    assert.equal(creditsForUsd(0.0625), 32);
    assert.equal(creditsForUsd(0.002359), 2);
    assert.equal(creditsForUsd(0), 0);
    // The unit is said, because a bare number beside "~30 s" reads as seconds.
    assert.equal(formatCredits(32), '32 credits');
    assert.equal(formatCredits(1), '1 credit');
    assert.equal(formatCredits(1250), '1,250 credits');
    assert.equal(formatCredits(0), '');
    assert.equal(formatCredits(7, { exact: false }), '~7 credits');
});

test('a row is priced for the endpoint it would actually run', async () => {
    const { routeForAttached } = await fresh();
    // One model, four endpoints, four prices. Which one is priced follows the
    // composer: a reference attached means the editing endpoint.
    const flux = {
        'text-to-image': { model: 'flux-3-text-to-image', usd: 0.0625 },
        'image-to-image': { model: 'flux-3-image-to-image', usd: 0.075 },
    };
    assert.deepEqual(routeForAttached(flux, 'image', 'none'),
        { capability: 'text-to-image', model: 'flux-3-text-to-image', usd: 0.0625, attached: 'none', exact: true });
    assert.deepEqual(routeForAttached(flux, 'image', 'image'),
        { capability: 'image-to-image', model: 'flux-3-image-to-image', usd: 0.075, attached: 'image', exact: true });

    // An EDIT-ONLY row with nothing attached is still worth a price — "~7
    // credits once you attach a picture" is useful while choosing, and the
    // alternative was the redundant place label. It is quoted as the edit it
    // is (attached: 'image', or the gateway refuses the endpoint) and marked
    // inexact, which is what the tilde is for.
    const editOnly = { 'image-to-image': { model: 'ai-background-remover', usd: null } };
    assert.deepEqual(routeForAttached(editOnly, 'image', 'none'),
        { capability: 'image-to-image', model: 'ai-background-remover', usd: null, attached: 'image', exact: false });

    // A video row prefers the capability that matches what is attached.
    const clip = {
        'text-to-video': { model: 'flux-3-text-to-video', usd: null },
        'image-to-video': { model: 'flux-3-image-to-video', usd: null },
    };
    assert.equal(routeForAttached(clip, 'video', 'image').capability, 'image-to-video');
    assert.equal(routeForAttached(clip, 'video', 'none').capability, 'text-to-video');
    assert.equal(routeForAttached(null, 'image', 'none'), null);
});

// Deliberately textual: the row hangs off a Menu portal, which react-dom/server
// refuses, so the wiring is read instead.
test('the picker shows the money where it used to show the tab name, and has it before it draws', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'RunOnPicker.jsx'), 'utf8');
    // The price REPLACES the place on hosted rows rather than joining it.
    assert.match(source, /const meta = priced\s*\n\s*\? formatCredits\(credits, \{ exact: route\?\.exact !== false \}\)/);
    // Off the CATALOGUE, not a fetch per row. Asking as each row scrolled into
    // view is what made the numbers pop in one at a time down the list; the
    // studio warms every endpoint at boot instead.
    assert.match(source, /const credits = route\?\.usd > 0 \? creditsForUsd\(route\.usd\) : 0;/);
    assert.doesNotMatch(source, /useOnScreen|useRowCredits|fetch\(/, 'a row never fetches its own price');
    // The AUTOMATIC row is one target in one place; showing it above every tab
    // put a This Mac model at the top of the Hivemind list.
    assert.match(source, /automaticOnThisTab/);
});

// Liam, after picking AI Ghibli Style from the Hivemind tab, writing a prompt
// and pressing Generate: "is that true? seems odd it doesnt also work
// text-to-image standalone." It is true — MUAPI's schema for that endpoint is
// one required `image_url` and no prompt field at all — but the studio only
// said so after the prompt had been written, in a toast that offered nothing.
test('a model that can only edit says so before the prompt is written, not after', () => {
    const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');

    // The catalog's verdict reaches the picker. A consolidated hosted row's id
    // ("flux-3") is in neither MUAPI bucket, so the MUAPI lists cannot answer
    // this for the hosted rail — the server's own requires_image can.
    const targets = read('lib', 'runTargets.js');
    assert.match(targets, /requiresImage: Boolean\(requiresImage\)/);
    assert.match(targets, /requiresImage: model\.requires_image === true/);

    // Both catalogs are asked, because each knows rows the other does not.
    const image = read('studios', 'ImageStudio.jsx');
    assert.match(image, /const cloudSelectionNeedsPicture = \(\) => !s\.useLocalModel/);
    assert.match(image, /Boolean\(currentRunTarget\(\)\?\.requiresImage\) \|\| apiModelRequiresImage\(s\.selectedModel\)/);

    // 19 of the 57 editing rows have no prompt field upstream; the box must not
    // ask for one it will drop.
    assert.match(image, /const apiModelTakesPrompt = \(id\) => \{/);
    assert.match(image, /it takes no prompt`/);

    // The press is greyed with the reason, beside the Attach door that fixes
    // it — not allowed through to a dead-end toast.
    assert.match(image, /const referenceMissing = s\.uploadedImageUrls\.length === 0 && cloudSelectionNeedsPicture\(\);/);
    assert.match(image, /generateBlocked = rentedBlocked \|\| localBlocked \|\| offlineBlocked \|\| referenceMissing/);
    assert.match(image, /localBlockedReason \|\| referenceMissingReason \|\| t\('image\.generateTooltip'\)/);

    // And the badge is a requirement rather than an extra when a picture is the
    // only thing the row can start from. "Edit" beside a name reads as "can
    // also edit". The badge is the row's TYPE now — one per row, derived from
    // every endpoint it has — so a model that also answers a bare prompt can
    // never wear this one.
    const picker = read('components', 'RunOnPicker.jsx');
    assert.match(picker, /\[STARTS_FROM_IMAGE\]: t\('runOn\.badgeNeedsPicture'\)/);
    assert.match(picker, /const needs = target\.startsFrom === STARTS_FROM_IMAGE/);
    assert.match(read('lib', 'i18n.js'), /'runOn\.badgeNeedsPicture': 'Needs a picture',/);
    assert.match(targets, /if \(fromText && fromImage\) return STARTS_FROM_EITHER;/);
    assert.match(targets, /if \(fromImage\) return STARTS_FROM_IMAGE;/);
});

// Liam, on the first cut of that fix — a label on the left, an Upload button
// pushed to the right edge of a wide bar: "bruh too much empty space. I want
// it to me like an empty state where everything is centered and it says Drag
// or drop an image or click to browse. make drag and drop work too."
test('a model that reads only a picture gets one centred drop zone for a composer', () => {
    const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', 'src', ...parts), 'utf8');
    const composer = read('studios', 'image', 'ImageComposer.jsx');
    const image = read('studios', 'ImageStudio.jsx');

    // The mode: needs a picture AND has no prompt field upstream.
    assert.match(image, /const uploadOnly = !s\.useLocalModel && cloudSelectionNeedsPicture\(\) && !apiModelTakesPrompt\(s\.selectedModel\);/);
    assert.match(image, /uploadOnly=\{uploadOnly\}/);

    // The prompt box stands down, and so does every door that acts on a prompt
    // or on a reference list — Attach, Improve, Starters, `more`, Clear.
    assert.match(composer, /prompt=\{uploadOnly \? \(/);
    assert.match(composer, /tools=\{uploadOnly \? null : tools\}/);
    // ...along with the clauses of the recipe sentence that cannot apply. Where
    // it runs stays: it is the way back off this model.
    assert.match(composer, /parts=\{uploadOnly \? uploadOnlyRecipe : recipeParts\}/);
    assert.match(composer, /const uploadOnlyRecipe = recipeParts\.filter\(\(part\) => !part\.key \|\| part\.key === 'runOn'\)/);

    // An empty state, centred, that takes a drop as readily as a click.
    assert.match(composer, /function UploadOnlyComposer\(\{ url, busy = false, onFiles, onDropData, onClear \}\)/);
    assert.match(composer, /flex cursor-pointer flex-col items-center justify-center/);
    assert.match(composer, /onDrop=\{\(e\) => \{/);
    assert.match(composer, /onDropData\?\.\(e\.dataTransfer\)/);
    assert.match(image, /onUploadDrop=\{composerDrop\.onDrop\}/);
    // The hidden input sits inside the clickable zone, so its own click must
    // not bubble back into browse() — that recursion re-opens the dialog for ever.
    assert.match(composer, /onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    // dragenter/dragleave fire per child; a boolean flickers across the icon.
    assert.match(composer, /depth\.current = Math\.max\(0, depth\.current - 1\)/);
    // A picture already attached is kept, shown, and clearable.
    assert.match(composer, /<Thumb src=\{url\}/);
    assert.match(composer, /label=\{t\('image\.uploadOnlyClear'\)\}/);
    assert.match(read('lib', 'i18n.js'), /'image\.uploadOnlyEmpty': 'Drag and drop an image, or click to browse'/);

    // And the canvas stops telling you to describe something.
    assert.match(read('studios', 'image', 'ImageStage.jsx'), /hint=\{emptyHint \|\| 'Describe the image below/);
    assert.match(image, /emptyHint=\{uploadOnly/);
});

// The error Liam hit next, printed where the price goes: "AI Ghibli Style
// cannot start from that input. It does: image-to-image." True, and about an
// endpoint nobody asked for — the composer had asked to price the row's
// text-to-image route, which an edit-only row does not have.
test('an edit-only row is priced as an edit, not refused for lacking a text route', () => {
    const image = fs.readFileSync(path.join(__dirname, '..', 'src', 'studios', 'ImageStudio.jsx'), 'utf8');
    assert.match(image, /routeForAttached\(hostedTarget\.hostedRoutes, 'image', refsSupported && refCount > 0 \? 'image' : 'none'\)/);
    assert.match(image, /attached: hostedRoute\?\.attached \|\|/);
    // The tilde says the figure is for a press the composer is not set up to
    // make — so it goes once the picture is on.
    assert.match(image, /formatCredits\(hostedQuote\.credits, \{ exact: hostedRoute\?\.exact !== false \}\)/);
    // And the upload door itself: 30 of the 70 hosted rows that take a picture
    // have ids in neither MUAPI bucket, so the bucket lookup alone refused them.
    assert.match(image, /if \(\(currentRunTarget\(\)\?\.accepts \|\| \[\]\)\.includes\('image_url'\)\) return true;/);
});
