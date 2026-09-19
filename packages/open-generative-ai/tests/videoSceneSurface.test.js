// ONE sequence surface for the Video studio.
//
// The strip and a derived chain strip used to be two card strips shown
// ALTERNATELY for the same episode, and a scene could be armed from either of
// them — two arming paths writing the same motionContextUrl on two different
// clips. These tests pin the landing shape: the strip is the only surface, it
// is seeded from the chain lineage (which outlives the session the strip does
// not), and arming goes through exactly one function.
//
// The third test is the wording rule: H3's prompt grammar is the model's, not
// the user's. Tokens like <Subject 1> may live in the compiled prompt, in hover
// titles and in Prompt Check's findings — never in the labels, hints and menu
// copy a first-timer reads.
//
// The last two are about DISCLOSURE, and both were rewritten when the route's
// UI was replaced. The studio used to be a permanent 320px settings column with
// a shut `CollapsibleSection title="Advanced"` at the bottom of it; it is a
// StudioFrame now — full-bleed stage, floating composer, and everything else in
// a drawer that is not rendered at all until `s.advancedOpen`. So the seed, the
// quality tier and the refinement switch moved out of VideoStudio.jsx into
// video/VideoAdvanced.jsx's SAMPLING section, and the References control (which
// carries LTX's stitched views) is now mounted twice: once for the drawer, once
// as the composer's frames door. The contracts did not change — where they are
// checked did.
//
// Deliberately textual: chain lineage, the single arming path and the run a
// workflow refuses are state machinery; and the drawer's body only paints for a
// lane this machine may not have and takes ~90 props off a live engine, so it
// is asserted at its wiring while the DISCLOSURE ITSELF — the one claim a bare
// box can settle — is a real render of StudioFrame below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { React, renderComponent } = require('./helpers/render.js');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const lib = (name) => import(`../src/lib/${name}.js`);

test('a chained scene survives a restart: the lineage seeds the strip', async () => {
    const { chainTimelineModel } = await lib('chainTimeline');
    const { timelineFromChainShots, filledTimelineSegments } = await lib('videoTimeline');

    // Three shots of one episode, newest first — the shape History is loaded in
    // (localStorage, so it is still there after the browser is restarted; the
    // strip's own sessionStorage is not).
    const history = [
        { id: '3', url: 'u3', model: 'minimax-h3', chainFromUrl: 'u2' },
        { id: '2', url: 'u2', model: 'minimax-h3', chainFromUrl: 'u1' },
        { id: '1', url: 'u1', model: 'minimax-h3' },
    ];
    const model = chainTimelineModel(history[0], history);
    assert.equal(model.shots.length, 3, 'the lineage is a three-shot episode');

    const seeded = timelineFromChainShots(model.shots);
    assert.deepEqual(filledTimelineSegments(seeded.segments).map((s) => s.url), ['u1', 'u2', 'u3']);
    // The scene continues at its END: the selected card is the empty slot after
    // the last shot, which is the slot Auto-continue arms from.
    const tail = seeded.segments[seeded.segments.length - 1];
    assert.equal(tail.url, '');
    assert.equal(seeded.selectedId, tail.id);
    // A single unchained clip is not an episode and seeds nothing.
    assert.equal(chainTimelineModel(history[2], [history[2]]), null);

    // And the studio actually reaches for it — on open, and on a restore that
    // found nothing saved.
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /const chainSceneSeed = \(\) => \{/);
    assert.match(studio, /const seeded = chainSceneSeed\(\) \|\| openTimeline\(s\.resultUrl \|\| '', s\.resultModel \|\| ''\);/);
    const restore = studio.slice(studio.indexOf('const saved = loadTimelineState(tabIdRef.current);'));
    assert.match(restore.slice(0, 1400), /\} else \{[\s\S]*?const seeded = chainSceneSeed\(\);[\s\S]*?s\.timelineOn = true;/);
});

test('one arming path: nothing but armTimelineContinuation writes the chain', () => {
    const studio = read('src/studios/VideoStudio.jsx');

    // Continue scene opens the one surface and lets the strip arm it.
    const continueScene = studio.match(/const continueSceneFrom = \([\s\S]*?\n {2}\};/)[0];
    assert.doesNotMatch(continueScene, /motionContextUrl:/, 'Continue scene does not arm a chain itself');
    assert.match(continueScene, /openSceneAt\(url, target\.id\);/);

    // openSceneAt is the funnel, and it ends in the single arming call.
    const openScene = studio.match(/const openSceneAt = \([\s\S]*?\n {2}\};/)[0];
    assert.match(openScene, /s\.timelineExtend = true;/);
    assert.match(openScene, /armTimelineContinuation\(\);/);

    // Exactly one place commits a motionContextUrl for a continuation: the arm.
    // (clearMotionContext and disarm set it to null, which is the other half of
    // the same path.)
    const arming = studio.match(/motionContextUrl: plan\.fromUrl/g) || [];
    assert.equal(arming.length, 1, 'the chain is armed in exactly one place');
    const armFn = studio.match(/const armTimelineContinuation = \(\) => \{[\s\S]*?\n {2}\};/)[0];
    assert.match(armFn, /motionContextUrl: plan\.fromUrl/);

    // The derived twin is gone, so an episode cannot appear as two strips.
    assert.ok(!fs.existsSync(path.join(__dirname, '../src/studios/video/ChainTimeline.jsx')));
    assert.doesNotMatch(studio, /ChainTimeline/);
});

