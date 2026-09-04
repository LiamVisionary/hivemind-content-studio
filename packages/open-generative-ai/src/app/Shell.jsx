// App chrome: tiered sidebar (≥lg, an icon rail under 1280px), slim topbar, and
// a mobile chip strip that keeps the folded tiers behind one More menu.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOwnerSession } from '../hooks/hooks.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { t, tf } from '../lib/i18n.js';
import { clearOwnerHandoff, ensureVaultReady, requestVaultUnlock, resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, CollapsibleSection, IconButton, Kbd, StudioRestartAction, cx, openSection } from '../ui/kit.jsx';
import { getExploreDock, subscribeExploreDock, toggleExploreDock } from './exploreDockStore.js';
import { getNavBadges, subscribeNavBadges } from './navBadges.js';
import { APP_NAME, NAV_ITEMS, NAV_SECTIONS, OFF_NAV_PAGE_TITLES } from './navConfig.jsx';
import { APP_VERSION, shortCommit, versionLabel } from '../lib/appVersion.js';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { apiOfflineSentence, apiStatusLabel, pingApiStatus, useApiStatus } from './statusStore.js';

// Topbar trigger for the Hivemind prompt library (explore dock). Only in studio
// mode; the panel itself is rendered once by App and anchors under this button.
function ExploreDockButton() {
  const [open, setOpen] = useState(getExploreDock);
  useEffect(() => subscribeExploreDock(setOpen), []);
  if (!isHivemindStudioEnabled()) return null;
  return (
    <button
      type="button"
      data-explore-trigger
      onClick={toggleExploreDock}
      title="Hivemind prompt library"
      aria-label="Hivemind prompt library"
      aria-pressed={open}
      className={cx(
        'inline-flex h-ctl-md items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-colors duration-150',
        open
          ? 'border-honey/50 bg-honey-tint text-honey'
          : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
      )}
    >
      <Icon name="logo" size={15} className="text-honey" />
      <span className="hidden sm:inline">Hive</span>
    </button>
  );
}

// The verdict is a button, not a coloured dot: a user who reads "Not running"
// needs the sentence and the command in the same place, plus a way to ask again
// without reloading the page.
function ApiStatusPill() {
  const status = useApiStatus();
  const [busy, setBusy] = useState(false);
  const label = apiStatusLabel(status);
  const tone =
    status.tone === 'online'
      ? 'text-ok bg-ok-tint'
      : status.tone === 'offline'
        ? 'text-danger bg-danger-tint'
        : 'text-warn bg-warn/10';
  const retry = () => {
    setBusy(true);
    void pingApiStatus().finally(() => setBusy(false));
  };
  return (
    <Menu
      align="end"
      width="w-[300px]"
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          title={tf('app.statusTitle', label)}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold transition-opacity hover:opacity-85',
            tone,
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2 p-1.5">
          <div className="text-[13px] font-semibold text-ink1">
            {status.online
              ? t('app.running')
              : status.tone === 'offline'
                ? t('app.notRunning')
                : t('app.reaching')}
          </div>
          {status.tone === 'offline' ? (
            <>
              <p className="text-xs leading-relaxed text-ink2">{apiOfflineSentence()}</p>
              <StudioRestartAction />
            </>
          ) : null}
          <Button
            size="sm"
            icon="refresh"
            loading={busy}
            onClick={() => { retry(); close(); }}
          >
            {t('common.tryAgain')}
          </Button>
        </div>
      )}
    </Menu>
  );
}

// Signed in (cookie) but this tab never received the per-tab passphrase — a
// second browser tab, typically. Every sealed tile then says "unlock", so the
// control to do it has to exist somewhere: here, next to Lock.
function VaultUnlockButton({ signedIn }) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!signedIn || !isHivemindStudioEnabled()) return undefined;
    let alive = true;
    ensureVaultReady().then((ready) => { if (alive) setLocked(!ready); });
    return () => { alive = false; };
  }, [signedIn]);
  if (!locked) return null;
  return (
    <button
      type="button"
      onClick={requestVaultUnlock}
      title="Locked — unlock to see your encrypted media and saved items"
      className="inline-flex h-ctl-md items-center gap-1.5 rounded-md border border-honey/50 bg-honey-tint px-3 text-xs font-semibold text-honey transition-colors hover:border-honey"
    >
      <Icon name="unlock" size={14} />
      <span className="hidden sm:inline">Unlock vault</span>
    </button>
  );
}

