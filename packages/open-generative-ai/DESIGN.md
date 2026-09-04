# Hivemind Content Studio — "Hive" Design System (v3)

The single source of truth for the 2026 React redesign. Every ported component follows this.
Tokens live in `src/styles/variables.css`; Tailwind utilities in `tailwind.config.js`; primitives in `src/ui/`.

## 1. Direction

A **precision instrument for media production**. Warm graphite surfaces, hairline borders, one
honey-amber accent, dense-but-calm layouts. No neon glow, no glass blur walls, no giant centered
heroes, no ambient animation. The content (images/video) is the hero; chrome recedes.

- Dark only. Surfaces are warm near-black (`bg-bg0` → `bg-bg3` layers), never pure black.
- **One accent**: honey (`text-honey`, `bg-honey`) for primary actions, active nav, focus, progress.
  Semantic green/red/orange/blue only for status. Never cyan/violet.
- Hairline borders (`border-line1`, hover `border-line2`) define structure; shadows only on overlays.
- Type: Inter for everything; `font-mono` for seeds, ids, dimensions, file sizes, timings.
- Radii: controls/inputs `rounded-md` (10px), cards/panels `rounded-lg` (14px), overlays `rounded-xl` (20px). Never larger.
- Motion: 120–180ms `--ease-swift` on hover/press/enter. Nothing loops forever except explicit
  progress indicators. Respect `prefers-reduced-motion`.

## 2. Layout — workspace-first

The old UI centered a hero header + composer in a void. The new pattern for every studio:

```
┌────────┬──────────────────────────────────────────┐
│        │ Topbar (52px): page title · status · acts │
│ Sidebar├──────────────────────────────────────────┤
│ 216px  │ ┌────────────┐ ┌───────────────────────┐ │
│        │ │ Control    │ │ Canvas / results area │ │
│ groups │ │ panel      │ │ (gallery, viewer,     │ │
│ + labels│ │ 300-340px │ │ empty state)          │ │
│        │ │ scrollable │ │                       │ │
│        │ └────────────┘ └───────────────────────┘ │
│        │  Prompt bar docked at bottom of canvas    │
└────────┴──────────────────────────────────────────┘
```

- **Sidebar** (`Shell.jsx`, already built): labeled nav grouped Create (with a collapsed
  Labs fold) / Produce / a collapsed Advanced group, all driven off `navConfig.jsx` —
  add a page there, not here. Collapses to an icon rail < 1280px (the chevron in the
  footer overrides it, remembered in `studio.sidebarCollapsed`); under `lg` it becomes a
  top chip strip whose folded tiers ride in one More menu. Don't rebuild it.
- **Studio layout**: use `<StudioLayout>` from `src/ui/kit.jsx` — left `panel` slot (params),
  main `children` (results/canvas), optional bottom `composer` slot (prompt bar). It handles
  scrolling, responsive stacking (panel becomes a sheet under `lg`), and empty-state centering.
- **Hub views**: full-bleed content region with a slim toolbar row (title/kicker left, filters right),
  then cards/tables. No page-level hero headers — the topbar already names the page.
- Results/galleries: CSS grid `repeat(auto-fill, minmax(220px, 1fr))`, gap-3; cards are
  `bg-bg2 border border-line1 rounded-lg overflow-hidden`, hover raises to `border-line2`.

## 3. Component recipes (use the primitives, don't hand-roll)

From `src/ui/kit.jsx`:
- `Button` — `variant="primary|neutral|ghost|danger"`, `size="sm|md|lg"`, `icon`, `loading`.
  Primary = honey fill + `text-on-honey` (dark text). ONE primary per view region.
- `IconButton` — square, labelled via `title`/`aria-label`.
- `Field`/`TextInput`/`TextArea`/`NativeSelect` — 36px controls, `bg-bg2`, hairline border,
  honey focus ring. Labels 12px `text-ink2` medium, above the control.
- `Segmented` — pill group for 2–5 exclusive options (aspect ratio, pair mode, filters).
- `Toggle`, `Slider` (honey track fill, mono value readout), `Pill` (`tone="ok|danger|warn|info|honey|neutral"`),
  `SectionLabel` (11px uppercase kicker `text-ink3`), `Card`, `EmptyState`, `Spinner`, `ProgressBar`, `Kbd`.
- `Modal` from `src/ui/Modal.jsx` — portal, scrim `bg-scrim`, `esc`/outside-click close, sizes.
  It moves focus in (first `[autofocus]`/`[data-autofocus]`, else the panel), traps Tab, restores
  focus on close, locks page scroll, and Escape closes only the TOPMOST dialog. `ConfirmModal`
  takes `tone="danger"` (focus lands on Cancel — a stray Enter must never delete) or
  `tone="primary"` (money / irreversible-but-not-destructive: Rent, Stock), `cancelLabel`, and a
  node `body`. Use it for every confirm; `window.confirm` is banned.
- `Menu`/`MenuItem`/`ChipButton` from `src/ui/Menu.jsx` — composer option chips that open
  popover menus (replaces the old `<details>` popovers; closes on outside click). `ChipButton`
  forwards `title`/`aria-*`; `Menu` flips to the other edge and caps its width at the viewport.
- `IconButton` sizes `xs` (24px — dense rows, card corners) / `sm` / `md` / `lg`; never hand-roll
  a `grid h-6 w-6 place-items-center` button.
