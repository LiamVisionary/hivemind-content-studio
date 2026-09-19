// The right edge — the tracks this session has made, newest at the top.
//
// A track has no picture, so the card carries what a picture would have: the
// length, and a note mark that goes honey while it is the one on the stage.
// That is the RestoreRail precedent rather than a new one — RailCard already
// draws nothing when it is given no `src`, and a column of stamp-sized
// waveforms would cost more than the rail is worth.
//
// Pressing a card puts that track on the stage, where the player is. There is
// deliberately no second transport here: two play buttons on one page is how
// you end up with two tracks playing at once.
import { RailCard, RailEmpty, RailHeading } from '../frame/ResultsRail.jsx';
import { formatTrackLength } from '../../lib/musicLane.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

const CARD_W = 72;
const CARD_ASPECT = '1 / 1';

/**
 * @param {array}  tracks   [{ id, title, seconds, playing }], newest first
 * @param {string} activeId the one on the stage
 */
export function MusicRail({ tracks = [], activeId = '', onOpen }) {
  return (
    <>
      <RailHeading>Tracks</RailHeading>
      {tracks.length === 0 ? (
        <RailEmpty>Nothing made in this tab yet</RailEmpty>
      ) : null}
      {tracks.map((track, index) => {
        const selected = track.id === activeId;
        return (
          <RailCard
            key={track.id}
            width={CARD_W}
            aspect={CARD_ASPECT}
            selected={selected}
            caption={formatTrackLength(track.seconds)}
            label={track.title ? `${track.title} — ${formatTrackLength(track.seconds)}` : `Track ${tracks.length - index}`}
            onClick={() => onOpen(track)}
          >
            <span
              className={cx(
                'pointer-events-none absolute inset-0 grid place-items-center',
                selected ? 'text-honey' : 'text-ink3',
              )}
            >
              <Icon name="music" size={20} />
            </span>
          </RailCard>
        );
      })}
    </>
  );
}
