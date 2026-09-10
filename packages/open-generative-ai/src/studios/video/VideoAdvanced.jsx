// The Video studio's Advanced drawer — its body, not a settings panel.
//
// This was ~460 lines of inline JSX in VideoStudio.jsx: a permanent 320px
// column beside the player, tiered "Runs on / Task / Format" always-visible and
// one shut `CollapsibleSection title="Advanced"` holding the tuning bench. The
// studio frame turns that inside out — the stage owns the window and this opens
// over its left edge on one press — so the DRAWER is now the disclosure.
// Nothing inside it is collapsed: the CollapsibleSection flattened into plain
// sections, and its `advancedHint` (the string that existed to say what was
// armed behind a shut header) rides on the heading of SAMPLING, the section
// that owns most of what it names.
//
// Re-tiered by WHAT A CONTROL DECIDES rather than by how deep it was:
//
//   RUNS ON      — place, model and bill, the mode readout, and the two notices
//                  only a local lane can raise.
//   SHOT         — what is being made: the task (and its head-swap engine),
//                  then the old Format block — aspect, duration, resolution,
//                  quality, mode, effect.
//   CAST         — who is in it.
//   FRAMES       — what it starts, continues and refers to: keyframes,
//                  references (persona and stitched views ride inside them),
//                  and the source clip.
//   MOTION & LOOK— how it moves and what it looks like: camera, restyle,
//                  emotion, the UGC brief, and the adapters.
//   SAMPLING     — the tuning bench: quality tier, refinement, detailer, grain,
//                  the two speed switches, the seed, and every input the
//                  selected workflow declares for itself.
//   AVOID        — the negative prompt and how hard to push away from it.
//
// The composer's recipe line carries five of these decisions as one-press
// tokens. A token is only ever a shortcut: every control it touches is ALSO
// here, because the drawer is the complete surface and the sentence is not.
// That is why CAST, FRAMES and MOTION & LOOK take rendered NODES — those
// controls are the composer's stateful components (CastStrip, FrameSlotsPicker,
// ReferencesMenu, the clip chip, the four prompt-writing menus), and the studio
// hands the same elements to both places rather than this file growing a second
// copy of their forty-prop call sites.
//
// Two row vocabularies, on purpose, the same split ImageSettingsPanel makes. A
// control that needs its sentence — why the duration range collapsed, what a
// detailer pass costs, why Spectrum is forced off while chaining — keeps the
// kit's `Field`, which is the codebase's labelled-control-with-a-hint and gives
// the input a real <label>. A control that is just a value or a switch gets
// `DrawerRow`, the design's label-left / control-right line.
//
// This is a presentational component: every value it reads lives on the
// caller's mutable engine object `s` and every write goes back through the
// studio's own `commit()` / named setters / `bump()` — no store of its own, and
// not one line of generation, persistence, resume or cascade logic moved here.
import {
  AspectRatioPicker, Field, IconButton, NativeSelect, Pill, Segmented, Slider,
  TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import {
  DrawerBody, DrawerChoice, DrawerDivider, DrawerRow, DrawerRunOn, DrawerSection, DrawerValue,
} from '../frame/AdvancedDrawer.jsx';
import { aspectRatioName } from '../../lib/i18n.js';
import { PLACE_THIS_MAC } from '../../lib/runTargets.js';
import { LocalCatalogNotice } from '../LocalCatalogNotice.jsx';
import { LaneMemoryNotice } from '../LaneMemoryNotice.jsx';
import { LoraSection } from '../image/LoraSection.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';

// DrawerSection's heading on its own. The run-on card is full-bleed and owns
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

// A sentence that belongs to a DrawerRow rather than to a Field: the paragraph
// under the Task switch, and the red line naming what a head swap is still
// missing. Same three tones the panel used.
function DrawerNote({ tone = 'ink3', children }) {
  return (
    <p className={cx(
      'text-[11px] leading-relaxed',
      tone === 'danger' ? 'font-medium text-danger' : 'text-ink3',
    )}>
      {children}
    </p>
  );
}

// A row of the composer's own chip-shaped controls, wrapped for a 320px column.
// They were laid out for one wide toolbar line; here they wrap, which is the
// only change made to them.
function DrawerControls({ children }) {
  return <div className="flex flex-wrap items-center gap-2 py-1.5">{children}</div>;
}

export function VideoAdvanced({
  engine: s,
  // `commit` persists a setting and repaints; `bump` (repaint only) is never
  // needed here, because nothing in this drawer is UI-only state — every switch
  // it owns is a saved setting. The one exception, the LoRA disclosure, carries
  // its own bump inside loraProps.onToggleOpen.
  commit,
  // ---- gate + readouts ------------------------------------------------
  rentedBlocked,
  modeLabel,
  runOn,
  tabActive = true,
  // ---- task -----------------------------------------------------------
  videoTask,
  availableTasks,
  swapState,
  // ---- format ---------------------------------------------------------
  visibility,
  arOptions,
  setAr,
  arMatchedToFrame,
  startFrameArMatchAvailable,
  setMatchStartFrameAr,
  minimaxSelected,
  durationOptions,
  durationCapped,
  motionCapHint,
  setDuration,
  resolutionOptions,
  setResolution,
  qualityOptions,
  setQuality,
  modeOptions,
  setMode,
  effectOptions,
  setEffect,
  // ---- sampling -------------------------------------------------------
  advancedHint,
  tierPair,
  selectHiveModel,
  minimaxStepsAvailable,
  minimaxRefinement,
  modelDefaultSteps,
  seedAvailable,
  setSeed,
  randomizeSeed,
  lockLastSeed,
  spectrumAvailable,
  chainArmed,
  fastHighResAvailable,
  denoiseAvailable,
  setNegativePrompt,
  advancedInputs,
  setAdvanced,
  // The LoraSection prop bag, exactly as the Image studio passes it — null on a
  // model with no adapter lane, which is the whole render condition.
  loraProps = null,
  // ---- notices --------------------------------------------------------
  // Optional because the Video studio does not track a local-catalog status
  // today (only Image, Story and Sprite do). Wired the moment it grows one; the
  // home exists either way, so the notice never has to be re-invented.
  localCatalog = null,
  onSwitchToCloud = null,
  // ---- the composer's own controls, rendered here too ------------------
  // Each is the SAME element the composer builds. Null simply drops the row.
  cast = null,
  frames = null,
  references = null,
  clip = null,
  cameraMotion = null,
  restyle = null,
  emotion = null,
  ugcBrief = null,
}) {
  // Which target the card is describing. RunOnPicker resolves the same thing
  // internally for its own chip, but renderTrigger is handed the READOUT, not
  // the target, and the card's icon is the one thing the readout cannot say.
  const runOnShown = runOn.isAutomatic ? (runOn.automatic?.target || runOn.value) : runOn.value;

  // The old panel's `Format` block had one visibility test across six controls;
  // SHOT keeps it verbatim and adds the Task switch, which had its own.
  const formatVisible = Boolean(
    visibility.ar || visibility.duration || visibility.resolution
    || visibility.quality || visibility.mode || visibility.effect,
  );
  const taskVisible = availableTasks.length > 1;
  // What SHOT is currently set to, said on its heading — the design's one-line
  // summary, built only from values already on this render.
  const shotHint = [
    visibility.duration && s.setup.duration ? `${s.setup.duration}s` : '',
    visibility.resolution ? s.setup.resolution : '',
  ].filter(Boolean).join(' · ');

  // A boolean, not a collected array: rendering `{[a, b, c]}` would hand React
  // a keyless list and log a warning on every paint, and pagesSmoke asserts the
  // studios render silently.
  const hasMotionMenus = Boolean(cameraMotion || restyle || emotion || ugcBrief);

  return (
    <DrawerBody>
      {/* ---- RUNS ON -------------------------------------------------------
          One readout for the question four controls used to ask four ways. It
          names the place, the model and the bill in one line, opens ONE list
          grouped by who pays, and carries the rented-machine card (pin, attach,
          reconnect, rent — RentedSourceStatus) inside This Mac, where a rental
          actually belongs.

          Deliberately OUTSIDE the rentedBlocked gate below, which the old panel
          was not: `rentedBlocked ? null : (…)` wrapped the WHOLE panel, so a tab
          pinned to a machine that had gone away rendered an empty column with
          its own reconnect button inside the part that had vanished. The code
          comment already claimed this behaviour ("collapse the panel to the
          Source block and its reconnect CTA"); this is that comment honoured. */}
      <DrawerHeading>Runs on</DrawerHeading>
      <RunOnPicker
        targets={runOn.targets}
        value={runOn.value}
        onChange={runOn.onChange}
        automatic={runOn.automatic}
        onAutomatic={runOn.onAutomatic}
        isAutomatic={runOn.isAutomatic}
        engine={s}
        page="video"
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
            // the subtitle here, so joining it in would say it twice.
            title={readout.model && readout.model !== readout.place
              ? `${readout.place} · ${readout.model}`
              : readout.place}
            subtitle={readout.automatic && readout.note
              ? `Automatic — ${readout.note}`
              : readout.note}
            onClick={toggle}
          />
        )}
      />
      <div className="flex flex-col gap-2 px-[19px] pb-4">
        {/* The places that can make a STILL here but have no clip route yet.
            Said once, quietly, rather than offered as rows whose Generate can
            only fail. */}
        {runOn.unreachable.length ? (
          <small className="text-[11px] text-ink3">
            {`${runOn.unreachable.join(' and ')} can make stills here, not clips yet.`}
          </small>
        ) : null}
        {/* What this run actually IS — reference → video, continue scene, head
            swap, extend. It reads out from the request plan, so it is the one
            line that answers "why did my start frame stop mattering". */}
        <Pill tone="honey" className="w-fit">{modeLabel}</Pill>
        {/* A list that cannot run anything is worse than no list: it reads as a
            working studio right up to the press. Local work is the only work
            either notice can affect, so both stay out of the cloud lane. */}
        {s.setup.localMode && localCatalog ? (
          <LocalCatalogNotice
            status={localCatalog.status}
            comfyConnected={localCatalog.comfyConnected}
            onCheckAgain={localCatalog.onCheckAgain}
            onSwitchToCloud={onSwitchToCloud}
          />
        ) : null}
        {/* Only ever visible when another local lane finished and is still
            sitting on real memory — which on this stack is mostly the --gpu-only
            LTX video lane, i.e. this studio's own. */}
        {s.setup.localMode ? <LaneMemoryNotice active={tabActive} /> : null}
      </div>
      <DrawerDivider />

      {rentedBlocked ? null : (
        <>
          {/* ---- SHOT ------------------------------------------------------
              The task, then the old Format block. Task is first and explicit
              because every input slot below reads its meaning from it —
              inferring it from whichever files were attached is what made an
              uploaded clip always mean "extend". */}
          {taskVisible || formatVisible ? (
            <DrawerSection label="Shot" hint={shotHint}>
              {taskVisible ? (
                <>
                  <DrawerRow label="Task">
                    <DrawerChoice
                      ariaLabel="Task"
                      value={videoTask}
                      onChange={(next) => commit({ ...s.setup, videoTask: next })}
                      options={[
                        { value: 'generate', label: 'Generate' },
                        { value: 'extend', label: 'Extend' },
                        { value: 'head-swap', label: 'Head swap' },
                      ]}
                    />
                  </DrawerRow>
                  <DrawerNote>
                    {videoTask === 'head-swap'
                      ? 'Replaces the face in the source video with the new face. The BFS head-swap LoRA is switched on by this mode — you do not need to select it. Prompt shaped "head_swap: FACE: … ACTION: …".'
                      : videoTask === 'extend'
                        ? 'Appends new footage to the end of the uploaded video.'
                        : 'Generates from the prompt, optionally starting from a frame you attach.'}
                  </DrawerNote>
                  {videoTask === 'head-swap' ? (
                    <>
                      <Field
                        label="Swap engine"
                        className="py-2"
                        hint={s.setup.headSwapBackend === 'facefusion'
                          ? 'Swaps only the face region — body, clothing, background and motion stay identical to your source, and it runs about 10× quicker. Hair and head shape stay the original actor\'s.'
                          : 'Regenerates every frame, so it can change hair and head shape — but the whole picture is reinvented rather than preserved.'}
                      >
                        <Segmented
                          value={s.setup.headSwapBackend === 'facefusion' ? 'facefusion' : 'bfs'}
                          onChange={(next) => commit({ ...s.setup, headSwapBackend: next })}
                          options={[
                            { value: 'bfs', label: 'Regenerate whole frame' },
                            { value: 'facefusion', label: 'Swap face only' },
                          ]}
                        />
                      </Field>
                      {s.setup.headSwapBackend === 'facefusion' ? (
                        <DrawerRow label="Face enhancer (about 2× slower)">
                          <Toggle
                            checked={Boolean(s.setup.headSwapFaceEnhancer)}
                            onChange={(next) => commit({ ...s.setup, headSwapFaceEnhancer: next })}
                            label="Face enhancer (about 2× slower)"
                          />
                        </DrawerRow>
                      ) : (
                        <Field
                          label="Head-swap strength"
                          className="py-2"
                          hint="1.0 gives the best motion fidelity. Above 1.0 captures identity and hair more strongly, but can distort."
                        >
                          <Slider
                            min={0.5}
                            max={1.5}
                            step={0.05}
                            value={Number(s.setup.headSwapLoraStrength ?? 1)}
                            onChange={(next) => commit({ ...s.setup, headSwapLoraStrength: next })}
                            format={(v) => Number(v).toFixed(2)}
                          />
                        </Field>
                      )}
                    </>
                  ) : null}
                  {/* Never a problem without its fix: the same sentence is the
                      disabled Generate button's title, so the two agree. */}
                  {swapState.active && !swapState.ready ? (
                    <DrawerNote tone="danger">
                      {'Still needed: '}{swapState.missing.join(' and ')}
                    </DrawerNote>
                  ) : null}
                </>
              ) : null}

              {visibility.ar ? (
                <Field
                  label="Aspect ratio"
                  className="py-2"
                  hint={arMatchedToFrame ? 'Matched to the starting frame — no cropping' : undefined}
                >
                  {/* Six across, and no friendly name under each tile: the
                      drawer is 320px wide, so "Portrait" would wrap where the
                      ratio itself does not. Same control, one density tighter. */}
                  <AspectRatioPicker
                    columns={6}
                    options={arOptions}
                    value={s.setup.ar}
                    onChange={setAr}
                    disabled={arMatchedToFrame}
                    nameFor={aspectRatioName}
                  />
                </Field>
              ) : null}
              {startFrameArMatchAvailable ? (
                <DrawerRow label="Use starting frame aspect ratio">
                  <Toggle
                    label="Use starting frame aspect ratio"
                    checked={s.setup.matchStartFrameAr}
                    onChange={setMatchStartFrameAr}
                  />
                </DrawerRow>
              ) : null}
              {visibility.duration ? (
                minimaxSelected ? (
                  // A slider when the model offers a RANGE. Its ends come from
                  // availableDurationsFor, which collapses while a motion
                  // reference is attached — the run used to be accepted and then
                  // die minutes later on the card, after the references were
                  // staged. motionCapHint says which of the two reasons it is.
                  <Field
                    label="Duration"
                    className="py-2"
                    hint={durationCapped
                      ? motionCapHint
                      : 'Up to 15s — the model keeps people and scenes consistent for about 15 seconds, so longer takes are not offered.'}
                  >
                    <Slider
                      min={Number(durationOptions[0]) || 1}
                      max={Number(durationOptions[durationOptions.length - 1]) || 15}
                      step={1}
                      value={Number(s.setup.duration) || 5}
                      onChange={setDuration}
                      format={(v) => `${v}s`}
                    />
                  </Field>
                ) : (
                  // …and a select when it offers a LIST. Same setting, same
                  // setter; the model decides which shape can tell the truth.
                  <Field label="Duration" className="py-2">
                    <NativeSelect value={String(s.setup.duration)} onChange={(e) => setDuration(e.target.value)}>
                      {durationOptions.map((d) => <option key={d} value={String(d)}>{`${d}s`}</option>)}
                    </NativeSelect>
                  </Field>
                )
              ) : null}
              {visibility.resolution ? (
                minimaxSelected ? (
                  <Field
                    label="Resolution"
                    className="py-2"
                    hint={{
                      Standard: 'Fastest — try an idea cheaply before a real render (0.3MP).',
                      High: 'The balanced default for speed and detail (0.9MP).',
                      Max: "Best quality — the model's own canvas: sharpest detail, audio and on-screen text, and the slowest to render (1.0MP, its ceiling).",
                    }[s.setup.resolution] || undefined}
                  >
                    <Segmented
                      value={s.setup.resolution}
                      onChange={setResolution}
                      options={[
                        { value: 'Standard', label: 'Draft' },
                        { value: 'High', label: 'High' },
                        { value: 'Max', label: 'Best quality' },
                      ]}
                    />
                  </Field>
                ) : (
                  <Field label="Resolution" className="py-2">
                    <NativeSelect value={s.setup.resolution} onChange={(e) => setResolution(e.target.value)}>
                      {resolutionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                    </NativeSelect>
                  </Field>
                )
              ) : null}
              {visibility.quality ? (
                <Field label="Quality" className="py-2">
                  <NativeSelect value={s.setup.quality} onChange={(e) => setQuality(e.target.value)}>
                    {qualityOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                  </NativeSelect>
                </Field>
              ) : null}
              {visibility.mode ? (
                <Field label="Mode" className="py-2">
                  <NativeSelect value={s.setup.mode} onChange={(e) => setMode(e.target.value)}>
                    {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                  </NativeSelect>
                </Field>
              ) : null}
              {visibility.effect ? (
                <Field label="Effect type" className="py-2">
                  <NativeSelect value={s.setup.effectName} onChange={(e) => setEffect(e.target.value)}>
                    {effectOptions.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
                  </NativeSelect>
                </Field>
              ) : null}
            </DrawerSection>
          ) : null}

          {/* ---- CAST ------------------------------------------------------
              WHO is in the shot — every way of adding someone lands in the one
              strip, and the weave recasts the prompt the moment it changes. The
              recipe line's "Maya + Dog" token is a shortcut to exactly this. */}
          {cast ? (
            <DrawerSection label="Cast">
              <DrawerControls>{cast}</DrawerControls>
            </DrawerSection>
          ) : null}

          {/* ---- FRAMES ----------------------------------------------------
              What the shot starts from, continues from, and refers to. The
              keyframe picker changes shape with the model (three LTX slots, a
              start/end pair, a single start frame, or the chain chip that
              replaces all of them); the references control carries the persona
              bar and the stitched ingredient views inside it; the clip chip
              says which of its two meanings is live. */}
          {frames || references || clip ? (
            <DrawerSection label="Frames">
              <DrawerControls>
                {frames}
                {references}
                {clip}
              </DrawerControls>
            </DrawerSection>
          ) : null}

          {/* ---- MOTION & LOOK ---------------------------------------------
              How it moves and what it looks like. The four prompt-writing menus
              write into the prompt rather than into settings, which is why they
              sit together and away from SAMPLING; the adapters are the one
              thing here that changes the graph. */}
          {hasMotionMenus || loraProps ? (
            <DrawerSection label="Motion & look">
              {hasMotionMenus ? (
                <DrawerControls>
                  {cameraMotion}
                  {restyle}
                  {emotion}
                  {ugcBrief}
                </DrawerControls>
              ) : null}
              {loraProps ? (
                <div className="pt-2">
                  <LoraSection {...loraProps} />
                </div>
              ) : null}
            </DrawerSection>
          ) : null}

          {/* ---- SAMPLING --------------------------------------------------
              The tuning bench that used to live behind the shut "Advanced"
              header. `advancedHint` was that header's summary of what was armed
              down here — it rides on this heading now, because hidden state is
              fine and unsaid state is not. */}
          <DrawerSection label="Sampling" hint={advancedHint}>
            {/* Lite/Standard for models that ship both a distilled and a
                full-step build. Only rendered when both are installed, and
                switching swaps the SELECTED MODEL — not a setting — so exactly
                one is ever active and the run-on list still shows one row. */}
            {tierPair ? (
              <Field
                label="Quality"
                className="py-2"
                hint={tierPair.lite.id === s.setup.modelId
                  ? 'Fastest, with softer detail (distilled, ~8 steps)'
                  : 'Best quality — about 3x slower (full-step CFG)'}
              >
                <Segmented
                  value={tierPair.lite.id === s.setup.modelId ? 'lite' : 'standard'}
                  onChange={(tier) => { if (tierPair[tier]) selectHiveModel(tierPair[tier]); }}
                  options={[
                    { value: 'lite', label: 'Faster' },
                    { value: 'standard', label: 'Best quality' },
                  ]}
                />
              </Field>
            ) : null}
            {minimaxStepsAvailable ? (
              <Field
                label="Refinement"
                className="py-2"
                hint={minimaxRefinement === 'high'
                  ? 'Smoother motion, sharper hands and faces, cleaner audio — roughly twice the render time (32 sampling passes).'
                  : `Quickest, at the model's own default (${Math.round(modelDefaultSteps || 15)} sampling passes).`}
              >
                <Segmented
                  value={minimaxRefinement}
                  onChange={(next) => commit({ ...s.setup, steps: next === 'high' ? 32 : null })}
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'high', label: 'High detail' },
                  ]}
                />
              </Field>
            ) : null}
            {denoiseAvailable ? (
              <Field
                label="Detailer"
                className="py-2"
                hint={s.setup.detailerStrength
                  ? "Lightricks' IC-LoRA Detailer runs a second sampling pass over the clip to add fine texture. Roughly doubles generation time."
                  : 'Off — one pass, exactly as fast as before.'}
              >
                <NativeSelect
                  value={String(s.setup.detailerStrength || 0)}
                  onChange={(e) => commit({ ...s.setup, detailerStrength: Number(e.target.value) })}
                >
                  <option value="0">Off</option>
                  <option value="0.4">Subtle (0.4)</option>
                  <option value="0.6">Recommended (0.6)</option>
                  <option value="0.9">Strong (0.9)</option>
                </NativeSelect>
              </Field>
            ) : null}
            {denoiseAvailable ? (
              <Field
                label="Grain cleanup"
                className="py-2"
                hint={s.setup.denoise
                  ? (s.setup.denoise === 'strong'
                    ? 'Motion-adaptive temporal pass + a spatial pass. Re-encodes after generation.'
                    : 'Motion-adaptive temporal pass: averages static grain, leaves moving detail alone.')
                  : 'Off — the clip is saved exactly as the model rendered it.'}
              >
                <NativeSelect
                  value={s.setup.denoise || ''}
                  onChange={(e) => commit({ ...s.setup, denoise: e.target.value })}
                >
                  <option value="">Off</option>
                  <option value="light">Light</option>
                  <option value="strong">Strong</option>
                </NativeSelect>
              </Field>
            ) : null}
            {spectrumAvailable ? (
              <Field
                label="Faster, softer detail"
                className="py-2"
                hint={chainArmed
                  ? 'Forced off while chaining scenes: step forecasting mispredicts the pinned join frames.'
                  : 'About half the sampling time: roughly half the steps are predicted rather than computed, so fine detail softens and highlights can bloom. Turn it off for maximum fidelity (Spectrum).'}
              >
                <Toggle
                  checked={!chainArmed && s.setup.spectrum !== false}
                  disabled={chainArmed}
                  onChange={(next) => commit({ ...s.setup, spectrum: next })}
                  label="Faster, softer detail"
                />
              </Field>
            ) : null}
            {fastHighResAvailable ? (
              <Field
                label="Fast high-res"
                className="py-2"
                hint="About half the render time, at the same size, length and sound — most of the steps run on a much smaller canvas before the picture is lifted to full size. The same seed gives a different take, not the same one faster."
              >
                <Toggle
                  checked={s.setup.fastHighRes === true}
                  onChange={(next) => commit({ ...s.setup, fastHighRes: next })}
                  label="Fast high-res"
                />
              </Field>
            ) : null}
            {seedAvailable ? (
              <Field
                label="Seed"
                className="py-2"
                hint="Lock one and the same settings give you the same take again."
              >
                <div className="flex items-center gap-1.5">
                  <TextInput
                    type="number"
                    min={0}
                    step={1}
                    value={s.setup.seed >= 0 ? String(s.setup.seed) : ''}
                    placeholder="Random"
                    onChange={(e) => setSeed(e.target.value === '' ? -1 : e.target.value)}
                    className="flex-1"
                  />
                  <IconButton
                    icon="refresh"
                    label="Randomize seed"
                    title="Use a fresh random seed each generation"
                    active={s.setup.seed < 0}
                    onClick={randomizeSeed}
                  />
                </div>
                {/* The take you just liked, one press from being pinned. */}
                {s.setup.seed < 0 && typeof s.lastSeed === 'number' ? (
                  <button
                    type="button"
                    onClick={lockLastSeed}
                    className="mt-1 text-left text-xs text-ink3 hover:text-honey"
                  >
                    {'Last seed: '}<DrawerValue>{s.lastSeed}</DrawerValue>{' · click to lock'}
                  </button>
                ) : null}
              </Field>
            ) : null}
            {/* Whatever else the SELECTED WORKFLOW declares. These are not a
                fixed list: a graph publishes its own inputs and the panel grows
                a toggle, a select or a typed field for each one. They landed at
                the bottom of the old Advanced section and they land at the
                bottom of SAMPLING, because they are the same thing — knobs
                nobody here can name in advance. */}
            {advancedInputs.map((input) => {
              const value = s.setup.advancedValues[input.name];
              if (input.type === 'boolean') {
                return (
                  <DrawerRow key={input.name} label={input.title || input.name} title={input.description || ''}>
                    <Toggle
                      label={input.title || input.name}
                      checked={Boolean(value)}
                      onChange={(v) => setAdvanced(input.name, v)}
                    />
                  </DrawerRow>
                );
              }
              if (Array.isArray(input.enum) && input.enum.length > 0) {
                return (
                  <Field key={input.name} label={input.title || input.name} className="py-2">
                    <NativeSelect
                      value={String(value)}
                      onChange={(e) => {
                        const match = input.enum.find((v) => String(v) === e.target.value);
                        setAdvanced(input.name, match ?? e.target.value);
                      }}
                    >
                      {input.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v).replaceAll('_', ' ')}</option>)}
                    </NativeSelect>
                  </Field>
                );
              }
              const numeric = ['int', 'float', 'number'].includes(input.type);
              return (
                <Field key={input.name} label={input.title || input.name} className="py-2">
                  <TextInput
                    type={numeric ? 'number' : 'text'}
                    value={value ?? ''}
                    min={numeric && input.minValue != null ? input.minValue : undefined}
                    max={numeric && input.maxValue != null ? input.maxValue : undefined}
                    step={numeric ? (input.step ?? (input.type === 'int' ? 1 : 'any')) : undefined}
                    className={numeric ? 'font-mono' : ''}
                    onChange={(e) => setAdvanced(input.name, numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
                  />
                </Field>
              );
            })}
          </DrawerSection>

          {/* ---- AVOID -----------------------------------------------------
              Its own section rather than two more rows of the tuning bench: the
              negative prompt is the only control here that takes WORDS, and it
              is the one whose absence from a lane is worth saying out loud.
              denoiseAvailable gates the pair together — H3 has no negative
              conditioning lane, so offering it there would be a lie. */}
          {denoiseAvailable ? (
            <DrawerSection label="Avoid">
              <Field
                label="Avoid these things"
                className="py-2"
                hint="What to keep out of the shot. Works at best quality; the faster lanes ignore it."
              >
                <TextArea
                  rows={2}
                  value={s.setup.negativePrompt || ''}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  placeholder="blurry, bad anatomy, extra fingers, deformed hands, watermark"
                  className="resize-y text-xs"
                />
              </Field>
              {/* Only once there is a list to push away from — a strength dial
                  over an empty box is a control that does nothing. */}
              {String(s.setup.negativePrompt || '').trim() ? (
                <Field
                  label="How hard to avoid them"
                  className="py-2"
                  hint="How hard to push the shot away from that list — adds about 8% to the render. Raise it if it is still not listening (NAG)."
                >
                  <NativeSelect
                    value={String(s.setup.nagScale ?? '')}
                    onChange={(e) => commit({
                      ...s.setup,
                      nagScale: e.target.value === '' ? null : Number(e.target.value),
                    })}
                  >
                    <option value="">Default (11)</option>
                    <option value="5">Subtle (5)</option>
                    <option value="15">Strong (15)</option>
                    <option value="1">Off</option>
                  </NativeSelect>
                </Field>
              ) : null}
            </DrawerSection>
          ) : null}
        </>
      )}
    </DrawerBody>
  );
}
