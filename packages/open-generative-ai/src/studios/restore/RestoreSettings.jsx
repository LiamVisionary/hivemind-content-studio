// The Restore studio's Advanced drawer — its body, not a settings panel.
//
// This was a permanent 320px column beside the comparison, with three decisions
// out in the open and thirteen dials behind one shut `CollapsibleSection`. The
// studio frame turns that inside out: the stage owns the window and this opens
// over its left edge on one press, so the DRAWER is now the disclosure and
// nothing inside it is collapsed. The fold's summary line (`advancedSummary`)
// did not disappear with the fold — it rides on the heading of HOW IT IS CUT,
// the section that owns most of what it names, so a shut drawer still answers
// for what is set.
//
// The order is the order the decisions actually matter in. WHICH MACHINE comes
// first because it is the only control that changes what the render costs, and
// because two of the features below — the seam dissolve, and re-finishing
// without re-rendering — depend on the gateway being able to READ the finished
// chunks, which it cannot on a rented machine (they are sealed to the vault on
// arrival). The drawer states that rather than letting somebody discover it
// after paying for an hour of GPU.
//
// The three rows are not "free" and "paid": they are free, paid by the hour,
// and paid by the render. The badge says which, because that is the whole
// decision — an afternoon of restoring wants the hourly box, a single clip
// wants the hosted one, and getting that backwards is what costs money.
//
// Two row vocabularies, the same split ImageSettingsPanel and VideoAdvanced
// make: a control that needs its sentence keeps the kit's `Field`, which gives
// the input a real <label>; a control that is just a value or a switch gets the
// design's label-left / control-right `DrawerRow`.
//
// The composer's recipe line carries four of these decisions as one-press
// tokens (the machine, the model, the output size, the chunk length). A token
// is only ever a shortcut: every control it touches is ALSO here, because the
// drawer is the complete surface and the sentence is not.
import {
  Card, Field, NativeSelect, Segmented, Slider, Toggle,
} from '../../ui/kit.jsx';
import {
  DrawerDivider, DrawerHeading, DrawerRow, DrawerRunOn, DrawerSection,
} from '../frame/AdvancedDrawer.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { PLACE_THIS_MAC } from '../../lib/runTargets.js';
import { t, tf } from '../../lib/i18n.js';
import {
  CLOUD_LANE, COLOR_CORRECTIONS, RESOLUTION_PRESETS, RESTORE_MODELS,
  advancedSummary, describeChunkPlan, describeCloudPrice, describePrice,
} from '../../lib/videoRestore.js';


