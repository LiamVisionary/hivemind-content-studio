// Prompt helper: refine an idea into a prompt, on whichever model is chosen.
//
// Replaces the per-workflow ComfyUI prompt_assistant node. It used to be local
// only — any GGUF the studio could find, run in a llama-server this app owns —
// which meant a machine with no weights on it had a dialog that could not write
// anything, while the Story producer one screen over was happily using the
// owner's ChatGPT plan. It now offers the same three sources the producer does
// (`components/ModelSourcePicker.jsx`, `lib/useModelSources.js`).
//
// THE SHAPE. Four rows, top to bottom, in the order the question is actually
// asked: what you said (your idea), who it is being written for (the cast and
// references chips, and the shot it is continuing), what came back (the prompt),
// and what to change about it. The model is a pill in the title bar, because it
// is a property of the whole dialog rather than a step in it — and because the
// machinery behind it (every model on three bills, RAM, load and unload) buried
// the two presses that matter every day when it sat inline as a section.
//
// The memory UX is still the load-bearing part FOR A LOCAL MODEL. A 30 GB model
// loaded while a video generation holds 20 GB is an OOM that kills the
// generation, so the picker locks anything that cannot fit and the "unload
// others first" switch is what makes the borderline ones reachable. None of it
// applies to a cloud model, so none of it is shown for one — a load step that is
// skipped, and a RAM header that would be warning about the wrong resource. It
// lives behind the picker's Memory disclosure: the day it matters it is one
// press away, and every other day it is not in the way.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Modal } from '../ui/Modal.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, IconButton, Kbd, Pill, Spinner, TextArea, TextInput, Toggle, cx } from '../ui/kit.jsx';
import {
    blockedReason,
    canSelect,
    externalHold,
    formatBytes,
    lastUsedModelId,
    refineSuggestions,
    rememberModelId,
    writingForChips,
} from '../lib/promptHelperRuntime.js';
import { flattenApiDetail } from '../lib/muapiErrors.js';
import { CompactModelPicker } from '../components/ModelSourcePicker.jsx';
import { useModelSources } from '../lib/useModelSources.js';
import { costLine, LOCAL, needsLoad, PROMPT_USAGE, rowFor, startingModelIdWithRuntime, tabOf } from '../lib/textModels.js';
import { referenceToLocalImageInput } from '../lib/hivemindStudio.js';
import { videoContactSheet } from '../lib/contactSheet.js';
import { useMediaPoster, useMediaSealFailure } from '../hooks/hooks.js';
import { t, tf } from '../lib/i18n.js';
import { characterNoteLines, charactersMentionedIn } from '../lib/h3Characters.js';

async function api(path, body) {
    const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        // A 422 arrives as a FastAPI array of { msg } — flattened, or the toast
        // would read "[object Object]".
        throw new Error(flattenApiDetail(payload?.detail ?? payload?.error) || `Request failed (${response.status})`);
    }
    return payload;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Shot 3 as the design's `shot 03` — two digits so a strip of them lines up. */
const shotLabel = (shot) => String(Math.max(1, Number(shot) || 1)).padStart(2, '0');

// What each one-press refinement is called. Kept beside the component and keyed
// by literal, because the key table's missing-key check only sees a quoted
// literal — a key built by interpolation would let a typo ship as its own name.
// `matchShot` is absent on purpose: it names a shot number, so it goes through
// tf() at the call site.
const SUGGESTION_LABEL = {
    moreDetail: () => t('promptHelper.suggestMoreDetail'),
    tighten: () => t('promptHelper.suggestTighten'),
    anotherShot: () => t('promptHelper.suggestAnotherShot'),
    singleStill: () => t('promptHelper.suggestSingleStill'),
    timing: () => t('promptHelper.suggestTiming'),
};

/**
 * A panel hung off a trigger, drawn into <body> rather than inside the dialog.
 *
 * The Modal panel is `overflow-hidden` (it has to be, to round its corners), so
 * an absolutely-positioned popover anchored inside it is clipped the moment it
 * is taller than the dialog — the same trap `ui/kit.jsx`'s hint bubble
 * documents. Fixed coordinates measured from the trigger, clamped to the
 * viewport, flipping above when there is no room below.
 *
 * `role="dialog"` is load-bearing rather than decorative: Modal gives Escape to
 * the TOPMOST dialog, and this portal mounts after the modal's, so one keypress
 * closes the popover and leaves the dialog open instead of closing both.
 */
