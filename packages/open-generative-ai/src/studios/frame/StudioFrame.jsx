// The Image and Video studios' frame — a full-bleed stage, a rail of previous
// work down the right edge, one floating composer, and every remaining control
// behind Advanced on the left.
//
// It replaces StudioLayout for these two routes only. StudioLayout puts a 320px
// settings panel permanently on screen and stacks results in a scrolling grid;
// the redesign inverts that: the thing you made owns the window, and the forty
// controls that make it are one click away instead of always underfoot.
//
// Layout contract (matching the design canvas, which draws a 1440x900 frame
// whose left 216px is the app's own nav rail — that rail is the Shell's here, so
// every inset below is measured from the route's own left edge):
//
//   stage      inset 0 <rail> <composer> 0, the picture centred inside it
//   rail       right 0, top 0, bottom 0, width 96 (image) / 108 (video)
//   composer   floating, bottom 22, centred over the stage, max-width 880
//   drawer     left 16, top 16, bottom 16, width 320 — it PUSHES the stage and
//              composer right rather than covering them (>= lg; below that it
//              is a sheet, because there is nothing to push into)
//
// The composer's height is not fixed — the prompt grows — so it is measured and
// published as --frame-composer-h, which the stage reserves as bottom padding.
// Without that, a three-line prompt sits on top of the picture.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Icon } from '../../ui/icons.jsx';
import { StudioOfflineNotice, cx } from '../../ui/kit.jsx';

// How far the stage keeps clear of the composer, on top of the composer's own
// measured height: the 22px it floats above the bottom edge, plus air.
const STAGE_COMPOSER_GAP = 44;
// left 16 + width 320 + gap 16. The stage and composer both start here while the
// drawer is open.
const DRAWER_PUSH = 352;
// The floating tab strip's own height plus the air above and below it. The strip
// hovers over the stage rather than sitting in a bar of its own, so the stage has
// to keep clear of it the same way it keeps clear of the composer.
const STAGE_TABS_RESERVE = 56;

/**
 * StudioFrame — the redesigned Image/Video route frame.
 *
 * @param {node}   stage        what fills the middle (a picture, a player, an empty state)
 * @param {node}   stageActions floating action column pinned to the stage's top-right
 * @param {node}   notices      failure callouts and banners, floated over the top of the stage
 * @param {node}   rail         the right edge — results (image) or the sequence (video)
 * @param {number} railWidth    px; the design uses 96 for image, 108 for video
 * @param {node}   composer     the floating ComposerPanel
 * @param {object} drop         the composer's drop contract (see ComposerSlot in ui/kit.jsx)
 * @param {node}   drawer       Advanced's body — a stack of DrawerSections
 * @param {bool}   drawerOpen   whether Advanced is open
 * @param {func}   onDrawerClose
 * @param {string} drawerTitle
 * @param {node}   footer       the bottom-left corner (collapse, settings)
 */
