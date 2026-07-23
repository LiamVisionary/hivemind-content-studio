import { SettingsModal } from './SettingsModal.js';
import { t, getLang, setLang } from '../lib/i18n.js';

// Lucide-style stroke icons — one family, consistent 2px stroke.
const ICONS = {
    logo: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/><path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    image: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    video: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    lipsync: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    cinema: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8"/><path d="M2 6l19.5-2.5L22 8 2.5 10.5 2 6z"/><path d="M6.5 5.5l2 3.5"/><path d="M12.5 4.7l2 3.5"/><path d="M18.5 3.9l2 3.5"/></svg>`,
    canvas: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/><path d="M18 15V9a3 3 0 0 0-3-3h-3"/></svg>`,
    planner: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.9L12 3z"/><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/></svg>`,
    runs: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="12" height="4" rx="1"/><path d="M19 17l1.5 1.5L23 16"/></svg>`,
    history: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 13.5"/></svg>`,
    models: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>`,
    telemetry: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 12 6 12 9 4 15 20 18 12 22 12"/></svg>`,
    providers: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7V3"/><path d="M15 7V3"/><rect x="6" y="7" width="12" height="8" rx="2"/><path d="M12 15v3"/><path d="M12 18a3 3 0 0 1-3 3"/></svg>`,
    'mcp-cli': `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    refresh: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`,
    lock: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    settings: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

const zh = () => getLang() === 'zh-CN';

const NAV_SECTIONS = [
    {
        label: () => zh() ? '工作室' : 'Studios',
        items: [
            { page: 'image', icon: 'image', label: () => t('nav.image') },
            { page: 'video', icon: 'video', label: () => t('nav.video') },
            { page: 'lipsync', icon: 'lipsync', label: () => t('nav.lipsync'), railLabel: () => zh() ? '唇语' : 'Lip Sync' },
            { page: 'cinema', icon: 'cinema', label: () => t('nav.cinema'), railLabel: () => zh() ? '电影' : 'Cinema' },
            { page: 'canvas', icon: 'canvas', label: () => zh() ? '画布' : 'Canvas' },
        ],
    },
    {
        label: () => zh() ? '生产' : 'Produce',
        items: [
            { page: 'planner', icon: 'planner', label: () => zh() ? '规划器' : 'Planner' },
            { page: 'runs', icon: 'runs', label: () => zh() ? '运行' : 'Runs' },
            { page: 'history', icon: 'history', label: () => zh() ? '历史' : 'History' },
        ],
    },
    {
        label: () => zh() ? '系统' : 'System',
        items: [
            { page: 'models', icon: 'models', label: () => zh() ? '模型' : 'Models' },
            { page: 'telemetry', icon: 'telemetry', label: () => zh() ? '遥测' : 'Telemetry' },
            { page: 'providers', icon: 'providers', label: () => zh() ? '服务商' : 'Providers' },
            { page: 'mcp-cli', icon: 'mcp-cli', label: () => t('nav.mcpcli'), railLabel: () => 'MCP' },
        ],
    },
];

const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);
const APP_NAME = 'Hivemind Content Studio';

