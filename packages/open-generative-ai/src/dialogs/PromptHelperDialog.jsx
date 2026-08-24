// Prompt helper: refine an idea into a prompt using a local LLM on this machine.
//
// Replaces the per-workflow ComfyUI prompt_assistant node. The owner picks any
// GGUF the studio can find, and the app runs it in a llama-server it owns, so
// load and unload are real actions here rather than something only LM Studio
// could do.
//
// The memory UX is the load-bearing part. A 30 GB model loaded while a video
// generation holds 20 GB is an OOM that kills the generation, so the picker
// disables anything that cannot fit, and the "unload others first" toggle is
// what makes the borderline ones reachable at all.
import { useCallback, useEffect, useRef, useState } from 'react';

import { Modal } from '../ui/Modal.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Card, IconButton, Pill, SectionLabel, Spinner, TextArea, Toggle, cx } from '../ui/kit.jsx';
import {
    blockedReason,
    canSelect,
    describeWritingFor,
    externalHold,
    formatBytes,
    lastUsedModelId,
    modelStatus,
    preferredModelId,
    rememberModelId,
    sortModels,
} from '../lib/promptHelperRuntime.js';
import { flattenApiDetail } from '../lib/muapiErrors.js';
import { referenceToLocalImageInput } from '../lib/hivemindStudio.js';
import { videoContactSheet } from '../lib/contactSheet.js';
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
    // How much the last revision moved, so a correct three-word edit inside a
    // twenty-line prompt is visibly a change rather than apparently nothing.
    const [changedLines, setChangedLines] = useState(null);
    const [freed, setFreed] = useState(0);
    // Model-mediated editing: say what is wrong instead of rewriting the
    // prompt by hand. The textarea stays editable for direct fixes.
    const [editing, setEditing] = useState(false);
    const [revision, setRevision] = useState('');
    // A slow load must not overwrite state from a newer one the user kicked off.
    const requestRef = useRef(0);

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
        } catch (exc) {
            setError(exc.message);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setError('');
        refresh();
    }, [open, refresh]);

    // Picking a model is a durable choice, not a per-open one: the next open
    // starts here, on this machine, whatever ends up loaded in the meantime.
    const choose = useCallback((modelId) => {
        setSelected(modelId);
        rememberModelId(modelId);
    }, []);

    const models = sortModels(snapshot?.models);
    const selectedModel = models.find((m) => m.id === selected) || null;
    const isLoaded = selectedModel?.fit === 'loaded';
    const held = externalHold(snapshot);

    const run = async ({ revise = '' } = {}) => {
        // Silence here reads as a dead button. Both of these are reachable —
        // no model is selected when nothing is loaded on a fresh open.
        if (!selectedModel) {
            setError('Pick a local model above first.');
            return;
        }
        if (!(idea || '').trim()) {
            setError('Write something in the composer before using the helper.');
            return;
        }
        const ticket = ++requestRef.current;
        setError('');
        if (!revise) setResult('');
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
            const sourceLabel = videoUrl ? 'source clip' : continuingFromUrl ? 'previous shot' : 'start frame';
            let image = '';
            if (selectedModel.vision && (sourceClip || imageUrl)) {
                setBusy(sourceClip ? `Watching the ${sourceLabel}…` : 'Reading the start frame…');
                try {
                    // The vision projector only reads stills, so a clip goes in
                    // as a contact sheet.
                    image = sourceClip
                        ? (await videoContactSheet(sourceClip)) || ''
                        : (await referenceToLocalImageInput(imageUrl)).image_base64 || '';
                } catch { /* fall back to writing from the idea alone */ }
                if (ticket !== requestRef.current) return;
            }
            setBusy(revise
                ? 'Applying your changes…'
                : image ? `Writing prompt from your ${sourceLabel}…` : 'Writing prompt…');
            // H3 identifies characters through their source (name, casting,
            // work, year). When the idea names ones the studio's catalog
            // knows, ship the verified facts so the local model cannot
            // misremember a casting. Matched against the draft too: a
            // revision like "add Willow" should land enriched as well.
            const characterNotes = /minimax|(^|[-_.])h3([-_.]|$)/i.test(targetModel || '')
                ? characterNoteLines(charactersMentionedIn(`${idea}\n${revise ? `${result || ''}\n${revise}` : ''}`))
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
                currentPrompt: revise ? (result || idea || '') : null,
                revision: revise || null,
            });
            if (ticket !== requestRef.current) return;
            // Covers the model the picker chose for them: once it has actually
            // written a prompt, it is the one to come back to.
            rememberModelId(selectedModel.id);
            setResult(data.prompt || '');
            setProfileLabel(data.profileLabel || '');
            setWarnings(data.warnings || []);
            setSawImage(Boolean(data.sawImage));
            setChangedLines(revise ? (data.changedLines ?? null) : null);
            if (revise) { setRevision(''); setEditing(false); }
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
        setBusy('Freeing ComfyUI memory…');
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
        setBusy('Unloading…');
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
            <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>Cancel</Button>
            {/* Called with no argument on purpose: run() takes an options
                object, and a click handler would otherwise hand it an event. */}
            <Button onClick={() => run()} disabled={!selectedModel || !idea.trim() || Boolean(busy)}>
                {result ? 'Regenerate' : 'Write prompt'}
            </Button>
            <Button
                variant="primary"
                disabled={!draft.trim() || Boolean(busy)}
                onClick={accept}
                title="Put this prompt in the composer (⌘/Ctrl+Enter)"
            >
                Use this prompt
            </Button>
        </>
    );

    return (
        <Modal open={open} onClose={onClose} title="Prompt helper" size="lg" footer={footer}>
            <div className="flex flex-col gap-4">
                {unavailable ? (
                    <Card className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-xs text-ink2">
                        <span>No <code>llama-server</code> found on this machine. Install llama.cpp to use the prompt helper.</span>
                        <a
                            href="https://github.com/ggml-org/llama.cpp/releases"
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-honey hover:underline"
                        >
                            Get llama.cpp <Icon name="external" size={11} />
                        </a>
                    </Card>
                ) : null}

                {/* What the helper has been told about this shot, so the user
                    can see it knows rather than having to trust it. */}
                {writingFor ? (
                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink2">
                        <Icon name="persona" size={12} className="mt-px shrink-0 text-ink3" />
                        <span><span className="text-ink3">Writing for:</span> {writingFor}</span>
                    </p>
                ) : null}

                {/* Memory header — the numbers the load decision is made from.
                    Nothing to say until the runtime has answered: "0 GB free"
                    over an empty model list read as a broken machine. */}
                {snapshot === null ? (
                    <Card className="flex items-center gap-2 p-3 text-xs text-ink3">
                        <Spinner size={13} /> Checking this machine's RAM and models…
                    </Card>
                ) : (
                <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-xs">
                    <span className="text-ink2">
                        <span className="font-semibold text-ink1">{formatBytes(snapshot?.availableBytes)}</span> free
                        {snapshot?.totalBytes ? <span className="text-ink3"> of {formatBytes(snapshot.totalBytes)}</span> : null}
                    </span>
                    {snapshot?.reclaimableBytes ? (
                        <span className="text-ink3">+{formatBytes(snapshot.reclaimableBytes)} reclaimable by unloading</span>
                    ) : null}
                    {held ? (
                        // A sentence, not a pill: a fixed-height pill overflowed
                        // the card on narrow widths. Wraps instead.
                        <span className="flex min-w-0 items-start gap-1.5 text-[11px] font-semibold leading-snug text-warn">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                            <span>{held.count} model{held.count > 1 ? 's' : ''} held by LM Studio — unload there to free that RAM</span>
                        </span>
                    ) : null}
                    {freed ? <Pill tone="ok">freed {formatBytes(freed)}</Pill> : null}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={Boolean(busy)}
                        title="Asks ComfyUI to unload its models. The queue, the open workflow and cached node results are untouched."
                        onClick={freeComfy}
                    >
                        Free ComfyUI memory
                    </Button>
                </Card>
                )}

                <div>
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <SectionLabel>Local model</SectionLabel>
                        {/* Toggle renders the switch only, so the wording lives here. */}
                        <span className="flex items-center gap-2 text-[11px] text-ink2">
                            Unload others first
                            <Toggle
                                checked={unloadOthers}
                                onChange={setUnloadOthers}
                                label="Unload other models before loading"
                                disabled={Boolean(busy)}
                            />
                        </span>
                    </div>
                    <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto" role="radiogroup" aria-label="Local model">
                        {snapshot === null ? (
                            <p className="flex items-center gap-2 px-1 py-3 text-xs text-ink3"><Spinner size={12} /> Looking for GGUF models…</p>
                        ) : models.length === 0 ? (
                            <p className="px-1 py-3 text-xs text-ink3">No GGUF models found on this machine.</p>
                        ) : null}
                        {models.map((model) => {
                            const selectable = canSelect(model, { unloadOthers });
                            const reason = blockedReason(model, { unloadOthers });
                            const active = model.id === selected;
                            const pickable = selectable && !busy;
                            const pick = () => { if (pickable) choose(model.id); };
                            // A div with role=radio rather than a <button>: the
                            // Unload control sits INSIDE the row, and a button in
                            // a button is invalid HTML that a screen reader reads
                            // as one control.
                            return (
                                <div
                                    key={model.id}
                                    role="radio"
                                    aria-checked={active}
                                    aria-disabled={!pickable || undefined}
                                    tabIndex={pickable ? 0 : -1}
                                    onClick={pick}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
                                    title={reason || model.id}
                                    className={cx(
                                        'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                                        pickable ? 'cursor-pointer' : 'cursor-not-allowed',
                                        active ? 'border-honey bg-bg2' : 'border-line1 hover:bg-bg2',
                                        !selectable && 'opacity-40 hover:bg-transparent',
                                    )}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-xs font-medium text-ink1">{model.name}</div>
                                        <div className="truncate text-[11px] text-ink3">
                                            {[model.architecture, model.quantization].filter(Boolean).join(' · ')}
                                            {reason ? ` — ${reason}` : ''}
                                        </div>
                                    </div>
                                    {/* Only a model with a projector can read the
                                        start frame; without one the opening shot
                                        is written blind. */}
                                    {(imageUrl || videoUrl) && model.vision ? (
                                        <Pill tone="info">sees your {videoUrl ? 'clip' : 'frame'}</Pill>
                                    ) : null}
                                    {model.fit === 'loaded' ? (
                                        <>
                                            <Pill tone="ok" dot>In RAM</Pill>
                                            <IconButton
                                                icon="x"
                                                size="xs"
                                                label={`Unload ${model.name}`}
                                                disabled={Boolean(busy)}
                                                onClick={(e) => { e.stopPropagation(); unload(model.id); }}
                                                onKeyDown={(e) => e.stopPropagation()}
                                            />
                                        </>
                                    ) : (
                                        <span className="shrink-0 text-[11px] text-ink3">{modelStatus(model)}</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {/* A GGUF that is on disk but cannot be offered used to just
                        not appear, which reads as "the picker is hiding models"
                        — most often it is a symlink whose target was deleted. */}
                    {snapshot?.unavailable?.length ? (
                        <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-ink3">
                                {snapshot.unavailable.length} file{snapshot.unavailable.length > 1 ? 's' : ''} on disk cannot be used
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

                {draft ? (
                    <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <SectionLabel>{fromComposer ? 'Current prompt' : 'Suggested prompt'}</SectionLabel>
                            <span className="flex items-center gap-2">
                                {changedLines ? (
                                    <Pill tone="ok">{changedLines} line{changedLines > 1 ? 's' : ''} changed</Pill>
                                ) : null}
                                {sawImage ? (
                                    <Pill tone="info">read your {videoUrl ? 'source clip' : 'start frame'}</Pill>
                                ) : null}
                                {durationSeconds ? (
                                    <span className="text-[11px] text-ink3">{durationSeconds}s clip</span>
                                ) : null}
                                {profileLabel ? <span className="text-[11px] text-ink3">Guidance: {profileLabel}</span> : null}
                                <Button
                                    size="sm"
                                    variant={editing ? 'neutral' : 'ghost'}
                                    disabled={Boolean(busy)}
                                    onClick={() => setEditing((on) => !on)}
                                >
                                    Edit
                                </Button>
                            </span>
                        </div>
                        {fromComposer ? (
                            <p className="mb-2 text-[11px] text-ink3">
                                This is what your composer holds now — edit it here, describe a change,
                                or write a new prompt from it.
                            </p>
                        ) : null}
                        {/* A beat past the end of the clip never renders, so the
                            last thing described silently goes missing. */}
                        {warnings.map((warning) => (
                            <p key={warning} className="mb-2 text-[11px] text-warn">{warning}</p>
                        ))}
                        {/* Say what is wrong rather than rewriting it by hand.
                            The whole conversation is replayed, so the format,
                            the clip length and the start frame still hold. */}
                        {editing ? (
                            <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-line1 bg-bg1 p-2">
                                <TextArea
                                    rows={2}
                                    autoFocus
                                    value={revision}
                                    placeholder="What should change? e.g. make it night, cut the dialogue, hold the camera still"
                                    onChange={(e) => setRevision(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && revision.trim()) {
                                            run({ revise: revision.trim() });
                                        }
                                    }}
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="sm"
                                        disabled={!revision.trim() || !selectedModel || Boolean(busy)}
                                        onClick={() => run({ revise: revision.trim() })}
                                    >
                                        Apply change
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={Boolean(busy)}
                                        onClick={() => { setEditing(false); setRevision(''); }}
                                    >
                                        Cancel
                                    </Button>
                                    <small className="text-[11px] text-ink3">
                                        Rewrites the whole prompt, keeping everything you did not mention.
                                    </small>
                                </div>
                            </div>
                        ) : null}
                        <TextArea
                            rows={7}
                            value={draft}
                            onChange={(e) => setResult(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); accept(); }
                            }}
                        />
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
