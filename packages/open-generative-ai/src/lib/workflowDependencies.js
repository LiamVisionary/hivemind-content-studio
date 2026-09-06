// Workflow dependency preflight and its inline installers — the browser half.
//
// Before a registered workflow runs on a lane (this machine's ComfyUI, or a
// rented one the tab pins), the gateway reads the workflow's own graph and
// asks the lane what it has (gateway/dependencies.py). What comes back is a
// list of missing things, each with its source and whether it can be
// installed from here, plus a hardware verdict for workflows built for one
// kind of card. This module fetches that report, keeps the install jobs it
// starts in a store that outlives any dialog (the same shape as
// civitaiDownloadStore: several jobs at once, polled here, rendered
// anywhere), and offers the formatters the prompt needs.
//
// Pure of React on purpose, so every branch is testable in node.
import { formatDownloadBytes } from './civitaiDownload.js';

const TERMINAL = new Set(['success', 'error', 'cancelled']);

export function formatDependencyBytes(bytes) {
  const value = Number(bytes) || 0;
  return value > 0 ? formatDownloadBytes(value) : '';
}

/** A report says something must be done before this workflow can run here. */
export function dependenciesBlockGeneration(report) {
  if (!report || report.known === false) return false;
  if (report.hardware && report.hardware.supported === false) return true;
  return Array.isArray(report.missing) && report.missing.length > 0;
}

/** The items the installer can act on, and the ones it cannot. */
export function splitDependencies(report) {
  const missing = Array.isArray(report?.missing) ? report.missing : [];
  return {
    installable: missing.filter((item) => item.installable),
    blocked: missing.filter((item) => !item.installable),
  };
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** What the prompt says under one missing item. */
export function describeDependency(item) {
  if (!item) return '';
  const source = item.source || {};
  if (item.kind === 'model') {
    const size = formatDependencyBytes(item.bytes || source.bytes);
    const where = source.folder ? `models/${source.folder}` : '';
    const host = source.url ? hostOf(source.url) : '';
    return [size, where, host ? `from ${host}` : ''].filter(Boolean).join(' - ');
  }
  if (item.kind === 'custom_node') {
    const repo = source.repo ? String(source.repo).replace(/^https:\/\/(www\.)?github\.com\//, '') : '';
    const pin = source.commit ? `@${String(source.commit).slice(0, 7)}` : '';
    return repo ? `node pack ${repo}${pin}` : `node class ${item.class_type || item.name}`;
  }
  if (item.kind === 'comfyui') return 'part of a newer ComfyUI';
  return '';
}

/** One line for a job in flight: stage, bytes, or how it ended. */
export function describeDependencyJob(job) {
  if (!job) return '';
  if (job.status === 'success') return 'Installed';
  if (job.status === 'cancelled') return 'Cancelled';
  if (job.status === 'error') return job.error || 'Install failed';
  if (job.stage) return `${job.stage}...`;
  const total = Number(job.total_bytes) || 0;
  const done = Number(job.downloaded_bytes) || 0;
  if (total) return `${formatDownloadBytes(done)} of ${formatDownloadBytes(total)}`;
  return job.status === 'queued' ? 'Waiting to start' : 'Downloading...';
}

export function dependencyJobPercent(job) {
  if (!job) return 0;
  if (job.status === 'success') return 100;
  if (typeof job.percent === 'number') return Math.max(0, Math.min(100, job.percent));
  const total = Number(job.total_bytes) || 0;
  return total ? Math.max(0, Math.min(100, Math.round(((Number(job.downloaded_bytes) || 0) / total) * 100))) : 0;
}

/* ------------------------------------------------------------------ */
/* Install job store                                                   */
/* ------------------------------------------------------------------ */

let jobs = [];
const listeners = new Set();
const pollers = new Map();

function emit(next) {
  jobs = next;
  listeners.forEach((fn) => fn(jobs));
}

function upsert(job) {
  const id = String(job?.id || '');
  if (!id) return;
  const exists = jobs.some((item) => item.id === id);
  emit(exists ? jobs.map((item) => (item.id === id ? { ...item, ...job } : item)) : [...jobs, { ...job }]);
}

export function getDependencyJobs() {
  return jobs;
}

export function subscribeDependencyJobs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The jobs that belong to one workflow (any lane), oldest first. */
export function dependencyJobsFor(workflowId) {
  const id = String(workflowId || '');
  return jobs.filter((job) => !id || String(job.workflow_id || '') === id);
}

/** The latest job for one missing item, if any. */
export function dependencyJobForItem(dependencyId, workflowId = '') {
  const wanted = String(dependencyId || '');
  const own = dependencyJobsFor(workflowId).filter((job) => String(job.dependency || '') === wanted);
  return own.length ? own[own.length - 1] : null;
}

export function isDependencyInstallRunning(workflowId = '') {
  return dependencyJobsFor(workflowId).some((job) => job.status === 'queued' || job.status === 'running');
}

/** Every job for the workflow has settled, and at least one installed a node pack. */
export function dependencyInstallNeedsRestart(workflowId = '') {
  const own = dependencyJobsFor(workflowId);
  return own.length > 0
    && own.every((job) => TERMINAL.has(job.status))
    && own.some((job) => job.status === 'success' && job.needs_restart);
}

export function clearSettledDependencyJobs(workflowId = '') {
  const id = String(workflowId || '');
  emit(jobs.filter((job) => !(TERMINAL.has(job.status) && (!id || String(job.workflow_id || '') === id))));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('stopped')); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('stopped')); }, { once: true });
  });
}

