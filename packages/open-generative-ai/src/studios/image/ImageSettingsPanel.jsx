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
import { useReducer } from 'react';

import {
  AspectRatioPicker, CollapsibleSection, Field, IconButton, NativeSelect,
  SectionLabel, Segmented, Slider, TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import { t, tf, aspectRatioName } from '../../lib/i18n.js';
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
  // A slider drag fires ~60 changes a second. Each one still writes the engine
  // straight away (nothing downstream reads a stale value), but only this panel
  // repaints while the thumb is down; the studio's own `bump()` — which
  // re-renders the composer and every gallery card — waits for the release.
  const [, repaint] = useReducer((n) => n + 1, 0);

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
              readinessFor={runOn.readinessFor}
              onFixReadiness={runOn.onFixReadiness}
              busyAction={runOn.busyAction}
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
            <SectionLabel>{t('common.format')}</SectionLabel>
            {referenceDrivesAspect ? (
              <Field label={t('imagePanel.aspectRatio')}>
                <div className="rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs leading-relaxed text-ink3">
                  {t('imagePanel.aspectFromReference')}
                </div>
              </Field>
            ) : (
              <Field label={t('imagePanel.aspectRatio')} hint={etaLabel ? tf('imagePanel.aboutPerImage', etaLabel) : undefined}>
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
              <Field label={t('imagePanel.resolution')}>
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
            <Field label={t('imagePanel.howMany')} hint={t('imagePanel.howManyHint')}>
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

          <CollapsibleSection title={t('common.advanced')} hint={advancedHint} storageKey="image.advanced">
            {/* Steps, guidance and the negative prompt reach the LOCAL payload
                only — the cloud request is { model, prompt, aspect_ratio,
                quality, seed }, so on the API source those controls would be
                dead and are not shown. Seed rides on both. */}
            {s.useLocalModel ? (
              <Field label={t('image.steps')} hint={t('imagePanel.stepsHint')}>
                <Slider min={1} max={50} step={1} value={s.steps}
                  onChange={(v) => { s.steps = v; repaint(); }}
                  onCommit={() => bump()} />
              </Field>
            ) : null}
            {s.useLocalModel ? (
              <Field label={t('image.guidanceScale')} hint={t('imagePanel.guidanceHint')}>
                <Slider min={1} max={20} step={0.5} value={s.guidanceScale}
                  onChange={(v) => { s.guidanceScale = v; repaint(); }}
                  onCommit={() => bump()} />
              </Field>
            ) : null}
            <Field label={t('image.seed')} hint={t('imagePanel.seedHint')}>
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
                  label={t('imagePanel.sampler')}
                  hint={s.sampler
                    ? undefined
                    : krea2Selected
                      ? (s.steps <= AUTO_SAMPLER_LOW_STEP_THRESHOLD
                        ? t('imagePanel.samplerAutoLowSteps')
                        : t('imagePanel.samplerAutoTuned'))
                      : t('imagePanel.samplerAutoPair')}
                >
                  <NativeSelect
                    value={s.sampler}
                    onChange={(e) => { s.sampler = e.target.value; persist(); bump(); }}
                  >
                    <option value="">{t('imagePanel.autoMatchSteps')}</option>
                    {samplerChoices.map((name) => <option key={name} value={name}>{name}</option>)}
                  </NativeSelect>
                </Field>
                <Field
                  label={t('imagePanel.scheduler')}
                  hint={s.scheduler || !krea2Selected ? undefined : tf('imagePanel.schedulerAuto', s.steps <= AUTO_SAMPLER_LOW_STEP_THRESHOLD ? 'bong_tangent' : 'beta')}
                >
                  <NativeSelect
                    value={s.scheduler}
                    onChange={(e) => { s.scheduler = e.target.value; persist(); bump(); }}
                  >
                    <option value="">{t('imagePanel.autoMatchSteps')}</option>
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
                {tf('image.negPromptUnsupported', negativePromptUnsupportedBy || t('imagePanel.thisWorkflow'))}
              </p>
            ) : null}
            {editBudget ? (
              <Field
                label={t('imagePanel.resolution')}
                hint={editOutput
                  ? tf('imagePanel.editResolutionHint', editOutput.width, editOutput.height, editBudget.megapixels.toFixed(1))
                  : tf('imagePanel.editResolutionShapedHint', editBudget.megapixels.toFixed(1))}
              >
                <NativeSelect
                  value={String(editBudget.shortSide)}
                  onChange={(e) => { s.baseSize = Number(e.target.value) || 0; persist(); bump(); }}
                >
                  {EDIT_SHORT_SIDES.map((size) => {
                    const budget = editBudgetForShortSide(size);
                    return (
                      <option key={size} value={size}>
                        {`${tf('inpaint.megapixels', budget.megapixels.toFixed(1))}${budget.native ? ` — ${t('imagePanel.nativeCanvas')}` : ''}`}
                      </option>
                    );
                  })}
                </NativeSelect>
              </Field>
            ) : null}
            {s.useLocalModel && resolvedDims && !referenceDrivesAspect ? (
              <Field
                label={t('imagePanel.resolution')}
                // The ETA comes from measured runs of THIS setup — no model's
                // hard-coded timings pretending to describe every workflow.
                hint={resolvedDims.custom
                  ? tf('imagePanel.customResolutionHint', resolvedDims.width, resolvedDims.height)
                  : `${resolvedDims.width} × ${resolvedDims.height}${etaLabel ? tf('imagePanel.aboutAtTheseSettings', etaLabel) : t('imagePanel.scalesWithPixels')}`}
              >
                <NativeSelect
                  value={String(s.baseSize || 0)}
                  disabled={resolvedDims.custom}
                  onChange={(e) => { s.baseSize = Number(e.target.value) || 0; persist(); bump(); }}
                >
                  {LOCAL_BASE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size === 0 ? tf('imagePanel.workflowDefault', activeLocalModel?.defaultWidth || 1024) : tf('imagePanel.shortSide', size)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {showRuntimeMode ? (
              <Field
                label={t('imagePanel.memory')}
                hint={t('imagePanel.memoryHint')}
              >
                <Segmented
                  value={s.localRuntimeMode}
                  onChange={(v) => { s.localRuntimeMode = v; persist(); bump(); }}
                  options={[
                    { value: 'one-off', label: t('imagePanel.oneOff') },
                    { value: 'persistent', label: t('imagePanel.keepLoaded') },
                  ]}
                />
              </Field>
            ) : null}
            {customDimsActive && !referenceDrivesAspect ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('image.width')}>
                  <TextInput type="number" className="font-mono" placeholder={t('common.auto')}
                    value={s.customWidth ? String(s.customWidth) : ''}
                    onChange={(e) => { s.customWidth = parseInt(e.target.value, 10) || 0; persist(); bump(); }} />
                </Field>
                <Field label={t('image.height')}>
                  <TextInput type="number" className="font-mono" placeholder={t('common.auto')}
                    value={s.customHeight ? String(s.customHeight) : ''}
                    onChange={(e) => { s.customHeight = parseInt(e.target.value, 10) || 0; persist(); bump(); }} />
                </Field>
              </div>
            ) : null}
          </CollapsibleSection>

          <CollapsibleSection title={t('imagePanel.modes')} hint={modesHint} storageKey="image.modes">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>{t('imagePanel.regionBoxes')}</SectionLabel>
                <Toggle
                  label={t('imagePanel.regionBoxes')}
                  checked={s.regionMode}
                  onChange={(v) => { s.regionMode = v; persist(); bump(); }}
                />
              </div>
              <p className="text-xs leading-relaxed text-ink3">
                {t('imagePanel.regionBoxesBlurb')}
              </p>
              {s.regionMode ? (
                <>
                  {coupleOn ? (
                    <p className="text-xs leading-relaxed text-warn">
                      {t('imagePanel.coupleOwnsPrompt')}
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
                  <SectionLabel>{t('imagePanel.coupleMode')}</SectionLabel>
                  <Toggle
                    label={t('imagePanel.coupleMode')}
                    checked={s.coupleMode}
                    onChange={(v) => { s.coupleMode = v; persist(); bump(); }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-ink3">
                  {t('imagePanel.coupleModeBlurb')}
                </p>
                {coupleOn ? (
                  <div className="flex flex-col gap-3">
                    <Field label={t('imagePanel.sharedScene')}>
                      <TextInput
                        placeholder={t('imagePanel.sharedScenePlaceholder')}
                        value={s.coupleShared}
                        onChange={(e) => { s.coupleShared = e.target.value; bump(); }}
                      />
                    </Field>
                    <Field label={s.couplePair === 'mixed' ? t('imagePanel.characterAGirl') : t('imagePanel.characterA')}>
                      <TextArea rows={2} placeholder={t('imagePanel.characterAPlaceholder')}
                        value={s.coupleA}
                        onChange={(e) => { s.coupleA = e.target.value; bump(); }} />
                    </Field>
                    <Field label={s.couplePair === 'mixed' ? t('imagePanel.characterBBoy') : t('imagePanel.characterB')}>
                      <TextArea rows={2} placeholder={t('imagePanel.characterBPlaceholder')}
                        value={s.coupleB}
                        onChange={(e) => { s.coupleB = e.target.value; bump(); }} />
                    </Field>
                    <Field label={t('imagePanel.pair')}>
                      <Segmented size="sm" value={s.couplePair}
                        onChange={(v) => { s.couplePair = v; persist(); bump(); }}
                        options={[
                          { value: 'girls', label: t('imagePanel.twoGirls') },
                          { value: 'mixed', label: t('imagePanel.girlAndBoy') },
                          { value: 'boys', label: t('imagePanel.twoBoys') },
                        ]}
                      />
                    </Field>
                    <Field label={t('imagePanel.layout')}>
                      <Segmented size="sm" value={s.coupleDirection}
                        onChange={(v) => { s.coupleDirection = v; persist(); bump(); }}
                        options={[
                          { value: 'horizontal', label: t('imagePanel.sideBySide') },
                          { value: 'vertical', label: t('imagePanel.stacked') },
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
                          onChange={(v) => { s.coupleSplit = v; repaint(); }}
                          onCommit={() => { bump(); persist(); }}
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
                  <SectionLabel>{t('imagePanel.characterSheet')}</SectionLabel>
                  <Toggle
                    label={t('imagePanel.characterSheet')}
                    checked={s.characterSheetMode}
                    onChange={(v) => { s.characterSheetMode = v; persist(); bump(); }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-ink3">
                  {t('imagePanel.characterSheetBlurb')}
                </p>
                {sheetOn ? (
                  <Field label={t('imagePanel.views')}>
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
                <SectionLabel>{t('imagePanel.strengthHunt')}</SectionLabel>
                <p className="text-xs leading-relaxed text-ink3">
                  {huntArmedCount
                    ? tf('imagePanel.strengthHuntArmed', huntArmedCount)
                    : t('imagePanel.strengthHuntIdle')}
                </p>
              </div>
            ) : null}
          </CollapsibleSection>
        </>
      )}
    </>
  );
}
