// What a studio tab chip says — and what the command palette reads to list the
// tabs of the page you are on.
//
// The strip used to say "Tab 1", "Tab 2": true, and useless. A tab is the thing
// you left a four-minute render in, so the chip has to say WHICH render — the
// prompt if there is one, otherwise the model it is set to, otherwise that it is
// still empty. Derivation is pure and lives here so it can be tested without
// mounting a studio.
//
// The input is the cheap `chip()` descriptor a studio publishes on its api handle
// ({prompt, model, previewUrl, previewKind}) — NOT the clone snapshot, which deep
// copies reference images and is far too expensive to call on a poll.

// Roughly the width of a chip before the strip starts scrolling. Long enough to
// tell two prompts apart, short enough that six tabs still fit.
export const MAX_TAB_LABEL = 24;

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function clip(text) {
  if (text.length <= MAX_TAB_LABEL) return text;
  return `${text.slice(0, MAX_TAB_LABEL).trimEnd()}…`;
}

// Model ids arrive as workflow filenames and namespaced ids ("local:krea2",
// "hivemind/wan_2_2.json"); the chip shows the readable tail of one.
export function prettyModelName(model) {
  const raw = firstText(model);
  if (!raw) return '';
  const tail = raw.split(/[/\\]/).pop() || raw;
  return tail.replace(/\.(safetensors|ckpt|json|yaml|yml)$/i, '').replace(/^[a-z0-9]+:/i, '');
}

/**
 * The chip's text: the first ~24 characters of the prompt, else the model name,
 * else the caller's fallback ("New tab").
 *
 * @param {{prompt?: string, model?: string}|null} chipInfo
 * @param {{fallback?: string}} options
 */
export function tabChipLabel(chipInfo, { fallback = 'New tab' } = {}) {
  const prompt = firstText(chipInfo?.prompt);
  if (prompt) return clip(prompt);
  const model = prettyModelName(chipInfo?.model);
  if (model) return clip(model);
  return fallback;
}

/* ---------------- live label registry ---------------- */

// Module state, like studioTargets.js: it describes what is mounted right now.
// StudioTabs publishes on its existing busy poll; the command palette reads when
// it opens. Nothing is persisted — a tab that is not on screen is not an entry.
const published = new Map(); // studioType -> [{ id, index, label, busy }]

export function publishTabLabels(studioType, entries) {
  published.set(String(studioType || 'studio'), entries.map((entry) => ({ ...entry })));
}

export function readTabLabels(studioType) {
  return (published.get(String(studioType || 'studio')) || []).map((entry) => ({ ...entry }));
}

/** Test seam: forget everything. Never called by the app. */
export function resetTabLabels() {
  published.clear();
}
