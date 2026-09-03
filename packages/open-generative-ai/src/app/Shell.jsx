// App chrome: labeled sidebar (≥lg), slim topbar, mobile tab strip.
import { useEffect, useState } from 'react';
import { useLang, useOwnerSession } from '../hooks/hooks.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { getLang, t } from '../lib/i18n.js';

const zhUi = () => getLang() === 'zh-CN';
import { clearOwnerHandoff, ensureVaultReady, requestVaultUnlock, resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, IconButton, Kbd, cx } from '../ui/kit.jsx';
import { getExploreDock, subscribeExploreDock, toggleExploreDock } from './exploreDockStore.js';
import { APP_NAME, NAV_ITEMS, NAV_SECTIONS } from './navConfig.jsx';
import { Menu } from '../ui/Menu.jsx';
import { STUDIO_RESTART_COMMAND, apiOfflineSentence, apiStatusLabel, pingApiStatus, useApiStatus } from './statusStore.js';

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
      title={zhUi() ? 'Hivemind 提示词库' : 'Hivemind prompt library'}
      aria-label={zhUi() ? 'Hivemind 提示词库' : 'Hivemind prompt library'}
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
  const zh = zhUi();
  const [busy, setBusy] = useState(false);
  const label = apiStatusLabel(status, zh);
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
          title={zh ? `工作室：${label}` : `The studio: ${label}`}
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
              ? (zh ? '工作室正在运行' : 'The studio is running')
              : status.tone === 'offline'
                ? (zh ? '工作室没有运行' : 'The studio is not running')
                : (zh ? '正在联系工作室…' : 'Reaching the studio…')}
          </div>
          {status.tone === 'offline' ? (
            <>
              <p className="text-xs leading-relaxed text-ink2">{apiOfflineSentence(zh)}</p>
              <code className="block select-all break-all rounded-md border border-line1 bg-bg2 px-2 py-1.5 font-mono text-[11px] text-ink1">
                {STUDIO_RESTART_COMMAND}
              </code>
            </>
          ) : null}
          <Button
            size="sm"
            icon="refresh"
            loading={busy}
            onClick={() => { retry(); close(); }}
          >
            {zh ? '立即重试' : 'Retry now'}
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
      title={zhUi() ? '此标签页的保险库已锁定——解锁以查看加密媒体与已保存项目' : 'Your vault is locked in this tab — unlock it to open sealed media and saved items'}
      className="inline-flex h-ctl-md items-center gap-1.5 rounded-md border border-honey/50 bg-honey-tint px-3 text-xs font-semibold text-honey transition-colors hover:border-honey"
    >
      <Icon name="unlock" size={14} />
      <span className="hidden sm:inline">{zhUi() ? '解锁保险库' : 'Unlock vault'}</span>
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
          title={zhUi() ? '退出并锁定工作室' : 'Sign out and lock this studio'}
          className="inline-flex h-ctl-md items-center gap-1.5 rounded-md border border-line1 bg-bg2 px-3 text-xs font-semibold text-ink2 transition-colors hover:border-line2 hover:text-ink1"
        >
          <Icon name="lock" size={14} />
          <span className="hidden sm:inline">{zhUi() ? '锁定' : 'Lock'}</span>
        </button>
      ) : null}
    </>
  );
}

// Topbar refresh: re-reads the catalog, runs and history. The icon spins briefly
// so the click is visibly acknowledged even on pages that refresh silently.
function RefreshButton({ zh }) {
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
      title={zh ? '刷新目录、运行与历史' : 'Refresh catalog, runs and history'}
      aria-label={zh ? '刷新' : 'Refresh'}
      className="grid h-ctl-md w-[36px] shrink-0 place-items-center rounded-md text-ink2 transition-colors hover:bg-bg2 hover:text-ink1"
    >
      <Icon name="refresh" size={17} className={busy ? 'hive-motion-keep animate-[hive-spin_0.7s_linear_infinite]' : ''} />
    </button>
  );
}

