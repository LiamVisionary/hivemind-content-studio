// Runs view — durable-production master/detail. Left: the run list with a
// Segmented All/Active/Complete filter (filteredRuns / setStatusFilter /
// setSelectedRunId). Right: the selected run's brief scenes, workflow steps
// (mono step ids), artifacts (lightbox + download + copy-URL), and the bounded
// next action, all driven through the hubData action layer so every route, the
// live operator-token auth header, and the status semantics are preserved
// (filteredRuns / runAction / loadRunIntoSimpleComposer / duplicateRun). The
// operator token is now bound right here in the detail so resume/retry/cancel
// no longer silently 401 against a field hidden on another view — it is the same
// hubState.workflow.operatorToken that authHeaders() reads live at action time.
// Artifact media flows through useMediaSrc for E2E decrypt.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, EmptyState, Field, Pill, Segmented, TextInput } from '../../ui/kit.jsx';
import {
  duplicateRun, filteredRuns, generationArtifactUrl, loadRunIntoSimpleComposer,
  runAction, runTitle, setSelectedRunId, setStatusFilter, setWorkflow, titleCase, useHub,
} from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { RunCard } from '../components/RunCard.jsx';
import { StatusPill } from '../components/StatusPill.jsx';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Complete' },
];

const fmtTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/* ------------------------------------------------------------------ */
/* Artifact preview + lightbox                                        */
/* ------------------------------------------------------------------ */

function Lightbox({ src, isVideo, onClose }) {
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Artifact preview"
      onClick={onClose}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-scrim p-6"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-md bg-bg2 text-ink2 transition-colors hover:text-ink1"
      >
        <Icon name="x" size={18} />
      </button>
      {isVideo ? (
        <video
          src={src}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-lg object-contain shadow-overlay"
        />
      ) : (
        <img
          src={src}
          alt="Artifact preview"
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-lg object-contain shadow-overlay"
        />
      )}
    </div>,
    document.body,
  );
}

function ArtifactCard({ run, artifact, onOpen }) {
  const rawUrl = generationArtifactUrl(run, artifact);
  const src = useMediaSrc(rawUrl);
  const mime = artifact.mime_type || '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');
  const kb = Math.max(1, Math.round((artifact.size_bytes || 0) / 1024));
  const filename = `${run.run_id}-${artifact.role || 'artifact'}`;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(new URL(rawUrl, location.href).href);
      toast('Copied artifact URL.');
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <figure className="group relative flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2 transition-colors hover:border-line2">
      {isImage || isVideo ? (
        <button
          type="button"
          onClick={() => onOpen({ src, isVideo })}
          aria-label={`Open ${titleCase(artifact.role)} preview`}
          className="grid aspect-video place-items-center overflow-hidden bg-bg3"
        >
          {isVideo
            ? <video src={src} muted preload="metadata" className="pointer-events-none h-full w-full object-cover" />
            : <img src={src} alt={artifact.role} loading="lazy" className="h-full w-full object-cover" />}
        </button>
      ) : isAudio ? (
        <span className="flex aspect-video items-center bg-bg3 px-2.5">
          <audio src={src} controls preload="metadata" className="w-full" />
        </span>
      ) : (
        <span className="grid aspect-video place-items-center bg-bg3 text-xs text-ink3">{titleCase(artifact.role)}</span>
      )}

      <figcaption className="flex items-center gap-1.5 px-2.5 py-2">
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12px] font-semibold text-ink1">{titleCase(artifact.role)}</b>
          <small className="text-[11px] text-ink3">{artifact.provider || 'studio'} · <span className="font-mono">{kb} KB</span></small>
        </span>
        <a
          href={rawUrl}
          download={filename}
          target="_blank"
          rel="noreferrer"
          aria-label={`Download ${titleCase(artifact.role)}`}
          title="Download"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
        >
          <Icon name="download" size={15} />
        </a>
        <button
          type="button"
          onClick={copyUrl}
          aria-label={`Copy ${titleCase(artifact.role)} URL`}
          title="Copy URL"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
        >
          <Icon name="copy" size={15} />
        </button>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Detail sections                                                    */
/* ------------------------------------------------------------------ */