test('no prompt-grammar token renders in the copy a first-timer reads', () => {
    // The surfaces a first-timer meets: the composer chrome, the cast strip,
    // the references control and its vocabulary.
    const surfaces = [
        'src/studios/video/ReferencesMenu.jsx',
        'src/studios/video/referenceKinds.js',
        'src/studios/video/CastStrip.jsx',
        'src/studios/video/PersonaBar.jsx',
        'src/studios/video/promptCheckText.js',
    ];
    // Comments explain the grammar; that is where it belongs.
    const stripComments = (source) => source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
    const TOKEN = /<(Subject|Picture|Video|Audio)\s+[N\d]+>/;

    for (const file of surfaces) {
        const code = stripComments(read(file));
        // referenceKinds and CastStrip still BUILD the tokens (they are what the
        // model is told, and what the hover title shows); no token may be baked
        // into a sentence the user reads.
        const sentences = code.split('\n')
            .filter((line) => !/tag: \(index\) =>/.test(line))
            .filter((line) => !/const subjectToken = /.test(line))
            .filter((line) => !/: `<Subject \$\{number\}>`;/.test(line))
            .join('\n');
        assert.doesNotMatch(sentences, TOKEN, `${file} still speaks the model's grammar at the user`);
    }

    // The plain names exist and are what the rows are called.
    const kinds = read('src/studios/video/referenceKinds.js');
    assert.match(kinds, /export function plainReferenceLabel\(tag\)/);
    assert.match(read('src/studios/video/ReferencesMenu.jsx'), /\{plainReferenceLabel\(primaryTag\)\}/);
    // The cast chip reads "Person N", with the token as hover text only.
    const cast = read('src/studios/video/CastStrip.jsx');
    assert.match(cast, /`Person \$\{number\}`/);
    assert.match(cast, /title=\{subjectToken\}/);
    // The six sections have plain names in the check's wording.
    const check = read('src/studios/video/promptCheckText.js');
    assert.match(check, /subject_definitions: \(\) => 'who is in it'/);
    assert.match(check, /retention_analysis: \(\) => 'what carries over'/);
});

