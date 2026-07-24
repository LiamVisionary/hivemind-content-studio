// Tier 4 of drag-to-restore: recover a prompt (and seed) from an EXTERNAL ComfyUI
// image dragged in from disk. Standard ComfyUI (without --disable-metadata) embeds
// its graph in the file — the litegraph "workflow" and the API "prompt" as PNG
// tEXt/iTXt chunks, or in EXIF for WEBP/JPEG. Our own outputs never carry this (we
// run --disable-metadata), so this only ever fires for images made elsewhere.
//
// Parsing is a trimmed port of packages/comfyui-mobile/src/utils/imageWorkflowMetadata.ts.
// We only handle PLAINTEXT embedded metadata: encrypted comfyui-mobile envelopes use a
// different (PBKDF2 passphrase) key scheme this app can't open, and the studio can't run
// an arbitrary node graph anyway — so we recover the prompt/seed, not the full graph.

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp)$/i;

export function isWorkflowImageFile(file) {
  if (file?.type && IMAGE_MIME.test(file.type)) return true;
  const name = (file?.name ?? '').toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function latin1(bytes, start, end) {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function fourCC(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function isPng(b) {
  return PNG_SIGNATURE.every((v, i) => b[i] === v);
}

// Walk PNG chunks, returning the value of the first tEXt/iTXt chunk whose keyword
// matches (uncompressed only — what ComfyUI writes).
function readPngTextValue(b, keyword) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  while (off + 8 <= b.length) {
    const len = view.getUint32(off);
    const type = fourCC(b, off + 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) break;
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      let z = dataStart;
      while (z < dataEnd && b[z] !== 0) z++;
      if (latin1(b, dataStart, z) === keyword) return latin1(b, z + 1, dataEnd);
    } else if (type === 'iTXt') {
      let z = dataStart;
      while (z < dataEnd && b[z] !== 0) z++;
      if (latin1(b, dataStart, z) === keyword) {
        const compressionFlag = b[z + 1];
        let p = z + 3; // skip compression method
        while (p < dataEnd && b[p] !== 0) p++;
        p++; // language tag
        while (p < dataEnd && b[p] !== 0) p++;
        p++; // translated keyword
        if (compressionFlag === 0 && p <= dataEnd) {
          return new TextDecoder('utf-8').decode(b.subarray(p, dataEnd));
        }
      }
    }
    off = dataEnd + 4; // skip CRC
  }
  return null;
}

function stripExifPrefix(b) {
  if (b.length >= 6 && b[0] === 0x45 && b[1] === 0x78 && b[2] === 0x69 && b[3] === 0x66 && b[4] === 0 && b[5] === 0) {
    return b.subarray(6);
  }
  return b;
}

function readPngExif(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  while (off + 8 <= b.length) {
    const len = view.getUint32(off);
    const type = fourCC(b, off + 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) break;
    if (type === 'IEND') break;
    if (type === 'eXIf') return stripExifPrefix(b.subarray(dataStart, dataEnd));
    off = dataEnd + 4;
  }
  return null;
}

function isWebp(b) {
  return b.length >= 12 && fourCC(b, 0) === 'RIFF' && fourCC(b, 8) === 'WEBP';
}
function isJpeg(b) {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function readWebpExif(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  while (off + 8 <= b.length) {
    const cc = fourCC(b, off);
    const size = view.getUint32(off + 4, true);
    const dataStart = off + 8;
    if (dataStart + size > b.length) break;
    if (cc === 'EXIF') return stripExifPrefix(b.subarray(dataStart, dataStart + size));
    off = dataStart + size + (size & 1);
  }
  return null;
}

function readJpegExif(b) {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) break;
    const marker = b[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = view.getUint16(off + 2);
    const segStart = off + 4;
    if (segStart + len - 2 > b.length) break;
    if (marker === 0xe1) {
      const seg = b.subarray(segStart, off + 2 + len);
      const stripped = stripExifPrefix(seg);
      if (stripped !== seg) return stripped;
    }
    off = off + 2 + len;
  }
  return null;
}

// Read an EXIF ASCII tag value (ComfyUI packs UTF-8 JSON into it).
function readExifTagString(exif, tags) {
  if (!exif || exif.length < 8) return null;
  const little = exif[0] === 0x49 && exif[1] === 0x49;
  const big = exif[0] === 0x4d && exif[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  const ifd0 = u32(4);
  if (ifd0 + 2 > exif.length) return null;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > exif.length) break;
    const tag = u16(entry);
    if (!tags.includes(tag)) continue;
    if (u16(entry + 2) !== 2) continue; // ASCII
    const length = u32(entry + 4);
    const valueOffset = length <= 4 ? entry + 8 : u32(entry + 8);
    if (valueOffset + length > exif.length) continue;
    let end = valueOffset + length;
    while (end > valueOffset && exif[end - 1] === 0) end--;
    return new TextDecoder('utf-8').decode(exif.subarray(valueOffset, end));
  }
  return null;
}

