// The Image studio's composer — prompt box, five chips, Generate.
//
// Lifted out of ImageStudio.jsx and collapsed from nine chips to five, because a
// prompt bar that reads as a toolbar stops reading as a prompt bar:
//
//   Attach      — the picker, its thumbnails, "who is who" and "remove all"
//   Starters    — quick starters, the UGC block and the saved-prompt library
//   Improve     — Refine, the workflow's own helper, and the style-tag card
//   Start fresh
//   Model       — a readout that also changes the model without opening the panel
//
// Presentational: it reads and writes the caller's mutable engine object and
// calls `bump()`, exactly as the studio did inline.
import { ENHANCE_TAGS, QUICK_PROMPTS } from '../../lib/promptUtils.js';
import { t, zh } from '../../lib/i18n.js';
import { ugcVariantAt } from '../../lib/ugcMode.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, Card, IconButton, SectionLabel, TextArea, TextInput, cx } from '../../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { CompletionPingToggle } from '../../ui/CompletionPingToggle.jsx';
import { UploadPicker } from '../UploadPicker.jsx';
import { SavedPromptsMenu } from '../SavedPromptsMenu.jsx';
import { CameraMenu } from './CameraMenu.jsx';
import { ReferenceRolesMenu } from './ReferenceRolesMenu.jsx';
import { ModelMenu } from './ImageModelMenu.jsx';


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
  modelLabel,
  onSelectLocalModel,
  onSelectApiModel,
  // ---- starters ----
  captureContext,
  onRestoreContext,
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
}) {
  const enhanced = [s.enhanceBase.trim(), Array.from(s.enhanceTags).join(', ')].filter(Boolean).join(', ');
  // The helper doors are disabled on an empty box — the tooltip says why.
  const helperDisabledTitle = zh()
    ? '先在下方输入一个想法，再让助手润色'
    : 'Type an idea below first — the helper refines what is in the box';
  const hasPrompt = Boolean(s.prompt.trim());
  const ugcNextIndex = Number.isInteger(s.ugcVariantIndex) ? s.ugcVariantIndex + 1 : 0;
  const ugcCast = ugcVariantAt(ugcArmed ? s.ugcVariantIndex : ugcNextIndex);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      {s.promptHelper.open ? (
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel className="text-honey">{s.promptHelper.title || 'Prompt helper'}</SectionLabel>
            <IconButton icon="x" label="Dismiss prompt helper" size="sm" onClick={() => { onClosePromptHelper(); bump(); }} />
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

      <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg1 p-2.5 transition-colors focus-within:border-honey/40">
        {coupleOn ? (
          <div className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-ink2">
            <Icon name="info" size={14} className="shrink-0 text-ink3" />
            Couple mode is on — set the character prompts in the settings panel; they compose into one generation.
          </div>
        ) : (
          <textarea
            ref={promptRef}
            rows={1}
            placeholder={promptPlaceholder}
            value={s.prompt}
            onChange={(e) => setPromptValue(e.target.value)}
            // Cmd/Ctrl+Enter generates, same guards as the button.
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (!s.generating && !generateBlocked) onGenerate();
              }
            }}
            className="max-h-[150px] min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 pt-1 text-[15px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 md:max-h-[250px]"
          />
        )}

        {/* Five chips, then Generate pinned at the right/bottom in its own group
            instead of wrapping into the chip flow. */}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {/* Attach: the picker, its thumbnails, the roles menu and "remove
                all" are one door — three chips for one idea was the bug. */}
            <UploadPicker
              values={s.uploadedImageUrls}
              onChange={onPickerChange}
              uploadFn={uploadFn}
              requireApiKey={requireApiKey}
              maxImages={s.maxImages}
              accept="image/*"
              disabled={!refsSupported}
              ignored={refsIgnored}
              label={zh() ? '附加' : 'Attach'}
              footer={refCount > 0 ? (
                <>
                  {refsIgnored ? (
                    <p className="text-[11px] leading-relaxed text-ink3">
                      {zh()
                        ? '当前模型不读取参考图——它们仍会保留，但不会发送。'
                        : 'This model does not read reference pictures — they stay attached but are not sent.'}
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
                      title={zh() ? '移除全部参考图' : 'Remove every attached reference'}
                    >
                      {t('common.clearReferences')}
                    </Button>
                  </div>
                </>
              ) : null}
            />

            {/* Starters: quick prompts, the UGC block and the saved library are
                sections of ONE menu. */}
            <SavedPromptsMenu
              section="image"
              prompt={s.prompt}
              negativePrompt={s.negativePrompt}
              chip={{
                icon: 'sparkles',
                label: zh() ? '起点' : 'Starters',
                title: zh() ? '快速起点、UGC 段落与已保存提示词' : 'Quick starters, the UGC block, and your saved prompts',
              }}
              extraSections={(close) => (
                <>
                  <MenuHeading>{t('image.quickStarters')}</MenuHeading>
                  {QUICK_PROMPTS.map((q) => (
                    <MenuItem key={q.label} onClick={() => { setPromptValue(q.prompt); close(); }}>
                      {q.label}
                    </MenuItem>
                  ))}
                  <MenuHeading>{zh() ? 'UGC 首帧' : 'UGC first frame'}</MenuHeading>
                  <MenuItem
                    icon="persona"
                    meta={ugcVerticalAvailable ? 'also sets 9:16' : 'no 9:16 here'}
                    onClick={() => { onApplyUgc(ugcNextIndex); close(); }}
                    title={`${ugcCast.person} — ${ugcCast.room.place}, ${ugcCast.room.light}`}
                  >
                    {ugcArmed
                      ? (zh() ? '换一组阵容' : 'Deal a new cast')
                      : (zh() ? '开启 UGC 模式' : 'Turn on UGC mode')}
                  </MenuItem>
                  {ugcArmed ? (
                    <MenuItem icon="x" onClick={() => { onApplyUgc(null); close(); }}>
                      {zh() ? '关闭 UGC 模式' : 'Turn off UGC mode'}
                    </MenuItem>
                  ) : null}
                  <div className="my-1 h-px bg-line1" />
                </>
              )}
              capture={captureContext}
              onLoadPrompt={({ prompt, negativePrompt }) => {
                setPromptValue(prompt);
                s.negativePrompt = negativePrompt;
                persist();
                bump();
                promptRef.current?.focus();
              }}
              onLoadContext={onRestoreContext}
            />

            {/* Improve: one door for "make my prompt better", with the three
                routes inside it instead of three chips that all say the same. */}
            <Menu
              up
              width="w-64"
              trigger={(open, toggle) => (
                <ChipButton
                  icon="wand"
                  label={zh() ? '润色' : 'Improve'}
                  active={open}
                  onClick={toggle}
                  title={zh() ? '润色提示词，或加上风格标签' : 'Refine the prompt, or add style tags'}
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
                    {zh() ? '用提示助手润色' : 'Refine with the prompt helper'}
                  </MenuItem>
                  {helper ? (
                    <MenuItem
                      icon="wand"
                      disabled={s.promptHelper.busy || !hasPrompt}
                      title={hasPrompt ? undefined : helperDisabledTitle}
                      onClick={() => { onRunWorkflowHelper(); close(); }}
                    >
                      {helper.label || (zh() ? '工作流助手' : "This model's own helper")}
                    </MenuItem>
                  ) : null}
                  <MenuItem icon="plus" onClick={() => { s.enhancerOpen = true; bump(); close(); }}>
                    {zh() ? '添加风格标签' : 'Add style tags'}
                  </MenuItem>
                </>
              )}
            </Menu>

            {/* The camera rig, which used to be a studio of its own. It writes one
                sentence into the prompt and replaces it rather than stacking, so
                arming it twice does not compound. */}
            <CameraMenu
              rig={cameraRig}
              active={cameraArmed}
              open={cameraMenuOpen}
              onOpenChange={onCameraMenuOpenChange}
              onChange={onCameraChange}
              onArm={onArmCamera}
            />

            {/* Starting over lives here rather than in the result viewer: it is how
                you begin the next image, not something you do to the last one. */}
            <ChipButton
              icon="x"
              label={t('common.startFresh')}
              chevron={false}
              onClick={onNewPrompt}
            />

            {/* The model reads out here too, so it can be changed on a narrow
                window without opening the settings panel. */}
            <ModelMenu
              engine={s}
              modelLabel={modelLabel}
              hasRefs={refCount > 0}
              onSelectLocal={onSelectLocalModel}
              onSelectApi={onSelectApiModel}
              className=""
            />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* The chime belongs where its outcome is felt, not at the bottom of
                a tuning panel — and it is one app-wide value, not a per-studio one. */}
            {!s.generating && etaLabel ? (
              <span className="hidden text-[11px] text-ink3 sm:inline" title="Estimated from your own past runs at these settings">
                {zh() ? `约 ${etaLabel}` : `~${etaLabel}`}
              </span>
            ) : null}
            <CompletionPingToggle />
            <Button
              variant="primary"
              size="lg"
              loading={s.generating}
              disabled={generateBlocked}
              onClick={onGenerate}
              title={generateTitle}
              className="min-w-[130px]"
            >
              {generateLabel}
            </Button>
            {s.generating ? (
              <Button
                variant="danger"
                size="lg"
                onClick={onCancel}
                title={zh() ? '取消当前生成并重置状态' : 'Cancel the current generation and reset'}
                className="min-w-[100px]"
              >
                {t('common.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
