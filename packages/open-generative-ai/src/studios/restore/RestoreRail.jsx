// The Restore studio's right edge: every restoration this machine still holds.
//
// It replaces the `<RestoreProjects>` list that shared the bottom of a
// scrolling column with the Finish panel — a two-column grid under the one
// thing the page exists to show. The list is a rail now, for the same reason
// the Image gallery is: a project is something you come BACK to, and coming
// back should not cost the picture its window.
//
// What the list was really for has not changed. A chunked render is the kind of
// job a laptop lid closes on; every project here keeps its finished chunks, so
// the action is "resume", not "start again", and the card says how far it got
// because "6 of 14" is the difference between resuming and giving up.
//
// A 72px card cannot hold three buttons, so Open / Resume / Delete are one menu
// — opened by right-click, by long-press, and by a "…" door that appears on
// hover or keyboard focus, so all three input kinds reach the same actions.
// That is the rule the Image and Video rails already follow.
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { describeRestoreFailure } from '../../lib/videoRestore.js';
import { Icon } from '../../ui/icons.jsx';
import { MenuItem } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';
import { RailCard, RailEmpty, RailHeading, RailMenu } from '../frame/ResultsRail.jsx';

// 108px rail, 72px cards — the Video studio's measurements, because a
// restoration is a clip and a clip card is 16:9.
const CARD_W = 72;
const CARD_ASPECT = '16 / 9';
// No cap, deliberately. The gateway already reaps projects on its own schedule
// (describeRetention says so out loud, at the foot of this rail), so a second
// limit here would only hide projects that still exist and still have a Resume
// — which is the one thing this list is for.
// Long enough not to fire on a tap, short enough to feel like a press.
const LONG_PRESS_MS = 500;

// The status dot's colour. A rail card has no room for the Pill the list row
// carried, and the word is in the menu — out here it is a mark you can read
// down the column without opening anything.
const DOT = {
  complete: 'bg-ok',
  running: 'bg-honey',
  queued: 'bg-honey/60',
  awaiting_assembly: 'bg-warn',
  error: 'bg-danger',
  stopped: 'bg-inkSoft',
};

/** One word per state, shared with the composer's Projects door so the two
 *  surfaces cannot describe the same render differently. */
export const PROJECT_WORDS = {
  complete: 'Finished',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Failed',
  awaiting_assembly: 'Needs joining',
  queued: 'Queued',
};

function when(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch { return ''; }
}

/** The card's accessible name, and its hover tooltip — the row's whole line. */
export function projectLabel(project) {
  const done = project.progress?.chunks_done ?? 0;
  const total = project.progress?.chunks_total ?? 0;
  return [
    `${project.width}x${project.height}${project.preview ? ' preview' : ''}`,
    PROJECT_WORDS[project.status] || project.status,
    total ? `${done} of ${total} chunks` : 'no chunks yet',
    project.sink === 'clip' ? 'rendered on a rented machine' : '',
    when(project.updated_at),
  ].filter(Boolean).join(' · ');
}

/**
 * One project in the rail.
 *
 * Memoised on its own project, and every handler takes the project as an
 * argument, so the studio passes ONE stable function per action rather than a
 * fresh closure per card — this rail re-renders on every poll tick.
 */
const RestoreRailCard = memo(function RestoreRailCard({ project, selected, onOpen, onMenu }) {
  const holderRef = useRef(null);
  const timerRef = useRef(0);
  // A long press ends in a click; without this the menu would open and the
  // project would open behind it.
  const heldRef = useRef(false);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const endPress = () => clearTimeout(timerRef.current);
  const startPress = (event) => {
    if (event.button !== 0) return; // a right-click has its own door
    heldRef.current = false;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      heldRef.current = true;
      onMenu(project, holderRef.current);
    }, LONG_PRESS_MS);
  };

  const done = project.progress?.chunks_done ?? 0;
  const total = project.progress?.chunks_total ?? 0;
  return (
    <div ref={holderRef} className="group relative shrink-0">
      <RailCard
        aspect={CARD_ASPECT}
        width={CARD_W}
        selected={selected}
        label={projectLabel(project)}
        caption={total ? `${done}/${total}` : ''}
        onClick={() => {
          if (heldRef.current) { heldRef.current = false; return; }
          onOpen(project);
        }}
        onContextMenu={(event) => { event.preventDefault(); endPress(); onMenu(project, holderRef.current); }}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
      >
        {/* No thumbnail: a restored master is a sealed clip, and decrypting a
            column of them to draw forty stamp-sized posters would cost more
            than the rail is worth. The size is the identity instead — it is
            what the row led with, and it is what tells two runs of the same
            footage apart. */}
        <span className="pointer-events-none absolute inset-x-0 top-2 text-center font-mono text-[9px] leading-tight text-inkSoft">
          {project.width}x{project.height}
          {project.preview ? <span className="block text-honey">test</span> : null}
        </span>
        <span
          className={cx(
            'pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full shadow-[0_0_0_2px_rgba(0,0,0,0.55)]',
            DOT[project.status] || 'bg-inkSoft',
          )}
        />
      </RailCard>
      {/* The menu's visible door. A nested <button> inside RailCard's button
          would be invalid, so it is a sibling floated over the card's corner.
          Kept mounted (not hover-gated in the DOM) so it is tabbable. */}
      <button
        type="button"
        title="More actions"
        aria-label={`More actions — ${projectLabel(project)}`}
        aria-haspopup="menu"
        onClick={() => onMenu(project, holderRef.current)}
        className={cx(
          'absolute bottom-0.5 right-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-bg0/80 text-ink1',
          'opacity-0 transition-opacity duration-150 hover:bg-bg1 focus-visible:opacity-100',
          'group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        <Icon name="more" size={11} />
      </button>
    </div>
  );
});

