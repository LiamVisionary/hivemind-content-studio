// The prompt a workflow opens when the lane that will run it lacks something.
//
// One list, one line per missing thing: what it is, where it comes from, how
// big it is, and its own live progress bar once the install starts. The
// installers run in the store (workflowDependencies.js), so closing this
// dialog stops nothing; reopening it finds the same bars. Everything that CAN
// be installed from here starts at once when the prompt opens — a person who
// picked a workflow wants it to work, not a second question — and cancel is
// on every row. What cannot be installed is said in words with the one action
// that repairs it: a lane whose card cannot run the model is pointed at the
// Machines page, a ComfyUI that is too old is told to update.
//
// After a node pack lands the lane must load it: the prompt restarts the lane
// itself (ComfyUI-Manager's in-place restart), waits for it to answer, and
// re-checks, so the last thing on screen is "ready" or the next missing item.
import { useEffect, useMemo, useRef, useState } from 'react';
import { localAI } from '../lib/localInferenceClient.js';
import {
  cancelDependencyJob,
  checkWorkflowDependencies,
  clearSettledDependencyJobs,
  dependencyInstallNeedsRestart,
  dependencyJobForItem,
  dependencyJobPercent,
  describeDependency,
  describeDependencyJob,
  formatDependencyBytes,
  installDependencies,
  isDependencyInstallRunning,
  splitDependencies,
  subscribeDependencyJobs,
} from '../lib/workflowDependencies.js';
import { remedyFor } from '../lib/textModels.js';
import { t, tf } from '../lib/i18n.js';
import { Button, ProgressBar, cx } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import { Modal } from '../ui/Modal.jsx';

const RESTART_WAIT_MS = 90000;
const RESTART_POLL_MS = 1500;

function useDependencyJobs() {
  const [, force] = useState(0);
  useEffect(() => subscribeDependencyJobs(() => force((n) => n + 1)), []);
}

