// The stored zip, checked against a real unzipper rather than against itself.
//
// A hand-rolled container that only this file's own reader can open is worse
// than no container, so the archive is written here and then extracted by the
// system `unzip` — the same code path a person double-clicking it would take.
// CRC-32 gets a published vector as well, because `unzip -t` is the only other
// thing that would notice a wrong one. The remaining tests read the bytes
// directly, for the fields an extractor trusts silently (the offsets) and for
// the one an old extractor ignores (the UTF-8 flag).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const load = () => import('../src/lib/zipStore.js');
const bytes = (text) => new TextEncoder().encode(text);

function hasUnzip() {
    try {
        execFileSync('unzip', ['-v'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('crc32 matches the published vector', async () => {
    const { crc32 } = await load();
    // The canonical check value for "123456789".
    assert.equal(crc32(bytes('123456789')), 0xCBF43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
});

test('an empty archive is still a valid archive', async () => {
    const { zipStore } = await load();
    const out = zipStore([]);
    assert.equal(out.length, 22, 'end-of-central-directory record only');
    assert.deepEqual([...out.slice(0, 4)], [0x50, 0x4B, 0x05, 0x06]);
});

test('entries without a name are dropped rather than written nameless', async () => {
    const { zipStore } = await load();
    const view = new DataView(zipStore([{ name: '', bytes: bytes('x') }, null]).buffer);
    assert.equal(view.getUint16(10, true), 0, 'no entries');
});

test('the archive a real unzip reads back is the archive that went in', async (t) => {
    if (!hasUnzip()) {
        t.skip('no unzip on this machine');
        return;
    }
    const { zipStore } = await load();

    // The shape a turntable export actually writes: a frames/ folder whose
    // names sort into orbit order, plus the recipe beside it.
    const files = [
        { name: 'frames/frame_0001.jpg', body: 'first frame bytes' },
        { name: 'frames/frame_0002.jpg', body: 'second frame bytes, a little longer' },
        { name: 'frames/frame_0003.jpg', body: '' },
        { name: 'README.md', body: '# Turntable capture\n\nCamera model: SIMPLE_PINHOLE\n' },
    ];
    const archive = zipStore(files.map((file) => ({ name: file.name, bytes: bytes(file.body) })));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zipstore-'));
    try {
        const file = path.join(dir, 'capture.zip');
        fs.writeFileSync(file, archive);

        // -t is the CRC check: a wrong checksum fails here and nowhere else.
        execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
        execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'out')], { stdio: 'pipe' });

        for (const entry of files) {
            const extracted = path.join(dir, 'out', entry.name);
            assert.equal(fs.readFileSync(extracted, 'utf8'), entry.body, entry.name);
        }
        // The folder is part of the handoff, not a naming convention.
        assert.deepEqual(
            fs.readdirSync(path.join(dir, 'out', 'frames')).sort(),
            ['frame_0001.jpg', 'frame_0002.jpg', 'frame_0003.jpg'],
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Asserted on the BYTES rather than through `unzip`, and the reason is worth
// writing down: macOS ships Info-ZIP 6.0, which predates the general-purpose
// UTF-8 flag (bit 11) and decodes every name as CP437 regardless — it mangles
// this archive, and a correctly flagged UTF-8 name is exactly what it mangles.
// Python's zipfile, which does honour the flag, reads the same archive back
// intact. So the check is that the flag is set and the name is written as
// UTF-8; the round trip through a real extractor is covered above, on the ASCII
// names this feature actually writes.
test('a non-ASCII name is written as UTF-8, with the flag that says so', async () => {
    const { zipStore } = await load();
    const name = 'frames/tête—360°.jpg';
    const encoded = bytes(name);
    const archive = zipStore([{ name, bytes: bytes('ok') }]);
    const view = new DataView(archive.buffer);

    assert.equal(view.getUint16(6, true) & 0x0800, 0x0800, 'local header flags bit 11');
    assert.equal(view.getUint16(26, true), encoded.length, 'the byte length, not the character count');
    assert.deepEqual([...archive.slice(30, 30 + encoded.length)], [...encoded]);

    const end = archive.length - 22;
    const directoryAt = view.getUint32(end + 16, true);
    assert.equal(view.getUint16(directoryAt + 8, true) & 0x0800, 0x0800, 'central record too');
    assert.deepEqual([...archive.slice(directoryAt + 46, directoryAt + 46 + encoded.length)], [...encoded]);
});

test('the central directory points at every local header', async () => {
    const { zipStore } = await load();
    const rows = [
        { name: 'a.txt', bytes: bytes('aaaa') },
        { name: 'b/c.txt', bytes: bytes('bbbbbbbb') },
    ];
    const out = zipStore(rows);
    const view = new DataView(out.buffer);

    const end = out.length - 22;
    assert.equal(view.getUint32(end, true), 0x06054B50);
    assert.equal(view.getUint16(end + 10, true), 2, 'two entries');
    const directoryAt = view.getUint32(end + 16, true);
    assert.equal(view.getUint32(directoryAt, true), 0x02014B50);

    // Each central record's stored offset must land on a local header — the one
    // field an unzipper trusts absolutely and nothing else would catch.
    let at = directoryAt;
    for (const row of rows) {
        const nameLength = view.getUint16(at + 28, true);
        const offset = view.getUint32(at + 42, true);
        assert.equal(view.getUint32(offset, true), 0x04034B50, `${row.name} local header`);
        assert.equal(view.getUint32(offset + 18, true), row.bytes.length, 'stored size');
        assert.equal(view.getUint16(offset + 8, true), 0, 'method 0 — stored, not deflated');
        at += 46 + nameLength;
    }
    assert.equal(at, end, 'the directory ends exactly where the end record begins');
});

test('a fixed date makes the same input produce the same bytes', async () => {
    const { zipStore } = await load();
    const rows = [{ name: 'a.txt', bytes: bytes('aaaa') }];
    const date = new Date('2026-09-18T12:34:56Z');
    assert.deepEqual([...zipStore(rows, { date })], [...zipStore(rows, { date })]);
});