/**
 * Follow one job to its end, patching the store on every poll. Idempotent:
 * a job already being followed is not followed twice.
 */
export function followDependencyJob(api, job, { pollInterval = 900, signal } = {}) {
  const id = String(job?.id || '');
  if (!id) return;
  upsert(job);
  if (pollers.has(id) || TERMINAL.has(job.status)) return;
  const controller = new AbortController();
  pollers.set(id, controller);
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  void (async () => {
    let current = job;
    try {
      while (!TERMINAL.has(current.status)) {
        await wait(pollInterval, controller.signal);
        current = await api.getWorkflowDependencyJob(id);
        upsert(current);
      }
    } catch (error) {
      if (!controller.signal.aborted) upsert({ id, status: 'error', error: error?.message || 'Lost track of the install.' });
    } finally {
      pollers.delete(id);
    }
  })();
}

/**
 * Ask the gateway to install what is missing (every installable item, or the
 * ids given) and follow every job it started. Resolves to the gateway's
 * answer: `started` jobs and `refused` items with their reasons.
 */
export async function installDependencies(api, { workflowId, runOn = '', items } = {}) {
  const outcome = await api.installWorkflowDependencies({ workflowId, runOn, items });
  for (const job of outcome?.started || []) {
    followDependencyJob(api, { ...job, workflow_id: job.workflow_id || workflowId });
  }
  return outcome || { started: [], refused: [] };
}

export async function cancelDependencyJob(api, jobId) {
  const id = String(jobId || '');
  if (!id) return null;
  upsert({ id, cancelling: true });
  try {
    const job = await api.cancelWorkflowDependencyJob(id);
    if (job?.id) upsert(job);
    return job;
  } catch (error) {
    upsert({ id, cancelling: false });
    throw error;
  }
}

/** Adopt jobs the gateway reports (a reload mid-install), so their cards return. */
export function adoptDependencyJobs(api, reported = []) {
  for (const job of reported || []) followDependencyJob(api, job);
}

/* ------------------------------------------------------------------ */
/* Preflight cache                                                     */
/* ------------------------------------------------------------------ */

const REPORT_TTL_MS = 20000;
const reports = new Map();

/**
 * The lane's report for a workflow, cached briefly per (workflow, pin) so a
 * model picker that re-renders does not re-ask. `force` after an install.
 */
export async function checkWorkflowDependencies(api, { workflowId, runOn = '', force = false } = {}) {
  const id = String(workflowId || '').trim();
  if (!id) return { ok: true, known: false, missing: [] };
  const key = `${id} ${runOn || ''}`;
  const cached = reports.get(key);
  if (!force && cached && cached.at + REPORT_TTL_MS > Date.now()) return cached.report;
  const report = await api.checkWorkflowDependencies({ workflowId: id, runOn });
  reports.set(key, { at: Date.now(), report });
  adoptDependencyJobs(api, report?.jobs || []);
  return report;
}

export function forgetWorkflowDependencyReports() {
  reports.clear();
}