// Studio shell: left icon rail (desktop) + slim top bar + mobile tab strip.
// Returns { root, contentArea, setActive } — main.js drives navigation.
export function AppShell(navigate) {
    const root = document.createDocumentFragment();
    const railButtons = new Map();
    const tabButtons = new Map();
    let titleEl;

    // ---- Left rail -------------------------------------------------------
    const rail = document.createElement('aside');
    rail.className = 'hidden lg:flex w-[76px] shrink-0 flex-col items-center border-r border-white/[0.06] bg-panel-bg/70 backdrop-blur-xl py-3 z-40';
    rail.setAttribute('aria-label', 'Studio navigation');

    const logo = document.createElement('button');
    logo.className = 'mb-2 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary/25 to-accent/20 text-primary border border-white/10 transition-transform hover:scale-105';
    logo.innerHTML = ICONS.logo;
    logo.title = APP_NAME;
    logo.onclick = () => navigate('image');
    rail.appendChild(logo);

    const railNav = document.createElement('nav');
    railNav.className = 'flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto no-scrollbar pt-1';
    NAV_SECTIONS.forEach((section, sectionIndex) => {
        if (sectionIndex > 0) {
            const divider = document.createElement('div');
            divider.className = 'my-1.5 h-px w-8 shrink-0 bg-white/[0.07]';
            railNav.appendChild(divider);
        }
        section.items.forEach((item) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.dataset.page = item.page;
            btn.className = 'group relative flex w-[62px] shrink-0 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-secondary transition-colors hover:bg-white/[0.06] hover:text-white';
            btn.innerHTML = `
                <span class="pointer-events-none absolute left-[-7px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-primary opacity-0 transition-opacity" data-indicator></span>
                <span class="grid h-7 w-7 place-items-center" data-icon>${ICONS[item.icon]}</span>
                <span class="w-full truncate text-center text-[9px] font-semibold leading-tight tracking-wide">${(item.railLabel || item.label)()}</span>
            `;
            btn.onclick = () => navigate(item.page);
            railButtons.set(item.page, btn);
            railNav.appendChild(btn);
        });
    });
    rail.appendChild(railNav);

    const railBottom = document.createElement('div');
    railBottom.className = 'mt-1 flex shrink-0 flex-col items-center gap-0.5';

    const langBtn = document.createElement('button');
    const currentLang = getLang();
    langBtn.className = 'grid h-9 w-9 place-items-center rounded-xl text-[11px] font-bold text-secondary transition-colors hover:bg-white/[0.06] hover:text-white';
    langBtn.title = currentLang === 'zh-CN' ? t('web.switchToEn') : t('web.switchToZh');
    langBtn.textContent = currentLang === 'zh-CN' ? 'EN' : '中文';
    langBtn.onclick = () => setLang(currentLang === 'zh-CN' ? 'en' : 'zh-CN');
    railBottom.appendChild(langBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'grid h-9 w-9 place-items-center rounded-xl text-secondary transition-colors hover:bg-white/[0.06] hover:text-white';
    settingsBtn.title = t('web.settingsTitle');
    settingsBtn.setAttribute('aria-label', t('nav.settings'));
    settingsBtn.innerHTML = ICONS.settings;
    settingsBtn.onclick = () => document.body.appendChild(SettingsModal());
    railBottom.appendChild(settingsBtn);

    rail.appendChild(railBottom);
    root.appendChild(rail);

    // ---- Main column: top bar + mobile tabs + content --------------------
    const mainCol = document.createElement('div');
    mainCol.className = 'flex min-w-0 flex-1 flex-col';

    const topbar = document.createElement('header');
    topbar.className = 'z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] bg-panel-bg/70 px-4 backdrop-blur-xl md:px-5';

    const topLeft = document.createElement('div');
    topLeft.className = 'flex min-w-0 items-center gap-3';
    const mobileLogo = document.createElement('span');
    mobileLogo.className = 'grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/25 to-accent/20 text-primary border border-white/10 lg:hidden';
    mobileLogo.innerHTML = ICONS.logo;
    topLeft.appendChild(mobileLogo);

    titleEl = document.createElement('div');
    titleEl.className = 'flex min-w-0 items-baseline gap-2.5';
    topLeft.appendChild(titleEl);
    topbar.appendChild(topLeft);

    const topRight = document.createElement('div');
    topRight.className = 'flex shrink-0 items-center gap-2';

    // Hub status pill — hubApp.js reports into it by id.
    const apiStatus = document.createElement('span');
    apiStatus.id = 'hub-api-status';
    apiStatus.className = 'hub-api-status';
    apiStatus.innerHTML = '<i></i><span class="hidden sm:inline">Connecting</span>';
    topRight.appendChild(apiStatus);

    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'hub-refresh-button';
    refreshBtn.className = 'grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-secondary transition-colors hover:text-white hover:bg-white/10';
    refreshBtn.title = 'Refresh studio data';
    refreshBtn.setAttribute('aria-label', 'Refresh studio data');
    refreshBtn.innerHTML = ICONS.refresh;
    refreshBtn.onclick = () => window.dispatchEvent(new Event('hivemind-hub-refresh'));
    topRight.appendChild(refreshBtn);

    // Lock appears only when an owner session is actually active.
    const lockBtn = document.createElement('button');
    lockBtn.className = 'hidden h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs font-semibold text-secondary transition-colors hover:text-white hover:bg-white/10';
    lockBtn.innerHTML = `${ICONS.lock}<span class="hidden sm:inline">Lock</span>`;
    lockBtn.title = 'Lock the studio (owner session)';
    lockBtn.onclick = async () => {
        window.dispatchEvent(new Event('hivemind-owner-lock-broadcast'));
        try { await fetch('/api/owner/lock', { method: 'POST' }); } catch { /* non-critical */ }
        location.reload();
    };
    topRight.appendChild(lockBtn);
    fetch('/api/owner/session')
        .then((response) => (response.ok ? response.json() : null))
        .then((session) => {
            if (session?.unlocked) {
                lockBtn.classList.remove('hidden');
                lockBtn.classList.add('flex');
            }
        })
        .catch(() => { /* standalone mode — no owner gate */ });

    const mLangBtn = document.createElement('button');
    mLangBtn.className = 'grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-[11px] font-bold text-secondary transition-colors hover:text-white hover:bg-white/10 lg:hidden';
    mLangBtn.title = langBtn.title;
    mLangBtn.textContent = langBtn.textContent;
    mLangBtn.onclick = langBtn.onclick;
    topRight.appendChild(mLangBtn);

    const mSettingsBtn = document.createElement('button');
    mSettingsBtn.className = 'grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-secondary transition-colors hover:text-white hover:bg-white/10 lg:hidden';
    mSettingsBtn.title = t('web.settingsTitle');
    mSettingsBtn.setAttribute('aria-label', t('nav.settings'));
    mSettingsBtn.innerHTML = ICONS.settings;
    mSettingsBtn.onclick = () => document.body.appendChild(SettingsModal());
    topRight.appendChild(mSettingsBtn);
    topbar.appendChild(topRight);

    mainCol.appendChild(topbar);

    // Mobile tab strip
    const tabStrip = document.createElement('nav');
    tabStrip.className = 'flex h-11 w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] bg-panel-bg/70 px-3 backdrop-blur-xl no-scrollbar lg:hidden';
    tabStrip.setAttribute('aria-label', 'Studio media navigation');
    NAV_ITEMS.forEach((item) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.dataset.page = item.page;
        tab.textContent = item.label();
        tab.className = 'h-8 shrink-0 rounded-lg px-3 text-xs font-semibold text-secondary transition-colors hover:bg-white/5 hover:text-white';
        tab.onclick = () => navigate(item.page);
        tabButtons.set(item.page, tab);
        tabStrip.appendChild(tab);
    });
    mainCol.appendChild(tabStrip);

    const contentArea = document.createElement('main');
    contentArea.id = 'content-area';
    contentArea.className = 'flex-1 relative w-full overflow-hidden flex flex-col app-ambient-bg';
    mainCol.appendChild(contentArea);

    root.appendChild(mainCol);

    // ---- Active-state sync ------------------------------------------------
    function setActive(page) {
        const item = NAV_ITEMS.find((i) => i.page === page);
        railButtons.forEach((btn, p) => {
            const on = p === page;
            btn.classList.toggle('text-primary', on);
            btn.classList.toggle('bg-primary/10', on);
            btn.classList.toggle('text-secondary', !on);
            btn.querySelector('[data-indicator]').style.opacity = on ? '1' : '0';
        });
        tabButtons.forEach((btn, p) => {
            const on = p === page;
            btn.classList.toggle('bg-white/10', on);
            btn.classList.toggle('text-white', on);
            btn.classList.toggle('text-secondary', !on);
        });
        if (item) {
            titleEl.innerHTML = `
                <span class="truncate font-display text-[15px] font-semibold tracking-wide text-white">${item.label()}</span>
                <span class="hidden truncate text-xs text-muted sm:inline">${APP_NAME}</span>
            `;
            document.title = `${item.label()} — ${APP_NAME}`;
        }
    }

    return { root, contentArea, setActive };
}
