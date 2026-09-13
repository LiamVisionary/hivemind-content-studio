// The Restore studio's stage — the comparison, as large as the window allows.
//
// It replaces a scrolling column that put the one thing you are judging at the
// BOTTOM of five cards. A restoration is judged on detail that exists for a
// frame or two, so the comparison is not a card in a column; it is the reason
// the page exists, and here it owns the window the way the picture does in
// Image and the clip does in Video.
//
// Three things can be on screen, and only one at a time:
//
//   nothing yet   the empty state, with the load-a-clip door in it
//   rendering     the comparison with the chunk readout along its lower edge
//   done          the comparison
//
// Everything that used to be a Card above the comparison (the upload bar, the
// chunk progress, what has been charged so far, how long the intermediates are
// kept) is either that lower-edge readout or a floating notice — see
// RestoreStudio.jsx's `notices`. Nothing was dropped, and nothing can be
// scrolled past any more, because the stage does not scroll.
//
// Prop-driven, like ImageStage: it imports nothing from RestoreStudio.jsx, and
// an action arriving as `undefined` is an action this state cannot do.
import { COMPARE_MODES } from '../../lib/videoRestore.js';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { Stage, StageAction, StageEmpty, StageProgress } from '../frame/Stage.jsx';
import { RestoreCompare } from './RestoreCompare.jsx';

// What the frame falls back to before a clip has been measured. Not a guess
// about the footage — it is the shape of the empty plate.
const DEFAULT_ASPECT = '16 / 9';

/** The clip's own shape, so a 4:3 restoration is not letterboxed into 16:9. */
export function stageAspect(source) {
  const width = Number(source?.width) || 0;
  const height = Number(source?.height) || 0;
  if (!(width > 0) || !(height > 0)) return DEFAULT_ASPECT;
  return `${width} / ${height}`;
}

/**
 * RestoreStage — what fills StudioFrame's `stage` slot.
 *
 * @param {object} source        the measured clip ({width, height, frames, fps})
 * @param {string} originalUrl   the source clip, as a blob URL
 * @param {string} restoredUrl   the master (or the joined preview), decrypted
 * @param {string} mode          one of COMPARE_MODES
 * @param {bool}   running       a render is out
 * @param {object} progress      the gateway's derived progress for this project
 * @param {string} phase         'Restoring', 'Uploading' — what the bar is of
 * @param {number} percent       0..100, or null for an indeterminate bar
 * @param {string} subject       "6 of 14 chunks"
 * @param {string} timing        describeEta(progress)
 * @param {string} note          the sentence under the bar (spend, retention)
 * @param {func}   onCancel      stop the render
 * @param {func}   onLoadClip    the empty state's own door
 */
export function RestoreStage({
  source = null,
  originalUrl = '',
  restoredUrl = '',
  mode = 'wipe',
  restoredLabel = 'Restored',
  busy = false,
  phase = '',
  percent = null,
  subject = '',
  timing = '',
  note = '',
  onCancel = null,
  cancelLabel = 'Stop',
  emptyTitle = 'Restore and upscale video, on your own machine',
  emptyHint = 'SeedVR2 re-generates footage at a higher resolution and removes the compression mush on the way. Load a clip to see the plan; render a two-second test before committing to the whole thing.',
  emptyAction = null,
}) {
  // Nothing loaded and nothing reopened: the one sentence, and the door.
  if (!originalUrl && !restoredUrl) {
    return (
      <Stage aspect={DEFAULT_ASPECT}>
        <StageEmpty icon="film" title={emptyTitle} hint={emptyHint} action={emptyAction} />
      </Stage>
    );
  }

  return (
    <Stage
      aspect={stageAspect(source)}
      busy={busy}
      overlay={phase ? (
        <StageProgress
          phase={phase}
          percent={percent}
          subject={subject}
          timing={timing}
          note={note}
          onCancel={onCancel || undefined}
          cancelLabel={cancelLabel}
        />
      ) : null}
    >
      <RestoreCompare
        originalUrl={originalUrl}
        restoredUrl={restoredUrl}
        mode={mode}
        restoredLabel={restoredLabel}
      />
    </Stage>
  );
}

/**
 * RestoreStageActions — the floating column in StudioFrame's `stageActions`.
 *
 * Two doors. The first is the four-way comparison, which was a Segmented
 * control across the top of the frame and is a menu here for the same reason
 * the Image stage's actions are menus: a bar of four labelled options is chrome
 * that never goes away, and this is a choice people make a handful of times.
 * The second saves the master.
 */
export function RestoreStageActions({
  mode, onModeChange, canCompare = true, onDownload = null, downloadLabel = 'Download the master',
}) {
  const current = COMPARE_MODES.find((item) => item.id === mode) || COMPARE_MODES[0];
  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* No door until there are two clips. Offering "Compare" over a loaded
          clip that has not been restored yet is a choice with one outcome. */}
      {canCompare ? (
      <Menu
        align="end"
        width="w-60"
        trigger={(open, toggle) => (
          <StageAction
            icon="layers"
            // The sentence that used to sit under the frame. It is the answer to
            // "am I really looking at the same moment twice", which is the only
            // question that makes a comparison mean anything.
            label={`Compare: ${current.label} — both clips follow the restored one, so you are always on the same frame`}
            active={open}
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
          />
        )}
      >
        {(close) => (
          <>
            {COMPARE_MODES.map((item) => (
              <MenuItem
                key={item.id}
                selected={item.id === mode}
                onClick={() => { onModeChange(item.id); close(); }}
              >
                {item.label}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      ) : null}
      {onDownload ? (
        <StageAction icon="download" label={downloadLabel} onClick={onDownload} />
      ) : null}
    </div>
  );
}
