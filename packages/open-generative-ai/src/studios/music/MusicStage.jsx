// The Music stage — what a track looks like when there is nothing to look at.
//
// Every other studio's stage is the picture it made. Music has no picture, so
// the plate IS the readout: the title, the length, what made it, and a real
// <audio controls> the browser draws its own transport into. The plate is
// deliberately the same rounded, blurred material as the composer floating
// under it, and it is sized like a wide card rather than an aspect box — a
// 16:9 hole with a 40px player in the middle of it reads as a broken video.
//
// The mid-render readout is studios/frame/Stage.jsx's StageProgress, unchanged,
// so a music render says its phase, its percentage and its Cancel in exactly
// the shape the image and video renders do.
import { StageEmpty, StageProgress } from '../frame/Stage.jsx';
import { VaultLockedTile } from '../../hub/components/MediaThumb.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Button, cx } from '../../ui/kit.jsx';

/** The plate a finished or running track sits on. */
function Plate({ children, busy = false, className = '' }) {
  return (
    <div
      className={cx(
        'relative w-full max-w-[620px] overflow-hidden rounded-[16px] bg-bg2 px-6 pb-6 pt-7',
        busy && 'shadow-[0_0_0_1px_rgba(246,178,27,0.3)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * @param {string} title      what this track was asked for (the style line)
 * @param {string} src        the resolved, decrypted media src — '' while it resolves
 * @param {string} lengthText the length that was asked for, "1:00"
 * @param {string} metaText   the model, and how long it really took
 * @param {bool}   instrumental  said out loud, because an empty lyrics box is a decision
 * @param {object} audioRef   forwarded to the element, so the studio can stop it
 * @param {string} sealed     'locked' | 'undecryptable' when this tab has no key for it
 */
export function MusicStage({
  title = '',
  src = '',
  lengthText = '',
  metaText = '',
  instrumental = false,
  audioRef = null,
  sealed = '',
  busy = false,
  phase = '',
  percent = null,
  subject = '',
  timing = '',
  note = '',
  restriction = '',
  onCancel = null,
  empty = null,
}) {
  if (busy) {
    return (
      <Plate busy className="pb-0">
        <div className="flex items-center gap-3 pb-24">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-honey/[0.14] text-honey">
            <Icon name="music" size={19} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-medium text-ink1">{title || 'Your track'}</span>
            <span className="block truncate text-[12px] text-inkSoft">
              {[lengthText, instrumental ? 'instrumental' : 'with vocals'].filter(Boolean).join(' · ')}
            </span>
          </span>
        </div>
        <StageProgress
          phase={phase}
          percent={percent}
          subject={subject}
          timing={timing}
          note={note}
          onCancel={onCancel}
          cancelLabel="Stop"
        />
      </Plate>
    );
  }

  if (!src) return empty;

  return (
    <Plate>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-honey/[0.14] text-honey">
          <Icon name="music" size={19} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink1">{title || 'Your track'}</span>
          <span className="block truncate font-mono text-[11px] text-inkSoft">
            {[lengthText, instrumental ? 'instrumental' : 'with vocals', metaText].filter(Boolean).join(' · ')}
          </span>
        </span>
      </div>
      {/* Every track is sealed to a vault on disk, and resolveMediaSrc fails
          OPEN — it hands back the envelope URL when this tab holds no key. An
          <audio> pointed at that sits at readyState 0 looking exactly like a
          render that produced nothing, so the lock says which it is, and the
          tile itself is the door to unlocking. */}
      {sealed ? (
        <div className="mt-5 h-[72px] overflow-hidden rounded-[10px]">
          <VaultLockedTile reason={sealed} />
        </div>
      ) : (
        /* The browser's own transport. It carries play, scrub, volume and the
           time readout, all of which a hand-drawn bar would have to rebuild
           worse — and the <audio> element is also what makes the track reachable
           by keyboard and by a screen reader without any work here. */
        <audio
          ref={audioRef}
          src={src}
          controls
          preload="metadata"
          className="mt-5 h-10 w-full"
        />
      )}
      {/* Rides with the FINISHED track, not just the empty state: the moment a
          non-commercial licence matters is the moment somebody downloads the
          song and puts it behind an ad. */}
      {restriction ? (
        <p className="mt-3 text-[11px] leading-relaxed text-ink3">{restriction}</p>
      ) : null}
    </Plate>
  );
}

/**
 * The stage before anything has been made — and, on a first run, the one place
 * the missing checkpoint is both explained and repaired.
 *
 * `install` is the whole point: a state that says something is wrong and offers
 * nothing is a dead end, and "download 10 GB" is exactly the wrong thing to
 * send somebody to a document for.
 */
export function MusicStageEmpty({ title, hint, install = null, licence = '' }) {
  return (
    <div className="flex max-w-[520px] flex-col items-center gap-4">
      <StageEmpty
        icon="music"
        title={title}
        hint={hint}
        action={install ? (
          <Button icon="download" onClick={install.onClick} disabled={install.disabled}>
            {install.label}
          </Button>
        ) : null}
      />
      {licence ? (
        <p className="px-6 text-center text-[11px] leading-relaxed text-ink3">{licence}</p>
      ) : null}
    </div>
  );
}
