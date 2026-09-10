// The Video studio's composer — the insides of the frame's one floating panel.
//
// What changed, and why: the chip row is gone. Thirteen labelled chips wrapping
// over two lines read as a toolbar and stopped the prompt bar reading as a
// prompt bar, so the settings people actually change are written as a sentence
// instead —
//
//   Make a [5s clip] at [16:9] [continuing shot 03] with [Maya + Dog] on [RTX 5090] .  Advanced →
//
// Every token is still the control the chip was: pressing it opens the same
// menu, writing through the same studio handler, and the SAME control also
// exists in the Advanced drawer, which stays the complete surface. A token is
// only ever a shortcut.
//
// The doors that are not settings sit on the action row, left of Generate:
// frames · improve · starters · camera · more. `more` is where the controls the
// design draws no door for went — Style, Emotion, UGC, Shots, the source clip,
// the Hivemind prompt library, Start fresh, the completion chime and the manual
// timeline — rather than being dropped. Nothing in the old row was removed;
// several things moved one press deeper, the sentence took over the four that
// were settings, and the prompt library came in from the retired topbar.
//
// The panel chrome — radius, blur, shadow, the drop ring and the
// `data-studio-composer` wire contract — belongs to StudioFrame's ComposerFloat.
// This file draws what goes inside it.
//
// Still presentational: it reads the caller's mutable engine object and calls
// the studio's own handlers, exactly as the studio did inline. No generation,
// persistence, resume, queue or cascade logic lives here — including the
// deliberate asymmetry between the keyboard shortcut's guards
// (rentedBlocked || generating) and the button's `disabled`, which is preserved
// as it was rather than quietly reconciled.
import { useState } from 'react';

import { aspectRatioName, t } from '../../lib/i18n.js';
import { runOnReadout } from '../../lib/runTargets.js';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { Icon } from '../../ui/icons.jsx';
import { AspectRatioPicker, NativeSelect, Slider, Spinner, Toggle, cx } from '../../ui/kit.jsx';
import { ChipButton, MenuItem, useDismissable } from '../../ui/Menu.jsx';
import { CompletionPingToggle } from '../../ui/CompletionPingToggle.jsx';
import {
  ComposerMeta, ComposerPanel, ComposerPrimary, ComposerPrompt, ComposerSecondary, ComposerTool,
} from '../frame/ComposerPanel.jsx';
import { ExploreDockItem } from '../frame/ExploreDockItem.jsx';
import { RecipeLine, RecipeToken } from '../frame/RecipeLine.jsx';
import { SavedPromptsMenu } from '../SavedPromptsMenu.jsx';
import { UgcMenu } from '../UgcMenu.jsx';
import { UploadPicker } from '../UploadPicker.jsx';
import { CameraMotionMenu } from './CameraMotionMenu.jsx';
import { CastStrip } from './CastStrip.jsx';
import { EmotionMenu } from './EmotionMenu.jsx';
import { FrameSlotsPicker } from './FrameSlotsPicker.jsx';
import { PromptCheckMenu } from './PromptCheckMenu.jsx';
import { ReferencesMenu } from './ReferencesMenu.jsx';
import { RestyleMenu } from './RestyleMenu.jsx';
import { ShotBuilderChip } from './ShotBuilder.jsx';

/**
 * A popover that does NOT clip what it holds.
 *
 * `Menu` scrolls its panel (max-h + overflow-y-auto), which is right for a list
 * of MenuItems and wrong for a panel holding controls that open popovers of
 * their OWN — the cast strip's member editors and add list, Style, Emotion, UGC
 * and the clip chip all anchor inside their own trigger, and a scrolling parent
 * cut them off mid-list. Same dismissal contract (useDismissable, so Escape and
 * an outside pointerdown behave exactly as every other composer popover, and a
 * portaled [role=dialog] raised from inside does not tear it down), no scroll box.
 */
