// Circle a spot: the mark, and the sentences that stop it being drawn.
//
// The feature is two halves and BOTH have to hold. The ring goes into the
// pixels, because H3 takes no coordinates for part of a reference; and the
// prompt has to be told what the ring means, because an unexplained coloured
// circle in a reference picture is just an object, and what a model does with
// an object in a reference is draw it. So these pin the geometry (which decides
// whether the mark survives the encode at all) and the compiled prompt (which
// decides whether the mark is read as an instruction) together.
//
// Deliberately textual: the last two are the studio wiring around the rules
// above. Circling a spot goes through a canvas (jsdom has no 2D context), an
// upload, and a VideoStudio engine that takes ~90 props — none of which a render
// can stand up — while the claims that matter are structural: the circled copy
// lands in the row the original occupied, the original comes back when the row
// stops being a spot, and the switch opens the editor rather than entering a
// mode with nothing drawn in it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const lib = (name) => import(`../src/lib/${name}.js`);

const SPOT = { x: 0.1, y: 0.1, w: 0.25, h: 0.25, color: 'red', view: 'photo', source: '/map.jpg' };

test('a spot is normalized geometry, and a circle too small to hold a place is not one', async () => {
    const { normalizeSpot, MIN_SPOT } = await lib('sceneSpot');

    const spot = normalizeSpot({ x: -0.4, y: 0.5, w: 0.3, h: 0.9, color: 'nonsense', view: 'nonsense' });
    assert.equal(spot.x, 0, 'dragged off the left edge, it starts at the edge');
    // Clamped against the ORIGIN, not re-centred: the left edge stays where it
    // was put and the circle simply ends at the picture's edge.
    assert.equal(spot.y, 0.5);
    assert.equal(spot.h, 0.5, 'and ends at the bottom rather than overflowing it');
    assert.equal(spot.color, 'red', 'an unknown colour is the one that is known to work');
    assert.equal(spot.view, 'photo');

    // Below the floor there is nothing inside the ring to identify — at H3's
    // 768px reference canvas it is a dot, not a place.
    assert.equal(normalizeSpot({ ...SPOT, w: MIN_SPOT / 2 }), null);
    assert.equal(normalizeSpot(null), null);
    assert.equal(normalizeSpot({}), null);
});

