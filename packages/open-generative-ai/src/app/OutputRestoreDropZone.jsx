// Window-level drop orchestrator for "drag a generated image/video back into the app
// to restore all of its settings". It resolves a dropped output (from the in-app
// gallery/viewer, or a file dragged from disk) to its recorded generation context and
// hands that to the target studio through the existing loadStudioSetup bridge.
//
// Coexistence: reference-image drops onto an UploadPicker keep their existing behavior
// — a drop whose target is inside [data-upload-picker] is ignored here and handled by
// the picker's own onDrop. The overlay is pointer-events-none so the real drop target
// (and therefore that guard) is preserved.
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { loadStudioSetup } from './promptTarget.js';
import { basenameOf, resolveGenerationSetup } from '../lib/generationSetupStore.js';

const CUSTOM_TYPE = 'application/x-hivemind-output';

function dragHasPayload(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes(CUSTOM_TYPE) || types.includes('Files');
}

function isUploadPickerTarget(target) {
  return Boolean(target && typeof target.closest === 'function' && target.closest('[data-upload-picker]'));
}

function sectionFromMediaType(mediaType, basename) {
  const mt = String(mediaType || '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('image/')) return 'image';
  return /\.(mp4|webm|mov|m4v|gif)$/i.test(String(basename || '')) ? 'video' : 'image';
}

function extractIdentity(dataTransfer) {
  // 1) In-app drag from a gallery/viewer carries our exact identity.
  try {
    const raw = dataTransfer.getData(CUSTOM_TYPE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.url) {
        return { url: parsed.url, basename: basenameOf(parsed.url), section: parsed.section };
      }
    }
  } catch { /* not our payload */ }
  // 2) A file dragged from disk — identify by filename.
  const file = dataTransfer.files && dataTransfer.files[0];
  if (file) {
    return { url: null, basename: file.name, section: sectionFromMediaType(file.type, file.name), file };
  }
  // 3) A bare URL dragged from elsewhere.
  try {
    const uri = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain');
    const first = String(uri || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (first && /^(https?:|\/)/.test(first)) {
      return { url: first, basename: basenameOf(first), section: null };
    }
  } catch { /* none */ }
  return null;
}

// Tier 1/2 hit — the studio's own full captured context. Restore verbatim.
function restoreFullContext(section, context) {
  loadStudioSetup(section, { format: 'studio-full-context', section, context });
  try {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: section } }));
  } catch { /* non-critical */ }
  const needsAttention =
    (Array.isArray(context.referenceImages) && context.referenceImages.length) ||
    (Array.isArray(context.ingredientImages) && context.ingredientImages.length) ||
    (Array.isArray(context.loras) && context.loras.length);
  const where = section === 'video' ? 'Video' : 'Image';
  toast.success(
    needsAttention
      ? `Settings restored into the ${where} studio — re-check reference images / LoRAs.`
      : `Settings restored into the ${where} studio.`,
  );
}

// Tier 4 — an EXTERNAL ComfyUI image dragged from disk that embeds its own graph.
// Vault-independent; recovers the prompt (+ seed) only. Loaded on demand.
async function tryEmbeddedMetadata(file) {
  try {
    const meta = await import('../lib/imageWorkflowMetadata.js');
    if (!meta.isWorkflowImageFile(file)) return false;
    const data = await meta.readEmbeddedComfyData(file);
    const recovered = data && meta.extractPromptAndSeed(data);
    if (!recovered || (!recovered.prompt && typeof recovered.seed !== 'number')) return false;
    loadStudioSetup('image', {
      primaryPrompt: recovered.prompt || '',
      negativePrompt: recovered.negativePrompt || '',
      seed: recovered.seed,
    });
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'image' } }));
    toast.success('Recovered the prompt from the image’s embedded workflow.');
    return true;
  } catch {
    return false;
  }
}

// Tier 3 — an older local-ComfyUI output recorded in the owner's Hub History. Reuses
// the Hub's decrypt+restore+navigate path. hubData is dynamic-imported so it stays out
// of the main bundle. Needs the vault unlocked to decrypt.
async function tryCanvasHistory(identity) {
  try {
    const hub = await import('../hub/hubData.js');
    await hub.ensureCanvasHistoryLoaded();
    const historyId = hub.findCanvasHistoryIdForOutput(identity.url, identity.basename);
    if (!historyId) return false;
    await hub.loadCanvasOutputInStudio(historyId);
    return true;
  } catch {
    return false;
  }
}

async function handleDrop(dataTransfer) {
  const identity = extractIdentity(dataTransfer);
  if (!identity) return;

  // Tier 1 + 2 — our own outputs' full captured settings (session + durable vault).
  let result = null;
  try { result = await resolveGenerationSetup(identity); } catch { result = null; }
  if (result?.context) {
    restoreFullContext(result.section || identity.section || 'image', result.context);
    return;
  }

  // Tier 4 — external image file with embedded metadata (vault-independent). Try
  // before tier 3, which needs the vault unlocked.
  if (identity.file && await tryEmbeddedMetadata(identity.file)) return;

  // Tier 3 — older local-ComfyUI output in the Hub History (needs the vault unlocked,
  // so skip it when tier 2 already asked for an unlock).
  if (!result?.needsUnlock && await tryCanvasHistory(identity)) return;

  if (result?.needsUnlock) {
    toast('Unlock the studio (top-right) to restore saved settings, then drop again.');
    return;
  }
  toast('No saved settings found for this file.');
}

export function OutputRestoreDropZone() {
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);

  useEffect(() => {
    const reset = () => { depthRef.current = 0; setDragging(false); };
    const onDragEnter = (e) => {
      if (!dragHasPayload(e.dataTransfer) || isUploadPickerTarget(e.target)) return;
      depthRef.current += 1;
      setDragging(true);
    };
    const onDragOver = (e) => {
      if (!dragHasPayload(e.dataTransfer) || isUploadPickerTarget(e.target)) return;
      e.preventDefault(); // required to allow a drop
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* non-critical */ }
    };
    const onDragLeave = (e) => {
      if (!dragHasPayload(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    };
    const onDrop = (e) => {
      // Let the UploadPicker keep reference-image drops (its own onDrop handles them).
      if (isUploadPickerTarget(e.target)) { reset(); return; }
      if (!dragHasPayload(e.dataTransfer)) return;
      e.preventDefault();
      const dt = e.dataTransfer;
      reset();
      void handleDrop(dt);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[95] grid place-items-center"
      style={{ backgroundColor: 'rgba(10,10,14,0.55)' }}
    >
      <div className="rounded-xl border-2 border-dashed border-honey bg-bg1/95 px-8 py-6 text-center shadow-pop">
        <div className="text-sm font-medium text-ink1">Drop to restore its settings</div>
        <div className="mt-1 text-xs text-ink3">Loads the prompt, model and every setting into the matching studio</div>
      </div>
    </div>
  );
}
