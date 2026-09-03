// One reading of a failure, for every studio and every hub view.
//
// muapiErrors.js already does this for the cloud transport. This is the same
// idea one level up: whatever threw — a MUAPI 401, a HivemindOS 402, a bridge
// that is not listening, a lane that ran out of VRAM, a control API that
// restarted mid-request — becomes `{ title, detail, remedy }`, where `title` is
// one sentence a person can read and act on, `remedy` is the button that
// repairs it, and `detail` is the raw technical tail the callout keeps behind a
// Details disclosure.
//
// Three rules it exists to enforce (the owner's, not a style preference):
//   1. never present a problem without its fix — so a shape with a known repair
//      returns a `remedy`, and the repair is the one that actually works (a
//      rejected key opens the inline key field, not "Settings");
//   2. never show raw provider or backend text as the sentence — anything that
//      starts with a traceback, a filesystem path or a JSON body is demoted to
//      `detail` and the sentence is written here;
//   3. say it once — the callout carries all three parts, so nothing needs a
//      second toast beside it.
//
// Pure (no React, no toast, no fetch) like the rest of src/lib, so every branch
// is testable in node.
import { getLang } from './i18n.js';
import { describeMuapiError, flattenApiDetail } from './muapiErrors.js';
import { remedyFor } from './textModels.js';

const zh = () => getLang() === 'zh-CN';

// The same test the media gateway uses on the lane's own stderr, so the two
// ends agree on what "the card ran out" looks like.
const OOM = /out of memory|outofmemory|cuda error: out of memory|mps backend out of memory|allocation on device/i;
// A transport that never answered: the browser's own fetch failures, plus what
// urllib/requests say when nothing is listening on the port.
const UNREACHABLE = /failed to fetch|load failed|networkerror|network error|connection refused|econnrefused|errno 61|err_connection|socket hang up|etimedout|connection reset/i;

/**
 * Would showing this string as the sentence break rule 2?
 *
 * A traceback, an absolute path, a JSON body and a multi-line dump are all
 * evidence rather than instructions — worth keeping, never worth leading with.
 */
export function looksTechnical(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (/^traceback\b/i.test(raw)) return true;
  if (/^[[{]/.test(raw)) return true;
  if (/^(?:\/|[A-Za-z]:\\|file:\/\/)/.test(raw)) return true;
  if (/^\s*File "/m.test(raw)) return true;
  if (/^[A-Za-z_.]*(?:Error|Exception)(?:\s*[:(]|$)/.test(raw)) return true;
  if (raw.includes('\n')) return true;
  return raw.length > 220;
}

/** The generic sentence, named by what was being attempted when it failed. */
function genericTitle(operation) {
  const what = String(operation || '').trim();
  if (zh()) return what ? `${what}失败` : '这一步失败了';
  return what ? `${what} failed` : 'That did not work';
}

/** A sentence the caller may show, plus the tail it must hide. */
function sentence(raw, operation) {
  return looksTechnical(raw)
    ? { title: genericTitle(operation), detail: raw }
    : { title: raw, detail: '' };
}

/**
 * The repair the SERVER named, if it named one.
 *
 * modelRunner.js and localProducer.js attach `{ remedy, oauthProvider }` from
 * the `{message, remedy, provider}` body precisely so a refusal can become a
 * button; flattening it to a sentence throws the actionable half away.
 */
function serverRemedy(error) {
  const raw = String(error?.remedy || '');
  if (!raw) return null;
  const provider = String(error?.oauthProvider || error?.provider || '');
  // 'reconnect' only means anything with the account it names.
  if (raw === 'reconnect' && provider) return remedyFor(`oauth:${provider}`);
  return remedyFor(raw);
}

/**
 * → `{ title, detail, remedy }` for `FailureCallout` (or any caller that wants
 * one sentence and one button).
 *
 * `transport` is modelRunner's routing answer ('muapi' | 'local' | 'studio'),
 * `operation` names what was being attempted ('Generation', 'Reference
 * upload'), and `canLowerResolution` says whether the caller actually has a
 * size dial to step down — an action offered by a screen that cannot perform it
 * is the same dead end as no action at all.
 */
export function describeFailure(error, { transport = '', operation = '', canLowerResolution = false } = {}) {
  const raw = String(error?.message || flattenApiDetail(error?.detail) || error || '').trim();

  // The server said what to do. Nothing below can improve on that.
  const named = serverRemedy(error);
  if (named) return { ...sentence(raw, operation), remedy: named };

  if (transport === 'muapi') {
    const muapi = describeMuapiError(error);
    return {
      title: muapi.message,
      detail: muapi.message === raw ? '' : raw,
      // A refused key is repaired by the inline key field the pickers already
      // open — not by a page called Settings that has no field on it.
      remedy: muapi.keyRejected ? remedyFor('key:MUAPI_API_KEY') : null,
    };
  }

  if (OOM.test(raw)) {
    return {
      title: zh() ? '这个尺寸的显存不够' : 'Not enough memory for this size',
      detail: raw,
      remedy: canLowerResolution
        ? { label: zh() ? '降低分辨率' : 'Lower resolution', action: 'lower-resolution' }
        : null,
    };
  }

  if (UNREACHABLE.test(raw)) {
    return transport === 'local'
      ? {
        title: zh() ? '本机引擎没有在运行' : 'The local engine is not running',
        detail: raw,
        remedy: { label: zh() ? '再检查一次' : 'Check again', action: 'refresh' },
      }
      : {
        title: zh() ? '工作室没有响应' : 'The studio is not answering',
        detail: raw,
        remedy: { label: zh() ? '再检查一次' : 'Check again', action: 'refresh' },
      };
  }

  return { ...sentence(raw, operation), remedy: null };
}

/**
 * The same reading, flattened for the places that only have room for a line —
 * the ~26 hub toasts, a thread bubble, a status row.
 */
export function failureSentence(error, options = {}) {
  return describeFailure(error, options).title;
}
