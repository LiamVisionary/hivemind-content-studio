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
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('no prompt-grammar token renders outside the fold', () => {
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
    assert.match(check, /subject_definitions: \(\) => \(zh\(\) \? '主体定义' : 'who is in it'\)/);
    assert.match(check, /retention_analysis: \(\) => \(zh\(\) \? '保留分析' : 'what carries over'\)/);
});

test('the tuning bench is behind Advanced, and the closed header names what is armed', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    const format = studio.slice(
        studio.indexOf("<SectionLabel>{zh() ? '格式' : 'Format'}</SectionLabel>"),
        studio.indexOf("<CollapsibleSection title={zh() ? '高级' : 'Advanced'}"),
    );
    assert.ok(format.length > 0, 'the Format section is still there');
    assert.doesNotMatch(format, /label=\{zh\(\) \? '种子' : 'Seed'\}/, 'no seed in Format');
    assert.doesNotMatch(format, /tierPairFor/, 'no model tier in Format');
    assert.doesNotMatch(format, /label=\{zh\(\) \? '精修' : 'Refinement'\}/, 'no refinement in Format');

    const advanced = studio.slice(studio.indexOf("<CollapsibleSection title={zh() ? '高级' : 'Advanced'}"));
    assert.match(advanced, /label=\{zh\(\) \? '种子' : 'Seed'\}/);
    assert.match(advanced, /tierPairFor\(s\.catalogs\.hivemindI2V, s\.setup\.modelId\)/);
    assert.match(advanced, /label=\{zh\(\) \? '精修' : 'Refinement'\}/);

    // Hidden is fine; unsaid is not.
    assert.match(studio, /standardTierSelected \? \(zh\(\) \? '最佳画质' : 'best quality'\) : ''/);
    assert.match(studio, /Number\(s\.setup\.seed\) >= 0 \? \(zh\(\) \? `种子 \$\{s\.setup\.seed\}` : `seed \$\{s\.setup\.seed\}`\) : ''/);
});

test('the inpaint dialog cannot arm a run the workflow refuses', () => {
    const dialog = read('src/dialogs/VideoInpaintDialog.jsx');
    assert.match(dialog, /const ready = Boolean\(source && !busy && !noReference && \(mode === 'sam3' \|\| hasPaint\)\);/);
    // Never a problem without its fix in the same component.
    assert.match(dialog, /onAttachReference \? \(/);
    assert.match(dialog, /Attach a picture/);

    const studio = read('src/studios/VideoStudio.jsx');
    assert.match(studio, /onAttachReference=\{\(\) => \{[\s\S]*?s\.referencesOpenRequest = \(s\.referencesOpenRequest \|\| 0\) \+ 1;/);
});

test('the LTX views ride in the References control, not a panel section of their own', () => {
    const studio = read('src/studios/VideoStudio.jsx');
    // One control: the References chip renders for a views-only model too.
    assert.match(studio, /\{referenceEntry \|\| ingredientModel \? \(/);
    assert.match(studio, /views=\{ingredientViews\}/);
    assert.match(studio, /viewsOnly=\{!referenceEntry\}/);
    // And the jump button that pointed at the old panel is gone.
    assert.doesNotMatch(studio, /Open LTX Ingredients/);

    const menu = read('src/studios/video/ReferencesMenu.jsx');
    assert.match(menu, /views = null,/);
    assert.match(menu, /viewsOnly = false,/);
    assert.match(menu, /\{\(viewsOnly \? \[\] : KINDS\)\.map\(\(kind\) => \(/);
});
