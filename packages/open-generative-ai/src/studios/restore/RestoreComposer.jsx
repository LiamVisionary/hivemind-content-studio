// The Restore studio's composer — the insides of the frame's one floating panel.
//
// Restore has no prompt, so the row where the prompt goes carries the thing a
// restoration is actually about: THE CLIP. Loading one, seeing what was
// measured out of it, and swapping it are all that row, in the same place and
// at the same size as the sentence you type in the other two studios.
//
// Under it, the settings people actually change, written as a sentence:
//
//   Restore [14 chunks] at [2K] with [7B FP8] on [This Mac]. Test from [3.5s].
//
// Each underlined value opens the SAME control the Advanced drawer renders,
// writing through the same handler, so a shortcut cannot diverge from the
// drawer — the drawer stays the complete surface and this is four of its dials.
//
// TWO PRESSES, and the quieter one is the one to reach for first. A full render
// is tens of minutes to hours; a two-second test is one chunk. That trade is
// the reason this studio exists in the shape it does, so the test is a real
// button beside Restore (ComposerAlternate) rather than an item in a menu.
//
// The panel chrome — radius, blur, shadow, the drop ring and the
// `data-studio-composer` wire contract — belongs to StudioFrame's ComposerFloat.
// This file draws what goes inside it.
//
// Presentational: every value it reads is the studio's own state and every
// write goes back through the studio's own setters. No upload, poll, plan or
// spend logic lives here.
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { Slider, cx } from '../../ui/kit.jsx';
import { CompletionPingToggle } from '../../ui/CompletionPingToggle.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { t } from '../../lib/i18n.js';
import {
  RESOLUTION_PRESETS, RESTORE_MODELS, describeChunkPlan,
} from '../../lib/videoRestore.js';
import { DrawerChoice } from '../frame/AdvancedDrawer.jsx';
import { PROJECT_WORDS } from './RestoreRail.jsx';
import {
  ComposerAlternate, ComposerMeta, ComposerPanel, ComposerPrimary, ComposerSecondary, ComposerTool,
} from '../frame/ComposerPanel.jsx';
import { RecipeLine } from '../frame/RecipeLine.jsx';

/**
 * The subject row: what is being restored.
 *
 * A label wrapping a hidden file input, so the whole row is the door — the same
 * affordance the prompt box has, where clicking anywhere in it starts the work.
 */