test('the ring is thick enough to survive the reference canvas, at any resolution', async () => {
    const { spotGeometry } = await lib('sceneSpot');

    // The failure this is here for: a hairline drawn at a phone photo's native
    // 4032px is under two pixels once H3 stages the picture at a 768 short
    // edge — a circle that survives the editor's preview and not the encode.
    const phone = spotGeometry(SPOT, 4032, 3024);
    const staged = phone.lineWidth * (768 / 3024);
    assert.ok(staged >= 3, `a 4032px circle is still ${staged.toFixed(1)}px on the reference canvas`);

    // The same fraction on a small picture would be invisible, so there is a floor.
    assert.equal(spotGeometry(SPOT, 120, 90).lineWidth, 3);

    // Centre and radii come off the box; the stroke is inset by half its width
    // so a circle at the picture's edge is not clipped in half.
    const box = spotGeometry({ ...SPOT, x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 1000, 1000);
    assert.equal(box.cx, 400);
    assert.equal(box.cy, 400);
    assert.equal(box.rx, 200);
    assert.equal(box.color, '#FF1F1F');
});

test('the circle places itself in words, on the same thirds the region boxes use', async () => {
    const { spotPlaceWords, describeSpot } = await lib('sceneSpot');
    const { regionThirds } = await lib('regionPrompt');

    assert.equal(spotPlaceWords({ x: 0.05, y: 0.05, w: 0.2, h: 0.2 }), 'top left');
    assert.equal(spotPlaceWords({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), 'center');
    assert.equal(spotPlaceWords({ x: 0.7, y: 0.7, w: 0.25, h: 0.25 }), 'bottom right');
    assert.equal(spotPlaceWords({ x: 0.05, y: 0.4, w: 0.2, h: 0.2 }), 'left');

    // One rule, two callers: a control that said "top left" while another said
    // "center" about the same box would be two features.
    assert.deepEqual(regionThirds({ x: 0.05, y: 0.05, w: 0.2, h: 0.2 }), { h: 'left', v: 'top' });

    assert.equal(describeSpot(SPOT), 'red circle, top left');
    assert.equal(describeSpot({ ...SPOT, color: 'cyan' }), 'cyan circle, top left');
});

test('the sentences name the colour drawn, and forbid the ring', async () => {
    const { spotDefinitionSentence, spotRetentionLine } = await lib('sceneSpot');

    const definition = spotDefinitionSentence({ labels: ['<Picture 3>'], spot: SPOT });
    assert.match(definition, /<Picture 3>/);
    assert.match(definition, /red circle/);
    assert.match(definition, /top left/, 'the position is written out, so the instruction survives a lost ring');
    assert.match(definition, /chooses where this clip is set/);
    assert.match(definition, /must NEVER appear in the video/);
    assert.match(definition, /holds no subject and is not a person/, 'a picture nothing accounts for becomes a subject');

    // The colour in the words is the colour on the pixels, always.
    assert.match(spotDefinitionSentence({ labels: ['<Picture 1>'], spot: { ...SPOT, color: 'yellow' } }), /yellow circle/);
    assert.doesNotMatch(spotDefinitionSentence({ labels: ['<Picture 1>'], spot: { ...SPOT, color: 'yellow' } }), /red/);

    const retention = spotRetentionLine({ label: '<Picture 3>', spot: SPOT });
    assert.match(retention, /^<Picture 3>: attribute_transfer —/, "H3's own retention grammar, not a new one");
    assert.match(retention, /POSITIONAL instruction/);
    assert.match(retention, /does not carry into\s+a single frame|does not carry into a single frame/);
});

test('a map is translated to the ground; a photograph is not', async () => {
    const { spotDefinitionSentence } = await lib('sceneSpot');

    const map = spotDefinitionSentence({ labels: ['<Picture 3>'], spot: { ...SPOT, view: 'map' } });
    assert.match(map, /ground-level scene/);
    assert.match(map, /No frame of this clip is a map, a plan view or an aerial shot/);

    // Telling a ground-level photograph to translate itself from above invites
    // an aerial the model was never shown.
    const photo = spotDefinitionSentence({ labels: ['<Picture 3>'], spot: SPOT });
    assert.doesNotMatch(photo, /map/i);
    assert.doesNotMatch(photo, /aerial/i);
    assert.match(photo, /Stay in the circled part of <Picture 3>/);
});

test('the cast compiler files a circled picture as a place, never as a person', async () => {
    const { compileCastPrompt, castPersona, castScene } = await lib('castPrompt');
    const { sectionBodyIn } = await lib('h3PromptCheck');

    const compiled = compileCastPrompt({
        members: [
            castPersona('Cheryl', { images: ['/c1.jpg', '/c2.jpg'], gender: 'female', look: 'red coat' }),
            castScene('', { images: ['/map-circled.jpg'], retention: 'spot', spot: SPOT }),
        ],
        template: {},
        scaffold: true,
    });

    // The place is picture 3 and takes NO subject number: the person keeps
    // <Subject 1> and nobody is invented for the map.
    assert.match(compiled.prompt, /<Subject 1> is the woman shown in <Picture 1>, <Picture 2>/);
    assert.doesNotMatch(compiled.prompt, /<Subject 2>/);
    assert.match(compiled.prompt, /<Picture 3> is a location guide/);
    assert.match(compiled.prompt, /must NEVER appear in the video/);

    // And its contract is the spot's, not the generic place one.
    const retention = sectionBodyIn(compiled.prompt, 'retention_analysis');
    assert.match(retention, /<Picture 3>: attribute_transfer — read it as a POSITIONAL instruction/);
    assert.doesNotMatch(retention, /<Picture 3>: attribute_transfer — the place, its light/);

    // The auto-written summary puts the take IN the circled area — the
    // definition says where the clip is set, the summary is what sends the
    // subjects there.
    assert.match(sectionBodyIn(compiled.prompt, 'summary'), /Set in the area circled in <Picture 3>, seen from the ground/);
});

test('a circled place with nobody attached still gets a summary', async () => {
    const { compileCastPrompt, castScene } = await lib('castPrompt');
    const { sectionBodyIn } = await lib('h3PromptCheck');

    // Pick a location, describe the shot, attach no character sheet — an
    // ordinary way to use this, and the one that left summary: empty. An empty
    // summary is not merely unhelpful: it is one of the six fields H3 reads.
    const compiled = compileCastPrompt({
        members: [castScene('', { images: ['/map-circled.jpg'], retention: 'spot', spot: SPOT })],
        template: { detailed_description: 'A woman in a red coat walks to the end of the jetty.' },
        scaffold: true,
    });
    assert.equal(
        sectionBodyIn(compiled.prompt, 'summary'),
        'One continuous take, set in the area circled in <Picture 1>, seen from the ground.',
    );

    // No circle and nobody: there is genuinely nothing to summarise, and an
    // invented sentence would be worse than none.
    const plain = compileCastPrompt({
        members: [castScene('the harbour', { images: ['/plate.jpg'] })],
        template: { detailed_description: 'A jetty at golden hour.' },
        scaffold: true,
    });
    assert.equal(sectionBodyIn(plain.prompt, 'summary'), '');
});

test('an uncircled place keeps the sentences it always had', async () => {
    const { compileCastPrompt, castPersona, castScene } = await lib('castPrompt');
    const { sectionBodyIn } = await lib('h3PromptCheck');

    const compiled = compileCastPrompt({
        members: [
            castPersona('Cheryl', { images: ['/c1.jpg'], gender: 'female', look: 'red coat' }),
            castScene('the harbour shelter', { images: ['/plate.jpg'] }),
        ],
        template: {},
        scaffold: true,
    });
    assert.match(compiled.prompt, /<Picture 2> is a reference for the place itself/);
    assert.doesNotMatch(compiled.prompt, /circle/i);
    assert.doesNotMatch(sectionBodyIn(compiled.prompt, 'summary'), /Set in the area circled/);
});

test('Prompt Check will not let a circled picture reach a run the prompt never mentions', async () => {
    const { checkH3Prompt } = await lib('h3PromptCheck');
    const { compileCastPrompt, castPersona, castScene } = await lib('castPrompt');

    const images = ['/c1.jpg', '/map-circled.jpg'];
    const scenes = [{ url: '/map-circled.jpg', retention: 'spot', spot: SPOT }];

    // Typed straight in: the ring is in the pixels and nothing explains it.
    const silent = checkH3Prompt({
        prompt: 'A woman walks along a jetty at golden hour.',
        images,
        scenes,
    });
    const unused = silent.findings.find((finding) => finding.code === 'spot-unused');
    assert.ok(unused, 'a circle the prompt never mentions is reported');
    assert.equal(unused.label, '<Picture 2>', 'named by the row it is on');
    assert.equal(unused.color, 'red');
    assert.equal(unused.where, 'top left', 'the colour and the place ride apart, so the finding reads as a sentence');
    assert.equal(unused.level, 'warn');

    // The weave is its fix, so after one it is gone.
    const woven = compileCastPrompt({
        members: [
            castPersona('Cheryl', { images: ['/c1.jpg'], gender: 'female', look: 'red coat' }),
            castScene('', { images: ['/map-circled.jpg'], retention: 'spot', spot: SPOT }),
        ],
        template: { detailed_description: 'A woman walks along a jetty at golden hour.' },
        scaffold: true,
    });
    const after = checkH3Prompt({ prompt: woven.prompt, images, scenes });
    assert.equal(after.findings.filter((finding) => finding.code === 'spot-unused').length, 0);

    // A row claiming a spot with nothing circled can only come from a restored
    // draft, and is an error rather than a silent no-op.
    const empty = checkH3Prompt({
        prompt: 'A woman walks along a jetty.',
        images,
        scenes: [{ url: '/map-circled.jpg', retention: 'spot', spot: null }],
    });
    assert.ok(empty.findings.some((finding) => finding.code === 'spot-uncircled' && finding.level === 'error'));

    // An uncircled place says nothing here at all.
    const plain = checkH3Prompt({
        prompt: 'A woman walks along a jetty.',
        images,
        scenes: [{ url: '/map-circled.jpg', retention: 'attribute_transfer', spot: null }],
    });
    assert.equal(plain.findings.filter((finding) => finding.code.startsWith('spot-')).length, 0);
});

test('the weave offers itself as the fix, in the reader\'s words', () => {
    const menu = read('src/studios/video/PromptCheckMenu.jsx');
    assert.match(menu, /'spot-unused'\]\)/, 'spot-unused is weavable');
    assert.match(menu, /checkH3Prompt\(\{[^}]*scenes \}\)/, 'and the check is actually told about the scene rows');

    // The finding says what the clip will DO, and names the row the way the
    // panel does rather than in the model's grammar.
    const text = read('src/studios/video/promptCheckText.js');
    assert.match(text, /case 'spot-unused':/);
    assert.match(text, /plainReferenceLabel\(finding\.label\)/);
    assert.match(text, /A \$\{finding\.color\} circle is drawn on the \$\{finding\.where\} of/);
    assert.match(text, /something it will draw into the video/);
});

