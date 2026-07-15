import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Collapsible } from '@/components/Collapsible';
import { FoldIcon } from '@/components/FoldIcon';
import { WidgetControl } from '../../InputControls/WidgetControl';
import { NumberControl } from '../../InputControls/NumberControl';
import {
  controlNestedSurfaceClassName,
  controlSecondaryButtonClassName,
} from '../../InputControls/controlStyles';
import type { WorkflowNode } from '@/api/types';
import {
  generatePromptAssistantPrompt,
  type PromptAssistantGenerateRequest,
  type PromptAssistantGenerateResponse,
} from '@/api/client';
import {
  generateSeedFromNode,
  getSpecialSeedMode,
  useWorkflowStore
} from '@/hooks/useWorkflow';
import { ReloadIcon } from '@/components/icons';
import {
  resolveNodeByHierarchicalKey,
  resolveScopeForHierarchicalKey,
} from '@/utils/canonicalWorkflowOps';
import { RGTHREE_SEED_NODE_TYPE, hasSeedControlWidget } from '@/utils/seedUtils';
import { useLoraManagerStore } from '@/hooks/useLoraManager';
import { useSeedStore } from '@/hooks/useSeed';
import {
  applyLoraValuesToText,
  createDefaultLoraEntry,
  createDefaultLoraStackEntry,
  extractActiveLoraReferencesFromWorkflow,
  extractMultiLoraStackList,
  extractLoraList,
  findLoraListIndex,
  isLoraManagerNodeType,
  isMultiLoraStackNodeType,
  mergeLoras,
  normalizeLoraEntry,
  normalizeLoraStackEntry,
  serializeMultiLoraStackList
} from '@/utils/loraManager';
import {
  buildTriggerWordListFromMessage,
  extractTriggerWordList,
  extractTriggerWordListLoose,
  extractTriggerWordMessage,
  findTriggerWordListIndex,
  findTriggerWordMessageIndex,
  isTriggerWordToggleNodeType,
  normalizeTriggerWordEntry
} from '@/utils/triggerWordToggle';
import {
  buildPromptAssistantReferenceImageStorageKey,
  deletePromptAssistantReferenceImage,
  getPromptAssistantReferenceImageRestoreErrorMessage,
  loadPromptAssistantReferenceImage,
  savePromptAssistantReferenceImage,
} from '@/utils/promptAssistantReferenceImageStorage';
import {
  applyPromptAssistantForgeCoupleAutomation,
  normalizePromptAssistantHelperMode,
  normalizePromptAssistantProfileJsonOverride,
} from '@/utils/workflowInputs';
import {
  isWorkflowEncryptionUnlocked,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';
import { buildPromptAssistantEditIdea } from '@/utils/promptAssistantEditing';
import { FastGroupsBypasserControls } from './FastGroupsBypasserControls';
import {
  PromptLibraryBuilder,
  type PromptLibraryApplyPayload,
} from './PromptLibraryBuilder';
import { applyPromptLibraryLorasToWorkflow } from '@/utils/promptLibraryLoras';

interface WidgetDescriptor {
  widgetIndex: number;
  name: string;
  type: string;
  value: unknown;
  options?: Record<string, unknown> | unknown[];
  connected?: boolean;
}

interface RenderWidgetDescriptor extends WidgetDescriptor {
  source: 'input' | 'widget';
}

const PROMPT_ASSISTANT_DRAFT_SETTLE_MS = 360;
const PROMPT_ASSISTANT_REFERENCE_MAX_EDGE = 1280;

interface PromptAssistantReferenceImage {
  dataUrl: string;
  name: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Image read failed'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image decode failed'));
    image.src = src;
  });
}

async function preparePromptAssistantReferenceImage(file: File): Promise<PromptAssistantReferenceImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file');
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  try {
    const image = await loadImageElement(rawDataUrl);
    const maxEdge = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!maxEdge || maxEdge <= PROMPT_ASSISTANT_REFERENCE_MAX_EDGE) {
      return { dataUrl: rawDataUrl, name: file.name || 'reference image' };
    }

    const scale = PROMPT_ASSISTANT_REFERENCE_MAX_EDGE / maxEdge;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      return { dataUrl: rawDataUrl, name: file.name || 'reference image' };
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      dataUrl: canvas.toDataURL('image/jpeg', 0.86),
      name: file.name || 'reference image',
    };
  } catch {
    return { dataUrl: rawDataUrl, name: file.name || 'reference image' };
  }
}

interface NodeCardParametersProps {
  node: WorkflowNode;
  isBypassed: boolean;
  isKSampler: boolean;
  workflowExists: boolean;
  nodeTypesExists: boolean;
  visibleInputWidgets: WidgetDescriptor[];
  visibleWidgets: WidgetDescriptor[];
  errorInputNames: Set<string>;
  onUpdateNodeWidget: (widgetIndex: number, value: unknown, widgetName?: string) => void;
  onUpdateNodeWidgets: (updates: Record<number, unknown>) => void;
  getWidgetIndexForInput: (name: string) => number | null;
  findSeedWidgetIndex: () => number | null;
  setSeedMode: (nodeId: number, mode: 'fixed' | 'randomize' | 'increment' | 'decrement') => void;
  isWidgetPinned: (widgetIndex: number) => boolean;
  toggleWidgetPin: (widgetIndex: number, widgetName: string, widgetType: string, options?: Record<string, unknown> | unknown[]) => void;
  resolveWidgetValue?: (widgetIndex: number) => unknown;
  showFastGroupConfig: boolean;
  setShowFastGroupConfig: (open: boolean) => void;
}

