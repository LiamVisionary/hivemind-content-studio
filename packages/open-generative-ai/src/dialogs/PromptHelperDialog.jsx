// Prompt helper: refine an idea into a prompt, on whichever model is chosen.
//
// Replaces the per-workflow ComfyUI prompt_assistant node. It used to be local
// only — any GGUF the studio could find, run in a llama-server this app owns —
// which meant a machine with no weights on it had a dialog that could not write
// anything, while the Story producer one screen over was happily using the
// owner's ChatGPT plan. It now offers the same three sources the producer does
// (`components/ModelSourcePicker.jsx`, `lib/useModelSources.js`).
//
// The memory UX is still the load-bearing part FOR A LOCAL MODEL. A 30 GB model
// loaded while a video generation holds 20 GB is an OOM that kills the
// generation, so the picker disables anything that cannot fit and the "unload
// others first" toggle is what makes the borderline ones reachable. None of
// that applies to a cloud model, so none of it is shown for one — a load step
// that is skipped, and a RAM header that would be warning about the wrong
// resource.
import { useCallback, useEffect, useRef, useState } from 'react';

import { Modal } from '../ui/Modal.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, CollapsibleSection, IconButton, Pill, SectionLabel, Segmented, Spinner, TextArea, Toggle, cx } from '../ui/kit.jsx';
import {
    describeWritingFor,
    externalHold,
    formatBytes,
    lastUsedModelId,
    preferredModelId,
    rememberModelId,
} from '../lib/promptHelperRuntime.js';
import { flattenApiDetail } from '../lib/muapiErrors.js';
import { ModelSourcePicker } from '../components/ModelSourcePicker.jsx';
import { useModelSources } from '../lib/useModelSources.js';
import { LOCAL, needsLoad, PROMPT_USAGE, rowFor, startingModelId, statusLine, tabOf } from '../lib/textModels.js';
import { referenceToLocalImageInput } from '../lib/hivemindStudio.js';
import { videoContactSheet } from '../lib/contactSheet.js';
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
    const [selected, setSelected] = useState('');
    const [unloadOthers, setUnloadOthers] = useState(true);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [result, setResult] = useState('');
    const [profileLabel, setProfileLabel] = useState('');
    const [warnings, setWarnings] = useState([]);
    const [sawImage, setSawImage] = useState(false);
    // How much the last refinement moved, so a correct three-word edit inside a
    // twenty-line prompt is visibly a change rather than apparently nothing.
    const [changedLines, setChangedLines] = useState(null);
    const [freed, setFreed] = useState(0);
    // Refinement controls — how much the Refine pass may do, plus the owner's
    // free-text steer. Tucked into a disclosure so the default path stays two
    // buttons; the notes field replaces the old "describe a change" box.
    const [refineDetail, setRefineDetail] = useState('keep');
    const [refineShots, setRefineShots] = useState('keep');
    const [guidance, setGuidance] = useState('');
    // The model picker collapses to one line once a usable model is settled;
    // it starts open only when there is nothing to write with yet.
    const [pickerOpen, setPickerOpen] = useState(false);
    // A slow load must not overwrite state from a newer one the user kicked off.
    const requestRef = useRef(0);

    // Both sources of truth: the CATALOG drives the picker (local, HivemindOS
    // and the owner's own accounts), while the local runtime snapshot still
    // drives the things only a local model has — RAM, load/unload, and the
    // files on disk that cannot be used.
    const sources = useModelSources({ enabled: open });

    const refresh = useCallback(async () => {
        try {
            const data = await api('/api/prompt-helper/runtime');
            setSnapshot(data);
            // Nothing chosen yet — a fresh page load, or the stack restarted
            // and killed the server. Start from the model this browser last
            // used; only when that one is gone or cannot fit does it fall back
            // to what is in RAM, and then to the first model that fits (leaving
            // it empty left every action silently inert).
            setSelected((current) => current || preferredModelId(data.models, {
                lastUsedId: lastUsedModelId(),
                loadedId: data.loaded?.[0]?.modelId || '',
            }));
            // `preferredModelId` only knows about this machine, so on a box with
            // no GGUF on it the dialog used to settle on nothing and every
            // action was silently inert. The catalog decides in that case — and
            // it can answer with HivemindOS or one of the owner's own accounts.
        } catch (exc) {
            setError(exc.message);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setError('');
        refresh();
    }, [open, refresh]);

    // A fresh open with no usable model must not hide the picker behind a
    // one-line summary that reads "pick a model" with nothing to click.
    useEffect(() => {
        if (!open || snapshot === null) return;
        if (!selected && sources.catalog) {
            const fallback = startingModelId(sources.catalog, lastUsedModelId());
            if (fallback) { setSelected(fallback); return; }
        }
        if (!selected) setPickerOpen(true);
    }, [open, snapshot, selected, sources.catalog]);

    // Picking a model is a durable choice, not a per-open one: the next open
    // starts here, on this machine, whatever ends up loaded in the meantime.
    const choose = useCallback((modelId) => {
        setSelected(modelId);
        rememberModelId(modelId);
    }, []);

    const selectedModel = rowFor(sources.catalog, selected);
    // Which tab the picker opens on: the one the owner last moved to, else the
    // one the chosen model lives on, else this machine.
    const pickerTab = sources.tab || (selectedModel ? tabOf(selectedModel) : LOCAL);
    // Only a local model has to be pulled into RAM before it can answer; a
    // cloud one is served by a machine that is already running.
    const isLoaded = !needsLoad(selectedModel) || selectedModel?.fit === 'loaded';
    const held = externalHold(snapshot);

    const run = async ({ refine = null } = {}) => {
        // Silence here reads as a dead button. Both of these are reachable —
        // no model is selected when nothing is loaded on a fresh open.
        if (!selectedModel) {
            setError(t('promptHelper.pickModelFirst'));
            setPickerOpen(true);
            return;
        }
        const refineBase = refine ? (result || idea || '').trim() : '';
        if (refine && !refineBase) {
            setError(t('promptHelper.writeBeforeRefine'));
            return;
        }
        if (!refine && !(idea || '').trim()) {
            setError(t('promptHelper.writeBeforeHelper'));
            return;
        }
        const ticket = ++requestRef.current;
        setError('');
        if (!refine) setResult('');
        try {
            if (!isLoaded) {
                setBusy(`Loading ${selectedModel.name}…`);
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
            setResult(data.prompt || '');
            setProfileLabel(data.profileLabel || '');
            setWarnings(data.warnings || []);
            setSawImage(Boolean(data.sawImage));
            setChangedLines(refine ? (data.changedLines ?? null) : null);
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

    // ComfyUI can hold tens of GB of diffusion weights long after a generation
    // finished. Without this the picker could only report that a model did not
    // fit; now it can do something about it.
    const freeComfy = async () => {
        setBusy(t('promptHelper.freeingComfy'));
        setError('');
        try {
            const data = await api('/api/prompt-helper/free-comfy', {});
            setSnapshot(data);
            setFreed(data.freedBytes || 0);
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
        } catch (exc) {
            setError(exc.message);
        } finally {
            setBusy('');
        }
    };

    if (!open) return null;

    const unavailable = snapshot && !snapshot.available;
    // The dialog's result is component state, so a reload loses it — but the
    // prompt itself is still in the composer. Treat that as the current draft
    // so "edit what I already have" works on a fresh open, without persisting
    // prompt text anywhere (it stays in the composer's encrypted store).
    const draft = result || (idea || '').trim();
    const fromComposer = !result && Boolean(draft);
    const accept = () => { if (draft.trim() && !busy) { onUse?.(draft.trim()); onClose?.(); } };
    const refineNow = () => run({
        refine: {
            detail: refineDetail,
            shots: mediaType === 'video' ? refineShots : 'keep',
            guidance: guidance.trim(),
        },
    });
    const writingFor = describeWritingFor({ cast, references });

    // The actions belong to Modal's footer, not the body: the body scrolls, and a
    // long suggested prompt would otherwise push them off the bottom of the dialog.
    const footer = (
        <>
            {busy ? (
                <span className="mr-auto flex items-center gap-2 text-xs text-ink2">
                    <Spinner size={13} /> {busy}
                </span>
            ) : null}
            <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>{t('common.cancel')}</Button>
            {/* Called with no argument on purpose: run() takes an options
                object, and a click handler would otherwise hand it an event. */}
            <Button onClick={() => run()} disabled={!idea.trim() || Boolean(busy)}>
                {result ? t('promptHelper.rewriteFromIdea') : t('promptHelper.writePrompt')}
            </Button>
            <Button
                icon="sparkles"
                onClick={refineNow}
                disabled={!draft.trim() || Boolean(busy)}
                title={t('promptHelper.refineTitle')}
            >
                {t('composer.refine')}
            </Button>
            <Button
                variant="primary"
                disabled={!draft.trim() || Boolean(busy)}
                onClick={accept}
                title={t('promptHelper.useThisTitle')}
            >
                {t('common.usePrompt')}
            </Button>
        </>
    );

    return (
        <Modal open={open} onClose={onClose} title={t('image.promptHelper')} size="lg" footer={footer}>
            <div className="flex flex-col gap-4">
                {unavailable ? (
                    <Card className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-xs text-ink2">
                        {/* A <code> element splits the sentence; the table holds the two halves. */}
                        <span>{t('promptHelper.noLlamaBefore')} <code>llama-server</code> {t('promptHelper.noLlamaAfter')}</span>
                        <a
                            href="https://github.com/ggml-org/llama.cpp/releases"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-honey hover:underline"
                        >
                            {t('promptHelper.getLlamaCpp')} <Icon name="external" size={11} />
                        </a>
                    </Card>
                ) : null}

                {/* What the helper has been told about this shot, so the user
                    can see it knows rather than having to trust it. */}
                {writingFor ? (
                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink2">
                        <Icon name="persona" size={12} className="mt-px shrink-0 text-ink3" />
                        <span><span className="text-ink3">{t('promptHelper.writingFor')}</span> {writingFor}</span>
                    </p>
                ) : null}

                {/* Model — one line once settled; the full picker (memory
                    numbers, every model, unload controls) is behind it. The
                    machinery matters on the day a load will not fit, and it
                    buried the two buttons that matter every day. */}
                <div>
                    <button
                        type="button"
                        onClick={() => setPickerOpen((v) => !v)}
                        aria-expanded={pickerOpen}
                        className="-mx-1 flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-ink3 transition-colors hover:text-ink1"
                    >
                        <Icon name="chevronRight" size={13} className={cx('shrink-0 transition-transform', pickerOpen && 'rotate-90')} />
                        <SectionLabel>{t('common.model')}</SectionLabel>
                        {!pickerOpen ? (
                            snapshot === null ? (
                                <span className="flex items-center gap-1.5 text-[11px] normal-case text-ink3"><Spinner size={11} /> {t('promptHelper.checking')}</span>
                            ) : selectedModel ? (
                                <span className="min-w-0 truncate text-[11px] font-medium normal-case tracking-normal text-ink2">
                                    {selectedModel.name}
                                    {/* `modelStatus` speaks RAM, which is the
                                        wrong sentence for a model that is not
                                        on this machine — and a cloud row with
                                        no price quoted has nothing to add, so
                                        it must not leave a dangling separator. */}
                                    {statusLine(selectedModel)
                                        ? <span className="text-ink3"> · {statusLine(selectedModel)}</span>
                                        : null}
                                </span>
                            ) : (
                                <span className="text-[11px] font-medium normal-case tracking-normal text-honey">{t('promptHelper.pickAModel')}</span>
                            )
                        ) : null}
                    </button>
                </div>
                {pickerOpen ? (<>
                {/* Memory header — the numbers the load decision is made from.
                    Nothing to say until the runtime has answered: "0 GB free"
                    over an empty model list read as a broken machine. And
                    nothing to say at all on a cloud tab: a model served by a
                    machine that is already running does not spend this RAM, so
                    "0 GB free" beside it is a warning about the wrong thing. */}
                {pickerTab !== LOCAL ? null : snapshot === null ? (
                    <Card className="flex items-center gap-2 p-3 text-xs text-ink3">
                        <Spinner size={13} /> {t('promptHelper.checkingRam')}
                    </Card>
                ) : (
                <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-xs">
                    <span className="text-ink2">
                        <span className="font-semibold text-ink1">{formatBytes(snapshot?.availableBytes)}</span> {t('promptHelper.free')}
                        {snapshot?.totalBytes ? <span className="text-ink3"> {tf('promptHelper.ofTotal', formatBytes(snapshot.totalBytes))}</span> : null}
                    </span>
                    {snapshot?.reclaimableBytes ? (
                        <span className="text-ink3">{tf('promptHelper.reclaimable', formatBytes(snapshot.reclaimableBytes))}</span>
                    ) : null}
                    {held ? (
                        // A sentence, not a pill: a fixed-height pill overflowed
                        // the card on narrow widths. Wraps instead.
                        <span className="flex min-w-0 items-start gap-1.5 text-[11px] font-semibold leading-snug text-warn">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                            <span>{tf('promptHelper.heldByLmStudio', held.count)}</span>
                        </span>
                    ) : null}
                    {freed ? <Pill tone="ok">{tf('promptHelper.freed', formatBytes(freed))}</Pill> : null}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={Boolean(busy)}
                        title={t('promptHelper.freeComfyTitle')}
                        onClick={freeComfy}
                    >
                        {t('promptHelper.freeComfy')}
                    </Button>
                </Card>
                )}

                <div>
                    {/* No SectionLabel here: the collapsible header above is
                        already labelled "Model", and two of them read as two
                        different sections. */}
                    <div className="mb-2 flex items-center justify-end gap-3">
                        {/* RAM is a LOCAL concern. On a cloud tab there is
                            nothing here to unload and the toggle would be a
                            control that does nothing. */}
                        {pickerTab === LOCAL ? (
                            <span className="flex items-center gap-2 text-[11px] text-ink2">
                                {t('promptHelper.unloadOthers')}
                                <Toggle
                                    checked={unloadOthers}
                                    onChange={setUnloadOthers}
                                    label={t('promptHelper.unloadOthersLabel')}
                                    disabled={Boolean(busy)}
                                />
                            </span>
                        ) : null}
                    </div>
                    <ModelSourcePicker
                        {...sources.pickerProps}
                        selectedId={selected}
                        onPick={choose}
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
                                icon="close"
                                size="sm"
                                disabled={Boolean(busy)}
                                // An MTPLX slot is a server this app adopted rather
                                // than a model it loaded, so "Unload" is the wrong
                                // verb for what the button does to it.
                                label={model.provider === 'mtplx' ? t('promptHelper.stopLocalHelper') : tf('promptHelper.unloadModel', model.name)}
                                onClick={(event) => { event.stopPropagation(); void unload(model.id); }}
                            />
                        ) : null)}
                    />
                    {/* A GGUF that is on disk but cannot be offered used to just
                        not appear, which reads as "the picker is hiding models"
                        — most often it is a symlink whose target was deleted. */}
                    {pickerTab === LOCAL && snapshot?.unavailable?.length ? (
                        <details className="mt-2">
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
                </>) : null}

                {draft ? (
                    <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <SectionLabel>{fromComposer ? t('promptHelper.currentPrompt') : t('promptHelper.suggestedPrompt')}</SectionLabel>
                            <span className="flex items-center gap-2">
                                {changedLines ? (
                                    <Pill tone="ok">{tf('promptHelper.linesChanged', changedLines)}</Pill>
                                ) : null}
                                {sawImage ? (
                                    <Pill tone="info">{tf('promptHelper.readYour', videoUrl ? t('promptHelper.sourceClip') : t('promptHelper.startFrame'))}</Pill>
                                ) : null}
                                {durationSeconds ? (
                                    <span className="text-[11px] text-ink3">{tf('promptHelper.clipSeconds', durationSeconds)}</span>
                                ) : null}
                                {profileLabel ? <span className="text-[11px] text-ink3">{tf('promptHelper.guidanceIs', profileLabel)}</span> : null}
                            </span>
                        </div>
                        {fromComposer ? (
                            <p className="mb-2 text-[11px] text-ink3">
                                {t('promptHelper.composerHolds')}
                            </p>
                        ) : null}
                        {/* A beat past the end of the clip never renders, so the
                            last thing described silently goes missing. */}
                        {warnings.map((warning) => (
                            <p key={warning} className="mb-2 text-[11px] text-warn">{warning}</p>
                        ))}
                        <TextArea
                            rows={7}
                            value={draft}
                            onChange={(e) => setResult(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); accept(); }
                            }}
                        />

                        {/* How far Refine may go. Closed, Refine still does its
                            base job — perfect structure, nothing lost, the
                            unwritten craft decisions filled in. */}
                        <CollapsibleSection title={t('promptHelper.refinementControls')} className="mt-3" storageKey="promptHelper.refine">
                            <div className="flex flex-col gap-3">
                                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                                    <span className="flex items-center gap-2 text-[11px] text-ink2">
                                        {t('promptHelper.detail')}
                                        <Segmented
                                            size="sm"
                                            value={refineDetail}
                                            onChange={setRefineDetail}
                                            options={[
                                                { value: 'keep', label: t('promptHelper.keep') },
                                                { value: 'enrich', label: t('promptHelper.addMore') },
                                            ]}
                                        />
                                    </span>
                                    {mediaType === 'video' ? (
                                        <span className="flex items-center gap-2 text-[11px] text-ink2">
                                            {t('promptHelper.shots')}
                                            <Segmented
                                                size="sm"
                                                value={refineShots}
                                                onChange={setRefineShots}
                                                options={[
                                                    { value: 'keep', label: t('promptHelper.keep') },
                                                    { value: 'more', label: t('promptHelper.addShots') },
                                                    { value: 'single', label: t('promptHelper.singleStill') },
                                                ]}
                                            />
                                        </span>
                                    ) : null}
                                </div>
                                <div>
                                    <TextArea
                                        rows={2}
                                        value={guidance}
                                        placeholder={t('promptHelper.guidancePlaceholder')}
                                        onChange={(e) => setGuidance(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) {
                                                e.preventDefault();
                                                refineNow();
                                            }
                                        }}
                                    />
                                    <p className="mt-1 text-[11px] text-ink3">
                                        {t('promptHelper.notesWin')}
                                    </p>
                                </div>
                            </div>
                        </CollapsibleSection>
                    </div>
                ) : null}

                {error ? (
                    <div className="flex items-start gap-2 rounded-md border border-danger bg-danger-tint px-3 py-2" role="alert">
                        <Icon name="warning" size={13} className="mt-px shrink-0 text-danger" />
                        <span className="min-w-0 break-words font-mono text-xs text-ink1">{error}</span>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}