// The mobile strip holds 13 chips in ~375px; landing on a System page used to
// leave the highlighted chip off-screen with no hint that the strip scrolls.
function scrollActiveChipIntoView(node) {
  if (!node || typeof node.scrollIntoView !== 'function') return;
  try { node.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch { /* older engines */ }
}

function NavEntry({ item, active, onNavigate }) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.page)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'group relative flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150',
        active ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
      )}
    >
      <span
        className={cx(
          'absolute left-[-10px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-honey transition-opacity duration-150',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
      <Icon name={item.icon} size={16} className={active ? 'text-honey' : 'text-ink3 group-hover:text-ink2'} />
      <span className="truncate">{item.label()}</span>
    </button>
  );
}

// The command palette's own doorway. A shortcut nobody can see is a shortcut
// nobody uses, so ⌘K sits beside the page title and is also clickable.
function PaletteHint({ onOpen }) {
  const mac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
  const label = zhUi() ? '搜索页面、标签、提示词、模型' : 'Search pages, tabs, prompts and models';
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

export function Shell({ page, onNavigate, onOpenSettings, onOpenPalette, children }) {
  const { zh, toggle, lang } = useLang();
  const activeItem = NAV_ITEMS.find((i) => i.page === page);

  useEffect(() => {
    if (activeItem) document.title = `${activeItem.label()} — ${APP_NAME}`;
  }, [activeItem]);

  return (
    <div className="flex h-full w-full">
      {/* ---- Sidebar (≥ lg) ---- */}
      <aside
        className="hidden w-[var(--sidebar-w)] shrink-0 flex-col border-r border-line1 bg-bg1 lg:flex"
        aria-label="Studio navigation"
      >
        <button
          type="button"
          onClick={() => onNavigate('image')}
          className="mx-3 mb-1 mt-3 flex items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg2"
          title={APP_NAME}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="logo" size={20} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold leading-tight text-ink1">Hivemind</span>
            <span className="block truncate text-[11px] leading-tight text-ink3">Content Studio</span>
          </span>
        </button>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-2">
          {NAV_SECTIONS.map((section, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink3">
                {section.label()}
              </div>
              {section.items.map((item) => (
                <NavEntry key={item.page} item={item} active={item.page === page} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-1 border-t border-line1 p-3">
          <IconButton icon="settings" label={`${t('nav.settings')} (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`} onClick={onOpenSettings} />
          <button
            type="button"
            onClick={toggle}
            title={`${lang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh')} (${zh ? '页面会刷新' : 'reloads the page'})`}
            className="grid h-ctl-md w-[36px] place-items-center rounded-md text-[11px] font-bold text-ink2 transition-colors hover:bg-bg2 hover:text-ink1"
          >
            {lang === 'zh-CN' ? 'EN' : '中文'}
          </button>
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
            <ExploreDockButton />
            <ApiStatusPill />
            <RefreshButton zh={zh} />
            <LockButton />
            <span className="lg:hidden">
              <IconButton icon="settings" label={`${t('nav.settings')} (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl+'},)`} onClick={onOpenSettings} />
            </span>
            <button
              type="button"
              onClick={toggle}
              title={`${lang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh')} (${zh ? '页面会刷新' : 'reloads the page'})`}
              className="grid h-ctl-md w-[36px] place-items-center rounded-md text-[11px] font-bold text-ink2 transition-colors hover:bg-bg2 hover:text-ink1 lg:hidden"
            >
              {lang === 'zh-CN' ? 'EN' : '中文'}
            </button>
          </div>
        </header>

        {/* ---- Mobile tab strip (< lg) ---- */}
        <nav
          className="hive-edge-fade flex h-11 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line1 bg-bg1 px-3 lg:hidden"
          aria-label="Studio navigation"
        >
          {NAV_ITEMS.map((item) => {
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
        </nav>

        <main id="content-area" className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-bg0">
          {children}
        </main>
      </div>
    </div>
  );
}
