// The Restore Studio's left panel: the machine, the model, the size, and the
// dials that decide how the render is cut up.
//
// The order is the order the decisions actually matter in. WHICH MACHINE comes
// first because it is the only control that changes what the render costs, and
// because two of the features below — the seam dissolve, and re-finishing
// without re-rendering — depend on the gateway being able to READ the finished
// chunks, which it cannot on a rented machine (they are sealed to the vault on
// arrival). The panel states that rather than letting somebody discover it
// after paying for an hour of GPU.
//
// The three rows are not "free" and "paid": they are free, paid by the hour,
// and paid by the render. The badge says which, because that is the whole
// decision — an afternoon of restoring wants the hourly box, a single clip
// wants the hosted one, and getting that backwards is what costs money.
import {
  Card, CollapsibleSection, Field, NativeSelect, SectionLabel, Segmented, Slider, Toggle,
} from '../../ui/kit.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { runTargetsFromRows } from '../../lib/runTargets.js';
import { remedyFor } from '../../lib/textModels.js';
import { t, tf } from '../../lib/i18n.js';
import {
  CLOUD_LANE, COLOR_CORRECTIONS, RESOLUTION_PRESETS, RESTORE_MODELS,
  advancedSummary, describeChunkPlan, describeCloudPrice, describePrice, restoreRunTargets,
} from '../../lib/videoRestore.js';


