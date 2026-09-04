// Window-level drop orchestrator for "drag a generated image/video back into the app
// to restore all of its settings". It resolves a dropped output (from the in-app
// gallery/viewer, or a file dragged from disk) to its recorded generation context and
// hands that to the target studio through the existing loadStudioSetup bridge.
//
// Coexistence: this is the whole window EXCEPT the places where a dropped file is an
// INPUT rather than a past run. Two of them: an UploadPicker (and the References
// panel, which wears the same mark), and the studio composer — the box you write the
// shot in, where a drop attaches the file as an image/motion/voice reference instead
// (ui/kit.jsx ComposerSlot). A drop inside either is ignored here and handled there.
// The overlay is pointer-events-none so the real drop target (and therefore that
// guard) is preserved.
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { loadStudioSetup } from './promptTarget.js';
import { basenameOf, resolveGenerationSetup, warmGenerationSetupLookup } from '../lib/generationSetupStore.js';
import { HIVEMIND_OUTPUT_DRAG_TYPE } from '../lib/referenceDrop.js';
import { zh } from '../lib/i18n.js';
import { Spinner, cx } from '../ui/kit.jsx';

const CUSTOM_TYPE = HIVEMIND_OUTPUT_DRAG_TYPE;

// Only an in-app output drag or an image/video FILE can restore anything, so
// only those light the overlay: a .pdf used to get "Drop to restore its
// settings" and then "No saved settings found". During dragenter/dragover the
// browser is in protected mode — `items[i].type` is readable, file contents and
// getData() are not — so the MIME is the most that can be checked here. An item
// with an empty type (a HEIC on some platforms) is let through rather than
// refused on a guess.
function dragHasPayload(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  if (types.includes(CUSTOM_TYPE)) return true;
  if (!types.includes('Files')) return false;
  const items = Array.from(dataTransfer.items || []);
  if (!items.length) return true; // some browsers expose no items mid-drag
  return items.some((item) => item.kind === 'file'
    && (!item.type || /^(image|video)\//i.test(item.type)));
}

// The regions that own their own drops. Nothing here fires inside them.
function isInputDropTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('[data-upload-picker]') || target.closest('[data-studio-composer]'));
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
  // 2) A file dragged from disk — identify by filename. (A bare URL drag is not
  //    handled: dragover never allows it, so a drop for one never fires.)
  const file = dataTransfer.files && dataTransfer.files[0];
  if (file) {
    return { url: null, basename: file.name, section: sectionFromMediaType(file.type, file.name), file };
  }
  return null;
}

// Tier 1/2 hit — the studio's own full captured context. Restore verbatim.
function restoreFullContext(section, context) {
  loadStudioSetup(section, { format: 'studio-full-context', section, context });
  try {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: section } }));
  } catch { /* non-critical */ }
  const omitted = Number(context.omittedReferences || 0);
  const needsAttention =
    (Array.isArray(context.referenceImages) && context.referenceImages.length) ||
    (Array.isArray(context.ingredientImages) && context.ingredientImages.length) ||
    (Array.isArray(context.loras) && context.loras.length);
  const where = section === 'video' ? (zh() ? '视频' : 'Video') : (zh() ? '图像' : 'Image');
  // Oversized inline references are not sealed (they would bloat the vault and cost
  // the settings of older generations), so say so rather than letting the user
  // generate with a silently smaller reference set than the run they restored.
  if (omitted) {
    toast.success(
      zh()
        ? `设置已恢复到${where}工作室 — 请重新附加 ${omitted} 张参考图。`
        : `Settings restored into the ${where} studio — re-attach ${omitted} reference image${omitted === 1 ? '' : 's'}.`,
      { duration: 6000 },
    );
    return;
  }
  toast.success(
    needsAttention
      ? (zh() ? `设置已恢复到${where}工作室 — 请检查参考图 / LoRA。` : `Settings restored into the ${where} studio — re-check reference images / LoRAs.`)
      : (zh() ? `设置已恢复到${where}工作室。` : `Settings restored into the ${where} studio.`),
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
    toast.success(zh() ? '已从图片内嵌的工作流中恢复提示词。' : 'Recovered the prompt from the image’s embedded workflow.');
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
    toast(zh() ? '先在顶栏解锁保险库，再拖放一次即可恢复保存的设置。' : 'Unlock your vault (topbar) to restore saved settings, then drop again.');
    return;
  }
  toast(zh() ? '没有找到这个文件的已保存设置。' : 'No saved settings found for this file.');
}

export function OutputRestoreDropZone() {
  // 'idle' | 'dragging' | 'restoring'. The overlay used to vanish the instant you
  // let go, so a drop that had to open the vault and try several filename keys
  // looked like nothing had happened at all.
  const [phase, setPhase] = useState('idle');
  const depthRef = useRef(0);

  useEffect(() => {
    const reset = () => { depthRef.current = 0; setPhase('idle'); };
    const setDragging = (on) => setPhase((prev) => (on ? 'dragging' : (prev === 'restoring' ? prev : 'idle')));
    const onDragEnter = (e) => {
      if (!dragHasPayload(e.dataTransfer) || isInputDropTarget(e.target)) return;
      depthRef.current += 1;
      setDragging(true);
      // Unlock the vault during the drag so the expensive key derivation is already
      // done by the time the user lets go.
      warmGenerationSetupLookup();
    };
    const onDragOver = (e) => {
      if (!dragHasPayload(e.dataTransfer) || isInputDropTarget(e.target)) return;
      e.preventDefault(); // required to allow a drop
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* non-critical */ }
    };
    const onDragLeave = (e) => {
      if (!dragHasPayload(e.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    };
    const onDrop = (e) => {
      // The pickers and the composer keep their own drops (their onDrop handles them).
      if (isInputDropTarget(e.target)) { reset(); return; }
      if (!dragHasPayload(e.dataTransfer)) return;
      e.preventDefault();
      const dt = e.dataTransfer;
      depthRef.current = 0;
      setPhase('restoring');
      // handleDrop must keep reading dt.files synchronously before its first
      // await — the DataTransfer is neutered once this handler returns.
      handleDrop(dt).catch(() => { /* every tier reports its own failure */ })
        .finally(() => setPhase('idle'));
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

  if (phase === 'idle') return null;
  const restoring = phase === 'restoring';
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[95] grid place-items-center"
      style={{ backgroundColor: 'rgba(10,10,14,0.55)' }}
      role={restoring ? 'status' : undefined}
      aria-live={restoring ? 'polite' : undefined}
    >
      <div
        className={cx(
          'rounded-xl border-2 bg-bg1/95 px-8 py-6 text-center shadow-pop',
          restoring ? 'border-solid border-honey/50' : 'border-dashed border-honey',
        )}
      >
        {restoring ? (
          <>
            <div className="flex items-center justify-center gap-2 text-sm font-medium text-ink1">
              <Spinner size={14} className="text-honey" />
              {zh() ? '正在恢复设置…' : 'Restoring settings…'}
            </div>
            <div className="mt-1 text-xs text-ink3">{zh() ? '正在用你的密钥解密这个输出保存的设置' : 'Decrypting this output’s saved setup with your key'}</div>
          </>
        ) : (
          <>
            <div className="text-sm font-medium text-ink1">{zh() ? '拖放此工作室生成的图片或视频以恢复其设置' : 'Drop an image or video from this studio to restore its settings'}</div>
            <div className="mt-1 text-xs text-ink3">{zh() ? '会把提示词、模型和全部设置载入对应的工作室' : 'Loads the prompt, model and every setting into the matching studio'}</div>
          </>
        )}
      </div>
    </div>
  );
}
