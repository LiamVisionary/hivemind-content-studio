// A failed request, said once, with the thing that makes it reportable.
//
// The server answers an unexpected 500 with `{detail, incident}` — a short id
// that also appears in the studio's own log file. Until now the browser threw
// that away and showed a sentence ("the studio server hit an unexpected
// error") that no one could act on or look up. This toast keeps the sentence
// and adds the ONE action that helps: Copy details, which puts the incident
// id, the route and the time on the clipboard so it can be pasted into a
// report beside the diagnostics bundle (GET /api/diagnostics/bundle).
//
// Deliberately NOT "Send report": nothing is transmitted from this app on its
// own (AGENTS.md), and a button that promised to send would either lie or
// leak. The owner attaches what they choose to.
//
// Plain .js with createElement rather than JSX because hubData.js imports it
// and the hub data tests load that module under bare node, with no compiler.
import { createElement } from 'react';
import { toast } from 'react-hot-toast';

/** The incident id an error is carrying, if it has one. */
export const incidentOf = (error) => String(error?.incident || '').trim();

/**
 * What goes on the clipboard. One line, no stack, nothing the server did not
 * already say — the sentence, the id, what it was for, and when.
 */
export function failureDetails(error, { context = '' } = {}) {
  const parts = [String(error?.message || 'Request failed')];
  const incident = incidentOf(error);
  if (incident) parts.push(`incident #${incident}`);
  if (error?.status) parts.push(`HTTP ${error.status}`);
  if (context) parts.push(context);
  parts.push(new Date().toISOString());
  return parts.join(' · ');
}

async function copyDetails(text) {
  try {
    // navigator.clipboard is undefined on a plain-http LAN origin; without the
    // guard this is an unhandled rejection and no feedback at all.
    if (!navigator.clipboard?.writeText) throw new Error('needs a secure (https or localhost) origin');
    await navigator.clipboard.writeText(text);
    toast.success('Details copied.');
  } catch (error) {
    toast.error(`Could not copy — ${error?.message || 'clipboard unavailable'}`);
  }
}

/**
 * Show a failure. With an incident id the toast carries Copy details; without
 * one it is the plain error toast every studio already shows, so this is a
 * drop-in for `toast.error(error.message)`.
 *
 * `context` names the operation ("Save prompt") so a generic sentence still
 * says what it was for.
 */
export function toastFailure(error, { context = '' } = {}) {
  const sentence = String(error?.message || 'Something went wrong.');
  const text = context ? `${context}: ${sentence}` : sentence;
  const incident = incidentOf(error);
  if (!incident) {
    toast.error(text);
    return '';
  }
  const details = failureDetails(error, { context });
  toast.error((instance) => createElement(
    'span',
    { className: 'flex items-center gap-3' },
    createElement('span', null, text, ' ', createElement('span', { className: 'text-ink3' }, `#${incident}`)),
    createElement(
      'button',
      {
        type: 'button',
        className: 'shrink-0 rounded-sm border border-line1 bg-bg2 px-2 py-1 text-xs font-semibold text-ink1 hover:border-line2',
        onClick: () => {
          toast.dismiss(instance.id);
          void copyDetails(details);
        },
      },
      'Copy details',
    ),
  ), { duration: 12000 });
  return incident;
}
