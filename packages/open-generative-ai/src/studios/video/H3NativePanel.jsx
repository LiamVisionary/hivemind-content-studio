// The MiniMax H3 (Apple Silicon) bench, inside the Video drawer.
//
// This lane's engine is antirez/h3.c running on this Mac's own GPU, and its
// settings are not the ones every other video lane has. There is no forecaster
// to switch off and no negative prompt: speed comes from doing less work
// — fewer sampling steps, fewer of the 50 transformer blocks, reusing the
// denoiser's velocity between steps, sampling on a smaller internal canvas.
//
// Four decisions shaped this panel.
//
// **One ladder, not four checkboxes.** Every dial here changes the TAKE, not
// just the time: a 4-step draft is a different clip from a 50-step render at
// the same seed. Presenting them as independent switches would invite
// combinations upstream measures as broken. So the primary control is a single
// Effort slider over the registry's presets, and the dials live behind a
// disclosure for when someone genuinely wants one.
//
// **The machine answers for itself.** Where the slider STARTS, whether the
// transformer streams from SSD, and whether the M5 int8 kernel is used are all
// decided by what this Mac is, and the gateway decides them — the panel reads
// them back and says so on the machine line. A 128 GB M5 and a 16 GB Air get
// different right answers, and neither is asked to know that.
//
// **Nothing untouched is sent.** The panel writes only what a person changed.
// An unset dial means "the preset decides" and an unset preset means "this Mac
// decides", all the way to the engine — which is what lets one saved tab open
// correctly on a different machine.
//
// **A problem is never shown without its fix.** An unbuilt engine, a missing
// checkpoint, the Ref2VA download reference mode needs: each appears as the one
// sentence that says what to run, not as a dead control or a submit-time error.
import { useEffect, useState } from 'react';

import { Field, Slider, Toggle, cx } from '../../ui/kit.jsx';
import { DrawerChoice, DrawerDivider, DrawerRow, DrawerSection, DrawerValue } from '../frame/AdvancedDrawer.jsx';
import {
  effectiveH3Dials, h3DialsAreCustom, h3MachineSummary, loadH3NativeProfile,
  resolveH3Preset, tokenReductionBlocked,
} from '../../lib/h3Native.js';

// The internal sampling canvas, as three named choices rather than a free
// number: h3 only accepts same-aspect multiples of 32, so a continuous slider
// would offer sizes the engine rounds away anyway.
const RENDER_SCALES = [
  { value: 1, label: 'Full', title: 'Sample at the output size.' },
  { value: 0.75, label: '¾', title: 'Sample at three quarters and upscale.' },
  { value: 0.5, label: '½', title: 'Sample at half size and upscale — about a quarter of the work.' },
];

function Notice({ tone = 'warn', children }) {
  return (
    <div className={cx(
      'rounded-md border px-3 py-2 text-[11px] leading-relaxed',
      tone === 'warn' ? 'border-warn/40 bg-warn/10 text-ink2' : 'border-line1 bg-bg2 text-ink3',
    )}>
      {children}
    </div>
  );
}