- `ProgressBar` takes `tone="honey|danger|ok"` + `label`; `Slider` inside a `Field` gets its id.
- `ErrorBoundary` from `src/app/ErrorBoundary.jsx` wraps every studio mount and every hub view;
  a render error shows a contained "X hit an error — Try again / Reload page" panel, never a
  black page. Wrap any new top-level surface the same way.
- Icons from `src/ui/icons.jsx` — one stroke family, `<Icon name size />`. Add missing icons there
  (24×24 viewBox, stroke-width 2, no fills) rather than pasting SVGs in components. No emoji or
  text glyphs (✓ ✕ ↻ ↓ +) as icons — the set has check/x/refresh/download/plus/more/star/…
- Colour tokens are alpha-capable: `border-honey/50`, `bg-bg0/80`, `bg-warn/10` work because
  `tailwind.config.js` maps them through `rgb(var(--x-rgb) / <alpha-value>)`; adding a colour means
  adding its `--x-rgb` triplet in `variables.css`. The tints scale (`bg-honey-tint/50` = half the wash).
- CSS helpers in `base.css`: `hive-edge-fade` (horizontal scrollers that hide their bar but fade
  the clipped edge), `hive-motion-keep` (progress indicators keep moving under reduced motion).

Prompt bar (composer) pattern: a `bg-bg1 border border-line1 rounded-lg` bar with an auto-growing
textarea, left = attach/reference chips, right = model chip + Generate (primary). Options that
were pill-soup become `ChipButton`+`Menu` groups with clear labels and current-value readouts.

## 4. States

- Loading: `Spinner` inline or skeleton `bg-bg2 animate-pulse rounded` blocks. Progress with a real
  percentage uses `ProgressBar` + mono percent.
- Empty: `EmptyState` with an icon, one sentence, and (when sensible) one action. No walls of tips.
- Errors: `FailureCallout` from `src/ui/kit.jsx` — one translated sentence, the button that repairs
  it (`remedy`), a way out (Try again / Dismiss), and the raw/technical text under a collapsed
  `Details` disclosure in `font-mono text-xs`. Never lead with the provider's or the backend's own
  words: `describeFailure(error, { transport, operation })` in `src/lib/describeFailure.js` writes
  the sentence and names the repair, and `toastFailure` is the same reading where there is no room
  for a callout. Inline `Pill tone="danger"` still covers a one-word state. Never `alert()` — use
  `toast.error(...)` (the `Toaster` in `App.jsx` sets one baseline: notices 4.5 s, success 3.5 s,
  errors 6 s — only override for genuinely long copy). Show a failure once (callout OR toast, not
  both), and never present a problem in a place where its fix could have been offered instead.
- Destructive confirms: `ConfirmModal` — one consistent pattern everywhere (tone above).
- Keyboard: ⌘/Ctrl+Enter generates in every composer; ⌘/Ctrl+, opens Settings; Escape closes the
  topmost layer; Space and Enter both activate `role="button"` tiles; hover-only actions also show
  on `focus-within`.

## 5. Hard rules (from the port maps — breaking these breaks the product)

1. `src/lib/**` is shared logic — edit it deliberately and with a node test; the crypto modules
   (e2eVault/e2eMedia/vaultSession/composerState) and every wire shape stay byte-for-byte
   compatible. (The original port rule was "immutable"; that ended once the port finished.)
2. Every fetch route, storage key, window event, postMessage type, and payload shape in your area's
   spec (`specs/*.json`) survives verbatim. Media `<img>/<video>` srcs go through
   `useMediaSrc` (wraps `resolveMediaSrc`) so E2E-encrypted media keeps decrypting client-side.
3. i18n: keep every `t()`/`tf()` key and `zh()` ternary. New strings you introduce: English + add
   the same inline `zh()` pattern where surrounding code does. `setLang` keeps its reload behavior.
4. Studios mount once on first visit and are display-toggled after that, so an in-flight
   generation survives a page switch; re-clicking the active tab is a no-op; hub views stay
   mounted forever once visited (iframes must never reload on tab switch).
5. No new deps. React 19 + react-hot-toast + existing libs only. Plain `.jsx` — no TypeScript.
6. Preserve fail-open behaviors exactly (e2eMedia falls back to raw URL; unknown local model must
   not disable upload; muapi 5xx keeps polling; etc. — your spec lists them).

## 6. Names — one product, one word for it

A consumer installed one thing. Running copy calls it **the studio** and never names the parts.

- **The app**: "Hivemind Content Studio" in the title bar, the sidebar mark and About. Everywhere
  else it is "the studio" — lower case, no product name in the middle of a sentence.
- **The backend**: never named to the user. There is no "Studio API", no "Media Studio", no
  "Hivemind Media Studio", no "control API". The state pill says `Ready` / `Starting` /
  `Not running`; a failure says "The studio could not …", never "Media Studio generation failed".
  (`src/app/statusStore.js` owns those three words, and the offline sentence with its fix.)
- **HivemindOS** appears only when the user has to go there — credits, balances, sign-in.
- **The one exception**: the Agents & API page may say "the built-in media MCP server" once,
  because an agent author is configuring a server and needs the technical noun.
- **Third-party providers** keep their own spelling, one way each: `MUAPI` (never "Muapi"),
  `Higgsfield`, `Civitai`, `ComfyUI`.

`tests/appNames.test.js` greps the user-facing strings for the retired names.
