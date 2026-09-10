// App chrome: a tiered sidebar (≥lg, an icon rail when folded) and a mobile chip
// strip that keeps the folded tiers behind one More menu.
//
// There is no topbar. It held eight controls on every page and cost 52px of
// stage to do it; each of them now lives where it belongs — see the note at the
// main column below.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOwnerSession } from '../hooks/hooks.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { t, tf } from '../lib/i18n.js';
import { clearOwnerHandoff, ensureVaultReady, requestVaultUnlock, resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, CollapsibleSection, IconButton, Kbd, Spinner, cx, openSection } from '../ui/kit.jsx';
import { getNavBadges, subscribeNavBadges } from './navBadges.js';
import { APP_NAME, NAV_ITEMS, NAV_SECTIONS, OFF_NAV_PAGE_TITLES } from './navConfig.jsx';
import { APP_VERSION, shortCommit, versionLabel } from '../lib/appVersion.js';
import { checkForUpdate } from '../lib/appUpdate.js';
import { inDesktopShell, installUpdate } from '../lib/desktopShell.js';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';

// The Hivemind prompt library's trigger used to live up here. It only ever
// inserted into a studio's prompt, so it now lives where that prompt is — the
// composer's `more` door in the Image and Video studios (see
// studios/frame/ExploreDockItem.jsx). Nothing anchors to it; the dock only
// checks [data-explore-trigger] to know not to dismiss itself on its own button.

// The verdict is a button, not a coloured dot: a user who reads "Not running"
// needs the sentence and the command in the same place, plus a way to ask again
// without reloading the page.
// The "Local API ready" verdict stood here, on screen at all times, saying
// "fine" 99% of the time. It is gone: the only reading that matters is the
// failing one, and every surface already carries that where it bites — the
// studios float StudioOfflineNotice over the stage (with Retry and the shell's
// restart), and the hub views show their own "showing the last reading" pill on
// the data that went stale. A permanent green dot is decoration.

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
      title={t('app.unlockVaultTitle')}
      aria-label={t('app.unlockVault')}
      className="grid h-ctl-md w-9 shrink-0 place-items-center rounded-md border border-honey/50 bg-honey-tint text-honey transition-colors hover:border-honey"
    >
      <Icon name="unlock" size={15} />
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
        <IconButton icon="lock" label={t('app.lockStudio')} onClick={lock} />
      ) : null}
    </>
  );
}

// The topbar's global Refresh stood here. One button that re-read everything,
// on every page, including the ones with nothing to re-read — so it is now a
// control on the hub toolbars whose data is actually polled (HubToolbar's
// `refresh`), and it still dispatches the same 'hivemind-hub-refresh' event that
// the studios' catalogs, the local-model list and the Comfy probe listen for.

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
// nobody uses, so it is a real row under the brand — the place a sidebar's
// search belongs — and shrinks to its magnifier on the rail.
function SidebarSearch({ onOpen, railed }) {
  const mac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  const label = t('app.paletteTitle');
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      className={cx(
        'flex h-8 items-center rounded-md border border-line1 bg-bg2 text-ink3 transition-colors hover:border-line2 hover:text-ink2',
        railed ? 'mx-2 justify-center px-0' : 'mx-3 gap-2 px-2.5',
      )}
    >
      <Icon name="search" size={14} className="shrink-0" />
      {railed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate text-left text-[12.5px]">{t('app.paletteLabel')}</span>
          <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
        </>
      )}
    </button>
  );
}

