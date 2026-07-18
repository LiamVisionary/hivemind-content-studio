import { muapi } from '../lib/muapi.js';
import { t2vModels, getAspectRatiosForVideoModel, getDurationsForModel, getResolutionsForVideoModel, i2vModels, getAspectRatiosForI2VModel, getDurationsForI2VModel, getResolutionsForI2VModel, v2vModels, getModesForModel } from '../lib/models.js';
import { AuthModal } from './AuthModal.js';
import { t } from '../lib/i18n.js';
import { createUploadPicker } from './UploadPicker.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { isWan2gpModelId, getLocalModelById, localT2VModels, localI2VModels } from '../lib/localModels.js';
import {
    generateHivemindVideo,
    getHivemindVideoModelById,
    getSavedHivemindVideoSelection,
    isHivemindStudioEnabled,
    isHivemindVideoModelId,
    loadStudioGenerationHistory,
    loadHivemindStudioContext,
    saveStudioGenerationHistory,
    uploadFileToHivemindStudio,
    workflowIdFromHivemindModelId,
} from '../lib/hivemindStudio.js';

// Promotes a wan2gp catalog entry (lib/localModels.js shape) into the
// `inputs`-shaped descriptor the Video Studio dropdowns/controls expect.
const adaptLocalToVideoEntry = (m) => ({
    id: m.id,
    name: m.name,
    provider: 'wan2gp',
    inputs: {
        prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
        aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['16:9', '1:1', '9:16'], default: (m.aspectRatios || ['16:9'])[0] },
    },
});

const adaptHivemindToVideoEntry = (m) => ({
    id: m.id,
    name: m.name,
    provider: 'hivemind-media-studio',
    workflowId: m.workflowId,
    supportsVideoInput: Boolean(m.supportsVideoInput),
    videoModes: m.videoModes || [],
    inputs: {
        prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
        aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['1:1', '16:9', '9:16'], default: (m.aspectRatios || ['1:1'])[0] },
        duration: { type: 'number', name: 'duration', enum: m.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], default: m.defaultDuration || 4 },
    },
});

const VIDEO_COMPLETION_PING_KEY = 'video_ping_when_complete';
const VIDEO_PREFERENCES_KEY = 'video_generation_preferences';