export function StudioFrame({
  stage,
  stageActions = null,
  notices = null,
  rail = null,
  railWidth = 96,
  composer,
  drop = null,
  drawer = null,
  drawerOpen = false,
  onDrawerClose,
  drawerTitle = 'Advanced',
  footer = null,
  // The studio's tab strip. It floats over the top of the stage, on the same
  // column as the composer, so the first chip and the prompt share a left edge.
  // StudioTabs hands it down and renders it only for the FRONT tab, so there is
  // never a second tablist in the DOM behind a hidden studio.
  tabs = null,
}) {
  const composerRef = useRef(null);
  const [composerH, setComposerH] = useState(112);

  // ResizeObserver rather than a layout effect on the prompt value: the panel
  // also grows when a reference strip appears, a banner opens, or the recipe
  // line wraps — none of which this component knows about.
  useLayoutEffect(() => {
    const node = composerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      setComposerH(node.getBoundingClientRect().height || 112);
    });
    observer.observe(node);
    setComposerH(node.getBoundingClientRect().height || 112);
    return () => observer.disconnect();
  }, []);

  // Escape shuts Advanced — but only when nothing is layered above it, or the
  // key would close the drawer out from under an open dialog or popover.
  useEffect(() => {
    if (!drawerOpen || !onDrawerClose) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      onDrawerClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, onDrawerClose]);

  const style = {
    '--frame-rail-w': `${railWidth}px`,
    '--frame-composer-h': `${composerH}px`,
    '--frame-left': drawerOpen ? `${DRAWER_PUSH}px` : '0px',
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 overflow-hidden bg-bg0"
      style={style}
      data-studio-frame=""
      data-drawer-open={drawerOpen ? '' : undefined}
    >
      {/* ---- tab strip ------------------------------------------------- */}
      {/* Floating, on the composer's column. The wrapper is the composer's
          wrapper verbatim — same left/right insets, same 22px gutter, same
          centred 880px column — and the strip is left-aligned inside it, which
          is what puts the first chip exactly above the prompt's first character.
          Anything else (a fixed full-width bar, or centring the strip itself)
          drifts the moment the drawer opens or the window changes width. */}
      {tabs ? (
        <div
          // pointer-events-none on the two wrappers, auto on the strip itself:
          // the inner column is 880px wide while the strip is a third of that, so
          // without this it would swallow every click on the top band of the
          // picture. z-[35] puts it over the composer rather than under it —
          // when a short window makes the two floating panels meet, a covered
          // prompt still scrolls, but a covered tab strip has no other door.
          className="pointer-events-none absolute left-0 top-3 z-[35] flex justify-center px-[22px] transition-[left] duration-300 ease-swift lg:left-[var(--frame-left)]"
          style={{ right: 'var(--frame-rail-w)' }}
        >
          <div className="pointer-events-none flex w-full max-w-[880px] justify-start">{tabs}</div>
        </div>
      ) : null}

      {/* ---- stage ---------------------------------------------------- */}
      {/* The picture, centred, with room reserved for the composer that floats
          over its lower edge. Its own scroll is off: a stage that scrolls is a
          gallery, and the gallery is the rail. */}
      <div
        className="absolute inset-y-0 left-0 grid place-items-center transition-[left] duration-300 ease-swift lg:left-[var(--frame-left)]"
        style={{ right: 'var(--frame-rail-w)' }}
      >
        <div
          className="grid h-full w-full place-items-center px-4"
          style={{
            paddingTop: tabs ? STAGE_TABS_RESERVE : 16,
            paddingBottom: `calc(var(--frame-composer-h) + ${STAGE_COMPOSER_GAP}px)`,
          }}
        >
          {stage}
        </div>
      </div>

      {/* ---- notices -------------------------------------------------- */}
      {/* Failure callouts, dependency prompts and lane notices used to head a
          scrolling column. There is no column now, so they float at the top of
          the stage, over the picture, where they cannot be scrolled past. */}
      {/* Rendered unconditionally: StudioOfflineNotice is self-gating and the
          studio's own callouts come and go. An empty column draws nothing. */}
      <div
        className="pointer-events-none absolute left-0 top-0 z-20 flex flex-col gap-2 px-4 transition-[left] duration-300 ease-swift lg:left-[var(--frame-left)]"
        style={{ right: 'var(--frame-rail-w)', paddingTop: tabs ? STAGE_TABS_RESERVE : 12 }}
      >
        <div className="pointer-events-auto mx-auto flex w-full max-w-[880px] flex-col gap-2">
          {/* "The studio is not answering", with its Retry and the shell's
              restart. StudioLayout used to carry this and these two routes no
              longer use StudioLayout — and it is the one reading that must not
              be behind a menu, so the frame owns it rather than each studio
              remembering to pass it. */}
          <StudioOfflineNotice floating />
          {notices}
        </div>
      </div>

      {/* ---- stage actions -------------------------------------------- */}
      {stageActions ? (
        <div
          className="absolute z-20 flex flex-col gap-1.5"
          style={{ right: `calc(var(--frame-rail-w) + 16px)`, top: tabs ? STAGE_TABS_RESERVE : 16 }}
        >
          {stageActions}
        </div>
      ) : null}

      {/* ---- right rail ------------------------------------------------ */}
      {rail ? (
        <aside
          className="absolute inset-y-0 right-0 z-10 hidden flex-col items-center gap-2 overflow-y-auto border-l border-line1/60 bg-bg0/60 px-2 pb-6 pt-4 sm:flex"
          style={{ width: 'var(--frame-rail-w)' }}
        >
          {rail}
        </aside>
      ) : null}

      {/* ---- composer -------------------------------------------------- */}
      {/* data-studio-composer is a wire contract: OutputRestoreDropZone checks
          for it so a picture dropped on the composer is attached as a reference
          instead of being restored as a past run. */}
      <ComposerFloat
        panelRef={composerRef}
        drop={drop}
        railWidth={railWidth}
      >
        {composer}
      </ComposerFloat>

      {/* ---- footer ---------------------------------------------------- */}
      {footer ? (
        <div className="absolute bottom-3 left-3 z-30 flex items-center gap-1">{footer}</div>
      ) : null}

      {/* ---- advanced drawer -------------------------------------------- */}
      {/* Below lg there is no room to push into, so the drawer becomes a sheet
          over a scrim — the same disclosure, a different geometry. */}
      {drawerOpen && drawer ? (
        <>
          <button
            type="button"
            aria-label={`Close ${drawerTitle}`}
            className="absolute inset-0 z-30 bg-scrim lg:hidden"
            onClick={onDrawerClose}
          />
          <aside
            role="dialog"
            aria-label={drawerTitle}
            className={cx(
              'hive-scale-in absolute bottom-3 left-3 top-3 z-40 flex w-[min(340px,88vw)] flex-col overflow-y-auto',
              'rounded-[18px] bg-bg0/85 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.07)] backdrop-blur-xl',
              'lg:bottom-4 lg:left-4 lg:top-4 lg:w-[320px]',
            )}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-bg0/[0.92] px-[19px] pb-3 pt-[17px] backdrop-blur-xl">
              <span className="mr-auto text-[14px] font-semibold text-ink1">{drawerTitle}</span>
              <button
                type="button"
                aria-label={`Close ${drawerTitle}`}
                onClick={onDrawerClose}
                className="grid h-[30px] w-[30px] place-items-center rounded-full bg-white/5 text-inkSoft transition-colors hover:bg-white/10 hover:text-ink1"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            {drawer}
          </aside>
        </>
      ) : null}
    </div>
  );
}

