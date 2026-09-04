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
//
// HOW FAR IT REACHES. The first pass took the first-run and primary-control
// surfaces. This one worked outward in the order a person meets them: every
// dialog, the hub views (including the Models page's four), and the Image and
// Restore studios' advanced panels. tests/keyTable.test.js COVERED is the
// authoritative list and refuses a bare literal on any file named there.
//
// Still inline, and said plainly rather than implied: the studio stages and
// composers under studios/*/, the two deepest operator consoles
// (hub/views/GpuMachinesView.jsx, hub/views/PlannerView.jsx), the shared
// components/ and ui/ widgets, and the sentences hub/hubData.js and the lib/
// helpers compose. Moving one of those onto keys means adding it to COVERED —
// the tests then hold it there.

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

// Fragments that a longer string is BUILT from. A phrase quoted inside another
// sentence is still a phrase, and the whole point of the table is that it is
// decided once: "Try again" was written on a button and then typed again, by
// hand, inside the two sentences that tell you to press it. Change the const
// and the button and both sentences move together.
const TRY_AGAIN = 'Try again';
const AUTOMATIC = 'Automatic';
const STUDIO_NOT_RUNNING = 'The studio is not running';
const HIVEMINDOS_CREDITS = 'HivemindOS credits';
const NOT_CONNECTED = 'Not connected';
const DID_NOT_WORK = 'That did not work';
const ENCRYPTED_AT_REST = 'Encrypted at rest';
const BASE_MODEL = 'Base model';

