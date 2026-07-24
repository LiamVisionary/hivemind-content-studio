// App chrome: labeled sidebar (≥lg), slim topbar, mobile tab strip.
import { useEffect, useState } from 'react';
import { useLang, useOwnerSession } from '../hooks/hooks.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { t } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { IconButton, cx } from '../ui/kit.jsx';
import { getExploreDock, subscribeExploreDock, toggleExploreDock } from './exploreDockStore.js';
import { APP_NAME, NAV_ITEMS, NAV_SECTIONS } from './navConfig.jsx';
import { getApiStatus, subscribeApiStatus } from './statusStore.js';

// Topbar trigger for the Hivemind explore dock. Only in studio mode; the dock
// panel itself is rendered once by App and anchors under this button.
function ExploreDockButton() {
  const [open, setOpen] = useState(getExploreDock);
  useEffect(() => subscribeExploreDock(setOpen), []);
  if (!isHivemindStudioEnabled()) return null;
  return (
    <button
      type="button"
      data-explore-trigger
      onClick={toggleExploreDock}
      title="Hivemind studio tools"
      aria-label="Hivemind studio tools"
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

function ApiStatusPill() {
  const [status, setStatus] = useState(getApiStatus);
  useEffect(() => subscribeApiStatus(setStatus), []);
  const tone =
    status.tone === 'online'
      ? 'text-ok bg-ok-tint'
      : status.tone === 'offline'
        ? 'text-danger bg-danger-tint'
        : 'text-warn bg-warn/10';
  return (
    <span
      className={cx('inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold', tone)}
      title={`Studio API: ${status.label}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      <span className="hidden sm:inline">{status.label}</span>
    </span>
  );
}

function LockButton() {
  const unlocked = useOwnerSession();
  if (!unlocked) return null;
  const lock = async () => {
    window.dispatchEvent(new Event('hivemind-owner-lock-broadcast'));
    try {
      await fetch('/api/owner/lock', { method: 'POST' });
    } catch { /* non-critical */ }
    location.reload();
  };
  return (
    <button
      type="button"
      onClick={lock}
      title="Lock the studio (owner session)"
      className="inline-flex h-ctl-md items-center gap-1.5 rounded-md border border-line1 bg-bg2 px-3 text-xs font-semibold text-ink2 transition-colors hover:border-line2 hover:text-ink1"
    >
      <Icon name="lock" size={14} />
      <span className="hidden sm:inline">Lock</span>
    </button>
  );
}

function NavEntry({ item, active, onNavigate }) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(item.page)}
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

export function Shell({ page, onNavigate, onOpenSettings, children }) {
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
        <nav className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-2">
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
          <IconButton icon="settings" label={t('nav.settings')} onClick={onOpenSettings} />
          <button
            type="button"
            onClick={toggle}
            title={lang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh')}
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
            <span className="hidden truncate text-xs text-ink3 md:inline">{APP_NAME}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ExploreDockButton />
            <ApiStatusPill />
            <IconButton
              icon="refresh"
              label="Refresh studio data"
              onClick={() => window.dispatchEvent(new Event('hivemind-hub-refresh'))}
            />
            <LockButton />
            <span className="lg:hidden">
              <IconButton icon="settings" label={t('nav.settings')} onClick={onOpenSettings} />
            </span>
            <button
              type="button"
              onClick={toggle}
              title={lang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh')}
              className="grid h-ctl-md w-[36px] place-items-center rounded-md text-[11px] font-bold text-ink2 transition-colors hover:bg-bg2 hover:text-ink1 lg:hidden"
            >
              {lang === 'zh-CN' ? 'EN' : '中文'}
            </button>
          </div>
        </header>

        {/* ---- Mobile tab strip (< lg) ---- */}
        <nav
          className="no-scrollbar flex h-11 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line1 bg-bg1 px-3 lg:hidden"
          aria-label="Studio navigation"
        >
          {NAV_ITEMS.map((item) => {
            const on = item.page === page;
            return (
              <button
                key={item.page}
                type="button"
                onClick={() => onNavigate(item.page)}
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
