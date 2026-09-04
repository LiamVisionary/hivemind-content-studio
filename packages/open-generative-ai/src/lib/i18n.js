import { pref, setPrefs } from './prefs.js';

// The stored choice moved into the one preferences document (lib/prefs.js),
// which migrates the old `og_lang` key on first load. Everything else about
// this module is unchanged: the choice is canonicalised, never overwritten
// with the shipping language, and LANGS_ENABLED is still the switch.

// The languages this build actually ships.
//
// zh-CN exists here as a half-translated dictionary: three studios, every
// dialog and most of the hub are English literals, so a Chinese-locale user was
// promised a translated app and got a bilingual one. Until the ~1,000 inline
// ternaries move into this key table, one honest language beats two dishonest
// ones — so the dictionary, the `zh()` branches and the stored choice all stay
// where they are and THIS LIST is the switch. Add 'zh-CN' back and the app
// speaks Chinese again, on whatever the person last chose.
export const LANGS_ENABLED = ['en'];

/** The BCP-47 tag `raw` names, whether or not this build ships it. */
export function canonicalLang(raw) {
    if (!raw) return 'en';
    const lower = String(raw).toLowerCase();
    if (lower === 'zh' || lower.startsWith('zh-') || lower.startsWith('zh_')) return 'zh-CN';
    return lower === 'zh-cn' ? 'zh-CN' : 'en';
}

/** The language to RENDER for `raw`: its canonical tag, clamped to what ships. */
export function normalizeLang(raw) {
    const canonical = canonicalLang(raw);
    return LANGS_ENABLED.includes(canonical) ? canonical : LANGS_ENABLED[0];
}

/** True when the interface is running in Chinese (never, while zh-CN is off). */
export const zh = () => getLang() === 'zh-CN';

// A stored choice is canonicalised (legacy `zh` → `zh-CN`) but never rewritten
// to the shipping language: overwriting it would silently discard the language
// the person picked, and re-enabling zh-CN would land them in English with no
// way to tell it had ever been set.
function rememberCanonical(raw) {
    const canonical = canonicalLang(raw);
    if (canonical !== raw) setPrefs({ lang: canonical });
    return normalizeLang(canonical);
}

/** Detect browser locale on first visit; migrates stored `zh` → `zh-CN`. */
export function initLocale() {
    const stored = pref('lang');
    if (stored) return rememberCanonical(stored);
    const detected = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const canonical = canonicalLang(detected);
    setPrefs({ lang: canonical });
    return normalizeLang(canonical);
}

export function getLang() {
    const stored = pref('lang');
    if (!stored) return initLocale();
    return rememberCanonical(stored);
}

// The <html lang> attribute drives font fallback, hyphenation, spellcheck and
// screen-reader voice; index.html bakes "en", so every language change (and the
// boot read in main.jsx) has to mirror the stored choice onto the document.
export function applyDocumentLang(lang = getLang()) {
    if (typeof document === 'undefined') return;
    try { document.documentElement.lang = normalizeLang(lang) === 'zh-CN' ? 'zh-CN' : 'en'; } catch { /* non-critical */ }
}

// The CHOICE is stored (canonical), the RENDERED language is what ships — so
// picking a language this build does not carry yet is recorded rather than
// thrown away. Callers should pass { reload: false }: useLang() re-renders on
// the 'og_lang_change' event, so nothing on screen has to be torn down.
export function setLang(lang, { reload = true } = {}) {
    const chosen = canonicalLang(lang);
    const normalized = normalizeLang(chosen);
    setPrefs({ lang: chosen });
    applyDocumentLang(normalized);
    if (reload && typeof location !== 'undefined') {
        location.reload();
    } else if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('og_lang_change', { detail: normalized }));
    }
}

function dictFor(lang) {
    const key = normalizeLang(lang);
    if (key === 'zh-CN') return translations['zh-CN'] || translations.zh;
    return translations.en;
}

