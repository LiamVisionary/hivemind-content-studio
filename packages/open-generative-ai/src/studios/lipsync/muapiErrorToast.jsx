// toast.error for a MUAPI failure, read through lib/muapiErrors.js. When the
// key is the problem the toast carries an "Open Settings" action — shared by
// the Cinema and Lip sync studios (both are MUAPI-only).
import { toast } from 'react-hot-toast';
import { describeMuapiError, openStudioSettings } from '../../lib/muapiErrors.js';

/**
 * `prefix` names the operation ("Audio upload failed") so a generic message
 * still says what it was for. Returns the description for callers that want it.
 */
export function toastMuapiError(error, { prefix = '' } = {}) {
  const described = describeMuapiError(error);
  const text = prefix ? `${prefix}: ${described.message}` : described.message;
  if (!described.keyRejected) {
    toast.error(text);
    return described;
  }
  toast.error((instance) => (
    <span className="flex items-center gap-3">
      <span>{text}</span>
      <button
        type="button"
        className="shrink-0 rounded-sm border border-line1 bg-bg2 px-2 py-1 text-xs font-semibold text-ink1 hover:border-line2"
        onClick={() => { toast.dismiss(instance.id); openStudioSettings(); }}
      >
        Open Settings
      </button>
    </span>
  ), { duration: 8000 });
  return described;
}
