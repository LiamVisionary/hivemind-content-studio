// The Image studio's Advanced drawer — its body, not a panel any more.
//
// This was a 320px settings column standing permanently beside the picture,
// tiered three deep: always-visible basics, a shut "Advanced", a shut "Modes".
// The studio frame turns that inside out — the stage owns the window and this
// opens over its left edge on one press — so the DRAWER is now the disclosure.
// Nothing inside it is collapsed: both CollapsibleSections flattened into plain
// sections, and the `hint` strings that existed to say what was armed behind a
// shut header now ride on the heading of the section that owns the control.
//
// Re-tiered again, by WHAT A CONTROL DECIDES rather than by how deep it was:
//
//   RUNS ON  — place, model and bill, plus the two notices only a local lane
//              can raise (no catalog here; another lane still holding memory).
//   OUTPUT   — shape and size: aspect, custom W×H, resolution, how many.
//   LOOK     — style presets, then the adapters.
//   CONTROL  — everything that changes what the prompt MEANS: references and
//              their roles, region boxes, couple mode, character sheets, hunt.
//   SAMPLING — steps, guidance, seed, sampler, scheduler.
//   MEMORY   — one-off, or keep the weights loaded between presses.
//   AVOID    — the negative prompt, and why it is inert when it is.
//
// The composer's recipe line carries five of these as one-press tokens. A token
// is only ever a shortcut: every control it touches is ALSO here, because the
// drawer is the complete surface and the sentence is not.
//
// Two row vocabularies, on purpose. A control that needs its sentence — the
// hint explaining what steps cost or why the negative prompt is asleep — keeps
// the kit's `Field`, which is the codebase's labelled-control-with-a-hint and
// gives the input a real <label>. A control that is just a value or a switch
// gets `DrawerRow`, the design's label-left / value-right line. Mixing them is
// what keeps the sentences without turning the drawer back into the panel.
//
// This is a presentational component: every value it reads lives on the
// caller's mutable engine object and every write goes back through `bump()` /
// `persist()`, which is the studio's existing contract — no store of its own.
import { useReducer } from 'react';

