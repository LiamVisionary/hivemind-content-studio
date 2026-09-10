// The Image studio's composer — the insides of the frame's one floating panel.
//
// What changed, and why: the chip toolbar is gone. Eight labelled chips in a row
// read as a toolbar and stopped the prompt bar reading as a prompt bar, so the
// settings people actually change are written as a sentence instead —
//
//   Make [1 image] at [9:16] in [photoreal] with [2 references] on [this Mac · Z-Image] .  Advanced →
//
// Every underlined value is still the control the chip was: pressing it opens
// the same menu, writing to the same engine field, and the SAME control still
// exists in the Advanced drawer, which stays the complete surface. A token is
// only ever a shortcut.
//
// The doors that are not settings (attach, improve, starters, and the "more"
// menu holding the Hivemind prompt library, Start fresh, the camera rig and the
// completion chime) sit on the action row, left of Generate. Three of the old
// chips had no home in the design's three round doors and are recorded in
// `more` rather than dropped; the prompt library came from the retired topbar,
// which held it on pages that had no prompt to insert into.
//
// The panel chrome — radius, blur, shadow, the drop ring and the
// `data-studio-composer` wire contract — belongs to StudioFrame's ComposerFloat.
// This file draws what goes inside it.
//
// Still presentational: it reads and writes the caller's mutable engine object
// and calls `bump()` / `persist()`, exactly as the studio did inline. No
// generation, persistence, resume or queue logic lives here.
import { lazy, Suspense, useState } from 'react';

import { ENHANCE_TAGS, QUICK_PROMPTS } from '../../lib/promptUtils.js';
import { runOnReadout } from '../../lib/runTargets.js';
import { t, aspectRatioName } from '../../lib/i18n.js';
import { ugcVariantAt } from '../../lib/ugcMode.js';
import { Icon } from '../../ui/icons.jsx';
import {
  AspectRatioPicker, Button, Card, IconButton, SectionLabel, TextArea, TextInput, cx,
} from '../../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { CompletionPingToggle } from '../../ui/CompletionPingToggle.jsx';
import { DrawerChoice } from '../frame/AdvancedDrawer.jsx';
import { ExploreDockItem } from '../frame/ExploreDockItem.jsx';
import {
  ComposerMeta, ComposerPanel, ComposerPrimary, ComposerPrompt, ComposerSecondary, ComposerTool,
} from '../frame/ComposerPanel.jsx';
import { RecipeLine } from '../frame/RecipeLine.jsx';
import { UploadPicker } from '../UploadPicker.jsx';
import { CameraMenu } from './CameraMenu.jsx';
import { ReferenceRolesMenu } from './ReferenceRolesMenu.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';

// The Starters popover carries the whole shipped prompt library — the animation
// shelf, the cast/persona prompts and the H3 character notes — which made it by
// far the largest thing on the app's DEFAULT page, and it is shut on arrival.
// Loaded when the door is pressed: the placeholder below is the same ChipButton,
// so the row does not move, and the menu comes up already open because the click
// that armed it IS the click that opens it.
const SavedPromptsMenuLazy = lazy(() => import('../SavedPromptsMenu.jsx').then((m) => ({ default: m.SavedPromptsMenu })));


