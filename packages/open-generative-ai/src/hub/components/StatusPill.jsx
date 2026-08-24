// Shared status → Pill tone mapping for runs, steps, attempts, and generation
// stages. Keeps the honey-for-active / semantic-for-terminal language of the
// design system in one place so every hub view reads the same.
import { Pill } from '../../ui/kit.jsx';
import { humanize } from '../hubData.js';

const TONE = {
  completed: 'ok',
  complete: 'ok',
  ready: 'ok',
  success: 'ok',
  succeeded: 'ok',
  done: 'ok',
  running: 'honey',
  active: 'honey',
  generating: 'honey',
  in_progress: 'honey',
  started: 'honey',
  processing: 'honey',
  failed: 'danger',
  error: 'danger',
  cancelled: 'warn',
  canceled: 'warn',
  waiting: 'neutral',
  pending: 'neutral',
  queued: 'neutral',
  idle: 'neutral',
};

export function statusTone(status) {
  return TONE[String(status || '').toLowerCase()] || 'neutral';
}

// Label falls back to the status in sentence case: "awaiting_generation" reads
// "Awaiting generation", not "Awaiting_generation".
export function StatusPill({ status, label, dot = true, className = '' }) {
  return (
    <Pill tone={statusTone(status)} dot={dot} className={className}>
      {label ?? humanize(status)}
    </Pill>
  );
}
