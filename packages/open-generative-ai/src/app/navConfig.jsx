// Navigation model — page keys are a wire contract (?page=, 'navigate' events).
// Three tiers, one disclosure convention: Create (with a Labs fold), Produce,
// and a collapsed Advanced group. Labels changed with the tiers; keys did not,
// so every old link still resolves.
import { t } from '../lib/i18n.js';

export const NAV_SECTIONS = [
  {
    id: 'create',
    label: () => t('nav.create'),
    items: [
      { page: 'image', icon: 'image', label: () => t('nav.image') },
      { page: 'video', icon: 'video', label: () => t('common.video') },
      { page: 'story', icon: 'persona', label: () => t('nav.story') },
      { page: 'restore', icon: 'wand', label: () => t('nav.restore') },

    ],
    // Working studios that each need something this machine may not have — a
    // rented GPU, a local checkpoint, a third-party account. Folded, not hidden.
    labs: {
      id: 'labs',
      label: () => t('nav.labs'),
      collapsible: true,
      defaultOpen: false,
      storageKey: 'nav.labs',
      items: [
        { page: 'sprite', icon: 'grid', label: () => t('nav.sprite') },
        { page: 'lipsync', icon: 'mic', label: () => t('nav.lipsync') },
      ],
    },
  },
  {
    id: 'produce',
    label: () => t('nav.produce'),
    items: [
      { page: 'planner', icon: 'sparkles', label: () => t('nav.planner') },
      { page: 'history', icon: 'clock', label: () => t('nav.library') },
      { page: 'runs', icon: 'stack', label: () => t('nav.productions') },
      { page: 'inspo', icon: 'star', label: () => t('nav.inspo') },
      { page: 'models', icon: 'database', label: () => t('nav.models') },
    ],
  },
  {
    id: 'advanced',
    label: () => t('common.advanced'),
    collapsible: true,
    defaultOpen: false,
    storageKey: 'nav.advanced',
    items: [
      { page: 'machines', icon: 'cpu', label: () => t('nav.machines') },
      { page: 'providers', icon: 'plug', label: () => t('nav.providers') },
      { page: 'passbook', icon: 'key', label: () => t('nav.passbook') },
      { page: 'canvas', icon: 'nodes', label: () => t('nav.canvas') },
      { page: 'mcp-cli', icon: 'terminal', label: () => t('nav.mcpcli') },
      // Still opened by ⌘, — it is a page now rather than a dialog, because a
      // packaged app's machine-level settings do not fit in a modal.
      { page: 'settings', icon: 'settings', label: () => t('common.settings') },
      // Version, licence, source and third-party notices. AGPL §5(d) asks an
      // interactive program to show these; the topbar version chip is the other
      // door to the same page.
      { page: 'about', icon: 'info', label: () => t('nav.about') },
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

// ⌘1..⌘9 — the first nine rows of the flat list, in the order the sidebar shows
// them. ONE list, because the palette advertises these hints and App.jsx binds
// them: they used to be derived separately (the palette off NAV_ITEMS, the
// handler off NAV_SECTIONS[0].items, which is four rows long), so ⌘5..⌘9 were
// printed beside Sprite, Lip sync, Planner, Library and Productions and did
// nothing at all — in a browser they fell through to the browser's own tab
// switching. An advertised shortcut that does nothing is worse than no hint.
export const SHORTCUT_ITEMS = NAV_ITEMS.slice(0, 9);
export const APP_NAME = t('app.name');

// Studios mount once on first visit and are display-toggled thereafter (App.jsx
// keeps them alive so an in-flight generation survives a page switch); hub pages
// persist the same way once the hub layer exists. Cinema folded into the Image
// composer's Camera menu and survives as an alias below.
export const STUDIO_PAGES = ['image', 'video', 'sprite', 'story', 'lipsync', 'restore'];
// Routable pages with no nav row of their own. The document title is derived
// from the nav item, so without an entry here a page like Activity — reachable
// by URL and from inside Productions, but deliberately not in the rail — leaves
// the PREVIOUS page's title in the tab. Same strings the views themselves use.
export const OFF_NAV_PAGE_TITLES = {
  telemetry: () => t('nav.activity'),
};

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
  settings: 'settings',
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
