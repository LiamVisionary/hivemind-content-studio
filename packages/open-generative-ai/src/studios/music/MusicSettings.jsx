// Advanced — the dials the sentence in the composer does not carry.
//
// Everything here changes HOW the track is rendered rather than what it is:
// sampler, scheduler, step count, guidance and the seed. They are behind a
// disclosure because none of them is a decision somebody writing a song is
// trying to make, and because getting one of them wrong on a turbo model is how
// an eight-step render becomes a forty-step one that sounds the same.
//
// The licence sits at the foot of the drawer rather than on the stage: it is a
// fact about the model, it is worth being able to find, and it is not something
// to put in front of somebody every time they press the button.
import { DrawerBody, DrawerChoice, DrawerDivider, DrawerHeading, DrawerRow, DrawerSection, DrawerValue } from '../frame/AdvancedDrawer.jsx';
import { accepts } from '../../lib/musicLane.js';
import { parseSeedInput } from '../image/imagePrefs.js';
import { Icon } from '../../ui/icons.jsx';
import { NativeSelect, Slider, TextInput, Toggle } from '../../ui/kit.jsx';

export function MusicSettings({ model, setup, onSetup, licence = '', runsOn = '', disabled = false }) {
  const patch = (next) => onSetup({ ...setup, ...next });
  const samplers = Array.isArray(model?.samplers) ? model.samplers : [];
  const schedulers = Array.isArray(model?.schedulers) ? model.schedulers : [];

  return (
    <DrawerBody>
      <DrawerHeading>Runs on</DrawerHeading>
      <div className="px-[19px] pb-4 pt-1">
        <div className="flex w-full items-center gap-[9px] rounded-[11px] bg-white/[0.04] px-[13px] py-[11px] text-left">
          <Icon name="cpu" size={16} className="shrink-0 text-inkSoft" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink1">{runsOn || 'This Mac'}</span>
            <span className="block truncate text-[11px] text-inkSoft">
              Rendered here. Nothing about the song leaves this machine.
            </span>
          </span>
        </div>
      </div>

      <DrawerSection label="Sampling" hint={`${setup.steps} steps`}>
        {accepts(model, 'steps') ? (
          <DrawerRow label="Steps" hint={String(setup.steps)} stack>
            <Slider
              min={4}
              max={60}
              step={1}
              value={setup.steps}
              disabled={disabled}
              onChange={(value) => patch({ steps: value })}
              format={(value) => `${value}`}
            />
          </DrawerRow>
        ) : null}
        {accepts(model, 'cfg') ? (
          <DrawerRow label="Guidance" hint={String(setup.cfg)} stack>
            <Slider
              min={1}
              max={10}
              step={0.5}
              value={setup.cfg}
              disabled={disabled}
              onChange={(value) => patch({ cfg: value })}
              format={(value) => value.toFixed(1)}
            />
          </DrawerRow>
        ) : null}
        {accepts(model, 'sampler_name') && samplers.length ? (
          <DrawerRow label="Sampler">
            <NativeSelect
              className="w-36"
              value={setup.samplerName}
              disabled={disabled}
              onChange={(event) => patch({ samplerName: event.target.value })}
            >
              {samplers.map((name) => <option key={name} value={name}>{name}</option>)}
            </NativeSelect>
          </DrawerRow>
        ) : null}
        {accepts(model, 'scheduler') && schedulers.length ? (
          <DrawerRow label="Scheduler">
            <NativeSelect
              className="w-36"
              value={setup.scheduler}
              disabled={disabled}
              onChange={(event) => patch({ scheduler: event.target.value })}
            >
              {schedulers.map((name) => <option key={name} value={name}>{name}</option>)}
            </NativeSelect>
          </DrawerRow>
        ) : null}
      </DrawerSection>

      <DrawerDivider />

      <DrawerSection label="Repeatability" hint={Number(setup.seed) < 0 ? 'random' : 'pinned'}>
        {accepts(model, 'seed') ? (
          <DrawerRow
            label="Seed"
            title="Minus one asks the engine to pick one. Pin a number to hear the same take again."
          >
            {/* The box holds TEXT and the request holds a number. Bound
                straight to the number, clearing the field to type a new one
                reads as Number('') === 0 — a pinned seed, with the control
                below flipping itself to "pin". parseSeedInput is the Image
                studio's own parser: empty or unparseable means "pick one for
                me", which is what an empty box looks like it means. */}
            <TextInput
              className="w-28 text-right font-mono"
              type="number"
              min={0}
              step={1}
              placeholder="random"
              value={setup.seedText ?? (Number(setup.seed) >= 0 ? String(setup.seed) : '')}
              disabled={disabled}
              onChange={(event) => patch({
                seedText: event.target.value,
                seed: parseSeedInput(event.target.value),
              })}
            />
          </DrawerRow>
        ) : null}
        <DrawerRow label="Pick a seed for me">
          <DrawerChoice
            options={[{ value: 'auto', label: 'auto' }, { value: 'pin', label: 'pin' }]}
            value={Number(setup.seed) < 0 ? 'auto' : 'pin'}
            disabled={disabled}
            onChange={(value) => {
              const seed = value === 'auto' ? -1 : Math.floor(Math.random() * 1_000_000);
              patch({ seed, seedText: seed >= 0 ? String(seed) : '' });
            }}
            ariaLabel="Pick a seed for me"
          />
        </DrawerRow>
      </DrawerSection>

      {accepts(model, 'generate_audio_codes') ? (
        <>
          <DrawerDivider />
          <DrawerSection label="Engine">
            <DrawerRow
              label="Write audio codes first"
              title="The language model that composes before the sampler renders. Turning it off removes a whole pass — faster, and much less musical."
            >
              <Toggle
                checked={setup.generateAudioCodes !== false}
                disabled={disabled}
                label="Write audio codes first"
                onChange={(next) => patch({ generateAudioCodes: next })}
              />
            </DrawerRow>
          </DrawerSection>
        </>
      ) : null}

      {licence ? (
        <>
          <DrawerDivider />
          <DrawerSection label="Licence">
            <DrawerRow label={model?.name || 'This model'}>
              <DrawerValue tone={model?.license?.commercial ? 'honey' : 'ink'}>
                {model?.license?.code || '—'}
              </DrawerValue>
            </DrawerRow>
            <p className="pt-0.5 text-[11px] leading-relaxed text-ink3">{licence}</p>
          </DrawerSection>
        </>
      ) : null}
    </DrawerBody>
  );
}
