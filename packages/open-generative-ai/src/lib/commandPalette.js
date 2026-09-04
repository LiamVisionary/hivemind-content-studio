// Command palette — what ⌘K can reach, and how a typed query narrows it.
//
// Four kinds of entry, in the order a person looks for them:
//   page    every nav item, with its icon (the map of the app in one list)
//   tab     the open tabs of the studio you are on, by their derived names
//   prompt  the saved prompt library (sealed; empty while the vault is locked)
//   model   the models installed on this machine, handed to the studio that runs
//           them through the Models tab's own openInStudio handoff
//
// Pure: the dialog owns loading and dispatch, this owns the list. Nothing here
// touches the network, storage or the DOM, so the whole thing is node-testable.

export const PALETTE_GROUPS = ['page', 'tab', 'prompt', 'model'];

// Long lists stop being a palette and start being a browser. The prompt library
// and the model catalog are both filtered down before they are shown.
const GROUP_CAPS = { page: 24, tab: 12, prompt: 8, model: 8 };

const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function groupLabel(kind, zh) {
  if (kind === 'page') return zh ? '页面' : 'Pages';
  if (kind === 'tab') return zh ? '标签' : 'Tabs';
  if (kind === 'prompt') return zh ? '已保存的提示词' : 'Saved prompts';
  return zh ? '模型' : 'Models';
}

export function paletteGroupLabel(kind, zh = false) {
  return groupLabel(kind, zh);
}

/**
 * Build the full entry list.
 *
 * @param {object} sources
 * @param {Array} sources.navItems  NAV_ITEMS — {page, icon, label()}
 * @param {Array} sources.tabs      open tabs of the current page — {id, index, label, busy}
 * @param {string} sources.studioType the page those tabs belong to ('' when the page has none)
 * @param {Array} sources.prompts   saved library entries — {id, name, data:{prompt, summary}}
 * @param {Array} sources.models    installed runnable models — {id, name, type, ready}
 * @param {boolean} sources.zh
 */
export function buildPaletteEntries({
  navItems = [], tabs = [], studioType = '', prompts = [], models = [], zh = false,
} = {}) {
  const entries = [];

  navItems.forEach((item, index) => {
    if (!item?.page) return;
    const label = typeof item.label === 'function' ? item.label() : text(item.label);
    entries.push({
      id: `page:${item.page}`,
      kind: 'page',
      label: label || item.page,
      hint: index < 9 ? `⌘${index + 1}` : '',
      icon: item.icon || 'sparkles',
      payload: { page: item.page },
    });
  });

  tabs.forEach((tab) => {
    if (!Number.isFinite(Number(tab?.id))) return;
    entries.push({
      id: `tab:${studioType}:${tab.id}`,
      kind: 'tab',
      label: text(tab.label) || `Tab ${Number(tab.index) + 1 || 1}`,
      hint: tab.busy ? (zh ? '正在生成' : 'Generating') : `${zh ? '标签' : 'Tab'} ${Number(tab.index) + 1 || 1}`,
      icon: 'copy',
      payload: { studioType, tabId: Number(tab.id) },
    });
  });

  prompts.forEach((entry) => {
    const prompt = text(entry?.data?.prompt);
    if (!prompt) return;
    entries.push({
      id: `prompt:${entry.id || entry.name}`,
      kind: 'prompt',
      label: text(entry?.name) || prompt.slice(0, 40),
      hint: text(entry?.data?.summary) || prompt.slice(0, 60),
      icon: 'sparkles',
      payload: { prompt },
    });
  });

  models.forEach((model) => {
    if (!model?.id) return;
    const video = String(model.type || '').toLowerCase() === 'video';
    entries.push({
      id: `model:${model.id}`,
      kind: 'model',
      label: text(model.name) || String(model.id),
      hint: video ? (zh ? '视频' : 'Video') : (zh ? '图像' : 'Image'),
      icon: video ? 'video' : 'image',
      disabled: model.ready === false,
      payload: { model },
    });
  });

  return entries;
}

function score(entry, needle) {
  const label = entry.label.toLowerCase();
  if (label.startsWith(needle)) return 0;
  if (label.includes(needle)) return 1;
  if (String(entry.hint || '').toLowerCase().includes(needle)) return 2;
  return -1;
}

/**
 * Narrow the list. An empty query keeps everything (capped per group); a query
 * matches the label first, then the hint, and never re-orders the groups — the
 * palette is a map of the app, and a map that reshuffles is unreadable.
 */
export function filterPaletteEntries(entries, query = '') {
  const needle = text(query).toLowerCase();
  const kept = [];
  for (const kind of PALETTE_GROUPS) {
    const group = entries.filter((entry) => entry.kind === kind);
    const matched = needle
      ? group
        .map((entry) => ({ entry, rank: score(entry, needle) }))
        .filter((row) => row.rank >= 0)
        .sort((left, right) => left.rank - right.rank)
        .map((row) => row.entry)
      : group;
    kept.push(...matched.slice(0, GROUP_CAPS[kind] || 8));
  }
  return kept;
}
