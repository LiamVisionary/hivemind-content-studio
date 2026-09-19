// A zip file, stored not deflated — the smallest thing that turns many files
// into one download.
//
// WHY THIS EXISTS RATHER THAN A DEPENDENCY. The studio ships one archive: a
// turntable capture's frames plus the recipe that says how to reconstruct them.
// The frames are already-compressed JPEGs, so deflate would spend CPU to save
// nothing on the only payload there is; the recipe is a few hundred bytes.
// Store-only is therefore not a shortcut, it is the right container — and it is
// sixty lines against a dependency in the landing chunk.
//
// WHY NOT N SEPARATE DOWNLOADS. A hundred and twenty save prompts, or a
// hundred and twenty files fanned across a Downloads folder in an order COLMAP
// then has to be told about. The folder structure IS part of the handoff.
//
// Pure: bytes in, bytes out. No DOM, no network, no clock unless one is given.

/* ---------------- CRC-32 ---------------- */

let table = null;

function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------- the container ---------------- */

// Neither the entry count nor any single member may cross the 32-bit fields a
// plain zip has; past either you need ZIP64, which this is deliberately not.
// The caller's own limits keep it far below both (180 frames, a few MB each),
// so this is an assertion rather than a case to handle.
const MAX_ENTRIES = 0xFFFF;
const MAX_BYTES = 0xFFFFFFFF;

const encoder = new TextEncoder();

/** MS-DOS date and time, the only stamp a plain zip carries. */
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * `entries` is `[{ name, bytes }]`; `name` may carry forward slashes, which is
 * how the archive gets its folders. Returns one Uint8Array.
 */
export function zipStore(entries, { date = null } = {}) {
  const rows = (Array.isArray(entries) ? entries : []).map((entry) => ({
    name: String(entry?.name || ''),
    bytes: entry?.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(0),
  })).filter((row) => row.name);

  if (rows.length > MAX_ENTRIES) throw new Error(`a stored zip holds at most ${MAX_ENTRIES} files`);
  for (const row of rows) {
    if (row.bytes.length > MAX_BYTES) throw new Error(`"${row.name}" is too large for a stored zip`);
  }

  const stamp = dosStamp(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const row of rows) {
    const name = encoder.encode(row.name);
    const sum = crc32(row.bytes);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034B50, true);   // local file header signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // flags: UTF-8 names
    lv.setUint16(8, 0, true);            // method 0 = stored
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, row.bytes.length, true); // compressed size
    lv.setUint32(22, row.bytes.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra field length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014B50, true);   // central directory signature
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, row.bytes.length, true);
    cv.setUint32(24, row.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attributes
    cv.setUint32(38, 0, true);           // external attributes
    cv.setUint32(42, offset, true);      // offset of the local header
    central.set(name, 46);

    locals.push(local, row.bytes);
    centrals.push(central);
    offset += local.length + row.bytes.length;
    if (offset > MAX_BYTES) throw new Error('the archive is too large for a stored zip');
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054B50, true);     // end of central directory
  ev.setUint16(8, rows.length, true);    // entries on this disk
  ev.setUint16(10, rows.length, true);   // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);        // where the central directory starts

  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
