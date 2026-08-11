// Expand (outpaint) dialog — pick a wider/taller canvas for a generated image;
// the gateway samples only the missing border and composites the untouched
// source back over the result (Mix-Studio port; centered placement in v1).
import { useEffect, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { computeExpandTarget } from '../../lib/expandGeometry.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, cx } from '../../ui/kit.jsx';

const ASPECTS = ['21:9', '16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '9:16'];

export function ExpandDialog({ entry, busy, onClose, onExpand }) {
  const src = useMediaSrc(entry?.url);
  const [dims, setDims] = useState(null);
  const [aspect, setAspect] = useState(null);
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
            onClick={() => { if (chosen) onExpand({ ...chosen.target, prompt }); }}
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
