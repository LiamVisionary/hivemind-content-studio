// The completion chime, as one control every studio can render beside Generate.
//
// lib/completionPing.js owns a single app-wide value, but for months the only
// toggles were the last row of the Image and Video Advanced sections: a Lipsync
// or Restore user could not reach it at all, and nobody looks for a sound
// setting under "Advanced". This puts it where its outcome is felt.
//
// It subscribes to the store itself, so two studios open in two tabs stay in
// step without either of them mirroring the value into their own state.
import { useEffect, useState } from 'react';

import {
  isCompletionPingEnabled, playCompletionPing, setCompletionPingEnabled, subscribeCompletionPing,
} from '../lib/completionPing.js';
import { t } from '../lib/i18n.js';
import { Icon } from './icons.jsx';
import { cx } from './kit.jsx';

export function CompletionPingToggle({ className = '' }) {
  const [on, setOn] = useState(isCompletionPingEnabled);
  useEffect(() => subscribeCompletionPing(setOn), []);

  const toggle = () => {
    const next = setCompletionPingEnabled(!on);
    setOn(next);
    // Turning it on plays it once — otherwise the only way to know what you
    // just armed is to wait out a generation.
    if (next) void playCompletionPing();
  };

  const label = t('common.pingWhenComplete');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={on ? `${label} — on` : `${label} — off`}
      onClick={toggle}
      className={cx(
        'grid h-9 w-9 shrink-0 place-items-center rounded-md border transition-colors duration-150',
        on
          ? 'border-honey/50 bg-honey-tint text-honey'
          : 'border-line1 bg-bg2 text-ink3 hover:border-line2 hover:text-ink1',
        className,
      )}
    >
      <Icon name={on ? 'sound' : 'mute'} size={15} />
    </button>
  );
}
