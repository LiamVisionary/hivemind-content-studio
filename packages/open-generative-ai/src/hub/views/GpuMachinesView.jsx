// GPU Machines view — rent provisioned studio ComfyUI boxes from the owner's own
// marketplace accounts (/api/gpu-rentals on the control API; distinct from the
// hosted customer billing gateway). Tier presets, prices and expected speeds
// come from the server; this view only renders and confirms.
//
// Redesigned 2026-09 for lay users. Three rules the layout keeps:
//
//  * The page answers "what am I paying for" before it offers to spend more:
//    one spend strip, then the machines, then renting.
//  * Renting is THREE choices — Cheapest / Balanced / Fastest — derived from the
//    same priced ladder the server returns. The full ladder (and the count and
//    the fallback preference) is behind "More options", where the per-generation
//    column makes the "pricier is not faster" trap readable instead of asserted.
//  * Everything that is setup rather than spend — the local ComfyUI lane, warm
//    regions, publishing on the tailnet — is a one-line row that expands. They
//    were three full cards competing with the rent button.
//
// Copy is plain: "a clip every 2.1 min", "ready to use in ~3 min", "$0.018 a
// clip". The essays that used to explain the market live in titles and in the
// advanced fold.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import {
  Button, Card, CollapsibleSection, EmptyState, Field, IconButton, NativeSelect, Pill, ProgressBar,
  SectionLabel, Segmented, Spinner, StudioRestartAction, TextInput, cx,
} from '../../ui/kit.jsx';
import { api, humanize } from '../hubData.js';
import { isRoutingLeader, notifyRentedMachinesChanged, requestRentedMode } from '../../lib/rentedMachines.js';
import { ConnectComfyCard } from '../components/ConnectComfyCard.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { RemoteAccessCard } from '../components/RemoteAccessCard.jsx';

// Money and a NaN must never meet: an unmanaged/external row may carry no
// usd_per_hour at all, and "$NaN/hr" (or a thrown toFixed) was the result.
const usd = (value, digits = 2) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? `$${Number(value).toFixed(digits)}` : '—');

// A paused machine's disk rate is the one number on this page that routinely
// lives below a cent (the marketplaces keep four decimals on it for exactly
// that reason). At two decimals it prints "$0.00/hr", and "free" is the one
// thing a still-billing disk is not.
const diskUsd = (value) => {
  if (!Number.isFinite(Number(value)) || value === null || value === '') return '—';
  const n = Number(value);
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
};

// The studios a rented box can be sent to. The server's tiers declare these
// three and no others (image / video / restore); anything else is a tier the
// studio does not know how to open, so it gets no door rather than a wrong one.
const PAGE_LABELS = { image: 'Image', video: 'Video', restore: 'Restore' };

// 6s while the view is open: provisioning machines report via their beacon,
// and the whole poll (list + beacon probes) is cheap.
const POLL_MS = 6000;
const MAX_BATCH = 8;

