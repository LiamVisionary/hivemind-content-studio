// The manual timeline: an ordered strip of segment cards the user curates by
// hand — generate into a slot, drag clips in, reorder, drop, combine.
//
// This is the general-purpose sibling of chainTimeline.js. That model DERIVES
// an episode from chain lineage and only exists once two clips are linked; this
// one is explicit state the user opens with a button, works for any model or
// workflow, and holds empty placeholder segments ("the shot I am about to
// generate") as first-class items. Chained generations still record their
// lineage — the two models coexist, and the strip simply hides the derived one
// while the explicit one is open.
//
// Pure, and in src/lib, so the node:test suite can cover the transitions — the
// insert/replace/move/capture rules are exactly the kind of arithmetic that is
// easy to get subtly wrong and invisible in a screenshot.

/** A fresh segment. `url` '' means an empty slot waiting for a generation. */
export function newTimelineSegment(url = '', model = '') {
  const id = globalThis.crypto?.randomUUID?.()
    || `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, url: String(url || ''), model: String(model || '') };
}

// A runaway restore must not mount hundreds of poster decoders; no real
// sequence is 24 shots of anything (that is six minutes of H3).
export const MAX_TIMELINE_SEGMENTS = 24;

/** The segments that actually hold a clip, in order. */
export const filledTimelineSegments = (segments) => (segments || []).filter((seg) => seg?.url);

/** Identity of the cut: what a built combined clip was built FROM. */
export const timelineCombineKey = (segments) => filledTimelineSegments(segments)
  .map((seg) => seg.url).join(' ');

/** Joining is a concat: one clip is not a cut. */
export const timelineCanCombine = (segments) => filledTimelineSegments(segments).length >= 2;

/**
 * Opening the timeline seeds it from what is on screen: the current result
 * becomes shot 1 (selected), matching "the timeline starts with the existing
 * shot". With nothing on the canvas it opens on a single empty selected slot.
 */
export function openTimeline(resultUrl = '', resultModel = '') {
  const first = newTimelineSegment(resultUrl || '', resultUrl ? resultModel : '');
  return { segments: [first], selectedId: first.id };
}

const indexOfSegment = (segments, id) => (segments || []).findIndex((seg) => seg?.id === id);

/** Append an empty slot after the last segment and select it ("+"). */
export function addTimelineSegment(segments) {
  const next = newTimelineSegment();
  return { segments: [...(segments || []), next].slice(0, MAX_TIMELINE_SEGMENTS), selectedId: next.id };
}

/** Put a clip into an existing segment (fill an empty slot, or replace). */
export function fillTimelineSegment(segments, id, { url, model }) {
  return (segments || []).map((seg) => (seg.id === id ? { ...seg, url: String(url || ''), model: String(model || '') } : seg));
}

/** Insert a segment at an index (clamped). Returns the new list. */
export function insertTimelineSegment(segments, index, segment) {
  const list = [...(segments || [])];
  if (list.length >= MAX_TIMELINE_SEGMENTS) return list;
  const at = Math.max(0, Math.min(Number.isInteger(index) ? index : list.length, list.length));
  list.splice(at, 0, segment);
  return list;
}

/**
 * Remove a segment. Selection moves to its neighbour — the one that slid into
 * its slot, else the new last — so the strip never ends up with a selection
 * pointing at nothing while segments remain.
 */
export function removeTimelineSegment(segments, id, selectedId) {
  const index = indexOfSegment(segments, id);
  const list = (segments || []).filter((seg) => seg.id !== id);
  const selected = selectedId === id
    ? (list[Math.min(Math.max(index, 0), list.length - 1)]?.id || '')
    : selectedId;
  return { segments: list, selectedId: selected };
}

/**
 * Move a segment to a new index (a card dragged between its siblings). The
 * index is where it lands in the list WITHOUT itself — the shape a drop gap
 * naturally produces.
 */
export function moveTimelineSegment(segments, id, toIndex) {
  const from = indexOfSegment(segments, id);
  if (from < 0) return segments || [];
  const list = [...(segments || [])];
  const [seg] = list.splice(from, 1);
  const at = Math.max(0, Math.min(Number.isInteger(toIndex) ? toIndex : list.length, list.length));
  list.splice(at, 0, seg);
  return list;
}

/**
 * A finished generation lands in the strip: it fills the selected slot when
 * that slot is empty, and otherwise becomes a NEW segment directly after the
 * selected one — never a silent replacement of a clip the user already has.
 * Returns the landed segment so the caller can select and announce it.
 */
export function captureIntoTimeline(segments, selectedId, { url, model }) {
  const list = segments || [];
  const index = indexOfSegment(list, selectedId);
  const selected = index >= 0 ? list[index] : null;
  if (selected && !selected.url) {
    const filled = fillTimelineSegment(list, selected.id, { url, model });
    return { segments: filled, selectedId: selected.id, segment: filled[index] };
  }
  const segment = newTimelineSegment(url, model);
  const at = index >= 0 ? index + 1 : list.length;
  return { segments: insertTimelineSegment(list, at, segment), selectedId: segment.id, segment };
}

/**
 * What a drop MEANS, resolved in one place so the component stays wiring.
 *
 * `target`: { id, region } — region 'before' | 'after' | 'on' for a card,
 * 'end' for the "+" card / trailing zone.
 * `payload`: { kind: 'segment', id } for a card being reordered, or
 * { kind: 'clip', url, model } for a clip arriving from outside.
 *
 * Returns { action, index?, id?, needsConfirm? } or null for a drop that
 * changes nothing (a card dropped back onto its own position).
 */
export function timelineDropPlan(segments, target, payload) {
  const list = segments || [];
  if (!target || !payload) return null;
  const targetIndex = target.region === 'end' ? list.length : indexOfSegment(list, target.id);
  if (target.region !== 'end' && targetIndex < 0) return null;

  if (payload.kind === 'segment') {
    const from = indexOfSegment(list, payload.id);
    if (from < 0) return null;
    // A card has no business being dropped ONTO another; the nearest gap wins.
    let index = target.region === 'end' ? list.length
      : targetIndex + (target.region === 'before' ? 0 : 1);
    // Where it lands in the list without itself.
    if (from < index) index -= 1;
    if (index === from) return null;
    return { action: 'move', id: payload.id, index };
  }

  if (payload.kind !== 'clip' || !payload.url) return null;
  if (target.region === 'end') return { action: 'append' };
  if (target.region === 'on') {
    const seg = list[targetIndex];
    if (!seg.url) return { action: 'fill', id: seg.id };
    if (seg.url === payload.url) return null;
    // Replacing a clip the user already placed loses work — the caller asks.
    return { action: 'replace', id: seg.id, needsConfirm: true };
  }
  return { action: 'insert', index: targetIndex + (target.region === 'before' ? 0 : 1) };
}

/**
 * How the NEXT shot continues from the previous one, when "Auto-continue" is
 * on: the mechanism is a property of the MODEL, the source clip is the last
 * filled segment before the selected slot.
 *
 *   'chain'  MiniMax H3 Motion Context — the pinned tail carries motion and
 *            room tone across the cut (the real chaining feature).
 *   'frame'  Any other local workflow with a start-image input (LTX included):
 *            the next clip opens on the previous clip's LAST FRAME, grabbed
 *            client-side — the clip files stay separate, which is what a
 *            segment-per-clip strip needs. (LTX's own extend graph appends to
 *            the SAME file, so it cannot feed a new segment.)
 *
 * Returns { mode, fromUrl, fromIndex } or null when there is nothing to
 * continue from or the model has no way to do it.
 */
export function timelineContinuationPlan(modelEntry, segments, selectedId) {
  const list = segments || [];
  const index = indexOfSegment(list, selectedId);
  if (index < 0 || list[index]?.url) return null;
  const before = list.slice(0, index).filter((seg) => seg.url);
  const prev = before[before.length - 1];
  if (!prev) return null;
  const mode = modelEntry?.supportsMotionContext ? 'chain'
    : (modelEntry?.supportsStartFrame ? 'frame' : null);
  if (!mode) return null;
  return { mode, fromUrl: prev.url, fromIndex: indexOfSegment(list, prev.id) };
}

/* ---------------- per-tab persistence ---------------- */

// The strip survives a RELOAD, not a new browser session — sessionStorage,
// like the tab strip and the pending-job registry it has to outlive with.
// Segments persist as opaque output POINTERS (id, url, model); prompts are
// deliberately never written here — they live in the encrypted composer and
// the sealed per-generation context, and a plaintext copy in storage would
// undo that. Same stance the persisted motionContextUrl already takes.
const TIMELINE_STORE_PREFIX = 'studio.videoTimeline.';

export const timelineStorageKey = (tabId) => `${TIMELINE_STORE_PREFIX}${Number(tabId) || 0}`;

export function serializeTimeline({ on, segments, selectedId, extend, showCombined }) {
  return {
    on: Boolean(on),
    segments: (segments || []).slice(0, MAX_TIMELINE_SEGMENTS)
      .map((seg) => ({ id: String(seg.id || ''), url: String(seg.url || ''), model: String(seg.model || '') })),
    selectedId: String(selectedId || ''),
    extend: Boolean(extend),
    showCombined: Boolean(showCombined),
  };
}

// Validated field by field rather than trusted: a corrupt blob must degrade to
// "no timeline", never to a strip of undefined cards.
export function reviveTimeline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const segments = Array.isArray(raw.segments)
    ? raw.segments
      .filter((seg) => seg && typeof seg === 'object' && typeof seg.id === 'string' && seg.id)
      .map((seg) => ({ id: seg.id, url: typeof seg.url === 'string' ? seg.url : '', model: typeof seg.model === 'string' ? seg.model : '' }))
      .slice(0, MAX_TIMELINE_SEGMENTS)
    : [];
  if (!segments.length) return null;
  const ids = new Set(segments.map((seg) => seg.id));
  if (ids.size !== segments.length) return null;
  return {
    on: raw.on === true,
    segments,
    selectedId: ids.has(raw.selectedId) ? raw.selectedId : segments[0].id,
    extend: raw.extend === true,
    showCombined: raw.showCombined === true,
  };
}

export function saveTimelineState(tabId, state) {
  try {
    sessionStorage.setItem(timelineStorageKey(tabId), JSON.stringify(serializeTimeline(state)));
  } catch { /* storage disabled or full — the strip just doesn't survive */ }
}

export function loadTimelineState(tabId) {
  try {
    return reviveTimeline(JSON.parse(sessionStorage.getItem(timelineStorageKey(tabId)) || 'null'));
  } catch {
    return null;
  }
}

export function clearTimelineState(tabId) {
  try { sessionStorage.removeItem(timelineStorageKey(tabId)); } catch { /* non-critical */ }
}