function Section({ title, right, children }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-ink2">{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

function RunDetail({ run, operatorToken }) {
  const [preview, setPreview] = useState(null);
  if (!run) {
    return (
      <EmptyState icon="stack" title="Select a run" hint="Inspect its scenes, steps, artifacts, and next action." className="flex-1" />
    );
  }
  const action = run.next_actions?.[0];
  const canCancel = !['completed', 'cancelled'].includes(run.status);
  const canAuth = Boolean(run.current_step) || canCancel;
  const scenes = run.brief?.scenes || [];
  const created = fmtTime(run.created_at);
  const updated = fmtTime(run.updated_at);

  return (
    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink3">{titleCase(run.lane)}</p>
          <h3 className="truncate text-[15px] font-semibold text-ink1">{runTitle(run)}</h3>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink3">{run.run_id}</p>
          {created || updated ? (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink3">
              {created ? <span>created <span className="font-mono text-ink2">{created}</span></span> : null}
              {updated ? <span>updated <span className="font-mono text-ink2">{updated}</span></span> : null}
            </p>
          ) : null}
        </div>
        <StatusPill status={run.status} />
      </div>

      {action ? (
        <Section title="Next action">
          <div className="rounded-lg border border-line1 bg-bg2 p-3">
            <b className="text-[13px] text-ink1">{titleCase(action.intent)}</b>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink3">{action.reason}</p>
          </div>
        </Section>
      ) : null}

      {scenes.length ? (
        <Section title="Scenes" right={<span className="font-mono text-[11px] text-ink3">{scenes.length}</span>}>
          <div className="flex flex-col gap-1">
            {scenes.map((scene, index) => (
              <div key={index} className="flex items-start gap-2.5 rounded-md border border-line1 bg-bg2 px-3 py-2">
                <span className="mt-0.5 font-mono text-[11px] text-ink3">{String(index + 1).padStart(2, '0')}</span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13px] text-ink1">{scene.title || scene.beat || `Scene ${index + 1}`}</b>
                  {scene.beat && scene.beat !== scene.title ? <small className="block truncate text-[11px] text-ink3">{scene.beat}</small> : null}
                </span>
                {scene.duration_seconds ? <span className="shrink-0 font-mono text-[11px] text-ink3">{scene.duration_seconds}s</span> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Workflow">
        <div className="flex flex-col gap-1">
          {(run.steps || []).map((step) => (
            <div key={step.step_id} className="flex items-center gap-2.5 rounded-md border border-line1 bg-bg2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink1">{step.step_id}</span>
              <StatusPill status={step.status} dot={false} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Artifacts">
        {run.artifact_records?.length ? (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
            {run.artifact_records.map((artifact) => (
              <ArtifactCard key={artifact.id} run={run} artifact={artifact} onOpen={setPreview} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink3">No artifacts yet.</p>
        )}
      </Section>

      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => loadRunIntoSimpleComposer(run.run_id)}>Use prompt &amp; settings</Button>
          <Button size="sm" onClick={() => duplicateRun(run.run_id)}>Duplicate &amp; edit</Button>
          {run.current_step ? (
            <>
              <Button size="sm" onClick={() => runAction('resume', run.run_id)}>Resume</Button>
              <Button size="sm" onClick={() => runAction('retry', run.run_id, run.current_step)}>Retry step</Button>
            </>
          ) : null}
          {canCancel ? <Button size="sm" variant="danger" onClick={() => runAction('cancel', run.run_id)}>Cancel</Button> : null}
        </div>
        {canAuth ? (
          <Field
            label="Operator token"
            className="mt-1 max-w-sm"
            hint="Held in memory only. Needed for resume, retry, and cancel — sent as a bearer token at action time."
          >
            <TextInput
              type="password"
              autoComplete="off"
              placeholder="••••••••"
              value={operatorToken}
              onChange={(e) => setWorkflow({ operatorToken: e.target.value })}
            />
          </Field>
        ) : null}
      </Section>

      {preview ? <Lightbox src={preview.src} isVideo={preview.isVideo} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* RunsView                                                           */
/* ------------------------------------------------------------------ */

export function RunsView({ active }) {
  const s = useHub();
  const runs = filteredRuns();
  const selected = s.runs.find((run) => run.run_id === s.selectedRunId);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker="Durable production" title="Runs">
        <Segmented options={FILTERS} value={s.statusFilter} onChange={setStatusFilter} />
      </HubToolbar>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="custom-scrollbar flex min-h-0 flex-col gap-2 overflow-y-auto border-b border-line1 p-3 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-0.5 pb-1">
            <Pill tone="neutral" className="h-5 px-2 text-[10px]">{runs.length} shown</Pill>
          </div>
          {runs.length ? (
            runs.map((run) => (
              <RunCard key={run.run_id} run={run} selected={run.run_id === s.selectedRunId} onOpen={setSelectedRunId} />
            ))
          ) : (
            <EmptyState icon="stack" title="No matching runs" hint="Create a production or change the filter." />
          )}
        </div>
        <RunDetail run={selected} operatorToken={s.workflow.operatorToken} />
      </div>
    </div>
  );
}
