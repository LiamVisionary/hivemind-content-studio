// The Image studio's settings panel.
//
// Lifted out of ImageStudio.jsx verbatim in behaviour, re-tiered by WHO NEEDS A
// CONTROL rather than by where its value is sent:
//
//   Basic (always visible) — Runs on (place + model), Aspect, Style, How many,
//                            LoRAs. "Runs on" is one control: the segmented
//                            Local / API / Rented triad and the model menu
//                            beside it asked the same question twice.
//   Advanced (collapsed)   — Steps, Guidance, Seed, Sampler/Scheduler, Negative
//                            prompt, Resolution, custom W×H.
//   Modes (collapsed)      — Region boxes, Couple, Character sheet, Strength Hunt.
//
// Both disclosures carry a `hint` naming what is armed inside them, so nothing
// switched on can hide behind a closed header.
//
// This is a presentational component: every value it reads lives on the caller's
// mutable engine object and every write goes back through `bump()` / `persist()`,
// which is the studio's existing contract — no store of its own.
import {
  AspectRatioPicker, CollapsibleSection, Field, IconButton, NativeSelect,
  SectionLabel, Segmented, Slider, TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import { t, aspectRatioName, zh } from '../../lib/i18n.js';
import { EDIT_SHORT_SIDES, editBudgetForShortSide } from '../../lib/editResolution.js';
import { AUTO_SAMPLER_LOW_STEP_THRESHOLD, STYLE_PRESETS, parseSeedInput } from './imagePrefs.js';
import { LocalCatalogNotice } from '../LocalCatalogNotice.jsx';
import { LaneMemoryNotice } from '../LaneMemoryNotice.jsx';
import { RegionBoxEditor } from './RegionBoxEditor.jsx';
import { LoraSection } from './LoraSection.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';


// Short-side resolutions offered for local workflows. 0 = the workflow's own
// default (1024 for the Krea/SDXL-class graphs).
export const LOCAL_BASE_SIZES = [0, 1280, 1152, 1024, 896, 768, 640, 512];

export function ImageSettingsPanel({
  engine: s,
  bump,
  persist,
  // ---- derived, computed once in the studio's render ----
  activeLocalModel,
  aspectRatios,
  resolutions,
  resolvedDims,
  customDimsActive,
  referenceDrivesAspect,
  editBudget,
  editOutput,
  rentedBlocked,
  refCount,
  showSampler,
  showRuntimeMode,
  samplerChoices,
  schedulerChoices,
  krea2Selected,
  etaLabel,
  coupleOn,
  sheetOn,
  coupleCapable,
  characterSheetCapable,
  characterSheetPresets,
  strengthHuntCapable,
  huntArmedCount,
  supportsNegativePrompt,
  negativePromptInactive,
  negativePromptUnsupportedBy,
  selectedArNumber,
  tabActive,
  loraProps,
  // The whole Runs-on readout: joined targets, the Automatic pick, this tab's
  // choice and its machine pin. One prop, because it is one control.
  runOn,
  // ---- handlers ----
  onSetSource,
  onDiscoverLocalCatalog,
}) {
  const advancedHint = [
    Number(s.steps) ? `${s.steps} steps` : '',
    s.seedText && String(s.seedText).trim() !== '-1' ? `seed ${s.seedText}` : '',
    s.sampler || s.scheduler ? [s.sampler, s.scheduler].filter(Boolean).join('/') : '',
    s.negativePrompt.trim() && supportsNegativePrompt ? 'negative prompt' : '',
    customDimsActive ? `${s.customWidth}×${s.customHeight}` : '',
  ].filter(Boolean).join(' · ');

  const regionCount = s.regionMode && !coupleOn ? (s.regions?.length || 0) : 0;
  const modesHint = [
    // Region mode with no boxes drawn changes nothing, so it is not worth a badge.
    regionCount ? `${regionCount} region${regionCount === 1 ? '' : 's'}` : '',
    coupleOn ? 'couple' : '',
    sheetOn ? 'sheet' : '',
    huntArmedCount ? `hunt ×${huntArmedCount}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <>
      {rentedBlocked ? null : (
        <>
          {/* One readout for the question four controls used to ask four ways.
              It names the place, the model and the bill in one line, opens ONE
              list grouped by who pays, and carries the rented-machine card
              (pin, attach, reconnect, rent) inside This Mac — where a rental
              actually belongs. Where the segmented Local / API / Rented control
              and a second model menu used to be. */}
          <div className="flex flex-col gap-2">
            <RunOnPicker
              targets={runOn.targets}
              value={runOn.value}
              onChange={runOn.onChange}
              automatic={runOn.automatic}
              onAutomatic={runOn.onAutomatic}
              isAutomatic={runOn.isAutomatic}
              engine={s}
              page="image"
              pinned={runOn.pinned}
              onPin={runOn.onPin}
            />
            {/* A list that cannot run anything is worse than no list: it reads
                as a working studio right up to the press. When this machine has
                nothing to offer, the section says why and carries the one action
                that changes it. */}
            {s.useLocalModel && !s.localImageModels.length && s.localCatalogStatus !== 'ready' ? (
              <LocalCatalogNotice
                status={s.localCatalogStatus}
                onCheckAgain={() => { void onDiscoverLocalCatalog(); }}
                onSwitchToCloud={() => onSetSource(false)}
              />
            ) : null}
            {/* Only ever visible when another local mode finished and is still
                sitting on real memory — see LaneMemoryNotice. Local work is the
                only work it can affect, so it stays out of the cloud lane. */}
            {s.useLocalModel ? <LaneMemoryNotice active={tabActive} /> : null}
          </div>

          <div className="flex flex-col gap-3">
            <SectionLabel>{zh() ? '格式' : 'Format'}</SectionLabel>
            {referenceDrivesAspect ? (
              <Field label={zh() ? '宽高比' : 'Aspect ratio'}>
                <div className="rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs leading-relaxed text-ink3">
                  {zh() ? '与参考图一致——编辑会保留其比例。' : 'Matches your reference image — the edit keeps its proportions.'}
                </div>
              </Field>
            ) : (
              <Field label={zh() ? '宽高比' : 'Aspect ratio'} hint={etaLabel ? `About ${etaLabel} per image` : undefined}>
                <AspectRatioPicker
                  options={aspectRatios}
                  value={customDimsActive ? 'custom' : s.selectedAr}
                  onChange={(v) => {
                    if (v === 'custom') {
                      s.customArOpen = true;
                      if (!(s.customWidth && s.customHeight)) {
                        s.customWidth = resolvedDims?.width || activeLocalModel?.defaultWidth || 1024;
                        s.customHeight = resolvedDims?.height || activeLocalModel?.defaultWidth || 1024;
                      }
                    } else {
                      s.selectedAr = v;
                      s.customArOpen = false;
                      s.customWidth = 0;
                      s.customHeight = 0;
                    }
                    persist();
                    bump();
                  }}
                  nameFor={aspectRatioName}
                  custom={s.useLocalModel ? {
                    name: t('ar.custom'),
                    detail: (s.customWidth && s.customHeight) ? `${s.customWidth}×${s.customHeight}` : 'W×H',
                  } : null}
                />
              </Field>
            )}
            {resolutions.length > 0 ? (
              <Field label={zh() ? '分辨率' : 'Resolution'}>
                <NativeSelect
                  title={t('image.qualityTooltip')}
                  value={s.selectedResolution}
                  onChange={(e) => { s.selectedResolution = e.target.value; persist(); bump(); }}
                >
                  {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                </NativeSelect>
              </Field>
            ) : null}
          </div>

          {/* Style is the first thing a consumer looks for, so it is a chip strip
              in Basic rather than a dropdown behind a disclosure. */}
          <div className="flex flex-col gap-2">
            <SectionLabel>{t('image.stylePreset')}</SectionLabel>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('image.stylePreset')}>
              {STYLE_PRESETS.map((preset) => {
                const on = s.selectedStyle === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={on}
                    onClick={() => { s.selectedStyle = preset; persist(); bump(); }}
                    className={cx(
                      'inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors duration-150',
                      on
                        ? 'border-honey/50 bg-honey-tint text-honey'
                        : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
                    )}
                  >
                    {preset}
                  </button>
                );
              })}
            </div>
          </div>

          {/* "How many" — the batch reaches the local payload only, so on the
              cloud source there is nothing to choose. */}
          {s.useLocalModel ? (
            <Field label={zh() ? '生成数量' : 'How many'} hint={zh() ? undefined : 'Pictures per press — each one costs the same time again'}>
              <Segmented
                value={String(s.batchCount || 1)}
                onChange={(v) => { s.batchCount = Number(v) || 1; persist(); bump(); }}
                options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </Field>
          ) : null}

          {/* Adapters are Basic: the selected list reads out with its weights and
              "Add" opens the catalog. */}
          {s.useLocalModel ? <LoraSection {...loraProps} /> : null}

          <CollapsibleSection title={t('image.advancedOptions')} hint={advancedHint} storageKey="image.advanced">
            {/* Steps, guidance and the negative prompt reach the LOCAL payload
                only — the cloud request is { model, prompt, aspect_ratio,
                quality, seed }, so on the API source those controls would be
                dead and are not shown. Seed rides on both. */}
            {s.useLocalModel ? (
              <Field label={t('image.steps')} hint={zh() ? undefined : 'More detail, more time — every step is another pass over the picture'}>
                <Slider min={1} max={50} step={1} value={s.steps}
                  onChange={(v) => { s.steps = v; bump(); }} />
              </Field>
            ) : null}
            {s.useLocalModel ? (
              <Field label={t('image.guidanceScale')} hint={zh() ? undefined : 'How literally the model follows your words — high sticks to the prompt, low invents (CFG)'}>
                <Slider min={1} max={20} step={0.5} value={s.guidanceScale}
                  onChange={(v) => { s.guidanceScale = v; bump(); }} />
              </Field>
            ) : null}
            <Field label={t('image.seed')} hint={zh() ? undefined : 'The same seed and the same settings make the same picture again — leave it at -1 for a new one every press'}>
              <div className="flex items-center gap-1.5">
                <TextInput
                  type="number"
                  min={0}
                  step={1}
                  className="font-mono"
                  placeholder={t('image.seedPlaceholder')}
                  value={s.seedText}
                  onChange={(e) => { s.seedText = e.target.value; s.seed = parseSeedInput(e.target.value); bump(); }}
                />
                <IconButton icon="refresh" label={t('common.randomize')} onClick={() => {
                  s.seed = Math.floor(Math.random() * 999999999);
                  s.seedText = String(s.seed);
                  bump();
                }} />
              </div>
            </Field>
            {showSampler ? (
              <>
                <Field
                  label={zh() ? '采样器' : 'Sampler'}
                  hint={s.sampler
                    ? undefined
                    : krea2Selected
                      ? (s.steps <= AUTO_SAMPLER_LOW_STEP_THRESHOLD
                        ? 'Auto — clean at 2–5 steps, but not a speed win (deis_3m, ~2.7 model evals a step)'
                        : 'Auto — tuned for 8–10 steps, one pass each (euler_ancestral)')
                      : (zh() ? '自动：工作流按步数自行选择' : 'Auto — the workflow picks a pair to match the step count')}
                >
                  <NativeSelect
                    value={s.sampler}
                    onChange={(e) => { s.sampler = e.target.value; persist(); bump(); }}
                  >
                    <option value="">{zh() ? '自动（按步数）' : 'Auto (match steps)'}</option>
                    {samplerChoices.map((name) => <option key={name} value={name}>{name}</option>)}
                  </NativeSelect>
                </Field>
                <Field
                  label={zh() ? '调度器' : 'Scheduler'}
                  hint={s.scheduler || !krea2Selected ? undefined : `Auto — ${s.steps <= AUTO_SAMPLER_LOW_STEP_THRESHOLD ? 'bong_tangent' : 'beta'} for this step count`}
                >
                  <NativeSelect
                    value={s.scheduler}
                    onChange={(e) => { s.scheduler = e.target.value; persist(); bump(); }}
                  >
                    <option value="">{zh() ? '自动（按步数）' : 'Auto (match steps)'}</option>
                    {schedulerChoices.map((name) => <option key={name} value={name}>{name}</option>)}
                  </NativeSelect>
                </Field>
              </>
            ) : null}
            {s.useLocalModel && supportsNegativePrompt ? (
              <Field
                label={t('image.negPromptLabel')}
                // At guidance 1 ComfyUI never evaluates the negative branch, so say so
                // instead of letting the text look like it is doing something.
                hint={negativePromptInactive ? t('image.negPromptNeedsGuidance') : undefined}
              >
                <TextInput
                  placeholder={t('image.negPromptPlaceholder')}
                  value={s.negativePrompt}
                  onChange={(e) => { s.negativePrompt = e.target.value; bump(); }}
                />
              </Field>
            ) : s.useLocalModel && s.negativePrompt ? (
              // The field is gone, but text saved under another model is not: explain
              // why it stopped applying rather than dropping it silently.
              <p className="text-[11px] leading-relaxed text-ink3">
                {t('image.negPromptUnsupported')(negativePromptUnsupportedBy || 'This workflow')}
              </p>
            ) : null}
            {editBudget ? (
              <Field
                label={zh() ? '分辨率' : 'Resolution'}
                hint={editOutput
                  ? `${editOutput.width} × ${editOutput.height} for this reference — ${editBudget.megapixels.toFixed(1)} MP of canvas; sampling time scales with pixel count`
                  : `${editBudget.megapixels.toFixed(1)} MP of canvas, shaped like your reference — sampling time scales with pixel count`}
              >
                <NativeSelect
                  value={String(editBudget.shortSide)}
                  onChange={(e) => { s.baseSize = Number(e.target.value) || 0; persist(); bump(); }}
                >
                  {EDIT_SHORT_SIDES.map((size) => {
                    const budget = editBudgetForShortSide(size);
                    return (
                      <option key={size} value={size}>
                        {`${budget.megapixels.toFixed(1)} MP${budget.native ? ' — the model’s native canvas' : ''}`}
                      </option>
                    );
                  })}
                </NativeSelect>
              </Field>
            ) : null}
            {s.useLocalModel && resolvedDims && !referenceDrivesAspect ? (
              <Field
                label={zh() ? '分辨率' : 'Resolution'}
                // The ETA comes from measured runs of THIS setup — no model's
                // hard-coded timings pretending to describe every workflow.
                hint={resolvedDims.custom
                  ? `${resolvedDims.width} × ${resolvedDims.height} — set by the Custom aspect ratio above`
                  : `${resolvedDims.width} × ${resolvedDims.height}${etaLabel ? ` — about ${etaLabel} at these settings` : ' — sampling time scales with pixel count'}`}
              >
                <NativeSelect
                  value={String(s.baseSize || 0)}
                  disabled={resolvedDims.custom}
                  onChange={(e) => { s.baseSize = Number(e.target.value) || 0; persist(); bump(); }}
                >
                  {LOCAL_BASE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size === 0 ? `Workflow default (${activeLocalModel?.defaultWidth || 1024})` : `${size} short side`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {showRuntimeMode ? (
              <Field
                label={zh() ? '本地运行模式' : 'Memory'}
                hint={zh()
                  ? '单次生成在每张图后释放内存；常驻模型把模型留在内存中，后续出图更快。'
                  : 'Keep loaded makes the next picture start faster; One-off gives the memory back after each one.'}
              >
                <Segmented
                  value={s.localRuntimeMode}
                  onChange={(v) => { s.localRuntimeMode = v; persist(); bump(); }}
                  options={[
                    { value: 'one-off', label: zh() ? '单次生成' : 'One-off' },
                    { value: 'persistent', label: zh() ? '常驻模型' : 'Keep loaded' },
                  ]}
                />
              </Field>
            ) : null}
            {customDimsActive && !referenceDrivesAspect ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('image.width')}>
                  <TextInput type="number" className="font-mono" placeholder={t('image.widthPlaceholder')}
                    value={s.customWidth ? String(s.customWidth) : ''}
                    onChange={(e) => { s.customWidth = parseInt(e.target.value, 10) || 0; persist(); bump(); }} />
                </Field>
                <Field label={t('image.height')}>
                  <TextInput type="number" className="font-mono" placeholder={t('image.heightPlaceholder')}
                    value={s.customHeight ? String(s.customHeight) : ''}
                    onChange={(e) => { s.customHeight = parseInt(e.target.value, 10) || 0; persist(); bump(); }} />
                </Field>
              </div>
            ) : null}
          </CollapsibleSection>

          <CollapsibleSection title={zh() ? '模式' : 'Modes'} hint={modesHint} storageKey="image.modes">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>{zh() ? '区域框' : 'Region boxes'}</SectionLabel>
                <Toggle
                  label={zh() ? '区域框' : 'Region boxes'}
                  checked={s.regionMode}
                  onChange={(v) => { s.regionMode = v; persist(); bump(); }}
                />
              </div>
              <p className="text-xs leading-relaxed text-ink3">
                {zh()
                  ? '说明各元素的位置：每个框都会变成一句位置描述附加到提示词后，适用于所有模型，无需额外节点。框内文字仅保留在本次会话。'
                  : 'Say what goes where: each box becomes a placement sentence appended to your prompt. Works with every model — no extra nodes. Box text stays in this session only.'}
              </p>
              {s.regionMode ? (
                <>
                  {coupleOn ? (
                    <p className="text-xs leading-relaxed text-warn">
                      {zh() ? '双人模式开启时由它接管提示词，区域框暂不生效。' : 'Couple mode owns the prompt while it is on, so regions stand down.'}
                    </p>
                  ) : null}
                  <RegionBoxEditor
                    regions={s.regions}
                    aspect={selectedArNumber}
                    disabled={coupleOn}
                    onChange={(next) => { s.regions = next; bump(); }}
                  />
                </>
              ) : null}
            </div>

            {coupleCapable ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel>{zh() ? '双人模式' : 'Couple mode'}</SectionLabel>
                  <Toggle
                    label={zh() ? '双人模式' : 'Couple mode'}
                    checked={s.coupleMode}
                    onChange={(v) => { s.coupleMode = v; persist(); bump(); }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-ink3">
                  {zh()
                    ? '双角色模式：每个角色一段提示词，画布按比例分割。角色文字仅保留在本次会话。'
                    : 'Two-character mode: one prompt per character with a canvas split. Character text stays in this session only.'}
                </p>
                {coupleOn ? (
                  <div className="flex flex-col gap-3">
                    <Field label="Shared scene (optional)">
                      <TextInput
                        placeholder="e.g. sitting by a bonfire at night"
                        value={s.coupleShared}
                        onChange={(e) => { s.coupleShared = e.target.value; bump(); }}
                      />
                    </Field>
                    <Field label={s.couplePair === 'mixed' ? 'Character A (girl)' : 'Character A'}>
                      <TextArea rows={2} placeholder="e.g. haruno sakura, pink hair, smiling"
                        value={s.coupleA}
                        onChange={(e) => { s.coupleA = e.target.value; bump(); }} />
                    </Field>
                    <Field label={s.couplePair === 'mixed' ? 'Character B (boy)' : 'Character B'}>
                      <TextArea rows={2} placeholder="e.g. black hair, green eyes, crossed arms"
                        value={s.coupleB}
                        onChange={(e) => { s.coupleB = e.target.value; bump(); }} />
                    </Field>
                    <Field label="Pair">
                      <Segmented size="sm" value={s.couplePair}
                        onChange={(v) => { s.couplePair = v; persist(); bump(); }}
                        options={[
                          { value: 'girls', label: 'Two girls' },
                          { value: 'mixed', label: 'Girl & boy' },
                          { value: 'boys', label: 'Two boys' },
                        ]}
                      />
                    </Field>
                    <Field label="Layout">
                      <Segmented size="sm" value={s.coupleDirection}
                        onChange={(v) => { s.coupleDirection = v; persist(); bump(); }}
                        options={[
                          { value: 'horizontal', label: 'Side by side' },
                          { value: 'vertical', label: 'Stacked' },
                        ]}
                      />
                    </Field>
                    <Field
                      label={s.coupleDirection === 'vertical'
                        ? `A ${Math.round(s.coupleSplit)}% top / B ${100 - Math.round(s.coupleSplit)}%`
                        : `A ${Math.round(s.coupleSplit)}% / B ${100 - Math.round(s.coupleSplit)}%`}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex h-1.5 w-full overflow-hidden rounded-full">
                          <div className="bg-honey" style={{ width: `${Math.round(s.coupleSplit)}%` }} />
                          <div className="bg-info" style={{ width: `${100 - Math.round(s.coupleSplit)}%` }} />
                        </div>
                        <Slider min={10} max={90} step={5} value={s.coupleSplit}
                          onChange={(v) => { s.coupleSplit = v; bump(); }}
                          onCommit={() => persist()}
                          format={(v) => `${v}%`} />
                      </div>
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : null}

            {characterSheetCapable ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel>{zh() ? '角色设定图' : 'Character sheet'}</SectionLabel>
                  <Toggle
                    label={zh() ? '角色设定图' : 'Character sheet'}
                    checked={s.characterSheetMode}
                    onChange={(v) => { s.characterSheetMode = v; persist(); bump(); }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-ink3">
                  {zh()
                    ? '基于参考图的多视角设定图：每个视角单独编辑、共用种子，合成为一张带标注的设定图。提示词框可选，用于补充风格。'
                    : 'Multi-view sheet from your reference: each view is its own edit with a shared seed, composited into one labeled sheet. The prompt box is optional extra styling.'}
                </p>
                {sheetOn ? (
                  <Field label="Views">
                    <Segmented size="sm" value={s.characterSheetPreset}
                      onChange={(v) => { s.characterSheetPreset = v; persist(); bump(); }}
                      options={characterSheetPresets}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}

            {strengthHuntCapable ? (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>{zh() ? '强度搜索' : 'Strength Hunt'}</SectionLabel>
                <p className="text-xs leading-relaxed text-ink3">
                  {huntArmedCount
                    ? `Armed on ${huntArmedCount} LoRA${huntArmedCount === 1 ? '' : 's'} — one press sweeps each from 0 to its weight and adds a labeled comparison sheet.`
                    : 'Try one LoRA at every weight in a single press. Arm it on a LoRA with the grid button in the list above.'}
                </p>
              </div>
            ) : null}
          </CollapsibleSection>
        </>
      )}
    </>
  );
}
