// Expand (outpaint) dialog — pick a wider/taller canvas for a generated image;
// the gateway samples only the missing border and composites the untouched
// source back over the result (Mix-Studio port; centered placement in v1).
import { useEffect, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { computeExpandTarget } from '../../lib/expandGeometry.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, cx } from '../../ui/kit.jsx';

const ASPECTS = ['21:9', '16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '9:16'];

// Where the SOURCE sits on the grown canvas. The offset fraction is the share
// of new canvas placed BEFORE the source: 0 pins the source at the start of
// the growth axis (growth extends after it), 1 pins it at the end.
const ANCHORS = [
  { id: 'start', fraction: 0 },
  { id: 'center', fraction: 0.5 },
  { id: 'end', fraction: 1 },
];

export function ExpandDialog({ entry, busy, onClose, onExpand }) {
  const src = useMediaSrc(entry?.url);
  const [dims, setDims] = useState(null);
  const [aspect, setAspect] = useState(null);
  const [anchor, setAnchor] = useState('center');
  const [prompt, setPrompt] = useState(entry?.prompt || '');

  // Source dimensions come from the decrypted pixels, not metadata — edit
  // engines snap to their own buckets, so recorded dims can lie.
  useEffect(() => {
    if (!src) return undefined;
    const probe = new Image();
    probe.onload = () => setDims({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.src = src;
    return () => { probe.onload = null; };
  }, [src]);

  const options = dims
    ? ASPECTS.map((a) => ({ aspect: a, target: computeExpandTarget(dims.width, dims.height, a) }))
        .filter((o) => o.target)
    : [];
  const chosen = options.find((o) => o.aspect === aspect) || null;
  // Which axis grows decides the anchor labels (and whether placement shows).
  const growsX = chosen && dims ? chosen.target.width / chosen.target.height > dims.width / dims.height : false;
  const anchorLabels = growsX
    ? { start: 'Left', center: 'Center', end: 'Right' }
    : { start: 'Top', center: 'Middle', end: 'Bottom' };
  const anchorFraction = ANCHORS.find((a) => a.id === anchor)?.fraction ?? 0.5;

  return (
    <Modal open onClose={busy ? undefined : onClose} title="Expand the canvas" size="md" dismissable={!busy}
      footer={
        <>
          <ActionButton variant="neutral" label="Cancel" onClick={onClose} disabled={busy} />
          <ActionButton
            variant="primary"
            icon="external"
            loading={busy}
            label={busy ? 'Expanding…' : chosen ? `Expand to ${chosen.target.width}×${chosen.target.height}` : 'Pick a shape'}
            onClick={() => {
              if (!chosen) return;
              onExpand({
                ...chosen.target,
                prompt,
                // Only the growth axis takes the anchor; the other stays centered.
                offsetX: growsX ? anchorFraction : 0.5,
                offsetY: growsX ? 0.5 : anchorFraction,
              });
            }}
            disabled={busy || !chosen}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink3">
          Your image keeps its pixels, centered on a larger canvas; only the new border is
          generated{dims ? ` (source ${dims.width}×${dims.height})` : ''}.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o.aspect}
              type="button"
              onClick={() => setAspect(o.aspect)}
              title={`${o.target.width}×${o.target.height}`}
              className={cx(
                'rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                aspect === o.aspect
                  ? 'border-honey bg-honey-tint text-honey'
                  : 'border-line1 bg-bg1 text-ink1 hover:border-line2',
              )}
            >
              {o.aspect}
            </button>
          ))}
          {dims && !options.length ? (
            <span className="text-xs text-ink3">Every preset matches this image&apos;s shape already — nothing to expand into.</span>
          ) : null}
        </div>
        {chosen ? (
          <div>
            <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Keep the image at</div>
            <div className="flex flex-wrap gap-1.5">
              {ANCHORS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setAnchor(option.id)}
                  disabled={busy}
                  className={cx(
                    'rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                    anchor === option.id
                      ? 'border-honey bg-honey-tint text-honey'
                      : 'border-line1 bg-bg1 text-ink1 hover:border-line2',
                    busy && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {anchorLabels[option.id]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Scene description (guides the new border)</span>
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the scene so the extension continues it naturally"
            className="w-full resize-none rounded-md border border-line1 bg-bg0 px-2.5 py-2 text-[13px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 focus:border-honey/50"
          />
        </label>
      </div>
    </Modal>
  );
}
