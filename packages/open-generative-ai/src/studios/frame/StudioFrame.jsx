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
//   rail       a floating pill inset from the top-right corner, 12px narrower
//              than the band it reserves (96 image / 108 video) and only as
//              tall as its contents, capped at the frame height less its insets
//   composer   floating, bottom 22, centred over the stage, max-width 880
//   drawer     left 16, top 16, bottom 16, width 320 — it PUSHES the stage and
//              composer right rather than covering them (>= lg; below that it
//              is a sheet, because there is nothing to push into)
//   drawer tab a binder tab on the drawer's outer edge, centred top to bottom.
//              Shut, the drawer waits off the frame's left edge with only its
//              tab showing; a press slides it out and the tab rides its edge
//
// The composer's height is not fixed — the prompt grows — so it is measured and
// published as --frame-composer-h, which the stage reserves as bottom padding.
// Without that, a three-line prompt sits on top of the picture.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { Icon } from '../../ui/icons.jsx';
import { StudioOfflineNotice, cx } from '../../ui/kit.jsx';
import { MenuLayer } from '../../ui/Menu.jsx';

// How far the stage keeps clear of the composer, and of the tab strip, on top
// of the composer's own measured height.
//
// Both are published as CSS custom properties rather than used as JS numbers,
// because both are desktop air: on a phone the composer is two and a half times
// taller and the window is a third as tall, so 44px of breathing room under it
// and 56px above the tabs is most of what is left for the picture. base.css
// gives them their phone values and restores these from sm up. They live in
// base.css and NOT in the inline style object for the reason the rail band does
// — an inline custom property cannot be taken back at a breakpoint.
const STAGE_COMPOSER_GAP = 'var(--frame-stage-gap)';
// left 16 + width 320 + gap 16. The stage and composer both start here while the
// drawer is open.
const DRAWER_PUSH = 352;
// How long the drawer takes to slide out or back in: the `duration-300` the
// stage and composer already move by, so all three arrive together.
const DRAWER_SLIDE_MS = 300;
// The floating tab strip's own height plus the air above and below it. The strip
// hovers over the stage rather than sitting in a bar of its own, so the stage has
// to keep clear of it the same way it keeps clear of the composer.
const STAGE_TABS_RESERVE = 'var(--frame-tabs-reserve)';

