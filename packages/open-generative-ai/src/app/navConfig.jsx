// Navigation model — page keys are a wire contract (?page=, 'navigate' events).
// Three tiers, one disclosure convention: Create (with a Labs fold), Produce,
// and a collapsed Advanced group. Labels changed with the tiers; keys did not,
// so every old link still resolves.
import { t, zh } from '../lib/i18n.js';

export const NAV_SECTIONS = [
  {
    id: 'create',
    label: () => (zh() ? '创作' : 'Create'),
    items: [
      { page: 'image', icon: 'image', label: () => t('nav.image') },
      { page: 'video', icon: 'video', label: () => t('nav.video') },
      { page: 'story', icon: 'persona', label: () => (zh() ? '故事' : 'Story') },
      { page: 'restore', icon: 'wand', label: () => (zh() ? '修复' : 'Restore') },

    ],
    // Working studios that each need something this machine may not have — a
    // rented GPU, a local checkpoint, a third-party account. Folded, not hidden.
    labs: {
      id: 'labs',
      label: () => (zh() ? '实验室' : 'Labs'),
      collapsible: true,
      defaultOpen: false,
      storageKey: 'nav.labs',
      items: [
        { page: 'sprite', icon: 'grid', label: () => (zh() ? '精灵图' : 'Sprite') },
        { page: 'lipsync', icon: 'mic', label: () => t('nav.lipsync') },
      ],
    },
  },
  {
    id: 'produce',
    label: () => (zh() ? '生产' : 'Produce'),
    items: [
      { page: 'planner', icon: 'sparkles', label: () => (zh() ? '规划器' : 'Planner') },
      { page: 'history', icon: 'clock', label: () => (zh() ? '作品库' : 'Library') },
      { page: 'runs', icon: 'stack', label: () => (zh() ? '制作' : 'Productions') },
      { page: 'inspo', icon: 'star', label: () => (zh() ? '灵感' : 'Inspo') },
      { page: 'models', icon: 'database', label: () => (zh() ? '模型' : 'Models') },
    ],
  },
  {
    id: 'advanced',
    label: () => (zh() ? '高级' : 'Advanced'),
    collapsible: true,
    defaultOpen: false,
    storageKey: 'nav.advanced',
    items: [
      { page: 'machines', icon: 'cpu', label: () => (zh() ? '租用的 GPU' : 'Rented GPUs') },
      { page: 'providers', icon: 'plug', label: () => (zh() ? '服务商' : 'Providers') },
      { page: 'passbook', icon: 'key', label: () => 'PassBook' },
      { page: 'canvas', icon: 'nodes', label: () => (zh() ? '画布' : 'Canvas') },
      { page: 'mcp-cli', icon: 'terminal', label: () => t('nav.mcpcli') },
      // Version, licence, source and third-party notices. AGPL §5(d) asks an
      // interactive program to show these; the topbar version chip is the other
      // door to the same page.
      { page: 'about', icon: 'info', label: () => (zh() ? '关于' : 'About') },
    ],
  },
];

// Every group a section renders, in the order it renders them — the flat item
// list and the mobile strip are both derived from this, so a group added above
// is navigable everywhere without a second registration.
export function navGroups(section) {
  return section.labs ? [section, section.labs] : [section];
}

export const NAV_GROUPS = NAV_SECTIONS.flatMap(navGroups);
export const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
export const APP_NAME = 'Hivemind Content Studio';

// Studios mount once on first visit and are display-toggled thereafter (App.jsx
// keeps them alive so an in-flight generation survives a page switch); hub pages
// persist the same way once the hub layer exists. Cinema folded into the Image
// composer's Camera menu and survives as an alias below.
export const STUDIO_PAGES = ['image', 'video', 'sprite', 'story', 'lipsync', 'restore'];
export const HUB_PAGES = {
  planner: 'create',
  canvas: 'canvas',
  inspo: 'inspo',
  models: 'models',
  runs: 'runs',
  history: 'history',
  telemetry: 'telemetry',
  providers: 'providers',
  machines: 'machines',
  passbook: 'passbook',
  // Agents & API is a static docs page with no state of its own — it rides the
  // hub layer rather than the studio mount registry. About does the same: one
  // fetch of /api/about on first open, then nothing.
  'mcp-cli': 'agents',
  about: 'about',
};

// Retired pages that still resolve. A page key is a wire contract — old links,
// bookmarks and 'navigate' events keep arriving long after a tab folds into a
// control — so the key survives as a redirect that also opens the control it
// became. Cinema is now the Image composer's Camera menu.
export const PAGE_ALIASES = {
  cinema: { page: 'image', menu: 'camera' },
};

// Own keys only: a plain lookup answered yes for 'constructor' and every other
// Object.prototype name, and ?page=constructor then routed into the hub layer.
export function isKnownPage(page) {
  if (typeof page !== 'string' || !page) return false;
  return Object.hasOwn(PAGE_ALIASES, page) || STUDIO_PAGES.includes(page) || Object.hasOwn(HUB_PAGES, page);
}