test('the tuning bench is not on screen until Advanced is opened, and what is armed is still named', async () => {
    // The guarantee this has always protected: the seed, the quality tier and
    // the refinement switch are a DISCLOSURE — you do not meet them on the way
    // to pressing Generate — and whatever is armed down there is named rather
    // than silently steering the render.
    //
    // It used to be checked as "not in the always-visible Format block, yes in
    // the shut CollapsibleSection, whose header carries advancedHint". There is
    // no Format block and no collapsible now: the whole drawer is the
    // disclosure, and StudioFrame renders its body ONLY while drawerOpen — so
    // the tuning bench is not merely folded away, it is not in the document.
    // That is the stronger claim, and it is the one a render can settle.
    const frame = {
        stage: React.createElement('div', null, 'stage'),
        composer: React.createElement('div', null, 'composer'),
        drawer: React.createElement('div', null, 'the tuning bench'),
        drawerTitle: 'Advanced',
        onDrawerClose: () => {},
    };
    const shut = await renderComponent('src/studios/frame/StudioFrame.jsx', 'StudioFrame', { ...frame, drawerOpen: false });
    assert.doesNotMatch(shut, /the tuning bench/, 'a shut Advanced still painted its body');
    const open = await renderComponent('src/studios/frame/StudioFrame.jsx', 'StudioFrame', { ...frame, drawerOpen: true });
    assert.match(open, /the tuning bench/, 'opening Advanced did not reveal its body');
    assert.match(open, /role="dialog" aria-label="Advanced"/);

    // And the Video studio is wired into exactly that slot: the bench is the
    // drawer, and s.advancedOpen is the only thing that opens it.
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /const panel = \(\n\s*<VideoAdvanced/, 'the drawer body is VideoAdvanced');
    assert.match(studio, /drawer=\{panel\}/);
    assert.match(studio, /drawerOpen=\{s\.advancedOpen\}/);

    // The bench itself — same three controls, now in the drawer's SAMPLING
    // section rather than at the bottom of a shut header.
    const advanced = read('src/studios/video/VideoAdvanced.jsx');
    const sampling = advanced.slice(
        advanced.indexOf('<DrawerSection label="Sampling"'),
        advanced.indexOf('<DrawerSection label="Avoid">'),
    );
    assert.ok(sampling.length > 0, 'SAMPLING is still a section of the drawer');
    assert.match(sampling, /label="Seed"/);
    assert.match(sampling, /label="Refinement"/);
    assert.match(sampling, /\{tierPair \? \(/, 'the quality tier is in SAMPLING');
    assert.match(studio, /tierPair=\{tierPairFor\(s\.catalogs\.hivemindI2V, s\.setup\.modelId\)\}/);

    // Nothing that stays on screen carries them — the three always-visible
    // surfaces of the new frame are where the old Format block's job went, and
    // a seed field appearing on one of them would be the regression.
    for (const file of [
        'src/studios/video/VideoComposerBar.jsx',
        'src/studios/video/VideoStage.jsx',
        'src/studios/video/VideoRail.jsx',
    ]) {
        const code = read(file);
        assert.doesNotMatch(code, /label="Seed"/, `${file} puts the seed on screen with Advanced shut`);
        assert.doesNotMatch(code, /label="Refinement"/, `${file} puts refinement on screen with Advanced shut`);
        assert.doesNotMatch(code, /tierPair/, `${file} puts the quality tier on screen with Advanced shut`);
    }

    // Hidden is fine; unsaid is not. advancedHint — the string that existed to
    // let the shut header say what was armed beneath it — still names a
    // non-default quality tier and a locked seed, and now heads the section
    // that owns them, so opening Advanced does not mean reading seven rows.
    assert.match(studio, /standardTierSelected \? 'best quality' : ''/);
    assert.match(studio, /Number\(s\.setup\.seed\) >= 0 \? `seed \$\{s\.setup\.seed\}` : ''/);
    assert.match(studio, /advancedHint=\{advancedHint\}/);
    assert.match(sampling, /<DrawerSection label="Sampling" hint=\{advancedHint\}>/);

    // The always-visible surface still names the armed state it does carry: the
    // chain token goes honey while a scene is continuing, and the `more` door
    // lights whenever anything behind it is armed.
    const composer = read('src/studios/video/VideoComposerBar.jsx');
    assert.match(composer, /value: `continuing shot \$\{chainShot\}`,\n\s*tone: 'honey',/);
    assert.match(composer, /const moreArmed = Boolean\(clipUrl\)/);
    assert.match(composer, /active=\{open \|\| moreArmed\}/);
});

test('the inpaint dialog cannot arm a run the workflow refuses', () => {
    const dialog = read('src/dialogs/VideoInpaintDialog.jsx');
    assert.match(dialog, /const ready = Boolean\(source && !busy && !noReference && \(mode === 'sam3' \|\| hasPaint\)\);/);
    // Never a problem without its fix in the same component.
    assert.match(dialog, /onAttachReference \? \(/);
    assert.match(dialog, /\{t\('inpaint\.attachAPicture'\)\}/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /onAttachReference=\{\(\) => \{[\s\S]*?s\.referencesOpenRequest = \(s\.referencesOpenRequest \|\| 0\) \+ 1;/);
});

test('the LTX views ride in the References control, not a panel section of their own', () => {
    // Unchanged contract, two mounting points. "Use this person" is ONE
    // control; LTX's stitched reference views are that model's own reference
    // kind, not a section of settings with a jump button pointing at it. The
    // frame draws References twice now — the drawer's copy, and the composer's
    // frames door — so both have to open for a views-only model.
    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /const ingredientViews = ingredientModel \? \(\n\s*<IngredientsPanel/);
    assert.equal(
        (studio.match(/<IngredientsPanel/g) || []).length, 1,
        'the views panel is built once and handed to References — never mounted as a section',
    );

    const surfaces = [
        ['src/studios/VideoStudio.jsx', /const drawerReferences = referenceEntry \|\| ingredientModel \? \(/],
        ['src/studios/video/VideoComposerBar.jsx', /\{referenceEntry \|\| ingredientModel \? \(/],
    ];
    for (const [file, gate] of surfaces) {
        const code = read(file);
        // The control renders for a model whose only reference kind is views.
        assert.match(code, gate, `${file} no longer opens References for a views-only model`);
        const element = code.match(/<ReferencesMenu[\s\S]*?\n\s*\/>/);
        assert.ok(element, `${file} no longer mounts ReferencesMenu`);
        assert.match(element[0], /views=\{ingredientViews\}/, `${file} drops the stitched views`);
        assert.match(element[0], /viewsOnly=\{!referenceEntry\}/, `${file} does not mark a views-only model`);
    }

    // And the jump button that pointed at the old panel is gone — from the
    // studio and from both files its JSX moved into.
    for (const file of [
        'src/studios/VideoStudio.jsx',
        'src/studios/video/VideoAdvanced.jsx',
        'src/studios/video/VideoComposerBar.jsx',
    ]) {
        assert.doesNotMatch(read(file), /Open LTX Ingredients/, `${file} still jumps to a views panel`);
    }

    const menu = read('src/studios/video/ReferencesMenu.jsx');
    assert.match(menu, /views = null,/);
    assert.match(menu, /viewsOnly = false,/);
    assert.match(menu, /\{\(viewsOnly \? \[\] : KINDS\)\.map\(\(kind\) => \(/);
});
