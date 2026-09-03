// One toast for a failure that has no canvas to sit on.
//
// `FailureCallout` is the shape a failure takes where there is room for it —
// the studio canvas, a hub panel. Everywhere else (a menu action, an upload, a
// hub list refresh) the failure is a toast, and this is the same reading in
// that shape: the sentence describeFailure wrote, and — when the failure named
// a repair — the button that performs it, instead of the provider's words and
// a dead end.
//
// It replaces `toast.error(error.message)`, which is how raw backend text used
// to reach a person on ~33 paths.
import { toast } from 'react-hot-toast';

import { describeFailure } from '../lib/describeFailure.js';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import { zh } from '../lib/i18n.js';

/**
 * `operation` names what was being attempted ("Reference upload"), so a generic
 * failure still says what it was for. `handlers` is passed through to
 * runFailureRemedy for the studio-local repairs. Returns the description, for
 * callers that also want to render it.
 */
export function toastFailure(error, { operation = '', handlers = null } = {}) {
  const failure = describeFailure(error, { operation });
  const text = operation && failure.title.indexOf(operation) !== 0
    ? `${operation}: ${failure.title}`
    : failure.title;
  if (!failure.remedy) {
    toast.error(text);
    return failure;
  }
  toast.error((instance) => (
    <span className="flex flex-col gap-1.5 text-[12px]">
      <span className="text-ink2">{text}</span>
      <span className="flex gap-2">
        <button
          type="button"
          className="shrink-0 rounded-sm border border-line1 bg-bg2 px-2 py-1 text-xs font-semibold text-ink1 hover:border-line2"
          onClick={() => { toast.dismiss(instance.id); void runFailureRemedy(failure.remedy, handlers || {}); }}
        >
          {failure.remedy.label}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-sm px-2 py-1 text-xs font-semibold text-ink2 hover:text-ink1"
          onClick={() => toast.dismiss(instance.id)}
        >
          {zh() ? '关闭' : 'Dismiss'}
        </button>
      </span>
    </span>
  ), { duration: 12000 });
  return failure;
}
