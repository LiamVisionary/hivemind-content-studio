// Adding credits: one balance, two ways to buy, and one press at the end.
//
// This sheet used to open all four rails at once — card, USDC, the HivemindOS
// wallet, the monthly plans — each with its own form and its own button, about
// four screens of scroll. Four questions asked simultaneously when only one of
// them is ever answered.
//
// It is three decisions in order now: whether this is a one-off or a plan, how
// much, and which way to pay. Only the chosen rail expands, and the single
// press lives in the footer where it cannot scroll away from the choice it acts
// on.
//
// The reordering also repaired something the old layout quietly got wrong: the
// amount picker sat ABOVE all four rails, so it read as applying to the monthly
// plans, and it never did — a plan's price is the plan's. The amount now lives
// inside the one-off path, the only path in which it means anything.
//
// One rule survives the rewrite unchanged: nothing is charged in this sheet.
// Every rail ends somewhere else — a hosted checkout page, a wallet the owner
// controls, an approval in another app — and the footer line always names which
// of them the press is about to open.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import {
  CREDITS_PER_USD, TOP_UP_AMOUNTS_USD, WALLET_POLL_MS, WALLET_WAIT_MS, cancelSubscription,
  creditsForUsd, depositConfig, formatCredits, formatUsd, quoteDeposit, settleDeposit,
  startCardCheckout, startSubscription, startWalletPayment, subscriptionState, walletPaymentState,
} from '../lib/account.js';
import { textModelCatalog } from '../lib/localProducer.js';
import { DRAFT_USAGE, creditsPerCall, recommendedId, rowFor } from '../lib/textModels.js';
import { t, tf } from '../lib/i18n.js';
import { announceAccountChanged, useAccountOverview } from '../app/AccountRow.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, SectionLabel, Skeleton, TextInput, cx } from '../ui/kit.jsx';
import { ConfirmModal, Modal } from '../ui/Modal.jsx';

/** Open a hosted checkout, and say which of the three things happened. A
 *  blocked pop-up is the common one and it is silent — the sheet has to notice
 *  it, or a person presses Continue and nothing at all appears to occur. */
function openCheckout(url) {
  if (!url) return false;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) {
    toast.success(t('credits.checkoutOpened'));
    return true;
  }
  toast.error(t('credits.checkoutBlocked'));
  return false;
}

function minutesLeft(expiresAt) {
  const remaining = Date.parse(expiresAt || '') - Date.now();
  return Number.isFinite(remaining) ? Math.max(0, Math.round(remaining / 60_000)) : 0;
}

/** A tier id as the plan cards show it — they capitalise in CSS, and a button
 *  reading "Subscribe to pro" beside a card reading "Pro" names two things. */
const titled = (tier) => String(tier || '').charAt(0).toUpperCase() + String(tier || '').slice(1);

/** Credits a dollar buys on a plan, for comparing a plan against a top-up. */
export function planRate(plan) {
  const credits = Number(plan?.monthlyCredits);
  const price = Number(plan?.priceUsdMonthly);
  return Number.isFinite(credits) && Number.isFinite(price) && price > 0 ? credits / price : null;
}

/**
 * Whether the Monthly tab has earned its "Better rate" badge.
 *
 * ROUNDED, because the plan cards below print rounded rates. A plan worth
 * 500.25 credits a dollar against a top-up's 500 is arithmetically better and
 * visibly identical — it lit the badge while all three cards read "500 per $1",
 * which is a badge arguing with the only evidence for it on screen.
 */
export function betterRateThanTopUp(plans) {
  return (plans || []).some((plan) => Math.round(planRate(plan) || 0) > CREDITS_PER_USD);
}

/* ---------------- the three choices ---------------- */

