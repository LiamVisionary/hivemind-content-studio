// Navigation model — page keys are a wire contract (?page=, 'navigate' events).
import { getLang, t } from '../lib/i18n.js';

const zh = () => getLang() === 'zh-CN';

export const NAV_SECTIONS = [
  {
    label: () => (zh() ? '工作室' : 'Studios'),
    items: [
      { page: 'image', icon: 'image', label: () => t('nav.image') },
      { page: 'video', icon: 'video', label: () => t('nav.video') },
      { page: 'sprite', icon: 'grid', label: () => (zh() ? '精灵图' : 'Sprite') },
      { page: 'story', icon: 'persona', label: () => (zh() ? '故事' : 'Story') },
      { page: 'lipsync', icon: 'mic', label: () => t('nav.lipsync') },
      { page: 'cinema', icon: 'clapper', label: () => t('nav.cinema') },
      { page: 'canvas', icon: 'nodes', label: () => (zh() ? '画布' : 'Canvas') },
    ],
  },
  {
    label: () => (zh() ? '生产' : 'Produce'),
    items: [
      { page: 'planner', icon: 'sparkles', label: () => (zh() ? '规划器' : 'Planner') },
      { page: 'runs', icon: 'stack', label: () => (zh() ? '运行' : 'Runs') },
      { page: 'history', icon: 'clock', label: () => (zh() ? '历史' : 'History') },
    ],
  },
  {
    label: () => (zh() ? '系统' : 'System'),
    items: [
      { page: 'models', icon: 'database', label: () => (zh() ? '模型' : 'Models') },
      { page: 'telemetry', icon: 'pulse', label: () => (zh() ? '遥测' : 'Telemetry') },
      { page: 'providers', icon: 'plug', label: () => (zh() ? '服务商' : 'Providers') },
      { page: 'passbook', icon: 'key', label: () => 'PassBook' },
      { page: 'machines', icon: 'cpu', label: () => (zh() ? 'GPU 机器' : 'Machines') },
      { page: 'mcp-cli', icon: 'terminal', label: () => t('nav.mcpcli') },
    ],
  },
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items);
export const APP_NAME = 'Hivemind Content Studio';

// Studio pages rebuild on every navigation; hub pages persist once mounted.
export const STUDIO_PAGES = ['image', 'video', 'sprite', 'story', 'cinema', 'lipsync', 'mcp-cli'];
export const HUB_PAGES = {
  planner: 'create',
  canvas: 'canvas',
  models: 'models',
  runs: 'runs',
  history: 'history',
  telemetry: 'telemetry',
  providers: 'providers',
  machines: 'machines',
  passbook: 'passbook',
};

export function isKnownPage(page) {
  return STUDIO_PAGES.includes(page) || Boolean(HUB_PAGES[page]);
}