const translations = {
    en: {
        // Navigation
        'nav.image': 'Image',
        'nav.video': 'Video',
        'nav.lipsync': 'Lip sync',
        'nav.mcpcli': 'Agents & API',
        'nav.settings': 'Settings',

        // Common
        'common.generate': 'Generate',
        'common.clearReferences': 'Clear',
        'common.startFresh': 'Start fresh',
        'common.generating': 'Generating…',
        'common.download': 'Download',
        'common.cancel': 'Cancel',
        'common.save': 'Save',
        'common.history': 'History',
        'common.less': 'Less',
        'common.searchModels': 'Search models...',
        'common.retry': 'Retry',
        'common.noResults': 'No local models match',
        'common.regenerate': 'Regenerate',
        'common.backToSetup': 'Back to setup',
        'common.useInGenerator': 'Use in generator',
        'common.randomize': 'Randomize',
        'common.pingWhenComplete': 'Ping when complete',

        // Settings Modal
        'settings.title': 'Settings',
        'settings.apiKey': 'API key',
        'settings.muapiKeyLabel': 'MUAPI API Key',
        'settings.keyPlaceholder': 'Enter your MUAPI API key...',
        'settings.keyNote': 'Kept in this browser and sent only to api.muapi.ai.',
        'settings.keyOnMachine': 'Key on this machine',
        'settings.keyOnMachineNote': 'Cloud generations run through this machine’s shared credential store; the key never enters this browser.',
        'settings.manageKeys': 'Manage in PassBook',
        'settings.invalidKey': 'Please enter a valid API key.',

        // Auth Modal
        'auth.title': 'Connect your cloud account',
        'auth.subtitle': 'Cloud models run on MUAPI, on your own account. Create an access key there, then paste the key value here to continue.',
        'auth.keyLabel': 'MUAPI access key',
        'auth.keyPlaceholder': 'Paste your access key value...',
        'auth.keyNote': 'Do not enter the key name or label; paste the generated key value from MUAPI.',
        'auth.storedOnMachine': 'Saved to this machine’s shared store — every Hive app here can use it, and it never stays in this browser.',
        'auth.storedInBrowser': 'Kept in this browser and sent only to api.muapi.ai.',
        'auth.saving': 'Saving…',
        'auth.initBtn': 'Save and continue',
        'auth.createKey': 'Create or copy a MUAPI access key',

        // Image Studio
        'image.placeholder': 'Describe the image you want to create',
        'image.placeholderTransform': 'Describe how to transform this image (optional)',
        'image.generateTooltip': 'Generate AI image from prompt',
        'image.multiImageNote': 'images selected — describe the transformation (optional)',
        'ar.square': 'Square',
        'ar.portrait': 'Portrait',
        'ar.landscape': 'Landscape',
        'ar.wide': 'Wide',
        'ar.tall': 'Tall',
        'ar.cinema': 'Cinema',
        'ar.custom': 'Custom',
        'image.qualityTooltip': 'Set output quality',
        'image.generatingLocally': 'Generating locally...',
        'image.quickStarters': 'Quick starters',
        'image.promptEnhancer': 'Prompt enhancer',
        'image.basePromptPlaceholder': 'Enter base prompt...',
        'image.enhancementTags': 'Enhancement tags',
        'image.enhancedPrompt': 'Enhanced prompt',
        'image.enhancedPlaceholder': 'Your enhanced prompt will appear here...',
        'image.advancedOptions': 'Advanced',
        'image.stylePreset': 'Style preset',
        'image.negPromptLabel': 'Negative prompt',
        'image.negPromptPlaceholder': 'What to exclude from the image (e.g., blurry, distorted, watermark)',
        'image.negPromptNeedsGuidance': 'Not doing anything right now — raise Guidance above 1 for this to take effect (at 1 the sampler skips the negative pass).',
        'image.negPromptUnsupported': (name) => `${name} ignores negative prompts — this workflow never wires one, so saved text is not sent.`,
        'image.guidanceScale': 'Guidance scale',
        'image.steps': 'Steps',
        'image.seed': 'Seed',
        'image.seedPlaceholder': '-1 for random',
        'image.width': 'Width',
        'image.height': 'Height',
        'image.widthPlaceholder': 'Auto',
        'image.heightPlaceholder': 'Auto',

        // Video Studio
        'video.placeholder': 'Describe the video you want to create',
        'video.generateTooltip': 'Generate AI video',
        'video.history': 'History',
        'video.regenerate': 'Regenerate',
        'video.download': 'Download',
        'video.extend': 'Extend',
        'video.new': 'New',
        'video.backToSetup': 'Back to setup',
        'video.progressTitle': 'Creating your video',
        'video.progress.preparing': 'Preparing generation',
        'video.progress.loading': 'Loading model',
        'video.progress.queued': 'Queued with provider',
        'video.progress.rendering': 'Rendering frames',
        'video.progress.finishing': 'Preparing playback',
        'video.progress.inProgress': 'In progress',
        'video.progress.elapsed': 'Elapsed',
        // Real sampler counters off the executing backend, not an estimate.
        'video.progress.step': (step, total) => `Step ${step} of ${total}`,

        // Lip Sync Studio
        'lipsync.input': 'Input',
        'lipsync.portraitImage': 'Portrait image',
        'lipsync.video': 'Video',
        'lipsync.promptPlaceholder': 'Optional: describe the talking style or motion...',
        'lipsync.regenerate': 'Regenerate',
        'lipsync.download': 'Download',
        'lipsync.new': 'New',
        'lipsync.history': 'History',
        'lipsync.noAudioAlert': 'Please upload an audio file first.',
        'lipsync.noImageAlert': 'Please upload a portrait image first.',
        'lipsync.noVideoAlert': 'Please upload a source video first.',

        // Local Model Manager
        'localModels.title': 'Local models',
        'localModels.webOnly': 'Local models are managed by the desktop app.',
        'localModels.inferenceEngine': 'Inference engine',
        'localModels.checking': 'Checking...',
        'localModels.installed': 'Installed and ready',
        'localModels.notInstalled': 'Not installed — required for local generation',
        'localModels.installEngine': 'Install engine',
        'localModels.downloading': 'Downloading...',
        'localModels.extracting': 'Extracting...',
        'localModels.storedIn': 'Stored in',
        'localModels.storedDefault': 'Stored in your app data folder',
        'localModels.checkingStorage': 'Checking storage...',
        'localModels.engineNotAnswering': 'The local engine is starting — it has not answered yet.',
        'localModels.loading': 'Loading...',
        'localModels.featured': 'Featured',
        'localModels.download': 'Download',
        'localModels.requiredComponents': 'Required components',
        'localModels.ready': 'Ready',
        'localModels.available': 'Available',
        'localModels.offline': 'Unavailable',
        'localModels.starting': 'Starting...',
        'localModels.complete': 'Complete!',
        'localModels.preparing': 'Preparing...',
        'localModels.get': 'Get',
        'localModels.notConfigured': 'Not configured',
        'localModels.notConfiguredNote': 'Not configured (Wan2GP models will appear offline)',
        'localModels.probing': 'Probing...',
        'localModels.deleteConfirm': (name) => `Delete "${name}"? You'll need to re-download it to use it again.`,

        // Web shell

        // MCP & CLI page
    },
    zh: {
        // Navigation
        'nav.image': '图像',
        'nav.video': '视频',
        'nav.lipsync': '唇语同步',
        'nav.mcpcli': '代理与 API',
        'nav.settings': '设置',

        // Common
        'common.generate': '生成',
        'common.clearReferences': '清除',
        'common.startFresh': '重新开始',
        'common.generating': '生成中…',
        'common.download': '下载',
        'common.cancel': '取消',
        'common.save': '保存',
        'common.history': '历史记录',
        'common.less': '收起',
        'common.searchModels': '搜索模型...',
        'common.retry': '重试',
        'common.noResults': '未找到本地模型',
        'common.regenerate': '重新生成',
        'common.backToSetup': '返回设置',
        'common.useInGenerator': '用于生成器',
        'common.randomize': '随机',
        'common.pingWhenComplete': '完成时提示音',

        // Settings Modal
        'settings.title': '设置',
        'settings.apiKey': 'API 密钥',
        'settings.muapiKeyLabel': 'MUAPI API 密钥',
        'settings.keyPlaceholder': '输入您的 MUAPI API 密钥...',
        'settings.keyNote': '保存在此浏览器中，仅发送到 api.muapi.ai。',
        'settings.keyOnMachine': '密钥已在本机',
        'settings.keyOnMachineNote': '云端生成通过本机的共享凭据库运行；密钥不会进入此浏览器。',
        'settings.manageKeys': '在 PassBook 中管理',
        'settings.invalidKey': '请输入有效的 API 密钥。',

        // Auth Modal
        'auth.title': '连接您的云端账户',
        'auth.subtitle': '云端模型在 MUAPI 上以您自己的账户运行。在那里创建一个访问密钥，然后将密钥值粘贴到这里继续。',
        'auth.keyLabel': 'MUAPI 访问密钥',
        'auth.keyPlaceholder': '粘贴您的访问密钥值...',
        'auth.keyNote': '请不要输入密钥名称或标签；粘贴从 MUAPI 生成的密钥值。',
        'auth.storedOnMachine': '已保存到本机的共享凭据库 — 本机上的每个 Hive 应用都可使用，且不会留在此浏览器中。',
        'auth.storedInBrowser': '保存在此浏览器中，仅发送到 api.muapi.ai。',
        'auth.saving': '保存中…',
        'auth.initBtn': '保存并继续',
        'auth.createKey': '创建或复制 MUAPI 访问密钥',

        // Image Studio
        'image.placeholder': '描述您想创建的图像',
        'image.placeholderTransform': '描述您想如何转换此图像（可选）',
        'image.generateTooltip': '根据提示词生成 AI 图像',
        'image.multiImageNote': '张图片已选择——描述要做的变化（可选）',
        'ar.square': '方形',
        'ar.portrait': '竖版',
        'ar.landscape': '横版',
        'ar.wide': '宽屏',
        'ar.tall': '竖屏',
        'ar.cinema': '影院宽幅',
        'ar.custom': '自定义',
        'image.qualityTooltip': '设置输出质量',
        'image.generatingLocally': '本地生成中...',
        'image.quickStarters': '快速启动',
        'image.promptEnhancer': '提示词增强器',
        'image.basePromptPlaceholder': '输入基础提示词...',
        'image.enhancementTags': '增强标签',
        'image.enhancedPrompt': '增强后的提示词',
        'image.enhancedPlaceholder': '增强后的提示词将显示在这里...',
        'image.advancedOptions': '高级选项',
        'image.stylePreset': '风格预设',
        'image.negPromptLabel': '反向提示词',
        'image.negPromptPlaceholder': '图像中要排除的内容（如：模糊、失真、水印）',
        'image.negPromptNeedsGuidance': '引导系数为 1 时无效——采样器会跳过反向通道。调高引导系数后才会生效。',
        'image.negPromptUnsupported': (name) => `${name} 不支持反向提示词——该工作流没有接入反向编码，保存的文本不会发送。`,
        'image.guidanceScale': '引导系数',
        'image.steps': '步数',
        'image.seed': '随机种子',
        'image.seedPlaceholder': '-1 表示随机',
        'image.width': '宽度',
        'image.height': '高度',
        'image.widthPlaceholder': '自动',
        'image.heightPlaceholder': '自动',

        // Video Studio
        'video.placeholder': '描述您想创建的视频',
        'video.generateTooltip': '生成 AI 视频',
        'video.history': '历史记录',
        'video.regenerate': '重新生成',
        'video.download': '下载',
        'video.extend': '延伸',
        'video.new': '新建',
        'video.backToSetup': '返回设置',
        'video.progressTitle': '正在创建视频',
        'video.progress.preparing': '正在准备生成',
        'video.progress.loading': '正在加载模型',
        'video.progress.queued': '已加入提供商队列',
        'video.progress.rendering': '正在渲染画面',
        'video.progress.finishing': '正在准备播放',
        'video.progress.inProgress': '进行中',
        'video.progress.elapsed': '已用时间',
        'video.progress.step': (step, total) => `第 ${step} / ${total} 步`,

        // Lip Sync Studio
        'lipsync.input': '输入',
        'lipsync.portraitImage': '人像图',
        'lipsync.video': '视频',
        'lipsync.promptPlaceholder': '可选：描述说话风格或动作...',
        'lipsync.regenerate': '重新生成',
        'lipsync.download': '下载',
        'lipsync.new': '新建',
        'lipsync.history': '历史记录',
        'lipsync.noAudioAlert': '请先上传音频文件。',
        'lipsync.noImageAlert': '请先上传人像图片。',
        'lipsync.noVideoAlert': '请先上传源视频。',

        // Local Model Manager
        'localModels.title': '本地模型',
        'localModels.webOnly': '本地模型由桌面应用管理。',
        'localModels.inferenceEngine': '推理引擎',
        'localModels.checking': '检查中...',
        'localModels.installed': '已安装，可以使用',
        'localModels.notInstalled': '未安装 — 本地生成所必需',
        'localModels.installEngine': '安装引擎',
        'localModels.downloading': '下载中...',
        'localModels.extracting': '解压中...',
        'localModels.storedIn': '存储于',
        'localModels.storedDefault': '存储在应用数据文件夹中',
        'localModels.checkingStorage': '检查存储...',
        'localModels.engineNotAnswering': '本地引擎正在启动——尚未响应。',
        'localModels.loading': '加载中...',
        'localModels.featured': '推荐',
        'localModels.download': '下载',
        'localModels.requiredComponents': '所需组件',
        'localModels.ready': '已就绪',
        'localModels.available': '可用',
        'localModels.offline': '不可用',
        'localModels.starting': '启动中...',
        'localModels.complete': '完成！',
        'localModels.preparing': '准备中...',
        'localModels.get': '获取',
        'localModels.notConfigured': '未配置',
        'localModels.notConfiguredNote': '未配置（Wan2GP 模型将显示为离线）',
        'localModels.probing': '探测中...',
        'localModels.deleteConfirm': (name) => `删除"${name}"？您需要重新下载才能再次使用。`,

        // Web shell

        // MCP & CLI page
    },
};

translations['zh-CN'] = translations.zh;

export function t(key) {
    const lang = getLang();
    const dict = dictFor(lang);
    const val = dict[key] !== undefined ? dict[key] : (translations.en[key] !== undefined ? translations.en[key] : key);
    return typeof val === 'function' ? val : val;
}

export function tf(key, ...args) {
    const lang = getLang();
    const dict = dictFor(lang);
    const val = dict[key] !== undefined ? dict[key] : (translations.en[key] !== undefined ? translations.en[key] : key);
    return typeof val === 'function' ? val(...args) : val;
}

// Friendly display name for a "W:H" aspect-ratio string; distinctive shapes get
// their own name, everything else falls back to orientation.
const AR_NAME_KEYS = { '1:1': 'ar.square', '16:9': 'ar.wide', '9:16': 'ar.tall', '21:9': 'ar.cinema' };

export function aspectRatioName(ar) {
    const key = AR_NAME_KEYS[ar];
    if (key) return t(key);
    const [w, h] = String(ar).split(':').map(Number);
    if (!(w > 0) || !(h > 0)) return '';
    if (w === h) return t('ar.square');
    return w > h ? t('ar.landscape') : t('ar.portrait');
}