/* ---------------- the floating composer, and its drop zone ---------------- */

// Lifted from ui/kit.jsx's ComposerSlot, which drew a bordered strip across the
// bottom of a column. The contract is identical (drop.accepts/hint/onDrop/busy)
// and so is the data attribute the window-level restore zone looks for; only the
// geometry differs — it floats, so its drag affordance is a ring on the panel
// rather than a band across the page.
function ComposerFloat({ drop, railWidth, panelRef, children }) {
  const [over, setOver] = useState(false);
  const [hint, setHint] = useState('');
  // dragenter/dragleave fire for every child, so a plain boolean flickers as the
  // pointer crosses the buttons. Count enters instead.
  const depthRef = useRef(0);
  const active = typeof drop?.onDrop === 'function';
  const accepts = useCallback((event) => active
    && (typeof drop.accepts !== 'function' || drop.accepts(event.dataTransfer, event.target)), [active, drop]);
  const busy = Boolean(drop?.busy);
  const showing = over || busy;

  const handlers = active
    ? {
      onDragEnter: (event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        depthRef.current += 1;
        setHint(typeof drop.hint === 'function' ? drop.hint(event.dataTransfer) : (drop.hint || ''));
        setOver(true);
      },
      onDragOver: (event) => {
        if (!accepts(event)) return;
        event.preventDefault(); // required to allow a drop
        try { event.dataTransfer.dropEffect = 'copy'; } catch { /* non-critical */ }
      },
      onDragLeave: () => {
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (!depthRef.current) setOver(false);
      },
      onDrop: (event) => {
        depthRef.current = 0;
        setOver(false);
        if (!accepts(event)) return;
        event.preventDefault();
        // Keeps the drop off the window-level restore zone even before its own
        // [data-studio-composer] guard gets a look at it.
        event.stopPropagation();
        drop.onDrop(event.dataTransfer);
      },
    }
    : {};

  return (
    <div
      className="absolute bottom-[22px] left-0 z-30 flex justify-center px-[22px] transition-[left] duration-300 ease-swift lg:left-[var(--frame-left)]"
      style={{ right: `${railWidth}px` }}
    >
      <div
        ref={panelRef}
        {...(active ? { 'data-studio-composer': '' } : {})}
        {...handlers}
        className={cx(
          'relative box-border flex w-full max-w-[880px] flex-col gap-[13px] rounded-[18px] bg-bg0/85 px-[19px] py-[17px] backdrop-blur-xl transition-shadow',
          showing
            ? 'shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_2px_rgb(var(--honey-rgb))]'
            : 'shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.07)]',
        )}
      >
        {children}
        {showing ? (
          <div
            className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-[18px] border-2 border-dashed border-honey bg-bg0/90"
            role={busy ? 'status' : undefined}
            aria-live={busy ? 'polite' : undefined}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-honey">
              <Icon name={busy ? 'refresh' : 'upload'} size={16} className={busy ? 'animate-spin' : ''} />
              {busy ? 'Attaching…' : (hint || 'Drop to attach')}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
