// The account row: a face, a name, a balance and a meter, above Settings and Lock.
//
// Two doors in one row, and they are deliberately separate presses. The top
// half is WHO — a name to be recognised by, and the account settings behind it.
// The bottom half is WHAT YOU HAVE — the credit balance and what is left of
// today's free Swarm Scout allowance, and it opens the place to buy more.
// Merging them into one button would mean guessing which of the two a press
// meant, and the two are answered in different sheets.
//
// The meter is the reason this row exists at all. Free usage that is only
// discovered when a generation is REFUSED is the failure mode this app already
// has a rule about (see the project's UX rule: never present a problem without
// its fix). A bar in the sidebar turns "you are out" from an error into
// something seen coming, next to the button that fixes it.
import { useSyncExternalStore } from 'react';

import {
  allowanceFraction, allowanceTone, avatarStyle, formatCredits, accountOverview, resetsAtLabel,
} from '../lib/account.js';
import { t, tf } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Skeleton, cx, useHint } from '../ui/kit.jsx';

// ONE read, shared by everything that shows it.
//
// The row, the account sheet and the credits sheet each used to call the hook,
// and the hook used to own its own state — so opening a sheet fired a second
// request and sat on its own skeleton while the row behind it already had the
// answer on screen. Three components, three fetches, three loading states for
// one fact.
//
// So the state lives here, module-level, in the shape `app/navBadges.js` and
// `app/statusStore.js` already use: a snapshot, a listener set, and
// `useSyncExternalStore` to read it. A sheet that opens while the row is loaded
// renders filled in immediately, and a refresh after a mutation updates all
// three at once with nothing threaded through the shell.
//
// The row is on screen on every page, so it re-reads on a timer rather than on
// navigation — and slowly. A balance moves when a generation finishes (the
// studio's own refresh event, listened for below) and an allowance moves on the
// same presses; nothing else changes minute to minute.
const REFRESH_MS = 90_000;
// A mount inside this window reuses the last read instead of asking again. The
// studio caches its own answer for 12s for the same reason; this is the client
// half of it, and what makes opening a sheet instant.
const FRESH_FOR_MS = 10_000;

// Three states, not two, and conflating any pair of them prints a confident
// lie. `loaded` false is "we have not asked yet" — drawing "0 credits" there
// reads as an emptied balance. `failed` is "we asked and could not be told" — a
// locked studio, a stopped one, no network — which is NOT the same as having no
// account, though the first build of this drew them identically: a signed-out
// studio showed a confident "No account yet" under a name of three dots, with a
// lecture about backing up credits nobody had.
let snapshot = { overview: null, loaded: false, failed: false, known: false };
let fetchedAt = 0;
let inFlight = null;
let timer = null;
const listeners = new Set();

function publish(next) {
  // `known` is the only thing most callers should branch on: we asked, we were
  // told, and the answer is in `overview`.
  snapshot = { ...next, known: next.loaded && !next.failed && Boolean(next.overview) };
  listeners.forEach((listener) => listener());
}

function load({ force = false } = {}) {
  if (!force && snapshot.loaded && Date.now() - fetchedAt < FRESH_FOR_MS) return inFlight;
  // A second caller mounting mid-flight joins the request already running
  // rather than starting another one.
  if (inFlight) return inFlight;
  inFlight = accountOverview()
    .then((payload) => {
      fetchedAt = Date.now();
      publish({ overview: payload, loaded: true, failed: false });
    })
    .catch(() => {
      // A failed refresh KEEPS the last overview: the row labels it stale
      // rather than blanking a name it still has.
      fetchedAt = Date.now();
      publish({ ...snapshot, loaded: true, failed: true });
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

const reload = () => { void load({ force: true }); };

function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = window.setInterval(reload, REFRESH_MS);
    window.addEventListener('hivemind-hub-refresh', reload);
    window.addEventListener('hivemind-account-changed', reload);
  }
  void load();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      window.removeEventListener('hivemind-hub-refresh', reload);
      window.removeEventListener('hivemind-account-changed', reload);
    }
  };
}

export function useAccountOverview() {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return { ...state, refresh: reload };
}

/** Anything that changes the balance or the account announces it here, so the
 *  row and both sheets agree without threading a callback through the shell. */