function DependencyRow({ item, workflowId, api, busy }) {
  const job = dependencyJobForItem(item.id, workflowId);
  const running = job && (job.status === 'queued' || job.status === 'running');
  const done = job?.status === 'success';
  const failed = job?.status === 'error';
  const percent = dependencyJobPercent(job);
  const indeterminate = running && !Number(job?.total_bytes) && !done;
  const line = job ? describeDependencyJob(job) : (item.reason || describeDependency(item));
  return (
    <li className={cx('flex flex-col gap-1.5 rounded-md border px-3 py-2.5', failed ? 'border-danger/40 bg-danger-tint' : done ? 'border-ok/40 bg-bg2' : 'border-line1 bg-bg2')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon
              name={done ? 'check' : failed ? 'warning' : item.kind === 'model' ? 'download' : 'nodes'}
              size={14}
              className={done ? 'text-ok' : failed ? 'text-danger' : 'text-ink3'}
            />
            <span className="truncate text-[13px] font-semibold text-ink1">{item.name}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-ink3">{tf('deps.kind', item.kind)}</span>
          </div>
          <div className={cx('mt-0.5 text-[11px]', failed ? 'text-danger' : 'text-ink3')} title={line}>{line}</div>
        </div>
        <div className="shrink-0">
          {running ? (
            <Button size="sm" variant="ghost" disabled={Boolean(job?.cancelling)} onClick={() => void cancelDependencyJob(api, job.id).catch(() => {})}>
              {job?.cancelling ? t('deps.cancelling') : t('common.cancel')}
            </Button>
          ) : item.installable && !done ? (
            <Button size="sm" disabled={busy} onClick={() => void installDependencies(api, { workflowId, items: [item.id] }).catch(() => {})}>
              {failed ? t('common.tryAgain') : t('deps.install')}
            </Button>
          ) : null}
        </div>
      </div>
      {running || done ? (
        <ProgressBar value={indeterminate ? null : percent / 100} tone={done ? 'ok' : 'honey'} label={item.name} />
      ) : failed ? (
        <ProgressBar value={1} tone="danger" label={item.name} />
      ) : null}
    </li>
  );
}

/**
 * @param {object} props
 * @param {object} props.report the preflight report the prompt opened with
 * @param {string} props.workflowId
 * @param {string} props.runOn the tab's "Run on" pin, if any
 * @param {(report: object) => void} props.onReport a fresh report after a re-check
 * @param {(remedy: object) => void} props.onRemedy runs a remedy button (Machines page and friends)
 * @param {() => void} props.onClose
 * @param {boolean} [props.autoInstall=true] start every installable item on open
 */
export function WorkflowDependencyPrompt({ report, workflowId, runOn = '', onReport, onRemedy, onClose, autoInstall = true, api = localAI }) {
  useDependencyJobs();
  const [phase, setPhase] = useState('idle'); // idle | installing | restarting | checking | ready
  const [notice, setNotice] = useState('');
  const started = useRef(false);
  const { installable, blocked } = useMemo(() => splitDependencies(report), [report]);
  const hardware = report?.hardware || { supported: true };
  const running = isDependencyInstallRunning(workflowId);
  const needsRestart = dependencyInstallNeedsRestart(workflowId);
  const totalBytes = formatDependencyBytes(report?.missing_bytes);

  // Everything installable starts on open. Once.
  useEffect(() => {
    if (!autoInstall || started.current || !installable.length || !hardware.supported) return;
    started.current = true;
    setPhase('installing');
    void installDependencies(api, { workflowId, runOn }).then((outcome) => {
      const refused = outcome?.refused || [];
      if (refused.length) setNotice(refused.map((item) => item.reason).filter(Boolean).join(' '));
    }).catch((error) => setNotice(error?.message || t('deps.installFailed')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoInstall, workflowId]);

  const recheck = async () => {
    setPhase('checking');
    try {
      const fresh = await checkWorkflowDependencies(api, { workflowId, runOn, force: true });
      onReport?.(fresh);
      if (fresh?.ok) {
        setPhase('ready');
        clearSettledDependencyJobs(workflowId);
      } else {
        setPhase('idle');
      }
    } catch (error) {
      setPhase('idle');
      setNotice(error?.message || t('deps.checkFailed'));
    }
  };

  const restart = async () => {
    setPhase('restarting');
    setNotice('');
    try {
      const answer = await api.restartWorkflowLane({ runOn });
      if (!answer?.accepted) {
        setPhase('idle');
        setNotice(answer?.reason || t('deps.restartRefused'));
        return;
      }
      // The lane drops every connection while it execv's; wait for it to answer again.
      const deadline = Date.now() + RESTART_WAIT_MS;
      let back = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
        try {
          const probe = await checkWorkflowDependencies(api, { workflowId, runOn, force: true });
          if (probe && probe.known !== undefined) { back = true; onReport?.(probe); setPhase(probe.ok ? 'ready' : 'idle'); if (probe.ok) clearSettledDependencyJobs(workflowId); break; }
        } catch { /* still restarting */ }
      }
      if (!back) { setPhase('idle'); setNotice(t('deps.restartTimeout')); }
    } catch (error) {
      setPhase('idle');
      setNotice(error?.message || t('deps.restartRefused'));
    }
  };

  // The moment every install has settled and a node pack landed, the lane is
  // restarted without another press; a models-only install just re-checks.
  useEffect(() => {
    if (phase !== 'installing' || running) return;
    if (needsRestart) void restart();
    else void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, running, needsRestart]);

  const machines = remedyFor('attach-machine');
  const title = phase === 'ready' ? t('deps.readyTitle') : tf('deps.title', report?.title || workflowId);

  return (
    <Modal open onClose={onClose} title={title} size="lg" dismissable={phase !== 'restarting'}>
      <div className="flex flex-col gap-4">
        {!hardware.supported ? (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3.5 py-3 text-[12px] text-ink1" role="alert">
            <div className="font-semibold">{t('deps.cannotRunHere')}</div>
            <div className="mt-1 text-ink2">{hardware.reason}</div>
            {machines && onRemedy ? (
              <Button size="sm" className="mt-2" onClick={() => onRemedy(machines)}>{machines.label}</Button>
            ) : null}
          </div>
        ) : phase === 'ready' ? (
          <div className="rounded-md border border-ok/40 bg-bg2 px-3.5 py-3 text-[12px] text-ink1" role="status">
            {t('deps.readyBody')}
          </div>
        ) : (
          <p className="text-[12px] text-ink2">
            {tf('deps.intro', report?.missing?.length || 0, totalBytes)}
          </p>
        )}

        {report?.missing?.length ? (
          <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto custom-scrollbar pr-1">
            {[...installable, ...blocked].map((item) => (
              <DependencyRow key={item.id} item={item} workflowId={workflowId} api={api} busy={phase === 'restarting' || phase === 'checking'} />
            ))}
          </ul>
        ) : null}

        {notice ? <div className="text-[11px] text-danger" role="alert">{notice}</div> : null}

        <div className="flex items-center justify-between gap-3 border-t border-line1 pt-3">
          <span className="text-[11px] text-ink3">
            {phase === 'restarting' ? t('deps.restarting')
              : phase === 'checking' ? t('deps.checking')
                : running ? t('deps.installing')
                  : needsRestart ? t('deps.restartNeeded')
                    : ''}
          </span>
          <div className="flex items-center gap-2">
            {needsRestart && phase !== 'restarting' ? (
              <Button size="sm" onClick={() => void restart()}>{t('deps.restartNow')}</Button>
            ) : null}
            {phase !== 'restarting' && phase !== 'ready' ? (
              <Button size="sm" variant="ghost" disabled={phase === 'checking'} onClick={() => void recheck()}>{t('common.checkAgain')}</Button>
            ) : null}
            <Button size="sm" variant={phase === 'ready' ? 'primary' : 'ghost'} onClick={onClose}>
              {phase === 'ready' ? t('common.done') : t('common.close')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
