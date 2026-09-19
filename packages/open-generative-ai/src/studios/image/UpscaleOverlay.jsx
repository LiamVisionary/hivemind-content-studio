// "This picture is being upscaled" — said on the picture, not in the corner.
//
// An upscale used to report itself through a toast at the bottom-right of the
// window: a spinner that named no picture, while the three surfaces that draw
// the result (the viewer, the stage, the rail) all carried on looking idle. So
// the mark moved onto the subject. A spectrum travels the rim of the image and
// a badge sits in the middle of it saying what is happening and for how long.
//
// Drop it into the element that BOUNDS the picture — the rim is `inset: 0` on
// this overlay, so its parent's box is the rim's box. That parent needs
// `relative`; give the overlay the parent's corner radius when it has one
// (`rounded-[12px]` on the stage), because the ring inherits it.
//
// The colour and the CSS live in styles/base.css (`.spectral-rim`,
// `.spectral-ring`), beside the note explaining why this one indicator is
// allowed to loop and to leave the honey accent.
import { useEffect, useState } from 'react';

import { formatElapsed } from '../../lib/genProgress.js';
import { cx } from '../../ui/kit.jsx';

// Max quality adds a diffusion refine on top of R-ESRGAN and runs for minutes
// rather than seconds. Worth saying up front: an indeterminate loader with no
// idea of the scale is how a working render starts reading as a hung one.
export const UPSCALE_MODE_NOTE = {
  fast: '',
  max: 'max quality — this can take a couple of minutes',
};

/** The live count-up. Its own state so the second hand repaints this and nothing else. */
function Elapsed({ startedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // setInterval, not rAF: a background tab stops handing out frames, and a
    // timer that stops counting reads as a run that stopped running.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!startedAt) return null;
  return <span>{formatElapsed(now - startedAt)}</span>;
}

/**
 * @param {string} mode      'fast' | 'max' — only the note differs
 * @param {number} startedAt Date.now() at the press, for the count-up
 * @param {bool}   label     false on a 48px rail card: the rim alone, no badge
 * @param {string} className the parent's corner radius, when it has one
 */
export function UpscaleOverlay({ mode = 'fast', startedAt = 0, label = true, className = '' }) {
  const note = UPSCALE_MODE_NOTE[mode] || '';
  return (
    <div
      className={cx(
        'spectral-rim hive-motion-keep pointer-events-none absolute inset-0 z-20 grid place-items-center',
        className,
      )}
      // The rim is decoration; the badge is the sentence. A card with no badge
      // announces nothing rather than announcing an empty region.
      role={label ? 'status' : undefined}
      aria-live={label ? 'polite' : undefined}
      aria-hidden={label ? undefined : 'true'}
    >
      {label ? (
        // The house treatment for a floating surface over a picture: a scrim
        // with a real blur behind it. A tint alone is see-through over art.
        <div className="flex max-w-[min(86%,17rem)] flex-col items-center gap-2 rounded-xl border border-line1 bg-bg0/85 px-5 py-4 text-center shadow-overlay backdrop-blur-xl">
          <span className="spectral-ring hive-motion-keep h-7 w-7" />
          <span className="text-[12.5px] font-medium text-ink1">Upscaling…</span>
          <span className="font-mono text-[10.5px] text-inkSoft">
            <Elapsed startedAt={startedAt} />
          </span>
          {/* Its own line, wrapped: on the same line as the clock it stretched
              the badge into a bar wider than a portrait picture. */}
          {note ? <span className="text-[11px] leading-snug text-ink3">{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