test('the circled copy replaces the picture in place, and leaving the role takes it back off', () => {
    const studio = read('src/studios/VideoStudio.jsx');

    // The row's position is the <Picture N> numbering, so the circled copy goes
    // where the original was — a picture appended at the end would renumber the
    // prompt underneath the user.
    assert.match(studio, /images: \(s\.setup\.referenceImageUrls \|\| \[\]\)\.map\(\(item\) => \(item === editing\.url \? circled : item\)\)/);
    // The original rides on the spot, which is what makes removal exact.
    assert.match(studio, /const armed = \{ \.\.\.spot, source \};/);
    assert.match(studio, /retention: 'spot', carries: '', spot: armed/);
    // Rows first, then the weave: the same order every other row change takes.
    assert.match(studio, /s\.spotEdit = null;\n\s+s\.spotBusy = false;\n\s+\/\/ Rows first/);

    // Leaving the spot role restores the original picture — a ring in the
    // pixels under a prompt that no longer explains it is a ring in the video.
    assert.match(studio, /if \(circled && retention !== 'spot' && circled\.spot\.source\) \{\n\s+removeSceneSpot\(url, retention\);/);
    assert.match(studio, /spotMemory\(\)\.set\(source, member\.spot\);/);
    assert.match(studio, /images: \(s\.setup\.referenceImageUrls \|\| \[\]\)\.map\(\(item\) => \(item === url \? source : item\)\)/);

    // The cast survives a rebuild of the scene rows — a spot dropped when a
    // different row was edited would leave a circled picture with no sentences.
    assert.match(studio, /spot: said\[url\]\?\.spot \|\| null,/);

    // The role and the circle are ONE act: the switch opens the editor rather
    // than entering a mode with nothing drawn in it.
    const panel = read('src/studios/video/ReferencesMenu.jsx');
    assert.match(panel, /onClick=\{\(\) => \(option\.id === 'spot' \? onSpot\?\.\(\) : onRole\?\.\(option\.id\)\)\}/);
});