function LockButton() {
  const unlocked = useOwnerSession();
  const lock = async () => {
    window.dispatchEvent(new Event('hivemind-owner-lock-broadcast'));
    // The passphrase handoff lives in this tab's sessionStorage for 24 h; Lock
    // must not leave it behind (the hub only cleared it once a hub page had
    // been visited).
    clearOwnerHandoff();
    resetVaultSession();
    try {
      await fetch('/api/owner/lock', { method: 'POST' });
    } catch { /* non-critical */ }
    location.reload();
  };
  return (
    <>
      <VaultUnlockButton signedIn={unlocked} />
      {unlocked ? (
        <button
          type="button"
          onClick={lock}
          title="Sign out and lock this studio"
          className="inline-flex h-ctl-md items-center gap-1.5 rounded-md border border-line1 bg-bg2 px-3 text-xs font-semibold text-ink2 transition-colors hover:border-line2 hover:text-ink1"
        >
          <Icon name="lock" size={14} />
          <span className="hidden sm:inline">Lock</span>
        </button>
      ) : null}
    </>
  );
}

// Topbar refresh: re-reads the catalog, runs and history. The icon spins briefly
// so the click is visibly acknowledged even on pages that refresh silently.
function RefreshButton() {
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    window.dispatchEvent(new Event('hivemind-hub-refresh'));
    setBusy(true);
    window.setTimeout(() => setBusy(false), 900);
  };
  return (
    <button
      type="button"
      onClick={refresh}
      title={t('app.refreshTitle')}
      aria-label={t('app.refresh')}
      className="grid h-ctl-md w-[36px] shrink-0 place-items-center rounded-md text-ink2 transition-colors hover:bg-bg2 hover:text-ink1"
    >
      <Icon name="refresh" size={17} className={busy ? 'hive-motion-keep animate-[hive-spin_0.7s_linear_infinite]' : ''} />
    </button>
  );
}

