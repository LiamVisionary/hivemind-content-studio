// Hive Persona ID — the rules that decide what a saved character IS, what
// counts as editing one, and what happens when the world has moved on since it
// was saved.
const test = require('node:test');
const assert = require('node:assert/strict');

async function load() {
    return import('../src/lib/personaId.js');
}

const CHERYL = {
    images: ['/api/media-studio/references/face-a.png', '/api/media-studio/references/face-b.png'],
    videos: [{ url: '/api/media-studio/references/walk.mp4', name: 'walk.mp4', useAudio: true }],
    audios: [{ url: '/api/media-studio/references/voice.m4a', name: 'voice.m4a' }],
};

test('a persona is the three reference rows, in the order they were attached', async () => {
    const { personaFromReferences } = await load();
    const persona = personaFromReferences(CHERYL);
    // Order IS the labelling: reference N is the prompt's <Kind N>.
    assert.deepEqual(persona.images, CHERYL.images);
    assert.equal(persona.videos[0].useAudio, true);
    assert.equal(persona.audios[0].name, 'voice.m4a');
    assert.equal(persona.v, 1);
});

test('junk entries are dropped rather than saved as broken slots', async () => {
    const { personaFromReferences, personaCounts } = await load();
    const persona = personaFromReferences({
        images: ['/a.png', '', null, 42],
        videos: [{ name: 'no url' }, { url: '/b.mp4' }],
        audios: [{ url: '/c.m4a' }, {}],
    });
    assert.deepEqual(persona.images, ['/a.png']);
    assert.deepEqual(personaCounts(persona), { images: 1, videos: 1, audios: 1, total: 3 });
    assert.equal(persona.videos[0].useAudio, false, 'an absent flag is off, not undefined');
});

test('the summary names every kind it has and nothing it does not', async () => {
    const { personaSummary } = await load();
    assert.equal(personaSummary(CHERYL), '2 pictures · 1 motion clip · 1 voice clip');
    assert.equal(personaSummary({ images: ['/a.png'] }), '1 picture');
    assert.equal(personaSummary({}), 'No references');
});

test('reloading a persona does not report itself as edited', async () => {
    // The Save button only means something if it is dark until you change
    // something. A reference attached from the saved list carries no filename
    // while the freshly-uploaded one does, so names must not count as an edit.
    const { applyPersonaToReferences, personaFromReferences, samePersonaReferences } = await load();
    const loaded = applyPersonaToReferences(CHERYL);
    const nameless = {
        images: loaded.images,
        videos: loaded.videos.map(({ url, useAudio }) => ({ url, useAudio })),
        audios: loaded.audios.map(({ url }) => ({ url })),
    };
    assert.ok(samePersonaReferences(personaFromReferences(nameless), CHERYL));
});

test('every way of changing what the model is given counts as an edit', async () => {
    const { personaFromReferences, samePersonaReferences } = await load();
    const base = personaFromReferences(CHERYL);
    const differs = (change) => assert.ok(
        !samePersonaReferences(base, personaFromReferences({ ...CHERYL, ...change })),
    );
    differs({ images: [CHERYL.images[1], CHERYL.images[0]] });          // reordered — renumbers <Picture N>
    differs({ images: [...CHERYL.images, '/api/media-studio/references/face-c.png'] });
    differs({ images: [CHERYL.images[0]] });
    differs({ videos: [{ ...CHERYL.videos[0], useAudio: false }] });    // its soundtrack no longer rides along
    differs({ audios: [] });
});

test('a reference deleted since the save is reported, not silently attached', async () => {
    const { applyPersonaToReferences } = await load();
    const known = new Set([CHERYL.images[0], CHERYL.videos[0].url, CHERYL.audios[0].url]);
    const result = applyPersonaToReferences(CHERYL, { known });
    assert.deepEqual(result.images, [CHERYL.images[0]]);
    assert.deepEqual(result.missing, ['a picture']);
    assert.equal(result.videos.length, 1);
});

test('a missing clip is named by its filename so it can be replaced', async () => {
    const { applyPersonaToReferences } = await load();
    const result = applyPersonaToReferences(CHERYL, { known: new Set(CHERYL.images) });
    assert.deepEqual(result.missing, ['walk.mp4', 'voice.m4a']);
});

test('an unreachable listing loads the persona whole rather than emptying it', async () => {
    const { applyPersonaToReferences } = await load();
    // known: null is "could not check", which must never be read as "all gone".
    const result = applyPersonaToReferences(CHERYL, { known: null });
    assert.equal(result.images.length, 2);
    assert.deepEqual(result.missing, []);
});

test('a persona is trimmed to the slots the running workflow actually has', async () => {
    const { applyPersonaToReferences } = await load();
    const wide = { images: ['/1.png', '/2.png', '/3.png'], videos: [], audios: [] };
    const result = applyPersonaToReferences(wide, { limits: { images: 2, videos: 3, audios: 3 } });
    assert.deepEqual(result.images, ['/1.png', '/2.png']);
    assert.deepEqual(result.trimmed, [{ kind: 'images', dropped: 1 }]);
});

test('the first picture is the persona face', async () => {
    const { personaPrimaryImage, personaIsEmpty } = await load();
    assert.equal(personaPrimaryImage(CHERYL), CHERYL.images[0]);
    assert.equal(personaPrimaryImage({ videos: CHERYL.videos }), null);
    assert.equal(personaIsEmpty({}), true);
    assert.equal(personaIsEmpty(CHERYL), false);
});

