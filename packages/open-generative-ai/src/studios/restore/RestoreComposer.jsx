// The Restore studio's composer — the insides of the frame's one floating panel.
//
// Restore has no prompt, so the row where the prompt goes carries the thing a
// restoration is actually about: THE CLIP. Loading one, seeing what was
// measured out of it, and swapping it are all that row, in the same place and
// at the same size as the sentence you type in the other two studios.
//
// Under it, the render as a before and after — the size the clip is, the size
// it comes out, the model, and the machine with its bill:
//
//   640×360 → [2K · 2560×1440]  [7B · standard]  [This Mac · free]
//   Test 2s from [3.5s]
//
// It used to borrow the Image studio's sentence ("Restore [14 chunks] at [2K]
// with [7B FP8] on [This Mac — anima]"), which made the thing being restored
// read as its chunks, the model read as a checkpoint name, and the machine read
// as whichever ComfyUI process the gateway happened to list. A restoration is a
// change of size and of quality, so that is what the line says. The chunk
// count is on the Restore button; the chunk length is in Advanced.
//
// Each value writes through the studio's one settings handler — the same one
// the Advanced drawer writes through — so a shortcut cannot diverge from the
// drawer: the drawer stays the complete surface and this is four of its dials.
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
import { IconButton, Slider, cx } from '../../ui/kit.jsx';
import { CompletionPingToggle } from '../../ui/CompletionPingToggle.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { t } from '../../lib/i18n.js';
import {
  RESOLUTION_PRESETS, RESTORE_FAMILIES, RESTORE_MODELS, RESTORE_PRECISIONS,
  describeChunkPlan, restoreModelFor, targetDimensions,
} from '../../lib/videoRestore.js';
import { DrawerChoice } from '../frame/AdvancedDrawer.jsx';
import { PROJECT_WORDS } from './RestoreRail.jsx';
import {
  ComposerAlternate, ComposerPanel, ComposerPrimary, ComposerSecondary, ComposerTool,
} from '../frame/ComposerPanel.jsx';
import { RecipeLine } from '../frame/RecipeLine.jsx';

