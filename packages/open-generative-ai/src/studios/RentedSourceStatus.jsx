// Status line under the studios' "Rented" source option. Rented is always
// offered, so this panel has to be honest about every state a machine can be
// in — and each state that is not "live" needs the action that fixes it, not a
// spinner. Attaching is instant now (the gateway re-reads its lane registry per
// request), so there is no "connecting…" phase to narrate.
import { useState } from 'react';
import { Button, Spinner } from '../ui/kit.jsx';
import { getLang } from '../lib/i18n.js';
import { api } from '../hub/hubData.js';
import { isRoutingLeader, notifyRentedMachinesChanged } from '../lib/rentedMachines.js';

const zh = () => getLang() === 'zh-CN';

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
// question with a real answer — the gateway routes to the highest-priority
// attachment whose models match. This is that answer, and the switch for it.
function MachinePicker({ machines, all, busy, onSelect }) {
  return (
    <div className="flex flex-col gap-1">
      <small className="text-[11px] text-ink3">{zh() ? '运行于' : 'Run on'}</small>
      {machines.map((machine) => {
        const leading = isRoutingLeader(machine, all);
        const dead = machine.attached && !machine.tunnel_alive;
        return (
          <button
            key={machine.rental_id}
            type="button"
            disabled={busy || leading}
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
            <span className="ml-auto text-[10px] uppercase tracking-[0.06em] text-ink3">
              {leading
                ? (zh() ? '使用中' : 'in use')
                : dead
                  ? (zh() ? '重新连接' : 'reconnect')
                  : (zh() ? '切换' : 'switch')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function RentedSourceStatus({ engine: s, page }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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

  // Every machine that could serve THIS studio, whatever state it is in.
  const usable = [...live, ...idle, ...broken]
    .filter((machine) => !page || (machine.studio_pages || []).includes(page))
    .sort((a, b) => Number(b.attached) - Number(a.attached)
      || (b.priority || 0) - (a.priority || 0)
      || String(a.rental_id).localeCompare(String(b.rental_id)));

  if (usable.length > 1) {
    const rate = live.reduce((total, m) => total + (m.usd_per_hour || 0), 0);
    return (
      <div className="flex flex-col gap-1.5">
        <MachinePicker
          machines={usable}
          all={[...live, ...idle, ...broken]}
          busy={busy}
          onSelect={(machine) => attach(machine, '/select')}
        />
        <small className="text-[11px] text-ink3">
          {zh()
            ? `生成在选中的机器上运行并加密返回（共 ${live.length} 台在线，约 $${rate.toFixed(2)}/小时）。`
            : `Generations run on the selected machine and return sealed — ${live.length} online, ~$${rate.toFixed(2)}/hr total.`}
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
            {zh() ? '查看机器' : 'View Machines'}
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
          {zh() ? '查看机器' : 'View Machines'}
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
