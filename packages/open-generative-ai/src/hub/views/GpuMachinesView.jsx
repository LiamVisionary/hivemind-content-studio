// GPU Machines view — rent provisioned studio ComfyUI boxes on Vast.ai from
// the owner's own account (/api/gpu-rentals on the control API; distinct from
// the hosted customer billing gateway). Tier presets, prices, and expected
// speeds come from the server; this view only renders and confirms.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zh } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import {
  Button, Card, CollapsibleSection, EmptyState, Field, IconButton, NativeSelect, Pill, SectionLabel, Segmented,
  Spinner, TextInput,
} from '../../ui/kit.jsx';
import { api, humanize } from '../hubData.js';
import { isRoutingLeader, notifyRentedMachinesChanged, requestRentedMode } from '../../lib/rentedMachines.js';
import { ConnectComfyCard } from '../components/ConnectComfyCard.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { RemoteAccessCard } from '../components/RemoteAccessCard.jsx';
import { StatusPill } from '../components/StatusPill.jsx';

// Money and a NaN must never meet: an unmanaged/external row may carry no
// usd_per_hour at all, and "$NaN/hr" (or a thrown toFixed) was the result.
const usd = (value, digits = 3) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? `$${Number(value).toFixed(digits)}` : '—');
const hours = (value) => (Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)}h` : '—');

// 6s while the view is open: provisioning machines report via their beacon,
// and the whole poll (list + beacon probes) is cheap.
const POLL_MS = 6000;
// Vast bills per second, but a machine that cannot stay up for an hour is not
// worth provisioning (the model pull alone is billed minutes) — the server
// refuses those, and the stepper stops before the refusal.
const MAX_BATCH = 8;

function formatSeconds(seconds) {
  if (!seconds) return '—';
  if (seconds >= 90) return `${(seconds / 60).toFixed(1)} min`;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

// What one failure says about the NEXT rental. Different failures used to
// share one verdict; each row now carries its own. A host that never starts
// its container IS a bad host. The beacon reports two distinct download
// endings: "failed" (a stream gave up after its resumed retries, or the object
// was refused — the reason carries the last curl/HTTP error) and "stalled"
// (still crawling at the deadline). Neither indicts the tier, and the failed
// host is held out of the next search either way.
function failureVerdict(reason = '') {
  if (/never started/i.test(reason)) {
    return 'The host never started its container — a bad host, not a bad GPU class. Rent again and you will get a different one.';
  }
  if (/download failed/i.test(reason)) {
    return 'A weight download gave up part-way — the reason names the last error. That host is held out for a day, so renting the same GPU class again lands on a different one.';
  }
  if (/download stalled/i.test(reason)) {
    return 'A weight download was still crawling at the deadline — usually the host\'s connection, not the GPU class. That host is held out for a day, so the same class is still worth retrying.';
  }
  return 'Usually a bad host, not a bad GPU class. Rent again and you will get a different one.';
}

// The rung that produces a generation for the least money. Not the cheapest
// per hour and not the fastest: a faster card bills for fewer seconds, so the
// two ends of the slider both tend to lose to something in the middle.
function bestValueClass(plan) {
  const priced = (plan?.classes || []).filter((c) => c.usd_per_generation && c.available);
  if (!priced.length) return null;
  return priced.reduce((best, c) => (c.usd_per_generation < best.usd_per_generation ? c : best)).gpu_class;
}

// What the slider's position MEANS. The rungs differ on three axes that do not
// agree — an RTX PRO 6000 costs 2.3x a 5090 per hour and generates slower on
// MiniMax H3 — so there is no honest single "up". Name the axis instead, and
// keep every axis pointing the same way: right = more of it.
const RANK_AXES = {
  price: {
    label: 'Price',
    axis: 'cheapest → priciest per hour',
    of: (r) => r.usd_per_hour ?? Infinity,
  },
  speed: {
    label: 'Speed',
    axis: 'slowest → fastest per generation',
    of: (r) => -(r.seconds_per_generation || Infinity),
  },
  vram: {
    label: 'VRAM',
    axis: 'smallest → largest card',
    of: (r) => r.vram_gb || 0,
  },
};

function rankClasses(classes, rankBy) {
  const axis = RANK_AXES[rankBy] || RANK_AXES.price;
  // Sold-out rungs sink regardless of axis — they cannot be picked.
  return [...classes].sort((a, b) => (!a.available) - (!b.available) || axis.of(a) - axis.of(b));
}

// Discrete slider over a workload's GPU ladder, ordered by the chosen axis.
function PerformanceSlider({ classes, index, onChange, disabled, unshopped }) {
  const max = classes.length - 1;
  const pct = max ? (index / max) * 100 : 100;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <input
          type="range"
          className="hive-range block"
          style={{ '--fill': `${pct}%` }}
          min={0}
          max={max}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Performance level"
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {/* Stops sit on the track so the ladder is legible at a glance; the
            range input above stays the thing that takes clicks and keys. */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2">
          {classes.map((rung, i) => (
            <span
              key={rung.gpu_class}
              className={cxStop(i <= index, rung.available)}
              style={{ left: `calc(${max ? (i / max) * 100 : 100}% - 3px)` }}
            />
          ))}
        </div>
      </div>
      <div className="relative h-8">
        {classes.map((rung, i) => (
          <button
            key={rung.gpu_class}
            type="button"
            disabled={disabled}
            onClick={() => onChange(i)}
            className={`absolute flex-col whitespace-nowrap text-[10px] leading-tight ${
              i === 0 ? 'items-start' : i === max ? 'items-end' : 'items-center'
            } ${i === index ? 'text-ink1 font-medium' : 'text-ink3 hover:text-ink2'} ${
              // Five stops do not fit a half-width column: below md only the
              // ends (and the selected rung) carry a label.
              i === 0 || i === max || i === index ? 'flex' : 'hidden md:flex'
            }`}
            style={{
              left: `${max ? (i / max) * 100 : 100}%`,
              transform: i === 0 ? 'none' : i === max ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            <span>{rung.label}</span>
            {/* The price on the axis itself: the trade-off has to be readable
                without selecting each stop in turn. */}
            <span className="font-mono text-[10px] text-ink3">
              {/* "sold out" is a claim about the market, and it is only ours to
                  make when a marketplace actually answered. With none of them
                  answering, every stop on the ladder read as sold out while the
                  cards were listed and rentable. */}
              {rung.usd_per_hour
                ? `$${rung.usd_per_hour.toFixed(2)}/hr`
                : (unshopped ? 'no price' : 'sold out')}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function cxStop(filled, available) {
  return `absolute h-1.5 w-1.5 rounded-full ${
    !available ? 'bg-warn' : filled ? 'bg-honey' : 'bg-line1'
  }`;
}

function RentConfigurator({ plans, prefer, onPrefer, account, busy, onRent }) {
  const [tier, setTier] = useState(plans[0]?.tier);
  const [gpuClass, setGpuClass] = useState('');
  const [count, setCount] = useState(1);
  // The rent request waiting for its confirmation — real money, so one click
  // opens the confirm and a second one spends.
  const [pendingRent, setPendingRent] = useState(null);

  const plan = plans.find((p) => p.tier === tier) || plans[0];
  // Price by default, so the cheapest machine is always the first thing the
  // slider offers; the other axes are there for "I need it fast" / "I need the
  // VRAM" and say so on the label.
  const [rankBy, setRankBy] = useState('price');
  const classes = useMemo(() => rankClasses(plan?.classes || [], rankBy), [plan, rankBy]);
  const bestValue = useMemo(() => bestValueClass(plan), [plan]);
  // Ordering is by the chosen axis, which is not the VRAM order, so the floor
  // has to be named rather than assumed to be first.
  const floorClass = classes.find((c) => c.gpu_class === plan?.floor_class);
  // Land on the best value per generation rather than the floor: the floor is
  // there to be a floor, not a recommendation.
  const index = Math.max(0, classes.findIndex((c) => c.gpu_class === (gpuClass || bestValue || plan?.reference_class)));
  const rung = classes[index] || classes[0];

  // Naming the rung that beats this one turns a warning into an instruction.
  const cheaperAndFaster = useMemo(() => {
    if (!rung?.costs_more_no_faster) return null;
    return (plan?.classes || [])
      .filter((c) => c.available && c.usd_per_hour && c.seconds_per_generation
        && c.usd_per_hour < rung.usd_per_hour
        && c.seconds_per_generation <= rung.seconds_per_generation)
      .sort((a, b) => a.seconds_per_generation - b.seconds_per_generation)[0] || null;
  }, [plan, rung]);

  const hourly = rung?.usd_per_hour || 0;
  // The marketplaces that did not answer THIS search. Without them an unpriced
  // rung reads as a sold-out market and a priced one reads as the whole market,
  // and on 2026-08-28 neither was true: both marketplaces were refusing a
  // sealed credential while Vast alone listed 39 rentable 5090s.
  const troubles = plan?.marketplace_failures || [];
  // The marketplace this rung would actually be rented from — the rungs are
  // ranked cheapest-first across every provider, so the cheapest offer is the
  // one the server will take, and its account is the one that has to fund it.
  // account.credit is a SUM across marketplaces and cannot authorize anything:
  // Vast credit does not pay a RunPod bill.
  const source = rung?.offers?.[0]?.provider;
  const purse = (account?.providers || []).find((p) => p.provider === source)
    || (account?.providers || [])[0]
    || null;
  const credit = purse ? purse.credit : account?.credit;
  const running = (purse ? purse.usd_per_hour_running : account?.usd_per_hour_running) || 0;
  // What is left after the machines ALREADY running take their hour — the same
  // sum the server refuses on, so the stepper cannot offer a batch that would
  // come back as a payment error.
  const spare = credit != null ? credit - running : null;
  const affordable = hourly && spare != null
    ? Math.max(0, Math.min(MAX_BATCH, Math.floor(spare / hourly)))
    : MAX_BATCH;
  const machines = Math.min(count, Math.max(1, affordable));
  const runway = hourly && credit != null ? credit / (hourly * machines + running) : null;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={plan?.tier}
          onChange={(next) => { setTier(next); setGpuClass(''); setCount(1); }}
          options={plans.map((p) => ({ value: p.tier, label: p.family }))}
        />
        <small className="text-[12px] text-ink3">{plan?.family_detail}</small>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Rank by</SectionLabel>
            <Segmented
              value={rankBy}
              onChange={(next) => setRankBy(next)}
              options={Object.entries(RANK_AXES).map(([key, a]) => ({ value: key, label: a.label }))}
            />
          </div>
          <small className="text-[11px] text-ink3">
            {RANK_AXES[rankBy].axis} · {floorClass?.label || classes[0]?.label} is the
            smallest card this workload fits on
          </small>
          <PerformanceSlider
            classes={classes}
            index={index}
            disabled={busy}
            unshopped={troubles.length > 0}
            onChange={(i) => setGpuClass(classes[i]?.gpu_class || '')}
          />
          <small className="mt-1 text-[11px] text-ink3">{rung?.note}</small>
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg1 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <b className="text-[15px] text-ink1">{rung?.label}</b>
            {rung?.vram_gb ? <span className="text-[12px] text-ink3">{rung.vram_gb}GB</span> : null}
            {rung?.cheapest && <Pill tone="ok">Cheapest</Pill>}
            {rung?.fastest && <Pill tone="ok">Fastest</Pill>}
            {rung?.gpu_class === bestValue && <Pill tone="ok">Best value</Pill>}
            {rung?.estimate_basis === 'measured' && <Pill tone="honey">Measured here</Pill>}
            {rung?.warm && (
              <Pill tone="ok" title={`A warm volume in ${rung.warm_data_center || 'its region'} already holds the models: the box mounts it and skips the download, ready in ~${rung.warm_setup_minutes ?? 3} min.`}>
                Warm · ~{rung.warm_setup_minutes ?? 3} min
              </Pill>
            )}
          </div>
          {/* The trap the ladder exists to expose. Said outright, because
              position on a one-dimensional slider cannot say it. */}
          {rung?.costs_more_no_faster && (
            <small className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
              Costs more per hour than a cheaper rung and is no faster on this workload
              {cheaperAndFaster ? ` — ${cheaperAndFaster.label} does it in ${formatSeconds(cheaperAndFaster.seconds_per_generation)} for $${cheaperAndFaster.usd_per_hour.toFixed(2)}/hr` : ''}.
            </small>
          )}
          {rung?.usd_per_hour ? (
            <>
              <span className="font-mono text-[13px] text-ink1">${rung.usd_per_hour.toFixed(3)}/hr</span>
              <small className="text-[12px] text-ink2">
                {plan.reference_job} in <b>{formatSeconds(rung.seconds_per_generation)}</b>
                {rung.estimate_basis === 'estimated' ? (
                  <>
                    {' '}
                    <span
                      className="text-ink3"
                      title="Scaled from the measured RTX 5090 time by Vast's own benchmark for this card — a generic deep-learning mix, not a diffusion one. It can be well out: on MiniMax H3 the RTX PRO 6000 measured 1.9x SLOWER than this scaling predicted. Treat an estimated rung as unproven, not as a promise."
                    >
                      (estimated)
                    </span>
                  </>
                ) : null}
                {rung.usd_per_generation ? ` · $${rung.usd_per_generation.toFixed(4)} per generation` : ''}
              </small>
              <small className="text-[11px] text-ink3">
                {/* A warm rung must never quote the download size: the whole
                    point is that this box mounts the models instead of pulling
                    them. Keying that off the two minute-figures DIFFERING was
                    wrong — when the cheapest offer is itself the warm one they
                    are equal, and the rung then advertised "66GB of models" for
                    a rental that downloads nothing. */}
                {rung.available} offer{rung.available === 1 ? '' : 's'} · ready in ~
                {rung.warm ? (rung.warm_setup_minutes ?? rung.setup_minutes) : rung.setup_minutes} min
                {rung.warm
                  ? ' · models already on a warm volume, nothing to download'
                  : ` (${plan.download_gb}GB of models)`}
              </small>
              {/* A price from half the market is not the market's price. */}
              {troubles.length ? (
                <small className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                  {troubles.map((t) => t.why).join('; ')} — this is what is left of the
                  market. {troubles[0].fix}
                </small>
              ) : null}
            </>
          ) : troubles.length ? (
            /* Not a sold-out market: nobody was successfully asked. Saying "no
               offers match" here is what sent an owner looking for cards that
               were listed the whole time, so name the marketplace that went
               quiet and the one thing that fixes it. */
            <div className="flex flex-col gap-1">
              {troubles.map((trouble) => (
                <small
                  key={trouble.provider}
                  className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn"
                >
                  <b>{trouble.why}.</b> {trouble.fix}
                </small>
              ))}
            </div>
          ) : (
            <small className="text-[12px] text-warn">
              No {rung?.label} offers match right now — try another rung or Lowest price.
            </small>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] text-ink2">Machines</span>
          <div className="flex items-center gap-0.5 rounded-md border border-line1 bg-bg1 p-0.5">
            <Button size="sm" variant="ghost" disabled={busy || machines <= 1} onClick={() => setCount(machines - 1)}>−</Button>
            <span className="w-6 text-center font-mono text-[13px] text-ink1">{machines}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || machines >= Math.max(1, affordable)}
              onClick={() => setCount(machines + 1)}
              title={machines >= affordable ? `Your ${purse?.label || 'marketplace'} credit will not cover another machine for an hour` : ''}
            >
              +
            </Button>
          </div>
        </div>
        {hourly ? (
          <small className="text-[12px] text-ink3">
            ${(hourly * machines).toFixed(3)}/hr total
            {runway ? ` · ~${runway.toFixed(runway < 10 ? 1 : 0)}h on $${credit.toFixed(2)} ${purse?.label || ''} credit` : ''}
          </small>
        ) : null}
        <span className="ml-auto" />
        <Segmented
          size="sm"
          value={prefer}
          onChange={onPrefer}
          options={[{ value: 'balanced', label: 'Fast start' }, { value: 'cheapest', label: 'Lowest price' }]}
        />
        <Button
          variant="primary"
          loading={busy}
          disabled={busy || !rung?.usd_per_hour || affordable < 1}
          title="Rents the ask quoted above. If it is gone by the time the click lands, the next host is taken only within a few cents of the quote — otherwise nothing is rented and the price refreshes."
          onClick={() => setPendingRent({
            tier: plan.tier,
            gpu_class: rung.gpu_class,
            count: machines,
            // The exact ask the quote came from, and the number on the button:
            // the server tries that ask first and bounds any fallback to it.
            offer: rung.offers?.[0] || null,
            usd_per_hour: rung.usd_per_hour,
            label: rung.label,
          })}
        >
          {busy ? 'Provisioning…' : machines > 1 ? `Rent ${machines} machines` : 'Rent machine'}
        </Button>
      </div>
      {affordable < 1 && credit != null ? (
        <small className="text-[11px] text-warn">
          ${credit.toFixed(2)} {purse?.label} credit will not fund a {rung?.label} for an hour — add credit at{' '}
          {purse?.credit_url || 'vast.ai'} or pick a cheaper rung.
        </small>
      ) : null}
      <ConfirmModal
        open={Boolean(pendingRent)}
        tone="primary"
        onClose={() => setPendingRent(null)}
        onConfirm={() => { const request = pendingRent; setPendingRent(null); onRent(request); }}
        title={pendingRent?.count > 1 ? `Rent ${pendingRent.count} machines?` : 'Rent this machine?'}
        confirmLabel={pendingRent?.count > 1 ? `Rent ${pendingRent.count} machines` : 'Rent machine'}
        body={pendingRent ? (
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>
              <b className="text-ink1">{pendingRent.label}</b>
              {' · '}
              <span className="font-mono text-ink1">{usd(pendingRent.usd_per_hour)}/hr × {pendingRent.count}</span>
              {' = '}
              <span className="font-mono text-ink1">{usd(pendingRent.usd_per_hour * pendingRent.count)}/hr</span>
              {' on '}{purse?.label || 'marketplace'} credit.
            </p>
            <p className="text-ink3">
              Billed per second while running, from the moment the host is taken — provisioning time included.
              Pause keeps the disk at a lower rate; Destroy stops all billing.
            </p>
          </div>
        ) : null}
      />
    </Card>
  );
}

// Provisioning lifecycle in on-box beacon order. `phase` "booting" precedes
// beacon contact; after that the beacon's `step` drives the active row.
// Below this, a stale reading is just poll jitter and saying so is noise.
const STALE_BEACON_NOTICE_S = 45;

const PROVISION_STEPS = [
  { key: 'booting', label: 'Booting host' },
  { key: 'installing', label: 'Installing the ComfyUI stack' },
  { key: 'downloading', label: 'Downloading models' },
  { key: 'starting-comfy', label: 'Starting ComfyUI' },
  { key: 'ready', label: 'Ready' },
];

function stepIndex(machine) {
  if (machine.phase === 'booting') return 0;
  const step = machine.provision?.step || 'booting';
  // 'error' is not a step in the ladder. Falling back to 0 for it drew a
  // SPINNER on "Booting host" for a machine that had already died — so a box
  // that would never work looked like it was still starting, and the natural
  // response was to keep waiting and keep paying for it.
  if (step === 'error') {
    const reached = PROVISION_STEPS.findIndex((s) => s.key === 'downloading');
    return machine.provision?.done ? reached : 0;
  }
  const idx = PROVISION_STEPS.findIndex((s) => s.key === (step === 'syncing' ? 'installing' : step));
  return idx === -1 ? 0 : idx;
}

function ProvisionStepper({ machine }) {
  const current = stepIndex(machine);
  const p = machine.provision;
  const failed = machine.phase === 'error';
  return (
    <div className={`flex flex-col gap-1.5 rounded-md border p-3 ${failed ? 'border-danger/40 bg-danger-tint' : 'border-line1 bg-bg1'}`}>
      {failed && (
        <div className="mb-1 flex flex-col gap-0.5">
          <b className="text-[12px] text-danger">Provisioning failed — this machine cannot be used</b>
          <small className="text-[11px] text-ink2">
            {p?.detail || 'The box reported an error before ComfyUI came up.'}
          </small>
          <small className="text-[11px] text-ink3">
            It is being destroyed automatically; Vast bills a broken box like a working one and refunds nothing.
          </small>
        </div>
      )}
      {PROVISION_STEPS.map((step, i) => {
        const isDone = i < current;
        const isActive = i === current;
        return (
          <div key={step.key} className="flex items-center gap-2 text-[12px]">
            {isDone ? (
              <span className="grid h-4 w-4 place-items-center text-ok"><Icon name="check" size={12} /></span>
            ) : isActive && failed ? (
              <span className="grid h-4 w-4 place-items-center text-danger"><Icon name="x" size={12} /></span>
            ) : isActive ? (
              <Spinner size={13} className="text-honey" />
            ) : (
              <span className="grid h-4 w-4 place-items-center text-ink3"><span className="h-1 w-1 rounded-full bg-current" /></span>
            )}
            <span className={isActive && failed ? 'font-medium text-danger'
              : isActive ? 'text-ink1 font-medium' : isDone ? 'text-ink2' : 'text-ink3'}>
              {step.label}
              {isActive && step.key === 'downloading' && p?.total ? ` — ${p.done}/${p.total}` : ''}
              {isActive && failed ? ' — stopped here' : ''}
            </span>
            {/* The reason already has its own line in the failure header. */}
            {isActive && !failed && p?.detail ? (
              <small className="truncate font-mono text-[11px] text-ink3">{p.detail}</small>
            ) : null}
          </div>
        );
      })}
      {/* A remembered reading must not pose as a live one. The box goes quiet
          for minutes at a time while it saturates its uplink pulling models,
          so silence alone is not a failure — but the operator should be able
          to tell "still working" from "last thing we heard". */}
      {!failed && p?.stale_seconds > STALE_BEACON_NOTICE_S ? (
        <small className="mt-0.5 text-[11px] text-warn">
          No contact with the box for {formatSeconds(p.stale_seconds)} — showing its last known
          progress. Normal while it is pulling models at full speed.
        </small>
      ) : null}
    </div>
  );
}

function StudioButtons({ machine, onUse, onDetach, busy, applying, leading, shared }) {
  const pages = machine.studio_pages || [];
  if (applying) {
    return (
      <div className="flex items-center gap-2">
        <Spinner size={14} className="text-honey" />
        <small className="text-[12px] text-ink2">
          Attaching — opening a tunnel to the machine…
        </small>
      </div>
    );
  }
  // One-click use: attaches (and takes over routing) when needed, then opens
  // the studio in Rented mode. Attaching is live — the gateway re-reads the
  // lane registry per request, so nothing restarts and nothing in flight is
  // interrupted.
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pages.map((page) => (
        <Button
          key={page}
          variant={leading ? 'neutral' : 'primary'}
          size="sm"
          loading={busy}
          disabled={busy}
          onClick={() => onUse(machine, page)}
        >
          {leading ? 'Open' : 'Use in'} {page === 'image' ? 'Image' : 'Video'} Studio
        </Button>
      ))}
      {machine.attached && !machine.tunnel_alive && (
        <Pill tone="warn" className="h-5 px-2 text-[10px]">Tunnel down — Use re-attaches</Pill>
      )}
      {machine.attached ? (
        <Button variant="neutral" size="sm" disabled={busy} onClick={() => onDetach(machine)}>
          Detach
        </Button>
      ) : (
        <small className="text-[11px] text-ink3">First use routes this GPU class&apos;s models through the machine.</small>
      )}
      {shared && !leading && machine.attached ? (
        <small className="text-[11px] text-ink3">
          Another machine is serving these models — Use switches them over.
        </small>
      ) : null}
    </div>
  );
}

function MachineRow({ machine, onDestroy, destroying, onUse, onDetach, onPause, onResume, attachBusy, applying, leading, shared }) {
  const ready = machine.phase === 'ready';
  const paused = machine.phase === 'paused';
  // Resume was asked for and the host has not honoured it within the grace
  // period: Vast's own guidance is that a restart stuck >30 s means the GPU
  // is rented by someone else. Still "paused" (disk intact, still billing),
  // but the row has to say so and show the way out.
  const resumeBlocked = paused && Boolean(machine.resume_blocked);
  const resuming = paused && !resumeBlocked && Boolean(machine.resume_requested_at);
  // A failed box reports Vast status "running" — it IS running, and billing,
  // it just cannot serve anything. Take the tone from the phase, not the host.
  const failed = machine.phase === 'error';
  const pillStatus = ready ? 'succeeded' : resumeBlocked ? 'failed' : paused ? 'waiting' : failed ? 'failed'
    : machine.phase === 'provisioning' || machine.phase === 'booting' ? 'running' : machine.status;
  const pillLabel = humanize(ready ? 'ready' : failed ? 'failed' : resumeBlocked ? 'resume blocked' : resuming ? 'resuming' : machine.phase);
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={pillStatus} label={pillLabel} />
        <b className="font-mono text-[13px] text-ink1">{machine.gpu || 'GPU'}</b>
        {machine.tier_label && (
          <span className="text-[12px] text-ink3">{machine.tier_label.replace(/^[^·]+· /, '')}</span>
        )}
        {leading && ready && (
          <Pill tone="ok" dot>
            Running generations
          </Pill>
        )}
        <span className="font-mono text-[12px] text-ink2">
          {usd(paused ? (machine.paused_usd_per_hour ?? 0) : machine.usd_per_hour)}/hr
          {paused ? <span className="text-ink3"> (disk only)</span> : null}
        </span>
        {machine.seconds_per_generation && !paused ? (
          <span className="text-[12px] text-ink3" title={`Per ${machine.reference_job}`}>
            ~{formatSeconds(machine.seconds_per_generation)}/gen
            {machine.estimate_basis === 'estimated' ? ' (est.)' : ''}
          </span>
        ) : null}
        {machine.uptime_hours != null && (
          <span className="text-[12px] text-ink3">
            Up {hours(machine.uptime_hours)}
            {Number.isFinite(Number(machine.usd_per_hour)) ? ` · ≈${usd(machine.uptime_hours * machine.usd_per_hour, 2)} so far` : ''}
          </span>
        )}
        {!machine.managed && (
          <Pill tone="warn" className="h-5 px-2 text-[10px]" title="Rented through the billing gateway; managed elsewhere">External</Pill>
        )}
        <span className="ml-auto" />
        {machine.managed && (ready || paused) && (
          paused ? (
            <Button
              variant="primary"
              size="sm"
              disabled={attachBusy}
              onClick={() => onResume(machine)}
              title={resumeBlocked
                ? 'Ask the host again. If the GPU stays taken, destroy this machine and rent a fresh one.'
                : 'Quick resume: the models are still on the disk, so the box is back in about a minute — if the host still has the GPU free.'}
            >
              {resumeBlocked ? 'Retry resume' : resuming ? 'Resuming…' : 'Quick resume'}
            </Button>
          ) : (
            <Button
              variant="neutral"
              size="sm"
              disabled={attachBusy}
              onClick={() => onPause(machine)}
              title="Stops the GPU (and its hourly price) but keeps the disk with every model on it, so resuming takes about a minute instead of a fresh 15–30 minute provision. While paused you pay only for the disk — and the GPU is not reserved for you."
            >
              Pause (keeps disk)
            </Button>
          )
        )}
        {machine.managed && (
          <Button variant="danger" size="sm" loading={destroying} disabled={destroying} onClick={() => onDestroy(machine)}>
            {destroying ? 'Destroying…' : 'Destroy'}
          </Button>
        )}
      </div>
      <small className="font-mono text-[11px] text-ink3">
        {machine.provider_label ? `${machine.provider_label} · ` : ''}
        {machine.label || `id ${machine.rental_id}`}
      </small>
      {machine.managed && paused && !resumeBlocked && (
        <small
          className="text-[12px] text-ink3"
          title={`The models stay on the disk${machine.disk_gb ? ` (${machine.disk_gb}GB)` : ''}, so resuming takes about a minute instead of a fresh provision (measured 40 s on a PRO 6000). Marketplaces often bill stopped storage at a higher rate than running. The GPU is released to the host while paused; if someone else rents it, your resume waits on "scheduling" until it is free again. Destroy to stop paying for the disk.`}
        >
          Paused — disk kept at {usd(machine.paused_usd_per_hour ?? 0)}/hr, resume takes about a minute.
          The GPU is not reserved while paused.
        </small>
      )}
      {machine.managed && resumeBlocked && (
        <small className="text-[12px] text-warn">
          Resume was asked for {machine.resume_requested_at ? `${Math.max(1, Math.round((Date.now() / 1000 - machine.resume_requested_at) / 60))} min ago` : 'a while ago'} and
          the host has not given the GPU back — most likely someone else is renting it. Your disk and models
          are intact and still billing at {usd(machine.paused_usd_per_hour ?? 0)}/hr. Keep retrying, or destroy
          this machine and rent a fresh one.
        </small>
      )}
      {machine.managed && !ready && !paused && <ProvisionStepper machine={machine} />}
      {machine.managed && ready && (
        <StudioButtons
          machine={machine}
          onUse={onUse}
          onDetach={onDetach}
          busy={attachBusy}
          applying={applying}
          leading={leading}
          shared={shared}
        />
      )}
      {machine.ssh_command && (
        <code className="select-all rounded border border-line1 bg-bg1 px-2 py-1 font-mono text-[11px] text-ink2">
          {machine.ssh_command}
        </code>
      )}
      {machine.comfy_url && <small className="text-[11px] text-ink3">ComfyUI: {machine.comfy_url}</small>}
    </Card>
  );
}

// A warm volume: persistent storage on a cloud that keeps one (RunPod), stocked
// once with a tier's models so every later rental in that region mounts it
// and skips the download entirely (measured cold: 25 of 27 provisioning
// minutes were the pull). Billed per GB-month whether or not a box is using
// it; a stocking box is a normal rental of the tier, destroyed the moment it
// reports ready.
// A warm region is the one piece of studio spend with no row in Machines to
// remind you it exists, so the card carries both numbers: the rate, and what
// it has actually cost since it was created. A total under a cent renders as
// "<$0.01" — "$0.00" reads as free, which is the one thing it is not.
const warmUsd = (value) => {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
};
const warmAge = (hours) => {
  if (hours == null || Number.isNaN(Number(hours))) return null;
  const h = Number(hours);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)}h`;
  return `${(h / 24).toFixed(h < 240 ? 1 : 0)}d`;
};