const sizeText = (size) => `${size.width}×${size.height}`;

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
          className={cx(
            'grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-white/5 text-ink3 transition-colors hover:bg-white/10 hover:text-ink1',
            // Taking the clip off the stage is the one destructive press on this
            // row, and at 22px it sat inside the slop of the label beside it.
            'touch:ml-1 touch:h-11 touch:w-11',
          )}
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
export function ProjectDoorItems({
  projects = [], activeProjectId = '', onOpenProject, close = () => {},
  // The rail's other two actions, optional so a caller that only wants the list
  // still gets the list. Resume and Delete live in the rail's long-press menu,
  // and the rail is `hidden sm:flex` — so below 640px a project could be opened
  // and never finished or cleared. They ride beside each row here, at every
  // width, for the same reason the list itself is listed at every width.
  onResumeProject = null, onDeleteProject = null, busy = false,
}) {
  if (!onOpenProject || !projects.length) return null;
  return (
    <>
      <MenuHeading>Projects</MenuHeading>
      {projects.map((project) => {
        const done = project.progress?.chunks_done ?? 0;
        const total = project.progress?.chunks_total ?? 0;
        // The rail's own reading of "there is more of this to render".
        const unfinished = project.status !== 'complete' && done < total;
        const name = `${project.width}x${project.height} — ${PROJECT_WORDS[project.status] || project.status}`;
        return (
          // A row, not a nested button: MenuItem IS a button, so its siblings
          // have to sit beside it rather than inside it.
          <div key={project.id} className="flex items-center gap-1">
            <MenuItem
              className="min-w-0 flex-1"
              icon={project.preview ? 'eye' : 'film'}
              selected={project.id === activeProjectId}
              meta={total ? `${done}/${total}` : ''}
              onClick={() => { onOpenProject(project); close(); }}
            >
              {name}
            </MenuItem>
            {onResumeProject && unfinished ? (
              <IconButton
                icon="play"
                size="sm"
                label={`Resume ${name}`}
                disabled={busy || !project.has_source}
                onClick={() => { onResumeProject(project); close(); }}
              />
            ) : null}
            {onDeleteProject ? (
              <IconButton
                icon="trash"
                size="sm"
                label={`Delete ${name}`}
                disabled={busy}
                className="hover:bg-danger-tint hover:text-danger"
                onClick={() => { onDeleteProject(project); close(); }}
              />
            ) : null}
          </div>
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
 * @param {string} clipDetail  the measured source line ("1920×1080 · 487 frames · 23.98fps")
 * @param {func}   onPickClip  (File) => …
 * @param {func=}  onDetachClip
 * @param {object=} source     the measured clip ({ width, height, … }) — the line's "before"
 * @param {object} settings    RESTORE_DEFAULTS-shaped; written through onChangeSettings
 * @param {object} plan        planRestore(...) — the chunk plan the output menu describes
 * @param {number} previewAt   seconds; where the two-second test starts
 * @param {number} previewMax  the last second a test can start at
 * @param {object} runOn       { targets, value, onChange, readinessFor, onFixReadiness }
 * @param {object} primary     { label, onClick, loading, disabled, title }
 * @param {object=} alternate  the quieter press (the test), or null
 * @param {func=}  onStop      offered only while a render is out
 * @param {string} billLabel   the bill beside the machine's name ("free", "$0.42/hr", "per render")
 * @param {string=} billTitle  the longer reading of that bill, for the machine token's tooltip
 */
export function RestoreComposer({
  clipName = '',
  clipDetail = '',
  onPickClip,
  onDetachClip = null,
  clipDisabled = false,
  source = null,

  settings,
  onChangeSettings,
  plan = null,
  previewSeconds = 2,
  previewAt = 0,
  previewMax = 0,
  onPreviewAt,

  runOn,

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
  onResumeProject = null,
  onDeleteProject = null,
  projectsBusy = false,
}) {
  const set = (key) => (value) => onChangeSettings({ ...settings, [key]: value });
  const model = RESTORE_MODELS.find((item) => item.id === settings.model) || RESTORE_MODELS[2];
  const family = RESTORE_FAMILIES.find((item) => item.id === model.family) || RESTORE_FAMILIES[1];
  const precision = RESTORE_PRECISIONS.find((item) => item.id === model.precision) || RESTORE_PRECISIONS[0];
  const resolution = RESOLUTION_PRESETS.find((item) => item.id === settings.resolution) || RESOLUTION_PRESETS[0];
  // What a preset makes of THIS clip, by the plan's own arithmetic. Before a
  // clip there is no size to scale, so the presets say only their names.
  const measured = Boolean(source?.width && source?.height);
  const sizeFor = (preset) => (measured
    ? targetDimensions(source.width, source.height, preset.edge, Number(settings.maxResolution) || 0)
    : null);
  const output = sizeFor(resolution);
  const pickModel = (familyId, precisionId) => {
    const next = restoreModelFor(familyId, precisionId);
    if (next) set('model')(next.id);
  };
  // The test marker is only a decision while there is footage to pick a moment
  // out of, and only while nothing is rendering.
  const canTest = Boolean(alternate) && previewMax > 0;

  const recipeParts = [
    // The before. Words, not a control: a different clip comes from the row
    // above. With nothing loaded it is the stage's own name for the clip.
    { text: measured ? sizeText(source) : 'Original' },
    { text: '→' },
    {
      key: 'output',
      value: output ? `${resolution.label} · ${sizeText(output)}` : resolution.label,
      title: `${t('restorePanel.output')} — ${resolution.hint}`,
      menuWidth: 'w-[19rem]',
      menu: (close) => (
        <>
          {RESOLUTION_PRESETS.map((preset) => {
            const size = sizeFor(preset);
            return (
              <MenuItem
                key={preset.id}
                meta={size ? sizeText(size) : ''}
                selected={preset.id === settings.resolution}
                title={preset.hint}
                onClick={() => { set('resolution')(preset.id); close(); }}
              >
                {preset.label}
              </MenuItem>
            );
          })}
          {/* The shape of the wait, under the size that decides it. */}
          <p className="px-2.5 pb-1 pt-2 text-[11px] leading-relaxed text-ink3">
            {plan?.chunks?.length ? describeChunkPlan(plan) : resolution.hint}
          </p>
        </>
      ),
    },
    {
      key: 'model',
      // The family is the decision. The precision is named only when it is the
      // dearer one, because FP8 is what a render runs on unless somebody asked.
      value: `${family.size} · ${family.label.toLowerCase()}${precision.id === 'fp16' ? ` · ${precision.label}` : ''}`,
      title: `${model.label}, ${model.size} — ${model.hint}`,
      menuWidth: 'w-[21rem]',
      menu: (close) => (
        <>
          {RESTORE_FAMILIES.map((item) => (
            <MenuItem
              key={item.id}
              meta={item.size}
              note={item.hint}
              selected={item.id === family.id}
              onClick={() => { pickModel(item.id, precision.id); close(); }}
            >
              {item.label}
            </MenuItem>
          ))}
          {/* Stays open: flipping the precision is a second look at the same
              family, not a new choice to confirm. */}
          <div className="mx-1 mt-1 flex items-center justify-between gap-3 border-t border-line1 px-1.5 pt-2.5">
            <span className="text-[12px] text-ink2">Precision</span>
            <DrawerChoice
              options={RESTORE_PRECISIONS.map((item) => ({ value: item.id, label: item.label, title: item.hint }))}
              value={precision.id}
              onChange={(value) => pickModel(family.id, value)}
              ariaLabel="Precision"
            />
          </div>
          <p className="px-2.5 pb-1 pt-2 text-[11px] leading-relaxed text-ink3">
            {`${model.size}. ${precision.hint} ${t('restorePanel.firstChunkDownload')}`}
          </p>
        </>
      ),
    },
    {
      key: 'runOn',
      // The machine and its bill, in one token. The same control and the same
      // list as the drawer's.
      node: (
        <RunOnPicker
          bare
          searchable={false}
          targets={runOn.targets}
          value={runOn.value}
          onChange={runOn.onChange}
          readinessFor={runOn.readinessFor}
          onFixReadiness={runOn.onFixReadiness}
          renderTrigger={(open, toggle, readoutLabel, readout) => {
            // "This Mac · free", "Rented GPU · $0.42/hr", "Hosted GPU · per
            // render" — or, with no machine that can restore, only the place
            // ("Nowhere yet"). Short enough never to be cut off, which the whole
            // readout was; the whole reading stays on the tooltip.
            const said = runOn.value
              ? [runOn.value.label, billLabel].filter(Boolean).join(' · ')
              : readout.place;
            const whole = billTitle ? `${readoutLabel} — ${billTitle}` : readoutLabel;
            return (
              <button
                type="button"
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                title={whole}
                aria-label={whole}
                className={cx(
                  'inline-flex max-w-[220px] items-center truncate rounded-md px-2 py-[3px] text-[12.5px] transition-colors',
                  'bg-white/[0.06] text-ink1 hover:bg-white/[0.11]',
                  open && 'ring-1 ring-inset ring-honey/60',
                )}
              >
                <span className="truncate">{said}</span>
              </button>
            );
          }}
        />
      ),
    },
  ];

  // The test's starting point, on a line of its own: the line above is the
  // render, and this is the one chunk that says whether it is worth it.
  const testParts = canTest ? [
    { text: `Test ${previewSeconds}s from` },
    {
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
    },
  ] : null;

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
            onResumeProject={onResumeProject}
            onDeleteProject={onDeleteProject}
            busy={projectsBusy}
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
        <div className="flex flex-col">
          <RecipeLine parts={recipeParts} />
          {testParts ? <RecipeLine parts={testParts} /> : null}
        </div>
      )}
      tools={tools}
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
