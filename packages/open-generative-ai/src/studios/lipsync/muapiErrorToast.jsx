// toast.error for a MUAPI failure, read through lib/muapiErrors.js. When the
// key is the problem the toast carries the action that fixes it — "Add key",
// which opens the studio's own key dialog when the caller passes `onAddKey`,
// or Settings when it does not — shared by the Cinema and Lip sync studios
// (both are MUAPI-only).
import { toast } from 'react-hot-toast';
import { describeMuapiError, openStudioSettings } from '../../lib/muapiErrors.js';

function keyToast(text, { onAddKey = null } = {}) {
  toast.error((instance) => (
    <span className="flex items-center gap-3">
      <span>{text}</span>
      <button
        type="button"
        className="shrink-0 rounded-sm border border-line1 bg-bg2 px-2 py-1 text-xs font-semibold text-ink1 hover:border-line2"
        onClick={() => {
          toast.dismiss(instance.id);
          if (onAddKey) onAddKey();
          else openStudioSettings();
        }}
      >
        {onAddKey ? 'Add key' : 'Open Settings'}
      </button>
    </span>
  ), { duration: 8000 });
}

/**
 * `prefix` names the operation ("Audio upload failed") so a generic message
 * still says what it was for. `onAddKey` opens the caller's key dialog from
 * the toast. Returns the description for callers that want it.
 */
export function toastMuapiError(error, { prefix = '', onAddKey = null } = {}) {
  const described = describeMuapiError(error);
  const text = prefix ? `${prefix}: ${described.message}` : described.message;
  if (!described.keyRejected) {
    toast.error(text);
    return described;
  }
  keyToast(text, { onAddKey });
  return described;
}

/** A missing key that was noticed BEFORE a request — the same toast, with the
 *  same button, for work that is waiting on it rather than work that failed. */
export function toastMuapiKeyNeeded(text, { onAddKey = null } = {}) {
  keyToast(text, { onAddKey });
}