function formatSeconds(seconds) {
  if (!seconds) return '—';
  if (seconds >= 90) return `${(seconds / 60).toFixed(1)} min`;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)} sec`;
}

// "3h 24m" — an operator reads uptime as time, not as 3.4h.
function formatHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
}

// What one failure says about the NEXT rental, in the user's terms. A host that
// never starts its container IS a bad host, and the GPU class is not indicted.
function failureVerdict(reason = '') {
  if (/never started/i.test(reason)) {
    return 'That host never started the machine. Renting again lands on a different one.';
  }
  if (/download (failed|stalled)/i.test(reason)) {
    return 'That host could not pull the models in time — its connection, not the card. It is held out for a day, so renting the same kind again is worth it.';
  }
  return 'Usually the host rather than the card. Renting again lands on a different one.';
}

// One noun for what a tier produces, so every number on the page can be read
// without knowing what a "generation" is.
function unitFor(plan) {
  return /video|clip|animat/i.test(`${plan?.tier || ''} ${plan?.reference_job || ''}`) ? 'clip' : 'picture';
}

// A price per generation is the only honest comparison across cards: a faster
// card bills for fewer seconds, so neither end of the ladder wins by default.
function perUnit(rung, unit) {
  if (!rung?.usd_per_generation) return null;
  const value = rung.usd_per_generation;
  const digits = value < 0.01 ? 4 : 3;
  return `≈ $${value.toFixed(digits)} a ${unit}`;
}

function everyLabel(rung, unit) {
  if (!rung?.seconds_per_generation) return null;
  return `A ${unit} every ${formatSeconds(rung.seconds_per_generation)}`;
}

function readyLabel(rung) {
  const minutes = rung?.warm ? (rung.warm_setup_minutes ?? rung.setup_minutes) : rung?.setup_minutes;
  if (!minutes) return 'Ready when the host answers';
  return `Ready to use in ~${minutes} min`;
}

// The three cards, from the server's own priced ladder:
//   Cheapest  — lowest hourly of the available rungs.
//   Balanced  — lowest cost PER GENERATION, which is the recommendation, and is
//               usually neither end of the ladder.
//   Fastest   — lowest seconds per generation.
// Falls back gracefully: with one priced rung all three collapse to it, and the
// caller renders whatever is distinct.
function threeChoices(plan) {
  const priced = (plan?.classes || []).filter((c) => c.available && c.usd_per_hour);
  if (!priced.length) return [];
  const byHour = [...priced].sort((a, b) => a.usd_per_hour - b.usd_per_hour);
  const bySeconds = [...priced].sort(
    (a, b) => (a.seconds_per_generation || Infinity) - (b.seconds_per_generation || Infinity),
  );
  const byValue = [...priced]
    .filter((c) => c.usd_per_generation)
    .sort((a, b) => a.usd_per_generation - b.usd_per_generation);

  const cheapest = byHour[0];
  const fastest = bySeconds[0];
  const balanced = byValue[0] || byHour[Math.min(1, byHour.length - 1)];

  // One card often wins two axes — the server ranks cheapest-first, so the best
  // value IS usually the cheapest. Dropping the later duplicate would throw away
  // the `recommended` flag with it, leaving the page pre-armed on the priciest
  // card and recommending nothing. Merge the flag into the surviving slot.
  const out = [];
  const byClass = new Map();
  for (const entry of [
    { key: 'cheapest', name: 'Cheapest', rung: cheapest },
    { key: 'balanced', name: 'Balanced', rung: balanced, recommended: true },
    { key: 'fastest', name: 'Fastest', rung: fastest },
  ]) {
    if (!entry.rung) continue;
    const existing = byClass.get(entry.rung.gpu_class);
    if (existing) {
      existing.recommended = existing.recommended || entry.recommended;
      continue;
    }
    byClass.set(entry.rung.gpu_class, entry);
    out.push(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Spend                                                              */
/* ------------------------------------------------------------------ */

// The first thing on the page, because it is the question a bill raises. Credit
// is per marketplace (Vast credit does not pay a RunPod bill), so the strip
// sums the burn and names each purse underneath rather than adding purses up.
function SpendStrip({ account, rentals }) {
  const purses = (account?.providers || []);
  const running = Number(account?.usd_per_hour_running) || 0;
  // Unknown is not zero. A provider whose balance call raised sends `credit:
  // null`, and "$0.00" over a running machine reads as "you are out of money"
  // when the truth is "we could not ask".
  const credit = Number.isFinite(Number(account?.credit)) && account?.credit !== null ? Number(account.credit) : null;
  // The server's own figure, and it is the MINIMUM across marketplaces rather
  // than total ÷ burn: Vast credit does not pay a RunPod bill, so the machines
  // that die first are the ones on whichever purse runs dry first. Deriving a
  // runway from the summed credit reports a comfortable number right up until
  // half the fleet stops.
  const runway = Number.isFinite(Number(account?.hours_remaining)) && account?.hours_remaining !== null
    ? Number(account.hours_remaining)
    : null;
  const live = Number.isFinite(Number(account?.machines_running))
    ? Number(account.machines_running)
    : (rentals || []).filter((m) => m.phase !== 'error').length;

  return (
    <Card className="flex flex-wrap items-center gap-x-7 gap-y-4 p-5">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] text-ink3">Spending now</span>
        <b className="font-mono text-[22px] font-medium tracking-[-.01em] text-ink1">
          {usd(running)}
          <span className="text-[14px] text-ink2">/hr</span>
        </b>
      </div>
      <div className="h-9 w-px bg-line1" />
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] text-ink3">Credit left</span>
        <b className="font-mono text-[22px] font-medium tracking-[-.01em] text-ink1">{usd(credit)}</b>
      </div>
      <div className="h-9 w-px bg-line1" />
      <div className="flex flex-col gap-0.5">
        <span className="text-[12px] text-ink3">That lasts about</span>
        <b className="text-[22px] font-medium tracking-[-.01em] text-ink1">
          {runway != null
            ? `${runway < 10 ? runway.toFixed(1) : Math.round(runway)} hours`
            : running > 0
              ? (credit == null ? 'unknown' : 'no credit left')
              : 'as long as you like'}
        </b>
      </div>
      <span className="ml-auto max-w-[260px] text-[12px] leading-relaxed text-ink3">
        {running > 0 && credit == null
          ? 'A marketplace did not report its balance, so the runway above is unknown rather than unlimited.'
          : live
            ? `${live} machine${live > 1 ? 's' : ''} running. Everything stops billing the moment you stop it.`
            : 'Nothing is running, so nothing is being charged right now.'}
      </span>
      {/* Credit is spendable only where it sits, so the total above is never
          the whole answer once there is more than one marketplace. */}
      {purses.length > 1 ? (
        <div className="flex w-full flex-wrap gap-x-4 gap-y-1 border-t border-line1 pt-3 text-[11px] text-ink3">
          {purses.map((purse) => (
            <span key={purse.provider}>
              {purse.label}: <span className="font-mono text-ink2">{usd(purse.credit)}</span>
              {Number(purse.usd_per_hour_running) > 0 ? ` · ${usd(purse.usd_per_hour_running)}/hr` : ''}
            </span>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Machines                                                           */
/* ------------------------------------------------------------------ */

// Provisioning lifecycle in on-box beacon order. `phase` "booting" precedes
// beacon contact; after that the beacon's `step` drives the active row.
const PROVISION_STEPS = [
  { key: 'booting', label: 'Starting the machine' },
  { key: 'installing', label: 'Installing the software' },
  { key: 'downloading', label: 'Copying the models over' },
  { key: 'starting-comfy', label: 'Almost ready' },
  { key: 'ready', label: 'Ready' },
];
const STALE_BEACON_NOTICE_S = 45;

function stepIndex(machine) {
  if (machine.phase === 'booting') return 0;
  const step = machine.provision?.step || 'booting';
  // 'error' is not a step in the ladder: a box that had already died used to
  // draw a spinner on "Booting host", so it looked like it was still starting.
  if (step === 'error') {
    return machine.provision?.done ? PROVISION_STEPS.findIndex((s) => s.key === 'downloading') : 0;
  }
  const idx = PROVISION_STEPS.findIndex((s) => s.key === (step === 'syncing' ? 'installing' : step));
  return idx === -1 ? 0 : idx;
}

// One line and one bar, where five ladder rows used to be. The ladder was
// engineering detail; what a person needs is the step, the count and the wait.
function ProvisionProgress({ machine }) {
  const current = stepIndex(machine);
  const p = machine.provision;
  const step = PROVISION_STEPS[current];
  const fraction = p?.total ? Math.min(1, (p.done || 0) / p.total) : null;
  const value = step.key === 'downloading' && fraction != null
    ? (current + fraction) / (PROVISION_STEPS.length - 1)
    : current / (PROVISION_STEPS.length - 1);
  return (
    <div className="flex flex-col gap-1.5">
      <ProgressBar value={value} label="Getting ready" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <small className="text-[12px] text-ink2">
          {step.label}
          {step.key === 'downloading' && p?.total ? ` — ${p.done} of ${p.total}` : ''}
        </small>
        {p?.stale_seconds > STALE_BEACON_NOTICE_S ? (
          <small className="text-[11px] text-ink3" title="The box goes quiet while it saturates its uplink pulling models. This is its last known progress.">
            no news for {formatSeconds(p.stale_seconds)} — normal while it downloads
          </small>
        ) : null}
      </div>
    </div>
  );
}

// A machine is one row: a status dot, what it is, what it costs, what it is
// doing, and the one action worth a button. Everything rarer — the ssh command,
// the ComfyUI address, Destroy, Detach — is in the row's menu.
function MachineRow({
  machine, onDestroy, destroying, onUse, onDetach, onPause, onResume, attachBusy, applying, leading,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ready = machine.phase === 'ready';
  const paused = machine.phase === 'paused';
  const failed = machine.phase === 'error';
  const resumeBlocked = paused && Boolean(machine.resume_blocked);
  // The same call lib/rentedMachines.js:classifyMachine makes: an attached
  // machine whose forward is dead is 'broken', not 'live'. A green Ready dot
  // over a lane that carries nothing sends every job into a hole.
  const tunnelDown = machine.phase === 'ready' && machine.attached && !machine.tunnel_alive;
  const resuming = paused && !resumeBlocked && Boolean(machine.resume_requested_at);
  // Only a machine WE provisioned has a beacon, so only a managed one can be
  // "getting ready". An unmanaged row (the hosted billing worker rents onto the
  // same account) is up and billing; drawing it a 0% progress bar forever
  // asserted a lie about a machine that is already running.
  const provisioning = machine.managed && !ready && !paused && !failed;
  const pages = machine.studio_pages || [];
  // An unknown start time is not a zero bill. `uptime_hours` is null whenever
  // the provider does not report a start, and reading that as 0 printed
  // "$0.00 so far" over a machine that is charging by the second.
  const spent = machine.uptime_hours != null
    && Number.isFinite(Number(machine.uptime_hours))
    && Number.isFinite(Number(machine.usd_per_hour))
    ? usd(Number(machine.uptime_hours) * Number(machine.usd_per_hour))
    : null;

  return (
    <Card className={cx('flex flex-col gap-3 p-4', failed && 'border-danger/40')}>
      <div className="flex flex-wrap items-center gap-4">
        {applying || provisioning ? (
          <Spinner size={14} className="shrink-0 text-honey" />
        ) : (
          <span
            className={cx(
              'h-2 w-2 shrink-0 rounded-full',
              ready && !tunnelDown ? 'bg-ok shadow-[0_0_0_4px_var(--ok-tint)]'
                : tunnelDown ? 'bg-warn'
                  : failed ? 'bg-danger' : 'bg-ink3',
            )}
          />
        )}

        <div className="min-w-[190px]">
          <b className="text-[14px] text-ink1">{machine.tier_label?.replace(/^[^·]+· /, '') || machine.gpu || 'Machine'}</b>
          <div className="mt-0.5 text-[12px] text-ink3">
            {machine.gpu || 'GPU'}
            {tunnelDown ? ' · connection dropped' : leading && ready ? ' · in use by the studios' : ''}
            {!machine.managed ? ' · managed elsewhere' : ''}
          </div>
        </div>

        <div className="min-w-[120px]">
          <div className="font-mono text-[13px] text-ink1">
            {paused ? diskUsd(machine.paused_usd_per_hour) : usd(machine.usd_per_hour)}/hr
          </div>
          <div className="mt-0.5 text-[12px] text-ink3">{spent ? `${spent} so far` : '—'}</div>
        </div>

        <div className="min-w-[150px]">
          <div className={cx('text-[13px]', failed ? 'text-danger' : 'text-ink1')}>
            {ready ? 'Ready'
              : paused ? (resumeBlocked ? 'Waiting on the host' : resuming ? 'Starting again' : 'Paused')
                : failed ? 'Could not start'
                  : provisioning ? 'Getting ready'
                    : (humanize(machine.phase) || 'Unknown')}
          </div>
          <div className="mt-0.5 text-[12px] text-ink3">
            {machine.uptime_hours != null ? `${ready ? 'running' : paused ? 'kept for' : 'up'} ${formatHours(machine.uptime_hours)}` : ''}
          </div>
        </div>

        <span className="ml-auto" />

        {/* One door per studio the machine actually serves. Collapsing these to
            studio_pages[0] left a rented video box openable only in Image, and
            the studios route by `studio_pages.includes(page)` — so a page the
            machine does not list routes nothing at all. */}
        {ready && machine.managed ? (
          <>
            {pages.map((page, i) => (
              <Button
                key={page}
                variant={i === 0 ? 'primary' : 'neutral'}
                size="sm"
                loading={attachBusy}
                disabled={attachBusy}
                onClick={() => onUse(machine, page)}
              >
                {leading ? 'Open in' : 'Use in'} {PAGE_LABELS[page] || 'Studio'}
              </Button>
            ))}
            <Button variant="neutral" size="sm" disabled={attachBusy} onClick={() => onPause(machine)} title="Stops the card and its hourly price but keeps the models on its disk, so starting it again takes about a minute.">
              Pause
            </Button>
          </>
        ) : null}
        {paused && machine.managed ? (
          <Button variant="primary" size="sm" disabled={attachBusy} onClick={() => onResume(machine)}>
            {resumeBlocked ? 'Try again' : resuming ? 'Starting…' : 'Start it again'}
          </Button>
        ) : null}
        {provisioning && machine.managed ? (
          <Button variant="neutral" size="sm" loading={destroying} disabled={destroying} onClick={() => onDestroy(machine)}>
            Cancel
          </Button>
        ) : null}
        {machine.managed || machine.ssh_command || machine.comfy_url ? (
          <IconButton icon="more" size="sm" label="More for this machine" active={menuOpen} onClick={() => setMenuOpen((v) => !v)} />
        ) : null}
      </div>

      {/* Which machine this row IS. Two boxes of the same tier and card are
          otherwise identical, and "Release" on the wrong one costs the work in
          flight on the other. */}
      <small className="w-full font-mono text-[11px] text-ink3">
        {machine.provider_label ? `${machine.provider_label} · ` : ''}
        {machine.label || `id ${machine.rental_id}`}
      </small>

      {provisioning ? <ProvisionProgress machine={machine} /> : null}

      {/* The repair is the button already on the row: `useMachine` re-selects
          whenever the tunnel is dead, which rebuilds the forward. */}
      {tunnelDown ? (
        <small className="text-[12px] leading-relaxed text-warn">
          The connection to this machine dropped, so the studios are not reaching it. It is still running and still
          billing — press {PAGE_LABELS[pages[0]] ? `Use in ${PAGE_LABELS[pages[0]]}` : 'Use'} to reconnect it.
        </small>
      ) : null}

      {paused && !resumeBlocked ? (
        <small className="text-[12px] leading-relaxed text-ink3">
          Paused keeps the models on its disk at {diskUsd(machine.paused_usd_per_hour)}/hr, so starting it again takes
          about a minute. The card itself is not held for you — release it if you are done.
        </small>
      ) : null}
      {resumeBlocked ? (
        <small className="text-[12px] leading-relaxed text-warn">
          The host has not given the card back — most likely someone else is renting it. Your models are safe and still
          cost {diskUsd(machine.paused_usd_per_hour)}/hr. Keep trying, or release this one and rent a fresh machine.
        </small>
      ) : null}
      {failed ? (
        <small className="text-[12px] leading-relaxed text-ink2">
          {machine.provision?.detail || 'It reported an error before the software came up.'} It is being released
          automatically — a broken machine bills like a working one.
        </small>
      ) : null}

      {menuOpen ? (
        <div className="flex flex-col gap-2 border-t border-line1 pt-3">
          {ready && machine.attached ? (
            <div className="flex items-center justify-between gap-3">
              <small className="text-[12px] text-ink2">Stop routing the studios through this machine</small>
              <Button variant="neutral" size="sm" disabled={attachBusy} onClick={() => onDetach(machine)}>Detach</Button>
            </div>
          ) : null}
          {machine.ssh_command ? (
            <code className="select-all break-all rounded-sm border border-line1 bg-bg1 px-2 py-1 font-mono text-[11px] text-ink2">
              {machine.ssh_command}
            </code>
          ) : null}
          {machine.comfy_url ? <small className="font-mono text-[11px] text-ink3">ComfyUI: {machine.comfy_url}</small> : null}
          {/* The server refuses to destroy a machine it did not rent (409), so
              offering the button on an unmanaged row is a button that only ever
              produces an error. */}
          {machine.managed ? (
            <div className="flex items-center justify-between gap-3">
              <small className="text-[12px] text-ink2">
                Release it — the disk and every model on it are deleted, and billing stops.
              </small>
              <Button variant="danger" size="sm" loading={destroying} disabled={destroying} onClick={() => onDestroy(machine)}>
                Release
              </Button>
            </div>
          ) : (
            <small className="text-[12px] text-ink3">
              This machine was rented outside the studio, so it is billed and released wherever it was started.
            </small>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Renting                                                            */
/* ------------------------------------------------------------------ */

function ChoiceCard({ choice, unit, selected, onSelect, disabled }) {
  const { rung } = choice;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(choice.key)}
      aria-pressed={selected}
      className={cx(
        'flex flex-col items-stretch gap-3 rounded-lg border p-4 text-left transition-colors duration-150 ease-swift disabled:opacity-40',
        selected ? 'border-honey/55 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
      )}
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold text-ink1">{choice.name}</span>
          {choice.recommended ? <Pill tone="honey">Recommended</Pill> : null}
        </div>
        <div className="mt-0.5 text-[12px] text-ink2">
          {rung.label}
          {rung.vram_gb ? ` · ${rung.vram_gb}GB` : ''}
        </div>
      </div>

      <div className="font-mono text-[20px] font-medium text-ink1">
        ${rung.usd_per_hour.toFixed(2)}
        <span className="text-[13px] text-ink2">/hr</span>
      </div>

      <div className="flex flex-col gap-1.5 text-[12px] text-ink2">
        <span>{everyLabel(rung, unit) || `${rung.available} offer${rung.available === 1 ? '' : 's'} available`}</span>
        <span className={rung.warm ? 'text-ok' : undefined}>{readyLabel(rung)}</span>
      </div>

      {perUnit(rung, unit) ? (
        <div className="text-[12px] text-ink3">
          {perUnit(rung, unit)}
          {choice.recommended ? ` — cheapest per ${unit}` : ''}
        </div>
      ) : null}

      <div
        className={cx(
          'mt-auto flex h-ctl-md items-center justify-center rounded-md border text-[13px] font-semibold',
          selected ? 'border-transparent bg-honey text-on-honey' : 'border-line1 bg-bg2 text-ink1',
        )}
      >
        {selected ? 'Chosen' : 'Choose'}
      </div>
    </button>
  );
}

// The whole ladder, with the per-generation column that makes "pricier is not
// faster" checkable rather than asserted. Only reachable from More options.
function LadderTable({ plan, unit, selectedClass }) {
  // "sold out" is a claim about the market, and it is only ours to make when a
  // marketplace actually answered. With none of them answering, every row read
  // as sold out while the cards were listed and rentable the whole time.
  const unshopped = (plan?.marketplace_failures || []).length > 0;
  const rows = useMemo(
    () => [...(plan?.classes || [])].sort(
      (a, b) => (!a.available) - (!b.available) || (a.usd_per_hour ?? Infinity) - (b.usd_per_hour ?? Infinity),
    ),
    [plan],
  );
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Every card available for this job</SectionLabel>
      <div className="grid grid-cols-[1.4fr_repeat(4,minmax(0,1fr))] gap-2 px-3 text-[11px] uppercase tracking-[0.06em] text-ink3">
        <span>Card</span>
        <span>Per hour</span>
        <span>Per {unit}</span>
        <span>A {unit} every</span>
        <span>Ready in</span>
      </div>
      {rows.map((rung) => {
        // Null, not zero: a marketplace that does not publish the host's link
        // speed cannot have its model download timed in advance. Inside a
        // template literal that null stringifies to "~null min".
        const readyMinutes = rung.warm ? (rung.warm_setup_minutes ?? rung.setup_minutes) : rung.setup_minutes;
        return (
        <div
          key={rung.gpu_class}
          className={cx(
            'grid grid-cols-[1.4fr_repeat(4,minmax(0,1fr))] items-center gap-2 rounded-md border px-3 py-2.5 text-[12px]',
            rung.gpu_class === selectedClass ? 'border-honey/55 bg-honey-tint' : 'border-line1 bg-bg2',
            !rung.available && 'opacity-60',
          )}
        >
          <span className="text-ink1">
            {rung.label} <span className="text-ink3">{rung.vram_gb ? `${rung.vram_gb}GB` : ''}</span>
            {/* The trap this ladder exists to expose: more per hour, no more
                speed. The per-unit column shows it; naming it stops a reader
                having to do the comparison themselves. */}
            {rung.costs_more_no_faster ? (
              <span className="text-warn" title="Another card on this ladder costs less per hour and is no slower for this job."> · costs more, no faster</span>
            ) : null}
          </span>
          <span className="font-mono text-ink1">{rung.usd_per_hour ? `$${rung.usd_per_hour.toFixed(2)}` : '—'}</span>
          <span className="font-mono text-ink2">
            {rung.usd_per_generation ? `$${rung.usd_per_generation.toFixed(rung.usd_per_generation < 0.01 ? 4 : 3)}` : '—'}
          </span>
          <span className="text-ink2">
            {rung.seconds_per_generation ? formatSeconds(rung.seconds_per_generation) : '—'}
            {rung.estimate_basis === 'estimated' ? (
              <span className="text-ink3" title="Scaled from a measured card by the marketplace's own benchmark — a generic mix, not a diffusion one. Treat it as unproven."> (est.)</span>
            ) : null}
          </span>
          <span className={cx(rung.warm ? 'text-ok' : 'text-ink2', !rung.available && 'text-ink3')}>
            {!rung.available
              ? (unshopped ? 'not asked' : 'sold out')
              : readyMinutes
                ? `~${readyMinutes} min`
                : 'unknown'}
          </span>
        </div>
        );
      })}
      <small className="text-[12px] leading-relaxed text-ink3">
        A pricier card is not always faster for this job — the per-{unit} column is the honest comparison.
      </small>
    </div>
  );
}

function RentPanel({ plans, prefer, onPrefer, account, busy, onRent, hasMachines }) {
  const [tier, setTier] = useState(plans[0]?.tier);
  const [choiceKey, setChoiceKey] = useState('balanced');
  const [count, setCount] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const [gpuClass, setGpuClass] = useState('');
  const [pendingRent, setPendingRent] = useState(null);

  const plan = plans.find((p) => p.tier === tier) || plans[0];
  const unit = unitFor(plan);
  const choices = useMemo(() => threeChoices(plan), [plan]);
  // When one card wins two axes the named key can be absent; fall back to the
  // recommendation, never to `choices[1]` — that index is the FASTEST card once
  // cheapest and balanced have collapsed, so the page armed the priciest option.
  const chosen = choices.find((c) => c.key === choiceKey)
    || choices.find((c) => c.recommended)
    || choices[0]
    || null;
  // An exact card picked in the fold wins over the three cards; picking a card
  // again from the three clears it.
  const rung = (gpuClass && (plan?.classes || []).find((c) => c.gpu_class === gpuClass)) || chosen?.rung || null;

  const troubles = plan?.marketplace_failures || [];
  // The marketplace this rung would be rented from — rungs are ranked
  // cheapest-first across providers, so the cheapest offer is the one the server
  // takes, and its account is the one that has to fund it. account.credit is a
  // SUM across marketplaces and cannot authorize anything.
  const source = rung?.offers?.[0]?.provider;
  const purse = (account?.providers || []).find((p) => p.provider === source)
    || (account?.providers || [])[0] || null;
  const credit = purse ? purse.credit : account?.credit;
  const running = (purse ? purse.usd_per_hour_running : account?.usd_per_hour_running) || 0;
  const hourly = rung?.usd_per_hour || 0;
  const spare = credit != null ? credit - running : null;
  const affordable = hourly && spare != null
    ? Math.max(0, Math.min(MAX_BATCH, Math.floor(spare / hourly)))
    : MAX_BATCH;
  const machines = Math.min(count, Math.max(1, affordable));
  const total = hourly * machines;
  const runway = total && credit != null ? credit / (total + running) : null;

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3.5">
        <h3 className="text-[15px] font-semibold text-ink1">{hasMachines ? 'Rent another' : 'Rent a machine'}</h3>
        {/* The server's own tier names. Deriving a label from the unit collapsed
            LTX 2.3 and MiniMax H3 into two buttons both reading "For video" —
            two different models, two different prices, no way to tell them
            apart before spending. */}
        {plans.length > 1 ? (
          <Segmented
            value={plan?.tier}
            onChange={(next) => { setTier(next); setGpuClass(''); setChoiceKey('balanced'); setCount(1); }}
            options={plans.map((p) => ({ value: p.tier, label: p.family }))}
          />
        ) : null}
        <small className="text-[12px] text-ink3">Live marketplace prices, checked a moment ago.</small>
      </div>
      {plan?.family_detail ? (
        <small className="-mt-1.5 text-[12px] leading-relaxed text-ink3">{plan.family_detail}</small>
      ) : null}

      {choices.length ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {choices.map((choice) => (
              <ChoiceCard
                key={choice.key}
                choice={choice}
                unit={unit}
                disabled={busy}
                selected={!gpuClass && choice.key === (chosen?.key)}
                onSelect={(key) => { setChoiceKey(key); setGpuClass(''); }}
              />
            ))}
          </div>
          {/* A price built from half the market is not the market's price. This
              has to sit beside the cards, not behind More options: the whole
              point is that an owner reading a confident price learns the other
              marketplace went quiet BEFORE they spend. */}
          {troubles.length ? (
            <small className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
              {troubles.map((t) => t.why).join('; ')} — this is what is left of the
              market. {troubles[0].fix}
            </small>
          ) : null}
        </>
      ) : troubles.length ? (
        // Not a sold-out market: nobody was successfully asked. Naming the
        // marketplace that went quiet is what stops an owner hunting for cards
        // that were listed the whole time.
        <Card className="flex flex-col gap-2 border-warn/40 p-4">
          {troubles.map((trouble) => (
            <small key={trouble.provider} className="text-[12px] leading-relaxed text-warn">
              <b>{trouble.why}.</b> {trouble.fix}
            </small>
          ))}
        </Card>
      ) : (
        <Card className="p-4">
          <small className="text-[12px] text-ink3">
            No offers match right now for this job — every card is rented out. Try again in a few minutes.
          </small>
        </Card>
      )}

      <Card className="flex flex-wrap items-center gap-4 border-line1 bg-bg1 p-3.5">
        <span className="max-w-[560px] text-[13px] leading-relaxed text-ink2">
          {rung ? (
            <>
              <b className="text-ink1">{rung.label}</b>
              {machines > 1 ? `, ${machines} machines` : ', one machine'} — <b className="text-ink1">{usd(total)}/hr</b>,
              billed by the second.
              {runway ? ` Your credit covers about ${runway < 10 ? runway.toFixed(1) : Math.round(runway)} hours.` : ''}
            </>
          ) : 'Pick a machine above.'}
        </span>
        <span className="ml-auto" />
        <Button variant="ghost" size="sm" onClick={() => setAdvanced((v) => !v)}>
          <Icon name="chevronRight" size={13} className={cx('transition-transform', advanced && 'rotate-90')} />
          More options
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={busy}
          disabled={busy || !hourly || affordable < 1}
          title="Rents the machine quoted here. If it is taken by the time the click lands, the next host is only taken within a few cents of this price — otherwise nothing is rented and the price refreshes."
          onClick={() => setPendingRent({
            tier: plan.tier,
            gpu_class: rung.gpu_class,
            count: machines,
            offer: rung.offers?.[0] || null,
            usd_per_hour: rung.usd_per_hour,
            label: rung.label,
            purse: purse?.label,
          })}
        >
          {machines > 1 ? `Rent ${machines} machines` : 'Rent this machine'}
        </Button>
      </Card>

      {affordable < 1 && credit != null ? (
        <small className="text-[12px] text-warn">
          {usd(credit)} {purse?.label} credit will not cover {rung?.label} for an hour. Add credit at{' '}
          {purse?.credit_url || 'your marketplace'}, or pick a cheaper machine.
        </small>
      ) : null}

      {advanced ? (
        <Card className="flex flex-col gap-5 bg-bg1 p-5">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink2">How many</span>
              <div className="flex items-center gap-0.5 rounded-md border border-line1 bg-bg0 p-0.5">
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
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink2">Prefer</span>
              <Segmented
                size="sm"
                value={prefer}
                onChange={onPrefer}
                options={[{ value: 'balanced', label: 'Ready sooner' }, { value: 'cheapest', label: 'Cheaper' }]}
              />
            </div>
            <small className="ml-auto text-[12px] text-ink3">
              {machines > 1 ? 'Several machines share the work of one big job.' : 'One is right unless a job is split across machines.'}
            </small>
          </div>

          {plan ? (
            <LadderTable plan={plan} unit={unit} selectedClass={rung?.gpu_class} />
          ) : null}

          <div className="flex flex-col gap-2">
            <SectionLabel>Picking an exact card</SectionLabel>
            <Field label="" className="max-w-xs">
              <NativeSelect value={gpuClass} onChange={(event) => setGpuClass(event.target.value)}>
                <option value="">Use the recommendation above</option>
                {(plan?.classes || []).filter((c) => c.available && c.usd_per_hour).map((c) => (
                  <option key={c.gpu_class} value={c.gpu_class}>
                    {c.label} — ${c.usd_per_hour.toFixed(2)}/hr
                    {c.costs_more_no_faster ? ' (costs more, no faster)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <small className="text-[12px] leading-relaxed text-ink3">
            <b className="text-ink2">Ready sooner</b> picks a host whose connection can copy the models in a few minutes.
            {' '}<b className="text-ink2">Cheaper</b> drops that bar: less per hour, but you pay for more setup time.
            Times assume a warm machine — the first job after it starts pays a one-off model load.
          </small>
        </Card>
      ) : null}

      <ConfirmModal
        open={Boolean(pendingRent)}
        tone="primary"
        onClose={() => setPendingRent(null)}
        onConfirm={() => { const request = pendingRent; setPendingRent(null); onRent(request); }}
        title={pendingRent?.count > 1 ? `Rent ${pendingRent.count} machines?` : 'Rent this machine?'}
        confirmLabel={pendingRent?.count > 1 ? `Rent ${pendingRent.count} machines` : 'Rent it'}
        body={pendingRent ? (
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>
              <b className="text-ink1">{pendingRent.label}</b>
              {' — '}
              <span className="font-mono text-ink1">
                {usd(pendingRent.usd_per_hour)}/hr{pendingRent.count > 1 ? ` × ${pendingRent.count} = ${usd(pendingRent.usd_per_hour * pendingRent.count)}/hr` : ''}
              </span>
              {pendingRent.purse ? ` on your ${pendingRent.purse} credit.` : '.'}
            </p>
            <p className="text-ink3">
              Charged by the second from the moment the machine is taken, setup time included. Pause keeps its models for
              a small disk charge; releasing it stops everything.
            </p>
          </div>
        ) : null}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Setup — one row each, expanded on demand                           */
/* ------------------------------------------------------------------ */

// A warm region keeps a tier's models on a persistent volume so every later
// rental in that region mounts it and skips the download (measured cold: 25 of
// 27 provisioning minutes were the pull). Billed per GB-month whether or not a
// machine uses it — so the row always carries the rate and the running total.
const warmUsd = (value) => {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
};

function WarmRegions({ plans, active }) {
  const [volumes, setVolumes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState(plans?.[0]?.tier || 'minimax');
  const [dataCenter, setDataCenter] = useState('EU-RO-1');
  const [confirmStock, setConfirmStock] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const hasVolumesRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const body = await api('/api/gpu-rentals/warm-volumes');
      hasVolumesRef.current = true;
      setVolumes(body.volumes || []);
      // A read that succeeds answers the banner a failed read put up. Without
      // this the first failure stuck for the life of the view, over a list that
      // had since loaded fine.
      setError('');
    } catch (e) {
      if (!hasVolumesRef.current) setError(e.message);
    }
  }, []);

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

  const monthly = (volumes || []).reduce((sum, v) => sum + (Number(v.usd_per_month) || 0), 0);
  const tierLabel = (plans || []).find((p) => p.tier === tier)?.tier_label || tier;

  return (
    <CollapsibleSection
      title="Keep models stored near a region"
      hint={volumes?.length ? `${volumes.length} region · ${warmUsd(monthly)}/mo` : 'Off'}
      storageKey="machines-warm-regions"
    >
      <div className="flex flex-col gap-3 pb-2">
        <small className="max-w-2xl text-[12px] leading-relaxed text-ink2">
          Storing a copy of the models near a region makes new machines there ready in about 3 minutes instead of 25.
          It costs a small monthly fee from the moment you turn it on until you delete it, whether or not a machine is
          using it.
        </small>
        {error ? (
          <div className="flex items-start gap-2 rounded-md bg-danger-tint px-3 py-2">
            <small className="min-w-0 flex-1 font-mono text-[11px] text-danger">{error}</small>
            <IconButton icon="x" size="xs" label="Dismiss" onClick={() => setError('')} />
          </div>
        ) : null}
        {volumes === null ? <Spinner size={13} className="text-honey" /> : volumes.length === 0 ? (
          <small className="text-[12px] text-ink3">No regions stored yet.</small>
        ) : volumes.map((v) => (
          <div key={v.key} className="flex flex-wrap items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2 text-[12px]">
            <span className={cx('h-2 w-2 rounded-full', v.state === 'stocked' ? 'bg-ok' : v.state === 'error' ? 'bg-danger' : 'bg-honey')} />
            <b className="text-ink1">{v.tier_label || v.tier}</b>
            <span className="font-mono text-ink2">{v.data_center_id} · {v.size_gb}GB</span>
            {v.usd_per_month != null ? (
              <span className="font-mono text-ink2" title="Billed from creation until the volume is deleted, whether or not a machine is attached.">
                {warmUsd(v.usd_per_month)}/mo
                {v.usd_accrued != null ? <span className="text-ink3">{' · '}{warmUsd(v.usd_accrued)} so far</span> : null}
              </span>
            ) : null}
            {v.state === 'stocking' ? <span className="text-ink3">Filling up — watch it under Your machines</span> : null}
            {/* Raw, not humanized: `detail` is free text from the marketplace
                and carries hyphenated identifiers (a region id like us-east-1),
                which humanize() would flatten into "us east 1". */}
            {v.state === 'error' ? <span className="text-warn">{v.detail}</span> : null}
            <span className="ml-auto" />
            {/* A failed region is a problem shown with its fix in the same row:
                stocking it again is one press, not a delete-and-retype. */}
            {v.state === 'error' ? (
              <Button
                size="sm"
                variant="neutral"
                disabled={busy}
                onClick={() => { setTier(v.tier); setDataCenter(v.data_center_id); setConfirmStock(true); }}
              >
                Try again
              </Button>
            ) : null}
            <Button size="sm" variant="danger" disabled={busy} onClick={() => setPendingDelete(v)}>Delete</Button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="For" className="w-44">
            <NativeSelect value={tier} onChange={(e) => setTier(e.target.value)}>
              {(plans || []).map((p) => <option key={p.tier} value={p.tier}>{p.tier_label || p.tier}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Region" className="w-40">
            <TextInput className="font-mono" value={dataCenter} onChange={(e) => setDataCenter(e.target.value)} placeholder="EU-RO-1" />
          </Field>
          <Button size="sm" variant="neutral" loading={busy} disabled={busy || !dataCenter.trim()} onClick={() => setConfirmStock(true)}>
            Store the models
          </Button>
        </div>
      </div>
      <ConfirmModal
        open={confirmStock}
        tone="primary"
        onClose={() => (busy ? null : setConfirmStock(false))}
        onConfirm={stock}
        busy={busy}
        title={`Store the models in ${dataCenter.trim() || '…'}?`}
        confirmLabel="Store them"
        body={(
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>Keeps a copy of the <b className="text-ink1">{tierLabel}</b> models in <b className="text-ink1">{dataCenter.trim()}</b>.</p>
            <p className="text-ink3">
              Charged monthly from now until you delete it, whether or not a machine is using it. Filling it up also
              rents one machine for the length of the copy.
            </p>
          </div>
        )}
      />
      <ConfirmModal
        open={Boolean(pendingDelete)}
        onClose={() => (busy ? null : setPendingDelete(null))}
        onConfirm={() => remove(pendingDelete)}
        busy={busy}
        title={pendingDelete ? `Delete the stored models in ${pendingDelete.data_center_id}?` : 'Delete these stored models?'}
        confirmLabel="Delete them"
        body={pendingDelete
          ? `The next machine there downloads them again, which takes about 25 minutes.${pendingDelete.usd_per_month ? ` This stops ${warmUsd(pendingDelete.usd_per_month)} a month.` : ''}`
          : ''}
      />
    </CollapsibleSection>
  );
}

function SetupSection({ plans, active }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line1 pt-5">
      <SectionLabel>Setup</SectionLabel>
      <CollapsibleSection title="Use the ComfyUI on this Mac" storageKey="machines-local-comfy">
        <div className="pb-2"><ConnectComfyCard enabled={active} /></div>
      </CollapsibleSection>
      <WarmRegions plans={plans} active={active} />
      <CollapsibleSection title="Open this studio on my other devices" storageKey="machines-remote-access">
        <div className="pb-2"><RemoteAccessCard /></div>
      </CollapsibleSection>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                               */
/* ------------------------------------------------------------------ */

function rentalRequestId() {
  try { return crypto.randomUUID(); } catch { return `rent-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`; }
}

export function GpuMachinesView({ active }) {
  const [plans, setPlans] = useState(null);
  const [rentals, setRentals] = useState(null);
  const [account, setAccount] = useState(null);
  // Machines destroyed because provisioning failed. They are gone from the list
  // by design, and a machine that silently disappears while the credit drops is
  // worse than no automation at all.
  const [failures, setFailures] = useState([]);
  const [failuresOpen, setFailuresOpen] = useState(false);
  const dismissedRef = useRef(new Set());
  // What an ACTION said vs what the POLL said: the poll owns loadError/stale,
  // `error` and `notice` are the user's and are cleared by a dismiss or by the
  // next action.
  const [error, setError] = useState('');
  // Which action produced `error`. Only 'rent' may promise that no money
  // changed hands; every other action fails with the machine still there.
  const [errorKind, setErrorKind] = useState('');
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [stale, setStale] = useState('');
  const [needsRestart, setNeedsRestart] = useState(false);
  const [marketRemedy, setMarketRemedy] = useState('');
  const [renting, setRenting] = useState(false);
  const [prefer, setPrefer] = useState('balanced');
  const [destroyingId, setDestroyingId] = useState(null);
  const [pendingDestroy, setPendingDestroy] = useState(null);
  const [attachBusyId, setAttachBusyId] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const beginAction = () => { setError(''); setNotice(''); setErrorKind(''); };
  const pollRef = useRef(null);
  const hasDataRef = useRef(false);
  const preferRef = useRef('balanced');

  const refresh = useCallback(async (withOffers) => {
    try {
      const rentalData = await api('/api/gpu-rentals');
      if (rentalData.marketplace?.configured === false) {
        setNeedsRestart(false);
        setMarketRemedy(rentalData.marketplace.remedy || '');
        if (hasDataRef.current) setStale(rentalData.marketplace.detail);
        else setLoadError(rentalData.marketplace.detail);
        return;
      }
      setMarketRemedy('');
      setRentals(rentalData.rentals || []);
      setAccount(rentalData.account || null);
      setFailures((rentalData.failures || []).filter(
        (failure) => !dismissedRef.current.has(String(failure.rental_id)),
      ));
      hasDataRef.current = true;
      if (withOffers) {
        // The server names its own tiers; the literal is only a floor for a
        // payload that predates the field, and it has to list every tier or a
        // whole lane (MiniMax H3) silently vanishes from the picker.
        const tierKeys = rentalData.tiers || ['image', 'video', 'minimax'];
        try {
          setPlans(await Promise.all(
            tierKeys.map((key) => api(
              `/api/gpu-rentals/plan?tier=${encodeURIComponent(key)}&prefer=${encodeURIComponent(preferRef.current)}`,
            )),
          ));
        } catch (err) {
          // A 404 here is version skew, not a missing feature: the control API
          // is a long-lived process that only picks up new routes on restart.
          if (/not found/i.test(err.message || '')) {
            const skew = new Error('The studio’s local service is running an older build without the rental '
              + 'planner. Restart the studio and it will pick it up.');
            skew.needsRestart = true;
            throw skew;
          }
          throw err;
        }
      }
      setLoadError('');
      setStale('');
      setNeedsRestart(false);
    } catch (err) {
      const message = err.message || 'Failed to reach the rentals API';
      // A poll that fails while a machine is provisioning must not replace a
      // working screen with a red banner: keep the last good data and say
      // quietly that it went stale.
      setNeedsRestart(Boolean(err?.needsRestart));
      setMarketRemedy('');
      if (hasDataRef.current) setStale(message);
      else setLoadError(message);
    }
  }, []);

  const connectAccountAction = marketRemedy === 'connect-account'
    ? (
      <Button
        size="sm"
        icon="plug"
        onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }))}
      >
        Connect HivemindOS account
      </Button>
    )
    : null;

  useEffect(() => {
    if (!active) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      return undefined;
    }
    refresh(true);
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
          // rental instead of renting a second billing machine.
          request_id: rentalRequestId(),
          // Pin the quoted ask and bound the fallbacks to its price.
          ...(offer ? { offer_id: offer.offer_id, provider: offer.provider } : {}),
          ...(quoted ? { max_usd_per_hour: quoted } : {}),
        }),
      });
      await refresh(true);
      const notices = [];
      if (body.partial) notices.push(body.partial);
      const landed = body.usd_per_hour;
      if (quoted && landed && Math.abs(landed - quoted) >= 0.0005) {
        // Three decimals, not two: the server lets a fallback land within
        // max($0.02, 3%) of the quote, so the entire legal gap on a ~$0.34/hr
        // tier rounds away at two — the sentence then contrasts a number with
        // itself ("it cost $0.34/hr instead of the $0.34/hr quoted").
        notices.push(`it cost $${landed.toFixed(3)}/hr instead of the $${quoted.toFixed(3)}/hr quoted — that machine was taken, and the next one was within a few cents`);
      }
      setNotice(notices.length ? notices.join('; ') : '');
    } catch (err) {
      // A refusal means the quote was stale: re-price so the number on the
      // button and the message agree, then say why nothing was rented.
      try { await refresh(true); } catch { /* the message below still stands */ }
      setError(err.message);
      setErrorKind('rent');
    } finally {
      setRenting(false);
    }
  };

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
    // "Use" SELECTS: with more than one machine serving the same models,
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

  // Called AFTER the ConfirmModal; the row's button only opens it.
  const destroy = async (machine) => {
    beginAction();
    setPendingDestroy(null);
    setDestroyingId(machine.rental_id);
    try {
      const body = await api(`/api/gpu-rentals/${encodeURIComponent(machine.rental_id)}`, { method: 'DELETE' });
      // Destroying an ATTACHED machine restarts the stack to drop its lane, so
      // wait for the studio to come back before refreshing.
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

  const dismissFailures = async (rentalId = null) => {
    beginAction();
    const ids = rentalId === null ? failures.map((f) => String(f.rental_id)) : [String(rentalId)];
    ids.forEach((id) => dismissedRef.current.add(id));
    setFailures((current) => current.filter((f) => !dismissedRef.current.has(String(f.rental_id))));
    try {
      await api(
        rentalId === null ? '/api/gpu-rentals/failures' : `/api/gpu-rentals/failures/${encodeURIComponent(rentalId)}`,
        { method: 'DELETE' },
      );
    } catch (err) {
      ids.forEach((id) => dismissedRef.current.delete(id));
      setError(`Could not dismiss that notice — ${err.message}`);
      refresh(false);
    }
  };

  const loading = rentals === null && !loadError;
  // Names the machine the confirm is about. `label` first: two boxes of the
  // same tier and card share a `gpu`, and Release is irreversible.
  const machineName = (machine) => machine?.label || machine?.gpu
    || (machine?.rental_id ? `machine ${machine.rental_id}` : 'this machine');
  const failureSpend = failures.reduce((sum, f) => sum + (Number(f.usd_spent) || 0), 0);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        title="Rented GPUs"
        subtitle="Borrow a fast graphics card by the second. Stop it any time."
        refresh={() => refresh(true)}
      />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto flex max-w-[1060px] flex-col gap-8">
          {loadError ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger-tint p-3" role="alert">
              <small className="min-w-0 flex-1 text-[12px] text-danger">{loadError}</small>
              {needsRestart ? <StudioRestartAction /> : connectAccountAction || (
                <Button size="sm" icon="refresh" onClick={() => refresh(true)}>Try again</Button>
              )}
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-tint p-3" role="alert">
              <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                {/* Six actions share this banner, and only one of them is rent.
                    A failed Release is exactly the case where the machine IS
                    still alive and still billing — telling the owner there that
                    they have not been charged is the worst thing to say. */}
                <b className="text-[13px] text-ink1">
                  {errorKind === 'rent' ? 'Nothing was rented' : 'That did not go through'}
                </b>
                <div className="mt-1 text-[12px] leading-relaxed text-ink2">
                  {error}
                  {errorKind === 'rent'
                    ? ' You have not been charged; the prices below have been refreshed.'
                    : ' Nothing changed — the machines are still as shown below.'}
                </div>
              </div>
              <Button size="sm" variant="neutral" onClick={() => { setError(''); setErrorKind(''); }}>Dismiss</Button>
            </div>
          ) : null}

          {notice ? (
            <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3" role="status">
              <Pill tone="warn" className="shrink-0">Heads up</Pill>
              <small className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink1">{notice}</small>
              <IconButton icon="x" size="sm" label="Dismiss" className="-mr-1 -mt-1" onClick={() => setNotice('')} />
            </div>
          ) : null}

          {stale && !loadError ? (
            <Card className="flex flex-wrap items-center gap-2 border-warn/40 p-2 text-[11px] text-warn">
              <Spinner size={12} className="text-warn" />
              {/* `stale` carries the server's own sentence, and for a sealed
                  vault it is the only place the repair is named. Dropping it
                  left a state you could enter and not exit, under a line that
                  was also false: the studio DID answer. */}
              <span className="min-w-0">
                {marketRemedy ? 'Showing the last reading — ' : 'Showing the last reading — the studio did not answer just now. '}
                {stale}{' '}
                Retrying every {Math.round(POLL_MS / 1000)}s.
              </span>
              {needsRestart ? <StudioRestartAction /> : connectAccountAction}
            </Card>
          ) : null}

          {loading ? (
            <div className="flex flex-col gap-8">
              <Card className="h-[92px] animate-pulse bg-bg1" />
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-[15px] font-semibold text-ink1">Your machines</h3>
                  <Spinner size={13} className="text-honey" />
                  <small className="text-[12px] text-ink3">Reading your marketplace accounts…</small>
                </div>
                <Card className="h-24 animate-pulse bg-bg1" />
              </div>
            </div>
          ) : (
            <>
              <SpendStrip account={account} rentals={rentals} />

              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="text-[15px] font-semibold text-ink1">Your machines</h3>
                  {failures.length ? (
                    <small className="text-[12px] text-ink3">
                      {failures.length === 1 ? '1 machine failed earlier' : `${failures.length} machines failed earlier`}
                      {failureSpend ? ` · ${usd(failureSpend)} spent` : ''}
                      {' · '}
                      <button
                        type="button"
                        className="font-medium text-honey hover:underline"
                        onClick={() => setFailuresOpen((v) => !v)}
                      >
                        what happened
                      </button>
                    </small>
                  ) : null}
                </div>

                {failuresOpen && failures.length ? (
                  <div className="flex flex-col gap-2" aria-label="Machines that failed to start">
                    {failures.map((failure) => (
                      <Card key={`${failure.rental_id}-${failure.destroyed_at}`} className="flex items-start gap-3 bg-bg1 p-3.5">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                          <b className="text-[13px] text-ink1">
                            {failure.gpu || failure.gpu_class} could not start, so it was released for you
                          </b>
                          <small className="text-[12px] leading-relaxed text-ink2">{failureVerdict(failure.reason)}</small>
                          {/* The beacon's own account of what went wrong. The
                              machine is destroyed, so once this card is gone
                              nothing else in the app or the API still holds it —
                              and it is what names the actual fault (the last
                              download error, a RAM ceiling, a missing SSH door)
                              behind the generic verdict above. */}
                          {failure.reason ? (
                            <small className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink3">
                              {failure.reason}
                            </small>
                          ) : null}
                          <small className="text-[11px] text-ink3">
                            Ran {formatSeconds((failure.uptime_hours || 0) * 3600)}
                            {failure.usd_spent ? ` · ${usd(failure.usd_spent)} spent, which is not refunded` : ''}
                            {failure.destroy_error ? ` · could not release it: ${failure.destroy_error}` : ''}
                          </small>
                        </div>
                        <IconButton icon="x" size="sm" label="Dismiss this notice" className="-mr-1 -mt-1" onClick={() => dismissFailures(failure.rental_id)} />
                      </Card>
                    ))}
                    {failures.length > 1 ? (
                      <Button size="sm" variant="ghost" className="self-end" onClick={() => dismissFailures()}>Dismiss all</Button>
                    ) : null}
                  </div>
                ) : null}

                {rentals?.length ? (
                  <div className="flex flex-col gap-2.5">
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
                      />
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon="cpu"
                    title="Nothing is running, so nothing is being charged"
                    hint="Rent one below when a job is too slow on this Mac. It takes a few minutes to be ready, then the studios use it automatically."
                  />
                )}
              </section>

              {plans?.length ? (
                <RentPanel
                  plans={plans}
                  prefer={prefer}
                  onPrefer={setPrefer}
                  account={account}
                  busy={renting}
                  onRent={rent}
                  hasMachines={Boolean(rentals?.length)}
                />
              ) : loadError ? (
                <small className="text-[12px] text-ink3">Prices unavailable — {loadError}</small>
              ) : (
                <Spinner size={18} className="text-ink2" />
              )}

              <SetupSection plans={plans} active={active} />
            </>
          )}
        </div>
      </div>

      <ConfirmModal
        open={Boolean(pendingDestroy)}
        onClose={() => setPendingDestroy(null)}
        onConfirm={() => destroy(pendingDestroy)}
        title={`Release ${machineName(pendingDestroy)}?`}
        confirmLabel="Release it"
        cancelLabel="Keep it"
        body={pendingDestroy ? (
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>
              The machine and its disk are deleted — every model on it is gone, and a new rental downloads them again.
              This cannot be undone.
            </p>
            <p className="text-ink3">
              Billing stops the moment it is released
              {Number.isFinite(Number(pendingDestroy.usd_per_hour)) ? ` (it is ${usd(pendingDestroy.usd_per_hour)}/hr now)` : ''}.
              {pendingDestroy.attached ? ' The studios using it fall back to this Mac.' : ''}
            </p>
          </div>
        ) : null}
      />
    </div>
  );
}