export function RestoreSettings({
  lanes, selectedLane, onSelectLane, price, cloudQuote,
  settings, onChange, plan, source, busy, onRemedy = null,
}) {
  const set = (key) => (value) => onChange({ ...settings, [key]: value });
  // The gateway's lanes as run targets — the same rows, the same groups and the
  // same component the rest of the studio uses.
  const targets = runTargetsFromRows(restoreRunTargets(lanes), { kind: 'video' });
  // A lane that cannot run the job says why, and — where the owner can do
  // something about it — carries the door. "Unavailable" on its own is the same
  // sentence as "broken", and only one of the two is true here.
  const laneReadiness = (target) => {
    if (target.ready) return null;
    const source = lanes.find((lane) => lane.lane === target.id);
    const remedy = source?.remedy ? remedyFor(source.remedy) : null;
    return {
      state: 'unroutable',
      label: t('localModels.offline'),
      detail: '',
      action: remedy ? { ...remedy, kind: 'restore-remedy' } : null,
      blocks: true,
    };
  };
  const model = RESTORE_MODELS.find((item) => item.id === settings.model) || RESTORE_MODELS[2];
  const singleChunk = (plan?.chunks?.length || 0) < 2;

  return (
    <>
      <div className="flex flex-col gap-2">
        {lanes.length ? (
          <>
            {/* The ONE readout every studio answers this with. A lane IS a
                place: the free local one and a rented box are both This Mac,
                and the hosted one is HivemindOS credits — the same three bills
                the Image, Video, Story and Sprite pickers group by. */}
            <RunOnPicker
              targets={targets}
              value={targets.find((target) => target.id === selectedLane) || null}
              onChange={(target) => onSelectLane(target.id)}
              searchable={false}
              readinessFor={laneReadiness}
              onFixReadiness={(action) => onRemedy?.(action)}
            />
            {/* The bill for THIS render, under the choice that decides it.
                A paid lane showing no figure reads as free. */}
            {selectedLane === CLOUD_LANE ? (
              <p className="text-[11px] font-medium leading-snug text-ink2">
                {describeCloudPrice(cloudQuote)
                  || (cloudQuote === undefined
                    ? t('restorePanel.pricing')
                    : t('restorePanel.notPriced'))}
              </p>
            ) : null}
            {selectedLane !== CLOUD_LANE && price ? (
              <p className="text-[11px] font-medium leading-snug text-ink2">{describePrice(price)}</p>
            ) : null}
          </>
        ) : (
          <Card className="p-3 text-[11px] leading-snug text-ink3">
            {/* A <code> element splits the sentence; the table holds both halves. */}
            {t('restorePanel.noSeedVr2Before')}
            {' '}<code className="text-ink2">ComfyUI-SeedVR2_VideoUpscaler</code>{' '}
            {t('restorePanel.noSeedVr2After')}
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t('common.model')}</SectionLabel>
        <NativeSelect value={settings.model} onChange={(event) => set('model')(event.target.value)} disabled={busy}>
          {RESTORE_MODELS.map((item) => (
            <option key={item.id} value={item.id}>{item.label} — {item.size}</option>
          ))}
        </NativeSelect>
        <p className="text-[11px] leading-snug text-ink3">
          {model.hint} {t('restorePanel.firstChunkDownload')}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t('restorePanel.output')}</SectionLabel>
        <Segmented
          size="sm"
          options={RESOLUTION_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
          value={settings.resolution}
          onChange={set('resolution')}
        />
        <p className="text-[11px] leading-snug text-ink3">
          {RESOLUTION_PRESETS.find((item) => item.id === settings.resolution)?.hint}
          {plan?.width ? ` ${tf('restorePanel.comesOut', plan.width, plan.height)}` : ''}
        </p>
        {/* The plan stays out here with the size it belongs to: "14 chunks of
            about 4.0s" is the shape of the wait, not an advanced dial. */}
        {plan?.chunks?.length ? (
          <p className="text-[11px] text-ink3">{describeChunkPlan(plan)}</p>
        ) : null}
      </div>

      {/* Three decisions above, thirteen dials below. A consumer opening
          Restore met a control room; the defaults are good and the fold keeps
          every one of them a single click away, with a summary on the closed
          header so nothing that IS set can hide in here. */}
      <CollapsibleSection title={t('common.advanced')} hint={advancedSummary(settings)} storageKey="restore.advanced">
        <Field label={t('restorePanel.capLongEdge')} hint={t('restorePanel.capLongEdgeHint')}>
          <Slider
            value={settings.maxResolution}
            min={0} max={7680} step={160}
            onChange={set('maxResolution')}
            format={(value) => (value ? tf('inpaint.pixels', value) : t('restorePanel.off'))}
          />
        </Field>

        <SectionLabel>{t('restorePanel.howItIsCut')}</SectionLabel>
        <Field
          label={t('restorePanel.temporalBatch')}
          hint={t('restorePanel.temporalBatchHint')}
        >
          <Slider value={settings.batchSize} min={1} max={33} step={4} onChange={set('batchSize')} format={(value) => tf('restorePanel.frames', value)} />
        </Field>
        <Field label={t('restorePanel.chunkLength')} hint={t('restorePanel.chunkLengthHint')}>
          <Slider value={settings.chunkSeconds} min={1} max={20} step={0.5} onChange={set('chunkSeconds')} format={(value) => tf('restorePanel.seconds', value)} />
        </Field>
        <Field
          label={t('restorePanel.leadIn')}
          hint={t('restorePanel.leadInHint')}
        >
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

        <SectionLabel>{t('restorePanel.colourAndSeed')}</SectionLabel>
        <NativeSelect value={settings.colorCorrection} onChange={(event) => set('colorCorrection')(event.target.value)}>
          {COLOR_CORRECTIONS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </NativeSelect>
        <p className="text-[11px] leading-snug text-ink3">
          {COLOR_CORRECTIONS.find((item) => item.id === settings.colorCorrection)?.hint}
        </p>
        <Field label={t('image.seed')} hint={t('restorePanel.seedHint')}>
          <Slider value={settings.seed} min={0} max={99999} step={1} onChange={set('seed')} />
        </Field>

        <SectionLabel>{t('restorePanel.memoryAndSpeed')}</SectionLabel>
        <Toggle
          checked={settings.tiledVae}
          onChange={set('tiledVae')}
          label={t('restorePanel.tiledVae')}
        />
        {/* No "Compile the model" toggle. Measured on a rented RTX 5090: it
            makes the first chunk 47% slower and crashes the second
            (CompatibleDiT does not support len()), so there is no setting of it
            that helps a chunked render. Offering a switch the gateway refuses
            would be worse than not offering one. */}
      </CollapsibleSection>

      {source ? (
        <Card className="p-3 text-[11px] leading-snug text-ink3">
          {tf('restorePanel.sourceLine', source.width, source.height, source.frames, source.fps.toFixed(2))}
          {source.hasAudio ? t('restorePanel.soundtrackKept') : t('restorePanel.noSoundtrack')}
        </Card>
      ) : null}
    </>
  );
}