// The one table, ordered by the surface a person meets it on.
export const STRINGS = {
    // ---- The app itself -----------------------------------------------
    'app.name': 'Hivemind Content Studio',
    // Three words for the one thing the person installed — never a backend name.
    'app.status.starting': 'Starting',
    'app.status.notRunning': 'Not running',
    'app.running': 'The studio is running',
    'app.notRunning': STUDIO_NOT_RUNNING,
    'app.reaching': 'Reaching the studio…',
    'app.offlineSentence': 'The studio’s local service is not answering, so nothing can generate.',
    // The remedy, in the two shapes it can take. The desktop shell supervises
    // the local services and can restart them; a browser tab cannot, and says
    // so rather than printing a command only this checkout could run.
    'app.restartStudio': 'Restart studio',
    'app.restartOutsideShell': 'This page cannot start it — start the studio the way you started it before, then press Try again.',
    'app.restartFailed': 'The studio could not restart itself. Quit the app and open it again.',
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
    'common.tryAgain': TRY_AGAIN,
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
    'place.hivemindos': HIVEMINDOS_CREDITS,
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
    'runOn.automatic': AUTOMATIC,
    'runOn.automaticPrefix': `${AUTOMATIC} — `,
    'runOn.nowhere': 'Nowhere yet',
    'runOn.nothingRuns': 'No model here can run this yet',
    'runOn.freeStaysHere': 'free, stays here',
    'runOn.onYourCredits': `on your ${HIVEMINDOS_CREDITS}`,
    // Said when a row is blocked on a credential and nothing prose-shaped was
    // supplied. Never the credential's variable name — see credentialReason.
    'runOn.needsCredential': 'This account needs a key before it can run here.',

    // ---- Setup: the doors out of an empty Model section ------------------
    'setup.comfyNotConnected': 'ComfyUI is not connected.',
    'setup.comfyHint': 'Local models run on ComfyUI. Connect one — or use a cloud or rented model, which need no ComfyUI at all.',
    'setup.noImageModel': 'No image model installed yet.',
    'setup.noImageModelHint': 'Install one and it shows up here.',
    'setup.discovering': 'Looking at what this machine can run…',
    'setup.engineHint': 'It appears here as soon as it answers — or use the cloud for this one.',
    'setup.comfyAnswering': 'Answering',
    'setup.comfyNotAnswering': NOT_CONNECTED,
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
    'failure.generic': DID_NOT_WORK,
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
    'failure.finishSignIn': `Finish the sign-in in the tab that opened, then press ${TRY_AGAIN}.`,
    'failure.finishCheckout': `Finish the checkout in the tab that opened, then press ${TRY_AGAIN}.`,
    'failure.signInFailed': 'Could not start the sign-in.',
    'failure.openMachines': 'Open Machines',

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
    'restore.rentalGoneFix': 'Attach it again on the Rented GPUs page, or switch the machine and resume.',
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
    'video.generateOffline': `${STUDIO_NOT_RUNNING} — start it again to generate.`,
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


    // ---- Dialogs ---------------------------------------------------------
    // Everything a modal says. A dialog is where a person is stopped and asked
    // something, so its words are the ones that have to be exact — and they
    // were the ones written furthest from every other copy of themselves.
    'common.close': 'Close',
    'civitai.downloadTitle': 'Download from Civitai',
    'civitai.modelUrl': 'Civitai model URL',
    'civitai.modelUrlHint': 'Any civitai.com model or model-version link — LoRAs, checkpoints, VAEs and the rest are filed by type.',
    'civitai.urlPlaceholder': 'https://civitai.com/models/…',
    'civitai.downloadProgress': 'Download progress',
    'civitai.keepsRunning': 'You can close this window — the download keeps running in the background, and its progress and cancel button live on the LoRA card until it finishes.',

    'auth.opensInTab': 'Opens muapi.ai in a new tab',

    'privacy.twoKeys': 'Sealed to your key vs. to this Mac',
    'privacy.twoKeysBlurb': 'Both happen on this machine, but they are locked with different keys — which is what decides what another workspace can see.',
    'privacy.sealedToYourKey': 'Sealed to your key',
    'privacy.yourKeyLibrary': 'Your library: generated images and clips, uploaded references, saved personas.',
    'privacy.yourKeyDrafts': 'Drafts and saved projects held in your vault.',
    'privacy.yourKeyOnlyYou': 'Opened only by your passphrase or passkey — another workspace on this Mac cannot read them.',
    'privacy.macKey': 'Encrypted with this Mac’s key',
    'privacy.macKeyRunFiles': 'Run files: the brief, the script, the prompt lists a run writes as it works.',
    'privacy.macKeyKeychain': 'The key is in this Mac’s keychain, so any program running as you can read them.',
    'privacy.macKeyOwnerSees': 'The studio owner can see runs from every workspace, not only their own.',
    'privacy.neitherLeaves': 'Neither leaves this computer in plain text. Only what you explicitly send to a cloud model does.',
    'privacy.workspaces': 'Workspaces',
    'privacy.workspacesBlurb': 'Each workspace has its own library and its own key. A new one is created on the sign-in screen, so this one is locked first.',
    'privacy.addWorkspace': 'Add a workspace',

    'vault.workspacePassword': 'Workspace password',
    'vault.workspacePasswordBlurb': 'Your password opens this workspace and decrypts its library. Changing it re-seals one copy of the key, so nothing is re-encrypted and any passkey — or this browser’s remembered unlock — keeps working.',
    'vault.currentPassword': 'Current password',
    'vault.newPassword': 'New password',
    'vault.confirmPassword': 'Type the new one again',
    'vault.changePassword': 'Change password',
    'vault.recoveryKey': 'Recovery key',
    'vault.recoveryKeyBlurb': 'A recovery key is the only way back in if you forget your password — the server has never held your key and cannot reset it for you. Minting a new one retires the old key immediately and leaves everything you have made untouched.',
    'vault.recoveryShownOnce': 'The new key is shown once, and then only you have it.',
    'vault.showNewRecoveryKey': 'Show a new recovery key',

    // One word, two senses — the verb that opens "Run Wan2GP on a CUDA box"
    // and the noun in front of a run id. The table holds a WORD once, so both
    // read it from here rather than each keeping a copy to drift from.
    'common.run': 'Run',
    'common.test': 'Test',
    'common.delete': 'Delete',
    'localModels.enterUrlFirst': 'Enter a URL first',
    'localModels.reachable': (version) => `Reachable · Gradio ${version}`,
    'localModels.unreachable': (detail) => `Unreachable: ${detail}`,
    'localModels.probeFailed': 'Could not probe that server',
    'localModels.saveUrlFailed': 'Could not save that URL',
    'localModels.wan2gpTitle': 'Wan2GP server (optional)',
    'localModels.wan2gpName': 'Wan2GP',
    'localModels.wan2gpOnCuda': 'on a CUDA box (',
    'localModels.wan2gpUnlocks': ') to unlock video models from this UI.',
    'localModels.serverUrl': 'Server URL',
    'localModels.urlPlaceholder': 'http://127.0.0.1:7860',
    'localModels.modelAction': 'That model action',
    'localModels.startHere': 'Start here',
    'localModels.tryIt': 'Try it',
    'localModels.tryItTitle': 'Open the Image studio on this model',
    'localModels.tryItNeedsAux': 'Get the required components first',
    'localModels.deleteLabel': (name) => `Delete ${name}`,
    'localModels.auxTextEncoder': 'Qwen3-4B Text Encoder (2.4 GB)',
    'localModels.auxVae': 'FLUX VAE (335 MB)',
    'localModels.deleteTitle': 'Delete model?',
    'localModels.listFailed': "Couldn't list local models",
    'localModels.noneYet': 'No local models available yet',
    'localModels.noneYetHint': 'Install the inference engine and the downloadable models will be listed here.',

    'clipPrep.title': 'Prepare clip',
    'clipPrep.prepareFailed': 'Could not prepare that clip.',
    'clipPrep.readingClip': 'Reading clip…',
    'clipPrep.useAsReference': 'Use as reference',
    'clipPrep.readFailed': "Couldn't read that clip",
    'clipPrep.decrypting': 'Decrypting and reading the clip on this device…',
    'clipPrep.trim': 'Trim',
    'clipPrep.in': 'In',
    'clipPrep.out': 'Out',
    'clipPrep.quality': 'Quality',
    'clipPrep.qualityHint': 'Smaller references generate faster',
    'clipPrep.crop': 'Crop',
    'clipPrep.cropHint': 'Centered, aspect preserved',
    // The budget readout. A <strong> sits inside the first sentence, so it is
    // held as the two halves the element leaves rather than as markup in a value.
    'clipPrep.budgetKeepsBefore': 'This',
    'clipPrep.budgetKeepsAfter': (reference, clip) => `reference keeps its own length — it costs ${reference} of motion budget and leaves the full ${clip} range open.`,
    'clipPrep.budgetAsLong': (shot) => `As long as the ${shot} shot: it spends the whole motion budget. Trim it below ${shot} to spend less.`,
    'clipPrep.budgetLonger': (shot) => `Longer than the ${shot} shot: it is trimmed to ${shot} on the way in. Trim it below ${shot} to spend less budget.`,
    'clipPrep.useCurrentFrameTitle': 'Saves the frame under the playhead as a start frame and closes this dialog — reopen Prepare to trim the clip as well',
    'clipPrep.useCurrentFrame': 'Use current frame',
    'clipPrep.storyboard': 'Storyboard',
    'clipPrep.dropAudio': 'Drop audio',
    'clipPrep.noAudio': '(none)',
    'clipPrep.useFrameAt': (at) => `Use the frame at ${at} as a start frame (closes this dialog)`,
    'clipPrep.frameAt': (at) => `Frame at ${at}`,
    'clipPrep.preparedHere': 'prepared on this device — nothing is uploaded until you apply it',

    'common.model': 'Model',
    'common.format': 'Format',
    'common.active': 'Active',
    'promptHelper.pickModelFirst': 'Pick a model first.',
    'promptHelper.writeBeforeRefine': 'Write a prompt before refining it.',
    'promptHelper.writeBeforeHelper': 'Write something in the composer before using the helper.',
    'promptHelper.sourceClip': 'source clip',
    'promptHelper.previousShot': 'previous shot',
    'promptHelper.startFrame': 'start frame',
    'promptHelper.watching': (what) => `Watching the ${what}…`,
    'promptHelper.readingStartFrame': 'Reading the start frame…',
    'promptHelper.refining': 'Refining your prompt…',
    'promptHelper.writingFrom': (what) => `Writing prompt from your ${what}…`,
    'promptHelper.writing': 'Writing prompt…',
    'promptHelper.freeingComfy': 'Freeing ComfyUI memory…',
    'promptHelper.unloading': 'Unloading…',
    'promptHelper.rewriteFromIdea': 'Rewrite from idea',
    'promptHelper.writePrompt': 'Write prompt',
    'promptHelper.refineTitle': "Rewrite this prompt into the model's perfect shape and fill in the craft details. The controls below steer how far it goes.",
    'promptHelper.useThisTitle': 'Put this prompt in the composer (⌘/Ctrl+Enter)',
    'promptHelper.noLlamaBefore': 'No',
    'promptHelper.noLlamaAfter': 'found on this machine. Install llama.cpp to use the prompt helper.',
    'promptHelper.getLlamaCpp': 'Get llama.cpp',
    'promptHelper.writingFor': 'Writing for:',
    'promptHelper.checking': 'checking…',
    'promptHelper.pickAModel': 'pick a model',
    'promptHelper.checkingRam': "Checking this machine's RAM and models…",
    'promptHelper.free': 'free',
    'promptHelper.ofTotal': (total) => `of ${total}`,
    'promptHelper.reclaimable': (bytes) => `+${bytes} reclaimable by unloading`,
    'promptHelper.heldByLmStudio': (count) => `${count} model${count > 1 ? 's' : ''} held by LM Studio — unload there to free that RAM`,
    'promptHelper.freed': (bytes) => `freed ${bytes}`,
    'promptHelper.freeComfyTitle': 'Asks ComfyUI to unload its models. The queue, the open workflow and cached node results are untouched.',
    'promptHelper.freeComfy': 'Free ComfyUI memory',
    'promptHelper.unloadOthers': 'Unload others first',
    'promptHelper.unloadOthersLabel': 'Unload other models before loading',
    'promptHelper.stopLocalHelper': 'Stop the local helper',
    'promptHelper.unloadModel': (name) => `Unload ${name}`,
    'promptHelper.filesUnusable': (count) => `${count} file${count > 1 ? 's' : ''} on disk cannot be used`,
    'promptHelper.currentPrompt': 'Current prompt',
    'promptHelper.suggestedPrompt': 'Suggested prompt',
    'promptHelper.linesChanged': (count) => `${count} line${count > 1 ? 's' : ''} changed`,
    'promptHelper.readYour': (what) => `read your ${what}`,
    'promptHelper.clipSeconds': (seconds) => `${seconds}s clip`,
    'promptHelper.guidanceIs': (label) => `Guidance: ${label}`,
    'promptHelper.composerHolds': 'This is what your composer holds now — edit it directly, hit Refine to knock it into shape, or rewrite it from your idea.',
    'promptHelper.refinementControls': 'Refinement controls',
    'promptHelper.detail': 'Detail',
    'promptHelper.keep': 'Keep',
    'promptHelper.addMore': 'Add more',
    'promptHelper.shots': 'Shots',
    'promptHelper.addShots': 'Add shots',
    'promptHelper.singleStill': 'Single still',
    'promptHelper.guidancePlaceholder': 'Steer it: focus more on…, add…, remove…, make … more subtle',
    'promptHelper.notesWin': 'Your notes win over the toggles. Refine keeps every fact and line of dialogue either way.',

    'inpaint.title': 'Replace head',
    'inpaint.tracked': 'Tracked',
    'inpaint.trackedFor': (price) => `Tracked — ${price}`,
    'inpaint.coverageFailed': 'Could not read frames for the coverage check.',
    'inpaint.trimmedToGrid': 'trimmed to H3’s frame grid',
    'inpaint.needsReferenceTitle': 'Attach a picture of the new head first — the workflow refuses a run without one.',
    'inpaint.useThisMask': 'Use this mask',
    // The warning sentence, in the pieces its two <em>s leave.
    'inpaint.needsReferenceA': 'Attach at least one reference picture of the new head. The mask says',
    'inpaint.needsReferenceWhere': 'where',
    'inpaint.needsReferenceB': '; the pictures say',
    'inpaint.needsReferenceWho': 'who',
    'inpaint.needsReferenceC': ', and the workflow refuses a run without one.',
    'inpaint.attachAPicture': 'Attach a picture',
    'inpaint.othersNotSent': 'While this is armed, your other motion and voice references are not sent. The movement and the voice both come from this clip — its soundtrack is kept untouched, which is what the new head lip-syncs to.',
    'inpaint.scrubTheClip': 'Scrub the clip',
    'inpaint.paintTheArea': 'Paint the area',
    'inpaint.trackWithSam3': 'Track with SAM3',
    'inpaint.paintBlurb': 'Paint over the head, generously. This one region applies to every frame, which is usually right — the model paints the head consistently on its own, and a loose area lets it place a differently-shaped head naturally. The only thing to get right is that the head stays inside it for the whole clip.',
    'inpaint.brushSize': (px) => `${px}px brush`,
    'inpaint.erase': 'Erase',
    'inpaint.checkCoverage': 'Check coverage',
    'inpaint.sam3Blurb': 'SAM3 follows the subject frame by frame inside the render. Use it when the shot moves so much that a single covering region would swallow most of the frame. The preview below runs on the frame you are scrubbed to — enough to confirm it is selecting the right thing.',
    'inpaint.whatToTrack': 'What to track',
    'inpaint.trackPlaceholder': 'head',
    'inpaint.detectionThreshold': 'Detection threshold',
    'inpaint.previewOnFrame': 'Preview on this frame',
    'inpaint.trackedRedo': 'Tracked · redo',
    'inpaint.trackWholeClip': (price) => `Track the whole clip · ${price}`,
    'inpaint.clipIsTracked': 'This clip is tracked. The mask travels with the run, so the render lane does not need SAM3 of its own.',
    'inpaint.laneTracksItself': 'Your render lane tracks this itself when it carries the SAM3 checkpoint — that costs nothing and is the default. Track it here instead when the lane has no SAM3, or to settle the mask before spending a render on it. The clip is uploaded to HivemindOS for this, and only for this.',
    'inpaint.previewUnavailable': 'Preview unavailable.',
    'inpaint.laneStillTracks': 'The render itself still tracks with SAM3 on the lane — only this preview needs SAM3 reachable from here.',
    'inpaint.framingAndCost': 'Framing and cost',
    'inpaint.windowBlurb': "The model renders a WINDOW around the masked subject, not the whole frame, and the window is resampled to the size below — that, times the clip's frames, is what the card's memory budget is spent on.",
    'inpaint.window': 'Window',
    'inpaint.windowSize': 'Window size',
    'inpaint.timesSubject': (factor) => `${factor}× the subject`,
    'inpaint.renderSize': 'Render size',
    'inpaint.megapixels': (mp) => `${mp} MP`,
    'inpaint.growTheMask': 'Grow the mask',
    'inpaint.growTheMaskHint': "The model needs room beyond the head's own outline.",
    'inpaint.pixels': (px) => `${px}px`,


    // ---- The hub's views -------------------------------------------------
    'canvas.kicker': 'Node workflow',
    'models.tabEngine': 'Engine',
    'common.installed': 'Installed',
    'models.tabDiscover': 'Discover',
    'models.catalogUnreadable': 'Could not read the local workflow catalog.',
    'models.workflowCatalog': (detail) => `Workflow catalog: ${detail}`,
    'models.bridgeUnreachable': 'Could not reach the local model bridge.',
    'models.kicker': 'Local runtime',
    'models.rescan': 'Rescan installed models',
    'activity.kicker': 'Generation operations',
    'activity.subtitle': 'Agent-routed productions only · local metadata, no prompts, media, credentials, or provider payloads',
    'activity.offlinePill': 'Offline · showing the last reading',
    'activity.offlineHint': 'Telemetry comes from the studio on this machine. It retries on its own once the studio is back.',
    'activity.attempts': 'Attempts',
    'activity.running': (count) => `${count} running`,
    'activity.successRate': 'Success rate',
    'activity.failed': (count) => `${count} failed`,
    'activity.averageTime': 'Average time',
    'activity.p95': (duration) => `p95 ${duration}`,
    'activity.generationCost': 'Generation cost',
    'activity.artifacts': (count) => `${count} artifacts`,
    'activity.routingEvidence': 'Routing evidence · by provider',
    'activity.noSamples': 'No generation samples yet',
    'activity.noSamplesHint': 'Image, video, voice, and music attempts made by Planner runs appear here — studio generations are not counted.',
    'activity.latestActivity': 'Latest activity · generation attempts',
    'activity.automatic': 'automatic',
    'activity.noAttempts': 'No recent attempts',
    'activity.noAttemptsHint': 'Start a production and its generation attempts show up here as they run.',

    'providers.kicker': 'Capability routing',
    'providers.offline': 'Offline',
    'providers.checkStatus': 'Check status',
    'providers.statusUnavailable': 'Status unavailable — the studio is not running.',
    'providers.checkingSession': (label) => `Checking the HivemindOS ${label} OAuth session…`,
    'providers.connectedSentence': 'Connected.',
    'providers.notConnectedSentence': `${NOT_CONNECTED}.`,
    'providers.connected': 'Connected',
    'providers.checking': 'Checking',
    'providers.needsSetup': 'Needs setup',
    'providers.signInBlocked': 'The sign-in tab was blocked.',
    'providers.openSignInHere': 'Open the sign-in page here',
    'providers.reconnect': (label) => `Reconnect ${label}`,
    'providers.connectNamed': (label) => `Connect ${label}`,
    'providers.keySaved': (name) => `${name} saved.`,
    'providers.savingTheKey': 'Saving the key',
    'providers.replaceKey': (name) => `Replace ${name}`,
    'providers.addKeyNamed': (name) => `Add ${name}`,
    'providers.pasteTheKey': 'Paste the key',
    'providers.openai': 'OpenAI',
    'providers.openaiNote': 'GPT Image OAuth uses the Codex Responses image tool. The official Image API remains a separate OPENAI_API_KEY provider.',
    'providers.xai': 'xAI',
    'providers.xaiNote': 'A usable api:access session enables Grok Imagine image and video generation.',
    'providers.serverSideAuth': 'Server-side authentication',
    'providers.oauthBlurb': 'OAuth stays inside HivemindOS. This studio receives status only — finish a sign-in in its tab and the card updates here.',
    'providers.generationRoutes': 'Generation routes · capability providers',
    'providers.noneAdvertised': 'No providers advertised',
    'providers.noneAdvertisedHint': 'Provider readiness and routing appear once the studio is running.',

    'about.unstated': 'Unstated',
    'about.otherLicences': 'Other',
    'about.showFewer': 'Show fewer',
    'about.showMore': (count) => `Show ${count} more`,
    'about.subtitle': 'The build running on this machine, the licence it is under, and everything it is made of.',
    'about.version': 'Version',
    'about.builtFrom': (version) => `this page was built from ${version} — reload to catch up`,
    'about.built': 'Built',
    'about.licence': 'Licence',
    'common.source': 'Source',
    'about.viewSource': 'View source',
    'about.thisBuildIsCommit': (commit) => `this build is commit ${commit}`,
    'about.correspondingSource': 'the complete corresponding source',
    'about.security': 'Security',
    'about.reportVulnerability': 'Report a vulnerability privately',
    'about.securityDoc': 'what listens where, and what authenticates it, is in .github/SECURITY.md',
    'about.warranty': 'Warranty',
    'about.noWarranty': 'This program comes with ABSOLUTELY NO WARRANTY, to the extent permitted by applicable law — not even the implied warranty of merchantability or fitness for a particular purpose.',
    'about.freeSoftware': 'This is free software, and you are welcome to redistribute and modify it under the terms of the GNU Affero General Public License, version 3 or later.',
    'about.licenceShips': 'The full licence text and the donor and component provenance are below, and in the source above.',
    'about.licenceText': 'Licence text',
    'about.donorProvenance': 'Donor and component provenance',
    'about.readDocument': 'Read it',
    'about.documentMissing': (filename) => `This build did not ship ${filename}. It is in the source above, at the commit this build was made from.`,
    'about.whatsNew': "What's new",
    'about.noChangelog': 'This build did not ship a changelog. The full history is in CHANGELOG.md in the source above.',
    'about.thirdPartyNotices': 'Third-party notices',
    'about.noNotices': 'This build shipped without the generated dependency licence list.',
    'about.groupedByLicence': 'Grouped by licence, generated at build time from the installed Python distributions and the three npm lockfiles.',

    'runs.kicker': 'Durable production',
    'runs.filterAll': 'All',
    'runs.filterComplete': 'Complete',
    'runs.copiedUrl': 'Copied artifact URL.',
    'runs.thatRunAction': 'That run action',
    'runs.downloadNamed': (what) => `Download ${what}`,
    'runs.copyUrl': 'Copy URL',
    'runs.copyNamedUrl': (what) => `Copy ${what} URL`,
    'runs.pickAProduction': 'Pick a production',
    'runs.pickAProductionHint': 'See what it did, what it made, and what happens next.',
    'runs.production': 'Production',
    'runs.created': 'created',
    'runs.updated': 'updated',
    'runs.nextAction': 'Next action',
    'runs.scenes': 'Scenes',
    'runs.sceneNumber': (index) => `Scene ${index}`,
    'runs.workflow': 'Workflow',
    'runs.artifacts': 'Artifacts',
    'runs.noArtifacts': 'No artifacts yet.',
    'runs.actions': 'Actions',
    'runs.usePromptAndSettings': 'Use prompt & settings',
    'runs.duplicateAndEdit': 'Duplicate & edit',
    'runs.resume': 'Resume',
    'runs.retryStep': 'Retry step',
    'runs.cancelRun': 'Cancel run',
    'runs.operatorToken': 'Operator token',
    'runs.operatorTokenHint': 'Held in memory only. Needed for resume, retry, and cancel — sent as a bearer token at action time.',
    'runs.tokenPlaceholder': '••••••••',
    'runs.cancelTitle': 'Cancel this production?',
    'runs.cancelConfirm': 'Cancel production',
    'runs.cancelKeep': 'Keep running',
    'runs.cancelBody': (title) => `Running steps stop and "${title}" is marked cancelled. Artifacts already made stay in the run.`,
    'runs.shownCount': (count) => `${count} shown`,
    'runs.noMatching': 'No matching productions',
    'runs.noMatchingHint': 'Create a production or change the filter.',
    // A production whose record file the studio can no longer read. The row
    // stays in the list — one broken record must never hide the rest.
    'runs.recordMissing': 'Record missing',
    'runs.recordMissingTitle': "This production's record file is missing, so the studio cannot read it.",
    'runs.recordSealedTitle': "This production's record is sealed and could not be unlocked.",
    'runs.recordUnreadableTitle': "This production's record could not be read.",
    'runs.recordMissingHint': 'Everything else about it — its steps, its status, its history — is still here. The record itself lives in the studio folder, so check that folder is the one this run was made in.',
    'runs.recordSealedHint': 'The private sections of this record could not be unlocked on this machine. Nothing has been lost — check this workspace’s privacy settings.',
    'runs.recordUnreadableHint': 'The file is there but this studio cannot make sense of it. Storage settings show which folder it was read from.',
    'runs.openStorageSettings': 'Open storage settings',

    'history.kicker': 'Private archive',
    'history.prompts': 'Prompts',
    'history.outputs': 'Outputs',
    'history.favorites': 'Favorites',
    'history.loadVideoLabel': 'Load encrypted video preview',
    'history.loadVideo': 'Load video',
    'history.loadInStudio': 'Load in Studio',
    'history.loadInCanvas': 'Load in Canvas',
    'history.copyPrompt': 'Copy prompt',
    'history.openPreview': 'Open preview',
    'history.encryptedAtRest': ENCRYPTED_AT_REST,
    'history.privateOutput': 'Private output',
    'history.removeFavorite': 'Remove from favorites',
    'history.addFavorite': 'Add to favorites',
    'history.unlock': 'Unlock',
    'history.useInPlanner': 'Use in Planner',
    'history.originalWording': 'Your original wording',
    'history.loadingOutputs': 'Loading outputs',
    'history.staleReadingTitle': 'The studio did not answer the latest poll',
    'history.filterPlaceholder': 'Filter prompts and outputs',
    'history.allFormats': 'All formats',
    'history.allModels': 'All models',
    'history.everythingStaysHere': 'Everything here stays on this machine, encrypted at rest. Outputs come from the studios and Canvas · productions planned in the Planner live under Productions.',
    'history.studiosAndCanvas': 'Studios & Canvas',
    'history.ofCount': (shown, total) => `${shown} of ${total}`,
    'history.loadingMore': 'Loading more outputs…',
    'history.noOutputsMatch': 'No outputs match',
    'history.noOutputsYet': 'No outputs yet',
    'history.clearTheFilter': 'Try another word, or clear the filter.',
    'history.generateSomething': 'Generate something in a studio and it appears here.',
    'history.promptLibrary': 'Prompt library',
    'history.loadingEllipsis': 'Loading…',
    'history.generationPrompts': 'Generation prompts',
    'history.noPromptsMatch': 'No prompts match',
    'history.noFavoritesYet': 'No favorites yet',
    'history.noPromptsYet': 'No prompts yet',
    'history.starAPrompt': 'Star a prompt to keep it as a reusable ingredient.',
    'history.promptsRecordedHere': 'Create a production and its final generation prompt will be recorded here.',
    'history.deleteOutputTitle': 'Delete this generated output?',
    'history.deletePromptTitle': 'Delete this prompt?',
    'history.deletePermanently': 'Delete permanently',
    'history.deleteOutputBody': 'This permanently removes every same-name media copy, encrypted sidecar, history reference, workflow-index entry, and regenerable preview cache. This cannot be undone.',
    'history.deletePromptBody': 'This permanently removes the saved prompt from your library. This cannot be undone.',

    'settings.kicker': 'This machine',
    'settings.default': 'Default',
    'settings.saved': 'Saved',
    'settings.savedButPinned': 'Saved — but an environment variable on this machine still overrides it.',
    'settings.keyRemoved': 'API key removed',
    'settings.keySavedToMachine': 'Key saved to this machine’s shared store',
    'settings.keySaved': 'API key saved',
    'settings.exported': 'Settings exported',
    'settings.exportFailed': 'The studio could not write that file. Check that downloads are allowed for this page.',
    'settings.importedWithStudios': (count) => `Imported settings and ${count} studio defaults`,
    'settings.imported': 'Imported settings',
    'settings.importNotAnExport': 'That file is not a studio settings export.',
    'settings.restartRequired': (count) => `Saved. ${count === 1 ? 'That setting takes' : 'Those settings take'} effect after the studio restarts.`,
    'settings.fileUnreadable': 'The settings file could not be read',
    'settings.fileUnreadableHint': 'The studio started on its defaults. Saving any setting below replaces the file with a readable one.',
    'settings.general': 'General',
    'settings.language': 'Language',
    'settings.languageHint': 'This build ships English only; a stored choice is kept for when the rest is translated.',
    'settings.english': 'English',
    'settings.chime': 'Completion chime',
    'settings.chimeHint': 'A two-note chime when a generation lands. The same switch is in every studio.',
    'settings.apiKeyHint': 'The MUAPI key the hosted lanes generate with.',
    'settings.clearToRemove': 'Clear the field and save to remove it.',
    'settings.generationDefaults': 'Generation defaults',
    'settings.stillOnDefaults': 'still on the defaults',
    'settings.resetStudio': (studio) => `Reset ${studio}`,
    'settings.resetStudioBody': 'The saved model, aspect and tuning for this studio go back to the defaults the next time it opens. Nothing you have made is touched.',
    'settings.reset': 'Reset',
    'settings.backToDefaults': 'Back to the defaults',
    'settings.folders': 'Folders',
    'settings.localEngines': 'Local engines',
    'settings.localEnginesHint': 'Off is a working studio with one fewer local lane, never an error.',
    'settings.localModelsHint': 'Installing, inspecting and deleting a model all happen on the Models page.',
    'settings.engineTabBlurb': 'The Engine tab on the Models page installs the inference engine and the models, and says whether each one fits this machine.',
    'settings.workspace': 'Workspace',
    'settings.workspaceBlurb': 'Each workspace has its own vault and its own media folders, and deleting one deletes what is inside it. Switching or adding a workspace happens on the sign-in screen.',
    'settings.stateFolder': 'Studio state folder',
    'settings.switchWorkspace': 'Switch workspace',
    'settings.privacyAndVault': 'Privacy & vault',
    'settings.network': 'Network',
    'settings.networkHint': 'Where the studio’s own parts answer each other.',
    'settings.rentedGpusHint': 'This one is money, not housekeeping: a box that failed to provision still bills.',
    'settings.backupAndReset': 'Backup & reset',
    'settings.backupAndResetHint': 'An export carries no keys, no prompts and no search text — only what this browser remembers about how you like things.',
    'settings.exportSettings': 'Export settings',
    'settings.importSettings': 'Import settings',
    'settings.resetEveryPreference': 'Reset every preference',
    'settings.resetEveryPreferenceBody': 'Language, the chime, filters, panel state and every studio’s saved defaults go back to how they started. Your work, your credentials and this machine’s settings above are not touched.',
    'settings.resetEverything': 'Reset everything',
    'settings.preferencesReset': 'Preferences reset',
    'settings.prefsWereUnreadable': 'Your saved preferences could not be read and have been reset to the defaults.',
    'settings.product': 'Product',
    'settings.commit': 'Commit',
    'settings.buildDate': 'Build date',
    'settings.settingsFile': 'Settings file',


    // ---- The studios' advanced panels -------------------------------------
    'imagePanel.aspectRatio': 'Aspect ratio',
    'imagePanel.aspectFromReference': 'Matches your reference image — the edit keeps its proportions.',
    'imagePanel.aboutPerImage': (eta) => `About ${eta} per image`,
    'imagePanel.resolution': 'Resolution',
    'imagePanel.howMany': 'How many',
    'imagePanel.howManyHint': 'Pictures per press — each one costs the same time again',
    'imagePanel.stepsHint': 'More detail, more time — every step is another pass over the picture',
    'imagePanel.guidanceHint': 'How literally the model follows your words — high sticks to the prompt, low invents (CFG)',
    'imagePanel.seedHint': 'The same seed and the same settings make the same picture again — leave it at -1 for a new one every press',
    'imagePanel.sampler': 'Sampler',
    'imagePanel.samplerAutoLowSteps': 'Auto — clean at 2–5 steps, but not a speed win (deis_3m, ~2.7 model evals a step)',
    'imagePanel.samplerAutoTuned': 'Auto — tuned for 8–10 steps, one pass each (euler_ancestral)',
    'imagePanel.samplerAutoPair': 'Auto — the workflow picks a pair to match the step count',
    'imagePanel.autoMatchSteps': 'Auto (match steps)',
    'imagePanel.scheduler': 'Scheduler',
    'imagePanel.schedulerAuto': (name) => `Auto — ${name} for this step count`,
    'imagePanel.thisWorkflow': 'This workflow',
    'imagePanel.editResolutionHint': (width, height, megapixels) => `${width} × ${height} for this reference — ${megapixels} MP of canvas; sampling time scales with pixel count`,
    'imagePanel.editResolutionShapedHint': (megapixels) => `${megapixels} MP of canvas, shaped like your reference — sampling time scales with pixel count`,
    'imagePanel.nativeCanvas': 'the model’s native canvas',
    'imagePanel.customResolutionHint': (width, height) => `${width} × ${height} — set by the Custom aspect ratio above`,
    'imagePanel.aboutAtTheseSettings': (eta) => ` — about ${eta} at these settings`,
    'imagePanel.scalesWithPixels': ' — sampling time scales with pixel count',
    'imagePanel.workflowDefault': (width) => `Workflow default (${width})`,
    'imagePanel.shortSide': (size) => `${size} short side`,
    'imagePanel.memory': 'Memory',
    'imagePanel.memoryHint': 'Keep loaded makes the next picture start faster; One-off gives the memory back after each one.',
    'imagePanel.oneOff': 'One-off',
    'imagePanel.keepLoaded': 'Keep loaded',
    'imagePanel.modes': 'Modes',
    'imagePanel.regionBoxes': 'Region boxes',
    'imagePanel.regionBoxesBlurb': 'Say what goes where: each box becomes a placement sentence appended to your prompt. Works with every model — no extra nodes. Box text stays in this session only.',
    'imagePanel.coupleOwnsPrompt': 'Couple mode owns the prompt while it is on, so regions stand down.',
    'imagePanel.coupleMode': 'Couple mode',
    'imagePanel.coupleModeBlurb': 'Two-character mode: one prompt per character with a canvas split. Character text stays in this session only.',
    'imagePanel.sharedScene': 'Shared scene (optional)',
    'imagePanel.sharedScenePlaceholder': 'e.g. sitting by a bonfire at night',
    'imagePanel.characterA': 'Character A',
    'imagePanel.characterAGirl': 'Character A (girl)',
    'imagePanel.characterAPlaceholder': 'e.g. haruno sakura, pink hair, smiling',
    'imagePanel.characterB': 'Character B',
    'imagePanel.characterBBoy': 'Character B (boy)',
    'imagePanel.characterBPlaceholder': 'e.g. black hair, green eyes, crossed arms',
    'imagePanel.pair': 'Pair',
    'imagePanel.twoGirls': 'Two girls',
    'imagePanel.girlAndBoy': 'Girl & boy',
    'imagePanel.twoBoys': 'Two boys',
    'imagePanel.layout': 'Layout',
    'imagePanel.sideBySide': 'Side by side',
    'imagePanel.stacked': 'Stacked',
    'imagePanel.characterSheet': 'Character sheet',
    'imagePanel.characterSheetBlurb': 'Multi-view sheet from your reference: each view is its own edit with a shared seed, composited into one labeled sheet. The prompt box is optional extra styling.',
    'imagePanel.views': 'Views',
    'imagePanel.strengthHunt': 'Strength Hunt',
    'imagePanel.strengthHuntArmed': (count) => `Armed on ${count} LoRA${count === 1 ? '' : 's'} — one press sweeps each from 0 to its weight and adds a labeled comparison sheet.`,
    'imagePanel.strengthHuntIdle': 'Try one LoRA at every weight in a single press. Arm it on a LoRA with the grid button in the list above.',

    'restore.laneNotAnswering': 'ComfyUI is not answering on this machine, so it cannot say what it can restore.',
    'restore.laneNoNodes': 'This machine has no SeedVR2 upscaler installed.',
    'restore.laneFixHint': 'Install ComfyUI-SeedVR2_VideoUpscaler here, or attach a machine that already has it.',
    'restore.hostedUnavailable': 'The hosted restoration service is not available right now.',

    'restorePanel.pricing': 'Pricing this render…',
    'restorePanel.notPriced': 'This render could not be priced — nothing will be charged without a figure here.',
    'restorePanel.noSeedVr2Before': 'No machine here has the SeedVR2 nodes. Install',
    'restorePanel.noSeedVr2After': 'on this ComfyUI, or attach a rented machine that has it from the Rented GPUs page.',
    'restorePanel.firstChunkDownload': 'A model this machine has not used before downloads on its first chunk.',
    'restorePanel.output': 'Output',
    'restorePanel.comesOut': (width, height) => `This clip comes out ${width}x${height}.`,
    'restorePanel.capLongEdge': 'Cap the long edge',
    'restorePanel.capLongEdgeHint': '0 leaves it alone. Useful on very wide footage, where the short-edge target makes the width enormous.',
    'restorePanel.off': 'off',
    'restorePanel.howItIsCut': 'How it is cut up',
    'restorePanel.temporalBatch': 'Temporal batch',
    'restorePanel.temporalBatchHint': "Frames the model denoises together. More is steadier and needs more memory — not faster: measured on a 5090, going from 5 to 21 took 7% off the render and 52% more VRAM. Snapped to the model's 4n+1 lattice.",
    'restorePanel.frames': (count) => `${count} frames`,
    'restorePanel.seconds': (count) => `${count}s`,
    'restorePanel.chunkLength': 'Chunk length',
    'restorePanel.chunkLengthHint': 'Also the checkpoint interval — an interrupted render resumes at the last finished chunk.',
    'restorePanel.leadIn': 'Lead-in',
    'restorePanel.leadInHint': 'Frames each chunk re-reads from the one before, so it starts having seen them. This is what stops a visible re-grade at every boundary — and it is extra render time.',
    'restorePanel.seamDissolve': 'Seam dissolve',
    'restorePanel.seamSingleChunk': 'Nothing to dissolve — this clip is one chunk.',
    'restorePanel.seamHint': 'Frames to cross-dissolve where two chunks overlap. Replaces frames rather than inserting them, so the master stays exactly as long as the source.',
    'restorePanel.hardCut': 'hard cut',
    'restorePanel.colourAndSeed': 'Colour and seed',
    'restorePanel.seedHint': 'One seed for every chunk of a project. Two chunks denoised from different noise are two slightly different grades meeting at a seam.',
    'restorePanel.memoryAndSpeed': 'Memory and speed',
    'restorePanel.tiledVae': 'Tiled VAE — less memory, slower, can leave faint tile edges on flat gradients',
    'restorePanel.sourceLine': (width, height, frames, fps) => `Source: ${width}x${height}, ${frames} frames at ${fps}fps`,
    'restorePanel.soundtrackKept': ' — its soundtrack is carried over untouched.',
    'restorePanel.noSoundtrack': ' — no soundtrack.',

    'passbook.kicker': 'Shared on this machine',
    'passbook.stored': 'Stored',
    'passbook.notSet': 'Not set',
    'passbook.replaceKey': 'Replace key',
    'passbook.key': 'Key',
    'passbook.replace': 'Replace',
    'passbook.modeAlways': 'Always',
    'passbook.modeAlwaysHint': 'handed over without interruption',
    'passbook.modeAsk': 'Ask me',
    'passbook.modeAskHint': 'the request waits until you answer',
    'passbook.modeWindow': 'In hours',
    'passbook.modeWindowHint': 'allowed inside a schedule, refused outside',
    'passbook.modeNever': 'Never',
    'passbook.modeNeverHint': 'always refused',
    'passbook.requestsWaiting': (count) => `${count} request${count > 1 ? 's' : ''} waiting on you`,
    'passbook.wants': 'wants',
    'passbook.justThisOnce': 'Just this once',
    'passbook.approveFor1h': 'Approve for 1h',
    'passbook.decline': 'Decline',
    'passbook.everyKey': 'Every key',
    'passbook.minutesLeft': (minutes) => `${minutes}m left`,
    'passbook.closeNow': 'Close now',
    'passbook.stopBeingAskedBlurb': 'Stop being asked for a while. It closes on its own when the time is up.',
    'passbook.whileOpenBlurb': 'While it is open, anything running as you can use these keys without asking. That is what it is for — but it should never be something you did without noticing.',
    'passbook.notInstalled': 'Not installed.',
    // "Not installed" on its own leaves a first-time owner unable to tell a
    // missing component from a broken one. These two say which it is: the
    // first that there is nothing to do, the second that a read failed and
    // the panel beside it carries the retry.
    'passbook.optionalPart': 'Nothing to fix — this part of PassBook is optional, and the keys above work without it.',
    'passbook.panelUnreadable': 'This part of the page could not be read.',
    'passbook.app': 'App',
    'passbook.defaultMode': (mode) => `default ${mode}`,
    'passbook.noStoredKeys': 'No stored keys yet.',
    'passbook.brokerRunning': (mode) => `Reads go through the broker, in ${mode} mode.`,
    'passbook.brokerStopped': 'Not running — each app records its own reads, so the record has gaps.',
    'passbook.running': 'Running',
    'passbook.stopped': 'Stopped',
    'passbook.startItWith': 'Start it with',
    'passbook.linkingNotSetUp': 'Machine linking is not set up.',
    'passbook.thisFingerprint': "This machine's fingerprint:",
    'passbook.noLinkedMachines': 'No linked machines. Add one with `passbook-link request` on the machine that needs keys.',
    'passbook.lentTo': 'Lent to',
    'passbook.borrowedFrom': 'Borrowed from',
    'passbook.linkRevoked': 'Revoked',
    'passbook.linkExpired': 'Expired',
    'passbook.revoke': 'Revoke',
    'passbook.keySaved': (key) => `${key} saved — every Hive app on this machine can use it now.`,
    'passbook.keyReplaced': (key) => `${key} replaced.`,
    'passbook.keyUnchanged': (key) => `${key} was already stored; nothing changed.`,
    'passbook.saveFailed': 'Could not save that key.',
    'passbook.revokedRotate': (keys) => `Revoked. Rotate these at the provider — revoking cannot unsend them: ${keys}`,
    'passbook.revoked': 'Revoked.',
    'passbook.revokeFailed': 'Could not revoke that link.',
    'passbook.actionFailed': `${DID_NOT_WORK}.`,
    'passbook.modeSet': (key, mode, app) => `${key} is now "${mode}" for ${app}.`,
    'passbook.unlockedFor': (duration) => `Unlocked for ${duration}. It closes on its own.`,
    'passbook.closed': 'Closed.',
    'passbook.approved': (remember, byPasskey) => `Approved${remember ? ` for ${remember}` : ''}${byPasskey ? ' with your passkey' : ''}.`,
    'passbook.declined': 'Declined.',
    'passbook.encryptedAtRest': `${ENCRYPTED_AT_REST}.`,
    'passbook.encryptFailed': 'Could not encrypt the store.',
    'passbook.storeUnreadable': 'Could not read the shared store.',
    'passbook.containerHome': 'This build cannot reach the shared store',
    'passbook.containerHomeFix': 'Ship this build without the App Sandbox, or launch it with HIVE_HOME pointing at the real store.',
    'passbook.storedCount': (count) => `${count} stored`,
    'passbook.workspaceName': (name) => `workspace ${name}`,
    'passbook.oneStoreBlurb': 'These keys live in one store shared by every Hive app on this machine. Paste a key once and they all have it — and installing HivemindOS later adopts this same store rather than starting another.',
    'passbook.newKeysWrittenTo': 'New keys are written to this workspace:',
    'passbook.keysThisStudioUses': 'Keys this studio uses',
    'passbook.encryptionAtRest': 'Encryption at rest',
    'passbook.encrypted': 'Encrypted',
    'passbook.plaintext': 'Plaintext',
    'passbook.atRestBlurb': 'This protects the store at rest — a stolen laptop, a backup, a synced home folder. It does not stop code running as you from reading a key.',
    'passbook.encryptTheStore': 'Encrypt the store',
    'passbook.stopBeingAsked': 'Stop being asked',
    'passbook.howEachKeyAnswered': 'How each key is answered',
    'passbook.linkedMachines': 'Linked machines',
    'passbook.readBroker': 'Read broker',
    'passbook.accessRecord': 'Access record',
    'passbook.unaltered': 'Unaltered',
    'passbook.altered': 'Altered',
    'passbook.noAccessRecord': 'No access record on this machine.',

    'assets.searchPlaceholder': 'Search name, trigger word, creator…',
    'assets.anyBaseModel': 'Any base model',
    'assets.grid': 'Grid',
    'assets.list': 'List',
    'assets.shownOf': (shown, total) => `${shown} of ${total} shown`,
    'assets.onDisk': (size) => `${size} on disk`,
    'assets.clearFilters': 'Clear filters',
    'assets.nothingMatches': 'Nothing matches those filters',
    'assets.noneInstalled': 'No models installed yet',
    'assets.widenTheSearch': 'Widen the search, or clear the base-model filter.',
    'assets.downloadFromDiscover': 'Download a model from Discover and it lands in the ComfyUI models folder.',
    'runnable.warmBlurb': 'Loading a model takes a few seconds — warm it before you start, or give the memory back when you are done.',
    'runnable.modelIsWarm': 'Model is warm.',
    'runnable.warmFailed': 'Warm failed',
    'runnable.warmUp': 'Warm up',
    'runnable.modelUnloaded': 'Model unloaded.',
    'runnable.unloadFailed': 'Unload failed',
    'runnable.freeMemory': 'Free memory',
    'runnable.openInVideo': 'Open in the Video studio',
    'runnable.openInImage': 'Open in the Image studio',
    'runnable.open': 'Open',
    'runnable.countedFilter': (label, count) => `${label} ${count}`,
    'runnable.searchPlaceholder': 'Search workflows…',
    'runnable.readingCatalog': 'Reading the local model catalog…',
    'runnable.noVideoModels': 'No video models advertised here',
    'runnable.noMatchingModels': 'No matching models',
    'runnable.videoModelsHint': 'Video models come from the studio catalog and run in the Video studio — open it to see what is installed.',
    'runnable.nothingInstalledHint': 'Nothing installed yet. The Engine tab lists what this machine can run and installs it for you.',
    'runnable.browseModels': 'Browse models to install',

    'assets.kindLora': 'LoRA',
    'assets.kindCheckpoint': 'Checkpoint',
    'assets.kindEmbedding': 'Embedding',
    'assets.kindOther': 'Support file',
    'assets.copyFailed': 'Could not copy to the clipboard.',
    'assets.filenameCopied': 'Filename copied.',
    'assets.copyFilename': 'Copy filename',
    'assets.viewOnCivitai': 'View on Civitai',
    'assets.byCreator': (creator) => `by ${creator}`,
    'assets.triggerWords': 'Trigger words',
    'assets.copiedWord': (word) => `Copied “${word}”.`,
    'assets.copyToClipboard': 'Copy to the clipboard',
    'assets.description': 'Description',
    'assets.notes': 'Notes',
    'assets.file': 'File',
    'assets.name': 'Name',
    'assets.folder': 'Folder',
    'assets.size': 'Size',
    'assets.usedBy': 'Used by',
    'assets.added': 'Added',

    'discover.revealFor': (name) => `Reveal the preview for ${name}`,
    'discover.clickToReveal': 'Click to reveal',
    'discover.downloads': 'Downloads',
    'discover.likes': 'Likes',
    'discover.openOnCivitai': 'Open on Civitai',
    'discover.openNamedOnCivitai': (name) => `Open ${name} on Civitai`,
    'discover.searching': 'Searching Civitai…',
    'discover.resultCount': (count, more) => `${count} result${count === 1 ? '' : 's'}${more ? ' · more available' : ''}`,
    'discover.noResults': 'No results. Widen the filters or try a different term.',
    'discover.downloadStarted': 'Download started — progress is on the card below.',
    'discover.needsBridge': 'Civitai browsing needs the hosted bridge',
    'discover.needsBridgeHint': 'This build talks to models it manages itself. Browsing and installing from Civitai needs the hosted bridge — the Mac running the stack.',
    'discover.searchPlaceholder': 'Search Civitai, or paste a model URL to install it',
    'discover.searchLabel': 'Search Civitai',
    'discover.installUrl': 'Install URL',
    'discover.search': 'Search',
    'discover.type': 'Type',
    'discover.baseModel': BASE_MODEL,
    'discover.sort': 'Sort',
    'discover.period': 'Period',
    'discover.allTime': 'All time',
    'discover.rating': 'Rating',
    'discover.safeOnly': 'Safe only',
    'discover.includeNsfw': 'Include NSFW',
    'discover.anyRating': 'Any rating',
    'discover.perPage': 'Results per page',
    'discover.resultsPerPage': (count) => `${count} results`,
    'discover.searchPrompt': 'Search Civitai to find LoRAs, checkpoints and embeddings.',
    'discover.loadMore': 'Load more',
    'discover.searchFailed': 'Civitai search failed',
    'discover.nothingYet': 'Nothing to show yet',
    'discover.searchByName': 'Search by name, or paste a civitai.com model URL to install it directly.',

    'inspo.kicker': 'Civitai',
    'inspo.loadedIntoVideo': 'Prompt loaded into the Video studio.',
    'inspo.loadedIntoImage': 'Prompt loaded into the Image studio.',
    'inspo.revealPreview': 'Reveal this preview',
    'inspo.openResult': 'Open this result',
    'common.usePrompt': 'Use prompt',
    'inspo.details': 'Details',
    'inspo.detailsLabel': 'Show the full prompt and settings',
    'inspo.labelCopied': (label) => `${label} copied.`,
    'inspo.civitaiVideo': 'Civitai video',
    'inspo.civitaiImage': 'Civitai image',
    'inspo.useInVideo': 'Use in Video studio',
    'inspo.useInImage': 'Use in Image studio',
    'inspo.prompt': 'Prompt',
    'inspo.madeWith': 'Made with',
    'inspo.baseModelLabel': `${BASE_MODEL}:`,
    'inspo.checkpointLabel': 'Checkpoint:',
    'inspo.loraLabel': 'LoRA:',
    'inspo.onlyPromptLoaded': 'Only the prompt and settings are loaded — your model is not switched. Install these from the Models page to match it exactly.',
    'inspo.withPrompts': (count, scanned) => `${count} with prompts${scanned ? ` · read ${scanned}` : ''}`,
    'inspo.nothingUsable': 'Nothing with a usable prompt here. Widen the period, or try the other media type.',
    'inspo.needsBridge': 'The inspiration finder needs the hosted bridge',
    'inspo.needsBridgeHint': 'Browsing Civitai runs on the Mac that holds the stack and its Civitai key. This build has no bridge to it.',
    'inspo.creatorPlaceholder': 'Filter by creator (optional)',
    'inspo.creatorLabel': 'Civitai creator',
    'inspo.everyResultHasPrompt': 'Every result here came with a prompt you can load.',
    'inspo.readToFind': (scanned, found) => `Read ${scanned} Civitai results to find these ${found}. The rest were posted without a prompt.`,
    'inspo.searchToSee': 'Search to see images and videos that came with their prompt.',

    'setup.comfyUrlPlaceholder': 'http://127.0.0.1:8188',

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
