import { useEffect, useMemo, useState } from 'react';
import type { NodeTypes } from '@/api/types';
import { WidgetControl } from '@/components/InputControls/WidgetControl';
import {
  controlDangerButtonClassName,
  controlGhostButtonClassName,
  controlNestedSurfaceClassName,
  controlSecondaryButtonClassName,
} from '@/components/InputControls/controlStyles';
import { CheckIcon, PlusIcon, SaveDiskIcon, SearchIcon, TrashIcon, XMarkIcon } from '@/components/icons';
import { SearchBar } from '@/components/SearchBar';
import type { ActiveLoraReference } from '@/utils/loraManager';
import {
  deletePromptLibraryItem,
  listPromptLibraryItems,
  savePromptLibraryItem,
  type PromptLibraryItem,
  type PromptLibraryLoraAttachment,
} from '@/utils/promptLibrary';
import {
  isWorkflowEncryptionUnlocked,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';

export interface PromptLibraryApplyPayload {
  positive: string;
  negative: string;
  loras: PromptLibraryLoraAttachment[];
  mode: 'append' | 'replace';
}

interface PromptLibraryBuilderProps {
  disabled?: boolean;
  currentPositive: string;
  currentNegative: string;
  helperMode: string;
  nodeTypes: NodeTypes | null;
  activeLoras: ActiveLoraReference[];
  onApply: (payload: PromptLibraryApplyPayload) => string | null;
}

const emptyLora = (): PromptLibraryLoraAttachment => ({
  name: '',
  strength: 1,
  clipStrength: 1,
  active: true,
});

function joinBlocks(blocks: string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n');
}

function loraKey(name: string): string {
  const normalized = name.replace(/\\/g, '/').trim().toLowerCase();
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
}

function mergeLoras(...groups: PromptLibraryLoraAttachment[][]): PromptLibraryLoraAttachment[] {
  const byKey = new Map<string, PromptLibraryLoraAttachment>();
  for (const group of groups) {
    for (const lora of group) {
      const name = String(lora.name ?? '').replace(/\\/g, '/').trim();
      if (!name) continue;
      byKey.set(loraKey(name), {
        ...lora,
        name,
        strength: lora.strength ?? 1,
        clipStrength: lora.clipStrength ?? lora.strength ?? 1,
        active: lora.active !== false,
      });
    }
  }
  return Array.from(byKey.values());
}

function activeReferencesToAttachments(
  references: ActiveLoraReference[],
): PromptLibraryLoraAttachment[] {
  return references
    .filter((reference) => reference.active !== false && String(reference.name ?? '').trim())
    .map((reference) => ({
      name: reference.name,
      strength: reference.strength ?? 1,
      clipStrength: reference.strength ?? 1,
      active: true,
    }));
}

function getLoraChoices(nodeTypes: NodeTypes | null): string[] {
  const required = nodeTypes?.LoraLoader?.input?.required;
  const loraInput = required?.lora_name;
  const rawChoices = Array.isArray(loraInput?.[0]) ? loraInput?.[0] : [];
  return Array.from(new Set(rawChoices.map((choice) => String(choice)).filter(Boolean)));
}

function buildDraftFromItems(items: PromptLibraryItem[]): {
  positive: string;
  negative: string;
  loras: PromptLibraryLoraAttachment[];
} {
  return {
    positive: joinBlocks(items.map((item) => item.positive)),
    negative: joinBlocks(items.map((item) => item.negative ?? '')),
    loras: mergeLoras(...items.map((item) => item.loras ?? [])),
  };
}

function libraryItemMatches(item: PromptLibraryItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    item.title,
    item.kind,
    item.partType,
    item.mode,
    item.positive,
    item.negative,
    ...item.loras.map((lora) => lora.name),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

export function PromptLibraryBuilder({
  disabled = false,
  currentPositive,
  currentNegative,
  helperMode,
  nodeTypes,
  activeLoras,
  onApply,
}: PromptLibraryBuilderProps) {
  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(() => isWorkflowEncryptionUnlocked());
  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [selectedKind, setSelectedKind] = useState<'all' | 'full' | 'part'>('all');
  const [query, setQuery] = useState('');
  const [builderItems, setBuilderItems] = useState<PromptLibraryItem[]>([]);
  const [draftPositive, setDraftPositive] = useState('');
  const [draftNegative, setDraftNegative] = useState('');
  const [draftLoras, setDraftLoras] = useState<PromptLibraryLoraAttachment[]>([]);
  const [saveTitle, setSaveTitle] = useState('');
  const [applyMode, setApplyMode] = useState<'append' | 'replace'>('append');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loraChoices = useMemo(() => getLoraChoices(nodeTypes), [nodeTypes]);
  const currentLoras = useMemo(() => activeReferencesToAttachments(activeLoras), [activeLoras]);

  useEffect(() => {
    const updateUnlock = () => setUnlocked(isWorkflowEncryptionUnlocked());
    updateUnlock();
    return subscribeWorkflowEncryptionStatus(updateUnlock);
  }, []);

  const refreshItems = async () => {
    if (!isWorkflowEncryptionUnlocked()) {
      setItems([]);
      return;
    }
    setItems(await listPromptLibraryItems());
  };

  useEffect(() => {
    if (!open || !unlocked) return;
    let cancelled = false;
    void listPromptLibraryItems()
      .then((nextItems) => {
        if (!cancelled) {
          setError(null);
          setItems(nextItems);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Prompt library could not be loaded');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, unlocked]);

  const filteredItems = useMemo(
    () =>
      items.filter((item) =>
        (selectedKind === 'all' || item.kind === selectedKind) &&
        libraryItemMatches(item, query),
      ),
    [items, query, selectedKind],
  );

  const rebuildDraft = (nextBuilderItems: PromptLibraryItem[]) => {
    const draft = buildDraftFromItems(nextBuilderItems);
    setDraftPositive(draft.positive);
    setDraftNegative(draft.negative);
    setDraftLoras(draft.loras);
  };

  const addItemToBuilder = (item: PromptLibraryItem) => {
    setStatus(null);
    setError(null);
    setBuilderItems((prev) => {
      if (prev.some((existing) => existing.id === item.id)) return prev;
      const next = [...prev, item];
      rebuildDraft(next);
      return next;
    });
  };

  const removeItemFromBuilder = (id: string) => {
    setBuilderItems((prev) => {
      const next = prev.filter((item) => item.id !== id);
      rebuildDraft(next);
      return next;
    });
  };

  const addCurrentToDraft = () => {
    setDraftPositive((value) => joinBlocks([value, currentPositive]));
    setDraftNegative((value) => joinBlocks([value, currentNegative]));
    setDraftLoras((value) => mergeLoras(value, currentLoras));
    setStatus('Current prompt added to draft');
    setError(null);
  };

  const updateDraftLora = (index: number, patch: Partial<PromptLibraryLoraAttachment>) => {
    setDraftLoras((prev) => prev.map((entry, idx) => (
      idx === index
        ? {
            ...entry,
            ...patch,
            clipStrength: patch.strength !== undefined && entry.clipStrength === entry.strength
              ? patch.strength
              : patch.clipStrength ?? entry.clipStrength,
          }
        : entry
    )));
  };

  const removeDraftLora = (index: number) => {
    setDraftLoras((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveItem = async (kind: 'full' | 'part', source: 'current' | 'draft') => {
    setStatus(null);
    setError(null);
    try {
      const fromDraft = source === 'draft';
      const positive = fromDraft ? draftPositive : currentPositive;
      const negative = fromDraft ? draftNegative : currentNegative;
      const loras = fromDraft ? draftLoras : currentLoras;
      if (!positive.trim() && !negative.trim()) {
        throw new Error('Nothing to save yet');
      }
      const title = saveTitle.trim() || (kind === 'full' ? 'Saved prompt' : 'Prompt part');
      const saved = await savePromptLibraryItem({
        kind,
        title,
        positive,
        negative: kind === 'full' ? negative : '',
        mode: helperMode,
        partType: kind === 'part' ? 'positive' : undefined,
        loras,
      });
      setSaveTitle('');
      await refreshItems();
      setStatus(`${saved.kind === 'full' ? 'Prompt' : 'Part'} saved`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Prompt could not be saved');
    }
  };

  const deleteItem = async (id: string) => {
    setStatus(null);
    setError(null);
    try {
      await deletePromptLibraryItem(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      setBuilderItems((prev) => {
        const next = prev.filter((item) => item.id !== id);
        rebuildDraft(next);
        return next;
      });
      setStatus('Deleted');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Prompt could not be deleted');
    }
  };

  const handleApply = () => {
    setStatus(null);
    setError(null);
    if (!draftPositive.trim() && !draftNegative.trim() && draftLoras.length === 0) {
      setError('Build a prompt or attach a LoRA first');
      return;
    }
    const summary = onApply({
      positive: draftPositive,
      negative: draftNegative,
      loras: draftLoras,
      mode: applyMode,
    });
    setStatus(summary || (applyMode === 'append' ? 'Draft appended' : 'Draft applied'));
  };

  return (
    <div className={`mt-3 ${controlNestedSurfaceClassName}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-sm font-semibold text-cyan-100">Prompt Library</span>
        <span className="text-xs text-slate-400">{items.length > 0 ? `${items.length} saved` : 'Builder'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/10 p-3">
          {!unlocked ? (
            <div className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Unlock ComfyUI Mobile to use encrypted prompt saves.
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <input
                  type="text"
                  value={saveTitle}
                  onChange={(event) => setSaveTitle(event.target.value)}
                  placeholder="Save title"
                  className="w-full rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  disabled={disabled}
                />
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={() => { void saveItem('full', 'current'); }}
                    disabled={disabled}
                  >
                    <SaveDiskIcon className="h-4 w-4" />
                    Current full
                  </button>
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={() => { void saveItem('part', 'current'); }}
                    disabled={disabled}
                  >
                    <PlusIcon className="h-4 w-4" />
                    Current part
                  </button>
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={() => { void saveItem('full', 'draft'); }}
                    disabled={disabled}
                  >
                    <CheckIcon className="h-4 w-4" />
                    Draft full
                  </button>
                </div>
              </div>

              <div className="flex gap-2">
                {(['all', 'full', 'part'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                      selectedKind === kind
                        ? 'bg-cyan-500 text-slate-950'
                        : 'bg-slate-950/50 text-slate-300 border border-white/10'
                    }`}
                    onClick={() => setSelectedKind(kind)}
                  >
                    {kind}
                  </button>
                ))}
              </div>

              <SearchBar
                value={query}
                onChange={setQuery}
                placeholder="Search prompts"
              />

              <div className="grid gap-2 max-h-56 overflow-y-auto pr-1">
                {filteredItems.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">
                    <SearchIcon className="mx-auto mb-2 h-4 w-4" />
                    No saved prompts yet
                  </div>
                ) : (
                  filteredItems.map((item) => {
                    const inBuilder = builderItems.some((builderItem) => builderItem.id === item.id);
                    return (
                      <div
                        key={item.id}
                        className={`rounded-lg border p-3 transition ${
                          inBuilder
                            ? 'border-cyan-400/60 bg-cyan-500/10'
                            : 'border-white/10 bg-slate-950/45'
                        }`}
                      >
                        <button
                          type="button"
                          className="block w-full text-left"
                          onClick={() => addItemToBuilder(item)}
                          disabled={disabled}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
                              {item.title}
                            </div>
                            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
                              {item.kind}
                            </span>
                          </div>
                          <div className="mt-1 line-clamp-2 text-xs text-slate-400">
                            {item.positive || item.negative || 'LoRA bundle'}
                          </div>
                          {item.loras.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {item.loras.slice(0, 3).map((lora) => (
                                <span
                                  key={`${item.id}-${lora.name}`}
                                  className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200"
                                >
                                  {lora.name.split('/').pop()}
                                </span>
                              ))}
                              {item.loras.length > 3 && (
                                <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                                  +{item.loras.length - 3}
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                        <button
                          type="button"
                          className="mt-2 inline-flex items-center gap-1 text-xs text-red-300 hover:text-red-200"
                          onClick={() => { void deleteItem(item.id); }}
                          disabled={disabled}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {builderItems.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {builderItems.map((item) => (
                    <button
                      key={`builder-${item.id}`}
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100"
                      onClick={() => removeItemFromBuilder(item.id)}
                    >
                      <span className="max-w-40 truncate">{item.title}</span>
                      <XMarkIcon className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                className={controlGhostButtonClassName}
                onClick={addCurrentToDraft}
                disabled={disabled}
              >
                Add current prompt to draft
              </button>

              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Draft positive
                </label>
                <textarea
                  value={draftPositive}
                  onChange={(event) => setDraftPositive(event.target.value)}
                  className="min-h-28 w-full resize-y rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Draft negative
                </label>
                <textarea
                  value={draftNegative}
                  onChange={(event) => setDraftNegative(event.target.value)}
                  className="min-h-20 w-full resize-y rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  disabled={disabled}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Attached LoRAs
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-200"
                    onClick={() => setDraftLoras((prev) => [...prev, emptyLora()])}
                    disabled={disabled}
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    Add
                  </button>
                </div>
                {draftLoras.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-slate-500">
                    No LoRAs attached
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {draftLoras.map((lora, index) => (
                      <div key={`draft-lora-${index}`} className="rounded-lg border border-white/10 bg-slate-950/45 p-2">
                        {loraChoices.length > 0 ? (
                          <WidgetControl
                            name="LoRA"
                            type="COMBO"
                            modelKind="loras"
                            value={lora.name}
                            options={{ options: loraChoices, stripSafetensorsSuffix: true }}
                            onChange={(value) => updateDraftLora(index, { name: String(value) })}
                            disabled={disabled}
                            compact
                            hasPin={false}
                          />
                        ) : (
                          <input
                            type="text"
                            value={lora.name}
                            onChange={(event) => updateDraftLora(index, { name: event.target.value })}
                            placeholder="LoRA filename"
                            className="mb-2 w-full rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
                            disabled={disabled}
                          />
                        )}
                        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                          <WidgetControl
                            name="Strength"
                            type="FLOAT"
                            value={Number(lora.strength ?? 1)}
                            options={{ min: -100000, max: 100000, step: 0.01 }}
                            onChange={(value) => updateDraftLora(index, { strength: Number(value) })}
                            disabled={disabled}
                            compact
                            hasPin={false}
                          />
                          <button
                            type="button"
                            className={`${controlDangerButtonClassName} h-10 px-3`}
                            onClick={() => removeDraftLora(index)}
                            disabled={disabled}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-[1fr_1fr] gap-2">
                {(['append', 'replace'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                      applyMode === mode
                        ? 'bg-cyan-500 text-slate-950'
                        : 'bg-slate-950/60 text-slate-300 border border-white/10'
                    }`}
                    onClick={() => setApplyMode(mode)}
                  >
                    {mode === 'append' ? 'Append' : 'Replace'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleApply}
                disabled={disabled}
              >
                <CheckIcon className="h-4 w-4" />
                Apply draft
              </button>
            </>
          )}
          {status && (
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
              {status}
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