export function RestoreSettings({
  lanes, runOn, selectedLane, price, cloudQuote,
  settings, onChange, plan, source, busy,
}) {
  const set = (key) => (value) => onChange({ ...settings, [key]: value });
  // The lane list, the selection and the readiness answer all arrive from the
  // studio — the composer's sentence asks the same question from the same
  // object, so the two surfaces cannot disagree about which machine is picked.
  const selected = runOn.value;
  // The install line, shown when NO machine here can restore — which is the
  // case it was written for and, until the lanes started saying why they were
  // refused, the case it never reached: a reachable gateway always returns the
  // local lane plus the hosted one, so `lanes.length` was never 0 for it.
  const anyLane = lanes.some((lane) => lane.available);
  const model = RESTORE_MODELS.find((item) => item.id === settings.model) || RESTORE_MODELS[2];
  const resolution = RESOLUTION_PRESETS.find((item) => item.id === settings.resolution) || RESOLUTION_PRESETS[0];
  const colour = COLOR_CORRECTIONS.find((item) => item.id === settings.colorCorrection);
  const singleChunk = (plan?.chunks?.length || 0) < 2;

  return (
    <>
      {/* ---- RUNS ON -------------------------------------------------------
          One readout for the question the lane list used to ask its own way.
          A lane IS a place: the free local one and a rented box are both This
          Mac, and the hosted one is HivemindOS credits — the same three bills
          the Image, Video, Story and Sprite pickers group by. */}
      <DrawerHeading>{t('runOn.label')}</DrawerHeading>
      {lanes.length ? (
        <RunOnPicker
          targets={runOn.targets}
          value={selected}
          onChange={runOn.onChange}
          searchable={false}
          readinessFor={runOn.readinessFor}
          onFixReadiness={runOn.onFixReadiness}
          // `bare` because the heading above already says what this is; the
          // picker's own SectionLabel would print it twice.
          bare
          renderTrigger={(open, toggle, readoutLabel, readout) => (
            <DrawerRunOn
              icon={selected?.place === PLACE_THIS_MAC ? 'cpu' : 'cloud'}
              title={readout.model && readout.model !== readout.place
                ? `${readout.place} · ${readout.model}`
                : readout.place}
              subtitle={readout.note}
              onClick={toggle}
            />
          )}
        />
      ) : null}
      <div className="flex flex-col gap-2 px-[19px] pb-4">
        {/* The bill for THIS render, under the choice that decides it.
            A paid lane showing no figure reads as free. */}
        {lanes.length && selectedLane === CLOUD_LANE ? (
          <p className="text-[11px] font-medium leading-snug text-ink2">
            {describeCloudPrice(cloudQuote)
              || (cloudQuote === undefined
                ? t('restorePanel.pricing')
                : t('restorePanel.notPriced'))}
          </p>
        ) : null}
        {lanes.length && selectedLane !== CLOUD_LANE && price ? (
          <p className="text-[11px] font-medium leading-snug text-ink2">{describePrice(price)}</p>
        ) : null}
        {anyLane ? null : (
          <Card className="p-3 text-[11px] leading-snug text-ink3">
            {/* A <code> element splits the sentence; the table holds both halves. */}
            {t('restorePanel.noSeedVr2Before')}
            {' '}<code className="text-ink2">ComfyUI-SeedVR2_VideoUpscaler</code>{' '}
            {t('restorePanel.noSeedVr2After')}
          </Card>
        )}
      </div>
      <DrawerDivider />

      {/* ---- MODEL ---------------------------------------------------------- */}
      <DrawerSection label={t('common.model')} hint={`${model.label} · ${model.size}`}>
        <NativeSelect value={settings.model} onChange={(event) => set('model')(event.target.value)} disabled={busy}>
          {RESTORE_MODELS.map((item) => (
            <option key={item.id} value={item.id}>{item.label} — {item.size}</option>
          ))}
        </NativeSelect>
        <p className="pt-2 text-[11px] leading-snug text-ink3">
          {model.hint} {t('restorePanel.firstChunkDownload')}
        </p>
      </DrawerSection>

      {/* ---- OUTPUT --------------------------------------------------------- */}
      <DrawerSection
        label={t('restorePanel.output')}
        hint={plan?.width ? `${plan.width}x${plan.height}` : resolution.label}
      >
        <Segmented
          size="sm"
          options={RESOLUTION_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
          value={settings.resolution}
          onChange={set('resolution')}
        />
        <p className="pt-2 text-[11px] leading-snug text-ink3">
          {resolution.hint}
          {plan?.width ? ` ${tf('restorePanel.comesOut', plan.width, plan.height)}` : ''}
        </p>
        {/* The plan stays with the size it belongs to: "14 chunks of about
            4.0s" is the shape of the wait, not an advanced dial. */}
        {plan?.chunks?.length ? (
          <p className="pt-1 text-[11px] text-ink3">{describeChunkPlan(plan)}</p>
        ) : null}
      </DrawerSection>

      {/* ---- HOW IT IS CUT --------------------------------------------------
          The old fold's contents, and its summary line on the heading. */}
      <DrawerSection label={t('restorePanel.howItIsCut')} hint={advancedSummary(settings)}>
        <Field label={t('restorePanel.capLongEdge')} hint={t('restorePanel.capLongEdgeHint')}>
          <Slider
            value={settings.maxResolution}
            min={0} max={7680} step={160}
            onChange={set('maxResolution')}
            format={(value) => (value ? tf('inpaint.pixels', value) : t('restorePanel.off'))}
          />
        </Field>
        <Field label={t('restorePanel.temporalBatch')} hint={t('restorePanel.temporalBatchHint')}>
          <Slider value={settings.batchSize} min={1} max={33} step={4} onChange={set('batchSize')} format={(value) => tf('restorePanel.frames', value)} />
        </Field>
        <Field label={t('restorePanel.chunkLength')} hint={t('restorePanel.chunkLengthHint')}>
          <Slider value={settings.chunkSeconds} min={1} max={20} step={0.5} onChange={set('chunkSeconds')} format={(value) => tf('restorePanel.seconds', value)} />
        </Field>
        <Field label={t('restorePanel.leadIn')} hint={t('restorePanel.leadInHint')}>
          <Slider value={settings.contextFrames} min={0} max={20} step={1} onChange={set('contextFrames')} format={(value) => tf('restorePanel.frames', value)} />
        </Field>
        <Field
          label={t('restorePanel.seamDissolve')}
          hint={singleChunk
            ? t('restorePanel.seamSingleChunk')
            : t('restorePanel.seamHint')}
        >
          <Slider
            value={settings.seamFrames}
            min={0} max={Math.max(0, settings.contextFrames)} step={1}
            onChange={set('seamFrames')}
            format={(value) => (value ? tf('restorePanel.frames', value) : t('restorePanel.hardCut'))}
          />
        </Field>
      </DrawerSection>

      {/* ---- COLOUR AND SEED ------------------------------------------------ */}
      <DrawerSection label={t('restorePanel.colourAndSeed')} hint={colour?.label || ''}>
        <NativeSelect value={settings.colorCorrection} onChange={(event) => set('colorCorrection')(event.target.value)}>
          {COLOR_CORRECTIONS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </NativeSelect>
        <p className="pb-1 pt-2 text-[11px] leading-snug text-ink3">{colour?.hint}</p>
        <Field label={t('image.seed')} hint={t('restorePanel.seedHint')}>
          <Slider value={settings.seed} min={0} max={99999} step={1} onChange={set('seed')} />
        </Field>
      </DrawerSection>

      {/* ---- MEMORY AND SPEED -----------------------------------------------
          No "Compile the model" toggle. Measured on a rented RTX 5090: it makes
          the first chunk 47% slower and crashes the second (CompatibleDiT does
          not support len()), so there is no setting of it that helps a chunked
          render. Offering a switch the gateway refuses would be worse than not
          offering one. */}
      <DrawerSection label={t('restorePanel.memoryAndSpeed')}>
        {/* The name on the left, the consequence under it. The kit's Toggle
            draws no words of its own — its `label` is only the accessible name
            — so a switch handed one sits on the row with nothing beside it,
            which is what this control did in the old panel. */}
        <DrawerRow label={t('restorePanel.tiledVaeName')}>
          <Toggle
            checked={settings.tiledVae}
            onChange={set('tiledVae')}
            label={t('restorePanel.tiledVaeName')}
          />
        </DrawerRow>
        <p className="text-[11px] leading-snug text-ink3">{t('restorePanel.tiledVae')}</p>
      </DrawerSection>

      {source ? (
        <div className="px-[19px] pb-[18px]">
          <Card className="p-3 text-[11px] leading-snug text-ink3">
            {tf('restorePanel.sourceLine', source.width, source.height, source.frames, source.fps.toFixed(2))}
            {source.hasAudio ? t('restorePanel.soundtrackKept') : t('restorePanel.noSoundtrack')}
          </Card>
        </div>
      ) : null}
    </>
  );
}
