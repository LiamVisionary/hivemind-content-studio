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
import { Button, Card, Pill, SectionLabel, Spinner, TextArea, Toggle, cx } from '../ui/kit.jsx';
import {
    blockedReason,
    canSelect,
    externalHold,
    formatBytes,
    modelStatus,
    sortModels,
} from '../lib/promptHelperRuntime.js';
import { referenceToLocalImageInput } from '../lib/hivemindStudio.js';
import { videoContactSheet } from '../lib/contactSheet.js';

async function api(path, body) {
    const response = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.detail || payload?.error || `Request failed (${response.status})`);
    return payload;
}

export function PromptHelperDialog({
    open, onClose, idea, targetModel, mediaType = 'video',
    hasFirstFrame = false, hasLastFrame = false, imageUrl = '', videoUrl = '',
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
            setSelected((current) => {
                if (current) return current;
                const live = data.loaded?.[0]?.modelId;
                if (live) return live;
                // Nothing in RAM (a fresh page load, or the stack restarted and
                // killed the server). Leaving this empty left every action
                // silently inert, so fall back to the first model that fits.
                const usable = sortModels(data.models).find((model) => canSelect(model, { unloadOthers: true }));
                return usable?.id || '';
            });
        } catch (exc) {
            setError(exc.message);
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setError('');
        refresh();
    }, [open, refresh]);

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
                const loaded = await api('/api/prompt-helper/load', { modelId: selectedModel.id, unloadOthers });
                if (ticket !== requestRef.current) return;
                setSnapshot(loaded);
            }
            // The start frame is sealed at rest, so it is decrypted here and
            // sent as a data URL — it goes to a llama-server on this machine
            // and no further.
            let image = '';
            if (selectedModel.vision && (videoUrl || imageUrl)) {
                setBusy(videoUrl ? 'Watching the source clip…' : 'Reading the start frame…');
                try {
                    // A source video beats a start frame: it carries the motion,
                    // which is what a video prompt is actually about. The vision
                    // projector only reads stills, so it gets a contact sheet.
                    image = videoUrl
                        ? (await videoContactSheet(videoUrl)) || ''
                        : (await referenceToLocalImageInput(imageUrl)).image_base64 || '';
                } catch { /* fall back to writing from the idea alone */ }
                if (ticket !== requestRef.current) return;
            }
            setBusy(revise
                ? 'Applying your changes…'
                : image ? `Writing prompt from your ${videoUrl ? 'source clip' : 'start frame'}…` : 'Writing prompt…');
            const data = await api('/api/prompt-helper/generate', {
                modelId: selectedModel.id,
                idea,
                targetModel: targetModel || '',
                mediaType,
                // MiniMax H3 treats a start frame as a different task, with its
                // own opening anchor line, so the helper has to be told.
                hasFirstFrame: Boolean(hasFirstFrame),
                hasLastFrame: Boolean(hasLastFrame),
                durationSeconds: durationSeconds || null,
                imageBase64: image || null,
                currentPrompt: revise ? (result || idea || '') : null,
                revision: revise || null,
            });
            if (ticket !== requestRef.current) return;
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
                onClick={() => { onUse?.(draft.trim()); onClose?.(); }}
            >
                Use this prompt
            </Button>
        </>
    );

    return (
        <Modal open={open} onClose={onClose} title="Prompt helper" size="lg" footer={footer}>
            <div className="flex flex-col gap-4">
                {unavailable ? (
                    <Card className="p-3 text-xs text-ink2">
                        No <code>llama-server</code> found on this machine. Install llama.cpp to use the prompt helper.
                    </Card>
                ) : null}

                {/* Memory header — the numbers the load decision is made from. */}
                <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-xs">
                    <span className="text-ink2">
                        <span className="font-semibold text-ink1">{formatBytes(snapshot?.availableBytes)}</span> free
                        {snapshot?.totalBytes ? <span className="text-ink3"> of {formatBytes(snapshot.totalBytes)}</span> : null}
                    </span>
                    {snapshot?.reclaimableBytes ? (
                        <span className="text-ink3">+{formatBytes(snapshot.reclaimableBytes)} reclaimable by unloading</span>
                    ) : null}
                    {held ? (
                        <Pill tone="warn" dot>
                            {held.count} model{held.count > 1 ? 's' : ''} held by LM Studio — unload there to free that RAM
                        </Pill>
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
                    <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                        {models.length === 0 ? (
                            <p className="px-1 py-3 text-xs text-ink3">No GGUF models found on this machine.</p>
                        ) : null}
                        {models.map((model) => {
                            const selectable = canSelect(model, { unloadOthers });
                            const reason = blockedReason(model, { unloadOthers });
                            const active = model.id === selected;
                            return (
                                <button
                                    key={model.id}
                                    type="button"
                                    disabled={!selectable || Boolean(busy)}
                                    onClick={() => setSelected(model.id)}
                                    title={reason || model.id}
                                    className={cx(
                                        'flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                                        active ? 'border-honey bg-bg2' : 'border-line1 hover:bg-bg2',
                                        !selectable && 'cursor-not-allowed opacity-40 hover:bg-transparent',
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
                                            <span
                                                role="button"
                                                tabIndex={0}
                                                aria-label={`Unload ${model.name}`}
                                                onClick={(e) => { e.stopPropagation(); unload(model.id); }}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); unload(model.id); } }}
                                                className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink3 hover:bg-bg3 hover:text-ink1"
                                            >
                                                <Icon name="x" size={13} />
                                            </span>
                                        </>
                                    ) : (
                                        <span className="shrink-0 text-[11px] text-ink3">{modelStatus(model)}</span>
                                    )}
                                </button>
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
                        <TextArea rows={7} value={draft} onChange={(e) => setResult(e.target.value)} />
                    </div>
                ) : null}

                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </div>
        </Modal>
    );
}