export function H3NativePanel({
  // The registry's `h3_native` block for the selected workflow.
  nativeH3,
  // The tab's saved H3 settings — ONLY what was changed. `{}` is a studio
  // nobody has touched, which is not the same as the draft preset.
  setup = {},
  // Persist a new settings object. Called with the whole bag, like commit().
  onChange,
  // Whether any reference picture, clip or voice is attached, so the Ref2VA
  // notice can be the difference between information and a blocked run.
  referencesAttached = false,
  // Skipped while the tab is in the background: this asks the gateway, which
  // stats a checkpoint tree.
  active = true,
}) {
  const [profile, setProfile] = useState(null);
  const [showDials, setShowDials] = useState(false);

  useEffect(() => {
    if (!active || !nativeH3) return;
    let live = true;
    loadH3NativeProfile().then((answer) => { if (live) setProfile(answer); });
    return () => { live = false; };
  }, [active, nativeH3]);

  if (!nativeH3) return null;

  const { ladder, name, preset, index, explicit, recommended } = resolveH3Preset(setup, nativeH3, profile);
  const dials = effectiveH3Dials(setup, preset);
  const custom = h3DialsAreCustom(setup, preset);
  const machine = profile?.machine || null;
  const derived = machine?.recommended || null;
  const blocker = machine && !machine.ready ? machine.blocked_by : null;
  const ranges = nativeH3.dials || {};
  const limits = nativeH3.limits || {};

  // A dial write always pins the preset too. Without it, moving a dial on the
  // machine's *recommended* preset would leave the request saying "recommend
  // me a preset, but with 42 layers" — and a different Mac would resolve that
  // to a different base. Choosing a dial is choosing the stop it sits on.
  const setDial = (key, value) => onChange({ ...setup, preset: name, [key]: value });
  const setSwitch = (key, value) => onChange({ ...setup, [key]: value });
  const setPreset = (next) => {
    // Moving the ladder clears the overrides: the stop IS the setting, and a
    // leftover 42-layer override would silently follow you to Reference and
    // quietly stop it being a reference render.
    const { steps, layers, reuse, core_reuse: coreReuse, render_scale: renderScale, ...rest } = setup;
    onChange({ ...rest, preset: next });
  };
  const clearOverrides = () => setPreset(name);

  const tokenBlocked = tokenReductionBlocked(dials);
  const tokenOn = setup.token_reduction === true && !tokenBlocked;
  const streaming = setup.ssd_streaming === undefined || setup.ssd_streaming === null
    ? Boolean(derived?.ssd_streaming) : Boolean(setup.ssd_streaming);
  const int8 = setup.int8_row_fc2 === undefined || setup.int8_row_fc2 === null
    ? Boolean(derived?.int8_row_fc2) : Boolean(setup.int8_row_fc2);

  return (
    <>
      <DrawerSection
        label="Effort"
        hint={preset ? `${preset.label}${custom ? ' · edited' : ''}` : ''}
      >
        {/* The lane cannot run at all — one sentence, and the command that
            fixes it. Everything below stays visible and usable: a person can
            set a render up while the weights download. */}
        {blocker ? (
          <div className="pb-2">
            <Notice>
              {blocker.reason}
              {blocker.fix ? (
                <>
                  {' '}
                  <code className="rounded bg-bg3 px-1 py-0.5 font-mono text-[10.5px] text-ink1">{blocker.fix}</code>
                </>
              ) : null}
            </Notice>
          </div>
        ) : null}
        {profile?.unreachable ? (
          <div className="pb-2">
            <Notice tone="quiet">
              This Mac has not answered about the H3 engine, so the settings below show the
              workflow&apos;s own defaults rather than what this machine recommends.
            </Notice>
          </div>
        ) : null}

        <Field
          label="How much work to spend"
          className="py-2"
          hint={preset?.description || ''}
        >
          <Slider
            min={0}
            max={Math.max(0, ladder.length - 1)}
            step={1}
            value={index}
            onChange={(next) => setPreset(ladder[next]?.name || name)}
            format={() => preset?.label || ''}
            aria-label="Effort"
          />
          {/* The stops, named under the track: a slider whose positions are
              words needs them written down, and this is also how the
              recommended stop is pointed at. */}
          <div className="mt-1 flex justify-between">
            {ladder.map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setPreset(item.name)}
                title={item.description}
                className={cx(
                  'text-[10.5px] transition-colors',
                  item.name === name ? 'font-medium text-honey' : 'text-ink3 hover:text-ink1',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Field>

        {/* What the machine decided, and the fact behind it. This is the
            "detected best settings" answer — said once, in words, rather than
            as three switches nobody should have to reason about. */}
        {machine ? (
          <DrawerRow
            label={h3MachineSummary(profile) || 'This Mac'}
            stack
            hint={!explicit && recommended === name ? 'recommended' : ''}
          >
            <p className="text-[11px] leading-relaxed text-ink3">
              {derived?.why || ''}
              {derived ? (
                <>
                  {' '}
                  {streaming
                    ? 'The transformer streams from SSD, which costs about a quarter of the speed and saves ~34 GB.'
                    : 'The whole model stays in memory.'}
                  {int8 ? ' The M5 int8 kernel is on.' : ''}
                </>
              ) : null}
            </p>
            {explicit && recommended && recommended !== name ? (
              <button
                type="button"
                onClick={() => setPreset(recommended)}
                className="self-start text-[11px] text-ink3 transition-colors hover:text-honey"
              >
                {`Back to ${ladder.find((item) => item.name === recommended)?.label || recommended}, what this Mac suits`}
              </button>
            ) : null}
          </DrawerRow>
        ) : null}

        {/* Not a blocker — the runner copies the weights instead — but the
            file-backed mode is what lets H3 fit on a smaller Mac, so a snapshot
            that forces the copy is worth its sentence and its one command. */}
        {machine?.advisory ? (
          <div className="pt-1">
            <Notice tone="quiet">
              {machine.advisory.reason}
              {machine.advisory.fix ? (
                <>
                  {' '}
                  <code className="rounded bg-bg3 px-1 py-0.5 font-mono text-[10.5px] text-ink1">{machine.advisory.fix}</code>
                </>
              ) : null}
            </Notice>
          </div>
        ) : null}

        {/* Reference mode is a second 62 GiB checkpoint. Said as information
            when nothing is attached, and as a blocked run when something is. */}
        {machine && machine.model && !machine.model.ref2va && referencesAttached ? (
          <div className="pt-1">
            <Notice>
              {'Reference pictures run MiniMax’s separate Ref2VA checkpoint, which is not on this Mac. '}
              {'This render will be refused until it is: '}
              <code className="rounded bg-bg3 px-1 py-0.5 font-mono text-[10.5px] text-ink1">
                hf download MiniMaxAI/MiniMax-H3 --include &apos;Ref2VA/*&apos;
              </code>
              {` (~${Math.round((nativeH3.reference_mode?.bytes || 0) / 1024 ** 3)} GiB). `}
              {'Text-to-video and start/end frames work without it.'}
            </Notice>
          </div>
        ) : null}

        <DrawerRow label="" className="pt-1">
          <button
            type="button"
            onClick={() => setShowDials((open) => !open)}
            className="text-[11px] text-ink3 transition-colors hover:text-honey"
          >
            {showDials ? 'Hide the individual dials' : 'Show the individual dials'}
          </button>
        </DrawerRow>
      </DrawerSection>

      {showDials ? (
        <>
          <DrawerDivider />
          <DrawerSection
            label="Dials"
            hint={custom ? 'edited' : `${preset?.label || ''} defaults`}
          >
            <DrawerRow label="Sampling steps" stack hint={<DrawerValue>{dials.steps}</DrawerValue>}>
              <Slider
                min={Number(ranges.steps?.min) || 2}
                max={64}
                step={1}
                value={Number(dials.steps) || 20}
                onCommit={(next) => setDial('steps', next)}
                onChange={(next) => setDial('steps', next)}
                aria-label="Sampling steps"
              />
            </DrawerRow>
            <DrawerRow
              label="Transformer blocks"
              stack
              hint={<DrawerValue>{`${dials.layers} of 50`}</DrawerValue>}
            >
              <Slider
                min={Number(ranges.layers?.min) || 35}
                max={Number(ranges.layers?.max) || 50}
                step={1}
                value={Number(dials.layers) || 50}
                onChange={(next) => setDial('layers', next)}
                aria-label="Transformer blocks"
              />
            </DrawerRow>
            <DrawerRow
              label="Velocity reuse"
              title="How often the denoiser recomputes its velocity. 1 recomputes every step."
            >
              <DrawerChoice
                ariaLabel="Velocity reuse"
                value={Number(dials.reuse) || 1}
                onChange={(next) => setDial('reuse', next)}
                options={[1, 2, 3].map((value) => ({ value, label: String(value) }))}
              />
            </DrawerRow>
            <DrawerRow
              label="Core refresh"
              title={Number(dials.reuse) > 1
                ? 'The engine refuses both reuse dials at once — lower velocity reuse to 1 to use this.'
                : 'How often the core residual is refreshed. 1 refreshes every step.'}
            >
              <DrawerChoice
                ariaLabel="Core refresh"
                disabled={Number(dials.reuse) > 1}
                value={Number(dials.core_reuse) || 1}
                onChange={(next) => setDial('core_reuse', next)}
                options={[1, 2, 4, 6].map((value) => ({ value, label: String(value) }))}
              />
            </DrawerRow>
            <DrawerRow
              label="Internal canvas"
              title={`Sampling size, as a share of the output. Never below ${limits.min_render_edge || 256}px on the short edge.`}
            >
              <DrawerChoice
                ariaLabel="Internal canvas"
                mono={false}
                value={Number(dials.render_scale) || 1}
                onChange={(next) => setDial('render_scale', next)}
                options={RENDER_SCALES}
              />
            </DrawerRow>
            {custom ? (
              <DrawerRow label="">
                <button
                  type="button"
                  onClick={clearOverrides}
                  className="text-[11px] text-ink3 transition-colors hover:text-honey"
                >
                  {`Back to the ${preset?.label || ''} settings`}
                </button>
              </DrawerRow>
            ) : null}
          </DrawerSection>

          <DrawerDivider />
          <DrawerSection label="Engine">
            <Field
              label="Token reduction"
              className="py-2"
              hint={tokenBlocked
                ? 'Unavailable at this Effort: pairing tokens over a thinned, heavily reused transformer is the combination upstream warns produces artefacts, and the engine refuses it.'
                : (nativeH3.token_reduction?.note
                  || 'About 28% faster, with a standing report of doubled images and garbled audio. Off unless you want it.')}
            >
              <Toggle
                checked={tokenOn}
                disabled={tokenBlocked}
                onChange={(next) => setSwitch('token_reduction', next)}
                label="Token reduction"
              />
            </Field>
            <Field
              label="Stream the transformer from SSD"
              className="py-2"
              hint={setup.ssd_streaming === undefined || setup.ssd_streaming === null
                ? `Set from this Mac's memory — currently ${streaming ? 'on' : 'off'}. About a quarter slower, and ~34 GB less resident.`
                : 'About a quarter slower, and ~34 GB less resident. Set by hand; clear it to follow the machine again.'}
            >
              <Toggle
                checked={streaming}
                onChange={(next) => setSwitch('ssd_streaming', next)}
                label="Stream the transformer from SSD"
              />
            </Field>
            <Field
              label="M5 int8 FC2 kernel"
              className="py-2"
              hint={setup.int8_row_fc2 === undefined || setup.int8_row_fc2 === null
                ? `Set from this Mac's chip — currently ${int8 ? 'on' : 'off'}. One activation scale per row; about 2.6% faster, and only on an M5.`
                : 'One activation scale per row; about 2.6% faster, and only on an M5. Set by hand; clear it to follow the machine again.'}
            >
              <Toggle
                checked={int8}
                onChange={(next) => setSwitch('int8_row_fc2', next)}
                label="M5 int8 FC2 kernel"
              />
            </Field>
            {(setup.ssd_streaming !== undefined && setup.ssd_streaming !== null)
              || (setup.int8_row_fc2 !== undefined && setup.int8_row_fc2 !== null) ? (
                <DrawerRow label="">
                  <button
                    type="button"
                    onClick={() => {
                      const { ssd_streaming: _s, int8_row_fc2: _i, ...rest } = setup;
                      onChange(rest);
                    }}
                    className="text-[11px] text-ink3 transition-colors hover:text-honey"
                  >
                    Let this Mac decide these again
                  </button>
                </DrawerRow>
              ) : null}
          </DrawerSection>
        </>
      ) : null}
    </>
  );
}
