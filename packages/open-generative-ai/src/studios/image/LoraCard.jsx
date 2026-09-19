// The LoRA catalog card, and its preview.
//
// Extracted from LoraSection so the two places that show installed LoRAs as
// picture cards are the same component rather than two that look alike: the
// studios' LoRA panel, and the rental-build page's picker. A card that drifted
// would teach the same click two different meanings.
//
// Presentational and uncontrolled: selection, keyboard and the press-origin
// guard live here because they are the card's behaviour; everything drawn ON
// the card (the update menu, the rental control, a download's progress bar)
// arrives as children, because those belong to whoever is showing the card.
import { useEffect, useRef, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

export function LoraPreview({ lora, className = '' }) {
  const src = useMediaSrc(lora.previewUrl || '');
  // Was `onError={(e) => e.currentTarget.remove()}`, which ripped the node out from
  // under React: one transient failure became permanent, no re-render could bring the
  // art back, and it erased the evidence that anything had failed. Fall back to the
  // label instead, and re-arm whenever the source changes.
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);

  return (
    <div className={cx('flex items-center justify-center overflow-hidden bg-bg3 text-[10px] font-semibold text-ink3', className)}>
      {lora.previewUrl && !failed ? (
        <img
          src={src}
          alt={`${lora.displayName || lora.name} preview`}
          // Deliberately NOT loading="lazy". This grid lives in a settings panel that
          // frequently does not scroll at all, and Chrome defers a lazy image until a
          // scroll or resize re-triggers its evaluation — in a non-scrollable panel
          // that never happens, so the art never loaded. Measured: these images sat at
          // currentSrc="" with ZERO network requests while fully in view; flipping the
          // one attribute to eager fired all seven immediately. The catalog is a
          // bounded set behind an explicit Show toggle, so eager is right here.
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>LoRA</span>
      )}
    </div>
  );
}

// A press that STARTED on an inner control belongs to that control, not to the
// card behind it. Drag-selecting the weight in a selected row and releasing over
// the row makes the browser fire `click` on their common ancestor — the row — so
// the input's own stopPropagation never sees it and the LoRA got muted mid-edit.
// Shared by the cards and by LoraSection's selected rows, which have the same
// shape of problem.
export function usePressOrigin() {
  const pressOrigin = useRef(null);
  return {
    notePress: (e) => { pressOrigin.current = e.target; },
    pressStartedOnControl: () => {
      const origin = pressOrigin.current;
      pressOrigin.current = null;
      return Boolean(origin?.closest?.('input, button, [role="group"]'));
    },
  };
}

export function LoraCard({
  lora,
  selected,
  onToggle,
  title,
  // The line under the name. Defaults to what the studios show — the first
  // trigger word, else the base-model family.
  subtitle,
  // Bottom-right cluster (a version label, an Update button, a status line).
  meta = null,
  // Drawn over the card: menus, progress, anything owned by the caller.
  children,
  className = '',
  highlighted = false,
}) {
  const label = lora.displayName || lora.name;
  const { notePress, pressStartedOnControl } = usePressOrigin();
  return (
    // Not a <button>: the card holds overlay menus, which cannot nest inside one.
    <div
      role="button"
      tabIndex={0}
      data-lora-id={lora.id}
      aria-pressed={selected}
      title={title || (selected ? `Unload ${label}` : `Use ${label}`)}
      onPointerDown={notePress}
      onClick={() => { if (!pressStartedOnControl()) onToggle(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
      }}
      className={cx(
        // No overflow-hidden: it would clip an overlay menu. The preview clips
        // itself, so the card corners still look right.
        'relative min-w-0 cursor-pointer rounded-md border text-left transition-colors duration-150',
        selected
          ? 'border-honey bg-honey-tint'
          : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
        highlighted && 'border-honey/60',
        className,
      )}
    >
      <LoraPreview lora={lora} className="aspect-[4/3] w-full rounded-t-[5px]" />
      <div className="p-2 pb-5">
        <div className="truncate text-xs font-semibold text-ink1">{label}</div>
        <div className="mt-0.5 truncate text-[10px] text-ink3">
          {subtitle === undefined ? (lora.triggerWords?.[0] || lora.baseModel) : subtitle}
        </div>
      </div>

      {meta ? <div className="absolute bottom-1 right-1.5 flex items-center gap-1">{meta}</div> : null}

      <span
        className={cx(
          'absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border text-ink1',
          selected ? 'border-honey bg-honey text-on-honey' : 'border-line2 bg-bg0/70',
        )}
      >
        <Icon name={selected ? 'check' : 'plus'} size={12} />
      </span>

      {children}
    </div>
  );
}