/**
 * How much of the window an on-screen keyboard is covering, in px.
 *
 * The composer is anchored to the bottom of a shell that is exactly one viewport
 * tall, so when a phone opens its keyboard nothing in the layout moves: the
 * keyboard is simply drawn OVER the bottom of the page, and the box being typed
 * into is the one thing that ends up hidden. `visualViewport` is the only API
 * that reports the covered strip, and lifting the composer by it is what makes
 * the difference between a web page and a messaging app.
 *
 * Zero everywhere there is no software keyboard, so the expression that consumes
 * it is the same expression on a desktop.
 */
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport;
    if (!vv?.addEventListener) return undefined;
    const read = () => {
      // What the layout viewport has and the visual one does not, less however
      // far the visual viewport has been scrolled down inside it (iOS pans the
      // page to keep the caret visible, and that pan is not keyboard).
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      // A rounding wobble of a pixel or two is not a keyboard; a URL bar
      // sliding away is not one either, and both would jitter the composer.
      setInset(covered > 80 ? Math.round(covered) : 0);
    };
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, []);
  return inset;
}

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
 * @param {func}   onDrawerToggle  the tab on the drawer's edge, Advanced's one door (no tab without it)
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
  onDrawerToggle,
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
  // Below sm the rail is docked ON the composer rather than down the right
  // edge, so the stage has to keep clear of its height the way it keeps clear
  // of the composer's. Measured for the same reason: it is a different height
  // in every studio (48px cards in Image, 72px in Video and Restore) and it is
  // not there at all until something has been made.
  const railRef = useRef(null);
  // The drawer's own panel, so the Escape guard below can tell it apart from a
  // dialog genuinely layered over it.
  const drawerRef = useRef(null);
  // Names the panel for its tab's aria-controls.
  const drawerId = useId();
  // Where the drawer's menus draw (MenuLayer in ui/Menu.jsx). State through a
  // callback ref rather than a ref, so the provider re-renders once it exists.
  const [menuLayer, setMenuLayer] = useState(null);
  const [composerH, setComposerH] = useState(112);
  const [railH, setRailH] = useState(0);
  const keyboardInset = useKeyboardInset();

  // The drawer's body is not in the tree while Advanced is shut — the drawer IS
  // the disclosure (see videoSceneSurface.test.js) — but it has to outlive the
  // press that shuts it by one slide, or the panel empties the moment it starts
  // back in and slides away blank.
  const [drawerBodyKept, setDrawerBodyKept] = useState(drawerOpen);
  useEffect(() => {
    if (drawerOpen) {
      setDrawerBodyKept(true);
      return undefined;
    }
    const timer = setTimeout(() => setDrawerBodyKept(false), DRAWER_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [drawerOpen]);
  const drawerBody = drawerOpen || drawerBodyKept;

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

  // …and the same measurement again at the document root, for the surfaces that
  // are NOT inside the frame. react-hot-toast's container is a child of <body>,
  // so `--frame-composer-h` is invisible to it: a toast that wants to sit above
  // the composer can only read the value from :root. Published under its own
  // name, and base.css zeroes it from sm up — above a phone the composer is a
  // centred 880px panel and a bottom-right toast never meets it, so lifting
  // there would only float the toasts oddly high.
  useEffect(() => {
    const root = typeof document === 'undefined' ? null : document.documentElement;
    if (!root) return undefined;
    root.style.setProperty('--app-composer-px', `${Math.round(composerH)}px`);
    // A studio that is not on screen reserves nothing. Studios stay mounted and
    // display-toggled (App.jsx keeps an in-flight generation alive across a page
    // switch), so this is the unmount of the LAST frame, not of every switch —
    // which is correct: while any frame is mounted, a composer is on the stage.
    return () => root.style.removeProperty('--app-composer-px');
  }, [composerH]);

  useLayoutEffect(() => {
    const node = railRef.current;
    if (!node) { setRailH(0); return undefined; }
    const read = () => setRailH(node.getBoundingClientRect().height || 0);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rail]);

  // Escape shuts Advanced — but only when nothing is layered above it, or the
  // key would close the drawer out from under an open dialog or popover.
  //
  // "Nothing layered above it" has to exclude THE DRAWER, which is itself a
  // `[role="dialog"]` (see the aside below). The blanket querySelector matched
  // the drawer's own panel the moment it opened, so this effect has never once
  // reached `onDrawerClose` — Escape closed Advanced in none of the studios
  // that mount this frame. A dialog nested INSIDE the drawer still wins the
  // key, which is the rule this was written for.
  useEffect(() => {
    if (!drawerOpen || !onDrawerClose) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      const layered = Array.from(document.querySelectorAll('[role="dialog"]'))
        .some((node) => node !== drawerRef.current);
      if (layered) return;
      onDrawerClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, onDrawerClose]);

  // The rail's band is published as --frame-rail-px, and base.css turns that
  // into the --frame-rail-w every layer below reserves — but only from sm up,
  // which is the only width the rail aside is drawn at (`hidden sm:flex`).
  //
  // It has to be two properties. An INLINE custom property wins on specificity
  // over any stylesheet rule, media query or not, so the
  // `@media (max-width: 639px) { --frame-rail-w: 0px }` that used to sit in
  // base.css never applied once. Measured at 375px: the rail really was
  // display:none, the var still computed to 96px, and the stage, the notices,
  // the tab strip and the composer all held that 96px open down the right edge
  // for something nobody could see — the composer came out 235px wide on a
  // 375px phone, and its Generate button fell out of the panel it lives in.
  //
  // A frame given no rail at all reserves nothing, at any width.
  const style = {
    '--frame-rail-px': rail ? `${railWidth}px` : '0px',
    // The pill's own width from sm up, and the strip's own height below it.
    '--frame-rail-pill-w': `${railWidth - 12}px`,
    '--frame-rail-strip-px': `${Math.round(railH)}px`,
    '--frame-composer-h': `${composerH}px`,
    // How far the composer rides up over an open software keyboard, and how
    // much extra the stage keeps clear because it did.
    '--frame-lift': `${keyboardInset}px`,
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
          // px-3 below sm, to keep the first chip on the same left edge as the
          // prompt under it — the composer went nearly edge to edge on a phone
          // and this did not follow, so the strip stood 10px inside it.
          className="pointer-events-none absolute left-0 top-3 z-[35] flex justify-center px-3 transition-[left] duration-300 ease-swift sm:px-[22px] lg:left-[var(--frame-left)]"
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
        {/* min-h-0 is load-bearing, not tidiness. This div is a GRID ITEM, so
            its automatic minimum size is its CONTENT size — which overrides the
            h-full above the moment the stage holds a real picture. Measured at
            1000x710 with a 1024^2 result: the box grew to 1135px inside its
            672px parent, `max-h-full` on the stage resolved to `none` against
            that now-indefinite height, and the picture sized itself off the
            WIDTH instead — 876x876, overflowing the window and running under
            the composer. It stayed hidden while the stage's <img> was broken,
            because a broken image contributes no intrinsic size to grow it. */}
        <div
          className="grid h-full min-h-0 w-full place-items-center px-4"
          style={{
            paddingTop: tabs ? STAGE_TABS_RESERVE : 16,
            paddingBottom: `calc(var(--frame-composer-h) + var(--frame-lift) + var(--frame-rail-strip) + ${STAGE_COMPOSER_GAP})`,
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
      {/* A floating pill, not a bordered column. The hairline down the left of
          a full-height strip drew a wall across the window and the strip's own
          empty half stayed on screen under one result. The rail is the same
          material as the composer and Advanced — rounded, blurred, ringed —
          inset from the edge and only as tall as what it holds, so it reads as
          one more thing floating over the stage rather than a second panel.
          The reserved band (--frame-rail-w) is unchanged: the stage and the
          composer still clear the full width, and the pill sits inside it. */}
      {rail ? (
        <aside
          ref={railRef}
          className={cx(
            // The same material and the same single instance in both shapes —
            // one rail, one menu, one piece of state — but a phone gets a
            // different geometry, because the band this pill floats in does not
            // exist below sm.
            //
            // It used to be `hidden sm:flex`, full stop. In the Image studio the
            // rail IS the session's results (and in Video, the sequence), so a
            // phone could see the last thing it made and nothing else: every
            // earlier picture in the session had no door but the Library.
            //
            // So below sm it is a strip that scrolls sideways, docked directly
            // on top of the composer and clear of the home indicator. Its height
            // is measured back into --frame-rail-strip, which the stage above
            // reserves, so the picture sits on the strip rather than behind it.
            'absolute z-10 flex gap-2 rounded-[18px] bg-bg0/85 backdrop-blur-xl',
            'shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.07)]',
            // no-scrollbar in both shapes: a 10px desktop scrollbar drawn under
            // a 64px strip or down the side of an 84px pill is most of what you
            // see of it. The cut-off card at the edge is the affordance.
            'no-scrollbar inset-x-3 flex-row items-center overflow-x-auto overscroll-x-contain px-2.5 py-2',
            'bottom-[calc(var(--frame-lift,0px)+var(--frame-composer-h)+env(safe-area-inset-bottom)+22px)]',
            'sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)]',
            'sm:w-[var(--frame-rail-pill-w)] sm:flex-col sm:items-center sm:overflow-x-visible sm:overflow-y-auto sm:px-2 sm:py-3',
          )}
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
      >
        {composer}
      </ComposerFloat>

      {/* ---- footer ---------------------------------------------------- */}
      {footer ? (
        <div className="absolute bottom-3 left-3 z-30 flex items-center gap-1">{footer}</div>
      ) : null}

      {/* ---- advanced drawer, and its tab -------------------------------- */}
      {/* The panel and a binder tab on its outer edge move as ONE piece. Shut,
          the piece is slid its own width to the left: the panel waits off the
          frame and the tab lands on the frame's left edge, the only part of
          Advanced left showing. A press slides it out, and the tab rides the
          panel's edge with its chevron turned round, as the door back in.

          Open is `transform: none` rather than a zero translate. A transformed
          ancestor is a containing block, and nothing inside the drawer has had
          to measure itself against one before.

          Below lg there is no room to push into, so the drawer becomes a sheet
          over a scrim — the same disclosure, a different geometry. */}
      {drawer ? (
        <>
          {drawerOpen ? (
            <button
              type="button"
              aria-label={`Close ${drawerTitle}`}
              className="absolute inset-0 z-30 bg-scrim lg:hidden"
              onClick={onDrawerClose}
            />
          ) : null}
          <div
            className={cx(
              'pointer-events-none absolute inset-y-0 left-0 z-40 flex py-3 pl-3 transition-transform duration-300 ease-swift lg:py-4 lg:pl-4',
              drawerOpen ? 'transform-none' : '-translate-x-full',
            )}
          >
            <aside
              ref={drawerRef}
              id={drawerId}
              role={drawerOpen ? 'dialog' : undefined}
              aria-label={drawerTitle}
              className={cx(
                // overscroll-contain so a flick that reaches the end of the
                // drawer does not carry on into the page behind it, and the
                // home indicator's strip as padding — below lg this is a sheet
                // standing on the bottom edge of the screen.
                'pointer-events-auto flex w-[min(340px,88vw)] shrink-0 flex-col overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] lg:w-[320px] lg:pb-0',
                'rounded-[18px] bg-bg0/85 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.07)] backdrop-blur-xl',
                // Visibility holds through a slide that is leaving and flips at
                // the start of one arriving, so the panel is hidden only once it
                // is off the frame, and nothing in a shut drawer can take focus.
                'transition-[visibility] duration-300',
                drawerOpen ? 'visible' : 'invisible',
              )}
            >
              {drawerBody ? (
                // The aside scrolls, so it clips, and the Runs on list is wider
                // than the drawer. Menus opened in here draw into the frame's
                // menu layer below instead. Only while open: a drawer on its way
                // out takes an open menu with it rather than leaving it hanging.
                <MenuLayer.Provider value={drawerOpen ? menuLayer : null}>
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
                </MenuLayer.Provider>
              ) : null}
            </aside>
            {onDrawerToggle ? (
              <DrawerTab open={drawerOpen} label={drawerTitle} controls={drawerId} onToggle={onDrawerToggle} />
            ) : null}
          </div>
          {/* The drawer's menu layer. Outside the sliding piece, which is
              transformed while it moves and whose panel blurs its backdrop —
              either one makes an ancestor the box a fixed child is placed in
              and clipped by. Inside the studio's root, which is where the
              Image and Video studios listen for the clicks that save settings. */}
          <div ref={setMenuLayer} className="absolute left-0 top-0" data-menu-layer="" />
        </>
      ) : null}
    </div>
  );
}

/* ---------------- the drawer's tab ---------------- */

// Advanced's one door. It used to be an "Advanced →" link after the full stop
// of the recipe sentence: a word at the far end of the composer, for a panel
// that comes out of the other side of the frame. Now the door is on the edge
// the drawer comes out of, and shaped like what it does — a binder tab on the
// drawer's outer edge, flat where it meets the panel (or, shut, the frame's
// edge) and rounded where it sticks out.
function DrawerTab({ open, label, controls, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      title={open ? `Close ${label}` : 'Every remaining control for this studio'}
      data-drawer-tab=""
      // Centred in what is LEFT of the frame once the composer has its share,
      // not in the frame. A plain top-1/2 is the middle of the window, and on a
      // phone the middle of the window is inside the composer: the tab was
      // drawn over the prompt's first characters, because the composer is
      // full-bleed there and the tab outranks it (z-40 over z-30).
      style={{ top: 'calc((100% - var(--frame-composer-h) - var(--frame-lift, 0px)) / 2)' }}
      className={cx(
        // 27px wide is not a door, it is a hint at one — and it sits on the very
        // edge a phone reserves for its own back-swipe. Under a thumb the tab
        // keeps its shape and takes a finger's width of padding.
        'pointer-events-auto absolute left-full flex -translate-y-1/2 flex-col items-center gap-2 py-3 pl-[6px] pr-[7px]',
        'touch:py-5 touch:pl-[12px] touch:pr-[14px]',
        // The house scrim, and a hairline on the three sides that stand clear;
        // the fourth is flush against the panel, or the frame's edge.
        'rounded-r-[12px] border border-l-0 border-white/[0.07] bg-bg0/85 backdrop-blur-xl',
        'shadow-[0_12px_32px_-12px_rgba(0,0,0,0.85)] transition-[padding,color] duration-200 ease-swift',
        // Shut, hovering draws the tab a few pixels further out — it can be pulled.
        open ? 'text-honey' : 'text-inkSoft hover:pr-[10px] hover:text-ink1',
      )}
    >
      <Icon name={open ? 'chevronLeft' : 'chevronRight'} size={14} />
      {/* Bottom to top, the way a spine on a left-hand edge reads. `sideways`
          lays every glyph down the same way, so a Chinese label turns with the
          rest instead of standing upright and then being flipped by the
          rotation. */}
      <span className="rotate-180 whitespace-nowrap font-mono text-[10px] font-semibold uppercase leading-none tracking-[0.14em] [text-orientation:sideways] [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

/* ---------------- the floating composer, and its drop zone ---------------- */

// Lifted from ui/kit.jsx's ComposerSlot, which drew a bordered strip across the
// bottom of a column. The contract is identical (drop.accepts/hint/onDrop/busy)
// and so is the data attribute the window-level restore zone looks for; only the
// geometry differs — it floats, so its drag affordance is a ring on the panel
// rather than a band across the page.
function ComposerFloat({ drop, panelRef, children }) {
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
      // --frame-rail-w, like the stage, the notices and the tab strip: this used
      // to carry its own `${railWidth}px` copy, which no breakpoint could reach.
      //
      // On a phone the panel goes nearly edge to edge (12px, not 22) and lifts
      // clear of the home indicator; `env()` is 0 everywhere that has no inset,
      // so the same expression is simply 12px in a desktop browser.
      className={cx(
        'absolute bottom-[calc(var(--frame-lift,0px)+12px+env(safe-area-inset-bottom))] left-0 z-30 flex justify-center px-3',
        // sm carries the inset too: a phone in landscape is past sm, and that
        // is exactly when the home indicator is at the bottom of a WIDE window.
        'transition-[left] duration-300 ease-swift sm:px-[22px] lg:left-[var(--frame-left)]',
        'sm:bottom-[calc(var(--frame-lift,0px)+22px+env(safe-area-inset-bottom))]',
      )}
      style={{ right: 'var(--frame-rail-w)' }}
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
