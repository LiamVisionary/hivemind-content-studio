// Status line under the studios' "Rented" source option. Rented is always
// offered, so this panel has to be honest about every state a machine can be
// in — and each state that is not "live" needs the action that fixes it, not a
// spinner. Attaching is instant now (the gateway re-reads its lane registry per
// request), so there is no "connecting…" phase to narrate.
import { useEffect, useState } from 'react';
import { Button, Spinner } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import { zh } from '../lib/i18n.js';
import { api } from '../hub/hubData.js';
import { isRoutingLeader, notifyRentedMachinesChanged, withPin } from '../lib/rentedMachines.js';

const openMachines = () => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'machines' } }));

function Line({ children }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function seconds(machine) {
  const value = machine.seconds_per_generation;
  if (!value) return '';
  return value >= 90 ? `~${(value / 60).toFixed(1)}min` : `~${Math.round(value)}s`;
}

// With more than one ready machine, "which box does this run on?" is a real
// question with a real answer — and it is answered PER TAB. A click here pins
// this tab to a machine: every generation the tab sends carries that pin
// (`run_on`), which the gateway tries ahead of its default order. Nothing
// global changes, so two tabs can drive two boxes at once and a switch made in
// one never moves the other. (The Machines view's "Use" still sets the default
// that un-pinned tabs and agents follow.)
//
// `machines`/`all` already carry the pin's effect (withPin), so the highlight
// is exactly what the gateway will do with this tab's requests. Only a row
// being ATTACHED shows a spinner — pinning an attached box is instant, local
// state — and no row is ever disabled: changing your mind is a normal thing to
// do, and greying the list out was most of what made this feel broken.
// Clicking the pinned row again UNPINS it (the tab follows the Machines default
// once more) — there used to be no way back.
function MachinePicker({ machines, all, pinned, pendingId, onSelect }) {
  return (
    <div className="flex flex-col gap-1">
      <small className="text-[11px] text-ink3">{zh() ? '运行于' : 'Run on'}</small>
      {machines.map((machine) => {
        const leading = isRoutingLeader(machine, all);
        const locked = machine.rental_id === pinned;
        const pending = machine.rental_id === pendingId;
        const dead = machine.attached && !machine.tunnel_alive;
        const label = dead
          ? (zh() ? '重新连接' : 'reconnect')
          : locked
            ? (zh() ? '已锁定' : 'locked')
            : leading
              ? (zh() ? '使用中' : 'in use')
              : (zh() ? '切换' : 'switch');
        return (
          <button
            key={machine.rental_id}
            type="button"
            aria-pressed={locked}
            data-rental-id={machine.rental_id}
            title={locked && !dead
              ? (zh() ? '再次点击可取消锁定，跟随“机器”页的默认选择' : 'Click again to unpin — this tab follows the Machines default')
              : (dead
                ? (zh() ? '重新连接这台机器' : 'Reconnect this machine')
                : (zh() ? '把此标签页锁定到这台机器' : 'Lock this tab to this machine'))}
            onClick={() => onSelect(machine)}
            className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
              leading ? 'border-honey/50 bg-honey-tint' : 'border-line1 bg-bg1 hover:border-line2'
            }`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${
              leading ? 'bg-honey' : dead ? 'bg-warn' : 'bg-ink3/40'}`}
            />
            <span className="text-[11px] text-ink1">{machine.gpu || 'GPU'}</span>
            <span className="font-mono text-[11px] text-ink3">${(machine.usd_per_hour || 0).toFixed(3)}/hr</span>
            {seconds(machine) ? <span className="text-[11px] text-ink3">{seconds(machine)}</span> : null}
            {/* The spinner REPLACES the status word rather than joining it: any
                wider label reflows the row (a "switching" caption wrapped the
                GPU name onto a second line), and a row that jumps on the click
                is the jank this whole panel is meant to stop showing. */}
            {pending
              ? <Spinner size={10} className="ml-auto shrink-0 text-honey" />
              : (
                <span className={`ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.06em] ${locked && !dead ? 'text-honey' : 'text-ink3'}`}>
                  {locked && !dead ? <Icon name="lock" size={10} /> : null}
                  {label}
                </span>
              )}
          </button>
        );
      })}
    </div>
  );
}