import {
  AspectRatioPicker, Button, Field, IconButton, NativeSelect, Slider,
  TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import {
  DrawerBody, DrawerChoice, DrawerDivider, DrawerRow, DrawerRunOn, DrawerSection, DrawerValue,
} from '../frame/AdvancedDrawer.jsx';
import { t, tf } from '../../lib/i18n.js';
import { PLACE_THIS_MAC } from '../../lib/runTargets.js';
import { EDIT_SHORT_SIDES, editBudgetForShortSide } from '../../lib/editResolution.js';
import { AUTO_SAMPLER_LOW_STEP_THRESHOLD, STYLE_PRESETS, parseSeedInput } from './imagePrefs.js';
import { LocalCatalogNotice } from '../LocalCatalogNotice.jsx';
import { LaneMemoryNotice } from '../LaneMemoryNotice.jsx';
import { RegionBoxEditor } from './RegionBoxEditor.jsx';
import { ReferenceRolesMenu } from './ReferenceRolesMenu.jsx';
import { LoraSection } from './LoraSection.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';


// Short-side resolutions offered for local workflows. 0 = the workflow's own
// default (1024 for the Krea/SDXL-class graphs).
export const LOCAL_BASE_SIZES = [0, 1280, 1152, 1024, 896, 768, 640, 512];

// DrawerSection's heading, on its own. The run-on card is full-bleed and owns
// its own 19px inset (see DrawerRunOn), so it cannot sit inside a section
// without being inset twice — the heading is lifted out rather than the card
// being redrawn here in a second vocabulary.
function DrawerHeading({ children }) {
  return (
    <div className="px-[19px] pb-2.5 pt-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-inkSoft">
        {children}
      </span>
    </div>
  );
}

// A hint that belongs to a DrawerRow rather than to a Field: the blurbs under
// the mode switches, and the notes that explain why a control is asleep.
function DrawerNote({ tone = 'ink3', children }) {
  return (
    <p className={cx('text-[11px] leading-relaxed', tone === 'warn' ? 'text-warn' : 'text-ink3')}>
      {children}
    </p>
  );
}

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
  // What each attached reference is FOR. The composer owns attaching them; the
  // drawer owns the half that has no room on a chip row — the roles menu, the
  // count, and the way back to none. Optional, so a caller that has not wired
  // it yet loses the row rather than the drawer.
  referenceProps = null,
  // ---- handlers ----
  onSetSource,
  onDiscoverLocalCatalog,
}) {
  // A slider drag fires ~60 changes a second. Each one still writes the engine
  // straight away (nothing downstream reads a stale value), but only this panel
  // repaints while the thumb is down; the studio's own `bump()` — which
  // re-renders the composer and every gallery card — waits for the release.
  const [, repaint] = useReducer((n) => n + 1, 0);

  // The two shut disclosures' summaries, built exactly as before — they have a
  // new home, not new words. Each fragment now rides on the heading of the
  // section that actually owns the control it names, which is why the custom
  // W×H pair reads out over OUTPUT instead of over the tuning dials.
  const outputHint = customDimsActive ? `${s.customWidth}×${s.customHeight}` : '';
  const samplingHint = [
    Number(s.steps) ? `${s.steps} steps` : '',
    s.seedText && String(s.seedText).trim() !== '-1' ? `seed ${s.seedText}` : '',
    s.sampler || s.scheduler ? [s.sampler, s.scheduler].filter(Boolean).join('/') : '',
    s.negativePrompt.trim() && supportsNegativePrompt ? 'negative prompt' : '',
  ].filter(Boolean).join(' · ');

  const regionCount = s.regionMode && !coupleOn ? (s.regions?.length || 0) : 0;
  const controlHint = [
    // Region mode with no boxes drawn changes nothing, so it is not worth a badge.
    regionCount ? `${regionCount} region${regionCount === 1 ? '' : 's'}` : '',
    coupleOn ? 'couple' : '',
    sheetOn ? 'sheet' : '',
    huntArmedCount ? `hunt ×${huntArmedCount}` : '',
  ].filter(Boolean).join(' · ');

  // Which target the card is describing. RunOnPicker resolves the same thing
  // internally for its own chip, but renderTrigger is handed the READOUT, not
  // the target, and the card's icon is the one thing the readout cannot say.
  const runOnShown = runOn.isAutomatic ? (runOn.automatic?.target || runOn.value) : runOn.value;

  return (
    <DrawerBody>
      {/* ---- RUNS ON ------------------------------------------------------
          One readout for the question four controls used to ask four ways. It
          names the place, the model and the bill in one line, opens ONE list
          grouped by who pays, and carries the rented-machine card (pin, attach,
          reconnect, rent) inside This Mac — where a rental actually belongs.

          Deliberately OUTSIDE the rentedBlocked gate below, unlike the old
          panel: a tab pinned to a machine that has gone away used to render an
          entirely empty settings column, and an empty column at least looked
          broken. An empty DRAWER looks like there is nothing to change. The
          reconnect CTA lives inside this picker, so this is the one section
          that has to survive exactly the state it exists to get out of. */}
      <DrawerHeading>{t('runOn.label')}</DrawerHeading>
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
        // `bare` because the card below already carries the heading (lifted to
        // DrawerHeading) and the Automatic sentence (folded into the subtitle),
        // and the picker's own copies would print each of them twice.
        bare
        renderTrigger={(open, toggle, readoutLabel, readout) => (
          <DrawerRunOn
            icon={runOnShown?.place === PLACE_THIS_MAC ? 'cpu' : 'cloud'}
            // The head of readoutText, without its " — bill" tail: the bill is
            // the subtitle here, so joining it into the title would say it twice.
            title={readout.model && readout.model !== readout.place
              ? `${readout.place} · ${readout.model}`
              : readout.place}
            subtitle={readout.automatic && readout.note
              ? `${t('runOn.automaticPrefix')}${readout.note}`
              : readout.note}
            onClick={toggle}
          />
        )}
      />
      {/* A list that cannot run anything is worse than no list: it reads as a
          working studio right up to the press. When this machine has nothing to
          offer, the section says why and carries the one action that changes
          it. Both notices are silent most of the time, so the block hides
          itself rather than leaving a gap above the divider. */}
      {s.useLocalModel ? (
        <div className="flex flex-col gap-2 px-[19px] pb-4 [&:empty]:hidden">
          {!s.localImageModels.length && s.localCatalogStatus !== 'ready' ? (
            <LocalCatalogNotice
              status={s.localCatalogStatus}
              onCheckAgain={() => { void onDiscoverLocalCatalog(); }}
              onSwitchToCloud={() => onSetSource(false)}
            />
          ) : null}
          {/* Only ever visible when another local mode finished and is still
              sitting on real memory — see LaneMemoryNotice. Local work is the
              only work it can affect, so it stays out of the cloud lane. */}
          <LaneMemoryNotice active={tabActive} />
        </div>
      ) : null}
      <DrawerDivider />

      {rentedBlocked ? null : (
        <>
          {/* ---- OUTPUT --------------------------------------------------
              'restorePanel.output' rather than a second key holding the same
              word: the key table refuses two keys with one value, and Restore
              got there first. */}
          <DrawerSection label={t('restorePanel.output')} hint={outputHint}>
            {referenceDrivesAspect ? (
              <Field label={t('imagePanel.aspectRatio')} className="py-2">
                <div className="rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs leading-relaxed text-ink3">
                  {t('imagePanel.aspectFromReference')}
                </div>
              </Field>
            ) : (
              <Field
                label={t('imagePanel.aspectRatio')}
                hint={etaLabel ? tf('imagePanel.aboutPerImage', etaLabel) : undefined}
                className="py-2"
              >
                {/* Six across, and no friendly name under each tile: the drawer
                    is 320px wide, so "Portrait" would wrap where the ratio
                    itself does not. Same control the panel used, one density
                    tighter — see AspectRatioPicker's `columns`. */}
                <AspectRatioPicker
                  columns={6}
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
                  custom={s.useLocalModel ? {
                    name: t('ar.custom'),
                    detail: (s.customWidth && s.customHeight) ? `${s.customWidth}×${s.customHeight}` : 'W×H',
                  } : null}
                />
              </Field>
            )}
            {/* Straight under the tile that opened them, instead of four
                sections down in Advanced where the Custom tile could not
                explain itself. */}
            {customDimsActive && !referenceDrivesAspect ? (
              <div className="grid grid-cols-2 gap-2 py-2">
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
            {resolutions.length > 0 ? (
              <Field label={t('imagePanel.resolution')} className="py-2">
                <NativeSelect
                  title={t('image.qualityTooltip')}
                  value={s.selectedResolution}
                  onChange={(e) => { s.selectedResolution = e.target.value; persist(); bump(); }}
                >
                  {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                </NativeSelect>
              </Field>
            ) : null}
            {editBudget ? (
              <Field
                label={t('imagePanel.resolution')}
                hint={editOutput
                  ? tf('imagePanel.editResolutionHint', editOutput.width, editOutput.height, editBudget.megapixels.toFixed(1))
                  : tf('imagePanel.editResolutionShapedHint', editBudget.megapixels.toFixed(1))}
                className="py-2"
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
                className="py-2"
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
            {/* "How many" — the batch reaches the local payload only, so on the
                cloud source there is nothing to choose. */}
            {s.useLocalModel ? (
              <Field label={t('imagePanel.howMany')} hint={t('imagePanel.howManyHint')} className="py-2">
                <DrawerChoice
                  ariaLabel={t('imagePanel.howMany')}
                  options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                  value={String(s.batchCount || 1)}
                  onChange={(v) => { s.batchCount = Number(v) || 1; persist(); bump(); }}
                />
              </Field>
            ) : null}
          </DrawerSection>

          {/* ---- LOOK ---------------------------------------------------- */}
          <DrawerSection label={t('imagePanel.look')} hint={s.selectedStyle !== 'None' ? s.selectedStyle : ''}>
            <div className="flex flex-wrap gap-1.5 pb-1" role="group" aria-label={t('image.stylePreset')}>
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
            {/* Adapters keep their whole catalog, download queue, groups menu
                and rental control — mounted, not reimplemented. */}
            {s.useLocalModel ? (
              <div className="pt-3">
                <LoraSection {...loraProps} />
              </div>
            ) : null}
          </DrawerSection>

          {/* ---- CONTROL -------------------------------------------------- */}
          <DrawerSection label={t('imagePanel.control')} hint={controlHint}>
            {/* Attaching a reference is the composer's door; what belongs here
                is the half that has no room on a chip row — what each picture
                supplies, and the count that says whether the drawer's answer
                and the sentence's agree. */}
            {referenceProps ? (
              <DrawerRow label={t('imagePanel.references')}>
                <DrawerValue tone={refCount ? 'honey' : 'ink'}>{refCount}</DrawerValue>
                {referenceProps.refsSupported ? (
                  <ReferenceRolesMenu
                    count={refCount}
                    roles={s.referenceRoles}
                    labelStyle={referenceProps.referenceLabelStyle}
                    onApply={referenceProps.onApplyRoles}
                  />
                ) : null}
                {refCount > 0 ? (
                  <Button
                    size="sm"
                    variant="neutral"
                    onClick={referenceProps.onClearReferences}
                    title={t('composer.clearReferencesTitle')}
                  >
                    {t('common.clearReferences')}
                  </Button>
                ) : null}
              </DrawerRow>
            ) : null}

            <DrawerRow label={t('imagePanel.regionBoxes')}>
              {regionCount ? <DrawerValue tone="honey">{regionCount}</DrawerValue> : null}
              <Toggle
                label={t('imagePanel.regionBoxes')}
                checked={s.regionMode}
                onChange={(v) => { s.regionMode = v; persist(); bump(); }}
              />
            </DrawerRow>
            <DrawerNote>{t('imagePanel.regionBoxesBlurb')}</DrawerNote>
            {s.regionMode ? (
              <div className="flex flex-col gap-2.5 py-2.5">
                {coupleOn ? <DrawerNote tone="warn">{t('imagePanel.coupleOwnsPrompt')}</DrawerNote> : null}
                <RegionBoxEditor
                  regions={s.regions}
                  aspect={selectedArNumber}
                  disabled={coupleOn}
                  onChange={(next) => { s.regions = next; bump(); }}
                />
              </div>
            ) : null}

            {coupleCapable ? (
              <>
                <DrawerRow label={t('imagePanel.coupleMode')}>
                  <Toggle
                    label={t('imagePanel.coupleMode')}
                    checked={s.coupleMode}
                    onChange={(v) => { s.coupleMode = v; persist(); bump(); }}
                  />
                </DrawerRow>
                <DrawerNote>{t('imagePanel.coupleModeBlurb')}</DrawerNote>
                {coupleOn ? (
                  <div className="flex flex-col gap-3 py-2.5">
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
                      <DrawerChoice
                        ariaLabel={t('imagePanel.pair')}
                        mono={false}
                        value={s.couplePair}
                        onChange={(v) => { s.couplePair = v; persist(); bump(); }}
                        options={[
                          { value: 'girls', label: t('imagePanel.twoGirls') },
                          { value: 'mixed', label: t('imagePanel.girlAndBoy') },
                          { value: 'boys', label: t('imagePanel.twoBoys') },
                        ]}
                      />
                    </Field>
                    <Field label={t('imagePanel.layout')}>
                      <DrawerChoice
                        ariaLabel={t('imagePanel.layout')}
                        mono={false}
                        value={s.coupleDirection}
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
              </>
            ) : null}

            {characterSheetCapable ? (
              <>
                <DrawerRow label={t('imagePanel.characterSheet')}>
                  <Toggle
                    label={t('imagePanel.characterSheet')}
                    checked={s.characterSheetMode}
                    onChange={(v) => { s.characterSheetMode = v; persist(); bump(); }}
                  />
                </DrawerRow>
                <DrawerNote>{t('imagePanel.characterSheetBlurb')}</DrawerNote>
                {sheetOn ? (
                  <Field label={t('imagePanel.views')} className="py-2.5">
                    <DrawerChoice
                      ariaLabel={t('imagePanel.views')}
                      mono={false}
                      value={s.characterSheetPreset}
                      onChange={(v) => { s.characterSheetPreset = v; persist(); bump(); }}
                      options={characterSheetPresets}
                    />
                  </Field>
                ) : null}
              </>
            ) : null}

            {strengthHuntCapable ? (
              <DrawerRow label={t('imagePanel.strengthHunt')} stack>
                <DrawerNote>
                  {huntArmedCount
                    ? tf('imagePanel.strengthHuntArmed', huntArmedCount)
                    : t('imagePanel.strengthHuntIdle')}
                </DrawerNote>
              </DrawerRow>
            ) : null}
          </DrawerSection>

          {/* ---- SAMPLING -------------------------------------------------
              Steps and guidance reach the LOCAL payload only — the cloud
              request is { model, prompt, aspect_ratio, quality, seed }, so on
              the API source those controls would be dead and are not shown.
              Seed rides on both. */}
          <DrawerSection label={t('imagePanel.sampling')} hint={samplingHint}>
            {s.useLocalModel ? (
              <Field label={t('image.steps')} hint={t('imagePanel.stepsHint')} className="py-2">
                <Slider min={1} max={50} step={1} value={s.steps}
                  onChange={(v) => { s.steps = v; repaint(); }}
                  onCommit={() => bump()} />
              </Field>
            ) : null}
            {s.useLocalModel ? (
              <Field label={t('image.guidanceScale')} hint={t('imagePanel.guidanceHint')} className="py-2">
                <Slider min={1} max={20} step={0.5} value={s.guidanceScale}
                  onChange={(v) => { s.guidanceScale = v; repaint(); }}
                  onCommit={() => bump()} />
              </Field>
            ) : null}
            <Field label={t('image.seed')} hint={t('imagePanel.seedHint')} className="py-2">
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
                  className="py-2"
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
                  className="py-2"
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
          </DrawerSection>

          {/* ---- MEMORY --------------------------------------------------- */}
          {showRuntimeMode ? (
            <DrawerSection label={t('imagePanel.memory')} hint={s.localRuntimeMode === 'persistent' ? t('imagePanel.keepLoaded') : ''}>
              <DrawerRow>
                <DrawerChoice
                  ariaLabel={t('imagePanel.memory')}
                  mono={false}
                  value={s.localRuntimeMode}
                  onChange={(v) => { s.localRuntimeMode = v; persist(); bump(); }}
                  options={[
                    { value: 'one-off', label: t('imagePanel.oneOff') },
                    { value: 'persistent', label: t('imagePanel.keepLoaded') },
                  ]}
                />
              </DrawerRow>
              <DrawerNote>{t('imagePanel.memoryHint')}</DrawerNote>
            </DrawerSection>
          ) : null}

          {/* ---- AVOID ---------------------------------------------------- */}
          {s.useLocalModel && supportsNegativePrompt ? (
            <DrawerSection label={t('imagePanel.avoid')}>
              <TextArea
                rows={2}
                aria-label={t('image.negPromptLabel')}
                placeholder={t('image.negPromptPlaceholder')}
                value={s.negativePrompt}
                onChange={(e) => { s.negativePrompt = e.target.value; bump(); }}
              />
              {/* At guidance 1 ComfyUI never evaluates the negative branch, so
                  say so instead of letting the text look like it is doing
                  something. */}
              {negativePromptInactive ? (
                <div className="pt-1.5">
                  <DrawerNote>{t('image.negPromptNeedsGuidance')}</DrawerNote>
                </div>
              ) : null}
            </DrawerSection>
          ) : s.useLocalModel && s.negativePrompt ? (
            // The field is gone, but text saved under another model is not:
            // explain why it stopped applying rather than dropping it silently.
            <DrawerSection label={t('imagePanel.avoid')}>
              <DrawerNote>
                {tf('image.negPromptUnsupported', negativePromptUnsupportedBy || t('imagePanel.thisWorkflow'))}
              </DrawerNote>
            </DrawerSection>
          ) : null}
        </>
      )}
    </DrawerBody>
  );
}
