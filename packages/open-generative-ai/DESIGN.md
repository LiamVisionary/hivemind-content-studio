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

- **Sidebar** (`Shell.jsx`, already built): labeled nav grouped Studios / Produce / System.
  Collapses to icon rail < 1280px, bottom tab bar on mobile. Don't rebuild it.
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
- `Menu`/`MenuItem`/`ChipButton` from `src/ui/Menu.jsx` — composer option chips that open
  popover menus (replaces the old `<details>` popovers; closes on outside click).
- Icons from `src/ui/icons.jsx` — one stroke family, `<Icon name size />`. Add missing icons there
  (24×24 viewBox, stroke-width 2, no fills) rather than pasting SVGs in components.

Prompt bar (composer) pattern: a `bg-bg1 border border-line1 rounded-lg` bar with an auto-growing
textarea, left = attach/reference chips, right = model chip + Generate (primary). Options that
were pill-soup become `ChipButton`+`Menu` groups with clear labels and current-value readouts.

## 4. States

- Loading: `Spinner` inline or skeleton `bg-bg2 animate-pulse rounded` blocks. Progress with a real
  percentage uses `ProgressBar` + mono percent.
- Empty: `EmptyState` with an icon, one sentence, and (when sensible) one action. No walls of tips.
- Errors: inline `Pill tone="danger"` or a bordered `bg-danger-tint` callout with the raw message in
  `font-mono text-xs`. Never `alert()` — replace `alert(...)` calls with `toast.error(...)`
  (react-hot-toast is styled in `main.jsx`) unless a spec says the flow depends on blocking.
- Destructive confirms: `Modal` with `Button variant="danger"` — one consistent pattern everywhere.

## 5. Hard rules (from the port maps — breaking these breaks the product)

1. `src/lib/**` is IMMUTABLE. Import it; never edit it. All crypto (e2eVault/e2eMedia/vaultSession/
   composerState), muapi, localInferenceClient, hivemindStudio, pendingJobs, i18n stay byte-identical.
2. Every fetch route, storage key, window event, postMessage type, and payload shape in your area's
   spec (`specs/*.json`) survives verbatim. Media `<img>/<video>` srcs go through
   `useMediaSrc` (wraps `resolveMediaSrc`) so E2E-encrypted media keeps decrypting client-side.
3. i18n: keep every `t()`/`tf()` key and `zh()` ternary. New strings you introduce: English + add
   the same inline `zh()` pattern where surrounding code does. `setLang` keeps its reload behavior.
4. Studios remount on navigation (fresh state, re-run discovery); re-clicking the active tab is a
   no-op; hub views stay mounted forever once visited (iframes must never reload on tab switch).
5. No new deps. React 19 + react-hot-toast + existing libs only. Plain `.jsx` — no TypeScript.
6. Preserve fail-open behaviors exactly (e2eMedia falls back to raw URL; unknown local model must
   not disable upload; muapi 5xx keeps polling; etc. — your spec lists them).
