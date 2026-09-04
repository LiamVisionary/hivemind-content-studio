import { pref, setPrefs } from './prefs.js';

// THE key table. One mechanism, one language.
//
// What used to be here was two mechanisms and neither covered the app: a
// 199-key dictionary, and ~1,400 inline `zh() ? '中文' : 'English'` ternaries
// spread over 77 files. The ternaries were the real cost — not because of
// translation, but because a string written inline in JSX is a string nobody
// can see beside its siblings, which is how one idea ended up phrased four ways
// in four studios ("Runs on" / "Runs at", "This Mac" / "This machine").
// The ternaries are gone; STRINGS below is the one place a phrase is decided.
//
// Adding a language means adding a second table beside STRINGS and putting its
// tag in LANGS_ENABLED — not re-editing 1,400 call sites. Nothing here is
// translated today, and that is deliberate: one honest language beats two
// dishonest ones. The stored choice still survives (lib/prefs.js), so a build
// that adds a table lands a person back on the language they last picked.

// The languages this build actually ships.
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
// thrown away. `og_lang_change` is what a second table would repaint on, so a
// caller that has one to switch to passes { reload: false }.
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

// The one table, ordered by the surface a person meets it on.
export const STRINGS = {
    // ---- The app itself -----------------------------------------------
    'app.name': 'Hivemind Content Studio',
    // Three words for the one thing the person installed — never a backend name.
    'app.status.starting': 'Starting',
    'app.status.notRunning': 'Not running',
    'app.running': 'The studio is running',
    'app.notRunning': 'The studio is not running',
    'app.reaching': 'Reaching the studio…',
    'app.offlineSentence': 'The studio’s local service is not answering, so nothing can generate. Start it again by running:',
    'app.statusTitle': (label) => `The studio: ${label}`,
    'app.refresh': 'Refresh',
    'app.refreshTitle': 'Refresh catalog, runs and history',
    'app.widenSidebar': 'Widen the sidebar',
    'app.collapseSidebar': 'Collapse to icons',
    'app.more': 'More',

    // ---- Navigation ------------------------------------------------------
    // Page keys are a wire contract; these are only what a person reads.
    'nav.create': 'Create',
    'nav.labs': 'Labs',
    // Activity is routable but not a rail row; it still has to name its tab.
    'nav.activity': 'Activity',
    'nav.produce': 'Produce',
    'nav.image': 'Image',
    'nav.story': 'Story',
    'nav.restore': 'Restore',
    'nav.sprite': 'Sprite',
    'nav.lipsync': 'Lip sync',
    'nav.planner': 'Planner',
    'nav.library': 'Library',
    'nav.productions': 'Productions',
    'nav.inspo': 'Inspo',
    'nav.models': 'Models',
    'nav.machines': 'Rented GPUs',
    'nav.providers': 'Providers',
    'nav.passbook': 'PassBook',
    'nav.canvas': 'Canvas',
    'nav.mcpcli': 'Agents & API',
    'nav.about': 'About',

    // ---- Words more than one surface says --------------------------------
    // A word that appears twice belongs here once. Two keys with the same value
    // is how "Retry now" and "Try again" ended up on the same press.
    'common.generate': 'Generate',
    'common.clearReferences': 'Clear',
    'common.startFresh': 'Start fresh',
    'common.generating': 'Generating…',
    'common.download': 'Download',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.history': 'History',
    'common.less': 'Less',
    'common.new': 'New',
    'common.ready': 'Ready',
    'common.advanced': 'Advanced',
    'common.auto': 'Auto',
    'common.video': 'Video',
    'common.settings': 'Settings',
    'common.searchModels': 'Search models...',
    'common.retry': 'Retry',
    'common.noResults': 'No local models match',
    'common.regenerate': 'Regenerate',
    'common.backToSetup': 'Back to setup',
    'common.useInGenerator': 'Use in generator',
    'common.randomize': 'Randomize',
    'common.pingWhenComplete': 'Ping when complete',
    // The two repairs that are NOT the same act: press the thing again, or ask
    // the machine again. "Retry now" was a third spelling of the first.
    'common.tryAgain': 'Try again',
    'common.checkAgain': 'Check again',
    'common.dismiss': 'Dismiss',
    'common.openModels': 'Open Models',
    'common.connectComfy': 'Connect ComfyUI',
    'common.switchToCloud': 'Switch to cloud',
    'common.connect': 'Connect',
    'common.detach': 'Detach',

    // ---- Where work runs -------------------------------------------------
    // ONE vocabulary for the three bills. The image/video picker said "This
    // Mac", the text producer said "This machine", the restore lanes said
    // "This computer", and the send-to menu had a fourth copy of the list.
    'place.thisMac': 'This Mac',
    'place.thisMacBlurb': 'Free, private, and as fast as the hardware — nothing leaves the machine.',
    'place.hivemindos': 'HivemindOS credits',
    'place.hivemindosBlurb': 'One balance of HivemindOS credits — the same one the HivemindOS app spends.',
    'place.accounts': 'Your accounts',
    'place.accountsBlurb': 'Billed by the provider to an account you already pay for. No HivemindOS credits spent.',
    'place.rentedGpu': 'Rented GPU',
    'sendTo.switchesTo': (model) => `switches to ${model}`,
    // The Restore studio's lanes, which used to be a fourth vocabulary of their
    // own ("This computer" / "Rented GPU" / "Hosted GPU").
    'restore.laneHostedGpu': 'Hosted GPU',
    'badge.free': 'Free',
    'badge.perHour': 'Per hour',
    'badge.perRender': 'Per render',

    // ---- The Runs-on control ---------------------------------------------
    'runOn.label': 'Runs on',
    'runOn.automatic': 'Automatic',
    'runOn.automaticPrefix': 'Automatic — ',
    'runOn.nowhere': 'Nowhere yet',
    'runOn.nothingRuns': 'No model here can run this yet',
    'runOn.freeStaysHere': 'free, stays here',
    'runOn.freeStaysOnThisMac': 'free, stays on this Mac',
    'runOn.onYourCredits': 'on your HivemindOS credits',

    // ---- Setup: the doors out of an empty Model section ------------------
    'setup.comfyNotConnected': 'ComfyUI is not connected.',
    'setup.comfyHint': 'Local models run on ComfyUI. Connect one — or use a cloud or rented model, which need no ComfyUI at all.',
    'setup.noImageModel': 'No image model installed yet.',
    'setup.noImageModelHint': 'Install one and it shows up here.',
    'setup.discovering': 'Looking at what this machine can run…',
    'setup.engineHint': 'It appears here as soon as it answers — or use the cloud for this one.',
    'setup.comfyAnswering': 'Answering',
    'setup.comfyNotAnswering': 'Not connected',
    'setup.comfyAttached': 'Attached',
    'setup.comfyLanes': 'Lanes',
    'setup.comfyLooking': 'Looking at this machine…',
    'setup.comfyAnsweringNow': 'Answering right now',
    'setup.comfyUseThis': 'Use this one',
    'setup.comfyPasteAddress': 'Or paste the address',
    'setup.comfyAddressHint': 'The address in ComfyUI’s own window — usually http://127.0.0.1:8188, or http://127.0.0.1:8000 for ComfyUI Desktop.',
    'setup.comfyBlurb': 'ComfyUI is optional. Cloud and rented models work without it; connect one to use the local lanes. This studio only reads — it never changes a ComfyUI you installed yourself.',
    'setup.comfyFoundHere': 'Found on this machine',
    'setup.comfyNoneFound': 'No ComfyUI found on this machine. ',
    'setup.comfyHowToInstall': 'How to install it',
    'setup.comfyThenComeBack': ' — then come back and connect it here.',
    'setup.comfyNoAnswer': 'That address did not answer',
    'setup.comfyRefused': 'Could not connect to that address.',
    'setup.comfyConnected': (target) => `Connected to ${target}. Local models are available again.`,

    // ---- What a composer offers, in every studio -------------------------
    // The Image and Video composers each grew their own spelling of the same
    // five chips; these are the shared ones.
    'composer.attach': 'Attach',
    'composer.clearReferencesTitle': 'Remove every attached reference',
    'composer.starters': 'Starters',
    'composer.startersTitle': 'Quick starters, the UGC block, and your saved prompts',
    'composer.improve': 'Improve',
    'composer.improveTitle': 'Refine the prompt, or add style tags',
    'composer.improveDisabled': 'Type an idea below first — the helper refines what is in the box',
    'composer.dismissHelper': 'Dismiss prompt helper',
    'composer.etaTitle': 'Estimated from your own past runs at these settings',
    'composer.cancelTitle': 'Cancel the current generation and reset',
    'composer.refine': 'Refine',
    'composer.camera': 'Camera',
    'composer.refineTitle': "Rewrite what is in the box with the prompt helper — it knows this model's prompting guide, the cast, the lane and the clip length",

    // ---- Failures: the sentence, and the button that repairs it ----------
    'failure.generic': 'That did not work',
    'failure.genericNamed': (operation) => `${operation} failed`,
    'failure.notEnoughMemory': 'Not enough memory for this size',
    'failure.lowerResolution': 'Lower resolution',
    'failure.localEngineDown': 'The local engine is not running',
    'failure.studioNotAnswering': 'The studio is not answering',
    'failure.addKey': 'Add key',
    'failure.signIn': 'Sign in',
    'failure.openHivemindos': 'Open HivemindOS',
    'failure.addCredits': 'Add credits',
    'failure.connectAccount': 'Connect account',
    'failure.connectProvider': 'Connect an account',
    'failure.finishSignIn': 'Finish the sign-in in the tab that opened, then press Try again.',
    'failure.finishCheckout': 'Finish the checkout in the tab that opened, then press Try again.',

    // ---- Restore: a stopped render, and what continues it ----------------
    'restore.stopped': 'That render stopped.',
    'restore.stoppedResume': 'Resume picks up at the first unfinished chunk.',
    'restore.stoppedDetail': 'Resume continues from the first unfinished chunk; the details below say what the machine reported.',
    'restore.cancelled': 'Stopped. Every finished chunk is still here.',
    'restore.cancelledResume': 'Resume continues from the next one — nothing already rendered is repeated.',
    'restore.oom': 'That machine ran out of memory on this chunk.',
    'restore.oomFix': 'Lower the temporal batch or the output size in Advanced, then resume — the finished chunks are kept.',
    'restore.projectGone': 'That project is no longer on this machine.',
    'restore.projectGoneFix': 'Working files are cleared once they age out; any master it produced is still in History.',
    'restore.sourceGone': "This project's source clip is no longer on this machine.",
    'restore.sourceGoneFix': 'Load the original clip again and start it — the finished chunks are still reused.',
    'restore.weightsFailed': 'That machine could not download the model weights.',
    'restore.weightsFailedFix': 'Check the connection and resume, or pick a model this machine already has.',
    'restore.modelMissing': 'That machine does not have this restore model.',
    'restore.modelMissingFix': 'Pick another model, or another machine, and resume.',
    'restore.spendReached': 'This render reached the amount you approved.',
    'restore.spendReachedFix': 'Resume quotes the rest at today’s price and asks you to approve it.',
    'restore.rentalGone': 'The rented machine is no longer there.',
    'restore.rentalGoneFix': 'Attach it again on the Machines page, or switch the machine and resume.',
    'restore.unreachable': 'That machine stopped answering.',
    'restore.unreachableFix': 'Check it is still running, then resume — the finished chunks are kept.',
    'restore.tooLarge': (size, ceiling) => `That clip is ${size} and this machine takes up to ${ceiling}. Trim it, or restore it in two halves.`,
    'restore.retention': (days) => `Intermediates are kept ${days} days, then cleared — any finished master stays in History.`,

    // Settings Modal
    'settings.apiKey': 'API key',
    'settings.muapiKeyLabel': 'MUAPI API Key',
    'settings.keyPlaceholder': 'Enter your MUAPI API key...',
    'settings.keyOnMachine': 'Key on this machine',
    'settings.keyInBrowser': 'Kept in this browser and sent only to api.muapi.ai.',
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
    'image.promptHelper': 'Prompt helper',
    'image.basePromptPlaceholder': 'Enter base prompt...',
    'image.enhancementTags': 'Enhancement tags',
    'image.enhancedPrompt': 'Enhanced prompt',
    'image.enhancedPlaceholder': 'Your enhanced prompt will appear here...',
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

    // Video Studio
    'video.placeholder': 'Describe the video you want to create',
    'video.generateTooltip': 'Generate AI video',
    'video.generateOffline': 'The studio is not running — start it again to generate.',
    'video.extend': 'Extend',
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
    'lipsync.promptPlaceholder': 'Optional: describe the talking style or motion...',
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
    'localModels.engineStarting': 'The local engine is starting — it has not answered yet.',
    'localModels.loading': 'Loading...',
    'localModels.featured': 'Featured',
    'localModels.requiredComponents': 'Required components',
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

};

/** The string `key` names. An unknown key renders as its own name, which is why
 *  tests/keyTable.test.js checks every key a surface asks for. */
export function t(key) {
    const value = STRINGS[key];
    return value === undefined ? key : value;
}

/** The same, for the few keys whose value is a function of its arguments. */
export function tf(key, ...args) {
    const value = STRINGS[key];
    if (value === undefined) return key;
    return typeof value === 'function' ? value(...args) : value;
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