function WarmVolumesCard({ plans, active }) {
  const [volumes, setVolumes] = useState(null);
  // `error` is what an action said (dismissable, never wiped by the poll);
  // `loadError` is the poll's own and only shows while there is no data.
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState(plans?.[0]?.tier || 'minimax');
  const [dataCenter, setDataCenter] = useState('EU-RO-1');
  // Confirmations: money (stock) and destruction (delete) each wait for a
  // second click in the app's own modal.
  const [confirmStock, setConfirmStock] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const hasVolumesRef = useRef(false);
  const load = useCallback(async () => {
    try {
      const body = await api('/api/gpu-rentals/warm-volumes');
      hasVolumesRef.current = true;
      setVolumes(body.volumes || []);
      setLoadError('');
    } catch (e) {
      // With data on screen a failed poll is just stale; only an empty card
      // needs to say why it is empty.
      if (!hasVolumesRef.current) setLoadError(e.message);
    }
  }, []);
  // Only while this page is showing and the tab is visible: hub views never
  // unmount, so an ungated interval here ran for the life of the tab.
  useEffect(() => {
    if (!active) return undefined;
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(timer);
  }, [load, active]);
  const stock = async () => {
    setError('');
    setBusy(true);
    setConfirmStock(false);
    try {
      await api('/api/gpu-rentals/warm-volumes', {
        method: 'POST',
        body: JSON.stringify({ tier, data_center_id: dataCenter.trim() }),
      });
      await load();
      notifyRentedMachinesChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (volume) => {
    setError('');
    setBusy(true);
    try {
      await api(`/api/gpu-rentals/warm-volumes/${encodeURIComponent(volume.tier)}`, { method: 'DELETE' });
      await load();
      setPendingDelete(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const tierLabel = (plans || []).find((p) => p.tier === tier)?.tier_label || tier;
  const deleteSaving = pendingDelete ? warmUsd(pendingDelete.usd_per_month) : null;
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Warm regions</SectionLabel>
      <Card className="flex flex-col gap-3 p-4">
        <small className="text-[12px] text-ink2">
          A warm region keeps a tier&rsquo;s models on a persistent volume (RunPod Secure Cloud) so a new machine
          there is ready in minutes instead of downloading 60&ndash;100&nbsp;GB first.
          {' '}<span className="text-ink3" title="Storage is $0.07/GB per month (first 1 TB) and bills from the moment the volume is created until you delete it, whether or not a machine is attached. Stocking it also rents one machine for the length of the download.">Storage bills monthly until deleted.</span>
        </small>
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-danger-tint px-3 py-2">
            <small className="min-w-0 flex-1 font-mono text-[11px] text-danger">{error}</small>
            <IconButton icon="x" size="xs" label="Dismiss" onClick={() => setError('')} />
          </div>
        )}
        {volumes === null ? (
          loadError
            ? <small className="font-mono text-[11px] text-danger">{loadError}</small>
            : <Spinner size={13} className="text-honey" />
        ) : volumes.length === 0 ? (
          <small className="text-[12px] text-ink3">No warm regions yet.</small>
        ) : (
          <div className="flex flex-col gap-2">
            {volumes.map((v) => (
              <div key={v.key} className="flex flex-wrap items-center gap-2 text-[12px]">
                <StatusPill status={v.state === 'stocked' ? 'succeeded' : v.state === 'error' ? 'failed' : 'running'} label={humanize(v.state)} />
                <b className="text-ink1">{v.tier_label || v.tier}</b>
                <span className="font-mono text-ink2">{v.provider} · {v.data_center_id} · {v.size_gb}GB</span>
                {v.usd_per_month != null && (
                  <span
                    className="font-mono text-ink2"
                    title={`${v.size_gb}GB at RunPod's network-volume rate ($0.07/GB/month for the first 1TB). Billed from creation until the volume is deleted, whether or not a machine is attached.`}
                  >
                    {warmUsd(v.usd_per_month)}/mo
                    {v.usd_accrued != null && (
                      <span className="text-ink3">
                        {' · '}{warmUsd(v.usd_accrued)} so far{warmAge(v.age_hours) ? ` (${warmAge(v.age_hours)})` : ''}
                      </span>
                    )}
                  </span>
                )}
                {v.state === 'stocking' && v.stocking_rental_id && (
                  <span className="text-ink3">Stocking on {v.stocking_rental_id} — watch it under Active machines</span>
                )}
                {v.state === 'error' && <span className="text-warn">{v.detail}</span>}
                <span className="ml-auto" />
                {v.state === 'error' && (
                  <Button size="sm" variant="neutral" disabled={busy} onClick={() => { setTier(v.tier); setDataCenter(v.data_center_id); setConfirmStock(true); }}>
                    Retry stocking
                  </Button>
                )}
                <Button size="sm" variant="danger" disabled={busy} onClick={() => setPendingDelete(v)}>Delete</Button>
              </div>
            ))}
          </div>
        )}
        {volumes && volumes.length > 1 && (
          <small className="text-[12px] text-ink2">
            Together: <b>{warmUsd(volumes.reduce((sum, v) => sum + (Number(v.usd_per_month) || 0), 0))}/mo</b>
            {' · '}{warmUsd(volumes.reduce((sum, v) => sum + (Number(v.usd_accrued) || 0), 0))} so far.
          </small>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Tier" className="w-44">
            <NativeSelect value={tier} onChange={(e) => setTier(e.target.value)}>
              {(plans || []).map((p) => <option key={p.tier} value={p.tier}>{p.tier_label || p.tier}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Data center" className="w-40">
            <TextInput
              className="font-mono"
              value={dataCenter}
              onChange={(e) => setDataCenter(e.target.value)}
              placeholder="EU-RO-1"
              title="RunPod data center id with storage support (e.g. EU-RO-1, EUR-IS-1, CA-MTL-3, US-IL-1)"
            />
          </Field>
          <Button size="sm" variant="neutral" loading={busy} disabled={busy || !dataCenter.trim()} onClick={() => setConfirmStock(true)}>
            Stock a warm region
          </Button>
        </div>
      </Card>
      <ConfirmModal
        open={confirmStock}
        tone="primary"
        onClose={() => (busy ? null : setConfirmStock(false))}
        onConfirm={stock}
        busy={busy}
        title={`Stock a warm region in ${dataCenter.trim() || '…'}?`}
        confirmLabel="Stock region"
        body={(
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>Creates a persistent volume in <b className="text-ink1">{dataCenter.trim()}</b> and fills it with the <b className="text-ink1">{tierLabel}</b> models.</p>
            <p className="text-ink3">
              Storage is <span className="font-mono text-ink2">$0.07/GB per month</span> and bills from creation until you delete the volume —
              whether or not a machine is attached. Stocking also rents one machine for the length of the download.
            </p>
          </div>
        )}
      />
      <ConfirmModal
        open={Boolean(pendingDelete)}
        onClose={() => (busy ? null : setPendingDelete(null))}
        onConfirm={() => remove(pendingDelete)}
        busy={busy}
        title={pendingDelete ? `Delete the warm volume in ${pendingDelete.data_center_id}?` : 'Delete this warm volume?'}
        confirmLabel="Delete volume"
        body={pendingDelete
          ? `The ${pendingDelete.tier_label || pendingDelete.tier} models on it are gone and the next rental there downloads them again (~25 min).${deleteSaving ? ` This stops ${deleteSaving}/month.` : ''}`
          : ''}
      />
    </section>
  );
}

function rentalRequestId() {
  try { return crypto.randomUUID(); } catch { return `rent-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`; }
}

export function GpuMachinesView({ active }) {
  const [plans, setPlans] = useState(null);
  const [rentals, setRentals] = useState(null);
  const [account, setAccount] = useState(null);
  // Machines destroyed because provisioning failed. They are gone from the
  // list by design, and a machine that silently disappears while the credit
  // drops is worse than no automation at all.
  const [failures, setFailures] = useState([]);
  // Failures dismissed from this screen. The server stamps them too (they stay
  // out of the list across reloads, and the host stays barred), but a poll
  // that was already in flight when the dismissal went out would bring the
  // row back for one cycle on its way in — so the view also keeps its own set.
  const dismissedRef = useRef(new Set());
  // Two different things used to share one `error`: what an ACTION said (a rent
  // refused, a destroy that failed) and what the POLL said (the list could not
  // be read at all). The poll cleared both on its next success, so an action's
  // explanation lived ≤6 s. Now the poll owns only loadError/stale; `error` and
  // `notice` are the user's, cleared by a dismiss or by the next action.
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  // A failed poll that still has good data on screen — reported as a chip, not
  // as an error that wipes the view.
  const [stale, setStale] = useState('');
  const [renting, setRenting] = useState(false);
  const [prefer, setPrefer] = useState('balanced');
  const [destroyingId, setDestroyingId] = useState(null);
  const [pendingDestroy, setPendingDestroy] = useState(null);
  const beginAction = () => { setError(''); setNotice(''); };
  const pollRef = useRef(null);
  const hasDataRef = useRef(false);
  // Read inside the memoised refresh without making it a dependency.
  const preferRef = useRef('balanced');

  const refresh = useCallback(async (withOffers) => {
    try {
      const rentalData = await api('/api/gpu-rentals');
      setRentals(rentalData.rentals || []);
      setAccount(rentalData.account || null);
      setFailures((rentalData.failures || []).filter(
        (failure) => !dismissedRef.current.has(String(failure.rental_id)),
      ));
      hasDataRef.current = true;
      if (withOffers) {
        const tierKeys = rentalData.tiers || ['image', 'video'];
        try {
          // One plan per workload prices its whole GPU ladder, so moving the
          // slider costs nothing.
          setPlans(await Promise.all(
            tierKeys.map((key) => api(
              `/api/gpu-rentals/plan?tier=${encodeURIComponent(key)}&prefer=${encodeURIComponent(preferRef.current)}`,
            )),
          ));
        } catch (err) {
          // A 404 here is version skew, not a missing feature: this view ships
          // with /api/gpu-rentals/plan, but the control API is a long-lived
          // process that only picks up new routes on restart. FastAPI's bare
          // "Not Found" sent someone hunting through the UI for the fault.
          throw /not found/i.test(err.message || '')
            ? new Error('The studio API is running an older build without the rental planner — '
              + 'restart the stack (zimage-stack restart), then reload.')
            : err;
        }
      }
      setLoadError('');
      setStale('');
    } catch (err) {
      const message = err.message || 'Failed to reach the rentals API';
      // A poll that fails while a machine is provisioning must not replace a
      // working screen with a red banner: the control API is a local process
      // that restarts, and a single dropped request is not an outage. Keep the
      // last good data and say quietly that it went stale; only a view with
      // NOTHING on it gets the hard error.
      if (hasDataRef.current) setStale(message);
      else setLoadError(message);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      return undefined;
    }
    refresh(true);
    // Tab hidden = no poll; the beacon probes are cheap but not free.
    pollRef.current = setInterval(() => { if (!document.hidden) refresh(false); }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [active, refresh]);

  useEffect(() => {
    preferRef.current = prefer;
    if (active) refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefer]);

  const rent = async ({ tier, gpu_class: gpuClass, count, offer, usd_per_hour: quoted }) => {
    beginAction();
    setRenting(true);
    try {
      const body = await api('/api/gpu-rentals', {
        method: 'POST',
        body: JSON.stringify({
          tier,
          gpu_class: gpuClass,
          count,
          prefer,
          // One id per click: a retry after a proxy timeout replays the same
          // rental on the server instead of renting a second billing machine.
          request_id: rentalRequestId(),
          // Pin the quoted ask and bound the fallbacks to its price: a rent
          // that silently landed on the next-cheapest host (+7.4% on
          // 2026-08-22) is how the card and the bill came to disagree.
          ...(offer ? { offer_id: offer.offer_id, provider: offer.provider } : {}),
          ...(quoted ? { max_usd_per_hour: quoted } : {}),
        }),
      });
      // Re-price first — the server drops its market snapshot on every rent.
      await refresh(true);
      const notices = [];
      // A batch can come up short when asks evaporate mid-flight; those
      // machines are already billing, so say it rather than silently
      // returning fewer than asked.
      if (body.partial) notices.push(body.partial);
      // Landed within tolerance but not on the quoted number: say so, with
      // both figures, instead of leaving the user to notice on the bill.
      const landed = body.usd_per_hour;
      if (quoted && landed && Math.abs(landed - quoted) >= 0.0005) {
        notices.push(`rented at $${landed.toFixed(3)}/hr, not the $${quoted.toFixed(3)}/hr quoted — that ask was taken, and the next host was within a few cents`);
      }
      // Not an error — the rent went through — so it is a warn notice, not the
      // danger card, and it stays until dismissed.
      setNotice(notices.length ? `Heads up — ${notices.join('; ')}.` : '');
    } catch (err) {
      // A refusal means the quote was stale: re-price the card so the number
      // on the button and the message agree, then show why nothing rented.
      try { await refresh(true); } catch { /* the message below still stands */ }
      setError(err.message);
    } finally {
      setRenting(false);
    }
  };

  const [attachBusyId, setAttachBusyId] = useState(null);
  const [applyingId, setApplyingId] = useState(null);

  // Kept for the operator escape hatch that still restarts (a hand-edited env
  // overlay); the normal attach/detach/destroy paths report restarting_stack
  // false and never call this.
  const waitForStackReturn = useCallback(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 4000); });
    for (let i = 0; i < 60; i += 1) {
      try {
        await api('/healthz');
        return;
      } catch {
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
      }
    }
  }, []);

  const applyAttachment = async (machine, method) => {
    beginAction();
    setAttachBusyId(machine.rental_id);
    try {
      const body = await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}/attach`, { method });
      if (body.restarting_stack) {
        setApplyingId(machine.rental_id);
        await waitForStackReturn();
        setApplyingId(null);
      }
      await refresh(false);
      notifyRentedMachinesChanged();
    } catch (err) {
      setError(err.message);
      setApplyingId(null);
    } finally {
      setAttachBusyId(null);
    }
  };

  const useMachine = async (machine, page) => {
    // "Use" now SELECTS: with more than one machine serving the same models,
    // attaching alone would leave the generation on whichever one already led.
    if (!machine.attached || !machine.tunnel_alive || !isRoutingLeader(machine, rentals || [])) {
      beginAction();
      setAttachBusyId(machine.rental_id);
      try {
        const body = await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}/select`, { method: 'POST' });
        if (body.restarting_stack) {
          setApplyingId(machine.rental_id);
          await waitForStackReturn();
          setApplyingId(null);
        }
        await refresh(false);
      } catch (err) {
        setError(err.message);
        setApplyingId(null);
        setAttachBusyId(null);
        return;
      }
      setAttachBusyId(null);
      notifyRentedMachinesChanged();
    }
    requestRentedMode(page);
    // Always announce: the target studio is already mounted and must pick up
    // the handoff (and the machine's served models) BEFORE it renders.
    notifyRentedMachinesChanged();
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page } }));
  };

  const pauseMachine = async (machine) => {
    beginAction();
    setAttachBusyId(machine.rental_id);
    try {
      await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}/pause`, { method: 'POST' });
      await refresh(false);
      notifyRentedMachinesChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setAttachBusyId(null);
    }
  };

  const resumeMachine = async (machine) => {
    beginAction();
    setAttachBusyId(machine.rental_id);
    try {
      await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}/resume`, { method: 'POST' });
      await refresh(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setAttachBusyId(null);
    }
  };

  // Called AFTER the ConfirmModal's Destroy; the row's button only opens it.
  const destroy = async (machine) => {
    beginAction();
    setPendingDestroy(null);
    setDestroyingId(machine.rental_id);
    try {
      const body = await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}`, { method: 'DELETE' });
      // Destroying an ATTACHED machine restarts the stack to drop its lane, so
      // wait for the studio to come back before refreshing — otherwise the
      // refresh fires into a server that is going down and the destroy reads
      // as "Failed to fetch" despite having succeeded.
      if (body.restarting_stack) {
        setApplyingId(machine.rental_id);
        await waitForStackReturn();
        setApplyingId(null);
      }
      await refresh(false);
      notifyRentedMachinesChanged();
    } catch (err) {
      setError(err.message);
      setApplyingId(null);
    } finally {
      setDestroyingId(null);
    }
  };

  // One notice, or every notice. Optimistic: the row goes the moment it is
  // clicked, and only comes back if the server refused to remember it.
  const dismissFailures = async (rentalId = null) => {
    beginAction();
    const ids = rentalId === null
      ? failures.map((failure) => String(failure.rental_id))
      : [String(rentalId)];
    ids.forEach((id) => dismissedRef.current.add(id));
    setFailures((current) => current.filter((failure) => !dismissedRef.current.has(String(failure.rental_id))));
    try {
      await api(
        rentalId === null
          ? '/api/gpu-rentals/failures'
          : `/api/gpu-rentals/failures/${encodeURIComponent(rentalId)}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      ids.forEach((id) => dismissedRef.current.delete(id));
      setError(`Could not dismiss the failure notice — ${err.message}`);
      refresh(false);
    }
  };

  const loading = rentals === null && !loadError;
  const machineName = (machine) => machine?.label || machine?.gpu || (machine?.rental_id ? `machine ${machine.rental_id}` : 'this machine');

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={zh() ? '自有算力' : 'Owner compute'}
        title={zh() ? '租用的 GPU' : 'Rented GPUs'}
        subtitle={zh() ? '运行时按秒计费' : 'Billed per second while running'}
      />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {loadError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-tint p-3">
            <small className="min-w-0 flex-1 font-mono text-[12px] text-danger">{loadError}</small>
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-tint p-3" role="alert">
            <small className="min-w-0 flex-1 font-mono text-[12px] text-danger">{error}</small>
            <IconButton icon="x" size="sm" label="Dismiss" className="-mr-1 -mt-1" onClick={() => setError('')} />
          </div>
        )}
        {notice && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3" role="status">
            <Pill tone="warn" className="shrink-0">Heads up</Pill>
            <small className="min-w-0 flex-1 text-[12px] text-ink1">{notice.replace(/^Heads up — /, '')}</small>
            <IconButton icon="x" size="sm" label="Dismiss" className="-mr-1 -mt-1" onClick={() => setNotice('')} />
          </div>
        )}
        {stale && !loadError && (
          <Card className="mb-4 flex items-center gap-2 border-warn/40 p-2 text-[11px] text-warn">
            <Spinner size={12} className="text-warn" />
            Showing the last reading — the studio API did not answer the latest poll
            ({stale}). Retrying every {Math.round(POLL_MS / 1000)}s.
          </Card>
        )}
        {failures.length > 0 && (
          <section className="mb-4 flex flex-col gap-2" aria-label="Provisioning failures">
            <div className="flex items-center justify-between gap-3">
              <b className="text-[12px] text-danger">
                {failures.length === 1 ? 'A machine failed to provision and was destroyed'
                  : `${failures.length} machines failed to provision and were destroyed`}
              </b>
              {failures.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => dismissFailures()}>
                  Dismiss all
                </Button>
              )}
            </div>
            {failures.map((failure) => (
              <Card
                key={`${failure.rental_id}-${failure.destroyed_at}`}
                className="flex items-start gap-3 border-danger/40 p-3"
                data-failure-row={failure.rental_id}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <small className="text-[12px] text-ink2">
                    {failure.gpu || failure.gpu_class} · {failure.reason}
                  </small>
                  <small className="text-[11px] text-ink3">
                    Ran {formatSeconds((failure.uptime_hours || 0) * 3600)} before failing
                    {failure.usd_spent ? ` · $${failure.usd_spent.toFixed(2)} spent, not refundable` : ''}
                    {failure.destroy_error ? ` · could not destroy it: ${failure.destroy_error}` : ''}
                  </small>
                  <small className="text-[11px] text-ink3">{failureVerdict(failure.reason)}</small>
                </div>
                <IconButton
                  icon="x"
                  size="sm"
                  label="Dismiss this failure"
                  className="-mr-1 -mt-1"
                  onClick={() => dismissFailures(failure.rental_id)}
                />
              </Card>
            ))}
          </section>
        )}
        {loading ? (
          // A bare centred spinner on an otherwise empty page reads as "broken",
          // especially on the first open after a stack restart, where the cold
          // Vast connection can take several seconds. Say what is being waited
          // on, and hold the shape of the page while waiting.
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <SectionLabel>Active machines</SectionLabel>
                <Spinner size={13} className="text-honey" />
                <small className="text-[12px] text-ink3">Reading your marketplace accounts…</small>
              </div>
              <Card className="h-24 animate-pulse bg-bg1" />
            </section>
            <section className="flex flex-col gap-3">
              <SectionLabel>Rent a machine</SectionLabel>
              <Card className="h-40 animate-pulse bg-bg1" />
            </section>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <SectionLabel>Active machines</SectionLabel>
                {(account?.providers || [])
                  .filter((p) => p.credit != null)
                  .map((p) => (
                    <small key={p.provider} className="text-[12px] text-ink3">
                      <b className="font-mono text-ink2">${p.credit.toFixed(2)}</b> {p.label} credit
                      {p.usd_per_hour_running
                        ? ` · burning $${p.usd_per_hour_running.toFixed(3)}/hr${
                          p.hours_remaining ? ` · ~${p.hours_remaining}h left` : ''}`
                        : ' · nothing running'}
                    </small>
                  ))}
              </div>
              {rentals?.length ? (
                <div className="flex flex-col gap-3">
                  {rentals.map((machine) => (
                    <MachineRow
                      key={machine.rental_id}
                      machine={machine}
                      onDestroy={setPendingDestroy}
                      destroying={destroyingId === machine.rental_id}
                      onUse={useMachine}
                      onDetach={(m) => applyAttachment(m, 'DELETE')}
                      onPause={pauseMachine}
                      onResume={resumeMachine}
                      attachBusy={attachBusyId === machine.rental_id}
                      applying={applyingId === machine.rental_id}
                      leading={isRoutingLeader(machine, rentals)}
                      shared={rentals.some((other) => other.rental_id !== machine.rental_id
                        && other.attached
                        && (other.models_served || []).some((n) => (machine.models_served || []).includes(n)))}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState icon="cpu" title="No machines running" hint="Rent one below — boxes come up provisioned with the studio models. Pause keeps the disk for a one-minute restart; Destroy stops all billing." />
              )}
            </section>

            {/* The free lane, next to the paid ones. ComfyUI is optional — the
                studio boots and sells cloud work without it — so "connect the
                one you already have" belongs beside "rent one", not behind a
                setup screen nobody finds. */}
            <section className="flex flex-col gap-3">
              <SectionLabel>This machine</SectionLabel>
              <ConnectComfyCard enabled={active} />
            </section>

            <WarmVolumesCard plans={plans} active={active} />

            <section className="flex flex-col gap-3">
              <SectionLabel>Rent a machine</SectionLabel>
              {plans?.length ? (
                <RentConfigurator
                  plans={plans}
                  prefer={prefer}
                  onPrefer={setPrefer}
                  account={account}
                  busy={renting}
                  onRent={rent}
                />
              ) : loadError ? (
                <small className="text-[12px] text-ink3">
                  Offers unavailable — {loadError}
                </small>
              ) : (
                <Spinner size={18} className="text-ink2" />
              )}
              <CollapsibleSection title="How the offers are chosen" storageKey="machines-offer-notes">
                <small className="text-[11px] leading-relaxed text-ink3">
                  Fast start picks a host whose link can pull the models in ~3 minutes; Lowest price drops that
                  bar, which is cheaper per hour but bills more provisioning time. Times are for a warm box —
                  the first generation after boot pays a one-off weight load (~40s image · ~2min video).
                  Reach ComfyUI through the SSH tunnel command on the machine card.
                </small>
              </CollapsibleSection>
            </section>
          </div>
        )}
        {/* Remote machines and remote access are the same question asked twice:
            this page is where "reach my studio from somewhere else" lives. */}
        <div className="mt-6">
          <RemoteAccessCard />
        </div>
      </div>
      <ConfirmModal
        open={Boolean(pendingDestroy)}
        onClose={() => setPendingDestroy(null)}
        onConfirm={() => destroy(pendingDestroy)}
        title={`Destroy ${machineName(pendingDestroy)}?`}
        confirmLabel="Destroy"
        cancelLabel="Keep it"
        body={pendingDestroy ? (
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>
              The box and its disk are deleted — every model on it is gone, and a new rental downloads them again.
              This cannot be undone.
            </p>
            <p className="text-ink3">
              Billing stops the moment it is destroyed
              {Number.isFinite(Number(pendingDestroy.usd_per_hour)) ? ` (currently ${usd(pendingDestroy.usd_per_hour)}/hr)` : ''}.
              {pendingDestroy.attached ? ' It is attached — the studios routing through it fall back to local.' : ''}
            </p>
          </div>
        ) : null}
      />
    </div>
  );
}