// The strip holds the Create and Produce chips — about ten in ~375px — and the
// folded tiers ride in the More menu beside them. Landing on a page whose chip
// is off-screen used to leave no hint that the strip scrolls.
function scrollActiveChipIntoView(node) {
  if (!node || typeof node.scrollIntoView !== 'function') return;
  try { node.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch { /* older engines */ }
}

/* ------------------------------------------------------------------ */
/* Sidebar tiers                                                      */
/* ------------------------------------------------------------------ */

// Under 1280px a 216px labelled sidebar plus a 320px params panel leaves no
// canvas, so the sidebar starts as an icon rail there. The chevron in the footer
// overrides that in either direction and the choice is remembered.
const RAIL_QUERY = '(max-width: 1279px)';
const RAIL_KEY = 'studio.sidebarCollapsed';

function readRailPreference() {
  try {
    const stored = window.localStorage?.getItem(RAIL_KEY);
    return stored === null || stored === undefined ? null : stored === '1';
  } catch { return null; }
}

function useSidebarRail() {
  const [narrow, setNarrow] = useState(() => {
    try { return Boolean(window.matchMedia?.(RAIL_QUERY)?.matches); } catch { return false; }
  });
  const [preference, setPreference] = useState(readRailPreference);
  useEffect(() => {
    let query = null;
    try { query = window.matchMedia?.(RAIL_QUERY) || null; } catch { query = null; }
    if (!query?.addEventListener) return undefined;
    const onChange = (event) => setNarrow(Boolean(event.matches));
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const setCollapsed = (next) => {
    setPreference(next);
    try { window.localStorage?.setItem(RAIL_KEY, next ? '1' : '0'); } catch { /* quota */ }
  };
  return [preference === null ? narrow : preference, setCollapsed];
}

const readNavBadges = () => getNavBadges();
const useNavBadges = () => useSyncExternalStore(subscribeNavBadges, readNavBadges, readNavBadges);

function NavEntry({ item, active, collapsed, count = 0, onNavigate }) {
  const label = item.label();
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.page)}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={cx(
        'group relative flex h-9 w-full items-center rounded-md text-[13px] font-medium transition-colors duration-150',
        collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
        active ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
      )}
    >
      <span
        className={cx(
          'absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-honey transition-opacity duration-150',
          collapsed ? 'left-0' : 'left-[-10px]',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Icon name={item.icon} size={16} className={active ? 'text-honey' : 'text-ink3 group-hover:text-ink2'} />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {count > 0 ? (
        collapsed
          ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-honey" />
          : <span className="ml-auto shrink-0 rounded-full bg-honey-tint px-1.5 font-mono text-[10px] font-semibold text-honey">{count}</span>
      ) : null}
    </button>
  );
}

// The command palette's own doorway. A shortcut nobody can see is a shortcut
// nobody uses, so ⌘K sits beside the page title and is also clickable.
function PaletteHint({ onOpen }) {
  const mac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  const label = 'Search pages, tabs, prompts and models';
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      className="hidden items-center gap-1.5 rounded-md border border-line1 bg-bg2 px-2 py-1 text-ink3 transition-colors hover:border-line2 hover:text-ink2 sm:inline-flex"
    >
      <Icon name="search" size={13} />
      <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
    </button>
  );
}

// The version chip. AGPL 5(d) wants an interactive program to say what it is and
// under what terms; this is the door to the page that says it, and it is also the
// fastest honest answer to "which build am I on".
//
// The number comes from the bundle (vite substitutes pyproject.toml's version at
// build), so it needs no request and is never blank while one is in flight. The
// commit is only known once the server has answered, so the chip shows the
// version alone until then and grows the commit after.
function VersionChip({ onNavigate }) {
  const [commit, setCommit] = useState('');
  useEffect(() => {
    let cancelled = false;
    // Unauthenticated by design, and tiny. A failure here is not worth a word on
    // screen: the chip still names the version and still opens About, which is
    // where a real problem reading the version reports itself.
    fetch('/api/version', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!cancelled && body?.commit) setCommit(shortCommit(body.commit)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const label = versionLabel({ version: APP_VERSION, commit });
  if (!label) return null;
  const title = `About · ${label} · AGPL-3.0-or-later`;
  return (
    <button
      type="button"
      onClick={() => onNavigate('about')}
      title={title}
      aria-label={title}
      className="hidden items-center rounded-md border border-line1 bg-bg2 px-2 py-1 font-mono text-[11px] text-ink3 transition-colors hover:border-line2 hover:text-ink2 md:inline-flex"
    >
      {label}
    </button>
  );
}

// One disclosure convention: a collapsible group is a kit CollapsibleSection with
// its closed-state hint, and the rail draws every group flat because a fold whose
// title you cannot read is a trap.
function NavGroup({ group, page, collapsed, hint, countFor, onNavigate }) {
  const holdsActive = group.items.some((item) => item.page === page);
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (!holdsActive || !group.collapsible) return;
    if (openSection(group.storageKey)) setReveal((n) => n + 1);
  }, [holdsActive, group.collapsible, group.storageKey, page]);

  const entries = group.items.map((item) => (
    <NavEntry
      key={item.page}
      item={item}
      active={item.page === page}
      collapsed={collapsed}
      count={countFor(item)}
      onNavigate={onNavigate}
    />
  ));

  if (collapsed) return <div className="flex flex-col gap-0.5">{entries}</div>;
  if (!group.collapsible) {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink3">{group.label()}</div>
        {entries}
      </div>
    );
  }
  return (
    <CollapsibleSection
      key={reveal}
      title={group.label()}
      hint={hint}
      defaultOpen={group.defaultOpen}
      storageKey={group.storageKey}
      className="px-2.5"
    >
      <div className="-mx-2.5 -mt-2 flex flex-col gap-0.5">{entries}</div>
    </CollapsibleSection>
  );
}

export function Shell({ page, onNavigate, onOpenSettings, onOpenPalette, children }) {
  const activeItem = NAV_ITEMS.find((i) => i.page === page);
  const [railed, setRailed] = useSidebarRail();
  const badges = useNavBadges();

  useEffect(() => {
    const label = activeItem ? activeItem.label() : OFF_NAV_PAGE_TITLES[page]?.();
    if (label) document.title = `${label} — ${APP_NAME}`;
  }, [activeItem, page]);

  // Two numbers, each on the group it belongs to: an approval an agent is waiting
  // on hints the closed Advanced header open, and a production still running is
  // counted on the Productions row itself.
  const advancedHint = badges.passbookPending > 0
    ? `${badges.passbookPending} request${badges.passbookPending > 1 ? 's' : ''} waiting on you`
    : '';
  const countFor = (item) => (item.page === 'runs' ? badges.runningProductions : 0);

  // Create and Produce ride the strip; Labs and Advanced ride the More menu.
  const stripItems = NAV_SECTIONS.filter((s) => !s.collapsible).flatMap((s) => s.items);
  const moreGroups = [
    ...NAV_SECTIONS.flatMap((s) => (s.labs ? [s.labs] : [])),
    ...NAV_SECTIONS.filter((s) => s.collapsible),
  ];
  const moreItem = moreGroups.flatMap((g) => g.items).find((item) => item.page === page);

  return (
    <div className="flex h-full w-full">
      {/* ---- Sidebar (≥ lg; icon rail when collapsed) ---- */}
      <aside
        className={cx(
          'hidden shrink-0 flex-col border-r border-line1 bg-bg1 lg:flex',
          railed ? 'w-[var(--sidebar-w-rail)]' : 'w-[var(--sidebar-w)]',
        )}
        aria-label="Studio navigation"
      >
        <button
          type="button"
          onClick={() => onNavigate('image')}
          className={cx(
            'mb-1 mt-3 flex items-center rounded-md py-2 text-left transition-colors hover:bg-bg2',
            railed ? 'mx-2 justify-center px-0' : 'mx-3 gap-2.5 px-2',
          )}
          title={APP_NAME}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="logo" size={20} />
          </span>
          {railed ? null : (
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold leading-tight text-ink1">Hivemind</span>
              <span className="block truncate text-[11px] leading-tight text-ink3">Content Studio</span>
            </span>
          )}
        </button>
        <nav className={cx('flex flex-1 flex-col overflow-y-auto py-2', railed ? 'gap-3 px-2' : 'gap-4 px-3')}>
          {NAV_SECTIONS.map((section) => (
            <div key={section.id} className={cx('flex flex-col', railed ? 'gap-3' : 'gap-4')}>
              <NavGroup
                group={section}
                page={page}
                collapsed={railed}
                hint={section.id === 'advanced' ? advancedHint : ''}
                countFor={countFor}
                onNavigate={onNavigate}
              />
              {section.labs ? (
                <NavGroup
                  group={section.labs}
                  page={page}
                  collapsed={railed}
                  hint=""
                  countFor={countFor}
                  onNavigate={onNavigate}
                />
              ) : null}
            </div>
          ))}
        </nav>
        {/* The language toggle stood here. This build ships one language
            (LANGS_ENABLED in lib/i18n.js); the control returns with the key
            table, in Settings only. The rail collapse took its place. */}
        <div className={cx('flex items-center gap-1 border-t border-line1 p-3', railed && 'flex-wrap justify-center')}>
          <IconButton
            icon={railed ? 'chevronRight' : 'chevronLeft'}
            label={railed ? t('app.widenSidebar') : t('app.collapseSidebar')}
            onClick={() => setRailed(!railed)}
          />
          <IconButton icon="settings" label={`${t('common.settings')} (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`} onClick={onOpenSettings} />
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-30 flex h-[var(--topbar-h)] shrink-0 items-center justify-between gap-3 border-b border-line1 bg-bg1 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-honey-tint text-honey lg:hidden">
              <Icon name="logo" size={17} />
            </span>
            <h1 className="truncate text-[14px] font-semibold text-ink1">{activeItem?.label() || APP_NAME}</h1>
            {onOpenPalette ? <PaletteHint onOpen={onOpenPalette} /> : null}
            <span className="hidden truncate text-xs text-ink3 md:inline">{APP_NAME}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <VersionChip onNavigate={onNavigate} />
            <ExploreDockButton />
            <ApiStatusPill />
            <RefreshButton />
            <LockButton />
            <span className="lg:hidden">
              <IconButton icon="settings" label={`${t('common.settings')} (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`} onClick={onOpenSettings} />
            </span>
          </div>
        </header>

        {/* ---- Mobile tab strip (< lg) ---- */}
        <nav
          className="hive-edge-fade flex h-11 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line1 bg-bg1 px-3 lg:hidden"
          aria-label="Studio navigation"
        >
          {stripItems.map((item) => {
            const on = item.page === page;
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
                aria-current={on ? 'page' : undefined}
                ref={on ? scrollActiveChipIntoView : undefined}
                className={cx(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors duration-150',
                  on ? 'bg-honey-tint text-honey' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
                )}
              >
                <Icon name={item.icon} size={13} />
                {item.label()}
              </button>
            );
          })}
          {/* Labs and Advanced, one press away instead of eighteen chips wide. */}
          <span className="shrink-0" ref={moreItem ? scrollActiveChipIntoView : undefined}>
            <Menu
              align="end"
              width="w-56"
              trigger={(open, togglePanel) => (
                <ChipButton
                  icon="more"
                  value={moreItem ? moreItem.label() : t('app.more')}
                  active={open || Boolean(moreItem)}
                  onClick={togglePanel}
                  aria-haspopup="menu"
                  aria-expanded={open}
                />
              )}
            >
              {(close) => (
                <>
                  {moreGroups.map((group) => (
                    <div key={group.id}>
                      <MenuHeading>{group.label()}</MenuHeading>
                      {group.items.map((item) => (
                        <MenuItem
                          key={item.page}
                          icon={item.icon}
                          selected={item.page === page}
                          onClick={() => { onNavigate(item.page); close(); }}
                        >
                          {item.label()}
                        </MenuItem>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </Menu>
          </span>
        </nav>

        <main id="content-area" className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg0">
          {children}
        </main>
      </div>
    </div>
  );
}