function ClipRow({ clipName, clipDetail, disabled, onPick, onDetach }) {
  return (
    <div className="flex items-center gap-2">
      <label
        className={cx(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-1 py-0.5 transition-colors hover:bg-white/[0.04]',
          disabled && 'pointer-events-none opacity-50',
        )}
        title={clipName ? 'Load a different clip' : 'Load a clip'}
      >
        <input
          type="file"
          accept="video/*"
          className="hidden"
          disabled={disabled}
          onChange={(event) => { onPick(event.target.files?.[0]); event.target.value = ''; }}
        />
        <Icon name={clipName ? 'film' : 'upload'} size={16} className="shrink-0 text-inkSoft" />
        <span className="flex min-w-0 flex-col">
          <span className={cx('truncate text-[16px] leading-[1.4]', clipName ? 'text-ink1' : 'text-ink3')}>
            {clipName || 'Load a clip'}
          </span>
          {clipDetail ? (
            <span className="truncate font-mono text-[10.5px] text-inkSoft">{clipDetail}</span>
          ) : null}
        </span>
      </label>
      {/* Outside the label on purpose: a button inside it would open the file
          picker on its way to detaching. */}
      {onDetach ? (
        <button
          type="button"
          onClick={onDetach}
          title="Take this clip off the stage"
          aria-label="Take this clip off the stage"
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-white/5 text-ink3 transition-colors hover:bg-white/10 hover:text-ink1"
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The list inside the `more` door.
 *
 * Exported so it can be rendered on its own: a Menu's children are a function
 * the panel calls only while it is OPEN, so a shut menu proves nothing about
 * what is inside it — and what is inside this one is the only route back into a
 * past render on a window too narrow for the rail.
 */
export function ProjectDoorItems({ projects = [], activeProjectId = '', onOpenProject, close = () => {} }) {
  if (!onOpenProject || !projects.length) return null;
  return (
    <>
      <MenuHeading>Projects</MenuHeading>
      {projects.map((project) => {
        const done = project.progress?.chunks_done ?? 0;
        const total = project.progress?.chunks_total ?? 0;
        return (
          <MenuItem
            key={project.id}
            icon={project.preview ? 'eye' : 'film'}
            selected={project.id === activeProjectId}
            meta={total ? `${done}/${total}` : ''}
            onClick={() => { onOpenProject(project); close(); }}
          >
            {`${project.width}x${project.height} — ${PROJECT_WORDS[project.status] || project.status}`}
          </MenuItem>
        );
      })}
      <div className="my-1 h-px bg-line1" />
    </>
  );
}

/**
 * RestoreComposer
 *
 * @param {string} clipName    the file's name, or the reopened project's identity
 * @param {string} clipDetail  the measured source line ("1920x1080 · 487 frames · 23.98fps")
 * @param {func}   onPickClip  (File) => …
 * @param {func=}  onDetachClip
 * @param {object} settings    RESTORE_DEFAULTS-shaped; written through onChangeSettings
 * @param {object} plan        planRestore(...) — what the chunk token reads
 * @param {number} previewAt   seconds; where the two-second test starts
 * @param {number} previewMax  the last second a test can start at
 * @param {object} runOn       { targets, value, onChange, readinessFor, onFixReadiness }
 * @param {object} primary     { label, onClick, loading, disabled, title }
 * @param {object=} alternate  the quieter press (the test), or null
 * @param {func=}  onStop      offered only while a render is out
 * @param {string} billLabel   the mono readout before the press ("62¢", "free")
 */
export function RestoreComposer({
  clipName = '',
  clipDetail = '',
  onPickClip,
  onDetachClip = null,
  clipDisabled = false,

  settings,
  onChangeSettings,
  plan = null,
  previewSeconds = 2,
  previewAt = 0,
  previewMax = 0,
  onPreviewAt,

  runOn,

  advancedOpen = false,
  onToggleAdvanced,

  primary,
  alternate = null,
  onStop = null,
  billLabel = '',
  billTitle = '',

  // Past renders, and the one door to them that survives a narrow window: the
  // rail is `hidden sm:flex`, so below 640px it is not on screen at all and
  // this menu is the only way back into a project. Listed at every width for
  // that reason — a door that only exists at one size is a door nobody learns.
  projects = [],
  activeProjectId = '',
  onOpenProject = null,
}) {
  const set = (key) => (value) => onChangeSettings({ ...settings, [key]: value });
  const model = RESTORE_MODELS.find((item) => item.id === settings.model) || RESTORE_MODELS[2];
  const resolution = RESOLUTION_PRESETS.find((item) => item.id === settings.resolution) || RESOLUTION_PRESETS[0];
  const chunks = plan?.chunks?.length || 0;
  // The test marker is only a decision while there is footage to pick a moment
  // out of, and only while nothing is rendering.
  const canTest = Boolean(alternate) && previewMax > 0;

  const recipeParts = [
    { text: 'Restore' },
    {
      key: 'chunks',
      value: chunks ? `${chunks} chunk${chunks === 1 ? '' : 's'}` : 'this clip',
      disabled: !chunks,
      title: chunks ? describeChunkPlan(plan) : 'Load a clip to see how the render is cut up',
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <p className="text-[11px] leading-relaxed text-ink3">{describeChunkPlan(plan)}</p>
          <label className="flex flex-col gap-1 text-[11px] text-ink3">
            {t('restorePanel.chunkLength')}
            <Slider
              value={settings.chunkSeconds}
              min={1}
              max={20}
              step={0.5}
              onChange={set('chunkSeconds')}
              format={(value) => `${value}s`}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink3">{t('restorePanel.chunkLengthHint')}</p>
        </div>
      ),
    },
    { text: 'at' },
    {
      key: 'resolution',
      value: resolution.label,
      title: resolution.hint,
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <DrawerChoice
            options={RESOLUTION_PRESETS.map((item) => ({ value: item.id, label: item.label }))}
            value={settings.resolution}
            onChange={set('resolution')}
            ariaLabel={t('restorePanel.output')}
          />
          <p className="text-[11px] leading-relaxed text-ink3">{resolution.hint}</p>
        </div>
      ),
    },
    { text: 'with' },
    {
      key: 'model',
      value: model.label,
      title: model.hint,
      menuWidth: 'w-[21rem]',
      menu: (close) => (
        <>
          {RESTORE_MODELS.map((item) => (
            <MenuItem
              key={item.id}
              meta={item.size}
              selected={item.id === settings.model}
              title={item.hint}
              onClick={() => { set('model')(item.id); close(); }}
            >
              {item.label}
            </MenuItem>
          ))}
          <p className="px-2.5 pb-1 pt-2 text-[11px] leading-relaxed text-ink3">
            {t('restorePanel.firstChunkDownload')}
          </p>
        </>
      ),
    },
    { text: 'on' },
    {
      key: 'runOn',
      // Where it runs and what it costs, in the sentence. The same control and
      // the same list as the drawer's.
      node: (
        <RunOnPicker
          bare
          searchable={false}
          targets={runOn.targets}
          value={runOn.value}
          onChange={runOn.onChange}
          readinessFor={runOn.readinessFor}
          onFixReadiness={runOn.onFixReadiness}
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
    // The test's starting point. A second sentence rather than a clause, so the
    // first one still reads as the render it describes.
    canTest ? { text: `Test ${previewSeconds}s from` } : null,
    canTest ? {
      key: 'previewAt',
      value: `${previewAt.toFixed(1)}s`,
      tone: previewAt > 0 ? 'honey' : 'neutral',
      title: 'Pick a shot with motion and detail — a static frame tells you very little',
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <Slider
            value={previewAt}
            min={0}
            max={previewMax}
            step={0.5}
            onChange={onPreviewAt}
            format={(value) => `${value.toFixed(1)}s`}
          />
          <p className="text-[11px] leading-relaxed text-ink3">
            Pick a shot with motion and detail — a static frame tells you very little.
          </p>
        </div>
      ),
    } : null,
    canTest ? { text: '.' } : null,
  ];

  const tools = (
    <Menu
      up
      width="w-[17rem]"
      trigger={(open, toggle) => (
        <ComposerTool icon="more" label="More" active={open} onClick={toggle} />
      )}
    >
      {(close) => (
        <>
          <ProjectDoorItems
            projects={projects}
            activeProjectId={activeProjectId}
            onOpenProject={onOpenProject}
            close={close}
          />
          {/* A restore is the longest wait in the app — hours, not seconds — so
              the chime belongs where its outcome is felt rather than at the
              bottom of a tuning panel. */}
          <div className="flex items-center justify-between gap-3 px-2 py-1">
            <span className="text-[13px] text-ink2">{t('common.pingWhenComplete')}</span>
            <CompletionPingToggle />
          </div>
          {onDetachClip ? (
            <>
              <div className="my-1 h-px bg-line1" />
              <MenuItem icon="x" onClick={() => { onDetachClip(); close(); }}>
                Take this clip off the stage
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
  );

  return (
    <ComposerPanel
      prompt={(
        <ClipRow
          clipName={clipName}
          clipDetail={clipDetail}
          disabled={clipDisabled}
          onPick={onPickClip}
          onDetach={onDetachClip}
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
      meta={billLabel ? <ComposerMeta title={billTitle}>{billLabel}</ComposerMeta> : null}
      secondary={onStop ? (
        <ComposerSecondary onClick={onStop} title="Stop after the chunk in flight — everything already finished is kept">
          Stop
        </ComposerSecondary>
      ) : (alternate ? (
        <ComposerAlternate
          onClick={alternate.onClick}
          loading={alternate.loading}
          disabled={alternate.disabled}
          title={alternate.title}
        >
          {alternate.label}
        </ComposerAlternate>
      ) : null)}
      primary={(
        <ComposerPrimary
          loading={primary.loading}
          disabled={primary.disabled}
          onClick={primary.onClick}
          title={primary.title}
        >
          {primary.label}
        </ComposerPrimary>
      )}
    />
  );
}