export function NodeCardParameters({
  node,
  isBypassed,
  isKSampler,
  workflowExists,
  nodeTypesExists,
  visibleInputWidgets,
  visibleWidgets,
  errorInputNames,
  onUpdateNodeWidget,
  onUpdateNodeWidgets,
  getWidgetIndexForInput,
  findSeedWidgetIndex,
  setSeedMode,
  isWidgetPinned,
  toggleWidgetPin,
  resolveWidgetValue,
  showFastGroupConfig,
  setShowFastGroupConfig
}: NodeCardParametersProps) {
  const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const nodeTypes = useWorkflowStore((state) => state.nodeTypes);
  const workflow = useWorkflowStore((state) => state.workflow);
  const currentFilename = useWorkflowStore((state) => state.currentFilename);
  const currentWorkflowKey = useWorkflowStore((state) => state.currentWorkflowKey);
  const activeSessionId = useWorkflowStore((state) => state.activeSessionId);
  const scopeStack = useWorkflowStore((state) => state.scopeStack);
  const syncTriggerWordsForNode = useLoraManagerStore((state) => state.syncTriggerWordsForNode);
  const storedSeedMode = useSeedStore((state) => state.seedModes[node.id]);
  const lastSeedValue = useSeedStore((state) => state.seedLastValues[node.id] ?? null);
  const isFastGroupsBypasser = /fast\s+groups/i.test(node.type) && /\(rgthree\)/i.test(node.type);
  const isRgthreeSeedNode = node.type === RGTHREE_SEED_NODE_TYPE;
  const isCrLoraStackNode = /cr\s*lora\s*stack/i.test(node.type);
  const isMultiLoraStackNode = isMultiLoraStackNodeType(node.type);
  const isPromptAssistantNode = node.type === 'PromptAssistantGenerate';
  // Per-lora fold state for CR-LoRA-Stack-style nodes, keyed by lora group index.
  // Default (absent / false) is unfolded so all controls show until collapsed.
  const [foldedLoras, setFoldedLoras] = useState<Record<number, boolean>>({});
  const [promptAssistantLoading, setPromptAssistantLoading] = useState(false);
  const [promptAssistantResult, setPromptAssistantResult] =
    useState<PromptAssistantGenerateResponse | null>(null);
  const [promptAssistantError, setPromptAssistantError] = useState<string | null>(null);
  const [promptAssistantEditInstruction, setPromptAssistantEditInstruction] = useState('');
  const [promptAssistantReferenceImage, setPromptAssistantReferenceImage] =
    useState<PromptAssistantReferenceImage | null>(null);
  const [promptAssistantImageLoading, setPromptAssistantImageLoading] = useState(false);
  const [promptAssistantImageError, setPromptAssistantImageError] = useState<string | null>(null);
  const [workflowEncryptionUnlocked, setWorkflowEncryptionUnlocked] =
    useState(() => isWorkflowEncryptionUnlocked());
  const toggleLoraFold = (index: number) =>
    setFoldedLoras((prev) => ({ ...prev, [index]: !prev[index] }));
  const isLoraManagerNode = isLoraManagerNodeType(node.type);
  const isTriggerWordToggleNode = isTriggerWordToggleNodeType(node.type);
  const seedWidgetIndex = !isKSampler && workflowExists && nodeTypesExists
    ? findSeedWidgetIndex()
    : null;
  const seedControlIndex = seedWidgetIndex !== null ? seedWidgetIndex + 1 : null;
  const seedControlValue = seedControlIndex !== null
    ? (resolveWidgetValue ? resolveWidgetValue(seedControlIndex) : widgetValues[seedControlIndex])
    : undefined;
  const hasSeedControl = hasSeedControlWidget(node, seedControlValue);
  const hideSeedInputWidget = !isKSampler && seedWidgetIndex !== null && !hasSeedControl;
  const inputWidgetsToRender = hideSeedInputWidget
    ? visibleInputWidgets.filter((widget) => widget.name !== 'seed' && widget.name !== 'noise_seed')
    : visibleInputWidgets;
  const widgetsToRender = hideSeedInputWidget
    ? visibleWidgets.filter((widget) => widget.name !== 'seed' && widget.name !== 'noise_seed')
    : visibleWidgets;
  const promptAssistantFinalWidgetNames = useMemo(
    () => new Set(['prompt', 'negative_prompt']),
    []
  );
  const promptAssistantHiddenWidgetNames = useMemo(
    () => new Set(['context', 'image_caption', 'extra_instructions', 'emit_ui_text', 'auto_generate_on_queue']),
    []
  );
  const promptAssistantFinalWidgets = useMemo(() => {
    if (!isPromptAssistantNode) return [];
    const byName = new Map<string, WidgetDescriptor>();
    for (const widget of [...inputWidgetsToRender, ...widgetsToRender]) {
      if (promptAssistantFinalWidgetNames.has(widget.name) && !byName.has(widget.name)) {
        byName.set(widget.name, widget);
      }
    }
    return ['prompt', 'negative_prompt']
      .map((name) => byName.get(name))
      .filter((widget): widget is WidgetDescriptor => Boolean(widget));
  }, [inputWidgetsToRender, isPromptAssistantNode, promptAssistantFinalWidgetNames, widgetsToRender]);
  const promptAssistantPromptWidget = promptAssistantFinalWidgets.find((widget) => widget.name === 'prompt') ?? null;
  const promptAssistantNegativeWidget = promptAssistantFinalWidgets.find((widget) => widget.name === 'negative_prompt') ?? null;
  const promptAssistantReferenceImageStorageKey = useMemo(() => {
    if (!isPromptAssistantNode) return '';
    return buildPromptAssistantReferenceImageStorageKey({
      workflowFilename: currentFilename,
      workflowKey: currentWorkflowKey,
      activeSessionId,
      nodeKey: node.itemKey || node.id,
    });
  }, [activeSessionId, currentFilename, currentWorkflowKey, isPromptAssistantNode, node.id, node.itemKey]);
  useEffect(() => {
    if (!isPromptAssistantNode) return undefined;
    const updateUnlockState = () => {
      setWorkflowEncryptionUnlocked(isWorkflowEncryptionUnlocked());
    };
    updateUnlockState();
    return subscribeWorkflowEncryptionStatus(updateUnlockState);
  }, [isPromptAssistantNode]);
  useEffect(() => {
    if (!promptAssistantReferenceImageStorageKey) return undefined;
    if (!workflowEncryptionUnlocked) {
      setPromptAssistantReferenceImage(null);
      setPromptAssistantImageError(null);
      return undefined;
    }
    let cancelled = false;
    setPromptAssistantReferenceImage(null);
    setPromptAssistantImageError(null);
    void loadPromptAssistantReferenceImage(promptAssistantReferenceImageStorageKey)
      .then((image) => {
        if (!cancelled && image) {
          setPromptAssistantReferenceImage(image);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const restoreMessage = getPromptAssistantReferenceImageRestoreErrorMessage(
            error,
            isWorkflowEncryptionUnlocked(),
          );
          setPromptAssistantImageError(restoreMessage);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [promptAssistantReferenceImageStorageKey, workflowEncryptionUnlocked]);
  const displayedInputWidgets = isPromptAssistantNode
    ? inputWidgetsToRender.filter((widget) =>
        !promptAssistantFinalWidgetNames.has(widget.name) &&
        !promptAssistantHiddenWidgetNames.has(widget.name)
      )
    : inputWidgetsToRender;
  const displayedWidgets = isPromptAssistantNode
    ? widgetsToRender.filter((widget) =>
        !promptAssistantFinalWidgetNames.has(widget.name) &&
        !promptAssistantHiddenWidgetNames.has(widget.name)
      )
    : widgetsToRender;
  const showParameters = visibleWidgets.length > 0 || visibleInputWidgets.length > 0;
  const inSubgraphScope = scopeStack[scopeStack.length - 1]?.type === 'subgraph';
  const promotedWidgetNames = useMemo(() => {
    const names = new Set<string>();
    if (!workflow || !inSubgraphScope) return names;
    const currentFrame = scopeStack[scopeStack.length - 1];
    if (!currentFrame || currentFrame.type !== 'subgraph') return names;
    const parentFrame = scopeStack.length > 1 ? scopeStack[scopeStack.length - 2] : null;

    const placeholderNodeId = currentFrame.placeholderNodeId;
    const placeholderNode =
      !parentFrame || parentFrame.type === 'root'
        ? workflow.nodes.find((n) => n.id === placeholderNodeId)
        : workflow.definitions?.subgraphs
            ?.find((sg) => sg.id === parentFrame.id)
            ?.nodes?.find((n) => n.id === placeholderNodeId);
    if (!placeholderNode) return names;

    const proxyWidgets = (placeholderNode.properties as Record<string, unknown> | undefined)?.proxyWidgets;
    if (Array.isArray(proxyWidgets)) {
      for (const entry of proxyWidgets) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [innerNodeIdRaw, widgetNameRaw] = entry;
        const widgetName = typeof widgetNameRaw === 'string' ? widgetNameRaw : null;
        if (!widgetName) continue;
        const innerNodeId = Number(innerNodeIdRaw);
        if (innerNodeIdRaw === '-1' || innerNodeId === node.id) {
          names.add(widgetName);
        }
      }
    }

    for (const input of placeholderNode.inputs ?? []) {
      const promotedName = input.widget?.name;
      if (typeof promotedName === 'string' && promotedName.trim()) {
        names.add(promotedName.trim());
      }
    }

    return names;
  }, [workflow, inSubgraphScope, scopeStack, node.id]);
  const isPromotedWidget = (widgetName: string): boolean => {
    if (promotedWidgetNames.size === 0) return false;
    const direct = widgetName.trim();
    if (promotedWidgetNames.has(direct)) return true;
    const base = direct.split(': ').pop()?.trim() ?? direct;
    return promotedWidgetNames.has(base);
  };

  const handleSeedModeValue = (newValue: unknown) => {
    const validModes = ['fixed', 'randomize', 'increment', 'decrement'];
    if (typeof newValue === 'string' && validModes.includes(newValue)) {
      setSeedMode(node.id, newValue as 'fixed' | 'randomize' | 'increment' | 'decrement');
    }
  };

  const handleSeedControlChange = (controlIndex: number) => (newValue: unknown) => {
    onUpdateNodeWidget(controlIndex, newValue);
    handleSeedModeValue(newValue);
  };

  const handleSeedValueChange = (seedIndex: number) => (newValue: number) => {
    onUpdateNodeWidget(seedIndex, newValue, 'seed');
    setSeedMode(node.id, 'fixed');
  };

  const handleSeedNewFixedRandomClick = (seedIndex: number) => () => {
    if (!nodeTypes) return;
    const nextSeed = generateSeedFromNode(nodeTypes, node);
    onUpdateNodeWidget(seedIndex, nextSeed, 'seed');
    setSeedMode(node.id, 'fixed');
  };

  const handleSeedUseLastClick = (seedIndex: number) => () => {
    if (typeof lastSeedValue !== 'number') return;
    onUpdateNodeWidget(seedIndex, lastSeedValue, 'seed');
    setSeedMode(node.id, 'fixed');
  };

  const updateLoraManagerList = (listIndex: number, nextList: unknown[]) => {
    if (isMultiLoraStackNode) {
      onUpdateNodeWidgets({
        [listIndex]: serializeMultiLoraStackList(nextList as Parameters<typeof serializeMultiLoraStackList>[0])
      });
      return;
    }

    const updates: Record<number, unknown> = { [listIndex]: nextList };
    if (workflow && nodeTypes) {
      const textIndex = getWidgetIndexForInput('text');
      if (textIndex !== null && Array.isArray(node.widgets_values)) {
        const currentText = node.widgets_values[textIndex];
        const nextText = applyLoraValuesToText(
          typeof currentText === 'string' ? currentText : '',
          nextList as Array<{ name: string; strength: number | string; clipStrength?: number | string; active?: boolean; expanded?: boolean }>
        );
        updates[textIndex] = nextText;
      }
    }
    onUpdateNodeWidgets(updates);
    syncTriggerWordsForCurrentNode();
  };

  const getCurrentLoraList = (listIndex: number) => {
    if (!Array.isArray(node.widgets_values)) return [];
    const rawValue = node.widgets_values[listIndex];
    if (isMultiLoraStackNode) {
      return extractMultiLoraStackList(rawValue) ?? [];
    }
    return extractLoraList(rawValue) ?? [];
  };

  const updateTriggerWordList = (
    listIndex: number,
    nextList: unknown[],
    extraUpdates?: Record<number, unknown>
  ) => {
    const updates: Record<number, unknown> = {
      [listIndex]: nextList,
      ...(extraUpdates ?? {})
    };
    onUpdateNodeWidgets(updates);
  };

  const getCurrentTriggerWordList = (listIndex: number) => {
    if (!Array.isArray(node.widgets_values)) return [];
    const rawValue = node.widgets_values[listIndex];
    return extractTriggerWordList(rawValue) ?? extractTriggerWordListLoose(rawValue) ?? [];
  };

  const getTriggerWordMessage = (listIndex: number) => {
    if (!Array.isArray(node.widgets_values)) return '';
    const widgetIndexMap = workflow?.widget_idx_map?.[String(node.id)];
    const mappedMessageIndex =
      widgetIndexMap?.originalMessage ?? widgetIndexMap?.orinalMessage;
    const messageIndex = mappedMessageIndex !== undefined
      ? mappedMessageIndex
      : findTriggerWordMessageIndex(node, listIndex);
    if (messageIndex === null) return '';
    const rawValue = node.widgets_values[messageIndex];
    return extractTriggerWordMessage(rawValue) ?? '';
  };

  const getTriggerWordSettings = () => {
    const groupModeIndex = getWidgetIndexForInput('group_mode');
    const defaultActiveIndex = getWidgetIndexForInput('default_active');
    const allowStrengthIndex = getWidgetIndexForInput('allow_strength_adjustment');
    const groupMode = groupModeIndex !== null
      ? Boolean(widgetValues[groupModeIndex])
      : true;
    const defaultActive = defaultActiveIndex !== null
      ? Boolean(widgetValues[defaultActiveIndex])
      : true;
    const allowStrengthAdjustment = allowStrengthIndex !== null
      ? Boolean(widgetValues[allowStrengthIndex])
      : false;
    return {
      groupMode,
      defaultActive,
      allowStrengthAdjustment
    };
  };

  const getTriggerWordListIndex = () => {
    const mappedIndex = getWidgetIndexForInput('toggle_trigger_words');
    if (mappedIndex !== null) return mappedIndex;
    return findTriggerWordListIndex(node);
  };

  const syncTriggerWordsForCurrentNode = () => {
    const scopeStack = useWorkflowStore.getState().scopeStack ?? [];
    const currentScope = scopeStack[scopeStack.length - 1];
    const graphId = currentScope?.type === 'subgraph' ? currentScope.id : 'root';
    syncTriggerWordsForNode(node.id, graphId);
  };

  const handleInputWidgetChange = (inputWidget: WidgetDescriptor) => (newValue: unknown) => {
    onUpdateNodeWidget(inputWidget.widgetIndex, newValue, inputWidget.name);
  };

  const canPinWidget = (widgetType: string, widgetName: string) => {
    if (widgetType.startsWith('LM_LORA')) return false;
    if (widgetType.startsWith('TW_')) return false;
    if (isLoraManagerNode && widgetName === 'text') return false;
    return true;
  };

  const handleWidgetChange = (widget: WidgetDescriptor) => (newValue: unknown) => {
    if (widget.type === 'TW_WORD') {
      const listIndex = widget.widgetIndex;
      const entryIndex = (widget.options as { entryIndex?: number } | undefined)?.entryIndex;
      if (entryIndex == null) return;
      const currentList = getCurrentTriggerWordList(listIndex);
      if (!currentList[entryIndex]) return;
      if (typeof newValue === 'object' && newValue) {
        const settings = getTriggerWordSettings();
        const nextList = [...currentList];
        nextList[entryIndex] = normalizeTriggerWordEntry(
          {
            ...nextList[entryIndex],
            ...(newValue as Record<string, unknown>)
          } as { text: string; active: boolean; strength?: number | string | null },
          {
            defaultActive: settings.defaultActive,
            allowStrengthAdjustment: settings.allowStrengthAdjustment
          }
        );
        updateTriggerWordList(listIndex, nextList);
      }
      return;
    }

    if (isTriggerWordToggleNode && widget.name === 'default_active' && typeof newValue === 'boolean') {
      const listIndex = getTriggerWordListIndex();
      if (listIndex !== null) {
        const currentList = getCurrentTriggerWordList(listIndex);
        const nextList = currentList.map((entry) => ({
          ...entry,
          active: newValue
        }));
        updateTriggerWordList(listIndex, nextList, {
          [widget.widgetIndex]: newValue
        });
        return;
      }
    }

    if (isTriggerWordToggleNode && widget.name === 'group_mode' && typeof newValue === 'boolean') {
      const listIndex = getTriggerWordListIndex();
      if (listIndex !== null) {
        const currentList = getCurrentTriggerWordList(listIndex);
        const settings = getTriggerWordSettings();
        const message = getTriggerWordMessage(listIndex);
        const nextList = message
          ? buildTriggerWordListFromMessage(message, {
              groupMode: newValue,
              defaultActive: settings.defaultActive,
              allowStrengthAdjustment: settings.allowStrengthAdjustment,
              existingList: currentList
            })
          : currentList.map((entry) =>
              normalizeTriggerWordEntry(entry, {
                defaultActive: settings.defaultActive,
                allowStrengthAdjustment: settings.allowStrengthAdjustment
              })
            );
        updateTriggerWordList(listIndex, nextList, {
          [widget.widgetIndex]: newValue
        });
        return;
      }
    }

    if (isTriggerWordToggleNode && widget.name === 'allow_strength_adjustment' && typeof newValue === 'boolean') {
      const listIndex = getTriggerWordListIndex();
      if (listIndex !== null) {
        const currentList = getCurrentTriggerWordList(listIndex);
        const settings = getTriggerWordSettings();
        const message = getTriggerWordMessage(listIndex);
        const nextList = message
          ? buildTriggerWordListFromMessage(message, {
              groupMode: settings.groupMode,
              defaultActive: settings.defaultActive,
              allowStrengthAdjustment: newValue,
              existingList: currentList
            })
          : currentList.map((entry) =>
              normalizeTriggerWordEntry(entry, {
                defaultActive: settings.defaultActive,
                allowStrengthAdjustment: newValue
              })
            );
        updateTriggerWordList(listIndex, nextList, {
          [widget.widgetIndex]: newValue
        });
        return;
      }
    }

    if (widget.type === 'LM_LORA_HEADER' && typeof newValue === 'boolean') {
      const listIndex = widget.widgetIndex;
      const currentList = getCurrentLoraList(listIndex);
      if (currentList.length === 0) return;
      const nextList = currentList.map((entry) => ({
        ...entry,
        active: newValue
      }));
      updateLoraManagerList(listIndex, nextList);
      return;
    }

    if (widget.type === 'LM_LORA') {
      const listIndex = widget.widgetIndex;
      const entryIndex = (widget.options as { entryIndex?: number } | undefined)?.entryIndex;
      if (entryIndex == null) return;
      const currentList = getCurrentLoraList(listIndex);
      if (!currentList[entryIndex]) return;
      if (newValue === null) {
        const nextList = currentList.filter((_, idx) => idx !== entryIndex);
        updateLoraManagerList(listIndex, nextList);
        return;
      }
      if (typeof newValue === 'object' && newValue) {
        const nextList = [...currentList];
        const normalizeEntry = isMultiLoraStackNode ? normalizeLoraStackEntry : normalizeLoraEntry;
        nextList[entryIndex] = normalizeEntry({
          ...nextList[entryIndex],
          ...(newValue as Record<string, unknown>)
        } as { name: string; strength: number | string });
        updateLoraManagerList(listIndex, nextList);
      }
      return;
    }

    if (widget.type === 'LM_LORA_ADD') {
      const listIndex = widget.widgetIndex;
      const currentList = getCurrentLoraList(listIndex);
      const choices = (widget.options as { choices?: unknown[] } | undefined)?.choices;
      const entry = typeof newValue === 'object' && newValue
        ? (isMultiLoraStackNode
            ? normalizeLoraStackEntry(newValue as { name: string; strength: number | string })
            : normalizeLoraEntry(newValue as { name: string; strength: number | string }))
        : (isMultiLoraStackNode
            ? createDefaultLoraStackEntry(choices)
            : createDefaultLoraEntry(choices));
      updateLoraManagerList(listIndex, [...currentList, entry]);
      return;
    }

    if (isLoraManagerNode && widget.name === 'text' && typeof newValue === 'string') {
      const listIndex = findLoraListIndex(node, widget.widgetIndex);
      if (listIndex !== null) {
        const currentList = getCurrentLoraList(listIndex);
        const merged = mergeLoras(newValue, currentList);
        onUpdateNodeWidgets({
          [widget.widgetIndex]: newValue,
          [listIndex]: merged
        });
        syncTriggerWordsForCurrentNode();
        return;
      }
    }

    if (widget.type === 'POWER_LORA_HEADER' && typeof newValue === 'boolean') {
      const { loraIndices } = (widget.options || {}) as { loraIndices: number[] };
      if (loraIndices) {
        const updates: Record<number, unknown> = {};
        const widgetValues = node.widgets_values;
        if (Array.isArray(widgetValues)) {
          loraIndices.forEach((idx) => {
            const currentVal = widgetValues[idx] as Record<string, unknown>;
            updates[idx] = { ...currentVal, on: newValue };
          });
          onUpdateNodeWidgets(updates);
        }
      }
    } else {
      onUpdateNodeWidget(widget.widgetIndex, newValue, widget.name);
    }
  };

  const getWidgetKey = (widget: WidgetDescriptor, prefix: string) => {
    const options = widget.options;
    let entryIndex: number | null = null;
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      const rawEntry = (options as { entryIndex?: unknown }).entryIndex;
      if (typeof rawEntry === 'number' && Number.isFinite(rawEntry)) {
        entryIndex = rawEntry;
      }
    }
    const keySuffix = entryIndex !== null ? entryIndex : widget.name || widget.type;
    return `${prefix}-${widget.widgetIndex}-${widget.type}-${keySuffix}`;
  };

  const getCrLoraStackGroupMeta = (name: string): { index: number; base: string } | null => {
    const match = name.match(/^(.*?)[_\s-]?(\d+)$/);
    if (!match) return null;
    const index = Number.parseInt(match[2], 10);
    if (!Number.isFinite(index)) return null;
    const base = match[1].trim().replace(/[_\s-]+$/, '').toLowerCase();
    if (!base) return null;
    return { index, base };
  };

  const getCrSwitchValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['on', 'true', 'yes', '1'].includes(normalized)) return true;
      if (['off', 'false', 'no', '0'].includes(normalized)) return false;
    }
    return Boolean(value);
  };

  const buildCrSwitchValue = (current: unknown, enabled: boolean): unknown => {
    if (typeof current === 'boolean') return enabled;
    if (typeof current === 'number') return enabled ? 1 : 0;
    if (typeof current === 'string') {
      const normalized = current.trim().toLowerCase();
      if (normalized === 'on' || normalized === 'off') {
        return enabled ? 'On' : 'Off';
      }
      if (normalized === 'true' || normalized === 'false') {
        return enabled ? 'true' : 'false';
      }
      if (normalized === 'yes' || normalized === 'no') {
        return enabled ? 'Yes' : 'No';
      }
    }
    return enabled;
  };

  const applyCrLoraComboDisplayOptions = (widget: RenderWidgetDescriptor): Record<string, unknown> | unknown[] | undefined => {
    if (!isCrLoraStackNode) return widget.options;
    const groupMeta = getCrLoraStackGroupMeta(widget.name);
    const isLoraField = Boolean(groupMeta && groupMeta.base.includes('lora'));
    if (!isLoraField) return widget.options;
    if (Array.isArray(widget.options)) {
      return {
        options: widget.options,
        stripSafetensorsSuffix: true
      };
    }
    if (widget.options && typeof widget.options === 'object') {
      return {
        ...widget.options,
        stripSafetensorsSuffix: true
      };
    }
    return { stripSafetensorsSuffix: true };
  };

  const crStackWidgets = useMemo<RenderWidgetDescriptor[]>(() => (
    [
      ...displayedInputWidgets.map((widget) => ({ ...widget, source: 'input' as const })),
      ...displayedWidgets.map((widget) => ({ ...widget, source: 'widget' as const }))
    ]
  ), [displayedInputWidgets, displayedWidgets]);

  const readPromptAssistantRequest = (): PromptAssistantGenerateRequest => {
    let currentNode = node;
    const currentWorkflow = useWorkflowStore.getState().workflow;
    if (currentWorkflow && node.itemKey) {
      const scope = resolveScopeForHierarchicalKey(currentWorkflow, node.itemKey);
      currentNode = resolveNodeByHierarchicalKey(scope.nodes, node.itemKey) ?? node;
    }

    const valueFor = (widget: WidgetDescriptor): unknown => {
      const values = currentNode.widgets_values;
      if (Array.isArray(values)) {
        return values[widget.widgetIndex] ?? widget.value;
      }
      if (values && typeof values === 'object') {
        const record = values as Record<string, unknown>;
        return record[widget.name] ?? record[String(widget.widgetIndex)] ?? widget.value;
      }
      return widget.value;
    };

    const byName = new Map<string, unknown>();
    for (const widget of [...inputWidgetsToRender, ...widgetsToRender]) {
      byName.set(widget.name, valueFor(widget));
    }

    const asString = (name: string, fallback = ''): string => {
      const value = byName.get(name);
      return value == null ? fallback : String(value);
    };
    const asNumber = (name: string, fallback: number): number => {
      const value = Number(byName.get(name));
      return Number.isFinite(value) ? value : fallback;
    };

    const request: PromptAssistantGenerateRequest = {
      idea: asString('idea'),
      profile: asString('profile', 'swarm_booru_tags') || 'swarm_booru_tags',
      timeout_seconds: asNumber('timeout_seconds', 60),
      seed: Math.trunc(asNumber('seed', -1)),
      helper_mode: normalizePromptAssistantHelperMode(asString('helper_mode', 'None')),
      negative_prompt: asString('negative_prompt'),
      reference_image: promptAssistantReferenceImage
        ? {
            data_url: promptAssistantReferenceImage.dataUrl,
            name: promptAssistantReferenceImage.name,
          }
        : undefined,
      active_loras: extractActiveLoraReferencesFromWorkflow(currentWorkflow),
    };
    const profileJsonOverride = normalizePromptAssistantProfileJsonOverride(
      asString('profile_json_override'),
    );
    if (profileJsonOverride) {
      request.profile_json_override = profileJsonOverride;
    }
    return request;
  };

  const handlePromptAssistantReferenceImageChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = '';
    if (!file) return;

    setPromptAssistantImageLoading(true);
    setPromptAssistantImageError(null);
    try {
      const image = await preparePromptAssistantReferenceImage(file);
      setPromptAssistantReferenceImage(image);
      if (promptAssistantReferenceImageStorageKey) {
        try {
          await savePromptAssistantReferenceImage(promptAssistantReferenceImageStorageKey, image);
        } catch (error) {
          setPromptAssistantImageError(
            error instanceof Error
              ? `Reference image loaded but was not saved for reload: ${error.message}`
              : 'Reference image loaded but was not saved for reload',
          );
        }
      }
    } catch (error) {
      setPromptAssistantImageError(error instanceof Error ? error.message : 'Image upload failed');
    } finally {
      setPromptAssistantImageLoading(false);
    }
  };

  const handlePromptAssistantRemoveReferenceImage = async () => {
    setPromptAssistantReferenceImage(null);
    setPromptAssistantImageError(null);
    if (!promptAssistantReferenceImageStorageKey) return;
    try {
      await deletePromptAssistantReferenceImage(promptAssistantReferenceImageStorageKey);
    } catch (error) {
      setPromptAssistantImageError(
        error instanceof Error
          ? `Reference image removed here, but saved copy cleanup failed: ${error.message}`
          : 'Reference image removed here, but saved copy cleanup failed',
      );
    }
  };

  const handlePromptAssistantGenerate = async () => {
    if (promptAssistantLoading) return;
    setPromptAssistantLoading(true);
    setPromptAssistantError(null);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, PROMPT_ASSISTANT_DRAFT_SETTLE_MS));
      const request = readPromptAssistantRequest();
      const result = await generatePromptAssistantPrompt(request);
      if (promptAssistantPromptWidget) {
        onUpdateNodeWidget(promptAssistantPromptWidget.widgetIndex, result.prompt, 'prompt');
      }
      if (promptAssistantNegativeWidget) {
        onUpdateNodeWidget(promptAssistantNegativeWidget.widgetIndex, result.negative_prompt, 'negative_prompt');
      }
      const latestWorkflow = useWorkflowStore.getState().workflow;
      const automation = applyPromptAssistantForgeCoupleAutomation(
        latestWorkflow,
        node,
        result.prompt,
        request.helper_mode,
      );
      if (automation) {
        useWorkflowStore.setState({ workflow: automation.workflow });
      }
      setPromptAssistantResult(result);
    } catch (error) {
      setPromptAssistantError(error instanceof Error ? error.message : 'Prompt generation failed');
    } finally {
      setPromptAssistantLoading(false);
    }
  };

  const handlePromptAssistantEditOutput = async () => {
    if (promptAssistantLoading) return;
    const instruction = promptAssistantEditInstruction.trim();
    if (!instruction) {
      setPromptAssistantError('Enter an edit instruction first');
      return;
    }

    const currentPositive = String(promptAssistantPromptWidget?.value ?? '');
    const currentNegative = String(promptAssistantNegativeWidget?.value ?? '');
    if (!currentPositive.trim() && !currentNegative.trim()) {
      setPromptAssistantError('Generate or write a final prompt before editing it');
      return;
    }

    setPromptAssistantLoading(true);
    setPromptAssistantError(null);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, PROMPT_ASSISTANT_DRAFT_SETTLE_MS));
      const request = readPromptAssistantRequest();
      request.idea = buildPromptAssistantEditIdea({
        instruction,
        currentPositive,
        currentNegative,
        helperMode: String(request.helper_mode ?? 'None'),
      });
      request.negative_prompt = currentNegative;
      const result = await generatePromptAssistantPrompt(request);
      if (promptAssistantPromptWidget) {
        onUpdateNodeWidget(promptAssistantPromptWidget.widgetIndex, result.prompt, 'prompt');
      }
      if (promptAssistantNegativeWidget) {
        onUpdateNodeWidget(promptAssistantNegativeWidget.widgetIndex, result.negative_prompt, 'negative_prompt');
      }
      const latestWorkflow = useWorkflowStore.getState().workflow;
      const automation = applyPromptAssistantForgeCoupleAutomation(
        latestWorkflow,
        node,
        result.prompt,
        request.helper_mode,
      );
      if (automation) {
        useWorkflowStore.setState({ workflow: automation.workflow });
      }
      setPromptAssistantResult(result);
    } catch (error) {
      setPromptAssistantError(error instanceof Error ? error.message : 'Prompt edit failed');
    } finally {
      setPromptAssistantLoading(false);
    }
  };

  const handlePromptLibraryApply = (payload: PromptLibraryApplyPayload): string | null => {
    const appendText = (current: string, draft: string): string => {
      if (payload.mode === 'replace') return draft;
      return [current, draft].map((value) => value.trim()).filter(Boolean).join('\n');
    };

    if (promptAssistantPromptWidget) {
      const current = String(promptAssistantPromptWidget.value ?? '');
      onUpdateNodeWidget(
        promptAssistantPromptWidget.widgetIndex,
        appendText(current, payload.positive),
        'prompt',
      );
    }
    if (promptAssistantNegativeWidget) {
      const current = String(promptAssistantNegativeWidget.value ?? '');
      const nextNegative = payload.mode === 'replace'
        ? payload.negative
        : appendText(current, payload.negative);
      onUpdateNodeWidget(promptAssistantNegativeWidget.widgetIndex, nextNegative, 'negative_prompt');
    }

    if (payload.loras.length === 0) {
      return payload.mode === 'append' ? 'Draft appended' : 'Draft applied';
    }

    const latestWorkflow = useWorkflowStore.getState().workflow;
    if (!latestWorkflow) return 'Prompt applied; no workflow was loaded for LoRA activation';

    const result = applyPromptLibraryLorasToWorkflow(latestWorkflow, payload.loras, {
      nodeTypes,
      allowInsert: true,
    });
    if (result.summary.changed) {
      useWorkflowStore.setState({ workflow: result.workflow });
    }
    if (result.summary.applied.length > 0) {
      return `${payload.mode === 'append' ? 'Draft appended' : 'Draft applied'}; LoRAs active: ${result.summary.applied.join(', ')}`;
    }
    return result.summary.reason
      ? `${payload.mode === 'append' ? 'Draft appended' : 'Draft applied'}; ${result.summary.reason}`
      : null;
  };

  const crStackGroupedWidgets = useMemo(() => {
    const grouped = new Map<number, RenderWidgetDescriptor[]>();
    const ungrouped: RenderWidgetDescriptor[] = [];
    for (const widget of crStackWidgets) {
      const meta = getCrLoraStackGroupMeta(widget.name);
      if (!meta) {
        ungrouped.push(widget);
        continue;
      }
      const current = grouped.get(meta.index) ?? [];
      current.push(widget);
      grouped.set(meta.index, current);
    }
    const orderedGroups = Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, widgets]) => ({ index, widgets }));
    return { groups: orderedGroups, ungrouped };
  }, [crStackWidgets]);

  const handleCrWidgetChange = (widget: RenderWidgetDescriptor) => (newValue: unknown) => {
    if (widget.source === 'input') {
      handleInputWidgetChange(widget)(newValue);
      return;
    }
    handleWidgetChange(widget)(newValue);
  };

  if (!showParameters && !isFastGroupsBypasser && !showFastGroupConfig) return null;

  return (
    <div className="node-parameters mb-2">
      {isFastGroupsBypasser && (
        <FastGroupsBypasserControls
          node={node}
          isBypassed={isBypassed}
          showFastGroupConfig={showFastGroupConfig}
          setShowFastGroupConfig={setShowFastGroupConfig}
        />
      )}
      {showParameters && (
        <>
          <div className="text-xs text-slate-400 mb-1.5 uppercase tracking-wide">
            Parameters
          </div>
          {isKSampler && workflowExists && nodeTypesExists && (() => {
            const seedIndex = getWidgetIndexForInput('seed');
            if (seedIndex === null) return null;
            const seedValue = widgetValues[seedIndex];
            const seedControlIndex = seedIndex + 1;
            const seedControlValue = widgetValues[seedControlIndex];
            const seedControlChoices = ['fixed', 'increment', 'decrement', 'randomize'];
            const noiseSeedInput = node.inputs.find((input) => input.name === 'noise_seed');
            const hideSeedControl = Boolean(noiseSeedInput?.link);

            return (
              <div className="mb-3">
                <WidgetControl
                  name="seed"
                  type="INT"
                  value={seedValue}
                  onChange={(newValue) => onUpdateNodeWidget(seedIndex, newValue, 'seed')}
                  disabled={isBypassed}
                  hasError={errorInputNames.has('seed')}
                  isPromoted={isPromotedWidget('seed')}
                />
                {seedControlIndex < widgetValues.length && !hideSeedControl && (
                  <WidgetControl
                    name="Control mode"
                    type="COMBO"
                    value={seedControlValue}
                    options={seedControlChoices}
                    onChange={handleSeedControlChange(seedControlIndex)}
                    isPromoted={isPromotedWidget('control_after_generate')}
                  />
                )}
              </div>
            );
          })()}
          {!isKSampler && workflowExists && nodeTypesExists && (() => {
            const seedIndex = seedWidgetIndex;
            if (seedIndex === null) return null;
            const baseChoices = ['fixed', 'randomize', 'increment', 'decrement'];
            const choices = typeof seedControlValue === 'string' && !baseChoices.includes(seedControlValue)
              ? [...baseChoices, seedControlValue]
              : baseChoices;
            const seedInputEntry = node.inputs.find(
              (input) => input.name === 'seed' || input.name === 'noise_seed'
            );
            if (seedInputEntry?.link != null) return null;

            if (hasSeedControl) {
              const controlIndex = seedIndex + 1;
              return (
                <div className="mb-3">
                  <WidgetControl
                    name="Seed control"
                    type="COMBO"
                    value={seedControlValue}
                    options={choices}
                    onChange={handleSeedControlChange(controlIndex)}
                    isPromoted={isPromotedWidget('control_after_generate')}
                  />
                </div>
              );
            }

            const seedWidget = visibleInputWidgets.find((widget) =>
              widget.name === 'seed' || widget.name === 'noise_seed'
            );
            const seedOptions = (seedWidget?.options ?? {}) as Record<string, unknown>;
            const min = typeof seedOptions.min === 'number' ? seedOptions.min : undefined;
            const max = typeof seedOptions.max === 'number' ? seedOptions.max : undefined;
            const step = typeof seedOptions.step === 'number' ? seedOptions.step : undefined;
            const rawSeedValue = Number((resolveWidgetValue ? resolveWidgetValue(seedIndex) : widgetValues[seedIndex]) ?? 0);
            const specialMode = getSpecialSeedMode(rawSeedValue);
            const seedMode = storedSeedMode ?? specialMode ?? 'fixed';
            // Display the special seed value (-1/-2/-3) directly when in a
            // special mode, matching the desktop rgthree behavior. The actual
            // seed used at queue time is resolved from this special value.
            const displaySeedValue = rawSeedValue;
            const hasSeedError = errorInputNames.has('seed') || errorInputNames.has('noise_seed');

            return (
              <div className="mb-3">
                <NumberControl
                  name="seed"
                  value={displaySeedValue}
                  onChange={handleSeedValueChange(seedIndex)}
                  disabled={isBypassed}
                  min={min}
                  max={max}
                  step={step}
                  hasError={hasSeedError}
                  isPromoted={isPromotedWidget('seed')}
                />
                {!isRgthreeSeedNode && (
                  <WidgetControl
                    name="Seed control"
                    type="COMBO"
                    value={seedMode}
                    options={baseChoices}
                    onChange={handleSeedModeValue}
                    isPromoted={isPromotedWidget('control_after_generate')}
                  />
                )}
                <div className="grid gap-2 mt-2">
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={() => setSeedMode(node.id, 'randomize')}
                    disabled={isBypassed}
                  >
                    🎲 Randomize each time
                  </button>
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={handleSeedNewFixedRandomClick(seedIndex)}
                    disabled={isBypassed}
                  >
                    🎲 New fixed random
                  </button>
                  <button
                    type="button"
                    className={controlSecondaryButtonClassName}
                    onClick={handleSeedUseLastClick(seedIndex)}
                    disabled={isBypassed || typeof lastSeedValue !== 'number'}
                  >
                    {typeof lastSeedValue === 'number'
                      ? `♻️ Use last queued seed (${lastSeedValue})`
                      : '♻️ Use last queued seed'}
                  </button>
                </div>
              </div>
            );
          })()}
          {isCrLoraStackNode ? (
            <>
              <div className="space-y-3">
                {crStackGroupedWidgets.groups.map(({ index, widgets }) => (
                  <div
                    key={`cr-lora-stack-group-${index}`}
                    className={`p-3 ${controlNestedSurfaceClassName} ${isBypassed ? 'opacity-80' : ''}`}
                  >
                    {(() => {
                      const switchWidget = widgets.find((widget) => {
                        const groupMeta = getCrLoraStackGroupMeta(widget.name);
                        return groupMeta?.base === 'switch';
                      });
                      const bodyWidgets = widgets.filter((widget) => widget !== switchWidget);
                      // Default the fold from the switch state so a group that loads
                      // disabled starts collapsed (matching the toggle-driven behavior),
                      // until the user explicitly folds/unfolds it.
                      const switchEnabled = switchWidget ? getCrSwitchValue(switchWidget.value) : true;
                      const folded = foldedLoras[index] ?? !switchEnabled;
                      return (
                        <>
                          <button
                            type="button"
                            aria-expanded={!folded}
                            onClick={() => toggleLoraFold(index)}
                            className="flex w-full items-center gap-1 mb-2 text-left text-cyan-300"
                          >
                            <FoldIcon open={!folded} className="w-5 h-5 shrink-0" />
                            <span className="text-xs font-semibold uppercase tracking-wider">
                              LoRA {index}
                            </span>
                          </button>
                          {switchWidget && (() => {
                            const enabled = switchEnabled;
                            return (
                              <button
                                type="button"
                                aria-pressed={enabled}
                                onClick={() => {
                                  const nextEnabled = !enabled;
                                  handleCrWidgetChange(switchWidget)(buildCrSwitchValue(switchWidget.value, nextEnabled));
                                  // Keep the fold in sync: collapse when disabling, expand when enabling.
                                  setFoldedLoras((prev) => ({ ...prev, [index]: !nextEnabled }));
                                }}
                                className={`w-full py-2 rounded-lg text-sm font-semibold transition-colors ${enabled ? 'bg-cyan-500 text-slate-950' : 'bg-slate-700 text-slate-200'} ${isBypassed ? 'opacity-60 cursor-not-allowed' : ''}`}
                                disabled={isBypassed}
                              >
                                {enabled ? 'Enabled' : 'Disabled'}
                              </button>
                            );
                          })()}
                          <Collapsible open={!folded} className="space-y-2 pt-2">
                            {bodyWidgets.map((widget) => {
                              const groupMeta = getCrLoraStackGroupMeta(widget.name);
                              const pinAllowed = canPinWidget(widget.type, widget.name);
                              const widgetOptions = applyCrLoraComboDisplayOptions(widget);
                              const displayName = (() => {
                                const base = groupMeta?.base ?? '';
                                if (base.includes('lora_name')) return 'Selected LoRA';
                                if (base.includes('model_weight')) return 'Model Strength';
                                if (base.includes('clip_weight')) return 'Clip Strength';
                                return widget.name;
                              })();
                              // Widget is renamed for display ("Selected LoRA"), so
                              // tell WidgetControl it's a lora picker explicitly.
                              const crModelKind = (groupMeta?.base ?? '').includes('lora_name')
                                ? 'loras'
                                : undefined;
                              return (
                                <div key={getWidgetKey(widget, 'cr-lora-widget')}>
                                  <WidgetControl
                                    name={displayName}
                                    type={widget.type}
                                    value={widget.value}
                                    options={widgetOptions}
                                    modelKind={crModelKind}
                                    onChange={handleCrWidgetChange(widget)}
                                    disabled={isBypassed}
                                    isPinned={pinAllowed ? isWidgetPinned(widget.widgetIndex) : false}
                                    onTogglePin={pinAllowed ? () => toggleWidgetPin(widget.widgetIndex, widget.name, widget.type, widgetOptions) : undefined}
                                    hasError={errorInputNames.has(widget.name)}
                                    isPromoted={isPromotedWidget(widget.name)}
                                  />
                                </div>
                              );
                            })}
                          </Collapsible>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>
              {crStackGroupedWidgets.ungrouped.map((widget) => {
                const pinAllowed = canPinWidget(widget.type, widget.name);
                const widgetOptions = applyCrLoraComboDisplayOptions(widget);
                return (
                  <div key={getWidgetKey(widget, 'cr-lora-ungrouped')} className={isBypassed ? 'opacity-80' : ''}>
                    <WidgetControl
                      name={widget.name}
                      type={widget.type}
                      value={widget.value}
                      options={widgetOptions}
                      onChange={handleCrWidgetChange(widget)}
                      disabled={isBypassed}
                      isPinned={pinAllowed ? isWidgetPinned(widget.widgetIndex) : false}
                      onTogglePin={pinAllowed ? () => toggleWidgetPin(widget.widgetIndex, widget.name, widget.type, widgetOptions) : undefined}
                      hasError={errorInputNames.has(widget.name)}
                      isPromoted={isPromotedWidget(widget.name)}
                    />
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {displayedInputWidgets.map((inputWidget) => (
                <div key={getWidgetKey(inputWidget, 'input-widget')} className={isBypassed ? 'opacity-80' : ''}>
                  <WidgetControl
                    name={inputWidget.name}
                    type={inputWidget.type}
                    value={inputWidget.value}
                    options={inputWidget.options}
                    onChange={handleInputWidgetChange(inputWidget)}
                    disabled={isBypassed}
                    isPinned={canPinWidget(inputWidget.type, inputWidget.name) ? isWidgetPinned(inputWidget.widgetIndex) : false}
                    onTogglePin={canPinWidget(inputWidget.type, inputWidget.name) ? () => toggleWidgetPin(inputWidget.widgetIndex, inputWidget.name, inputWidget.type, inputWidget.options) : undefined}
                    hasError={errorInputNames.has(inputWidget.name)}
                    isPromoted={isPromotedWidget(inputWidget.name)}
                  />
                </div>
              ))}
              {displayedWidgets.map((widget) => (
                <div key={getWidgetKey(widget, 'widget')} className={isBypassed ? 'opacity-80' : ''}>
                  <WidgetControl
                    name={widget.name}
                    type={widget.type}
                    value={widget.value}
                    options={widget.options}
                    onChange={handleWidgetChange(widget)}
                    disabled={isBypassed}
                    isPinned={canPinWidget(widget.type, widget.name) ? isWidgetPinned(widget.widgetIndex) : false}
                    onTogglePin={canPinWidget(widget.type, widget.name) ? () => toggleWidgetPin(widget.widgetIndex, widget.name, widget.type, widget.options) : undefined}
                    hasError={errorInputNames.has(widget.name)}
                    isPromoted={isPromotedWidget(widget.name)}
                  />
                </div>
              ))}
            </>
          )}
          {isPromptAssistantNode && (
            <div className={`mt-3 p-3 ${controlNestedSurfaceClassName}`}>
              <div className="mb-3 space-y-2">
                <div className="flex gap-2">
                  <label className="flex-1 py-2 px-3 rounded-lg border border-slate-600/80 bg-slate-950/40 text-sm font-medium text-slate-200 text-center transition-colors hover:border-cyan-400/70 hover:text-cyan-100">
                    <span>{promptAssistantImageLoading ? 'Loading image' : 'Reference image'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={handlePromptAssistantReferenceImageChange}
                      disabled={isBypassed || promptAssistantImageLoading || promptAssistantLoading}
                    />
                  </label>
                  {promptAssistantReferenceImage && (
                    <button
                      type="button"
                      className="py-2 px-3 rounded-lg border border-slate-600/80 bg-slate-950/40 text-sm font-medium text-slate-200 transition-colors hover:border-red-300/70 hover:text-red-100"
                      onClick={() => { void handlePromptAssistantRemoveReferenceImage(); }}
                      disabled={isBypassed || promptAssistantLoading}
                    >
                      Remove
                    </button>
                  )}
                </div>
                {promptAssistantReferenceImage && (
                  <div className="flex items-center gap-3 rounded-lg border border-slate-700/80 bg-slate-950/40 p-2">
                    <img
                      src={promptAssistantReferenceImage.dataUrl}
                      alt=""
                      className="h-16 w-16 rounded-md object-cover"
                    />
                    <div className="min-w-0 flex-1 text-xs text-slate-300 truncate">
                      {promptAssistantReferenceImage.name}
                    </div>
                  </div>
                )}
                {promptAssistantImageError && (
                  <div className="text-xs text-red-300 break-words">
                    {promptAssistantImageError}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="w-full py-2 px-3 rounded-lg text-sm font-semibold bg-cyan-500 text-slate-950 enabled:hover:bg-cyan-400 transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                onClick={handlePromptAssistantGenerate}
                disabled={isBypassed || promptAssistantLoading}
              >
                <ReloadIcon
                  className={`w-4 h-4 ${promptAssistantLoading ? 'animate-spin' : ''}`}
                />
                <span>{promptAssistantLoading ? 'Generating prompt' : 'Generate prompt'}</span>
              </button>
              {promptAssistantError && (
                <div className="mt-2 text-xs text-red-300 break-words">
                  {promptAssistantError}
                </div>
              )}
              {promptAssistantResult && !promptAssistantError && (
                <div className="mt-2 text-xs text-cyan-200 break-words">
                  {promptAssistantPromptWidget ? 'Prompt updated' : 'Generated prompt ready'}
                </div>
              )}
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Edit current output
                </label>
                <textarea
                  value={promptAssistantEditInstruction}
                  onChange={(event) => setPromptAssistantEditInstruction(event.target.value)}
                  placeholder="e.g. make it wider, keep the same characters, move her to the right"
                  className="min-h-20 w-full resize-y rounded-lg border border-white/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  data-swipe-nav-ignore="true"
                  disabled={isBypassed || promptAssistantLoading}
                />
                <button
                  type="button"
                  className="w-full py-2 px-3 rounded-lg text-sm font-semibold bg-slate-950/80 border border-cyan-400/30 text-cyan-100 enabled:hover:bg-cyan-500 enabled:hover:text-slate-950 transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  onClick={handlePromptAssistantEditOutput}
                  disabled={isBypassed || promptAssistantLoading}
                >
                  <ReloadIcon
                    className={`w-4 h-4 ${promptAssistantLoading ? 'animate-spin' : ''}`}
                  />
                  <span>{promptAssistantLoading ? 'Editing prompt' : 'Edit final prompt'}</span>
                </button>
              </div>
              {promptAssistantFinalWidgets.length > 0 && (
                <div className="mt-3 space-y-3">
                  {promptAssistantFinalWidgets.map((widget) => (
                    <WidgetControl
                      key={getWidgetKey(widget, 'prompt-assistant-final-widget')}
                      name={widget.name === 'prompt' ? 'Final positive prompt' : 'Final negative prompt'}
                      type={widget.type}
                      value={widget.value}
                      options={widget.options}
                      onChange={(newValue) => onUpdateNodeWidget(widget.widgetIndex, newValue, widget.name)}
                      disabled={isBypassed}
                      isPinned={canPinWidget(widget.type, widget.name) ? isWidgetPinned(widget.widgetIndex) : false}
                      onTogglePin={canPinWidget(widget.type, widget.name) ? () => toggleWidgetPin(widget.widgetIndex, widget.name, widget.type, widget.options) : undefined}
                      hasError={errorInputNames.has(widget.name)}
                      isPromoted={isPromotedWidget(widget.name)}
                    />
                  ))}
                </div>
              )}
              <PromptLibraryBuilder
                disabled={isBypassed || promptAssistantLoading}
                currentPositive={String(promptAssistantPromptWidget?.value ?? '')}
                currentNegative={String(promptAssistantNegativeWidget?.value ?? '')}
                helperMode={normalizePromptAssistantHelperMode(
                  String(readPromptAssistantRequest().helper_mode ?? 'None'),
                )}
                nodeTypes={nodeTypes}
                activeLoras={extractActiveLoraReferencesFromWorkflow(workflow)}
                onApply={handlePromptLibraryApply}
              />
            </div>
          )}
          {node.type === 'PrimitiveNode' && (() => {
            const outputType = node.outputs?.[0]?.type;
            const normalizedType = String(outputType).toUpperCase();
            if (normalizedType !== 'INT' && normalizedType !== 'FLOAT') return null;
            if (widgetValues.length < 2) return null;
            const controlValue = widgetValues[1];
            const controlChoices = ['fixed', 'increment', 'decrement', 'randomize'];
            return (
              <div className="mb-3">
                <WidgetControl
                  name="Control mode"
                  type="COMBO"
                  value={controlValue}
                  options={controlChoices}
                  onChange={(newValue) => onUpdateNodeWidget(1, newValue)}
                  disabled={isBypassed}
                  isPromoted={isPromotedWidget('control_after_generate')}
                />
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