// Portable personas. A persona in the vault is owner-sealed POINTERS, which
// mean nothing on another machine — so a persona that travels carries its media
// inline, and the file someone hands you is data, never instructions.

test('an exported persona carries its media, not its pointers', async () => {
    const { buildPersonaExport, parsePersonaExport } = await load();
    const media = {
        '/a.png': 'data:image/png;base64,AAA',
        '/walk.mp4': 'data:video/mp4;base64,BBB',
        '/voice.wav': 'data:audio/wav;base64,CCC',
    };
    const { document: doc } = buildPersonaExport({
        name: 'Cheryl',
        persona: {
            images: ['/a.png'],
            videos: [{ url: '/walk.mp4', name: 'walk.mp4', useAudio: true }],
            audios: [{ url: '/voice.wav', name: 'voice.wav' }],
        },
        media,
    });
    // No sealed URL survives into the document: it would be unreadable anywhere
    // else, and it names the owner's own storage.
    assert.doesNotMatch(JSON.stringify(doc), /\/a\.png|\/walk\.mp4|\/voice\.wav/);

    const back = parsePersonaExport(JSON.stringify(doc));
    assert.equal(back.name, 'Cheryl');
    assert.equal(back.images[0].dataUrl, media['/a.png']);
    // The soundtrack switch is part of the character, so it travels too.
    assert.equal(back.videos[0].useAudio, true);
    assert.equal(back.audios[0].name, 'voice.wav');
});

test('a reference whose bytes could not be read is reported, not exported empty', async () => {
    const { buildPersonaExport } = await load();
    const { document: doc, dropped } = buildPersonaExport({
        name: 'Half',
        persona: { images: ['/readable.png', '/locked.png'], videos: [], audios: [] },
        media: { '/readable.png': 'data:image/png;base64,AAA' },
    });
    assert.equal(doc.images.length, 1);
    assert.equal(dropped.length, 1, 'a persona arriving smaller than it was saved must say so');
});

test('an import refuses anything that is not inline media', async () => {
    const { parsePersonaExport } = await load();
    const refuses = (value, why) => assert.throws(() => parsePersonaExport(value), Error, why);

    refuses('{not json', 'malformed files are refused');
    refuses(JSON.stringify({ kind: 'something-else', v: 1 }), 'a foreign document is refused');
    refuses(JSON.stringify({ kind: 'hive-persona', v: 1, images: [] }), 'an empty persona is refused');
    // The one that matters for a file a stranger sent you: a remote URL would
    // make the importer fetch whatever it points at.
    refuses(
        JSON.stringify({ kind: 'hive-persona', v: 1, images: [{ dataUrl: 'https://example.test/x.png' }] }),
        'remote urls are not media',
    );
    refuses(
        JSON.stringify({ kind: 'hive-persona', v: 99, images: [{ dataUrl: 'data:image/png;base64,AAA' }] }),
        'a newer format is refused rather than half-read',
    );
});

test('the export filename is readable and safe on every OS', async () => {
    const { personaExportFilename } = await load();
    assert.equal(personaExportFilename('Cheryl'), 'cheryl.hivepersona.json');
    assert.equal(personaExportFilename('Cheryl / “v2” 🎬'), 'cheryl-v2.hivepersona.json');
    assert.equal(personaExportFilename(''), 'persona.hivepersona.json');
});

test('a reference the listing cannot see is not treated as deleted', async () => {
    const { applyPersonaToReferences } = await load();
    // The listing enumerates the saved-reference route only. A picture reused
    // from a generated output lives somewhere else entirely — it was never in
    // that listing, so its absence says nothing about whether it still exists.
    // Judging it anyway dropped it on every load (2026-08-12).
    const persona = {
        images: [
            '/api/media-studio/generated/cmf-abc-frame.png.e2e',
            '/api/media-studio/references/reference-live.png',
        ],
        videos: [{ url: '/api/media-studio/references/reference-gone.mp4', name: 'walk.mp4' }],
        audios: [],
    };
    const known = new Set(['/api/media-studio/references/reference-live.png']);
    const result = applyPersonaToReferences(persona, { known });

    assert.deepEqual(result.images, persona.images, 'an unlistable picture survives the load');
    // A reference that IS in the listing's namespace and absent from it really
    // was deleted, and still has to be reported.
    assert.deepEqual(result.videos, []);
    assert.equal(result.missing.length, 1);
});

test('an incomplete export says so IN THE FILE, not just in a toast', async () => {
    const { buildPersonaExport, parsePersonaExport } = await load();
    // A backup that quietly ships fewer references than the character had is
    // worse than no backup, because it looks complete. The toast is gone in a
    // few seconds; the file outlives it.
    const { document: doc } = buildPersonaExport({
        name: 'Cheryl',
        persona: {
            images: ['/a.png'],
            videos: [],
            audios: [{ url: '/voice.wav', name: 'voice.wav' }],
        },
        media: { '/a.png': 'data:image/png;base64,AAA' }, // the voice would not decrypt
    });
    assert.deepEqual(doc.savedCounts, { images: 1, videos: 0, audios: 1 });
    assert.equal(doc.audios.length, 0);
    assert.ok(doc.incomplete?.length, 'the document names what it could not carry');

    // A complete export carries no incomplete marker at all.
    const { document: whole } = buildPersonaExport({
        name: 'Cheryl',
        persona: { images: ['/a.png'], videos: [], audios: [] },
        media: { '/a.png': 'data:image/png;base64,AAA' },
    });
    assert.equal(whole.incomplete, undefined);
    assert.deepEqual(parsePersonaExport(JSON.stringify(whole)).images.length, 1);
});
