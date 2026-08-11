// Posters for sealed-media thumbnails.
//
// Verified for real in the browser against an ffmpeg-built clip that is black
// for its first 0.2s and red after: the produced poster's centre pixel came back
// (254, 0, 2), proving the seek lands past the opening rather than on frame 0.
// These pin that contract, plus the failure behaviour, with a stubbed DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// A <video> that reports `duration` and records where it was told to seek.
function stubDom({ duration = 10, fail = false, videoWidth = 320, videoHeight = 240 } = {}) {
    const seeks = [];
    const originals = { document: global.document };
    global.document = {
        createElement(tag) {
            if (tag === 'canvas') {
                return {
                    width: 0,
                    height: 0,
                    getContext: () => ({ drawImage() {} }),
                    toDataURL: () => 'data:image/jpeg;base64,STUB',
                };
            }
            const listeners = {};
            const element = {
                listeners,
                duration,
                videoWidth,
                videoHeight,
                addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
                removeAttribute() {},
                load() {},
                set currentTime(value) {
                    seeks.push(value);
                    queueMicrotask(() => listeners.seeked?.forEach((fn) => fn()));
                },
                set src(_value) {
                    queueMicrotask(() => (fail ? listeners.error : listeners.loadeddata)?.forEach((fn) => fn()));
                },
            };
            return element;
        },
    };
    return { seeks, restore: () => Object.assign(global, originals) };
}

async function loadPoster(tag) {
    return import(`${pathToFileURL(path.join(__dirname, '../src/lib/mediaPoster.js')).href}?test=${tag}`);
}

test('a poster is taken past the opening frame, never at 0', async () => {
    const { seeks, restore } = stubDom({ duration: 10 });
    try {
        const { captureVideoPoster } = await loadPoster('seek');
        const poster = await captureVideoPoster('blob:clip-a');
        assert.equal(poster, 'data:image/jpeg;base64,STUB');
        // Video routinely opens on black — a fade-in, a slate, a screen
        // recording's first compositor frame — so frame 0 is a black square as
        // uninformative as the icon it replaces.
        assert.equal(seeks.length, 1);
        assert.ok(seeks[0] > 0, 'seeks into the clip');
    } finally {
        restore();
    }
});

test('a very short clip seeks within its own duration', async () => {
    // Seeking past the end never fires `seeked`, which would hang the tile.
    const { seeks, restore } = stubDom({ duration: 0.2 });
    try {
        const { captureVideoPoster } = await loadPoster('short');
        await captureVideoPoster('blob:clip-short');
        assert.ok(seeks[0] <= 0.1, `expected a seek inside a 0.2s clip, got ${seeks[0]}`);
    } finally {
        restore();
    }
});

test('an undecodable clip resolves null instead of rejecting or hanging', async () => {
    const { restore } = stubDom({ fail: true });
    try {
        const { captureVideoPoster } = await loadPoster('fail');
        // A thumbnail is a nicety: the caller falls back to an icon, so this must
        // never become an unhandled rejection in a list render.
        assert.equal(await captureVideoPoster('blob:broken'), null);
    } finally {
        restore();
    }
});

test('a clip with no decodable dimensions resolves null', async () => {
    const { restore } = stubDom({ videoWidth: 0, videoHeight: 0 });
    try {
        const { captureVideoPoster } = await loadPoster('nodims');
        assert.equal(await captureVideoPoster('blob:dimensionless'), null);
    } finally {
        restore();
    }
});

test('each source decodes once and is served from cache after', async () => {
    const { seeks, restore } = stubDom({ duration: 10 });
    try {
        const { captureVideoPoster, peekMediaPoster } = await loadPoster('cache');
        const first = await captureVideoPoster('blob:clip-b');
        const second = await captureVideoPoster('blob:clip-b');
        assert.equal(second, first);
        assert.equal(seeks.length, 1, 'decoding is not free and a strip re-renders constantly');
        assert.equal(peekMediaPoster('blob:clip-b'), first);
        assert.equal(peekMediaPoster('blob:never-seen'), null);
    } finally {
        restore();
    }
});

test('concurrent requests for one source share a single decode', async () => {
    const { seeks, restore } = stubDom({ duration: 10 });
    try {
        const { captureVideoPoster } = await loadPoster('inflight');
        const [a, b] = await Promise.all([
            captureVideoPoster('blob:clip-c'),
            captureVideoPoster('blob:clip-c'),
        ]);
        assert.equal(a, b);
        assert.equal(seeks.length, 1);
    } finally {
        restore();
    }
});

// Pictures need the same treatment for a different reason: they render fine,
// but only after the whole sealed original has been fetched and decrypted —
// 3.6 MB to fill 36 pixels, which is why a panel of seven took seconds.
test('a picture reduces to a poster without needing a seek', async () => {
    const originals = { document: global.document, Image: global.Image };
    const drawn = [];
    global.document = {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: (...args) => drawn.push(args.length) }),
            toDataURL: () => 'data:image/jpeg;base64,IMG',
        }),
    };
    global.Image = class {
        constructor() {
            this.naturalWidth = 4000;
            this.naturalHeight = 3000;
            queueMicrotask(() => this.onload?.());
        }
        set src(_value) { /* the constructor already scheduled onload */ }
    };
    try {
        const { captureImagePoster } = await loadPoster('image');
        assert.equal(await captureImagePoster('blob:picture'), 'data:image/jpeg;base64,IMG');
        assert.equal(drawn.length, 1, 'one downscale, not one per render');
    } finally {
        Object.assign(global, originals);
    }
});

test('an undecodable picture resolves null rather than hanging a tile', async () => {
    const originals = { document: global.document, Image: global.Image };
    global.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => '' }) };
    global.Image = class {
        constructor() { queueMicrotask(() => this.onerror?.()); }
        set src(_value) {}
    };
    try {
        const { captureImagePoster } = await loadPoster('image-fail');
        assert.equal(await captureImagePoster('blob:broken-picture'), null);
    } finally {
        Object.assign(global, originals);
    }
});