/**
 * RestoreRail — the Restore studio's `rail` slot for StudioFrame (railWidth 108).
 *
 * The frame owns the column itself (the scrolling aside, its gap and padding),
 * so this returns the column's contents: the heading, the retention sentence,
 * the cards and the overflow.
 *
 * @param {array}  projects   fetchRestoreProjects()
 * @param {string} activeId   the project on the stage
 * @param {func}   onOpen     (project) => …
 * @param {func}   onResume   (project) => …
 * @param {func}   onDelete   (project) => …  opens the confirm, never deletes
 * @param {bool}   busy       a render is out; resuming another one is refused
 * @param {string} retention  describeRetention(capabilities)
 */
export function RestoreRail({
  projects = [],
  activeId = '',
  onOpen,
  onResume,
  onDelete,
  busy = false,
  retention = '',
}) {
  // { project, anchor } — one menu for the whole rail, not one per card: a menu
  // per card would give every card a piece of state and break the memo above.
  const [menu, setMenu] = useState(null);
  const openMenu = useCallback((project, anchor) => {
    setMenu((prev) => (prev && prev.project === project && prev.anchor === anchor ? null : { project, anchor }));
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const chosen = menu?.project || null;
  const done = chosen?.progress?.chunks_done ?? 0;
  const total = chosen?.progress?.chunks_total ?? 0;
  const unfinished = chosen ? (chosen.status !== 'complete' && done < total) : false;
  // The reading, not the exception — the same describeRestoreFailure the stage
  // uses, so the card and the callout never say different things about one
  // render.
  const failure = chosen?.error ? describeRestoreFailure(chosen.error) : null;

  return (
    <>
      <RailHeading>
        Projects
        {projects.length ? <span className="ml-1 tracking-normal text-ink3">{projects.length}</span> : null}
      </RailHeading>

      {projects.map((project) => (
        <RestoreRailCard
          key={project.id}
          project={project}
          selected={project.id === activeId}
          onOpen={onOpen}
          onMenu={openMenu}
        />
      ))}

      {!projects.length ? (
        <RailEmpty>Nothing restored yet</RailEmpty>
      ) : null}

      {/* How long these survive. The reaper's behaviour is right — a project is
          gigabytes of intermediates — but until it was said here a project that
          aged out simply vanished with nothing to read. */}
      {retention ? (
        <span className="mt-2 px-1 text-center text-[9px] leading-relaxed text-ink3">{retention}</span>
      ) : null}

      {menu ? (
        <RailMenu anchor={menu.anchor} label="Project actions" onClose={closeMenu}>
          <div className="px-2.5 pb-2 pt-1">
            <p className="text-[12px] leading-snug text-ink2">
              {chosen.width}x{chosen.height}
              {chosen.preview ? ' preview' : ''}
              {' — '}
              {PROJECT_WORDS[chosen.status] || chosen.status}
            </p>
            <p className="truncate font-mono text-[10px] text-ink3">
              {total ? `${done} of ${total} chunks` : 'no chunks yet'}
              {chosen.sink === 'clip' ? ' · rented' : ''}
              {when(chosen.updated_at) ? ` · ${when(chosen.updated_at)}` : ''}
            </p>
          </div>
          {/* A failure is never a bare statement: the sentence says what
              happened, the line under it says what to change, and Resume — one
              item down — is the way out that keeps every finished chunk. */}
          {failure ? (
            <div className="mx-1 mb-1.5 rounded-md bg-danger/10 px-2 py-1.5">
              <p className="text-[11px] leading-snug text-ink1">
                {failure.action ? `${failure.title} ${failure.action}` : failure.title}
              </p>
            </div>
          ) : null}
          <MenuItem icon="eye" onClick={() => { closeMenu(); onOpen(chosen); }}>Open</MenuItem>
          {unfinished ? (
            <MenuItem
              icon="play"
              disabled={busy || !chosen.has_source}
              title={chosen.has_source
                ? 'Continues from the first chunk with no file, under this project\'s original settings'
                : 'The source clip for this project is gone — load it again to resume'}
              onClick={() => { closeMenu(); onResume(chosen); }}
            >
              Resume
            </MenuItem>
          ) : null}
          <MenuItem icon="trash" disabled={busy} onClick={() => { closeMenu(); onDelete(chosen); }}>
            Delete
          </MenuItem>
        </RailMenu>
      ) : null}
    </>
  );
}