// `pinned` is this tab's "Run on" machine (a rental id) and `onPin` writes it —
// the studios own the value (it lives with the tab's other settings and is
// copied when the tab is duplicated); this panel only shows and edits it.
export function RentedSourceStatus({ engine: s, page, pinned = '', onPin = null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The row an attach is in flight for. It is the one click here that is not
  // instant: pinning a box that is already attached is local state.
  const [pendingId, setPendingId] = useState(null);
  const live = s.rentedMachines || [];
  const provisioning = s.rentedProvisioning || [];
  const idle = s.rentedIdle || [];
  const broken = s.rentedBroken || [];

  const attach = async (machine, route = '/attach') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/gpu-rentals/${machine.rental_id}${route}`, { method: 'POST' });
      notifyRentedMachinesChanged();
    } catch (err) {
      // The gateway now reports WHY a tunnel refused (e.g. Vast rejected the
      // rental key); surfacing it here beats a spinner that never resolves.
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Every machine that could serve THIS studio, whatever state it is in —
  // ordered as the gateway will order them for this tab's requests: the pin
  // first, then the server's own priority order.
  const known = [...live, ...idle, ...broken];
  const all = withPin(known, pinned);
  const usable = all
    .filter((machine) => !page || (machine.studio_pages || []).includes(page))
    .sort((a, b) => Number(b.attached) - Number(a.attached)
      || (b.priority || 0) - (a.priority || 0)
      || String(a.rental_id).localeCompare(String(b.rental_id)));

  // A pin that no longer names an ATTACHED machine is stale: the box was
  // detached or destroyed (from Machines, or it expired). Drop it, so the tab
  // follows the default again instead of sending a pin the gateway refuses.
  // Judged only against a non-empty list — an unreachable API (locked vault,
  // stack mid-restart) answers with no machines at all, and that is not "gone".
  const stale = Boolean(pinned) && known.length > 0
    && !known.some((machine) => machine.rental_id === pinned && machine.attached);
  useEffect(() => {
    if (stale && onPin) onPin('');
  }, [stale, onPin]);

  const select = async (machine) => {
    if (!onPin) return;
    setError('');
    // The pinned row again: unpin, and follow the Machines default.
    if (machine.rental_id === pinned) {
      onPin('');
      return;
    }
    if (machine.attached && machine.tunnel_alive) {
      onPin(machine.rental_id);
      return;
    }
    // Idle (never pointed at this studio) or broken (tunnel gone): attach it —
    // a plain attach, which leaves the global order alone — then pin. The pin
    // is written only once the lane exists, or the gateway would refuse it.
    setPendingId(machine.rental_id);
    try {
      await api(`/api/gpu-rentals/${machine.rental_id}/attach`, { method: 'POST' });
      onPin(machine.rental_id);
      notifyRentedMachinesChanged();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setPendingId(null);
    }
  };

  if (usable.length > 1) {
    const rate = live.reduce((total, m) => total + (m.usd_per_hour || 0), 0);
    const lockedHere = Boolean(pinned) && !stale;
    return (
      <div className="flex flex-col gap-1.5">
        <MachinePicker
          machines={usable}
          all={all}
          pinned={stale ? '' : pinned}
          pendingId={pendingId}
          onSelect={select}
        />
        <small className="text-[11px] text-ink3">
          {lockedHere
            ? (zh()
              ? `此标签页已锁定到该机器：它发出的生成在那里运行并加密返回。再次点击该机器可取消锁定（共 ${live.length} 台在线，约 $${rate.toFixed(2)}/小时）。`
              : `This tab is locked to that machine — its generations run there and return sealed. Click it again to follow the default. ${live.length} online, ~$${rate.toFixed(2)}/hr total.`)
            : (zh()
              ? `当前跟随“机器”页的默认选择；点击一台机器即可将此标签页锁定到它（共 ${live.length} 台在线，约 $${rate.toFixed(2)}/小时）。`
              : `Following the Machines default — click a machine to lock this tab to it. ${live.length} online, ~$${rate.toFixed(2)}/hr total.`)}
        </small>
        {error ? <small className="text-[11px] text-warn">{error}</small> : null}
      </div>
    );
  }

  if (live.length) {
    const rate = live.reduce((total, m) => total + (m.usd_per_hour || 0), 0);
    return (
      <small className="text-[11px] text-ink3">
        {zh()
          ? `生成将在租用的机器上运行并加密返回（${live.length} 台在线，约 $${rate.toFixed(2)}/小时）。`
          : `Generations run on your rented machine and return sealed — ${live.length} online, ~$${rate.toFixed(2)}/hr while it stays up.`}
      </small>
    );
  }

  // Ready and paid for, just not pointed at this studio yet: one click, no wait.
  if (idle.length) {
    const machine = idle[0];
    return (
      <div className="flex flex-col gap-1">
        <Line>
          <small className="text-[11px] text-ink2">
            {zh()
              ? `机器已就绪（${machine.gpu || 'GPU'}，约 $${(machine.usd_per_hour || 0).toFixed(2)}/小时）。`
              : `Machine ready — ${machine.gpu || 'GPU'}, ~$${(machine.usd_per_hour || 0).toFixed(2)}/hr.`}
          </small>
          <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => attach(machine)}>
            {zh() ? '用于本工作室' : 'Use it here'}
          </Button>
        </Line>
        {error ? <small className="text-[11px] text-warn">{error}</small> : null}
      </div>
    );
  }

  // Attached but the tunnel is gone: broken, not arriving. Say so.
  if (broken.length) {
    const machine = broken[0];
    return (
      <div className="flex flex-col gap-1">
        <Line>
          <small className="text-[11px] text-warn">
            {zh()
              ? '与机器的连接已断开，生成暂时无法在其上运行。'
              : 'Lost the connection to your machine — generations cannot reach it.'}
          </small>
          <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => attach(machine)}>
            {zh() ? '重新连接' : 'Reconnect'}
          </Button>
          <Button variant="ghost" size="sm" onClick={openMachines}>
            {zh() ? '查看机器' : 'View machines'}
          </Button>
        </Line>
        {error ? <small className="text-[11px] text-warn">{error}</small> : null}
      </div>
    );
  }

  // The only genuine spinner: the box is still pulling models.
  if (provisioning.length) {
    const machine = provisioning[0];
    const models = machine.provision?.total
      ? ` — ${machine.provision.done}/${machine.provision.total} ${zh() ? '个模型' : 'models'}`
      : '';
    return (
      <Line>
        <Spinner size={12} className="text-honey" />
        <small className="text-[11px] text-ink2">
          {zh() ? '机器正在准备中：' : 'Machine coming online: '}{machine.phase}{models}
        </small>
        <Button variant="ghost" size="sm" onClick={openMachines}>
          {zh() ? '查看机器' : 'View machines'}
        </Button>
      </Line>
    );
  }

  return (
    <Line>
      <small className="text-[11px] text-ink3">
        {zh()
          ? '暂无租用机器。租用一台即可在云端 GPU 上运行这些模型。'
          : 'No rented machine yet — rent one to run these models on a cloud GPU.'}
      </small>
      <Button variant="primary" size="sm" onClick={openMachines}>
        {zh() ? '租用机器' : 'Rent a machine'}
      </Button>
    </Line>
  );
}