export function ImageComposer({
  engine: s,
  bump,
  persist,
  promptRef,
  setPromptValue,
  // ---- references ----
  refsSupported,
  refsIgnored,
  refCount,
  referenceLabelStyle,
  uploadFn,
  requireApiKey,
  onPickerChange,
  onClearReferences,
  onApplyRoles,
  // ---- prompt helpers ----
  helper,
  onRunWorkflowHelper,
  onClosePromptHelper,
  onUsePromptHelperResult,
  // ---- model ----
  runOn,
  // ---- starters ----
  // The selected local workflow, or null on a cloud model — what the shipped
  // shelf is filtered by. A cloud model has no image starters written for it,
  // so null is an ordinary answer and the section simply does not draw.
  starterModel,
  captureContext,
  onRestoreContext,
  onApplyStarterSetup,
  onApplyUgc,
  ugcArmed,
  // ---- camera rig (the folded Cinema studio) ----
  cameraRig,
  cameraArmed,
  cameraMenuOpen,
  onCameraMenuOpenChange,
  onCameraChange,
  onArmCamera,
  ugcVerticalAvailable,
  // ---- the recipe line's settings ----
  // These are the SAME values the Advanced drawer renders, computed once in the
  // studio's render and handed to both surfaces. The token writes through the
  // studio's own handler so a shortcut can never diverge from the drawer.
  aspectRatios,
  customDimsActive,
  resolvedDims,
  referenceDrivesAspect,
  stylePresets,
  onSelectAspect,
  onSelectStyle,
  onSelectBatch,
  // ---- the drawer ----
  advancedOpen,
  onToggleAdvanced,
  // ---- generate ----
  coupleOn,
  promptPlaceholder,
  generateLabel,
  generateBlocked,
  generateTitle,
  etaLabel,
  onGenerate,
  onCancel,
  onNewPrompt,
  onClearPrompt,
}) {
  const enhanced = [s.enhanceBase.trim(), Array.from(s.enhanceTags).join(', ')].filter(Boolean).join(', ');
  // The helper doors are disabled on an empty box — the tooltip says why.
  const helperDisabledTitle = t('composer.improveDisabled');
  const hasPrompt = Boolean(s.prompt.trim());
  const ugcNextIndex = Number.isInteger(s.ugcVariantIndex) ? s.ugcVariantIndex + 1 : 0;
  const ugcCast = ugcVariantAt(ugcArmed ? s.ugcVariantIndex : ugcNextIndex);
  // The Starters popover is loaded on demand (see SavedPromptsMenuLazy): this
  // holds its open state so the placeholder door's click both arms the import
  // and opens the menu it turns into.
  const [startersOpen, setStartersOpen] = useState(false);
  const startersChip = {
    icon: 'folder',
    label: t('composer.starters'),
    title: t('composer.startersTitle'),
  };

  /* ---------------- the recipe line's values ---------------- */

  // The batch reaches the LOCAL payload only — a cloud model makes one picture
  // per press — so on the cloud source the token reads 1 and refuses, with the
  // reason in its tooltip, rather than disappearing and taking the sentence's
  // shape with it.
  const batchCount = Math.max(1, Math.min(4, Number(s.batchCount) || 1));
  const styleOn = Boolean(s.selectedStyle) && s.selectedStyle !== 'None';
  // Edit workflows take their aspect from the reference on the server, so the
  // preset would be a lie while one is attached (same rule the panel applies).
  const aspectValue = referenceDrivesAspect
    ? 'the reference aspect'
    : customDimsActive
      ? `${s.customWidth || '?'}×${s.customHeight || '?'}`
      : s.selectedAr;
  const aspectTitle = referenceDrivesAspect
    ? t('imagePanel.aspectFromReference')
    : resolvedDims
      ? `${resolvedDims.width} × ${resolvedDims.height}`
      : t('imagePanel.aspectRatio');
  const referenceValue = refCount === 0
    ? 'no references'
    : refCount === 1 ? '1 reference' : `${refCount} references`;
  // "~14s · free". Both halves already exist: the eta from this setup's own past
  // runs, and the note runOnReadout writes for the picker ("free, stays here",
  // "$0.42/hr") — trimmed to its first clause so a mono readout can hold it.
  const runOnShown = runOn.isAutomatic ? (runOn.automatic?.target || runOn.value) : runOn.value;
  const runCost = String(runOnReadout(runOnShown).note || '').split(',')[0].trim();
  const metaLabel = etaLabel ? `~${etaLabel}${runCost ? ` · ${runCost}` : ''}` : '';

  // The two actions that belong to references once some are attached: "who is
  // who" and "remove all". Rendered in the attach door's own panel (where they
  // have always lived) AND behind the sentence's references token, which is the
  // shortcut to the same two handlers — one function so they cannot drift.
  const referenceActions = () => (
    <>
      {refsIgnored ? (
        <p className="text-[11px] leading-relaxed text-ink3">
          This model does not read reference pictures — they stay attached but are not sent.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {refsSupported ? (
          <ReferenceRolesMenu
            count={refCount}
            roles={s.referenceRoles}
            labelStyle={referenceLabelStyle}
            onApply={onApplyRoles}
          />
        ) : null}
        <Button
          size="sm"
          variant="neutral"
          onClick={onClearReferences}
          title={t('composer.clearReferencesTitle')}
        >
          {t('common.clearReferences')}
        </Button>
      </div>
    </>
  );

  const recipeParts = [
    { text: 'Make' },
    {
      key: 'batch',
      value: batchCount === 1 ? '1 image' : `${batchCount} images`,
      disabled: !s.useLocalModel,
      title: s.useLocalModel ? t('imagePanel.howMany') : 'This model makes one picture at a time.',
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <DrawerChoice
            options={[1, 2, 3, 4]}
            value={batchCount}
            onChange={(v) => onSelectBatch(Number(v) || 1)}
            ariaLabel={t('imagePanel.howMany')}
          />
          <p className="text-[11px] leading-relaxed text-ink3">{t('imagePanel.howManyHint')}</p>
        </div>
      ),
    },
    { text: 'at' },
    {
      key: 'aspect',
      value: aspectValue,
      disabled: referenceDrivesAspect,
      title: aspectTitle,
      menuWidth: 'w-[19rem]',
      // No menu while the reference owns the aspect: the token reads the truth
      // and refuses, exactly as the panel's read-only box does.
      menu: referenceDrivesAspect ? undefined : () => (
        <div className="flex flex-col gap-2.5 px-1 py-0.5">
          <AspectRatioPicker
            columns={3}
            options={aspectRatios}
            value={customDimsActive ? 'custom' : s.selectedAr}
            onChange={onSelectAspect}
            nameFor={aspectRatioName}
            custom={s.useLocalModel ? {
              name: t('ar.custom'),
              detail: (s.customWidth && s.customHeight) ? `${s.customWidth}×${s.customHeight}` : 'W×H',
            } : null}
          />
          {customDimsActive ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-ink3">
                {t('image.width')}
                <TextInput
                  type="number"
                  className="font-mono"
                  placeholder={t('common.auto')}
                  value={s.customWidth ? String(s.customWidth) : ''}
                  onChange={(e) => { s.customWidth = parseInt(e.target.value, 10) || 0; persist(); bump(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-ink3">
                {t('image.height')}
                <TextInput
                  type="number"
                  className="font-mono"
                  placeholder={t('common.auto')}
                  value={s.customHeight ? String(s.customHeight) : ''}
                  onChange={(e) => { s.customHeight = parseInt(e.target.value, 10) || 0; persist(); bump(); }}
                />
              </label>
            </div>
          ) : null}
        </div>
      ),
    },
    { text: 'in' },
    {
      key: 'style',
      value: styleOn ? s.selectedStyle : 'no style',
      tone: styleOn ? 'honey' : 'neutral',
      title: t('image.stylePreset'),
      menu: (close) => (
        <div className="flex flex-wrap gap-1.5 px-1 py-0.5" role="group" aria-label={t('image.stylePreset')}>
          {(stylePresets || []).map((preset) => {
            const on = s.selectedStyle === preset;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={on}
                onClick={() => { onSelectStyle(preset); close(); }}
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
      ),
    },
    { text: 'with' },
    {
      key: 'references',
      value: referenceValue,
      // Struck through when the model reads none: they stay attached, they are
      // simply not sent, and the token is still pressable — that is how you
      // remove them.
      tone: refsIgnored ? 'muted' : 'neutral',
      disabled: refCount === 0,
      title: refCount === 0
        ? 'Attach pictures with the upload door, or drop them on the composer'
        : t('composer.clearReferencesTitle'),
      menu: refCount === 0 ? undefined : () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">{referenceActions()}</div>
      ),
    },
    { text: 'on' },
    {
      key: 'runOn',
      // Where it runs and on what, in the sentence. The same control and the
      // same list as the drawer's — a second model menu with its own vocabulary
      // is what this replaced.
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
          page="image"
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
      {s.promptHelper.open ? (
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel className="text-honey">{s.promptHelper.title || t('image.promptHelper')}</SectionLabel>
            <IconButton icon="x" label={t('composer.dismissHelper')} size="sm" onClick={() => { onClosePromptHelper(); bump(); }} />
          </div>
          <TextArea
            rows={4}
            disabled={s.promptHelper.busy}
            value={s.promptHelper.result}
            onChange={(e) => { s.promptHelper = { ...s.promptHelper, result: e.target.value }; bump(); }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-ink3" role="status" aria-live="polite">
              {s.promptHelper.status}
            </span>
            <Button size="sm" variant="primary" disabled={!s.promptHelper.ready} onClick={onUsePromptHelperResult}>
              Use prompt
            </Button>
          </div>
        </Card>
      ) : null}

      {s.enhancerOpen ? (
        <Card className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>{t('image.promptEnhancer')}</SectionLabel>
            <IconButton icon="x" label={t('common.less')} size="sm" onClick={() => { s.enhancerOpen = false; bump(); }} />
          </div>
          <TextInput
            placeholder={t('image.basePromptPlaceholder')}
            value={s.enhanceBase}
            onChange={(e) => { s.enhanceBase = e.target.value; bump(); }}
          />
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{t('image.enhancementTags')}</span>
            {Object.entries(ENHANCE_TAGS).map(([category, tags]) => (
              <div key={category} className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{category}</span>
                {tags.map((tag) => {
                  const on = s.enhanceTags.has(tag);
                  // Multi-select toggle pills: ChipButton's active tokens, the
                  // Pill's size, aria-pressed so a reader hears the state.
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-tag={tag}
                      aria-pressed={on}
                      onClick={() => {
                        if (on) s.enhanceTags.delete(tag); else s.enhanceTags.add(tag);
                        bump();
                      }}
                      className={cx(
                        'inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors duration-150',
                        on ? 'border-honey/50 bg-honey-tint text-honey' : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
                      )}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{t('image.enhancedPrompt')}</span>
            <div className={cx('min-h-[40px] rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs leading-relaxed', enhanced ? 'text-ink1' : 'text-ink3')}>
              {enhanced || t('image.enhancedPlaceholder')}
            </div>
            {/* One action. The old copy-to-clipboard door asked the user to
                paste back into the box they were already looking at. */}
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={!enhanced} onClick={() => {
                if (!enhanced) return;
                setPromptValue(enhanced);
                s.enhancerOpen = false;
                bump();
              }}>
                {t('common.useInGenerator')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );

  /* ---------------- the action row's doors ---------------- */

  const tools = (
    <>
      {/* Attach. The picker keeps its own trigger because it is more than a
          door: it carries the attached thumbnails, its own file input, its own
          drop target and the `data-upload-picker` attribute the frame's drop
          guard checks so a picture is never attached twice. It has to stay
          MOUNTED for that guard to see it, which is why it is here rather than
          inside a popover. "Who is who" and "remove all" ride in its footer,
          where they have always lived. */}
      <UploadPicker
        values={s.uploadedImageUrls}
        onChange={onPickerChange}
        uploadFn={uploadFn}
        requireApiKey={requireApiKey}
        maxImages={s.maxImages}
        accept="image/*"
        disabled={!refsSupported}
        ignored={refsIgnored}
        label={t('composer.attach')}
        footer={refCount > 0 ? referenceActions() : null}
      />

      {/* Improve: one door for "make my prompt better", with the three routes
          inside it instead of three chips that all say the same. */}
      <Menu
        up
        width="w-64"
        trigger={(open, toggle) => (
          <ComposerTool
            icon="wand"
            label={t('composer.improve')}
            active={open}
            onClick={toggle}
          />
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon="sparkles"
              disabled={!hasPrompt}
              title={hasPrompt ? undefined : helperDisabledTitle}
              onClick={() => { s.localPromptHelperOpen = true; bump(); close(); }}
            >
              Refine with the prompt helper
            </MenuItem>
            {helper ? (
              <MenuItem
                icon="wand"
                disabled={s.promptHelper.busy || !hasPrompt}
                title={hasPrompt ? undefined : helperDisabledTitle}
                onClick={() => { onRunWorkflowHelper(); close(); }}
              >
                {helper.label || "This model's own helper"}
              </MenuItem>
            ) : null}
            <MenuItem icon="plus" onClick={() => { s.enhancerOpen = true; bump(); close(); }}>
              Add style tags
            </MenuItem>
          </>
        )}
      </Menu>

      {/* Starters: quick prompts, the UGC block and the saved library are
          sections of ONE menu — and the library is the heaviest thing on this
          page while the menu is shut on arrival, so it loads on the press. The
          chip below stands in until then and looks identical, so the row never
          moves. It keeps SavedPromptsMenu's own trigger: that component is
          shared with the Video composer and draws its anchor itself. */}
      {startersOpen ? (
        <Suspense fallback={<ChipButton {...startersChip} active disabled />}>
          <SavedPromptsMenuLazy
            open={startersOpen}
            onOpenChange={setStartersOpen}
            section="image"
            prompt={s.prompt}
            negativePrompt={s.negativePrompt}
            modelSource={starterModel}
            chip={startersChip}
            extraSections={(close) => (
              <>
                <MenuHeading>{t('image.quickStarters')}</MenuHeading>
                {QUICK_PROMPTS.map((q) => (
                  <MenuItem key={q.label} onClick={() => { setPromptValue(q.prompt); close(); }}>
                    {q.label}
                  </MenuItem>
                ))}
                <MenuHeading>UGC first frame</MenuHeading>
                <MenuItem
                  icon="persona"
                  meta={ugcVerticalAvailable ? 'also sets 9:16' : 'no 9:16 here'}
                  onClick={() => { onApplyUgc(ugcNextIndex); close(); }}
                  title={`${ugcCast.person} — ${ugcCast.room.place}, ${ugcCast.room.light}`}
                >
                  {ugcArmed
                    ? 'Deal a new cast'
                    : 'Turn on UGC mode'}
                </MenuItem>
                {ugcArmed ? (
                  <MenuItem icon="x" onClick={() => { onApplyUgc(null); close(); }}>
                    Turn off UGC mode
                  </MenuItem>
                ) : null}
                <div className="my-1 h-px bg-line1" />
              </>
            )}
            capture={captureContext}
            onLoadPrompt={({ prompt, negativePrompt, setup }) => {
              setPromptValue(prompt);
              s.negativePrompt = negativePrompt;
              // A shipped image starter is a recipe, not just words: the studio
              // applies the settings it was written at before the prompt is
              // anything worth pressing Generate on.
              onApplyStarterSetup?.(setup);
              persist();
              bump();
              promptRef.current?.focus();
            }}
            onLoadContext={onRestoreContext}
          />
        </Suspense>
      ) : (
        <ChipButton
          {...startersChip}
          onClick={() => setStartersOpen(true)}
          // Warmed on hover so the chunk is usually already there by the time
          // the click lands.
          onPointerEnter={() => { void import('../SavedPromptsMenu.jsx'); }}
        />
      )}

      {/* More: the doors the design's three do not draw. Start fresh is how you
          begin the next image (not something you do to the last one), the camera
          rig is what used to be the Cinema studio, the prompt library came in
          from the retired topbar, and the completion chime is one app-wide value
          that belongs where its outcome is felt rather than at the bottom of a
          tuning panel.
          17rem rather than the old w-60: the library's row is the longest label
          in here, and it lost its last word to the ellipsis as soon as the
          selected check took 24px off the line. */}
      <Menu
        up
        width="w-[17rem]"
        align="end"
        trigger={(open, toggle) => (
          <ComposerTool
            icon="more"
            label="More"
            active={open || cameraArmed}
            onClick={toggle}
          />
        )}
      >
        {(close) => (
          <>
            {/* The prompt library reads first: like the starters door it writes
                the box, where the two below it change what the next press does.
                It kept its own toggle semantics, so it does not close(). */}
            <ExploreDockItem />
            <MenuItem
              icon="camera"
              meta={cameraArmed ? `${cameraRig.focal}mm · ${cameraRig.aperture}` : ''}
              onClick={() => { onCameraMenuOpenChange(true); close(); }}
              title="Writes the body, lens, focal length and aperture into the prompt as one camera sentence"
            >
              {t('composer.camera')}
            </MenuItem>
            <div className="flex items-center justify-between gap-3 px-2 py-1">
              <span className="text-[13px] text-ink2">{t('common.pingWhenComplete')}</span>
              <CompletionPingToggle />
            </div>
            {/* Last, under a rule of its own: everything above this line changes
                what the NEXT press does, and this one throws away what is on
                screen. It sat between the camera rig and the chime, read as a
                third setting, and got pressed by people who wanted an empty
                prompt — which is now a badge in the box's corner. The studio
                asks before it does anything. */}
            <div className="my-1 h-px bg-line1" />
            <MenuItem icon="x" onClick={() => { onNewPrompt(); close(); }}>
              {t('common.startFresh')}
            </MenuItem>
          </>
        )}
      </Menu>

      {/* The camera rig's own popover, anchored where the "more" menu's Camera
          item sat. Mounted only while it is open — the studio owns that flag, so
          ?page=cinema still routes straight into it (takeComposerMenuRequest)
          without the menu having to be on screen first. */}
      {cameraMenuOpen ? (
        <CameraMenu
          rig={cameraRig}
          active={cameraArmed}
          open={cameraMenuOpen}
          onOpenChange={onCameraMenuOpenChange}
          onChange={onCameraChange}
          onArm={onArmCamera}
        />
      ) : null}
    </>
  );

  return (
    <ComposerPanel
      above={above}
      prompt={coupleOn ? (
        <div className="flex items-center gap-2 py-1 text-[13px] text-ink2">
          <Icon name="info" size={14} className="shrink-0 text-ink3" />
          Couple mode is on — set the character prompts in the settings panel; they compose into one generation.
        </div>
      ) : (
        <ComposerPrompt
          inputRef={promptRef}
          placeholder={promptPlaceholder}
          value={s.prompt}
          onChange={(e) => setPromptValue(e.target.value)}
          // The small door, in the box's own corner: empties this box and
          // nothing else. Start fresh (in `more`) is the big one.
          onClear={onClearPrompt}
          // Cmd/Ctrl+Enter generates, same guards as the button.
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (!s.generating && !generateBlocked) onGenerate();
            }
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
      meta={!s.generating && metaLabel ? (
        <ComposerMeta title={t('composer.etaTitle')}>{metaLabel}</ComposerMeta>
      ) : null}
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
