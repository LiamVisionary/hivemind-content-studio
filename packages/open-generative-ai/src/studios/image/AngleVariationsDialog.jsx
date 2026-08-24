// Angle variations (Mix-Studio "camera variation mode" port) — re-render the
// same subject from several viewpoints in one run. Pick azimuths (each becomes
// one edit), one elevation, one framing; the runner executes them sequentially
// and the results land in the gallery as a labeled group, each paired with the
// source for Compare.
import { useState } from 'react';
import {
  ANGLE_AZIMUTHS,
  ANGLE_DISTANCES,
  ANGLE_ELEVATIONS,
} from '../../lib/editAngles.js';
import { Modal } from '../../ui/Modal.jsx';
import { ActionButton, Field, TextArea, cx } from '../../ui/kit.jsx';

// Compass order for the picker — reads as a walk around the subject.
const AZIMUTH_ORDER = ['front', 'front-right', 'right', 'back-right', 'back', 'back-left', 'left', 'front-left'];

function Chip({ active, label, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors',
        active ? 'border-honey bg-honey-tint text-honey' : 'border-line1 bg-bg1 text-ink1 hover:border-line2',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
    </button>
  );
}

export function AngleVariationsDialog({ entry, modelName, busy, progress, onClose, onRun }) {
  const [views, setViews] = useState(['front-right', 'right', 'back']);
  const [elevation, setElevation] = useState('eye-level');
  const [distance, setDistance] = useState('medium shot');
  const [extra, setExtra] = useState('');

  const toggleView = (view) => {
    setViews((prev) => (prev.includes(view) ? prev.filter((v) => v !== view) : [...prev, view]));
  };

  return (
    <Modal open onClose={busy ? undefined : onClose} title="Angle variations" size="lg" dismissable={!busy}
      footer={
        <>
          <ActionButton variant="neutral" label={busy ? 'Stop after this shot' : 'Cancel'} onClick={onClose} />
          <ActionButton
            variant="primary"
            icon="camera"
            loading={busy}
            label={busy
              ? (progress || 'Rendering…')
              : `Render ${views.length} viewpoint${views.length === 1 ? '' : 's'}`}
            disabled={busy || !views.length}
            onClick={() => onRun({
              angles: views.map((view) => ({ view, elevation, distance })),
              extraPrompt: extra,
            })}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-relaxed text-ink3">
          Each selected viewpoint re-renders this image&apos;s subject from that angle
          ({modelName}). One edit per viewpoint, run in order — results group in the gallery.
        </p>
        <div>
          <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Viewpoints ({views.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {AZIMUTH_ORDER.map((view) => (
              <Chip key={view} active={views.includes(view)} label={ANGLE_AZIMUTHS[view]} onClick={() => toggleView(view)} disabled={busy} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Elevation</div>
            <div className="flex flex-wrap gap-1.5">
              {ANGLE_ELEVATIONS.map((option) => (
                <Chip key={option} active={elevation === option} label={option} onClick={() => setElevation(option)} disabled={busy} />
              ))}
            </div>
          </div>
          <div>
            <div className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">Framing</div>
            <div className="flex flex-wrap gap-1.5">
              {ANGLE_DISTANCES.map((option) => (
                <Chip key={option} active={distance === option} label={option} onClick={() => setDistance(option)} disabled={busy} />
              ))}
            </div>
          </div>
        </div>
        <Field label="Extra guidance (optional)">
          <TextArea
            rows={2}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            disabled={busy}
            placeholder="Anything to keep or emphasize while the viewpoint changes"
          />
        </Field>
        {entry?.prompt ? (
          <p className="truncate text-[11px] text-ink3" title={entry.prompt}>Source prompt: {entry.prompt}</p>
        ) : null}
      </div>
    </Modal>
  );
}
