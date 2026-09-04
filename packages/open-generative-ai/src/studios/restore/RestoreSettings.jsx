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
import { Icon } from '../../ui/icons.jsx';
import {
  Button, Card, CollapsibleSection, Field, NativeSelect, SectionLabel, Segmented, Slider, Toggle, cx,
} from '../../ui/kit.jsx';
import { remedyFor } from '../../lib/textModels.js';
import {
  CLOUD_LANE, COLOR_CORRECTIONS, RESOLUTION_PRESETS, RESTORE_MODELS,
  advancedSummary, describeChunkPlan, describeCloudPrice, describeLane, describePrice,
  describeTensorRt, laneHasTensorRt,
} from '../../lib/videoRestore.js';

// Two local lanes both called "This computer" is a picker nobody can use, so
// the default lane keeps the friendly name and every other one is named.
function laneName(lane) {
  if (lane.lane === CLOUD_LANE) return 'Hosted GPU';
  if (lane.paid) return lane.machine || 'Rented GPU';
  if (lane.lane === 'default') return 'This computer';
  return `This computer — ${lane.lane} lane`;
}

// Two paid lanes that say "Paid" and nothing else are a choice nobody can make.
// The badge says HOW, because that is the actual difference between them: one
// meters the machine for as long as you keep it, the other meters the render.
function laneBadge(lane) {
  if (lane.lane === CLOUD_LANE) return 'Per render';
  return lane.paid ? 'Per hour' : 'Free';
}


function LaneRow({ lane, selected, onSelect, price, cloudQuote, onRemedy }) {
  const usable = lane.available;
  const hosted = lane.lane === CLOUD_LANE;
  // The repair the capabilities payload named. It renders OUTSIDE the row —
  // the row is a `<button disabled>`, and a button nested in a disabled button
  // never receives a click, which is how "Settings → HivemindOS account" came
  // to be a sentence instead of a door.
  const remedy = !usable && lane.remedy ? remedyFor(lane.remedy) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        disabled={!usable}
        onClick={() => onSelect(lane.lane)}
        className={cx(
          'w-full rounded-lg border px-3 py-2 text-left transition-colors',
          selected ? 'border-honey bg-bg2' : 'border-line1 bg-bg1 hover:bg-bg2',
          !usable && 'cursor-not-allowed opacity-50',
        )}
      >
        <span className="flex items-center gap-2">
          <Icon name={lane.paid ? 'cloud' : 'cpu'} size={14} />
          <span className="text-sm font-medium text-ink1">{laneName(lane)}</span>
          {usable ? (
            <span className={cx(
              'ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
              lane.paid ? 'bg-bg3 text-ink2' : 'bg-honey/20 text-honey',
            )}>
              {laneBadge(lane)}
            </span>
          ) : (
            // No price on a machine that cannot run the job: "free" beside
            // "cannot do this" reads as an offer.
            <span className="ml-auto rounded bg-bg3 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink3">
              Unavailable
            </span>
          )}
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-ink3">{describeLane(lane)}</span>
        {usable && describeTensorRt(lane) ? (
          <span className={cx(
            'mt-1 flex items-center gap-1 text-[11px] leading-snug',
            laneHasTensorRt(lane) ? 'text-honey' : 'text-ink3',
          )}>
            <Icon name={laneHasTensorRt(lane) ? 'pulse' : 'info'} size={11} />
            {describeTensorRt(lane)}
          </span>
        ) : null}
        {/* A lane that cannot run the job says why, and — where the owner can do
            something about it — what to do. "Unavailable" on its own is the same
            sentence as "broken", and only one of the two is true here. */}
        {!usable && lane.reason ? (
          <span className="mt-1 block text-[11px] leading-snug text-ink3">{lane.reason}</span>
        ) : null}
        {selected && hosted ? (
          <span className="mt-1 block text-[11px] font-medium text-ink2">
            {/* The price, or an honest absence of one. Never nothing: a paid lane
                showing no figure reads as free. */}
            {describeCloudPrice(cloudQuote)
              || (cloudQuote === undefined ? 'Pricing this render…' : 'This render could not be priced — nothing will be charged without a figure here.')}
          </span>
        ) : null}
        {selected && lane.paid && !hosted && price ? (
          <span className="mt-1 block text-[11px] font-medium text-ink2">{describePrice(price)}</span>
        ) : null}
      </button>
      {remedy && onRemedy ? (
        <Button size="sm" className="self-start" onClick={() => onRemedy(remedy)}>{remedy.label}</Button>
      ) : null}
    </div>
  );
}

