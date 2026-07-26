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

export function PromptHelperDialog({ open, onClose, idea, targetModel, mediaType = 'video', onUse }) {
    const [snapshot, setSnapshot] = useState(null);
    const [selected, setSelected] = useState('');
    const [unloadOthers, setUnloadOthers] = useState(true);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const [result, setResult] = useState('');
    const [profileLabel, setProfileLabel] = useState('');
    // A slow load must not overwrite state from a newer one the user kicked off.
    const requestRef = useRef(0);

    const refresh = useCallback(async () => {
        try {
            const data = await api('/api/prompt-helper/runtime');
            setSnapshot(data);
            setSelected((current) => {
                if (current) return current;
                const live = data.loaded?.[0]?.modelId;
                return live || '';
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

    const run = async () => {
        if (!selectedModel || !idea.trim()) return;
        const ticket = ++requestRef.current;
        setError('');
        setResult('');
        try {
            if (!isLoaded) {
                setBusy(`Loading ${selectedModel.name}…`);
                const loaded = await api('/api/prompt-helper/load', { modelId: selectedModel.id, unloadOthers });
                if (ticket !== requestRef.current) return;
                setSnapshot(loaded);
            }
            setBusy('Writing prompt…');
            const data = await api('/api/prompt-helper/generate', {
                modelId: selectedModel.id,
                idea,
                targetModel: targetModel || '',
                mediaType,
            });
            if (ticket !== requestRef.current) return;
            setResult(data.prompt || '');
            setProfileLabel(data.profileLabel || '');
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
            <Button onClick={run} disabled={!selectedModel || !idea.trim() || Boolean(busy)}>
                {result ? 'Regenerate' : 'Write prompt'}
            </Button>
            <Button
                variant="primary"
                disabled={!result.trim() || Boolean(busy)}
                onClick={() => { onUse?.(result.trim()); onClose?.(); }}
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
                </div>

                {result ? (
                    <div>
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <SectionLabel>Suggested prompt</SectionLabel>
                            {profileLabel ? <span className="text-[11px] text-ink3">Guidance: {profileLabel}</span> : null}
                        </div>
                        <TextArea rows={7} value={result} onChange={(e) => setResult(e.target.value)} />
                    </div>
                ) : null}

                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </div>
        </Modal>
    );
}