export function announceAccountChanged() {
  window.dispatchEvent(new Event('hivemind-account-changed'));
}

export function Avatar({ identity, size = 32 }) {
  // No identity is not a colour. A gradient blob with two dots in it read as a
  // broken image, so an account we do not have yet gets a plain outlined glyph
  // — visibly a placeholder rather than visibly somebody.
  const monogram = identity?.avatar?.monogram || '';
  if (!monogram) {
    return (
      <span
        aria-hidden="true"
        className="grid shrink-0 place-items-center rounded-full border border-dashed border-line2 text-ink3"
        style={{ width: size, height: size }}
      >
        <Icon name="persona" size={Math.round(size * 0.46)} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white/95 shadow-inner"
      style={{ ...avatarStyle(identity.avatar), width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {monogram}
    </span>
  );
}

/** The meter, as one line of words. Kept beside the bar because a bar alone
 *  says "some" and a person deciding whether to start a run needs a number. */
function allowanceLine(allowance, known) {
  // Nothing while the read is in flight. "Unknown" is a VERDICT — we asked and
  // could not be told — and printing it during the two to five seconds the read
  // takes made the studio look broken every single time it started, which is
  // exactly how it was reported. The same distinction the credit line makes.
  if (!known) return '';
  // Beyond that, "unknown" is for one case only: the gateway could not be
  // reached. It used to be the answer whenever a REMAINING count was missing,
  // which put "Free allowance unknown" over a meter whose daily ceiling we were
  // holding in the same object — see `allowance()` in hivemindos_account.py.
  if (!allowance?.known) return t('account.freeUnknown');
  const left = allowance.remainingRequests;
  const total = allowance.requestLimit;
  if (Number.isFinite(left) && left <= 0) return t('account.freeSpent');
  if (Number.isFinite(left) && Number.isFinite(total)) {
    return tf('account.freeLeft', formatCredits(left), formatCredits(total));
  }
  // A ceiling with no count against it is still a fact worth stating.
  if (Number.isFinite(total)) return tf('account.freePerDay', formatCredits(total));
  return t('account.freeUnknown');
}

function creditsLine(credits, known) {
  // Nothing at all until we have been told something. "0 credits" while a read
  // is in flight reads as a balance that just emptied.
  if (!known) return '';
  // With no account there are no credits, and that is what this line says. It
  // used to repeat "No account yet" — which the name line one row up was
  // already saying, so the row said the same thing to itself twice.
  if (!credits?.configured) return tf('account.credits', '0');
  const amount = credits.credits;
  if (!Number.isFinite(Number(amount))) return t('account.creditsUnknown');
  return tf('account.credits', formatCredits(amount));
}

/** The second line of the row, and the one that has to stay honest through
 *  every state: a studio that cannot answer must not be drawn as an account
 *  with no credits, which is what the first version of this did. */
function sublineFor({ known, failed, identity }) {
  // A failed read with something remembered is a STALE reading, and saying so
  // is the honest option — blanking a name we still have helps nobody. A failed
  // read with nothing remembered says nothing at all, because there is nothing.
  if (failed) return identity ? t('account.staleReading') : '';
  if (!known) return '';
  if (!identity?.connected) return t('account.noAccountYet');
  // The row's subline is 10.5px and truncates, so it gets the short form; the
  // sheet, which has the width for it, says what signing in actually does.
  return identity.emailLinked
    ? tf('account.backedUpShort', identity.emailMasked)
    : t('account.notBackedUp');
}

const METER_FILL = {
  ok: 'bg-honey',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-line2',
};

/**
 * `railed` is the icon-rail sidebar: 56px, no room for a name or a meter. The
 * avatar survives as the whole control there and opens the account sheet, and
 * the credits door moves into that sheet — rather than stacking two unlabelled
 * buttons nobody could tell apart at that width.
 */
export function AccountRow({ railed = false, onOpenAccount, onOpenCredits }) {
  const { overview, loaded, known, failed } = useAccountOverview();
  const hint = useHint('right');
  const identity = overview?.identity;
  const allowance = overview?.allowance;
  const fraction = allowanceFraction(allowance);
  const tone = allowanceTone(allowance);
  // A name we do not have is not a name made of dots. A remembered one survives
  // a failed refresh (labelled stale below); with nothing remembered the row
  // says so plainly rather than inventing an account.
  const name = (identity?.connected && identity.handle) || '';
  const nameLine = name || (failed ? t('account.unavailableShort') : known ? t('account.notConnected') : '');

  if (railed) {
    const door = name ? tf('account.openAccount', name) : t('account.row');
    // The rail hides the two lines that are the whole point of this row — the
    // balance and what is left of today's free allowance — so the hover bubble
    // carries them. Otherwise the meter only speaks once a run is refused,
    // which is the failure this row exists to prevent.
    const creditsText = creditsLine(overview?.credits, known);
    const allowanceText = allowanceLine(allowance, known);
    return (
      <>
        <button
          type="button"
          onClick={onOpenAccount}
          aria-label={door}
          {...hint.bind({ onClick: onOpenAccount })}
          className="grid h-9 w-9 place-items-center rounded-full transition-transform hover:scale-105"
        >
          {loaded
            ? <Avatar identity={identity?.connected ? identity : null} size={30} />
            : <Skeleton rounded="rounded-full" className="h-[30px] w-[30px]" />}
        </button>
        {hint.render(
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{nameLine || door}</span>
            {creditsText ? <span className="text-ink2">{creditsText}</span> : null}
            {allowanceText ? <span className="text-ink3">{allowanceText}</span> : null}
          </span>,
        )}
      </>
    );
  }

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2/60"
      aria-busy={loaded ? undefined : 'true'}
    >
      <button
        type="button"
        onClick={onOpenAccount}
        title={name ? tf('account.openAccount', name) : t('account.row')}
        className="flex min-w-0 items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-bg3"
      >
        {loaded
          ? <Avatar identity={identity?.connected ? identity : null} size={30} />
          : <Skeleton rounded="rounded-full" className="h-[30px] w-[30px] shrink-0" />}
        <span className="min-w-0 flex-1">
          {loaded ? (
            <>
              <span className="block truncate text-[12.5px] font-semibold leading-tight text-ink1">
                {nameLine}
              </span>
              <span className="block truncate text-[10.5px] leading-tight text-ink3">
                {sublineFor({ known, failed, identity })}
              </span>
            </>
          ) : (
            // Sized to the lines they stand in for, so nothing shifts when the
            // real ones arrive.
            <span className="flex flex-col gap-[5px] py-[3px]">
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-2 w-32" />
            </span>
          )}
        </span>
        <Icon name="chevronRight" size={13} className="shrink-0 text-ink3" />
      </button>
      <button
        type="button"
        onClick={onOpenCredits}
        title={t('account.openCredits')}
        className="flex flex-col gap-1.5 border-t border-line1 px-2.5 py-2 text-left transition-colors hover:bg-bg3"
      >
        <span className="flex items-baseline justify-between gap-2">
          {loaded
            ? <span className="truncate text-[12px] font-semibold text-ink1">{creditsLine(overview?.credits, known)}</span>
            : <Skeleton className="my-[3px] h-2.5 w-20" />}
          <span className="shrink-0 text-[10.5px] font-semibold text-honey">{t('failure.addCredits')}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-bg3"
            role="progressbar"
            aria-label={tf('account.freeMeter', allowance?.model || '')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
          >
            {loaded ? (
              <span
                className={cx('block h-full rounded-full transition-[width] duration-300', METER_FILL[tone])}
                style={{ width: `${fraction === null ? 0 : Math.max(fraction * 100, fraction > 0 ? 4 : 0)}%` }}
              />
            ) : (
              <Skeleton rounded="rounded-full" className="h-full w-full" />
            )}
          </span>
        </span>
        <span className="flex items-baseline justify-between gap-2 text-[10.5px] leading-tight text-ink3">
          {loaded
            ? <span className="truncate">{allowanceLine(allowance, known)}</span>
            : <Skeleton className="my-[3px] h-2 w-28" />}
          {known && allowance?.known && resetsAtLabel(allowance) ? (
            <span className="shrink-0">{tf('account.resetsAt', resetsAtLabel(allowance))}</span>
          ) : null}
        </span>
      </button>
    </div>
  );
}