// ComfyUI stores "<label>:{json}" in the tag — Make/ImageDescription for the workflow,
// Model for the prompt.
function readExifLabeled(exif, tags, label) {
  const value = readExifTagString(exif, tags);
  if (!value) return null;
  const sep = value.indexOf(':');
  if (sep === -1) return null;
  if (value.slice(0, sep).trim().toLowerCase() !== label) return null;
  return value.slice(sep + 1);
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Read the embedded ComfyUI litegraph "workflow" and API "prompt" from an image file. */
export async function readEmbeddedComfyData(file) {
  if (!isWorkflowImageFile(file)) return null;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
  let workflowRaw = null;
  let promptRaw = null;
  if (isPng(bytes)) {
    workflowRaw = readPngTextValue(bytes, 'workflow');
    promptRaw = readPngTextValue(bytes, 'prompt');
    if (!workflowRaw || !promptRaw) {
      const exif = readPngExif(bytes);
      workflowRaw = workflowRaw || readExifLabeled(exif, [0x010f, 0x010e], 'workflow');
      promptRaw = promptRaw || readExifLabeled(exif, [0x0110], 'prompt');
    }
  } else if (isWebp(bytes)) {
    const exif = readWebpExif(bytes);
    workflowRaw = readExifLabeled(exif, [0x010f, 0x010e], 'workflow');
    promptRaw = readExifLabeled(exif, [0x0110], 'prompt');
  } else if (isJpeg(bytes)) {
    const exif = readJpegExif(bytes);
    workflowRaw = readExifLabeled(exif, [0x010f, 0x010e], 'workflow');
    promptRaw = readExifLabeled(exif, [0x0110], 'prompt');
  }
  const workflow = parseJson(workflowRaw);
  const apiPrompt = parseJson(promptRaw);
  if (!workflow && !apiPrompt) return null;
  return { workflow, apiPrompt };
}

const NEGATIVE_HINT = /(worst|low quality|bad quality|bad anatomy|nsfw|deform|blurr|watermark|lowres|jpeg artifacts|text, )/i;

/**
 * Best-effort: pull the positive prompt (and negative + seed if present) out of an
 * embedded ComfyUI API prompt. Heuristic — the studio can't reconstruct a foreign node
 * graph, so this recovers the prompt/seed only.
 */
export function extractPromptAndSeed(data) {
  const api = data?.apiPrompt;
  if (!api || typeof api !== 'object') return null;
  const nodes = Object.values(api).filter((n) => n && typeof n === 'object' && n.class_type);
  let seed;
  for (const n of nodes) {
    const value = n.inputs?.seed ?? n.inputs?.noise_seed;
    if (typeof value === 'number') { seed = value; break; }
  }
  const texts = [...new Set(
    nodes
      .filter((n) => /CLIPTextEncode/i.test(String(n.class_type)))
      .map((n) => n.inputs?.text)
      .filter((t) => typeof t === 'string' && t.trim()),
  )].sort((a, b) => b.length - a.length);
  const prompt = texts[0] || '';
  const negativePrompt = texts.slice(1).find((t) => NEGATIVE_HINT.test(t)) || '';
  if (prompt || typeof seed === 'number') return { prompt, negativePrompt, seed };
  return null;
}