function AnchoredPanel({ anchor, width, label, onClose, children }) {
    const ref = useRef(null);
    const [pos, setPos] = useState(null);

    useLayoutEffect(() => {
        if (!anchor || !ref.current) return undefined;
        const place = () => {
            const target = anchor.getBoundingClientRect();
            const panel = ref.current.getBoundingClientRect();
            const margin = 8;
            const below = target.bottom + margin;
            const fits = below + panel.height + margin <= window.innerHeight;
            const next = {
                left: Math.min(
                    Math.max(margin, target.right - panel.width),
                    Math.max(margin, window.innerWidth - panel.width - margin),
                ),
                top: fits ? below : Math.max(margin, target.top - panel.height - margin),
            };
            setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
        };
        place();
        // Fixed coordinates do not follow the anchor: a resize under an open
        // panel would strand it where the pill used to be.
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
        };
    }, [anchor, children]);

    // Focus moves IN on open and back to the trigger on close. Not a nicety: the
    // panel is portaled outside the Modal, so Modal's Tab trap cannot see it and
    // a keyboard user would never reach a single row of it otherwise.
    useEffect(() => {
        if (!anchor || !ref.current) return undefined;
        const first = ref.current.querySelector('input, button, [tabindex]:not([tabindex="-1"])');
        // A timeout rather than requestAnimationFrame: rAF never fires while the
        // tab is hidden, and "the picker opened in a background tab" must not be
        // the one case where a keyboard user is left outside it. `preventScroll`
        // is what the frame delay was buying, and it is passed here.
        const timer = setTimeout(() => {
            try { (first || ref.current)?.focus({ preventScroll: true }); } catch { /* detached */ }
        }, 0);
        return () => {
            clearTimeout(timer);
            try { anchor.focus({ preventScroll: true }); } catch { /* the pill went away with the dialog */ }
        };
    }, [anchor]);

    useEffect(() => {
        if (!anchor) return undefined;
        const away = (event) => {
            if (ref.current?.contains(event.target) || anchor.contains(event.target)) return;
            onClose();
        };
        // Capture AND stop: Modal gives Escape to the topmost dialog, and this
        // panel is it — but React flushes the close at the microtask checkpoint
        // between the two listeners, so by the time Modal's own handler ran the
        // panel was already gone and the whole dialog closed with it.
        const key = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onClose();
        };
        document.addEventListener('mousedown', away, true);
        window.addEventListener('keydown', key, true);
        return () => {
            document.removeEventListener('mousedown', away, true);
            window.removeEventListener('keydown', key, true);
        };
    }, [anchor, onClose]);

    // Tab cycles INSIDE the panel. Modal's own trap only knows about its panel,
    // and this one is portaled out of it — without this, Tab off the last row
    // walked into the page behind the scrim.
    const onKeyDown = (event) => {
        if (event.key !== 'Tab' || !ref.current) return;
        const items = [...ref.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (!items.length) { event.preventDefault(); ref.current.focus(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus();
        }
    };

    return createPortal(
        <div
            ref={ref}
            role="dialog"
            // The dialog underneath is aria-modal, which makes everything
            // outside it inert to a screen reader — including this panel. A
            // stacked aria-modal dialog is how that is undone: the topmost one
            // becomes the live context.
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={{
                position: 'fixed',
                left: pos?.left ?? 0,
                top: pos?.top ?? 0,
                width,
                // Hidden for the measuring pass only: width and height have to
                // settle before it can be placed, and an unplaced panel must not
                // flash in the corner.
                visibility: pos ? 'visible' : 'hidden',
            }}
            // `dvh`: `vh` on iOS is the large viewport, so 80vh is 80% of a
            // screen the URL bar is covering the bottom of — and this panel is
            // placed against `window.innerHeight` below, which is the small one.
            // The two disagreeing is a panel measured taller than the box it was
            // told to fit in, which lands it half off the bottom edge.
            className="hive-scale-in z-[110] flex max-h-[min(520px,80dvh)] flex-col overflow-hidden rounded-lg border border-line1 bg-bg1 shadow-overlay"
        >
            {children}
        </div>,
        document.body,
    );
}

/** The shot this one continues, with a still of it — the picture is the fastest
 *  way to see WHICH clip is armed, which a shot number alone never answers. */
function ContinuingBanner({ url, shot, said, onStop }) {
    const { poster, resolved, pending } = useMediaPoster(url, { kind: 'video' });
    const sealed = useMediaSealFailure(url);
    const label = shotLabel(shot);
    return (
        <div className="flex items-stretch gap-3 rounded-lg border border-honey/35 bg-honey-tint/60 p-2.5">
            <div className="relative grid aspect-video w-[124px] shrink-0 place-items-center overflow-hidden rounded-md border border-line1 bg-bg2">
                {poster ? (
                    // Never lazy: in a container that does not scroll, a lazy
                    // image is never asked to paint.
                    <img src={poster} alt="" loading="eager" className="h-full w-full object-cover" />
                ) : pending || (!resolved && !sealed) ? (
                    <div className="h-full w-full animate-pulse bg-bg3" />
                ) : (
                    // A locked vault and a codec the browser cannot open look
                    // identical here — one padlock glyph, no picture — so the
                    // one that has a way out says so.
                    <Icon name={sealed === 'locked' ? 'lock' : 'film'} size={16} className="text-ink3" />
                )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-honey">{tf('promptHelper.continuingShot', label)}</span>
                    <Pill tone="honey" className="!h-[18px] !px-2 !text-[9.5px]">{t('promptHelper.motionPinned')}</Pill>
                    {onStop ? (
                        <Button size="sm" variant="ghost" icon="x" className="ml-auto" onClick={onStop}>
                            {t('promptHelper.stopContinuing')}
                        </Button>
                    ) : null}
                </div>
                <p className="m-0 text-[11px] leading-relaxed text-ink2">{t('promptHelper.continuationCarries')}</p>
                {sealed === 'locked' ? (
                    <p className="m-0 text-[11px] leading-relaxed text-ink3">{t('promptHelper.shotSealed')}</p>
                ) : null}
                {/* A clip restored from an earlier session has no prompt to
                    quote — the store that holds it is in-memory only — so the
                    line is absent rather than an empty quotation. */}
                {said ? (
                    <p className="m-0 truncate text-[11px] leading-relaxed text-ink3">{tf('promptHelper.shotSaid', label, said)}</p>
                ) : null}
            </div>
        </div>
    );
}

export function PromptHelperDialog({
    open, onClose, idea, targetModel, mediaType = 'video',
    hasFirstFrame = false, hasLastFrame = false, imageUrl = '', videoUrl = '',
    // The armed scene-chaining clip, when this prompt is for a continuation.
    // Without it the helper writes each shot as a fresh scene from the idea
    // alone — and a chained prompt that stops describing the established
    // subjects and style makes H3 cut to an unrelated take (measured on the
    // rental, 2026-08-10). It is also the best thing a vision model can look
    // at here: the shot this one has to match.
    continuingFromUrl = '',
    // How that shot was written. The rules say to keep the established scene;
    // this is what says what it IS — without it, an idea like "he keeps
    // talking" leaves the helper nothing to preserve.
    continuingFromPrompt = '',
    // Which shot that is, for the banner. The dialog cannot derive it: the
    // index lives in the composer's setup beside the armed url.
    continuingFromShot = 0,
    // Disarming the chain from here, because the banner is where someone
    // notices it is armed. Absent (the Image studio) simply omits the control.
    onStopContinuing = null,
    // UGC mode is armed in the composer. It layers onto whichever profile the
    // target model picks — the model's trained format is unchanged by the clip
    // being an ad, but the judgements inside it invert: speech stops being
    // optional, and every production word becomes a tell.
    ugc = false,
    // The loaded Hive Persona's gender ('' when none is loaded or it was never
    // set). The helper writes "the woman"/"her" or "the man"/"his" from it
    // instead of guessing from the idea. Only the gender goes — the persona's
    // name is sealed to the owner's vault and stays out of every request.
    personaGender = '',
    // Who is in the shot, by slot — [{ subject, kind, gender, name, voice,
    // look }] from lib/promptWeave.js castSubjects(). With it the helper
    // writes every <Subject N> into the scene instead of inventing a stranger.
    // A persona's name never travels (it is vault-sealed); a known character's
    // does, because the model has to be told which cartoon to write.
    cast = [],
    // What the run will condition on, when reference mode is armed:
    // { images: N, videos: [{ useAudio }], audios: N }. The helper has to write
    // the labels the graph will actually carry, and it cannot count them itself.
    references = null,
    durationSeconds = null, onUse,
}) {
    const [snapshot, setSnapshot] = useState(null);
    // Whether the local runtime scan has ANSWERED — separate from what it said,
    // because a failed scan leaves `snapshot` null and still has to settle the
    // dialog. See `modelChoiceSettled` below.
    const [runtimeAnswered, setRuntimeAnswered] = useState(false);
    // The owner's EXPLICIT pick, and only that. What the dialog is actually on
    // when they have not picked yet is derived (`activeId`): a preselection
    // written into state by whichever read answered first is how the remembered
    // choice got overwritten.
    const [selected, setSelected] = useState('');
    const [unloadOthers, setUnloadOthers] = useState(true);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [profileLabel, setProfileLabel] = useState('');
    const [warnings, setWarnings] = useState([]);
    const [sawImage, setSawImage] = useState(false);
    // How much the last refinement moved, so a correct three-word edit inside a
    // twenty-line prompt is visibly a change rather than apparently nothing.
    const [changedLines, setChangedLines] = useState(null);
    const [freed, setFreed] = useState(0);
    // Separate from the number: freeing NOTHING is the common case when ComfyUI
    // is running but holding nothing, and a button that reports nothing at all
    // reads as a button that did nothing.
    const [freedShown, setFreedShown] = useState(false);
    // The owner's steer for the next Refine. One box now, rather than two
    // switches and a notes field: the switches are still reachable — the
    // suggestions under the box ARE them — and free text is what everything
    // else needs.
    const [guidance, setGuidance] = useState('');
    // Every prompt this dialog has produced, oldest first, with a cursor into
    // them. Refine is destructive on screen and "that was better before" had no
    // answer; model results push a step, hand edits replace the one they are on.
    //
    // ONE piece of state, not two: a request that lands after the owner has
    // typed would otherwise splice the list against the cursor it was fired
    // with, leaving the cursor pointing past the end and the prompt apparently
    // gone.
    const [draftState, setDraftState] = useState({ entries: [], cursor: -1 });
    const { entries: history, cursor } = draftState;
    // The idea each result was written from, so a draft written before the
    // composer changed can say so instead of quietly being about the old one.
    const [writtenFrom, setWrittenFrom] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    // Opened on its own when a row is padlocked: `blockedReason` tells the owner
    // to turn on "Unload others first" or to free memory, and both of those
    // controls live in here — a repair named behind a closed disclosure is a
    // repair nobody finds.
    const [memoryOpen, setMemoryOpen] = useState(false);
    const pillRef = useRef(null);
    // A slow load must not overwrite state from a newer one the user kicked off.
    const requestRef = useRef(0);
    // A press that landed before the model list did, held until there is a model
    // to run it on. Both reads are in flight from the moment the dialog opens,
    // so this is a wait of a second at most — and it is the difference between
    // "the dialog is still reading" and the dialog telling the owner to pick a
    // model it is about to pick for them.
    const pendingRunRef = useRef(null);
    const runRef = useRef(() => {});

    // Both sources of truth: the CATALOG drives the picker (local, HivemindOS
    // and the owner's own accounts), while the local runtime snapshot still
    // drives the things only a local model has — RAM, load/unload, and the
    // files on disk that cannot be used.
    const sources = useModelSources({ enabled: open, onOpen: setPickerOpen });

    const refresh = useCallback(async () => {
        try {
            setSnapshot(await api('/api/prompt-helper/runtime'));
            // Which model this leaves the dialog on is decided in ONE place,
            // once both reads have answered — see `activeId`. Preselecting here
            // is what lost the owner's choice: this scan sees only local models,
            // so a remembered HivemindOS or account model read as "gone" and was
            // quietly replaced by whichever GGUF happened to fit.
        } catch (exc) {
            setError(exc.message);
        } finally {
            // Answered, not answered well. A scan that failed still settles the
            // dialog — it means this machine offers no local model, not that the
            // dialog is still looking — and a press waiting on the list would
            // otherwise wait forever.
            setRuntimeAnswered(true);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setError('');
        refresh();
    }, [open, refresh]);

    // Nothing about the picker survives a close: this dialog stays MOUNTED
    // between opens (the video studio toggles `open`), so a panel left open
    // would come back on the next open anchored to a pill that no longer exists
    // — positioned at the corner and deaf to Escape.
    useEffect(() => {
        if (open) return;
        // Including a press still waiting for the model list: it was for this
        // sitting, and firing it into a closed dialog writes a prompt nobody
        // asked for any more. `busy` belongs to it, so it goes too — an
        // in-flight generation is not touched, it clears its own in `finally`.
        if (pendingRunRef.current) { pendingRunRef.current = null; setBusy(''); }
        setPickerOpen(false);
        setMemoryOpen(false);
        setFreed(0);
        setFreedShown(false);
    }, [open]);

    // ⌘↵ is promised in the footer, so it is bound for the whole dialog rather
    // than only for the textarea that happens to have focus. Not while the
    // picker is open: there the key belongs to whatever is being chosen.
    const acceptRef = useRef(() => {});
    useEffect(() => {
        if (!open || pickerOpen) return undefined;
        const onKey = (event) => {
            if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            acceptRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, pickerOpen]);

    // A padlocked row's reason names a control — "turn on Unload others first",
    // "more than this machine can free" — and both of them live inside the
    // Memory disclosure. So it opens itself the first time there is a padlock,
    // and still closes when the owner closes it.
    const blocked = (sources.catalog?.models || []).some(
        (model) => needsLoad(model) && !canSelect(model, { unloadOthers }),
    );
    useEffect(() => { if (blocked) setMemoryOpen(true); }, [blocked]);

    // Picking a model is a durable choice, not a per-open one: the next open
    // starts here, on this machine, whatever ends up loaded in the meantime.
    const choose = useCallback((modelId) => {
        setSelected(modelId);
        rememberModelId(modelId);
        setPickerOpen(false);
    }, []);

    // Both reads have answered. The catalog always does (one that cannot be
    // read is a catalog with no models); the runtime scan reports through
    // `runtimeAnswered`, so a failed scan settles the dialog too.
    const modelChoiceSettled = sources.catalog !== null && runtimeAnswered;
    // What the dialog is ON: the owner's explicit pick, else the model the two
    // reads settle on. DERIVED, so there is no frame where the dialog knows the
    // answer and the screen still says "pick a model".
    const activeId = selected || (modelChoiceSettled
        ? startingModelIdWithRuntime(sources.catalog, {
            lastUsedId: lastUsedModelId(),
            runtimeModels: snapshot?.models || [],
            loadedId: snapshot?.loaded?.[0]?.modelId || '',
        })
        : '');
    const selectedModel = rowFor(sources.catalog, activeId);
    // Which section the picker opens on: the one the owner last moved to, else
    // the one the chosen model lives on, else this machine.
    const pickerTab = sources.tab || (selectedModel ? tabOf(selectedModel) : LOCAL);
    // Only a local model has to be pulled into RAM before it can answer; a
    // cloud one is served by a machine that is already running.
    const isLoaded = !needsLoad(selectedModel) || selectedModel?.fit === 'loaded';
    const held = externalHold(snapshot);

    // Settled with nothing to offer must not leave the pill saying "pick a
    // model" with nothing pressed to do it. Only once BOTH reads have answered:
    // opening on the first one's silence flung the picker open on every open of
    // a machine whose models are all in the cloud.
    useEffect(() => {
        if (!open || !modelChoiceSettled || selectedModel) return;
        setPickerOpen(true);
    }, [open, modelChoiceSettled, selectedModel]);

    // The held press, released. Through `runRef` rather than `run` itself:
    // `run` is rebuilt every render and this has to call the CURRENT one, so it
    // reads the idea and the draft as they are now. With a model it runs; with
    // the reads settled and still no model it runs too, and takes the honest
    // "pick a model first" branch below.
    useEffect(() => {
        if (!pendingRunRef.current) return;
        if (!selectedModel && !modelChoiceSettled) return;
        const queued = pendingRunRef.current;
        pendingRunRef.current = null;
        setBusy('');
        void runRef.current(queued);
    }, [modelChoiceSettled, selectedModel]);

    const run = async ({ refine = null } = {}) => {
        // Silence here reads as a dead button. What the OWNER controls is
        // checked first and answered straight away: an empty box is an empty box
        // whether or not the model list has arrived.
        const current = cursor >= 0 ? history[cursor] : '';
        const refineBase = refine ? (current || idea || '').trim() : '';
        if (refine && !refineBase) {
            setError(t('promptHelper.writeBeforeRefine'));
            return;
        }
        if (!refine && !(idea || '').trim()) {
            setError(t('promptHelper.writeBeforeHelper'));
            return;
        }
        if (!selectedModel) {
            // Pressed before the reads came back. The choice is not missing —
            // it is in this browser's prefs and the dialog is a moment from
            // settling on it — so the press waits rather than being told to
            // pick the very model that is about to appear under it.
            if (!modelChoiceSettled) {
                pendingRunRef.current = { refine };
                setError('');
                setBusy(t('promptHelper.readingModelList'));
                return;
            }
            setError(t('promptHelper.pickModelFirst'));
            setPickerOpen(true);
            return;
        }
        const ticket = ++requestRef.current;
        setError('');
        try {
            if (!isLoaded) {
                setBusy(tf('promptHelper.loadingModel', selectedModel.name));
                let loaded = await api('/api/prompt-helper/load', { modelId: selectedModel.id, unloadOthers });
                if (ticket !== requestRef.current) return;
                // A load another tab (or an earlier click) already started answers
                // `status: 'loading'` — wait for llama-server to come up rather than
                // firing a request it will refuse.
                const deadline = Date.now() + 4 * 60 * 1000;
                while (loaded?.status === 'loading' && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 2500));
                    if (ticket !== requestRef.current) return;
                    const snap = await api('/api/prompt-helper/runtime');
                    const row = (snap?.models || []).find((m) => m.id === selectedModel.id);
                    loaded = { ...snap, status: row?.fit === 'loading' ? 'loading' : 'loaded' };
                }
                setSnapshot(loaded);
                await sources.refresh();
            }
            // The start frame is sealed at rest, so it is decrypted here and
            // sent as a data URL — it goes to a llama-server on this machine
            // and no further.
            // A clip beats a still: it carries the motion, which is what a video
            // prompt is actually about. An armed chain counts — the shot this
            // one continues is the thing the new prompt has to keep matching.
            const sourceClip = videoUrl || continuingFromUrl;
            const sourceLabel = videoUrl ? t('promptHelper.sourceClip') : continuingFromUrl ? t('promptHelper.previousShot') : t('promptHelper.startFrame');
            let image = '';
            if (selectedModel.vision && (sourceClip || imageUrl)) {
                setBusy(sourceClip ? tf('promptHelper.watching', sourceLabel) : t('promptHelper.readingStartFrame'));
                try {
                    // The vision projector only reads stills, so a clip goes in
                    // as a contact sheet.
                    image = sourceClip
                        ? (await videoContactSheet(sourceClip)) || ''
                        : (await referenceToLocalImageInput(imageUrl)).image_base64 || '';
                } catch { /* fall back to writing from the idea alone */ }
                if (ticket !== requestRef.current) return;
            }
            setBusy(refine
                ? t('promptHelper.refining')
                : image ? tf('promptHelper.writingFrom', sourceLabel) : t('promptHelper.writing'));
            // H3 identifies characters through their source (name, casting,
            // work, year). When the idea names ones the studio's catalog
            // knows, ship the verified facts so the local model cannot
            // misremember a casting. Matched against the draft too: a
            // refine note like "add Willow" should land enriched as well.
            const characterNotes = /minimax|(^|[-_.])h3([-_.]|$)/i.test(targetModel || '')
                ? characterNoteLines(charactersMentionedIn(`${idea}\n${refine ? `${refineBase}\n${refine.guidance || ''}` : ''}`))
                : [];
            const data = await api('/api/prompt-helper/generate', {
                modelId: selectedModel.id,
                idea,
                targetModel: targetModel || '',
                mediaType,
                characterNotes: characterNotes.length ? characterNotes : undefined,
                // MiniMax H3 treats a start frame as a different task, with its
                // own opening anchor line, so the helper has to be told.
                hasFirstFrame: Boolean(hasFirstFrame),
                hasLastFrame: Boolean(hasLastFrame),
                // Scene chaining: this prompt continues an existing shot, which
                // changes what a good prompt IS — it has to re-describe the
                // established scene and open on the carried-over framing.
                isContinuation: Boolean(continuingFromUrl),
                previousPrompt: (continuingFromUrl && continuingFromPrompt) || null,
                ugc: Boolean(ugc),
                personaGender: personaGender || undefined,
                cast: Array.isArray(cast) && cast.length
                  ? cast.map((member) => ({
                    subject: member.subject,
                    kind: member.kind,
                    gender: member.gender || '',
                    name: member.kind === 'character' ? (member.name || '') : '',
                    voice: Boolean(member.voice),
                    look: member.look || '',
                  }))
                  : undefined,
                // Reference mode: how many of each are attached, and which
                // clips bring their own soundtrack (each of those takes an
                // <Audio N> label of its own, before its <Video N>).
                // Measured lengths ride along with the counts: a motion clip
                // shorter than the shot only drives its opening, and the writer
                // has to be told to carry the movement past where it runs out.
                references: references && (references.images || references.videos?.length || references.audios)
                  ? {
                    images: Number(references.images) || 0,
                    videos: (references.videos || []).map((item) => ({
                      useAudio: Boolean(item?.useAudio),
                      seconds: Number(item?.seconds) > 0 ? Number(item.seconds) : null,
                    })),
                    audios: Number(references.audios) || 0,
                    audioSeconds: (references.audioSeconds || []).map(
                      (value) => (Number(value) > 0 ? Number(value) : null),
                    ),
                  }
                  : undefined,
                durationSeconds: durationSeconds || null,
                imageBase64: image || null,
                currentPrompt: refine ? refineBase : null,
                refine: refine || undefined,
            });
            if (ticket !== requestRef.current) return;
            // Covers the model the picker chose for them: once it has actually
            // written a prompt, it is the one to come back to.
            rememberModelId(selectedModel.id);
            const written = data.prompt || '';
            // A new result is a new step, and anything that had been undone past
            // is dropped — a redo branch that no longer follows from what is on
            // screen is worse than no redo at all. Spliced against the CURRENT
            // cursor rather than the one this request was fired with.
            setDraftState(({ entries, cursor: at }) => {
                const base = entries.slice(0, at + 1);
                return { entries: [...base, written], cursor: base.length };
            });
            setWrittenFrom((idea || '').trim());
            setProfileLabel(data.profileLabel || '');
            setWarnings(data.warnings || []);
            setSawImage(Boolean(data.sawImage));
            setChangedLines(refine ? (data.changedLines ?? null) : null);
            if (refine) setGuidance('');
        } catch (exc) {
            if (ticket !== requestRef.current) return;
            setError(exc.message);
        } finally {
            if (ticket === requestRef.current) {
                setBusy('');
                refresh();
            }
        }
    };

    // Assigned during render, like `acceptRef` below: the effect above holds a
    // press from an earlier render and must release it into this one.
    runRef.current = run;

    // ComfyUI can hold tens of GB of diffusion weights long after a generation
    // finished. Without this the picker could only report that a model did not
    // fit; now it can do something about it.
    const freeComfy = async () => {
        setBusy(t('promptHelper.freeingComfy'));
        setError('');
        try {
            const data = await api('/api/prompt-helper/free-comfy', {});
            setSnapshot(data);
            setFreed(Number(data.freedBytes) || 0);
            setFreedShown(true);
            // Every padlock in the picker is a `fit` computed on the SERVER and
            // carried by the catalog. Freeing memory without re-reading it
            // leaves the rows this just unlocked still locked, with the button
            // that was supposed to unlock them apparently doing nothing.
            await sources.refresh();
        } catch (exc) {
            setError(exc.message);
        } finally {
            setBusy('');
        }
    };

    const unload = async (modelId) => {
        setBusy(t('promptHelper.unloading'));
        try {
            setSnapshot(await api('/api/prompt-helper/unload', { modelId }));
            await sources.refresh();
        } catch (exc) {
            setError(exc.message);
        } finally {
            setBusy('');
        }
    };

    if (!open) return null;

    const unavailable = snapshot && !snapshot.available;
    // The prompt box holds what the HELPER wrote and nothing else. Seeding it
    // from the composer showed one thing twice — the idea in the card, and the
    // same words again under "prompt" — which is the exact confusion the idea
    // card exists to remove.
    const draft = cursor >= 0 ? history[cursor] : '';
    // Written before the composer's idea last changed. The draft is still
    // usable — it is just no longer about what is in the box above it.
    const isStale = Boolean(draft) && writtenFrom !== (idea || '').trim();
    const accept = () => { if (draft.trim() && !busy) { onUse?.(draft.trim()); onClose?.(); } };
    // The window listener above is registered once; this is how it always calls
    // the CURRENT accept rather than the one from the render it was bound in.
    acceptRef.current = accept;
    // A hand edit REPLACES the step it started from rather than adding one: undo
    // is for "that refinement was worse", not for a keystroke. It does drop the
    // redo branch, which no longer follows from the text on screen.
    const editDraft = (text) => {
        setDraftState(({ entries, cursor: at }) => {
            if (at < 0) return { entries: [text], cursor: 0 };
            return {
                entries: entries.slice(0, at + 1).map((held, index) => (index === at ? text : held)),
                cursor: at,
            };
        });
        if (cursor < 0) setWrittenFrom((idea || '').trim());
    };
    // Stepping through history moves the prompt but not the sentences ABOUT it —
    // the change count, the timeline warnings, the "read your start frame" badge
    // and the guidance label all describe the step they came back with, and left
    // standing over a different one every one of them is a lie.
    const step = (delta) => {
        setDraftState(({ entries, cursor: at }) => ({
            entries,
            cursor: Math.min(entries.length - 1, Math.max(0, at + delta)),
        }));
        setChangedLines(null);
        setWarnings([]);
        setSawImage(false);
        setProfileLabel('');
    };
    const write = () => run();
    // A press and a typed note are both "what to change", so a press never
    // throws the note away — the server takes one guidance field and both go
    // into it, with the knobs the press carries riding alongside.
    const refineWith = (refine) => run({
        refine: {
            detail: refine?.detail || 'keep',
            shots: mediaType === 'video' ? (refine?.shots || 'keep') : 'keep',
            guidance: [guidance.trim(), (refine?.guidance || '').trim()].filter(Boolean).join('\n'),
        },
    });
    // An empty box is still a Refine: the base pass is "perfect structure,
    // nothing lost, the unwritten craft decisions filled in".
    const refineNow = () => refineWith(null);
    const chips = writingForChips({ cast, references });
    const suggestions = refineSuggestions({ mediaType, chained: Boolean(continuingFromUrl) });
    const sourceLabel = videoUrl ? t('promptHelper.sourceClip') : continuingFromUrl ? t('promptHelper.previousShot') : t('promptHelper.startFrame');
    const busyAnywhere = Boolean(busy);
    const hasIdea = Boolean((idea || '').trim());

    // What the picker calls "ready": a cloud model is answered by a machine that
    // is already running, and a local one has to be in RAM first.
    const ready = (row) => !needsLoad(row) || row.fit === 'loaded';
    const blockedFor = (model) => (needsLoad(model) ? blockedReason(model, { unloadOthers }) : '');
    const groups = [
        { id: 'ready', label: t('promptHelper.readyNow'), hint: t('promptHelper.readyNowHint'), match: ready },
        { id: 'load', label: t('place.thisMac'), hint: t('promptHelper.loadsOnFirstUse'), match: (row) => !ready(row) },
    ];

    const modelPill = (
        <button
            ref={pillRef}
            type="button"
            onClick={() => setPickerOpen((value) => !value)}
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            // No aria-label: it would REPLACE the pill's own words, and those
            // words are the answer — which model, on whose bill. Labelled
            // "Model" a screen reader announced the control and never the
            // choice it is showing.
            //
            // Shut while a job is in flight: swapping models mid-generate left
            // the pill naming one model and the answer coming from another.
            disabled={busyAnywhere}
            className={cx(
                // The only door to the model picker, so it joins the control
                // ladder under a thumb rather than staying a 24.5px pill.
                'inline-flex h-7 touch:h-ctl-md min-w-0 items-center gap-1.5 rounded-full border px-2.5 touch:px-3 transition-colors',
                pickerOpen ? 'border-honey/50 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
            )}
        >
            {/* A still grey dot beside "checking…" is a dialog that looks
                broken rather than busy — and looking broken is what got the
                helper pressed before it had finished reading. */}
            {!modelChoiceSettled && !selectedModel ? (
                <Spinner size={11} label={null} className="shrink-0 text-ink3" />
            ) : (
                <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', !selectedModel ? 'bg-ink3' : isLoaded ? 'bg-ok' : 'bg-honey')} />
            )}
            {!modelChoiceSettled && !selectedModel ? (
                <span className="text-[11.5px] text-ink3">{t('promptHelper.checking')}</span>
            ) : selectedModel ? (
                <>
                    <span className="max-w-[180px] truncate text-[11.5px] font-semibold text-ink1">{selectedModel.name}</span>
                    <span className="hidden truncate text-[11.5px] text-ink3 sm:inline">{costLine(selectedModel, PROMPT_USAGE)}</span>
                </>
            ) : (
                <span className="text-[11.5px] font-semibold text-honey">{t('promptHelper.pickAModel')}</span>
            )}
            <Icon name="chevronDown" size={12} className="shrink-0 text-ink3" />
        </button>
    );

    // The RAM machinery, one press below the list it explains. Local only: a
    // model served by a machine that is already running does not spend this
    // memory, so "0 GB free" beside it warns about the wrong resource.
    const pickerFooter = pickerTab !== LOCAL ? null : (
        <div className="flex flex-col">
            {/* Not behind the Memory disclosure: with no llama-server on the
                machine every local row is unreachable, and the one thing that
                repairs it must not be two presses inside a panel about RAM. */}
            {unavailable ? (
                <p className="m-0 border-b border-line1 px-3 py-2 text-[11px] leading-snug text-ink2">
                    {t('promptHelper.noLlamaBefore')} <code>llama-server</code> {t('promptHelper.noLlamaAfter')}{' '}
                    <a
                        href="https://github.com/ggml-org/llama.cpp/releases"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-honey hover:underline"
                    >
                        {t('promptHelper.getLlamaCpp')} <Icon name="external" size={10} />
                    </a>
                </p>
            ) : null}
            <div className="flex items-center gap-2 px-3 py-2">
                {snapshot === null ? (
                    <span className="flex items-center gap-2 text-[11px] text-ink3"><Spinner size={11} /> {t('promptHelper.checkingRam')}</span>
                ) : (
                    <span className="text-[11px] text-ink3">
                        <span className="font-semibold text-ink1">{formatBytes(snapshot?.availableBytes)}</span> {t('promptHelper.free')}
                        {snapshot?.totalBytes ? ` ${tf('promptHelper.ofTotal', formatBytes(snapshot.totalBytes))}` : ''}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setMemoryOpen((value) => !value)}
                    aria-expanded={memoryOpen}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-ink2 transition-colors hover:text-ink1"
                >
                    {t('imagePanel.memory')}
                    <Icon name="chevronDown" size={11} className={cx('transition-transform', memoryOpen && 'rotate-180')} />
                </button>
            </div>
            {memoryOpen ? (
                <div className="flex flex-col gap-2 border-t border-line1 px-3 py-2.5">
                    {snapshot?.reclaimableBytes ? (
                        <span className="text-[11px] text-ink3">{tf('promptHelper.reclaimable', formatBytes(snapshot.reclaimableBytes))}</span>
                    ) : null}
                    {held ? (
                        <span className="flex min-w-0 items-start gap-1.5 text-[11px] font-semibold leading-snug text-warn">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                            <span>{tf('promptHelper.heldByLmStudio', held.count)}</span>
                        </span>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-2 text-[11px] text-ink2">
                            {t('promptHelper.unloadOthers')}
                            <Toggle
                                checked={unloadOthers}
                                onChange={setUnloadOthers}
                                label={t('promptHelper.unloadOthersLabel')}
                                disabled={busyAnywhere}
                            />
                        </span>
                        {freedShown ? <Pill tone="ok" className="!h-5 !px-2 !text-[10px]">{tf('promptHelper.freed', formatBytes(freed))}</Pill> : null}
                        <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto"
                            disabled={busyAnywhere}
                            title={t('promptHelper.freeComfyTitle')}
                            onClick={freeComfy}
                        >
                            {t('promptHelper.freeComfy')}
                        </Button>
                    </div>
                    {/* A GGUF that is on disk but cannot be offered used to just
                        not appear, which reads as "the picker is hiding models"
                        — most often it is a symlink whose target was deleted. */}
                    {snapshot?.unavailable?.length ? (
                        <details>
                            <summary className="cursor-pointer text-[11px] text-ink3">
                                {tf('promptHelper.filesUnusable', snapshot.unavailable.length)}
                            </summary>
                            <ul className="mt-1 flex flex-col gap-0.5">
                                {snapshot.unavailable.map((entry) => (
                                    <li key={entry.path} className="truncate text-[11px] text-ink3" title={entry.path}>
                                        {entry.id} — {entry.reason}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}
                </div>
            ) : null}
        </div>
    );

    const footer = (
        <>
            {busy ? (
                <span role="status" aria-live="polite" className="mr-auto flex items-center gap-2 text-xs text-ink2">
                    <Spinner size={13} /> {busy}
                </span>
            ) : (
                <span className="mr-auto flex items-center gap-1.5 text-[11px] text-ink3">
                    <Kbd>⌘↵</Kbd> {t('promptHelper.toUse')}
                </span>
            )}
            <Button variant="ghost" onClick={onClose} disabled={busyAnywhere}>{t('common.cancel')}</Button>
            <Button
                variant="primary"
                disabled={!draft.trim() || busyAnywhere}
                onClick={accept}
                title={t('promptHelper.useThisTitle')}
            >
                {t('common.usePrompt')}
            </Button>
        </>
    );

    return (
        <Modal
            open={open}
            onClose={onClose}
            title={t('image.promptHelper')}
            size="wide"
            titleAside={modelPill}
            footer={footer}
        >
            {pickerOpen ? (
                <AnchoredPanel
                    anchor={pillRef.current}
                    width="min(440px, calc(100vw - 2rem))"
                    label={t('common.model')}
                    onClose={() => setPickerOpen(false)}
                >
                    <CompactModelPicker
                        {...sources.pickerProps}
                        listLabel={t('common.model')}
                        tab={pickerTab}
                        selectedId={activeId}
                        onPick={choose}
                        groups={groups}
                        // Where the owner left off, so the row they reach for
                        // nine times out of ten is the one wearing a mark.
                        badgeFor={(model) => (model.id === lastUsedModelId() ? t('promptHelper.lastUsed') : null)}
                        // A model that cannot be loaded is not a choice, and the
                        // reason is the repair: the Memory panel under this list
                        // is where the room comes from.
                        blockedFor={blockedFor}
                        // One media prompt per press: less out than a Story
                        // draft, so the estimate beside each paid row is
                        // sized for THIS dialog's ask.
                        usage={PROMPT_USAGE}
                        // Unload stays ON the row it acts on. A model holding
                        // 20 GB is the reason this dialog has a memory UX at
                        // all, and moving that control away from the model it
                        // frees is how it stops being used.
                        rowAction={(model) => (model.fit === 'loaded' ? (
                            <IconButton
                                icon="x"
                                size="sm"
                                disabled={busyAnywhere}
                                // An MTPLX slot is a server this app adopted rather
                                // than a model it loaded, so "Unload" is the wrong
                                // verb for what the button does to it.
                                label={model.provider === 'mtplx' ? t('promptHelper.stopLocalHelper') : tf('promptHelper.unloadModel', model.name)}
                                onClick={(event) => { event.stopPropagation(); void unload(model.id); }}
                            />
                        ) : null)}
                        footer={pickerFooter}
                    />
                </AnchoredPanel>
            ) : null}

            <div className="flex min-h-0 flex-col gap-3">
                {/* What you said, as the helper received it. Read-only on
                    purpose: the composer owns it. It is also the door — the
                    press that turns it into a prompt lives on it, and goes
                    honey the moment the prompt underneath is out of date. */}
                <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg0 px-3 py-2">
                    <div className="flex items-center gap-2">
                        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink3">{t('promptHelper.yourIdea')}</span>
                        <span className="hidden text-[10.5px] text-ink3/85 sm:inline">{t('promptHelper.mirrorsComposer')}</span>
                        <Button
                            size="sm"
                            variant={isStale ? 'primary' : 'neutral'}
                            icon="wand"
                            className="ml-auto"
                            disabled={!hasIdea || busyAnywhere}
                            onClick={write}
                        >
                            {draft ? t('promptHelper.rewriteFromThis') : t('promptHelper.writeFromThis')}
                        </Button>
                    </div>
                    <p className={cx('m-0 line-clamp-3 text-[12.5px] leading-relaxed', hasIdea ? 'text-ink2' : 'text-ink3')}>
                        {hasIdea ? idea : t('promptHelper.writeBeforeHelper')}
                    </p>
                </div>

                {/* What the helper has been told about this shot, so the user
                    can see it knows rather than having to trust it. */}
                {chips.length ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1.5 pr-0.5 text-[11px] text-ink3">
                            <Icon name="persona" size={12} />
                            {t('promptHelper.writingFor')}
                        </span>
                        {chips.map((chip) => (
                            <span key={chip} className="inline-flex h-[22px] items-center rounded-full border border-line1 bg-bg2 px-2.5 text-[10.5px] font-medium text-ink2">
                                {chip}
                            </span>
                        ))}
                    </div>
                ) : null}

                {continuingFromUrl ? (
                    <ContinuingBanner
                        url={continuingFromUrl}
                        shot={continuingFromShot}
                        said={continuingFromPrompt}
                        onStop={onStopContinuing ? () => { onStopContinuing(); } : null}
                    />
                ) : null}

                {error ? (
                    <div className="flex items-start gap-2 rounded-md border border-danger bg-danger-tint px-3 py-2" role="alert">
                        <Icon name="warning" size={13} className="mt-px shrink-0 text-danger" />
                        <span className="min-w-0 break-words font-mono text-xs text-ink1">{error}</span>
                    </div>
                ) : null}

                {!draft ? (
                    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                        <div className="grid h-11 w-11 place-items-center rounded-lg border border-line1 bg-bg2 text-ink3">
                            <Icon name="wand" size={20} />
                        </div>
                        <div className="flex max-w-[42ch] flex-col gap-1">
                            <span className="text-[13px] font-semibold text-ink1">{t('promptHelper.emptyTitle')}</span>
                            <span className="text-[12px] leading-relaxed text-ink3">{t('promptHelper.emptyHint')}</span>
                        </div>
                        <Button variant="primary" disabled={!hasIdea || busyAnywhere} onClick={write}>
                            {t('promptHelper.writePrompt')}
                        </Button>
                    </div>
                ) : (
                <>
                    <div className="flex min-h-0 flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                            <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-ink3">
                                {t('promptHelper.suggestedPrompt')}
                            </span>
                            <span className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                                {durationSeconds ? (
                                    <span className="hidden whitespace-nowrap text-[11px] text-ink3 sm:inline">{tf('promptHelper.clipSeconds', durationSeconds)}</span>
                                ) : null}
                                {profileLabel ? (
                                    <span className="hidden max-w-[200px] truncate text-[11px] text-ink3 md:inline">{tf('promptHelper.guidanceIs', profileLabel)}</span>
                                ) : null}
                                {/* Refine is destructive on screen: without
                                    these, "that was better before" has no
                                    answer but to write it again. */}
                                <span className="inline-flex items-center gap-0.5 rounded-md border border-line1 bg-bg2 p-0.5">
                                    {/* One glyph, mirrored: a step back and a
                                        step forward read as one control, which
                                        two unrelated arrows never do. */}
                                    <IconButton
                                        icon="refresh"
                                        size="sm"
                                        className="[&>svg]:-scale-x-100"
                                        disabled={cursor <= 0 || busyAnywhere}
                                        label={t('promptHelper.undo')}
                                        onClick={() => step(-1)}
                                    />
                                    <IconButton
                                        icon="refresh"
                                        size="sm"
                                        disabled={cursor < 0 || cursor >= history.length - 1 || busyAnywhere}
                                        label={t('promptHelper.redo')}
                                        onClick={() => step(1)}
                                    />
                                </span>
                                {sawImage ? (
                                    <Pill tone="info" className="!h-[22px] whitespace-nowrap !px-2.5 !text-[10.5px]">{tf('promptHelper.readYour', sourceLabel)}</Pill>
                                ) : null}
                                {changedLines ? (
                                    <Pill tone="honey" dot className="!h-[22px] whitespace-nowrap !px-2.5 !text-[10.5px]">{tf('promptHelper.linesChanged', changedLines)}</Pill>
                                ) : null}
                            </span>
                        </div>

                        {/* A beat past the end of the clip never renders, so the
                            last thing described silently goes missing. */}
                        {warnings.map((warning) => (
                            <p key={warning} className="m-0 text-[11px] leading-relaxed text-warn">{warning}</p>
                        ))}

                        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line1 bg-bg2 focus-within:border-honey/60">
                            {isStale ? (
                                <div className="flex items-center gap-3 border-b border-line1 px-3.5 py-2">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink3" />
                                    <span className="min-w-0 text-[11px] leading-relaxed text-ink3">{t('promptHelper.staleDraft')}</span>
                                    {/* The same press as the card's, said again
                                        beside the prompt it is actually about. */}
                                    <button
                                        type="button"
                                        disabled={busyAnywhere}
                                        onClick={write}
                                        className="ml-auto shrink-0 text-[11px] font-medium text-ink2 underline transition-colors hover:text-ink1 disabled:opacity-40"
                                    >
                                        {t('promptHelper.rewriteFromThis')}
                                    </button>
                                </div>
                            ) : null}
                            <TextArea
                                rows={9}
                                aria-label={t('promptHelper.suggestedPrompt')}
                                value={draft}
                                onChange={(event) => editDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); accept(); }
                                }}
                                // `!text-[13px]` outranks base.css's coarse-pointer
                                // 16px floor, and this is the app's longest
                                // typing surface — editing a prompt here on a
                                // phone zoomed the whole dialog in and left it
                                // there. The touch size has to be `!` to win.
                                className="!min-h-[180px] !rounded-none !border-0 !bg-transparent !px-3.5 !py-3.5 !text-[13px] touch:!text-[16px] !leading-[1.8] hover:!border-0 focus:!border-0"
                            />
                        </div>
                    </div>

                    {/* One box and five presses, instead of two switches and a
                        notes field. The presses ARE the switches — "add more
                        detail" is the enrich knob, which carries a craft
                        sentence free text would lose — and the box is for
                        everything the switches were never going to cover. */}
                    <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg1 p-3">
                        <div className="flex items-center gap-2">
                            <TextInput
                                value={guidance}
                                placeholder={t('promptHelper.refinePlaceholder')}
                                onChange={(event) => setGuidance(event.target.value)}
                                aria-label={t('promptHelper.refinePlaceholder')}
                                onKeyDown={(event) => {
                                    // ⌘↵ is the footer's promise and belongs to
                                    // Use prompt even in here; plain Enter is
                                    // this box's own submit.
                                    if (event.metaKey || event.ctrlKey) return;
                                    if (event.key === 'Enter' && !event.shiftKey && draft.trim() && !busyAnywhere) {
                                        event.preventDefault();
                                        refineNow();
                                    }
                                }}
                            />
                            <button
                                type="button"
                                disabled={!draft.trim() || busyAnywhere}
                                onClick={refineNow}
                                title={t('promptHelper.refineTitle')}
                                className="inline-flex h-ctl-md shrink-0 items-center gap-2 rounded-md border border-honey/45 bg-honey-tint px-3.5 text-[13px] font-semibold text-honey transition-colors duration-150 hover:bg-honey-tint/[1.6] active:translate-y-px disabled:opacity-40"
                            >
                                <Icon name="sparkles" size={14} />
                                {t('composer.refine')}
                            </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            <span className="text-[11.5px] text-ink3">{t('promptHelper.tryColon')}</span>
                            {suggestions.map((suggestion) => (
                                <button
                                    key={suggestion.id}
                                    type="button"
                                    disabled={!draft.trim() || busyAnywhere}
                                    onClick={() => refineWith(suggestion)}
                                    className="text-[11.5px] text-ink2 underline decoration-line2 underline-offset-2 transition-colors hover:text-ink1 hover:decoration-ink2 disabled:opacity-40"
                                >
                                    {suggestion.id === 'matchShot'
                                        ? tf('promptHelper.suggestMatchShot', shotLabel(continuingFromShot))
                                        : (SUGGESTION_LABEL[suggestion.id] || (() => suggestion.id))()}
                                </button>
                            ))}
                        </div>
                    </div>
                </>
                )}
            </div>
        </Modal>
    );
}
