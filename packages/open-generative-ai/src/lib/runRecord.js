// How a production whose record cannot be read is presented.
//
// GET /api/runs answers with a DEGRADED envelope for such a row instead of
// failing the whole list — one run whose manifest had moved used to take
// Productions down with a 500, so the owner saw nothing at all. This is the
// single reading of that envelope, shared by the list card and the detail
// pane: the sentence a person can act on, the hint that says what to do, and
// the technical tail, which stays behind the callout's Details disclosure and
// is never the sentence itself.
//
// Pure (no React) like the rest of src/lib, so every branch is testable in node.
import { t } from './i18n.js';

const TITLES = {
  missing: 'runs.recordMissingTitle',
  sealed: 'runs.recordSealedTitle',
};

const HINTS = {
  missing: 'runs.recordMissingHint',
  sealed: 'runs.recordSealedHint',
};

/**
 * `{ reason, title, hint, detail }` when this run's record is unreadable,
 * `null` when the run is fine. Everything else about such a run — its steps,
 * its status, its history — is still true and still shown.
 */
export function runRecordFailure(run) {
  if (!run || run.record_status !== 'unreadable') return null;
  const failure = run.record_failure && typeof run.record_failure === 'object' ? run.record_failure : {};
  const reason = String(failure.reason || 'unreadable');
  return {
    reason,
    title: t(TITLES[reason] || 'runs.recordUnreadableTitle'),
    hint: t(HINTS[reason] || 'runs.recordUnreadableHint'),
    // The server's own message and the path it looked at: evidence, not the
    // headline. `message` repeats the sentence above it, so it is left out.
    detail: [failure.manifest_path, failure.detail].filter(Boolean).join('\n'),
  };
}