export function RestoreSettings({
  lanes, selectedLane, onSelectLane, price, cloudQuote,
  settings, onChange, plan, source, busy, onRemedy = null,
}) {
  const set = (key) => (value) => onChange({ ...settings, [key]: value });
  const model = RESTORE_MODELS.find((item) => item.id === settings.model) || RESTORE_MODELS[2];
  const singleChunk = (plan?.chunks?.length || 0) < 2;

  return (
    <>
      <div className="flex flex-col gap-2">
        <SectionLabel>Where it runs</SectionLabel>
        {lanes.length ? lanes.map((lane) => (
          <LaneRow
            key={lane.lane}
            lane={lane}
            price={price}
            cloudQuote={cloudQuote}
            selected={lane.lane === selectedLane}
            onSelect={onSelectLane}
            onRemedy={onRemedy}
          />
        )) : (
          <Card className="p-3 text-[11px] leading-snug text-ink3">
            No machine here has the SeedVR2 nodes. Install
            {' '}<code className="text-ink2">ComfyUI-SeedVR2_VideoUpscaler</code>{' '}
            on this ComfyUI, or attach a rented machine that has it from the Machines page.
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Model</SectionLabel>
        <NativeSelect value={settings.model} onChange={(event) => set('model')(event.target.value)} disabled={busy}>
          {RESTORE_MODELS.map((item) => (
            <option key={item.id} value={item.id}>{item.label} — {item.size}</option>
          ))}
        </NativeSelect>
        <p className="text-[11px] leading-snug text-ink3">
          {model.hint} A model this machine has not used before downloads on its first chunk.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Output</SectionLabel>
        <Segmented
          size="sm"
          options={RESOLUTION_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
          value={settings.resolution}
          onChange={set('resolution')}
        />
        <p className="text-[11px] leading-snug text-ink3">
          {RESOLUTION_PRESETS.find((item) => item.id === settings.resolution)?.hint}
          {plan?.width ? ` This clip comes out ${plan.width}x${plan.height}.` : ''}
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
      <CollapsibleSection title="Advanced" hint={advancedSummary(settings)} storageKey="restore.advanced">
        <Field label="Cap the long edge" hint="0 leaves it alone. Useful on very wide footage, where the short-edge target makes the width enormous.">
          <Slider
            value={settings.maxResolution}
            min={0} max={7680} step={160}
            onChange={set('maxResolution')}
            format={(value) => (value ? `${value}px` : 'off')}
          />
        </Field>

        <SectionLabel>How it is cut up</SectionLabel>
        <Field
          label="Temporal batch"
          hint="Frames the model denoises together. More is steadier and needs more memory — not faster: measured on a 5090, going from 5 to 21 took 7% off the render and 52% more VRAM. Snapped to the model's 4n+1 lattice."
        >
          <Slider value={settings.batchSize} min={1} max={33} step={4} onChange={set('batchSize')} format={(value) => `${value} frames`} />
        </Field>
        <Field label="Chunk length" hint="Also the checkpoint interval — an interrupted render resumes at the last finished chunk.">
          <Slider value={settings.chunkSeconds} min={1} max={20} step={0.5} onChange={set('chunkSeconds')} format={(value) => `${value}s`} />
        </Field>
        <Field
          label="Lead-in"
          hint="Frames each chunk re-reads from the one before, so it starts having seen them. This is what stops a visible re-grade at every boundary — and it is extra render time."
        >
          <Slider value={settings.contextFrames} min={0} max={20} step={1} onChange={set('contextFrames')} format={(value) => `${value} frames`} />
        </Field>
        <Field
          label="Seam dissolve"
          hint={singleChunk
            ? 'Nothing to dissolve — this clip is one chunk.'
            : 'Frames to cross-dissolve where two chunks overlap. Replaces frames rather than inserting them, so the master stays exactly as long as the source.'}
        >
          <Slider
            value={settings.seamFrames}
            min={0} max={Math.max(0, settings.contextFrames)} step={1}
            onChange={set('seamFrames')}
            format={(value) => (value ? `${value} frames` : 'hard cut')}
          />
        </Field>

        <SectionLabel>Colour and seed</SectionLabel>
        <NativeSelect value={settings.colorCorrection} onChange={(event) => set('colorCorrection')(event.target.value)}>
          {COLOR_CORRECTIONS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </NativeSelect>
        <p className="text-[11px] leading-snug text-ink3">
          {COLOR_CORRECTIONS.find((item) => item.id === settings.colorCorrection)?.hint}
        </p>
        <Field label="Seed" hint="One seed for every chunk of a project. Two chunks denoised from different noise are two slightly different grades meeting at a seam.">
          <Slider value={settings.seed} min={0} max={99999} step={1} onChange={set('seed')} />
        </Field>

        <SectionLabel>Memory and speed</SectionLabel>
        <Toggle
          checked={settings.tiledVae}
          onChange={set('tiledVae')}
          label="Tiled VAE — less memory, slower, can leave faint tile edges on flat gradients"
        />
        {/* No "Compile the model" toggle. Measured on a rented RTX 5090: it
            makes the first chunk 47% slower and crashes the second
            (CompatibleDiT does not support len()), so there is no setting of it
            that helps a chunked render. Offering a switch the gateway refuses
            would be worse than not offering one. */}
      </CollapsibleSection>

      {source ? (
        <Card className="p-3 text-[11px] leading-snug text-ink3">
          Source: {source.width}x{source.height}, {source.frames} frames at {source.fps.toFixed(2)}fps
          {source.hasAudio ? ' — its soundtrack is carried over untouched.' : ' — no soundtrack.'}
        </Card>
      ) : null}
    </>
  );
}
