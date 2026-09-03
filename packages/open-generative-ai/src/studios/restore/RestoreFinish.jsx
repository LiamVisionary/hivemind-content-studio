// Finishing, which is deliberately NOT restoration.
//
// Sharpening, grain, flat-detail softening and the reframe are decided from the
// chunks the render already produced, so changing your mind costs one ffmpeg
// pass rather than another hour of diffusion. That is the entire reason the
// chunk files survive the master being written, and it is the sentence this
// panel leads with — otherwise the obvious assumption is that touching any of
// these dials means starting again.
import { Button, Card, Field, NativeSelect, SectionLabel, Slider } from '../../ui/kit.jsx';

const RATIOS = ['', '16:9', '9:16', '1:1', '4:5', '21:9', '4:3'];

export function RestoreFinish({ finish, onChange, onApply, busy, disabled, assemblesHere }) {
  const set = (key) => (value) => onChange({ ...finish, [key]: value });
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <SectionLabel>Finish</SectionLabel>
        <p className="mt-1 text-[11px] leading-snug text-ink3">
          {assemblesHere
            ? 'Applied to the restored chunks already on disk — re-running this costs one pass, not another render.'
            : 'Applied to the clip this browser joined from the rented render. Re-running it re-joins and re-encodes, but never re-restores.'}
        </p>
      </div>

      <Field label="Sharpen" hint="Modest by design. SeedVR2 has already resolved the detail; a hard unsharp on top of it puts back the halo the restore removed.">
        <Slider value={finish.sharpen} min={0} max={1} step={0.05} onChange={set('sharpen')} format={(value) => (value ? value.toFixed(2) : 'off')} />
      </Field>

      <Field
        label="Soften flat detail"
        hint="Blurs flat areas and leaves edges alone — skin texture and sensor grain go, eyelashes stay. It is not face-aware; it treats every flat area the same way."
      >
        <Slider value={finish.skinSoftening} min={0} max={1} step={0.05} onChange={set('skinSoftening')} format={(value) => (value ? value.toFixed(2) : 'off')} />
      </Field>

      <Field label="Grain" hint="Moving grain, laid over the finished picture. A little of it hides the plastic look a strong restore can leave.">
        <Slider value={finish.grain} min={0} max={1} step={0.05} onChange={set('grain')} format={(value) => (value ? value.toFixed(2) : 'off')} />
      </Field>

      <Field label="Reframe" hint="Pad adds bars; crop cuts footage. Neither upscales — the box always fits inside what the model actually made.">
        <div className="flex gap-2">
          <NativeSelect value={finish.aspect} onChange={(event) => set('aspect')(event.target.value)}>
            <option value="source">Leave the frame alone</option>
            <option value="pad">Pad to</option>
            <option value="crop">Crop to</option>
          </NativeSelect>
          <NativeSelect
            value={finish.aspectRatio}
            disabled={finish.aspect === 'source'}
            onChange={(event) => set('aspectRatio')(event.target.value)}
          >
            {RATIOS.map((ratio) => <option key={ratio || 'none'} value={ratio}>{ratio || '—'}</option>)}
          </NativeSelect>
        </div>
      </Field>

      <Field label="Quality" hint="CRF: lower is a bigger, better file. 16 is a master you can grade; 22 is a delivery copy.">
        <Slider value={finish.quality} min={8} max={30} step={1} onChange={set('quality')} format={(value) => `CRF ${value}`} />
      </Field>

      <Button icon="wand" onClick={onApply} disabled={disabled || busy} loading={busy}>
        {busy ? 'Finishing…' : 'Apply finish'}
      </Button>
    </Card>
  );
}