// Not kit's `Segmented`: that one is a compact toolbar control (h-7, a label and
// nothing else) and this is the sheet's opening question — full width, and it
// carries the single fact that decides it, which is that a plan buys more per
// dollar than a top-up does. Widening the shared control with a badge and a
// grow flag for one caller would make every toolbar pay for this sheet.
function ModeTabs({ mode, onMode, betterRate }) {
  const tabs = [
    { key: 'topup', label: t('credits.modeTopUp'), badge: '' },
    { key: 'monthly', label: t('credits.modeMonthly'), badge: betterRate ? t('credits.betterRate') : '' },
  ];
  return (
    <div className="flex gap-1 rounded-[9px] border border-line1 bg-bg2 p-[3px]" role="group">
      {tabs.map((tab) => {
        const on = tab.key === mode;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={on}
            onClick={() => onMode(tab.key)}
            className={cx(
              'flex h-[34px] flex-1 items-center justify-center gap-[7px] rounded-[7px] text-[13px] font-semibold transition-all duration-150 ease-swift',
              on ? 'bg-bg3 text-ink1 shadow-card' : 'text-ink2 hover:text-ink1',
            )}
          >
            <span>{tab.label}</span>
            {tab.badge ? (
              <span className="rounded-[4px] bg-honey-tint px-1.5 py-0.5 text-[10px] font-semibold text-honey">
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// What each amount buys is written ON the amount, not once in the corner for
// whichever one happens to be selected. Five prices with one credit figure
// floating above them made the reader hold the selection in their head to know
// which price the figure belonged to; five cards each carrying their own answer
// is the comparison the ladder exists to offer.
function AmountPicker({ amountUsd, onChange }) {
  return (
    <div className="flex flex-col gap-[9px]">
      <SectionLabel className="!mb-0">{t('credits.amount')}</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
        {TOP_UP_AMOUNTS_USD.map((value) => {
          const on = value === amountUsd;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onChange(value)}
              aria-pressed={on}
              className={cx(
                'flex flex-col items-center justify-center gap-1 rounded-[10px] border px-2 py-3 transition-all duration-150 ease-swift',
                on ? 'border-honey bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
              )}
            >
              <span
                className={cx(
                  'font-mono text-[18px] font-semibold leading-none tracking-[-0.02em]',
                  on ? 'text-honey' : 'text-ink1',
                )}
              >
                {formatUsd(value)}
              </span>
              <span className="text-[11px] leading-none text-ink3">
                {tf('account.credits', formatCredits(creditsForUsd(value)))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One way to pay, as a radio row. A rail that cannot be used stays on the list
 *  wearing its reason, rather than vanishing — an option that disappears is
 *  indistinguishable from one that never existed. */
function MethodRow({ icon, title, hint, tag, on, off, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={off}
      aria-pressed={on}
      className={cx(
        'flex items-start gap-[11px] rounded-[10px] border px-[13px] py-3 text-left transition-all duration-150 ease-swift',
        on ? 'border-honey bg-honey-tint' : 'border-line1 bg-bg2',
        off ? 'opacity-50' : 'hover:border-line2',
      )}
    >
      <span
        className={cx(
          'mt-[3px] h-[15px] w-[15px] shrink-0 rounded-full border',
          on ? 'border-honey bg-honey shadow-[inset_0_0_0_3px_var(--bg-2)]' : 'border-line2',
        )}
      />
      <span
        className={cx(
          'grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition-colors duration-150',
          on ? 'bg-honey-tint text-honey' : 'bg-bg3 text-ink2',
        )}
      >
        <Icon name={icon} size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-ink1">{title}</span>
        <span className="text-[12px] leading-[1.45] text-ink3">{hint}</span>
      </span>
      {tag ? (
        <span className="shrink-0 rounded-[5px] border border-line1 px-[7px] py-[3px] text-[11px] text-ink3">
          {tag}
        </span>
      ) : null}
    </button>
  );
}

/* ---------------- the balance ---------------- */

function BalanceCard({ loaded, credits, drafts }) {
  return (
    <div className="flex items-center gap-4 rounded-[10px] border border-line1 bg-bg2 px-[17px] py-[15px]">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-honey-tint text-honey">
        <Icon name="coin" size={17} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <SectionLabel className="!mb-0">{t('account.balance')}</SectionLabel>
        {loaded ? (
          <div className="flex items-baseline gap-2">
            {credits?.configured ? (
              <>
                <span className="font-mono text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] text-ink1">
                  {formatCredits(credits.credits)}
                </span>
                <span className="text-[13px] text-ink2">{t('credits.unit')}</span>
              </>
            ) : (
              <span className="text-[15px] font-semibold text-ink1">{t('account.notConnected')}</span>
            )}
          </div>
        ) : (
          <Skeleton className="mt-1 h-7 w-32" />
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-[3px] text-right">
        {drafts ? (
          <span className="text-[12px] text-ink2">{tf('credits.draftsLeft', drafts.count, drafts.model)}</span>
        ) : null}
        <span className="font-mono text-[11px] text-ink3">
          {tf('credits.perDollar', formatCredits(CREDITS_PER_USD))}
        </span>
      </div>
    </div>
  );
}

/* ---------------- USDC ---------------- */

function UsdcPayer({ payer, onPayer, failure }) {
  return (
    <div className="flex flex-col gap-[9px] rounded-[10px] border border-line1 bg-bg2 px-4 py-[15px]">
      <Field label={t('credits.cryptoPayer')} hint={t('credits.cryptoPayerHint')} error={failure || undefined}>
        <TextInput
          placeholder={t('credits.addressPlaceholder')}
          value={payer}
          onChange={(event) => onPayer(event.target.value)}
          className="font-mono text-[12px]"
        />
      </Field>
    </div>
  );
}

function UsdcQuote({ quote, amountUsd, hash, onHash, failure, expired }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(quote.recipient);
      toast.success(t('credits.copied'));
    } catch {
      toast.error(t('failure.generic'));
    }
  };
  return (
    <div className="flex flex-col gap-[11px] rounded-[10px] border border-honey/35 bg-bg2 px-4 py-[15px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-ink2">{t('credits.cryptoSendTo')}</span>
        <span className={cx('font-mono text-[11px]', expired ? 'text-danger' : 'text-honey')}>
          {expired ? t('credits.cryptoExpired') : tf('credits.cryptoExpires', minutesLeft(quote.expiresAt))}
        </span>
      </div>
      <span className="font-mono text-[17px] font-semibold text-ink1">
        {formatUsd(quote.amountUsd ?? amountUsd)} USDC
      </span>
      <button
        type="button"
        onClick={copy}
        className="flex items-center gap-2 rounded-lg border border-line1 bg-bg1 px-[11px] py-[9px] text-left transition-colors duration-150 hover:border-line2"
      >
        <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-[1.5] text-ink2">
          {quote.recipient}
        </span>
        <span className="flex shrink-0 items-center gap-[5px] text-[11px] font-semibold text-honey">
          <Icon name="copy" size={12} />
          {t('credits.copy')}
        </span>
      </button>
      {expired ? null : (
        <Field label={t('credits.cryptoHash')} error={failure || undefined}>
          <TextInput
            placeholder={t('credits.addressPlaceholder')}
            value={hash}
            onChange={(event) => onHash(event.target.value)}
            className="font-mono text-[12px]"
          />
        </Field>
      )}
      <span className="text-[11px] leading-[1.5] text-ink3">{t('credits.cryptoFootnote')}</span>
    </div>
  );
}

/* ---------------- monthly ---------------- */

function PlanCards({ plans, current, picked, onPick }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {plans.map((plan) => {
        // Two different facts, and they were drawn as one: the plan you HAVE
        // and the plan the footer is about to act on. Selecting a second tier
        // lit both cards identically, so the sheet showed two current plans.
        // Selection is the honey card; the running plan keeps its badge.
        const active = current?.tier === plan.tier;
        const on = picked === plan.tier;
        const rate = planRate(plan);
        return (
          <button
            key={plan.tier}
            type="button"
            onClick={() => onPick(plan.tier)}
            aria-pressed={on}
            className={cx(
              'flex flex-col gap-2 rounded-[10px] border px-3.5 py-[13px] text-left transition-all duration-150 ease-swift',
              on ? 'border-honey bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold capitalize text-ink1">{plan.tier}</span>
              {active ? (
                <span className="text-[10px] font-semibold text-honey">{t('common.active')}</span>
              ) : null}
            </span>
            <span className="font-mono text-[19px] font-semibold tracking-[-0.02em] text-ink1">
              {formatUsd(plan.priceUsdMonthly)}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[12px] text-ink2">
                {tf('credits.planCredits', formatCredits(plan.monthlyCredits))}
              </span>
              {rate ? (
                <span className="text-[11px] text-honey">{tf('credits.planRate', formatCredits(rate))}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- the sheet ---------------- */

export function CreditsDialog({ onClose }) {
  const { overview, loaded, refresh } = useAccountOverview();
  const [mode, setMode] = useState('topup');
  const [amountUsd, setAmountUsd] = useState(10);
  const [method, setMethod] = useState('card');
  const [busy, setBusy] = useState(false);

  const [deposit, setDeposit] = useState(null);
  const [payer, setPayer] = useState('');
  const [quote, setQuote] = useState(null);
  const [hash, setHash] = useState('');
  const [usdcFailure, setUsdcFailure] = useState('');

  const [plans, setPlans] = useState(null);
  const [tier, setTier] = useState('');
  const [confirming, setConfirming] = useState(false);

  const [catalog, setCatalog] = useState(null);
  const stopWallet = useRef(null);

  const credits = overview?.credits;

  useEffect(() => {
    let alive = true;
    depositConfig()
      .then((config) => { if (alive) setDeposit(config); })
      .catch(() => { if (alive) setDeposit({ available: false, detail: '' }); });
    return () => { alive = false; };
  }, []);

  const loadPlans = useCallback(async () => {
    try {
      setPlans(await subscriptionState());
    } catch {
      setPlans({ available: false, plans: [], current: null });
    }
  }, []);
  // On mount rather than when the Monthly tab opens: the tab itself carries the
  // "Better rate" badge, which is an answer about the plans.
  useEffect(() => { void loadPlans(); }, [loadPlans]);

  // A running plan starts out as the picked one. Its card is drawn selected
  // either way, and leaving the choice empty underneath it put a dead "Choose a
  // plan" beneath a card already marked Active.
  useEffect(() => {
    const running = plans?.current?.tier;
    if (running) setTier((picked) => picked || running);
  }, [plans]);

  // The estimate beside the balance. Secondary and never blocking: it appears
  // when the catalog lands and is simply absent if it does not.
  useEffect(() => {
    let alive = true;
    textModelCatalog().then((payload) => { if (alive) setCatalog(payload); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => () => { stopWallet.current?.(); }, []);

  // The quote expires while the sheet is open, so the countdown has to move on
  // its own — a stale "8 min" beside a dead quote is how somebody sends USDC to
  // an address that will no longer credit it.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!quote) return undefined;
    const timer = window.setInterval(() => tick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [quote]);

  // Two ways the wallet rail cannot work, both knowable before the press and
  // neither repaired by trying: there is no app on this machine to ask, or the
  // app pools a different balance from the one this studio spends — in which
  // case paying from it would top up the wrong account.
  const walletReason = {
    'no-app': t('credits.walletLocalOnly'),
    'different-account': t('credits.walletOtherAccount'),
  }[overview?.walletPayBlocked] || '';
  const usdcOff = Boolean(deposit && !deposit.available);
  const walletOff = Boolean(walletReason);

  // A rail can go unusable after it was chosen — the overview refreshes while
  // the sheet is open — and a footer press that acts on an unavailable rail
  // would fail for a reason the sheet already knew.
  useEffect(() => {
    if ((method === 'usdc' && usdcOff) || (method === 'wallet' && walletOff)) setMethod('card');
  }, [method, usdcOff, walletOff]);

  const funded = useCallback(() => {
    refresh();
    announceAccountChanged();
  }, [refresh]);

  const drafts = useMemo(() => {
    const row = rowFor(catalog, recommendedId(catalog));
    const perDraft = creditsPerCall(row, DRAFT_USAGE);
    const balance = Number(credits?.credits);
    if (!row || !perDraft || perDraft <= 0 || !credits?.configured || !Number.isFinite(balance)) return null;
    return { count: formatCredits(Math.floor(balance / perDraft)), model: row.name };
  }, [catalog, credits]);

  const planList = plans?.plans || [];
  const current = plans?.current || null;
  const betterRate = betterRateThanTopUp(planList);
  const expired = quote ? minutesLeft(quote.expiresAt) <= 0 : false;

  /* ---- the four acts the one footer press can perform ---- */

  const buyWithCard = async () => {
    setBusy(true);
    try {
      openCheckout((await startCardCheckout(amountUsd))?.checkoutUrl);
    } catch (error) {
      toast.error(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  const getQuote = async () => {
    setBusy(true);
    setUsdcFailure('');
    try {
      setQuote(await quoteDeposit(payer.trim(), amountUsd));
    } catch (error) {
      setUsdcFailure(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    setBusy(true);
    setUsdcFailure('');
    try {
      const result = await settleDeposit(quote.paymentId, hash.trim());
      toast.success(tf('credits.cryptoSettled', formatUsd(result?.creditedUsd ?? amountUsd)));
      setQuote(null);
      setHash('');
      funded();
    } catch (error) {
      setUsdcFailure(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  const askWallet = async () => {
    setBusy(true);
    let request;
    try {
      request = await startWalletPayment(amountUsd);
    } catch (error) {
      setBusy(false);
      toast.error(error?.message || t('credits.walletLocalOnly'));
      return;
    }
    // A custom scheme nothing handles fails SILENTLY — the same trap the
    // account link hit — so the wait is budgeted rather than open-ended, and
    // running out says "the app did not answer" instead of spinning forever.
    window.location.href = request.url;
    const deadline = Date.now() + WALLET_WAIT_MS;
    let cancelled = false;
    stopWallet.current = () => { cancelled = true; };
    const poll = async () => {
      if (cancelled) return;
      let state = 'pending';
      try {
        state = (await walletPaymentState(request.nonce))?.state || 'pending';
      } catch {
        state = 'pending';
      }
      if (cancelled) return;
      if (state === 'settled') {
        setBusy(false);
        toast.success(t('credits.walletApproved'));
        funded();
        return;
      }
      if (state === 'refused') {
        setBusy(false);
        toast.error(t('credits.walletRefused'));
        return;
      }
      if (state === 'expired' || Date.now() > deadline) {
        setBusy(false);
        toast.error(t('credits.walletNoApp'));
        return;
      }
      window.setTimeout(poll, WALLET_POLL_MS);
    };
    window.setTimeout(poll, WALLET_POLL_MS);
  };

  const subscribe = async () => {
    setBusy(true);
    try {
      openCheckout((await startSubscription(tier))?.checkoutUrl);
    } catch (error) {
      toast.error(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  /* ---- what the one press says, and whether it can be pressed ---- */

  const monthly = mode === 'monthly';
  const usdcQuoting = !monthly && method === 'usdc' && Boolean(quote);
  const subscribedToPick = Boolean(tier) && current?.tier === tier;

  let cta = { label: t('credits.cardGo'), external: true, act: buyWithCard, off: false };
  if (monthly) {
    const running = current?.tier || '';
    if (!tier || !planList.length) {
      cta = { label: t('credits.choosePlan'), external: false, act: () => {}, off: true };
    } else if (subscribedToPick) {
      cta = { label: tf('credits.subscribed', titled(tier)), external: false, act: () => {}, off: true };
    } else {
      // Picking a second tier while one runs is a CHANGE, not a new purchase,
      // and a button that says "Subscribe" beside a card marked Active reads
      // as buying a second plan.
      cta = {
        label: tf(running ? 'credits.switchTo' : 'credits.subscribeTo', titled(tier)),
        external: true,
        act: subscribe,
        off: false,
      };
    }
  } else if (method === 'wallet') {
    cta = { label: t('credits.walletGo'), external: false, act: askWallet, off: false };
  } else if (method === 'usdc') {
    cta = usdcQuoting && !expired
      ? { label: t('credits.cryptoConfirm'), external: false, act: settle, off: !hash.trim() }
      : usdcQuoting
        ? { label: t('credits.cryptoQuote'), external: false, act: () => setQuote(null), off: false }
        : { label: t('credits.cryptoQuote'), external: false, act: getQuote, off: !payer.trim() };
  }

  const honesty = monthly || method === 'card'
    ? t('credits.honestyCard')
    : method === 'usdc' ? t('credits.honestyCrypto') : t('credits.honestyWallet');

  const waitingOnApp = busy && !monthly && method === 'wallet';

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={t('credits.title')}
        size="lg"
        footer={
          <>
            {/* Grows rather than pushing: an auto margin in a WRAPPING flex row
                eats the whole line's free space, which sent the primary button
                to a second row all by itself. */}
            <span className="min-w-[180px] flex-1 text-[11px] leading-[1.45] text-ink3">
              {waitingOnApp ? t('credits.walletWaiting') : honesty}
            </span>
            <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
            <Button
              variant="primary"
              icon={cta.external ? 'external' : undefined}
              loading={busy}
              disabled={cta.off}
              onClick={() => void cta.act()}
            >
              {cta.label}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-[18px]">
          <BalanceCard loaded={loaded} credits={credits} drafts={drafts} />

          <div className="flex flex-col gap-3">
            <ModeTabs mode={mode} onMode={setMode} betterRate={betterRate} />

            {monthly ? (
              <div className="flex flex-col gap-[11px]">
                {plans === null ? (
                  <div className="grid gap-2 sm:grid-cols-3" aria-busy="true">
                    {[0, 1, 2].map((card) => (
                      <div key={card} className="flex flex-col gap-2 rounded-[10px] border border-line1 bg-bg2 px-3.5 py-[13px]">
                        <Skeleton className="h-3 w-12" />
                        <Skeleton className="h-4 w-14" />
                        <Skeleton className="h-2.5 w-20" />
                        <Skeleton className="h-2 w-16" />
                      </div>
                    ))}
                  </div>
                ) : planList.length ? (
                  <PlanCards plans={planList} current={current} picked={tier} onPick={setTier} />
                ) : (
                  <p className="text-[12px] text-ink3">{t('credits.plansUnavailable')}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-[1.5] text-ink3">
                  <span>{t('credits.planNote')}</span>
                  {current ? (
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      className="text-ink2 underline underline-offset-2 transition-colors duration-150 hover:text-ink1"
                    >
                      {t('credits.managePlan')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-[18px]">
                <AmountPicker amountUsd={amountUsd} onChange={setAmountUsd} />

                <div className="flex flex-col gap-[9px]">
                  <SectionLabel className="!mb-0">{t('credits.howToPay')}</SectionLabel>
                  <div className="flex flex-col gap-1.5">
                    <MethodRow
                      icon="card"
                      title={t('credits.card')}
                      hint={t('credits.cardHint')}
                      on={method === 'card'}
                      onPick={() => setMethod('card')}
                    />
                    <MethodRow
                      icon="coin"
                      title={t('credits.crypto')}
                      hint={usdcOff ? t('credits.cryptoUnavailable') : t('credits.cryptoHint')}
                      tag={usdcOff ? t('common.unavailable') : t('credits.cryptoTag')}
                      on={method === 'usdc'}
                      off={usdcOff}
                      onPick={() => setMethod('usdc')}
                    />
                    <MethodRow
                      icon="wallet"
                      title={t('credits.wallet')}
                      hint={walletReason || t('credits.walletHint')}
                      tag={walletOff ? t('common.unavailable') : t('credits.walletTag')}
                      on={method === 'wallet'}
                      off={walletOff}
                      onPick={() => setMethod('wallet')}
                    />
                  </div>
                </div>

                {method === 'usdc' && !quote ? (
                  <UsdcPayer
                    payer={payer}
                    onPayer={(value) => { setPayer(value); setUsdcFailure(''); }}
                    failure={usdcFailure}
                  />
                ) : null}
                {method === 'usdc' && quote ? (
                  <UsdcQuote
                    quote={quote}
                    amountUsd={amountUsd}
                    hash={hash}
                    onHash={(value) => { setHash(value); setUsdcFailure(''); }}
                    failure={usdcFailure}
                    expired={expired}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          try {
            await cancelSubscription();
            toast.success(t('credits.cancelled'));
            setConfirming(false);
            setTier('');
            await loadPlans();
            funded();
          } catch (error) {
            toast.error(error?.message || t('failure.generic'));
          }
        }}
        title={t('credits.cancelTitle')}
        body={t('credits.cancelBody')}
        confirmLabel={t('credits.cancelPlan')}
        cancelLabel={t('credits.keepPlan')}
      />
    </>
  );
}