export function normalizeVideoPreferences(value) {
    if (!value || typeof value !== 'object') return null;
    const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
    if (!modelId || modelId.length > 256) return null;
    const duration = Number(value.duration);
    return {
        modelId,
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
}

export function normalizeVideoGenerationProgress(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = value > 1 ? value / 100 : value;
    return Math.min(1, Math.max(0, normalized));
}

export function classifyVideoGenerationStage(status) {
    const value = String(status || '').toLowerCase();
    if (/load|model|startup|prepar/.test(value)) return 'loading';
    if (/encod|decod|export|sav|final/.test(value)) return 'finishing';
    if (/queue|pending|submit/.test(value)) return 'queued';
    return 'rendering';
}

export function formatVideoGenerationElapsed(elapsedMs) {
    const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

export function VideoStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full flex flex-col items-center justify-center bg-app-bg relative p-4 md:p-6 overflow-y-auto custom-scrollbar overflow-x-hidden';

    // Merge Wan2GP video models in only when running inside Electron AND the
    // user has a Wan2GP server configured. We can't probe synchronously, so
    // we always include them when isLocalAIAvailable() — getCurrentModel()
    // reads from these arrays, so they need to be present from init.
    const localT2V = isLocalAIAvailable() ? localT2VModels.map(adaptLocalToVideoEntry) : [];
    const localI2V = isLocalAIAvailable() ? localI2VModels.map(adaptLocalToVideoEntry) : [];
    let hivemindI2V = [];
    let allT2V = [...t2vModels, ...localT2V];
    let allI2V = [...i2vModels, ...localI2V];

    // --- State ---
    const defaultModel = allT2V[0];
    let selectedModel = defaultModel.id;
    let selectedModelName = defaultModel.name;
    let selectedAr = defaultModel.inputs?.aspect_ratio?.default || '16:9';
    let selectedDuration = defaultModel.inputs?.duration?.default || 5;
    let selectedResolution = defaultModel.inputs?.resolution?.default || '';
    let selectedQuality = defaultModel.inputs?.quality?.default || '';
    let selectedMode = '';
    let selectedEffectName = '';
    let lastGenerationId = null;
    let lastGenerationModel = null;
    let dropdownOpen = null;
    let uploadedImageUrl = null;
    let uploadedEndImageUrl = null; // optional end-frame for FLF i2v models
    let imageMode = false; // false = t2v models, true = i2v models
    let v2vMode = false;   // true = video-to-video tools mode
    let uploadedVideoUrl = null;
    let uploadedVideoName = null;
    let lastSubmittedContext = null;
    let viewedGenerationContext = null;
    let pingWhenComplete = false;
    let completionAudioContext = null;
    let persistedVideoPreferences = null;
    try {
        pingWhenComplete = sessionStorage.getItem(VIDEO_COMPLETION_PING_KEY) === '1';
    } catch {}
    try {
        persistedVideoPreferences = normalizeVideoPreferences(
            JSON.parse(localStorage.getItem(VIDEO_PREFERENCES_KEY) || 'null'),
        );
    } catch {}

    const getCurrentModels = () => v2vMode ? v2vModels : (imageMode ? allI2V : allT2V);
    // Local Wan2GP entries don't live in the Muapi-derived helpers, so we
    // resolve aspect ratios off the catalog when the selected id is local.
    const getCurrentAspectRatios = (id) => {
        const hive = getHivemindVideoModelById(id);
        if (hive) return hive.aspectRatios || ['1:1', '16:9', '9:16'];
        const local = getLocalModelById(id);
        if (local) return local.aspectRatios || ['16:9', '1:1', '9:16'];
        return imageMode ? getAspectRatiosForI2VModel(id) : getAspectRatiosForVideoModel(id);
    };
    const getCurrentDurations = (id) => {
        const hive = getHivemindVideoModelById(id);
        if (hive) return hive.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        if (getLocalModelById(id)) return [];
        return imageMode ? getDurationsForI2VModel(id) : getDurationsForModel(id);
    };
    const getCurrentResolutions = (id) => {
        if (getHivemindVideoModelById(id)) return [];
        if (getLocalModelById(id)) return [];
        return imageMode ? getResolutionsForI2VModel(id) : getResolutionsForVideoModel(id);
    };
    const getCurrentModes = (id) => getModesForModel(id);
    const getCurrentModel = () => getCurrentModels().find(m => m.id === selectedModel);
    const isMotionControlV2V = () => v2vMode && !!getCurrentModel()?.imageField;
    const isHivemindVideoInputMode = () => isHivemindVideoModelId(selectedModel) && Boolean(uploadedVideoUrl);
    const getQualitiesForModel = (id) => {
        const model = getCurrentModels().find(m => m.id === id);
        return model?.inputs?.quality?.enum || [];
    };
    const getEffectNamesForModel = (id) => {
        const model = getCurrentModels().find(m => m.id === id);
        return model?.inputs?.name?.enum || [];
    };

    // ==========================================
    // 1. HERO SECTION
    // ==========================================
    const hero = document.createElement('div');
    hero.className = 'flex flex-col items-center mb-10 md:mb-20 animate-fade-in-up transition-all duration-700';
    hero.innerHTML = `
        <div class="mb-10 relative group">
             <div class="absolute inset-0 bg-primary/20 blur-[100px] rounded-full opacity-40 group-hover:opacity-70 transition-opacity duration-1000"></div>
             <div class="relative w-24 h-24 md:w-32 md:h-32 bg-teal-900/40 rounded-3xl flex items-center justify-center border border-white/5 overflow-hidden">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="text-primary opacity-20 absolute -right-4 -bottom-4">
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                <div class="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center border border-primary/20 shadow-glow relative z-10">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-primary">
                        <polygon points="23 7 16 12 23 17 23 7"/>
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                </div>
                <div class="absolute top-4 right-4 text-primary animate-pulse">✨</div>
             </div>
        </div>
        <h1 class="text-2xl sm:text-4xl md:text-7xl font-black text-white tracking-widest uppercase mb-4 selection:bg-primary selection:text-black text-center px-4">${t('video.title')}</h1>
        <p class="text-secondary text-sm font-medium tracking-wide opacity-60">${t('video.subtitle')}</p>
    `;
    container.appendChild(hero);

    // ==========================================
    // 2. PROMPT BAR
    // ==========================================
    const promptWrapper = document.createElement('div');
    promptWrapper.className = 'w-full max-w-4xl relative z-40 animate-fade-in-up';
    promptWrapper.style.animationDelay = '0.2s';

    const bar = document.createElement('div');
    bar.className = 'w-full bg-[#111]/90 backdrop-blur-xl border border-white/10 rounded-[1.5rem] md:rounded-[2.5rem] p-3 md:p-5 flex flex-col gap-3 md:gap-5 shadow-3xl';

    const topRow = document.createElement('div');
    topRow.className = 'flex items-start gap-5 px-2';

    // --- Image Upload Picker (Image-to-Video) ---
    const picker = createUploadPicker({
        anchorContainer: container,
        onSelect: ({ url }) => {
            if (isHivemindVideoInputMode()) clearVideoUpload();
            uploadedImageUrl = url;
            // Motion-control v2v: image is a second input alongside the video, not a mode switch
            if (isMotionControlV2V()) {
                textarea.disabled = false;
                textarea.placeholder = uploadedVideoUrl
                    ? (getCurrentModel()?.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)')
                    : 'Now upload a reference video using the 🎥 button';
                return;
            }
            // Clear video mode if active
            if (v2vMode) {
                uploadedVideoUrl = null;
                v2vMode = false;
                showVideoIcon();
            }
            if (!imageMode) {
                imageMode = true;
                const currentT2V = allT2V.find(m => m.id === selectedModel);
                const sibling = currentT2V?.family
                    ? allI2V.find(m => m.family === currentT2V.family)
                    : null;
                const target = sibling || allI2V[0];
                selectedModel = target.id;
                selectedModelName = target.name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
            }
            textarea.placeholder = 'Describe the motion or effect (optional)';
            textarea.disabled = false;
        },
        onClear: () => {
            uploadedImageUrl = null;
            // Motion-control v2v: keep the model selection; just lose the image
            if (isMotionControlV2V()) return;
            imageMode = false;
            // Clearing the start frame invalidates any selected end frame.
            uploadedEndImageUrl = null;
            endPicker?.reset();
            selectedModel = allT2V[0].id;
            selectedModelName = allT2V[0].name;
            document.getElementById('v-model-btn-label').textContent = selectedModelName;
            updateControlsForModel(selectedModel);
            persistVideoPreferences();
            textarea.placeholder = t('video.placeholder');
            textarea.disabled = false;
        },
        // Route the upload through the configured Wan2GP server when the active
        // model is local; otherwise fall back to the Muapi-hosted upload.
        uploadFn: (file) => isHivemindVideoModelId(selectedModel)
            ? uploadFileToHivemindStudio(file)
            : (isWan2gpModelId(selectedModel) ? localAI.uploadFileToWan2gp(file) : muapi.uploadFile(file)),
        requireApiKey: () => !isWan2gpModelId(selectedModel) && !isHivemindVideoModelId(selectedModel),
    });
    topRow.appendChild(picker.trigger);
    container.appendChild(picker.panel);

    // --- End-Frame Upload Picker (FLF i2v models — kling/veo/seedance/etc.) ---
    // Shown only when imageMode is on AND the selected i2v model declares a
    // `lastImageField` in its catalog entry. Reuses the same UploadPicker UI;
    // a corner badge differentiates it from the start-frame picker.
    const endPicker = createUploadPicker({
        anchorContainer: container,
        onSelect: ({ url }) => { uploadedEndImageUrl = url; },
        onClear: () => { uploadedEndImageUrl = null; },
        uploadFn: (file) => isHivemindVideoModelId(selectedModel)
            ? uploadFileToHivemindStudio(file)
            : (isWan2gpModelId(selectedModel) ? localAI.uploadFileToWan2gp(file) : muapi.uploadFile(file)),
        requireApiKey: () => !isWan2gpModelId(selectedModel) && !isHivemindVideoModelId(selectedModel),
    });
    endPicker.trigger.title = 'End frame (optional)';
    // Visual marker: small "L" badge in the corner so users can tell the two
    // pickers apart at a glance. The wrapper keeps it from interfering with
    // UploadPicker's own thumbnail/spinner state swapping.
    const endBadge = document.createElement('div');
    endBadge.className = 'absolute top-0.5 left-0.5 px-1 h-4 bg-white/20 rounded-md flex items-center justify-center pointer-events-none';
    endBadge.innerHTML = '<span class="text-[8px] font-black text-white leading-none">END</span>';
    endPicker.trigger.appendChild(endBadge);
    endPicker.trigger.classList.add('hidden'); // start hidden until updateEndFrameVisibility flips it on
    topRow.appendChild(endPicker.trigger);
    container.appendChild(endPicker.panel);

    const updateEndFrameVisibility = () => {
        const model = getCurrentModel();
        const supports = imageMode && !!model?.lastImageField;
        if (supports) {
            endPicker.trigger.classList.remove('hidden');
            endPicker.trigger.classList.add('flex');
        } else {
            endPicker.trigger.classList.add('hidden');
            endPicker.trigger.classList.remove('flex');
            // Drop any stale end-frame selection when leaving FLF-capable state
            if (uploadedEndImageUrl) {
                uploadedEndImageUrl = null;
                endPicker.reset();
            }
        }
    };

    // --- Video Upload Picker (Video-to-Video) ---
    const videoFileInput = document.createElement('input');
    videoFileInput.type = 'file';
    videoFileInput.accept = 'video/*';
    videoFileInput.className = 'hidden';

    const videoPickerBtn = document.createElement('button');
    videoPickerBtn.type = 'button';
    videoPickerBtn.title = 'Upload a source video';
    videoPickerBtn.className = 'w-10 h-10 shrink-0 rounded-xl border transition-all flex items-center justify-center relative overflow-hidden mt-1.5 bg-white/5 border-white/10 hover:bg-white/10 hover:border-primary/40 group';

    const videoIconEl = document.createElement('div');
    videoIconEl.className = 'flex items-center justify-center w-full h-full';
    videoIconEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-muted group-hover:text-primary transition-colors"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;

    const videoSpinnerEl = document.createElement('div');
    videoSpinnerEl.className = 'hidden items-center justify-center w-full h-full';
    videoSpinnerEl.innerHTML = `<span class="animate-spin text-primary text-sm">◌</span>`;

    const videoReadyEl = document.createElement('div');
    videoReadyEl.className = 'hidden items-center justify-center w-full h-full';
    videoReadyEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-primary"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><polyline points="7 10 10 13 15 8" stroke="#22d3ee" stroke-width="2.5"/></svg>`;

    videoPickerBtn.appendChild(videoFileInput);
    videoPickerBtn.appendChild(videoIconEl);
    videoPickerBtn.appendChild(videoSpinnerEl);
    videoPickerBtn.appendChild(videoReadyEl);

    const showVideoIcon = () => {
        videoIconEl.classList.replace('hidden', 'flex');
        videoSpinnerEl.classList.add('hidden'); videoSpinnerEl.classList.remove('flex');
        videoReadyEl.classList.add('hidden'); videoReadyEl.classList.remove('flex');
        videoPickerBtn.classList.remove('border-primary/60');
        videoPickerBtn.classList.add('border-white/10');
        videoPickerBtn.title = 'Upload a source video';
    };

    const showVideoSpinner = () => {
        videoIconEl.classList.add('hidden'); videoIconEl.classList.remove('flex');
        videoSpinnerEl.classList.replace('hidden', 'flex');
        videoReadyEl.classList.add('hidden'); videoReadyEl.classList.remove('flex');
    };

    const showVideoReady = (filename) => {
        videoIconEl.classList.add('hidden'); videoIconEl.classList.remove('flex');
        videoSpinnerEl.classList.add('hidden'); videoSpinnerEl.classList.remove('flex');
        videoReadyEl.classList.replace('hidden', 'flex');
        videoPickerBtn.classList.remove('border-white/10');
        videoPickerBtn.classList.add('border-primary/60');
        videoPickerBtn.title = `${filename} — click to clear`;
    };

    const clearVideoUpload = () => {
        const wasHivemindVideo = isHivemindVideoInputMode();
        uploadedVideoUrl = null;
        uploadedVideoName = null;
        showVideoIcon();
        // Motion-control v2v: keep the model and image; user can re-upload a video
        if (isMotionControlV2V()) {
            textarea.placeholder = 'Upload a reference video using the 🎥 button';
            return;
        }
        if (wasHivemindVideo) {
            imageMode = false;
            selectedModel = allT2V[0].id;
            selectedModelName = allT2V[0].name;
            document.getElementById('v-model-btn-label').textContent = selectedModelName;
            updateControlsForModel(selectedModel);
            persistVideoPreferences();
            textarea.placeholder = 'Describe the video you want to create';
            textarea.disabled = false;
            return;
        }
        v2vMode = false;
        selectedModel = allT2V[0].id;
        selectedModelName = allT2V[0].name;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Describe the video you want to create';
        textarea.disabled = false;
    };

    videoPickerBtn.onclick = (e) => {
        e.stopPropagation();
        if (uploadedVideoUrl) {
            clearVideoUpload();
        } else {
            videoFileInput.click();
        }
    };

    videoFileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const currentHive = getHivemindVideoModelById(selectedModel);
        const preferredHive = currentHive?.supportsVideoInput
            ? currentHive
            : (hivemindI2V.find((model) => model.workflowId === 'ltx23-eros-fast' && model.supportsVideoInput)
                || hivemindI2V.find((model) => model.supportsVideoInput));
        const useHivemind = Boolean(preferredHive && isHivemindStudioEnabled());
        const apiKey = localStorage.getItem('muapi_key');
        if (!useHivemind && !apiKey) {
            AuthModal(() => videoFileInput.click());
            return;
        }

        showVideoSpinner();
        try {
            const upload = useHivemind
                ? await uploadFileToHivemindStudio(file)
                : { url: await muapi.uploadFile(file) };
            const url = upload.url;
            uploadedVideoUrl = url;
            uploadedVideoName = file.name;
            showVideoReady(file.name);

            if (useHivemind) {
                picker.reset();
                endPicker.reset();
                uploadedImageUrl = null;
                uploadedEndImageUrl = null;
                v2vMode = false;
                imageMode = true;
                selectedModel = preferredHive.id;
                selectedModelName = preferredHive.name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
                textarea.placeholder = 'Describe how the shot should continue';
                textarea.disabled = false;
            // If a motion-control v2v model is already selected, keep it and the image upload
            } else if (isMotionControlV2V()) {
                textarea.disabled = false;
                textarea.placeholder = uploadedImageUrl
                    ? (getCurrentModel()?.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)')
                    : 'Now upload a reference image using the 🖼 button';
            } else {
                // Default v2v flow (e.g. watermark remover) — auto-pick the first v2v model
                if (imageMode) {
                    picker.reset();
                    uploadedImageUrl = null;
                    imageMode = false;
                }
                v2vMode = true;
                selectedModel = v2vModels[0].id;
                selectedModelName = v2vModels[0].name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
                textarea.placeholder = 'Video ready — click Generate to remove watermark';
                textarea.disabled = true;
            }
        } catch (err) {
            console.error('[VideoStudio] Video upload failed:', err);
            showVideoIcon();
            alert(`Video upload failed: ${err.message}`);
        }
        videoFileInput.value = '';
    };

    topRow.appendChild(videoPickerBtn);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Describe the video you want to create';
    textarea.className = 'flex-1 bg-transparent border-none text-white text-base md:text-xl placeholder:text-muted focus:outline-none resize-none pt-2.5 leading-relaxed min-h-[40px] max-h-[150px] md:max-h-[250px] overflow-y-auto custom-scrollbar';
    textarea.rows = 1;
    textarea.oninput = () => {
        textarea.style.height = 'auto';
        const maxHeight = window.innerWidth < 768 ? 150 : 250;
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    };

    topRow.appendChild(textarea);
    bar.appendChild(topRow);

    // Extend mode banner (shown when extend model is active, not editable by user)
    const extendBanner = document.createElement('div');
    extendBanner.className = 'hidden items-center gap-2 px-4 py-2 mx-2 mt-2 bg-primary/10 border border-primary/20 rounded-xl text-xs text-primary';
    extendBanner.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        <span>Extending previous Seedance 2.0 generation — add an optional prompt to guide the continuation</span>
    `;
    bar.appendChild(extendBanner);

    // Bottom Row: Controls
    const bottomRow = document.createElement('div');
    bottomRow.className = 'flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 px-2 pt-4 border-t border-white/5';

    const controlsLeft = document.createElement('div');
    controlsLeft.className = 'flex items-center gap-1.5 md:gap-2.5 relative overflow-x-auto no-scrollbar pb-1 md:pb-0';

    const createControlBtn = (icon, label, id, tooltip) => {
        const btn = document.createElement('button');
        btn.id = id;
        btn.className = 'flex items-center gap-1.5 md:gap-2.5 px-3 md:px-4 py-2 md:py-2.5 bg-white/5 hover:bg-white/10 rounded-xl md:rounded-2xl transition-all border border-white/5 group whitespace-nowrap';
        if (tooltip) btn.setAttribute('data-tooltip', tooltip);
        btn.innerHTML = `
            ${icon}
            <span id="${id}-label" class="text-xs font-bold text-white group-hover:text-primary transition-colors">${label}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" class="opacity-20 group-hover:opacity-100 transition-opacity"><path d="M6 9l6 6 6-6"/></svg>
        `;
        return btn;
    };

    const modelBtn = createControlBtn(`
        <div class="w-5 h-5 bg-primary rounded-md flex items-center justify-center shadow-lg shadow-primary/20">
            <span class="text-[10px] font-black text-black">V</span>
        </div>
    `, selectedModelName, 'v-model-btn', 'Select AI video model');

    const arBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
    `, selectedAr, 'v-ar-btn', 'Change aspect ratio');

    const durationBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    `, `${selectedDuration}s`, 'v-duration-btn', 'Set video duration');

    const resolutionBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M6 2L3 6v15a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z"/></svg>
    `, selectedResolution || '720p', 'v-resolution-btn', 'Set output resolution');

    const qualityBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
    `, selectedQuality || 'basic', 'v-quality-btn', 'Set output quality');

    const modeBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    `, selectedMode || 'normal', 'v-mode-btn');

    const effectNameBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"/></svg>
    `, 'Effect', 'v-effect-btn', 'Select effect type');

    controlsLeft.appendChild(modelBtn);
    controlsLeft.appendChild(arBtn);
    controlsLeft.appendChild(durationBtn);
    controlsLeft.appendChild(resolutionBtn);
    controlsLeft.appendChild(qualityBtn);
    controlsLeft.appendChild(effectNameBtn);

    // Advanced options toggle button
    const advancedBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 001.82-.33 1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-1.82.33A1.65 1.65 0 0019.4 9a1.65 1.65 0 00-1.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    `, 'Advanced', 'v-advanced-btn', 'Show advanced options');
    controlsLeft.appendChild(advancedBtn);

    // Initial visibility (t2v mode)
    const initDurations = getDurationsForModel(defaultModel.id);
    durationBtn.style.display = initDurations.length > 0 ? 'flex' : 'none';
    const initResolutions = getResolutionsForVideoModel(defaultModel.id);
    resolutionBtn.style.display = initResolutions.length > 0 ? 'flex' : 'none';
    qualityBtn.style.display = 'none';
    modeBtn.style.display = getModesForModel(defaultModel.id).length > 0 ? 'flex' : 'none';
    effectNameBtn.style.display = 'none';

    const generateBtn = document.createElement('button');
    generateBtn.className = 'bg-primary text-black px-6 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-[1.5rem] font-black text-sm md:text-base hover:shadow-glow hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2.5 w-full sm:w-auto shadow-lg';
    generateBtn.setAttribute('data-tooltip', 'Generate AI video from prompt');
    generateBtn.innerHTML = t('common.generate');

    const controlsRight = document.createElement('div');
    controlsRight.className = 'flex items-center justify-end gap-3 w-full sm:w-auto shrink-0';

    const pingToggleLabel = document.createElement('label');
    pingToggleLabel.className = 'flex items-center gap-2.5 px-2 py-2 cursor-pointer select-none shrink-0';
    pingToggleLabel.title = t('video.pingWhenComplete');
    pingToggleLabel.innerHTML = `
        <span class="relative w-9 h-5 shrink-0">
            <input data-video-completion-ping type="checkbox" class="peer absolute inset-0 w-full h-full opacity-0 cursor-pointer" aria-label="${t('video.pingWhenComplete')}">
            <span class="absolute inset-0 rounded-full bg-white/10 border border-white/10 transition-colors peer-checked:bg-primary/30 peer-checked:border-primary/60"></span>
            <span class="absolute left-[3px] top-[3px] w-3.5 h-3.5 rounded-full bg-white/60 transition-all peer-checked:translate-x-4 peer-checked:bg-primary"></span>
        </span>
        <span class="text-[11px] font-bold text-secondary whitespace-nowrap">${t('video.pingWhenComplete')}</span>
    `;
    const pingToggleInput = pingToggleLabel.querySelector('[data-video-completion-ping]');
    pingToggleInput.checked = pingWhenComplete;

    bottomRow.appendChild(controlsLeft);
    controlsRight.appendChild(pingToggleLabel);
    controlsRight.appendChild(generateBtn);
    bottomRow.appendChild(controlsRight);
    bar.appendChild(bottomRow);
    promptWrapper.appendChild(bar);
    container.appendChild(promptWrapper);

    const generationProgressView = document.createElement('div');
    generationProgressView.id = 'video-generation-progress';
    generationProgressView.className = 'video-generation-stage absolute inset-0 z-50 flex items-start justify-center p-4 md:p-8 opacity-0 pointer-events-none translate-y-4 transition-all duration-500';
    generationProgressView.setAttribute('role', 'status');
    generationProgressView.setAttribute('aria-live', 'polite');
    generationProgressView.setAttribute('aria-hidden', 'true');
    generationProgressView.innerHTML = `
        <div class="video-generation-card w-full max-w-[440px] bg-[#101313] border border-white/10 rounded-2xl p-4 md:p-5 shadow-3xl">
            <div class="flex items-center justify-between gap-4 mb-4">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="video-generation-icon w-10 h-10 shrink-0 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-black text-white">${t('video.progressTitle')}</p>
                        <p data-video-progress-model class="text-[11px] text-secondary truncate mt-0.5"></p>
                    </div>
                </div>
                <span data-video-progress-value class="shrink-0 text-xs font-black text-primary tabular-nums">${t('video.progress.inProgress')}</span>
            </div>

            <div class="video-generation-preview relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black/40">
                <img data-video-progress-preview alt="" class="hidden absolute inset-0 w-full h-full object-cover opacity-70">
                <div data-video-progress-placeholder class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                    <div class="video-generation-frames flex items-center gap-2 text-white/20">
                        <span></span><span></span><span></span>
                    </div>
                </div>
                <div class="video-generation-scan" aria-hidden="true"></div>
                <div class="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2 bg-black/70">
                    <span class="video-generation-live-dot w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true"></span>
                    <span data-video-progress-status class="text-[11px] font-bold text-white">${t('video.progress.preparing')}</span>
                </div>
            </div>

            <div class="mt-4">
                <div data-video-progress-track data-progress-mode="indeterminate" class="video-generation-progress-track h-1.5 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-label="Video generation progress">
                    <div data-video-progress-fill class="video-generation-progress-fill h-full rounded-full bg-primary"></div>
                </div>
                <div class="mt-2 flex items-center justify-between text-[10px] text-muted">
                    <span data-video-progress-detail>${t('video.progress.rendering')}</span>
                    <span class="tabular-nums"><span>${t('video.progress.elapsed')}</span> <span data-video-progress-elapsed>0:00</span></span>
                </div>
            </div>
        </div>
    `;
    container.appendChild(generationProgressView);

    const generationProgressModel = generationProgressView.querySelector('[data-video-progress-model]');
    const generationProgressValue = generationProgressView.querySelector('[data-video-progress-value]');
    const generationProgressPreview = generationProgressView.querySelector('[data-video-progress-preview]');
    const generationProgressPlaceholder = generationProgressView.querySelector('[data-video-progress-placeholder]');
    const generationProgressStatus = generationProgressView.querySelector('[data-video-progress-status]');
    const generationProgressTrack = generationProgressView.querySelector('[data-video-progress-track]');
    const generationProgressFill = generationProgressView.querySelector('[data-video-progress-fill]');
    const generationProgressDetail = generationProgressView.querySelector('[data-video-progress-detail]');
    const generationProgressElapsed = generationProgressView.querySelector('[data-video-progress-elapsed]');

    // ==========================================
    // 3. DROPDOWNS
    // ==========================================
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute bottom-[102%] left-2 z-50 transition-all opacity-0 pointer-events-none scale-95 origin-bottom-left glass rounded-3xl p-3 translate-y-2 w-[calc(100vw-3rem)] max-w-xs shadow-4xl border border-white/10 flex flex-col';

    const updateControlsForModel = (modelId) => {
        const model = getCurrentModels().find(m => m.id === modelId);
        const localVideoInput = isHivemindVideoInputMode();

        // End-frame picker visibility depends on imageMode + model.lastImageField.
        updateEndFrameVisibility();

        // In v2v mode, hide all parameter controls — no prompt/AR/duration/etc needed
        if (v2vMode) {
            arBtn.style.display = 'none';
            durationBtn.style.display = 'none';
            resolutionBtn.style.display = 'none';
            qualityBtn.style.display = 'none';
            modeBtn.style.display = 'none';
            effectNameBtn.style.display = 'none';
            extendBanner.classList.add('hidden');
            extendBanner.classList.remove('flex');
            return;
        }

        // Aspect ratio
        const availableArs = getCurrentAspectRatios(modelId);
        if (!localVideoInput && availableArs.length > 0) {
            selectedAr = availableArs[0];
            document.getElementById('v-ar-btn-label').textContent = selectedAr;
            arBtn.style.display = 'flex';
        } else {
            arBtn.style.display = 'none';
        }

        // Duration
        const durations = getCurrentDurations(modelId);
        if (durations.length > 0) {
            selectedDuration = durations[0];
            document.getElementById('v-duration-btn-label').textContent = `${selectedDuration}s`;
            durationBtn.style.display = 'flex';
        } else {
            durationBtn.style.display = 'none';
        }

        // Resolution
        const resolutions = getCurrentResolutions(modelId);
        if (resolutions.length > 0) {
            selectedResolution = resolutions[0];
            document.getElementById('v-resolution-btn-label').textContent = selectedResolution;
            resolutionBtn.style.display = 'flex';
        } else {
            resolutionBtn.style.display = 'none';
        }

        // Quality
        const qualities = getQualitiesForModel(modelId);
        if (qualities.length > 0) {
            selectedQuality = model?.inputs?.quality?.default || qualities[0];
            document.getElementById('v-quality-btn-label').textContent = selectedQuality;
            qualityBtn.style.display = 'flex';
        } else {
            selectedQuality = '';
            qualityBtn.style.display = 'none';
        }

        // Mode
        const modes = getCurrentModes(modelId);
        if (modes.length > 0) {
            selectedMode = model?.inputs?.mode?.default || modes[0];
            document.getElementById('v-mode-btn-label').textContent = selectedMode;
            modeBtn.style.display = 'flex';
        } else {
            selectedMode = '';
            modeBtn.style.display = 'none';
        }

        // Effect name (ai-video-effects / motion-controls)
        const effectNames = getEffectNamesForModel(modelId);
        if (effectNames.length > 0) {
            selectedEffectName = model?.inputs?.name?.default || effectNames[0];
            document.getElementById('v-effect-btn-label').textContent = selectedEffectName;
            effectNameBtn.style.display = 'flex';
        } else {
            selectedEffectName = '';
            effectNameBtn.style.display = 'none';
        }

        // Extend banner (extend model only)
        if (localVideoInput) {
            extendBanner.querySelector('span').textContent = 'Extending the uploaded LTX shot; duration controls how much new footage is appended';
            extendBanner.classList.remove('hidden');
            extendBanner.classList.add('flex');
        } else if (model?.requiresRequestId) {
            extendBanner.querySelector('span').textContent = 'Extending previous Seedance 2.0 generation; add an optional prompt to guide the continuation';
            extendBanner.classList.remove('hidden');
            extendBanner.classList.add('flex');
        } else {
            extendBanner.classList.add('hidden');
            extendBanner.classList.remove('flex');
        }
    };

    const persistVideoPreferences = () => {
        const preferences = normalizeVideoPreferences({
            modelId: selectedModel,
            duration: selectedDuration,
        });
        if (!preferences) return;
        persistedVideoPreferences = preferences;
        try {
            localStorage.setItem(VIDEO_PREFERENCES_KEY, JSON.stringify(preferences));
        } catch {}
    };

    const restorePersistedVideoPreferences = () => {
        const preferences = persistedVideoPreferences;
        if (!preferences) return false;

        const v2vModel = v2vModels.find((model) => model.id === preferences.modelId);
        const i2vModel = allI2V.find((model) => model.id === preferences.modelId);
        const t2vModel = allT2V.find((model) => model.id === preferences.modelId);
        const target = v2vModel || i2vModel || t2vModel;
        if (!target) return false;

        v2vMode = Boolean(v2vModel);
        imageMode = !v2vMode && Boolean(i2vModel);
        selectedModel = target.id;
        selectedModelName = target.name;
        const label = document.getElementById('v-model-btn-label');
        if (label) label.textContent = selectedModelName;
        updateControlsForModel(selectedModel);

        const matchingDuration = getCurrentDurations(selectedModel)
            .find((duration) => Number(duration) === preferences.duration);
        if (matchingDuration != null) {
            selectedDuration = matchingDuration;
            const durationLabel = document.getElementById('v-duration-btn-label');
            if (durationLabel) durationLabel.textContent = `${selectedDuration}s`;
        }

        if (v2vMode) {
            textarea.disabled = !target.imageField;
            textarea.placeholder = target.imageField
                ? (target.promptRequired
                    ? 'Upload a reference video and image, then describe the motion'
                    : 'Upload a reference video and image, then describe the motion (optional)')
                : 'Upload a video using the 🎥 button, then click Generate';
        } else if (imageMode) {
            textarea.disabled = false;
            textarea.placeholder = isHivemindVideoModelId(selectedModel)
                ? 'Upload a start frame image, then describe the motion'
                : 'Describe the motion or effect (optional)';
        } else {
            textarea.disabled = false;
            textarea.placeholder = 'Describe the video you want to create';
        }
        return true;
    };

    const selectHivemindWorkflowModel = (modelId) => {
        const target = allI2V.find(m => m.id === modelId);
        if (!target) return false;
        if (v2vMode) {
            v2vMode = false;
            uploadedVideoUrl = null;
            showVideoIcon();
        }
        imageMode = true;
        selectedModel = target.id;
        selectedModelName = target.name;
        const label = document.getElementById('v-model-btn-label');
        if (label) label.textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = uploadedImageUrl ? 'Describe the motion or effect (optional)' : 'Upload a start frame image, then describe the motion';
        textarea.disabled = false;
        return true;
    };

    const refreshHivemindWorkflows = async () => {
        const context = await loadHivemindStudioContext();
        hivemindI2V = context.videoModels.map(adaptHivemindToVideoEntry);
        allI2V = [...hivemindI2V, ...i2vModels, ...localI2V];
        const restoredPreference = restorePersistedVideoPreferences();
        if (!restoredPreference) {
            const saved = getSavedHivemindVideoSelection();
            if (saved?.modelId) selectHivemindWorkflowModel(saved.modelId);
        }
        if (dropdownOpen === 'model') showDropdown('model', modelBtn);
    };
    restorePersistedVideoPreferences();
    void refreshHivemindWorkflows();
    window.addEventListener('hivemind-workflow-selected', (event) => {
        const modelId = event.detail?.modelId;
        if (!modelId) return;
        if (selectHivemindWorkflowModel(modelId)) return;
        refreshHivemindWorkflows().then(() => selectHivemindWorkflowModel(modelId));
    });

    const showDropdown = (type, anchorBtn) => {
        dropdown.innerHTML = '';
        dropdown.classList.remove('opacity-0', 'pointer-events-none');
        dropdown.classList.add('opacity-100', 'pointer-events-auto');

        if (type === 'model') {
            dropdown.classList.add('w-[calc(100vw-3rem)]', 'max-w-xs');
            dropdown.classList.remove('max-w-[240px]', 'max-w-[200px]');
            dropdown.innerHTML = `
                <div class="flex flex-col h-full max-h-[70vh]">
                    <div class="px-2 pb-3 mb-2 border-b border-white/5 shrink-0">
                        <div class="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2.5 border border-white/5 focus-within:border-primary/50 transition-colors">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-muted"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                            <input type="text" id="v-model-search" placeholder="${t('common.searchModels')}" class="bg-transparent border-none text-xs text-white focus:ring-0 w-full p-0">
                        </div>
                    </div>
                    <div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 shrink-0">Video models</div>
                    <div id="v-model-list-container" class="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2"></div>
                </div>
            `;
            const list = dropdown.querySelector('#v-model-list-container');

            const makeModelItem = (m, isV2V = false) => {
                const item = document.createElement('div');
                item.className = `flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all border border-transparent hover:border-white/5 ${selectedModel === m.id ? 'bg-white/5 border-white/5' : ''}`;
                const isHive = isHivemindVideoModelId(m.id);
                const isWan = isWan2gpModelId(m.id);
                const iconColor = isV2V ? 'bg-orange-500/10 text-orange-400' : isHive ? 'bg-emerald-500/10 text-emerald-300' : m.id.includes('kling') ? 'bg-blue-500/10 text-blue-400' : m.id.includes('veo') ? 'bg-purple-500/10 text-purple-400' : m.id.includes('sora') ? 'bg-rose-500/10 text-rose-400' : 'bg-primary/10 text-primary';
                item.innerHTML = `
                    <div class="flex items-center gap-3.5">
                         <div class="w-10 h-10 ${iconColor} border border-white/5 rounded-xl flex items-center justify-center font-black text-sm shadow-inner uppercase">${m.name.charAt(0)}</div>
                         <div class="flex flex-col gap-0.5">
                            <span class="text-xs font-bold text-white tracking-tight">${m.name}</span>
                            ${isV2V ? `<span class="text-[9px] text-orange-400/70">${m.imageField ? 'Upload a video and image' : 'Upload a video to use'}</span>` : ''}
                            ${isHive ? '<span class="text-[9px] text-emerald-300/75">Hivemind local workflow</span>' : ''}
                            ${isWan ? '<span class="text-[9px] text-primary/75">Wan2GP local server</span>' : ''}
                         </div>
                    </div>
                    ${selectedModel === m.id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    if (isV2V) {
                        // Switch to v2v mode
                        v2vMode = true;
                        imageMode = false;
                        const isMC = !!m.imageField;
                        if (!isMC) {
                            // Single-input v2v (watermark remover etc.) — drop any image
                            picker.reset();
                            uploadedImageUrl = null;
                        }
                        selectedModel = m.id;
                        selectedModelName = m.name;
                        document.getElementById('v-model-btn-label').textContent = selectedModelName;
                        updateControlsForModel(selectedModel);
                        persistVideoPreferences();
                        if (isMC) {
                            textarea.placeholder = m.promptRequired
                                ? 'Upload a reference video and image, then describe the motion'
                                : 'Upload a reference video and image, then describe the motion (optional)';
                            textarea.disabled = false;
                        } else {
                            textarea.placeholder = 'Upload a video using the 🎥 button, then click Generate';
                            textarea.disabled = true;
                        }
                    } else {
                        if (isHive && selectHivemindWorkflowModel(m.id)) {
                            closeDropdown();
                            return;
                        }
                        // Leaving v2v mode if was in it
                        if (v2vMode) {
                            v2vMode = false;
                            uploadedVideoUrl = null;
                            showVideoIcon();
                            textarea.disabled = false;
                        }
                        selectedModel = m.id;
                        selectedModelName = m.name;
                        document.getElementById('v-model-btn-label').textContent = selectedModelName;
                        updateControlsForModel(selectedModel);
                        persistVideoPreferences();
                        textarea.placeholder = imageMode ? 'Describe the motion or effect (optional)' : 'Describe the video you want to create';
                    }
                    closeDropdown();
                };
                return item;
            };

            const renderModels = (filter = '') => {
                list.innerHTML = '';
                const lf = filter.toLowerCase();

                // Regular generation models (always t2v or i2v, never v2v)
                const generationModels = imageMode ? allI2V : [...hivemindI2V, ...allT2V];
                const filteredMain = generationModels
                    .filter(m => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf));
                filteredMain.forEach(m => list.appendChild(makeModelItem(m, false)));

                // Video Tools section
                const filteredV2V = v2vModels.filter(m => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf));
                if (filteredV2V.length > 0) {
                    const sectionLabel = document.createElement('div');
                    sectionLabel.className = 'text-[10px] font-bold text-orange-400/70 uppercase tracking-widest px-3 py-2 mt-1 border-t border-white/5';
                    sectionLabel.textContent = t('video.videoTools');
                    list.appendChild(sectionLabel);
                    filteredV2V.forEach(m => list.appendChild(makeModelItem(m, true)));
                }
            };

            renderModels();
            const searchInput = dropdown.querySelector('#v-model-search');
            searchInput.onclick = (e) => e.stopPropagation();
            searchInput.oninput = (e) => renderModels(e.target.value);

        } else if (type === 'ar') {
            dropdown.classList.add('max-w-[240px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-muted uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Aspect Ratio</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const availableArs = getCurrentAspectRatios(selectedModel);
            availableArs.forEach(r => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <div class="flex items-center gap-4">
                        <div class="w-6 h-6 border-2 border-white/20 rounded-md shadow-inner flex items-center justify-center group-hover:border-primary/50 transition-colors">
                             <div class="w-3 h-3 bg-white/10 rounded-sm"></div>
                        </div>
                        <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 transition-opacity">${r}</span>
                    </div>
                     ${selectedAr === r ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedAr = r;
                    document.getElementById('v-ar-btn-label').textContent = r;
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'duration') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Duration</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const durations = getCurrentDurations(selectedModel);
            durations.forEach(d => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${d}s</span>
                     ${selectedDuration === d ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedDuration = d;
                    document.getElementById('v-duration-btn-label').textContent = `${d}s`;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'quality') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Quality</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            getQualitiesForModel(selectedModel).forEach(q => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 capitalize">${q}</span>
                    ${selectedQuality === q ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedQuality = q;
                    document.getElementById('v-quality-btn-label').textContent = q;
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'resolution') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Resolution</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const resolutions = getCurrentResolutions(selectedModel);
            resolutions.forEach(r => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${r}</span>
                     ${selectedResolution === r ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedResolution = r;
                    document.getElementById('v-resolution-btn-label').textContent = r;
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'mode') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Mode</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            getCurrentModes(selectedModel).forEach(m => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 capitalize">${m}</span>
                    ${selectedMode === m ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedMode = m;
                    document.getElementById('v-mode-btn-label').textContent = m;
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'effect') {
            dropdown.classList.add('max-w-[240px]');
            dropdown.classList.remove('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Effect Type</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1 max-h-[50vh] overflow-y-auto custom-scrollbar';
            getEffectNamesForModel(selectedModel).forEach(e => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${e}</span>
                    ${selectedEffectName === e ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (ev) => {
                    ev.stopPropagation();
                    selectedEffectName = e;
                    document.getElementById('v-effect-btn-label').textContent = e;
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);
        }

        // Position dropdown
        const btnRect = anchorBtn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (window.innerWidth < 768) {
            dropdown.style.left = '50%';
            dropdown.style.transform = 'translateX(-50%) translate(0, 8px)';
        } else {
            dropdown.style.left = `${btnRect.left - containerRect.left}px`;
            dropdown.style.transform = 'translate(0, 8px)';
        }
        dropdown.style.bottom = `${containerRect.bottom - btnRect.top + 8}px`;
    };

    const closeDropdown = () => {
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        dropdown.classList.remove('opacity-100', 'pointer-events-auto');
        dropdownOpen = null;
    };

    const toggleDropdown = (type, btn) => (e) => {
        e.stopPropagation();
        if (dropdownOpen === type) closeDropdown();
        else { dropdownOpen = type; showDropdown(type, btn); }
    };

    modelBtn.onclick = toggleDropdown('model', modelBtn);
    arBtn.onclick = toggleDropdown('ar', arBtn);
    durationBtn.onclick = toggleDropdown('duration', durationBtn);
    resolutionBtn.onclick = toggleDropdown('resolution', resolutionBtn);
    qualityBtn.onclick = toggleDropdown('quality', qualityBtn);
    modeBtn.onclick = toggleDropdown('mode', modeBtn);
    effectNameBtn.onclick = toggleDropdown('effect', effectNameBtn);

    window.addEventListener('click', closeDropdown);
    container.appendChild(dropdown);

    // ==========================================
    // 4. CANVAS AREA + HISTORY
    // ==========================================
    const generationHistory = [];
    const generationContexts = new Map();

    const historySidebar = document.createElement('div');
    historySidebar.className = 'fixed right-0 top-0 h-full w-20 md:w-24 bg-black/60 backdrop-blur-xl border-l border-white/5 z-50 flex flex-col items-center py-4 gap-3 overflow-y-auto transition-all duration-500 translate-x-full opacity-0';
    historySidebar.id = 'video-history-sidebar';

    const historyLabel = document.createElement('div');
    historyLabel.className = 'text-[9px] font-bold text-muted uppercase tracking-widest mb-2';
    historyLabel.textContent = t('video.history');
    historySidebar.appendChild(historyLabel);

    const historyList = document.createElement('div');
    historyList.className = 'flex flex-col gap-2 w-full px-2';
    historySidebar.appendChild(historyList);
    container.appendChild(historySidebar);

    // Main canvas
    const canvas = document.createElement('div');
    canvas.className = 'absolute inset-0 flex flex-col items-center justify-center p-4 min-[800px]:p-16 z-10 opacity-0 pointer-events-none transition-all duration-1000 translate-y-10 scale-95';

    const videoContainer = document.createElement('div');
    videoContainer.className = 'relative group';

    const resultVideo = document.createElement('video');
    resultVideo.className = 'max-h-[60vh] max-w-[80vw] rounded-3xl shadow-3xl border border-white/10 interactive-glow object-contain';
    resultVideo.controls = true;
    resultVideo.loop = true;
    resultVideo.autoplay = true;
    resultVideo.muted = true;
    resultVideo.playsInline = true;
    videoContainer.appendChild(resultVideo);

    // Canvas Controls
    const canvasControls = document.createElement('div');
    canvasControls.className = 'mt-6 flex flex-wrap gap-2.5 opacity-0 transition-opacity delay-500 duration-500 justify-center';

    const backToSetupBtn = document.createElement('button');
    backToSetupBtn.className = 'bg-white/10 hover:bg-white/20 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white flex items-center gap-2';
    backToSetupBtn.title = t('video.backToSetup');
    backToSetupBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span>${t('video.backToSetup')}</span>`;

    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'bg-white/10 hover:bg-white/20 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    regenerateBtn.textContent = t('video.regenerate');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'bg-primary text-black px-6 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-glow active:scale-95';
    downloadBtn.textContent = t('video.download');

    const extendBtn = document.createElement('button');
    extendBtn.className = 'hidden bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-primary/30 text-primary backdrop-blur-lg';
    extendBtn.textContent = t('video.extend');
    extendBtn.title = 'Extend this video using Seedance 2.0 Extend';

    const newPromptBtn = document.createElement('button');
    newPromptBtn.className = 'bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    newPromptBtn.textContent = t('video.new');

    canvasControls.appendChild(backToSetupBtn);
    canvasControls.appendChild(regenerateBtn);
    canvasControls.appendChild(extendBtn);
    canvasControls.appendChild(downloadBtn);
    canvasControls.appendChild(newPromptBtn);

    canvas.appendChild(videoContainer);
    canvas.appendChild(canvasControls);
    container.appendChild(canvas);

    let generationProgressTimer = null;
    let generationStartedAt = 0;

    const getCompletionAudioContext = () => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!completionAudioContext || completionAudioContext.state === 'closed') {
            completionAudioContext = new AudioContextClass();
        }
        return completionAudioContext;
    };

    const primeCompletionPing = async () => {
        if (!pingWhenComplete) return;
        const audioContext = getCompletionAudioContext();
        if (!audioContext) return;
        try {
            if (audioContext.state !== 'running') await audioContext.resume();
            if (audioContext.state !== 'running') return;
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            oscillator.start();
            oscillator.stop(audioContext.currentTime + 0.01);
        } catch (error) {
            console.warn('[VideoStudio] Completion ping could not be enabled:', error?.message || 'audio unavailable');
        }
    };

    const playCompletionPing = async () => {
        if (!pingWhenComplete) return;
        const audioContext = getCompletionAudioContext();
        if (!audioContext) return;

        try {
            if (audioContext.state !== 'running') await audioContext.resume();
            if (audioContext.state !== 'running') return;
            const start = audioContext.currentTime + 0.02;
            [[659.25, start, 0.2], [880, start + 0.16, 0.34]].forEach(([frequency, noteStart, duration]) => {
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                oscillator.type = 'triangle';
                oscillator.frequency.setValueAtTime(frequency, noteStart);
                gain.gain.setValueAtTime(0.0001, noteStart);
                gain.gain.linearRampToValueAtTime(0.2, noteStart + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
                oscillator.connect(gain);
                gain.connect(audioContext.destination);
                oscillator.start(noteStart);
                oscillator.stop(noteStart + duration + 0.02);
            });
        } catch (error) {
            console.warn('[VideoStudio] Completion ping could not play:', error?.message || 'audio unavailable');
        }
    };

    pingToggleInput.onchange = () => {
        pingWhenComplete = Boolean(pingToggleInput.checked);
        try {
            sessionStorage.setItem(VIDEO_COMPLETION_PING_KEY, pingWhenComplete ? '1' : '0');
        } catch {}
        if (pingWhenComplete) void playCompletionPing();
    };

    const updateGenerationProgress = ({ status = '', progress = null, stage = '' } = {}) => {
        const normalized = normalizeVideoGenerationProgress(progress);
        const stageName = stage || classifyVideoGenerationStage(status);
        const stageLabel = t(`video.progress.${stageName}`);
        generationProgressStatus.textContent = stageLabel;

        if (normalized == null) {
            generationProgressTrack.dataset.progressMode = 'indeterminate';
            generationProgressTrack.removeAttribute('aria-valuenow');
            generationProgressFill.style.removeProperty('width');
            generationProgressValue.textContent = t('video.progress.inProgress');
            return;
        }

        const percent = Math.round(normalized * 100);
        generationProgressTrack.dataset.progressMode = 'determinate';
        generationProgressTrack.setAttribute('aria-valuemin', '0');
        generationProgressTrack.setAttribute('aria-valuemax', '100');
        generationProgressTrack.setAttribute('aria-valuenow', String(percent));
        generationProgressFill.style.width = `${percent}%`;
        generationProgressValue.textContent = `${percent}%`;
    };

    const showGenerationProgress = (context) => {
        generationProgressView.dataset.active = 'true';
        generationProgressView.setAttribute('aria-hidden', 'false');
        generationProgressView.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
        generationProgressView.classList.add('opacity-100', 'translate-y-0');

        generationProgressModel.textContent = context.modelName || context.model;
        const details = [context.aspectRatio];
        if (context.duration) details.push(`${context.duration}s`);
        generationProgressDetail.textContent = details.filter(Boolean).join(' · ');

        if (context.imageUrl) {
            generationProgressPreview.src = context.imageUrl;
            generationProgressPreview.classList.remove('hidden');
            generationProgressPlaceholder.classList.add('hidden');
        } else {
            generationProgressPreview.removeAttribute('src');
            generationProgressPreview.classList.add('hidden');
            generationProgressPlaceholder.classList.remove('hidden');
        }

        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
        hero.classList.add('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        promptWrapper.classList.add('hidden', 'opacity-0', 'pointer-events-none');
        updateGenerationProgress({ stage: 'preparing' });

        if (generationProgressTimer) clearInterval(generationProgressTimer);
        generationStartedAt = Date.now();
        generationProgressElapsed.textContent = '0:00';
        generationProgressTimer = window.setInterval(() => {
            generationProgressElapsed.textContent = formatVideoGenerationElapsed(Date.now() - generationStartedAt);
        }, 1000);
    };

    const hideGenerationProgress = ({ restoreSetup = false } = {}) => {
        generationProgressView.dataset.active = 'false';
        generationProgressView.setAttribute('aria-hidden', 'true');
        generationProgressView.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
        generationProgressView.classList.remove('opacity-100', 'translate-y-0');
        if (generationProgressTimer) clearInterval(generationProgressTimer);
        generationProgressTimer = null;
        generationProgressPreview.removeAttribute('src');

        if (restoreSetup) {
            hero.classList.remove('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
            promptWrapper.classList.remove('hidden', 'opacity-0', 'opacity-40', 'pointer-events-none');
        }
    };

    // --- Helper: Show video in canvas ---
    const showVideoInCanvas = (videoUrl, genModel, generationContext = null) => {
        viewedGenerationContext = generationContext || generationContexts.get(videoUrl) || null;
        hero.classList.add('hidden');
        promptWrapper.classList.add('hidden');

        // Show extend button only for seedance-v2.0-t2v and i2v (not extend itself)
        const isSeedance2 = genModel && (genModel === 'seedance-v2.0-t2v' || genModel === 'seedance-v2.0-i2v');
        extendBtn.classList.toggle('hidden', !isSeedance2);

        let videoRevealed = false;
        const revealVideo = () => {
            if (videoRevealed) return;
            videoRevealed = true;
            const completedGeneration = generationProgressView.dataset.active === 'true';
            if (completedGeneration) hideGenerationProgress();
            canvas.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
            canvas.classList.add('opacity-100', 'translate-y-0', 'scale-100');
            canvasControls.classList.remove('opacity-0');
            canvasControls.classList.add('opacity-100');
            if (completedGeneration) void playCompletionPing();
        };
        resultVideo.onloadeddata = revealVideo;
        resultVideo.src = videoUrl;
        if (generationProgressView.dataset.active === 'true') {
            updateGenerationProgress({ stage: 'finishing', progress: 1 });
        }
        if (resultVideo.readyState >= 2) queueMicrotask(revealVideo);
    };

    const redactPrivateHistoryEntry = (entry) => (
        isHivemindVideoModelId(entry?.model)
            ? { ...entry, prompt: '', prompt_private: true }
            : entry
    );

    // --- Helper: Add to history ---
    const addToHistory = (entry, generationContext = null) => {
        const safeEntry = redactPrivateHistoryEntry(entry);
        if (generationContext && entry?.url) generationContexts.set(entry.url, generationContext);
        generationHistory.unshift(safeEntry);
        saveStudioGenerationHistory('video_history', generationHistory, 30);
        historySidebar.classList.remove('translate-x-full', 'opacity-0');
        historySidebar.classList.add('translate-x-0', 'opacity-100');
        renderHistory();
    };

    const renderHistory = () => {
        historyList.innerHTML = '';
        generationHistory.forEach((entry, idx) => {
            const thumb = document.createElement('div');
            thumb.className = `relative group/thumb cursor-pointer rounded-xl overflow-hidden border-2 transition-all duration-300 ${idx === 0 ? 'border-primary shadow-glow' : 'border-white/10 hover:border-white/30'}`;

            thumb.innerHTML = `
                <video src="${entry.url}" preload="metadata" muted class="w-full aspect-square object-cover"></video>
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center gap-1">
                    <button class="hist-download p-1.5 bg-primary rounded-lg text-black hover:scale-110 transition-transform" title="Download">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    </button>
                </div>
            `;

            thumb.onclick = (e) => {
                if (e.target.closest('.hist-download')) {
                    downloadFile(entry.url, `video-${entry.id || idx}.mp4`);
                    return;
                }
                // Restore extend context when viewing a seedance-v2.0 generation
                if (entry.model === 'seedance-v2.0-t2v' || entry.model === 'seedance-v2.0-i2v') {
                    lastGenerationId = entry.id;
                    lastGenerationModel = entry.model;
                } else {
                    lastGenerationId = null;
                    lastGenerationModel = null;
                }
                showVideoInCanvas(entry.url, entry.model);
                historyList.querySelectorAll('div').forEach(t => {
                    t.classList.remove('border-primary', 'shadow-glow');
                    t.classList.add('border-white/10');
                });
                thumb.classList.remove('border-white/10');
                thumb.classList.add('border-primary', 'shadow-glow');
            };

            historyList.appendChild(thumb);
        });
    };

    // --- Helper: Download file ---
    const downloadFile = async (url, filename) => {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            window.open(url, '_blank');
        }
    };

    const savedHistory = loadStudioGenerationHistory('video_history');
    if (savedHistory.length > 0) {
        const sanitized = savedHistory.map(redactPrivateHistoryEntry);
        sanitized.forEach(e => generationHistory.push(e));
        saveStudioGenerationHistory('video_history', sanitized, 30);
        historySidebar.classList.remove('translate-x-full', 'opacity-0');
        historySidebar.classList.add('translate-x-0', 'opacity-100');
        renderHistory();
    }

    // --- Resume any pending video generations from a previous session ---
    (async () => {
        const pending = getPendingJobs('video');
        if (!pending.length) return;

        const apiKey = localStorage.getItem('muapi_key');
        if (!apiKey) return; // can't poll without key; jobs remain for next time

        const banner = document.createElement('div');
        banner.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[200] bg-[#111] border border-white/10 text-white text-sm px-5 py-3 rounded-2xl shadow-xl flex items-center gap-3';
        banner.innerHTML = `<span class="animate-spin text-primary">◌</span> <span class="banner-text">Resuming ${pending.length} pending generation${pending.length > 1 ? 's' : ''}…</span>`;
        document.body.appendChild(banner);

        let remaining = pending.length;
        pending.forEach(async (job) => {
            const elapsedAttempts = Math.floor((Date.now() - job.submittedAt) / job.interval);
            const attemptsLeft = Math.max(1, job.maxAttempts - elapsedAttempts);
            try {
                const result = await muapi.pollForResult(job.requestId, apiKey, attemptsLeft, job.interval);
                const url = result.outputs?.[0] || result.url || result.output?.url;
                if (url) {
                    addToHistory({ id: job.requestId, url, ...job.historyMeta, timestamp: new Date().toISOString() });
                }
            } catch (e) {
                console.warn('[VideoStudio] Pending job failed on resume:', job.requestId, e.message);
            } finally {
                removePendingJob(job.requestId);
                remaining--;
                if (remaining === 0) banner.remove();
                else banner.querySelector('.banner-text').textContent = `Resuming ${remaining} pending generation${remaining > 1 ? 's' : ''}…`;
            }
        });
    })();

    // --- Button Handlers ---
    downloadBtn.onclick = () => {
        const current = resultVideo.src;
        if (current) {
            const entry = generationHistory.find(e => e.url === current);
            downloadFile(current, `video-${entry?.id || 'clip'}.mp4`);
        }
    };

    const captureGenerationContext = (prompt) => ({
        prompt,
        model: selectedModel,
        modelName: selectedModelName,
        aspectRatio: selectedAr,
        duration: selectedDuration,
        resolution: selectedResolution,
        quality: selectedQuality,
        mode: selectedMode,
        effectName: selectedEffectName,
        imageMode,
        v2vMode,
        imageUrl: uploadedImageUrl,
        endImageUrl: uploadedEndImageUrl,
        videoUrl: uploadedVideoUrl,
        videoName: uploadedVideoName,
        sourceGenerationId: getCurrentModel()?.requiresRequestId ? lastGenerationId : null,
    });

    const restoreGenerationContext = (context) => {
        if (!context?.model) return false;

        imageMode = Boolean(context.imageMode);
        v2vMode = Boolean(context.v2vMode);
        const model = getCurrentModels().find((entry) => entry.id === context.model);
        if (!model) return false;

        selectedModel = context.model;
        selectedModelName = context.modelName || model.name;
        uploadedImageUrl = context.imageUrl || null;
        uploadedEndImageUrl = context.endImageUrl || null;
        uploadedVideoUrl = context.videoUrl || null;
        uploadedVideoName = context.videoName || null;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);

        selectedAr = context.aspectRatio || selectedAr;
        selectedDuration = context.duration ?? selectedDuration;
        selectedResolution = context.resolution ?? selectedResolution;
        selectedQuality = context.quality ?? selectedQuality;
        selectedMode = context.mode ?? selectedMode;
        selectedEffectName = context.effectName ?? selectedEffectName;
        const setLabel = (id, value) => {
            const label = document.getElementById(id);
            if (label && value !== '' && value != null) label.textContent = value;
        };
        setLabel('v-ar-btn-label', selectedAr);
        setLabel('v-duration-btn-label', `${selectedDuration}s`);
        setLabel('v-resolution-btn-label', selectedResolution);
        setLabel('v-quality-btn-label', selectedQuality);
        setLabel('v-mode-btn-label', selectedMode);
        setLabel('v-effect-btn-label', selectedEffectName);

        if (uploadedImageUrl) picker.setImage(uploadedImageUrl);
        else picker.reset();
        if (uploadedEndImageUrl) endPicker.setImage(uploadedEndImageUrl);
        else endPicker.reset();
        if (uploadedVideoUrl) showVideoReady(uploadedVideoName || 'Reference video');
        else showVideoIcon();

        textarea.value = context.prompt || '';
        textarea.disabled = v2vMode && !model.hasPrompt && !model.promptRequired;
        if (v2vMode) {
            textarea.placeholder = model.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)';
        } else if (imageMode) {
            textarea.placeholder = 'Describe the motion or effect (optional)';
        } else {
            textarea.placeholder = 'Describe the video you want to create';
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (context.sourceGenerationId) lastGenerationId = context.sourceGenerationId;
        persistVideoPreferences();
        return true;
    };

    const resetToPromptBar = () => {
        hideGenerationProgress();
        resultVideo.pause();
        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
        canvasControls.classList.add('opacity-0');
        canvasControls.classList.remove('opacity-100');
        hero.classList.remove('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        promptWrapper.classList.remove('hidden', 'opacity-0', 'opacity-40', 'pointer-events-none');
    };

    backToSetupBtn.onclick = () => {
        if (viewedGenerationContext) restoreGenerationContext(viewedGenerationContext);
        resetToPromptBar();
        textarea.focus();
    };

    regenerateBtn.onclick = () => {
        if (!viewedGenerationContext || !restoreGenerationContext(viewedGenerationContext)) {
            resetToPromptBar();
            textarea.focus();
            return;
        }
        resultVideo.pause();
        generateBtn.click();
    };

    newPromptBtn.onclick = () => {
        resetToPromptBar();
        textarea.value = '';
        picker.reset();
        endPicker.reset();
        uploadedImageUrl = null;
        uploadedEndImageUrl = null;
        imageMode = false;
        uploadedVideoUrl = null;
        uploadedVideoName = null;
        v2vMode = false;
        lastSubmittedContext = null;
        viewedGenerationContext = null;
        showVideoIcon();
        selectedModel = allT2V[0].id;
        selectedModelName = allT2V[0].name;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Describe the video you want to create';
        textarea.disabled = false;
        textarea.focus();
    };

    extendBtn.onclick = () => {
        if (!lastGenerationId) return;
        resetToPromptBar();
        textarea.value = '';
        picker.reset();
        uploadedImageUrl = null;
        imageMode = false;
        selectedModel = 'seedance-v2.0-extend';
        selectedModelName = 'Seedance 2.0 Extend';
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Optional: describe how to continue the video...';
        textarea.focus();
    };

    // ==========================================
    // 5. GENERATION LOGIC
    // ==========================================
    generateBtn.onclick = async () => {
        const prompt = textarea.value.trim();
        const model = getCurrentModel();
        const isExtendMode = model?.requiresRequestId;
        const isWan2gpLocal = isWan2gpModelId(selectedModel);
        const isHivemindLocal = isHivemindVideoModelId(selectedModel);
        const isHivemindVideoInput = isHivemindLocal && Boolean(uploadedVideoUrl);

        if (isHivemindVideoInput) {
            if (!model?.supportsVideoInput) {
                alert('This local workflow does not support source-video extension.');
                return;
            }
        } else if (v2vMode) {
            if (!uploadedVideoUrl) {
                alert('Please upload a video first.');
                return;
            }
            if (model?.imageField && !uploadedImageUrl) {
                alert('Please upload a reference image for motion control.');
                return;
            }
            if (model?.promptRequired && !prompt) {
                alert('Please describe the motion you want.');
                return;
            }
        } else if (isExtendMode) {
            if (!lastGenerationId) {
                alert('No Seedance 2.0 generation found to extend. Generate a video first.');
                return;
            }
        } else if (imageMode) {
            if (!uploadedImageUrl) {
                alert('Please upload a start frame image first.');
                return;
            }
        } else {
            if (!prompt) {
                alert('Please enter a prompt to generate a video.');
                return;
            }
        }

        const isLocal = isWan2gpLocal || isHivemindLocal;

        // Local Wan2GP generations don't go through Muapi — skip the auth gate.
        if (!isLocal) {
            const apiKey = localStorage.getItem('muapi_key');
            if (!apiKey) {
                AuthModal(() => generateBtn.click());
                return;
            }
        }

        lastSubmittedContext = captureGenerationContext(prompt);
        void primeCompletionPing();
        showGenerationProgress(lastSubmittedContext);
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<span class="animate-spin inline-block mr-2 text-black">◌</span> ${t('common.generating')}`;

        // Wan2GP reports real progress. Other providers stay visibly
        // indeterminate until they return because they expose no progress API.
        let unsubscribeProgress = null;
        if (isWan2gpLocal) {
            unsubscribeProgress = localAI.onProgress(({ status, progress }) => {
                updateGenerationProgress({ status, progress });
            });
        } else {
            updateGenerationProgress({ stage: isHivemindLocal ? 'rendering' : 'queued' });
        }

        let hadError = false;
        let capturedRequestId = null;
        const historyMeta = { prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration };

        const onRequestId = (rid) => {
            capturedRequestId = rid;
            updateGenerationProgress({ stage: 'rendering' });
            savePendingJob({ requestId: rid, studioType: 'video', historyMeta, maxAttempts: 900, interval: 2000, submittedAt: Date.now() });
        };

        try {
            // ─── Local Media Studio path ─────────────────────────────────────
            // Hivemind workflows are served through the same-origin Content
            // Studio API, which wraps the configured Media Studio MCP.
            if (isHivemindLocal) {
                const localParams = {
                    model: selectedModel,
                    workflow_id: workflowIdFromHivemindModelId(selectedModel),
                    prompt: prompt || '',
                    aspect_ratio: selectedAr,
                    duration: selectedDuration || 4,
                };
                if (isHivemindVideoInput) {
                    localParams.video = uploadedVideoUrl;
                    localParams.video_mode = 'extend';
                } else if (imageMode && uploadedImageUrl) {
                    localParams.image = uploadedImageUrl;
                }
                const res = await generateHivemindVideo(localParams);
                if (res && res.url) {
                    const genId = res.id || Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by Hivemind Media Studio');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            // ─── Local Wan2GP path ───────────────────────────────────────────
            // Uploaded image URLs were minted by uploadFileToWan2gp(), so
            // wan2gpProvider can rehydrate the Gradio file descriptor.
            if (isWan2gpLocal) {
                const localParams = {
                    model: selectedModel,
                    prompt: prompt || '',
                    aspect_ratio: selectedAr,
                };
                if (imageMode && uploadedImageUrl) localParams.image = uploadedImageUrl;
                const res = await localAI.generate(localParams);
                if (res && res.url) {
                    const genId = Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by Wan2GP');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            if (v2vMode) {
                const v2vParams = { model: selectedModel, video_url: uploadedVideoUrl, onRequestId };
                if (model?.imageField && uploadedImageUrl) v2vParams.image_url = uploadedImageUrl;
                if (model?.hasPrompt && prompt) v2vParams.prompt = prompt;
                const res = await muapi.processV2V(v2vParams);
                if (res && res.url) {
                    if (capturedRequestId) removePendingJob(capturedRequestId);
                    const genId = res.id || capturedRequestId || Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt: model?.hasPrompt ? prompt : '', model: selectedModel, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by API');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            if (imageMode) {
                const i2vParams = {
                    model: selectedModel,
                    image_url: uploadedImageUrl,
                    onRequestId,
                };
                i2vParams.prompt = prompt || '';
                i2vParams.aspect_ratio = selectedAr;
                if (uploadedEndImageUrl && getCurrentModel()?.lastImageField) {
                    i2vParams.last_image = uploadedEndImageUrl;
                }
                const durations = getCurrentDurations(selectedModel);
                if (durations.length > 0) i2vParams.duration = selectedDuration;
                const resolutions = getCurrentResolutions(selectedModel);
                if (resolutions.length > 0) i2vParams.resolution = selectedResolution;
                if (selectedQuality) i2vParams.quality = selectedQuality;
                if (selectedMode) i2vParams.mode = selectedMode;
                if (selectedEffectName) i2vParams.name = selectedEffectName;

                const res = await muapi.generateI2V(i2vParams);
                if (res && res.url) {
                    if (capturedRequestId) removePendingJob(capturedRequestId);
                    const genId = res.id || capturedRequestId || Date.now().toString();
                    if (selectedModel === 'seedance-v2.0-i2v') {
                        lastGenerationId = genId;
                        lastGenerationModel = selectedModel;
                    } else {
                        lastGenerationId = null;
                        lastGenerationModel = null;
                    }
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by API');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            const params = { model: selectedModel, onRequestId };

            if (prompt) params.prompt = prompt;

            // Extend mode: pass stored request_id, skip aspect_ratio
            if (isExtendMode) {
                params.request_id = lastGenerationId;
            } else {
                params.aspect_ratio = selectedAr;
            }

            const durations = getCurrentDurations(selectedModel);
            if (durations.length > 0) params.duration = selectedDuration;

            const resolutions = getCurrentResolutions(selectedModel);
            if (resolutions.length > 0) params.resolution = selectedResolution;

            if (selectedQuality) params.quality = selectedQuality;
            if (selectedMode) params.mode = selectedMode;

            const res = await muapi.generateVideo(params);

            if (res && res.url) {
                if (capturedRequestId) removePendingJob(capturedRequestId);
                const genId = res.id || capturedRequestId || Date.now().toString();
                // Store request_id for seedance-v2.0 models (enables Extend button)
                if (selectedModel === 'seedance-v2.0-t2v' || selectedModel === 'seedance-v2.0-i2v') {
                    lastGenerationId = genId;
                    lastGenerationModel = selectedModel;
                } else {
                    lastGenerationId = null;
                    lastGenerationModel = null;
                }

                addToHistory({
                    id: genId,
                    url: res.url,
                    prompt,
                    model: selectedModel,
                    aspect_ratio: selectedAr,
                    duration: selectedDuration,
                    timestamp: new Date().toISOString()
                }, lastSubmittedContext);
                showVideoInCanvas(res.url, selectedModel);
            } else {
                throw new Error('No video URL returned by API');
            }
        } catch (e) {
            hadError = true;
            if (capturedRequestId) removePendingJob(capturedRequestId);
            console.error(e);
            hideGenerationProgress({ restoreSetup: true });
            generateBtn.innerHTML = `Error: ${e.message.slice(0, 60)}`;
            setTimeout(() => {
                generateBtn.innerHTML = t('common.generate');
            }, 4000);
        } finally {
            generateBtn.disabled = false;
            if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
            // Only reset the label on success; the catch timeout handles the error case
            if (!hadError) generateBtn.innerHTML = t('common.generate');
        }
    };

    return container;
}