// The build, in plain text, at the bottom of the sidebar. AGPL 5(d) wants an
// interactive program to say what it is and under what terms; this is the door
// to the page that says it, and the fastest honest answer to "which build am I
// on". It stopped being a bordered chip in the topbar because it is a footnote,
// not a control — it reads as one line of mono and only underlines on hover.
//
// The number comes from the bundle (vite substitutes pyproject.toml's version at
// build), so it needs no request and is never blank while one is in flight. The
// commit is only known once the server has answered, so it shows the version
// alone until then and grows the commit after.
function SidebarVersion({ onNavigate, railed }) {
  const [commit, setCommit] = useState('');
  const [update, setUpdate] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let cancelled = false;
    // Unauthenticated by design, and tiny. A failure here is not worth a word on
    // screen: the line still names the version and still opens About, which is
    // where a real problem reading the version reports itself.
    fetch('/api/version', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        if (body.commit) setCommit(shortCommit(body.commit));
        // The repository comes from the SAME identity the shell's updater
        // endpoint is built from, so the page and the shell cannot end up
        // watching different repositories.
        return checkForUpdate({ sourceUrl: body.source_url, current: body.version || APP_VERSION })
          .then((found) => { if (!cancelled) setUpdate(found); });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const label = versionLabel({ version: APP_VERSION, commit });
  if (!label) return null;
  const title = `${t('nav.about')} · ${label} · AGPL-3.0-or-later`;

  // In the packaged app, installing means replacing the bundle and relaunching —
  // which is what every platform's updater does, and the only honest reading of
  // "update just what changed" for a signed bundle. Everywhere else the page
  // opens the release: a page must not mutate the server that serves it, and a
  // self-hosted install updates through its own deployment path.
  const install = async () => {
    if (!inDesktopShell()) {
      try { window.open(update.url, '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
      return;
    }
    setInstalling(true);
    setFailed('');
    const result = await installUpdate();
    // A successful install never resolves — the process is replaced mid-call —
    // so anything that gets here either declined or failed.
    setInstalling(false);
    if (!result.ok) setFailed(result.reason);
  };

  return (
    <div className={cx('flex min-w-0 flex-col gap-1', railed && 'items-center')}>
      <button
        type="button"
        onClick={() => onNavigate('about')}
        title={title}
        aria-label={title}
        className={cx(
          'truncate px-1 font-mono text-[10.5px] text-ink3 transition-colors hover:text-ink2 hover:underline',
          railed ? 'text-center' : 'text-left',
        )}
      >
        {railed ? `v${APP_VERSION}` : label}
      </button>
      {update ? (
        <>
          <button
            type="button"
            onClick={install}
            disabled={installing}
            title={tf('app.updateTitle', update.version)}
            aria-label={tf('app.updateTitle', update.version)}
            className={cx(
              'flex items-center gap-1.5 rounded-md border border-honey/40 bg-honey-tint text-[11px] font-semibold text-honey transition-colors hover:border-honey disabled:opacity-60',
              railed ? 'h-7 w-7 justify-center' : 'h-7 px-2',
            )}
          >
            {installing ? <Spinner size={12} /> : <Icon name="download" size={13} className="shrink-0" />}
            {railed ? null : <span className="truncate">{tf('app.updateReady', update.version)}</span>}
          </button>
          {/* The reason, once, in the key table's words — never the shell's own
              error text. 'unsigned-channel' is the one worth reading: this build
              carries no updater key, so the release has to be fetched by hand. */}
          {failed && !railed ? (
            <span className="px-1 text-[10.5px] leading-snug text-ink3">{t(`app.update.${failed}`)}</span>
          ) : null}
        </>
      ) : null}
    </div>
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
        {/* The shelf's own toggle belongs at the top of the shelf, next to what it
            folds — not at the bottom beside Settings, where a lone chevron read
            as "previous". Railed, the brand and the toggle stack instead of
            fighting over 56px. */}
        <div className={cx('mb-1 mt-3 flex items-center', railed ? 'flex-col gap-1 px-2' : 'gap-1 px-3')}>
          <button
            type="button"
            onClick={() => onNavigate('image')}
            className={cx(
              'flex min-w-0 items-center rounded-md py-2 text-left transition-colors hover:bg-bg2',
              railed ? 'justify-center px-0' : 'flex-1 gap-2.5 px-2',
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
          <IconButton
            icon="panelLeft"
            label={railed ? t('app.widenSidebar') : t('app.collapseSidebar')}
            active={railed}
            onClick={() => setRailed(!railed)}
          />
        </div>
        <SidebarSearch onOpen={onOpenPalette} railed={railed} />
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
        {/* Two rows, and everything the topbar used to hold on its right side.
            Top: the account-and-machine controls — settings, Lock (or Unlock
            vault while this tab is sealed), and whether the studio is answering.
            Bottom: the build, and the update when there is one. */}
        <div className={cx('flex flex-col gap-1.5 border-t border-line1 p-3', railed && 'items-center')}>
          <div className={cx('flex items-center gap-1', railed && 'flex-wrap justify-center')}>
            <IconButton icon="settings" label={`${t('common.settings')} (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`} onClick={onOpenSettings} />
            <LockButton />
          </div>
          <SidebarVersion onNavigate={onNavigate} railed={railed} />
        </div>
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The slim topbar stood here, on every page, and held eight controls
            that each belong somewhere better: the page title and the app name
            duplicated the sidebar, ⌘K is a search row under the brand, the
            version is a line at the sidebar's foot, Lock and the status verdict
            are in its utility row, Refresh is on the hub toolbars that actually
            poll, and the Hive prompt library opens from the composer that it
            inserts into. What it mostly did was take 52px off every stage. */}
        {/* ---- Mobile tab strip (< lg) ---- */}
        <nav
          className="hive-edge-fade flex h-11 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line1 bg-bg1 px-3 lg:hidden"
          aria-label="Studio navigation"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="logo" size={16} />
          </span>
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
                  {/* Below lg there is no sidebar, so its footer rides here —
                      the same four doors, in the same order. */}
                  <div className="my-1 h-px bg-line1" />
                  <MenuItem icon="search" onClick={() => { onOpenPalette?.(); close(); }}>
                    {t('app.paletteLabel')}
                  </MenuItem>
                  <MenuItem icon="settings" onClick={() => { onOpenSettings(); close(); }}>
                    {t('common.settings')}
                  </MenuItem>
                  <MenuItem icon="info" onClick={() => { onNavigate('about'); close(); }}>
                    {versionLabel({ version: APP_VERSION, commit: '' }) || t('nav.about')}
                  </MenuItem>
                </>
              )}
            </Menu>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
            <LockButton />
          </span>
        </nav>

        <main id="content-area" className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg0">
          {children}
        </main>
      </div>
    </div>
  );
}
