// The decrypted-media cache is a memory budget, not a lookup table.
//
// Before this, every picture and clip a session decrypted stayed in the renderer
// behind an object URL until the vault locked — a browse through a large library
// on a 16 GB Mac ended up fighting the local model for unified memory. These
// tests pin the two halves of the fix: a byte ceiling with least-recently-used
// eviction, and a reference count so an object URL is never revoked while a
// mounted component is still pointing an <img> at it.
const test = require('node:test');
const assert = require('node:assert/strict');

function stubBrowser() {
    const revoked = [];
    global.window = { location: { search: '' }, dispatchEvent: () => {} };
    global.CustomEvent = class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    global.sessionStorage = { getItem: () => null };
    global.URL = { createObjectURL: () => 'blob:mock/x', revokeObjectURL: (url) => revoked.push(url) };
    return revoked;
}

// A data: URL of a known length, so the cache's byte accounting is checkable
// without standing up the whole seal/decrypt path.
const picture = (bytes) => `data:image/png;base64,${'A'.repeat(Math.max(0, bytes - 22))}`;

async function loadMedia(tag) {
    return import(`../src/lib/e2eMedia.js?case=${Date.now()}-${tag}`);
}

test('media cache: the oldest unheld entry is evicted once the budget is passed', async () => {
    const revoked = stubBrowser();
    const media = await loadMedia('budget');
    media.setResolvedMediaBudget(2500);

    media.primeResolvedMedia('/api/a.png', picture(1000));
    media.primeResolvedMedia('/api/b.png', picture(1000));
    assert.equal(media.resolvedMediaCacheStats().entries, 2);

    media.primeResolvedMedia('/api/c.png', picture(1000));
    assert.equal(media.peekResolvedMediaSrc('/api/a.png'), null, 'the least recently used entry went');
    assert.ok(media.peekResolvedMediaSrc('/api/b.png'), 'the newer ones stayed');
    assert.ok(media.peekResolvedMediaSrc('/api/c.png'));
    assert.ok(media.resolvedMediaCacheStats().bytes <= 2500, 'the cache is back under its ceiling');
    assert.deepEqual(revoked, [picture(1000)], 'the evicted object URL was revoked exactly once');
});

test('media cache: a read is what makes an entry recent', async () => {
    stubBrowser();
    const media = await loadMedia('lru');
    media.setResolvedMediaBudget(2500);

    media.primeResolvedMedia('/api/a.png', picture(1000));
    media.primeResolvedMedia('/api/b.png', picture(1000));
    // Looking at A again is what a scroll back up does; B is now the oldest.
    media.peekResolvedMediaSrc('/api/a.png');
    media.primeResolvedMedia('/api/c.png', picture(1000));

    assert.ok(media.peekResolvedMediaSrc('/api/a.png'), 'the entry that was read again survived');
    assert.equal(media.peekResolvedMediaSrc('/api/b.png'), null, 'the untouched one went instead');
});

test('media cache: an entry a mounted component holds is never revoked', async () => {
    const revoked = stubBrowser();
    const media = await loadMedia('held');
    media.setResolvedMediaBudget(2500);

    media.primeResolvedMedia('/api/on-screen.png', picture(1000));
    // Two consumers: a gallery card and the lightbox over the same picture.
    media.retainResolvedMedia('/api/on-screen.png');
    media.retainResolvedMedia('/api/on-screen.png');
    media.primeResolvedMedia('/api/older.png', picture(1100));
    media.primeResolvedMedia('/api/newest.png', picture(1200));

    // Read through the accounting, not a peek: a read is itself the recency
    // signal, and peeking here would move the held entry out of harm's way and
    // quietly change what the rest of this test is measuring.
    assert.equal(media.peekResolvedMediaSrc('/api/older.png'), null, 'the oldest UNHELD one went');
    assert.deepEqual(revoked, [picture(1100)], 'the held one was left alone — revoking it blanks a live <img>');
    assert.equal(media.resolvedMediaCacheStats().bytes, 2200, 'the held entry is still in the cache');

    // One consumer unmounting is not enough — the other is still showing it.
    media.releaseResolvedMedia('/api/on-screen.png');
    assert.equal(media.resolvedMediaCacheStats().held, 1);
    media.releaseResolvedMedia('/api/on-screen.png');
    assert.equal(media.resolvedMediaCacheStats().held, 0);
    // Checked through the accounting rather than a peek, because a read is
    // itself a recency signal and would move this entry out of harm's way.
    assert.equal(media.resolvedMediaCacheStats().bytes, 2200, 'unmounting alone throws no bytes away');

    // …but it is now the entry the next arrival is allowed to push out.
    media.primeResolvedMedia('/api/next.png', picture(1300));
    assert.equal(media.peekResolvedMediaSrc('/api/on-screen.png'), null, 'released, so the next arrival may push it out');
    assert.deepEqual(revoked, [picture(1100), picture(1000)]);
});

test('media cache: retaining a URL that has not decrypted yet still protects it', async () => {
    stubBrowser();
    const media = await loadMedia('early');
    media.setResolvedMediaBudget(1500);

    // The hook retains at the top of its effect, before the decrypt resolves.
    media.retainResolvedMedia('/api/slow.png');
    media.primeResolvedMedia('/api/slow.png', picture(1000));
    media.primeResolvedMedia('/api/other.png', picture(1000));

    assert.ok(media.peekResolvedMediaSrc('/api/slow.png'), 'the burst did not evict it the moment it landed');
});

test('media cache: clearing on vault lock revokes everything and zeroes the accounting', async () => {
    const revoked = stubBrowser();
    const media = await loadMedia('clear');
    media.setResolvedMediaBudget(media.DEFAULT_MEDIA_CACHE_BUDGET_BYTES);

    media.primeResolvedMedia('/api/a.png', picture(1000));
    media.primeResolvedMedia('/api/b.png', picture(1000));
    assert.equal(media.resolvedMediaCacheStats().bytes, 2000);

    media.clearResolvedMediaCache();
    assert.equal(media.resolvedMediaCacheStats().entries, 0);
    assert.equal(media.resolvedMediaCacheStats().bytes, 0);
    assert.equal(revoked.length, 2);
});

test('media cache: the shipped budget is 256 MB', async () => {
    stubBrowser();
    const media = await loadMedia('default');
    assert.equal(media.DEFAULT_MEDIA_CACHE_BUDGET_BYTES, 256 * 1024 * 1024);
    assert.equal(media.resolvedMediaCacheStats().budget, 256 * 1024 * 1024);
});
