// Emotion / performance picker — one acting study at a time, applied to the
// prompt as an idempotent "Performance: …" phrase (switching replaces, never
// stacks), exactly like the Style picker beside it.
//
// 25 studies is too many to scan as a flat list, so the popover carries the
// guide's own two axes: family down the list, intensity as a filter across the
// top. Data and the composer live in src/lib/emotionDirection.js — including
// which text a model gets, since H3 reads a rewrite that names the sound.
import { useState } from 'react';
import {
  EMOTION_DIRECTIONS,
  EMOTION_FAMILIES,
  EMOTION_INTENSITIES,
  emotionDirectionById,
} from '../../lib/emotionDirection.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';

const INTENSITY_TONE = {
  subtle: 'text-ink3',
  medium: 'text-ink2',
  explosive: 'text-honey',
};

export function EmotionMenu({ activeId, onApply }) {
  const active = emotionDirectionById(activeId);
  const [intensity, setIntensity] = useState('all');
  const shown = EMOTION_DIRECTIONS.filter((entry) => intensity === 'all' || entry.intensity === intensity);

  return (
    <Menu
      up
      width="w-[23rem] max-w-[calc(100vw-1.5rem)]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="persona"
          label="Emotion"
          value={active ? active.label : ''}
          active={open || Boolean(active)}
          onClick={toggle}
          title="Pick a performance direction — appended to the prompt as one phrase, switching replaces it"
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 pb-1">
            {['all', ...EMOTION_INTENSITIES].map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setIntensity(level)}
                className={cx(
                  'rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors',
                  level === intensity
                    ? 'border-honey/50 bg-honey-tint text-honey'
                    : 'border-line1 bg-bg1 text-ink3 hover:border-line2 hover:text-ink2',
                )}
              >
                {level}
              </button>
            ))}
          </div>

          {/* Nine families is taller than the popover can be on a laptop, so the
              list scrolls while the filters and Clear stay pinned. */}
          <div className="max-h-[46vh] overflow-y-auto">
            {EMOTION_FAMILIES.map((family) => {
              const entries = shown.filter((entry) => entry.family === family);
              if (!entries.length) return null;
              return (
                <div key={family}>
                  <div className="px-1.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
                    {family}
                  </div>
                  <div className="flex flex-col gap-1">
                    {entries.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => { onApply(entry.id === activeId ? null : entry.id); close(); }}
                        title={entry.prompt}
                        className={cx(
                          'flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors',
                          entry.id === activeId
                            ? 'border-honey/50 bg-honey-tint'
                            : 'border-line1 bg-bg1 hover:border-line2 hover:bg-bg2',
                        )}
                      >
                        <span className="flex w-full items-baseline gap-2">
                          <span className={cx('text-[12px] font-semibold', entry.id === activeId ? 'text-honey' : 'text-ink1')}>
                            {entry.label}
                          </span>
                          <span className={cx('ml-auto shrink-0 text-[9px] font-semibold uppercase tracking-[0.06em]', INTENSITY_TONE[entry.intensity])}>
                            {entry.intensity}
                          </span>
                        </span>
                        <span className="text-[10px] text-ink3">{entry.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {active ? (
            <button
              type="button"
              onClick={() => { onApply(null); close(); }}
              className="mt-1 rounded-md border border-line1 bg-bg1 px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink1 transition-colors hover:border-line2"
            >
              Clear performance
            </button>
          ) : null}
        </div>
      )}
    </Menu>
  );
}