function LoosePopover({ renderTrigger, width = 'w-[26rem]', align = 'start', children }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative inline-block">
      {renderTrigger(open, () => setOpen((v) => !v))}
      {open ? (
        <div
          role="menu"
          className={cx(
            'hive-scale-in absolute bottom-[calc(100%+6px)] z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-line1 bg-bg1 p-2 shadow-pop',
            width,
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      ) : null}
    </div>
  );
}

export function VideoComposerBar({
  engine: s,
  promptRef,

  /* ---- the prompt ---- */
  // derivePromptUi(): a watermark remover has no prompt, so the box is disabled
  // (never hidden) and every prompt-WRITING door goes with it.
  promptUi,
  setPrompt,
  extendBanner,

  /* ---- the cast ---- */
  castTarget,
  referenceLane,
  h3,
  castWoven,
  onCastChange,
  onCastAttach,
  onCastWeave,
  onDraftLook,
  onAddMedia,

  /* ---- frames, references, the source clip ---- */
  // The four frame controls are mutually exclusive and in THIS order — the
  // three-slot picker, then the chain chip, then the two-slot picker, then the
  // plain start-frame picker. Only one ever renders, and the studio's own
  // effects null the stale halves when the branch changes.
  ltxFramesVisible,
  endFrameVisible,
  chainArmed,
  chainShot,
  onClearChain,
  slotLabels,
  refsArmed,
  uploadFn,
  requireApiKey,
  onStartFrameChange,
  onMiddleFrameChange,
  onLtxEndFrameChange,
  onEndFrameChange,
  referenceEntry,
  ingredientModel,
  ingredientViews,
  referenceLimits = {},
  sceneRefs = [],
  sceneRoles = {},
  onSceneRole,
  onCharacterRefsChange,
  onSceneRefsChange,
  onReferenceAudiosChange,
  onReferenceVideosChange,
  onPersonaChange,
  personaSeed,
  onOpenClip,
  videoFileInputRef,
  memberFileInputRef,
  onVideoFile,
  onMemberFiles,
  clipChipContinues,
  clipUrl,
  onVideoRefClick,

  /* ---- the prompt-writing doors ---- */
  starterGender,
  standIns = [],
  captureContext,
  onLoadPrompt,
  onLoadContext,
  cameraMotionIds = [],
  onApplyCameraMotions,
  emotionDirectionId,
  onApplyEmotion,
  ugcActive,
  ugcVariantIndex,
  ugcFormatId,
  ugcGender,
  ugcSubject,
  ugcDuration,
  ugcVerticalAvailable,
  onApplyUgc,
  restylePresetId,
  onApplyRestyle,
  shotTimeline = null,
  onOpenShotBuilder,
  promptCheckRefs = {},
  promptCheckDurations = {},
  onRefit,
  onWeave,
  onRefine,
  onOpenPromptHelper,

  /* ---- the recipe line's settings ---- */
  // The SAME values the Advanced drawer renders, computed once in the studio's
  // render and handed to both surfaces, so a shortcut can never diverge from the
  // drawer it shortcuts.
  videoTask,
  durationVisible,
  durationIsSlider,
  durationOptions = [],
  durationHint,
  onDurationChange,
  aspectVisible,
  aspectOptions = [],
  aspectMatchedToFrame,
  startFrameArMatchAvailable,
  onAspectChange,
  onMatchStartFrameAr,
  runOn,

  /* ---- the drawer ---- */
  advancedOpen,
  onToggleAdvanced,

  /* ---- `more` ---- */
  onNewPrompt,
  onClearPrompt,
  // The studio's own <TimelineStrip …>, handed over as a node rather than
  // rebuilt: the rail cannot express reorder-by-drag, exclude, cut, combine or
  // delete-with-file, so the full strip stays one press away.
  timeline = null,

  /* ---- generate ---- */
  generateLabel,
  generateBlocked,
  generateTitle,
  rentedBlocked,
  etaLabel = '',
  onGenerate,
  onCancel,
}) {
  // Which extra card is open over the prompt. The timeline is the studio's own
  // component; this only decides whether it is on screen.
  const [timelineOpen, setTimelineOpen] = useState(false);
  const promptWritable = !promptUi.disabled;
  const hasPrompt = Boolean(s.setup.prompt.trim());

  /* ---------------- the recipe line's values ---------------- */

  const durationSeconds = Number(s.setup.duration) || 0;
  // The task rides in the FIRST token rather than as a fourth badge: "5s clip",
  // "5s extension", "head swap" — the sentence says what the press will make.
  const clipValue = videoTask === 'head-swap'
    ? 'head swap'
    : `${durationSeconds ? `${durationSeconds}s ` : ''}${videoTask === 'extend' ? 'extension' : 'clip'}`;
  const aspectValue = aspectMatchedToFrame
    ? 'the starting frame aspect'
    : (s.setup.ar || t('common.auto'));
  // Scene members hold picture slots but are not IN the shot, so they are not
  // people and never take a <Subject N> — the same split the strip draws.
  const people = (s.cast || []).filter((member) => member && member.kind !== 'scene');
  const castValue = people.length === 0
    ? 'nobody yet'
    : people.length <= 2
      ? people.map((member) => member.name || 'someone').join(' + ')
      : `${people.length} in the shot`;
  // "~3m 20s · $0.42/hr". The cost half is the note runOnReadout already writes
  // for the picker ("free, stays here", "$0.42/hr"), trimmed to its first clause
  // so a mono readout can hold it; the eta half is the studio's, and is simply
  // absent until it has one.
  const runOnShown = runOn.isAutomatic ? (runOn.automatic?.target || runOn.value) : runOn.value;
  const runCost = String(runOnReadout(runOnShown).note || '').split(',')[0].trim();
  const metaLabel = [etaLabel ? `~${etaLabel}` : '', runCost].filter(Boolean).join(' · ');

  const recipeParts = [
    { text: 'Make a' },
    {
      key: 'duration',
      value: clipValue,
      disabled: !durationVisible,
      title: durationVisible ? 'How long the clip runs' : 'This model decides the length itself',
      menu: durationVisible ? () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          {/* The control the panel offers for THIS model — a slider where the
              model takes any length in a range, a list where it takes only the
              lengths it was trained on. */}
          {durationIsSlider ? (
            <Slider
              min={Number(durationOptions[0]) || 1}
              max={Number(durationOptions[durationOptions.length - 1]) || 15}
              step={1}
              value={durationSeconds || 5}
              onChange={onDurationChange}
              format={(v) => `${v}s`}
            />
          ) : (
            <NativeSelect
              value={String(s.setup.duration)}
              aria-label="Duration"
              onChange={(e) => onDurationChange(e.target.value)}
            >
              {durationOptions.map((d) => <option key={d} value={String(d)}>{`${d}s`}</option>)}
            </NativeSelect>
          )}
          {durationHint ? (
            <p className="text-[11px] leading-relaxed text-ink3">{durationHint}</p>
          ) : null}
        </div>
      ) : undefined,
    },
    { text: 'at' },
    {
      key: 'aspect',
      value: aspectValue,
      // Still pressable while the starting frame owns the aspect: the toggle
      // that gave it away is inside, and disabling the token would strand it.
      disabled: !aspectVisible && !startFrameArMatchAvailable,
      title: aspectMatchedToFrame ? 'Matched to the starting frame — no cropping' : 'Aspect ratio',
      menuWidth: 'w-[19rem]',
      menu: (aspectVisible || startFrameArMatchAvailable) ? () => (
        <div className="flex flex-col gap-2.5 px-1 py-0.5">
          {aspectVisible ? (
            <AspectRatioPicker
              columns={3}
              options={aspectOptions}
              value={s.setup.ar}
              onChange={onAspectChange}
              disabled={aspectMatchedToFrame}
              nameFor={aspectRatioName}
            />
          ) : null}
          {startFrameArMatchAvailable ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-ink2">Use starting frame aspect ratio</span>
              <Toggle
                label="Use starting frame aspect ratio"
                checked={s.setup.matchStartFrameAr}
                onChange={onMatchStartFrameAr}
              />
            </div>
          ) : null}
        </div>
      ) : undefined,
    },
    // The only honey word in the sentence, and it takes no connective before it:
    // it names the shot this one continues FROM, and pressing it stops chaining.
    // It also stays while the three-slot frame picker owns the frames, which is
    // the one place the tools row's own chain chip cannot draw.
    chainArmed ? {
      key: 'chain',
      value: `continuing shot ${chainShot}`,
      tone: 'honey',
      onClick: onClearChain,
      title: 'Stop continuing the scene — the pinned frames carry motion and room tone, the scene carries through the prompt',
    } : null,
    promptWritable ? { text: 'with' } : null,
    promptWritable ? {
      key: 'cast',
      // The whole strip, in a popover: adding someone opens a list, a member
      // chip opens an editor, and both are popovers of their own, so this one
      // must not scroll them away.
      node: (
        <LoosePopover
          width="w-[30rem]"
          renderTrigger={(open, toggle) => (
            <RecipeToken
              value={castValue}
              tone={people.length ? 'honey' : 'neutral'}
              active={open}
              title="Who is in the shot — every way of adding someone lands here, and the weave recasts the prompt the moment it changes"
              aria-label="Who is in the shot"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        >
          <CastStrip
            members={s.cast}
            onMembersChange={onCastChange}
            target={castTarget}
            referenceLane={referenceLane}
            h3={h3}
            woven={castWoven}
            promptEmpty={!hasPrompt}
            warnings={s.castWarnings}
            onAttach={onCastAttach}
            onWeave={onCastWeave}
            onDraftLook={onDraftLook}
            onAddMedia={onAddMedia}
          />
        </LoosePopover>
      ),
    } : null,
    { text: 'on' },
    {
      key: 'runOn',
      // Where it runs and on what, in the sentence — the same control and the
      // same joined list as the drawer's card. `page` / `pinned` / `onPin` stay
      // adjacent and in that order: rentedMachines.test.js reads them as three
      // consecutive lines on every surface that offers a run target.
      node: (
        <RunOnPicker
          bare
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
          renderTrigger={(open, toggle, readoutLabel) => (
            <button
              type="button"
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              title={readoutLabel}
              aria-label={readoutLabel}
              className={cx(
                'inline-flex max-w-[220px] items-center truncate rounded-md px-2 py-[3px] text-[12.5px] transition-colors',
                'bg-white/[0.06] text-ink1 hover:bg-white/[0.11]',
                open && 'ring-1 ring-inset ring-honey/60',
              )}
            >
              <span className="truncate">{readoutLabel}</span>
            </button>
          )}
        />
      ),
    },
    { text: '.' },
  ];

  /* ---------------- the cards that open over the prompt ---------------- */

  const above = (
    <>
      {extendBanner ? (
        <div className="flex items-center gap-2 rounded-md border border-honey/30 bg-honey-tint px-3 py-2 text-xs text-honey">
          <Icon name="arrowRight" size={14} className="shrink-0" />
          <span>{extendBanner}</span>
        </div>
      ) : null}
      {/* The manual timeline, opened from `more`. It draws a wide horizontal
          strip with its own drag targets, so it opens over the prompt rather
          than inside a popover that would clip every drop. */}
      {timeline && timelineOpen ? (
        <div className="rounded-md border border-line1 bg-bg1 p-2">{timeline}</div>
      ) : null}
    </>
  );

  /* ---------------- the source clip ---------------- */

  // One chip, two meanings, and the chip SAYS which. The request plan decides:
  // where a clip seeds the next shot's opening frames (motion context) it is
  // "Continue from clip"; everywhere else a clip is an INPUT to the run, so it
  // is the source video. One icon and the word "Clip" for both is what made it
  // unguessable.
  const clipLabel = clipChipContinues ? 'Continue from clip' : 'Source video';
  const clipIdle = clipChipContinues
    ? 'Continue from a clip — the next shot picks up where it ends, motion and room tone carrying across'
    : `${'Upload'}: ${slotLabels.video}${slotLabels.videoHint ? ` — ${slotLabels.videoHint}` : ''}`;
  const clipAttachedText = `${s.setup.videoName || clipLabel} — ${'click to clear'}`;
  const clipChip = (
    <ChipButton
      icon={clipChipContinues ? 'film' : 'upload'}
      label={clipLabel}
      value={clipUrl ? (s.setup.videoName || 'attached') : ''}
      active={Boolean(clipUrl)}
      chevron={false}
      disabled={s.videoUploading}
      aria-label={clipUrl ? clipAttachedText : `${clipLabel} — ${clipIdle}`}
      title={clipUrl ? clipAttachedText : clipIdle}
      onClick={onVideoRefClick}
    />
  );

  /* ---------------- the action row's doors ---------------- */

  // The `more` door lights when anything behind it is armed — a hidden setting
  // that steers the render must never be invisible state.
  const moreArmed = Boolean(clipUrl)
    || Boolean(restylePresetId)
    || Boolean(emotionDirectionId)
    || Boolean(ugcActive)
    || Boolean((shotTimeline?.shots || []).length);

  const tools = (
    <>
      {/* FRAMES. Four controls, one at a time, in this order — and they stay
          MOUNTED here rather than living in a popover: UploadPicker and
          ReferencesMenu carry the `data-upload-picker` attribute the composer's
          own drop guard checks, so a picture dropped on one of them is attached
          once instead of twice. */}
      {ltxFramesVisible ? (
        // LTX 2.3: one control with Start / Middle / End rows (all optional).
        <FrameSlotsPicker
          label="Frames"
          slots={[
            { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
            { key: 'middle', label: 'Middle', url: s.setup.ltxMiddleUrl },
            { key: 'end', label: 'End', url: s.setup.ltxEndUrl },
          ]}
          onSlotChange={(key, url) => {
            const value = url ? [url] : [];
            if (key === 'start') onStartFrameChange(value);
            else if (key === 'middle') onMiddleFrameChange(value);
            else onLtxEndFrameChange(value);
          }}
          uploadFn={uploadFn}
          requireApiKey={requireApiKey}
          autoOpen={s.framesPanelAutoOpen}
        />
      ) : chainArmed ? (
        // Scene chaining replaces the start frame: the armed clip's tail IS the
        // opening of this shot, so the picker gives way to the chain chip. The
        // sentence carries the same state as a token; this is the door that also
        // explains what a pinned frame does.
        <div
          className="flex items-center gap-1.5 rounded-md border border-honey/40 bg-honey-tint px-2 py-1"
          title="The pinned frames carry motion and room tone — the SCENE carries through the prompt. Keep the shot's style and subject words, hold the previous closing framing for a beat, then describe what happens next."
        >
          <Icon name="film" size={13} className="text-honey" />
          <span className="text-xs font-medium text-honey">{`Continuing shot ${chainShot}`}</span>
          <button
            type="button"
            title="Stop continuing the scene"
            aria-label="Stop continuing the scene"
            className="grid h-4 w-4 place-items-center rounded text-honey transition-colors hover:bg-honey/20"
            onClick={onClearChain}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ) : endFrameVisible ? (
        // First/last-frame models (H3 FL2VA, remote FLF): ONE control with Start
        // / End rows, same pattern as the LTX three-slot picker — never two
        // lookalike icon buttons side by side. Armed character references replace
        // these frames for the run, but the picker stays mounted (dimmed, with a
        // note) — hiding it stranded an already-set start frame with no way to
        // change it or add the end frame.
        <FrameSlotsPicker
          label="Frames"
          slots={[
            { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
            { key: 'end', label: 'End (optional)', url: s.setup.endImageUrl },
          ]}
          onSlotChange={(key, url) => {
            const value = url ? [url] : [];
            if (key === 'start') onStartFrameChange(value);
            else onEndFrameChange(value);
          }}
          uploadFn={uploadFn}
          requireApiKey={requireApiKey}
          inactiveNote={refsArmed ? 'Character references replace these frames while attached' : ''}
        />
      ) : (
        <UploadPicker
          values={s.setup.imageUrl ? [s.setup.imageUrl] : []}
          onChange={onStartFrameChange}
          uploadFn={uploadFn}
          requireApiKey={requireApiKey}
          maxImages={1}
          accept="image/*"
          label="Start frame"
          ignored={refsArmed}
        />
      )}

      {referenceEntry || ingredientModel ? (
        // One control for every reference kind this model has. The slot counts
        // come from the workflow entry rather than being restated here, so the
        // panel can never offer a slot the graph has not wired — and a model
        // whose only reference kind is stitched views shows just those.
        <ReferencesMenu
          images={Array.isArray(s.setup.referenceImageUrls) ? s.setup.referenceImageUrls : []}
          audios={Array.isArray(s.setup.referenceAudios) ? s.setup.referenceAudios : []}
          videos={Array.isArray(s.setup.referenceVideos) ? s.setup.referenceVideos : []}
          prompt={s.setup.prompt}
          // The explicit Weave lives in ONE place — Prompt Check, and the cast
          // strip's own readout — so the panel does not show a third copy of the
          // button. (It still accepts onWeave; nothing is passed.)
          durationSeconds={durationSeconds}
          limits={referenceLimits}
          views={ingredientViews}
          viewsOnly={!referenceEntry}
          scene={sceneRefs}
          sceneRoles={sceneRoles}
          onSceneRole={onSceneRole}
          onChange={{
            images: onCharacterRefsChange,
            scene: onSceneRefsChange,
            audios: onReferenceAudiosChange,
            videos: onReferenceVideosChange,
          }}
          persona={s.setup.persona || null}
          onPersonaChange={onPersonaChange}
          personaSeed={personaSeed}
          uploadFn={uploadFn}
          requireApiKey={requireApiKey}
          openRequest={s.referencesOpenRequest || 0}
          // Head replacement's one door. Offered only on a family whose registry
          // actually carries an inpaint graph, so the thumbnail never opens a
          // dialog whose Apply the run would ignore.
          onOpenClip={onOpenClip}
        />
      ) : null}

      <input
        ref={videoFileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => { void onVideoFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      {/* The cast strip's per-member attach — files land claimed for the member
          whose chip opened this picker. Both inputs reset e.target.value so
          re-picking the same file fires again. */}
      <input
        ref={memberFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          const key = e.target.dataset.memberKey || '';
          e.target.value = '';
          if (key && files.length) void onMemberFiles(key, files);
        }}
      />

      {/* The prompt-writing doors mean nothing on a tool whose prompt is
          disabled (a watermark remover), so they go with the textarea. The
          frame, reference and clip controls do not. */}
      {promptWritable ? (
        <>
          {/* IMPROVE. The helper, named for what it does here: it refines what is
              in the box — told the cast, the lane, the clip length and the
              attached references — rather than replacing it. */}
          <ComposerTool
            icon="wand"
            label={t('composer.refine')}
            disabled={!hasPrompt}
            title={hasPrompt ? t('composer.refineTitle') : t('composer.improveDisabled')}
            onClick={onOpenPromptHelper}
          />

          {/* STARTERS. The shipped shelf and the saved library are sections of
              ONE menu, as they already were — renamed to the door the design
              draws, so Image and Video call the same thing by the same word. */}
          <SavedPromptsMenu
            section="video"
            prompt={s.setup.prompt}
            modelSource={s.setup}
            chip={{ icon: 'folder', label: t('composer.starters'), title: t('composer.startersTitle') }}
            // Starters render for whoever holds <Subject 1> — the loaded persona,
            // or the first cast member — so the pronouns already fit before the
            // stand-in is bound.
            renderGender={starterGender}
            standIns={standIns}
            capture={captureContext}
            onLoadPrompt={onLoadPrompt}
            onLoadContext={onLoadContext}
          />

          {/* CAMERA. Up to three ordered moves, composed into one idempotent
              prompt phrase. */}
          <CameraMotionMenu selectedIds={cameraMotionIds} onApply={onApplyCameraMotions} />
        </>
      ) : null}

      {/* MORE. Everything the design's four doors do not draw, one press deeper
          instead of gone: the performance and style pickers, the UGC brief, the
          shot builder, the source clip, the Hivemind prompt library, the manual
          timeline, Start fresh and the app-wide completion chime. Its own panel
          rather than a Menu, because
          four of the things inside it open popovers of their own. */}
      <LoosePopover
        width="w-[24rem]"
        align="end"
        renderTrigger={(open, toggle) => (
          <ComposerTool icon="more" label="More" active={open || moreArmed} onClick={toggle} />
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-2">
            {promptWritable ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Performance direction is visible acting, so unlike the H3-only
                    controls beside it this applies to every video model — the
                    picker just writes H3's dialect when H3 is selected. */}
                <EmotionMenu activeId={emotionDirectionId} onApply={onApplyEmotion} />
                {/* Restyle presets, the UGC brief ([Shot 1] HOOK … / (S1) says …),
                    the Shot Builder and Prompt Check all write H3's own grammar,
                    so every one of them is H3-only — the UGC brief used to land in
                    LTX and cloud prompts too. */}
                {h3 ? (
                  <>
                    <RestyleMenu activeId={restylePresetId} onApply={onApplyRestyle} />
                    <UgcMenu
                      mode="video"
                      active={ugcActive}
                      variantIndex={ugcVariantIndex}
                      formatId={ugcFormatId}
                      gender={ugcGender}
                      subject={ugcSubject}
                      durationSeconds={ugcDuration}
                      verticalAvailable={ugcVerticalAvailable}
                      onArm={onApplyUgc}
                    />
                    <ShotBuilderChip
                      timeline={shotTimeline}
                      prompt={s.setup.prompt}
                      onOpen={() => { onOpenShotBuilder(); close(); }}
                    />
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5">{clipChip}</div>

            <div className="my-0.5 h-px bg-line1" />

            {/* The prompt library reads first among the doors: like the pickers
                above it, it writes the box. It came from the retired topbar,
                which carried it on every page including the ones with no prompt
                to insert into. It keeps its own toggle semantics, so unlike its
                neighbours it does not close(). */}
            <ExploreDockItem />
            {timeline ? (
              <MenuItem
                icon="clapper"
                selected={timelineOpen}
                onClick={() => { setTimelineOpen((v) => !v); close(); }}
                title="Reorder, exclude, cut, combine or delete the shots of this sequence by hand"
              >
                Timeline
              </MenuItem>
            ) : null}
            {/* One app-wide setting, beside the outcome it announces — it used to
                be the last row of this studio's Advanced section, where nobody
                looks for a sound setting. */}
            <div className="flex items-center justify-between gap-3 px-2 py-1">
              <span className="text-[13px] text-ink2">{t('common.pingWhenComplete')}</span>
              <CompletionPingToggle />
            </div>
            {/* Last, under a rule of its own: everything above this line changes
                what the NEXT press does, and this one throws away what is on
                screen. Among the settings it read as a third one, and it got
                pressed by people who only wanted an empty prompt — which is now
                a badge in the box's corner. The studio asks before it acts. */}
            <div className="my-0.5 h-px bg-line1" />
            <MenuItem icon="x" onClick={() => { onNewPrompt(); close(); }}>
              {t('common.startFresh')}
            </MenuItem>
          </div>
        )}
      </LoosePopover>

      {/* An upload in flight has to be visible with every popover shut. */}
      {s.videoUploading ? <Spinner size={14} className="text-honey" /> : null}
    </>
  );

  return (
    <ComposerPanel
      above={above}
      prompt={(
        <ComposerPrompt
          inputRef={promptRef}
          placeholder={promptUi.placeholder}
          disabled={promptUi.disabled}
          value={s.setup.prompt}
          onChange={(e) => setPrompt(e.target.value)}
          // The small door, in the box's own corner: empties this box and
          // nothing else — the frames, the cast and the clip stay. Start fresh
          // (in `more`) is the big one.
          onClear={onClearPrompt}
          // ⌘/Ctrl+Enter generates, the same as every other composer, behind the
          // guards it has always used. Deliberately NOT the button's `disabled`
          // expression: reconciling the two is a behaviour change, and this file
          // does not make behaviour changes.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            if (rentedBlocked || s.generating) return;
            void onGenerate();
          }}
        />
      )}
      recipe={(
        <RecipeLine
          parts={recipeParts}
          advancedOpen={advancedOpen}
          onToggleAdvanced={onToggleAdvanced}
        />
      )}
      tools={tools}
      meta={(
        <>
          {/* The last thing between a prompt and a paid generation, read out
              beside the press it guards. A READOUT, not a gate — nothing here
              blocks Generate. */}
          {promptWritable && h3 ? (
            <PromptCheckMenu
              prompt={s.setup.prompt}
              durationSeconds={durationSeconds}
              images={promptCheckRefs.images}
              videos={promptCheckRefs.videos}
              audios={promptCheckRefs.audios}
              durations={promptCheckDurations}
              // The one finding with a mechanical fix, and the last door:
              // adoptPrompt catches a prompt arriving from somewhere, and
              // withDurationThatFits catches the length changing under one
              // already written. This catches the rest — text TYPED or PASTED
              // straight into the composer, which nothing else can see.
              onRefit={onRefit}
              onWeave={onWeave}
              onRefine={onRefine}
            />
          ) : null}
          {!s.generating && metaLabel ? (
            <ComposerMeta title={t('composer.etaTitle')}>{metaLabel}</ComposerMeta>
          ) : null}
        </>
      )}
      secondary={s.generating ? (
        <ComposerSecondary onClick={onCancel} title={t('composer.cancelTitle')}>
          {t('common.cancel')}
        </ComposerSecondary>
      ) : null}
      primary={(
        <ComposerPrimary
          loading={s.generating}
          disabled={generateBlocked}
          onClick={onGenerate}
          title={generateTitle}
        >
          {generateLabel}
        </ComposerPrimary>
      )}
    />
  );
}
