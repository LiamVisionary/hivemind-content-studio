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
import { toast } from 'react-hot-toast';
import { useMediaSrc } from '../../hooks/hooks.js';
import { downloadMedia } from '../../lib/downloadMedia.js';
import { mediaDownloadName } from '../../lib/downloadNames.js';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import { Button, EmptyState, Field, Pill, Segmented, TextInput } from '../../ui/kit.jsx';
import {
  duplicateRun, extensionForMime, filteredRuns, generationArtifactUrl, humanize, laneLabel,
  loadRunIntoSimpleComposer, runAction, runDisplayTitle, setSelectedRunId, setStatusFilter,
  setWorkflow, useHub,
} from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { TelemetryPanel } from './TelemetryView.jsx';
import { Lightbox } from '../components/Lightbox.jsx';
import { RunCard } from '../components/RunCard.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { toastFailure } from '../../ui/failureToast.jsx';
import { t, tf } from '../../lib/i18n.js';

const FILTERS = [
  { value: '', label: t('runs.filterAll') },
  { value: 'active', label: t('common.active') },
  { value: 'completed', label: t('runs.filterComplete') },
];

const fmtTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/* ------------------------------------------------------------------ */
/* Artifact preview                                                   */
/* ------------------------------------------------------------------ */

function ArtifactCard({ run, artifact, onOpen }) {
  const rawUrl = generationArtifactUrl(run, artifact);
  const src = useMediaSrc(rawUrl);
  const mime = artifact.mime_type || '';
  const isImage = mime.startsWith('image/');
  const isVideo = mime.startsWith('video/');
  const isAudio = mime.startsWith('audio/');
  const kb = Math.max(1, Math.round((artifact.size_bytes || 0) / 1024));
  // Named like History's downloads: <provider>-<run>-<role>.<ext>. The raw
  // anchor this replaces saved a sealed artifact's envelope JSON (ciphertext)
  // under a name with no extension at all.
  const filename = mediaDownloadName(
    artifact.provider, `${run.run_id}-${artifact.role || 'artifact'}`, extensionForMime(mime), { fallback: 'artifact' },
  );

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(new URL(rawUrl, location.href).href);
      toast(t('runs.copiedUrl'));
    } catch (error) {
      toastFailure(error, { operation: t('runs.thatRunAction') });
    }
  };

  return (
    <figure className="group relative flex flex-col overflow-hidden rounded-lg border border-line1 bg-bg2 transition-colors hover:border-line2">
      {isImage || isVideo ? (
        <button
          type="button"
          onClick={() => onOpen({ src, isVideo, title: humanize(artifact.role) })}
          aria-label={`Open ${humanize(artifact.role)} preview`}
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
        <span className="grid aspect-video place-items-center bg-bg3 text-xs text-ink3">{humanize(artifact.role)}</span>
      )}

      <figcaption className="flex items-center gap-1.5 px-2.5 py-2">
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[12px] font-semibold text-ink1">{humanize(artifact.role)}</b>
          <small className="text-[11px] text-ink3">{artifact.provider || 'studio'} · <span className="font-mono">{kb} KB</span></small>
        </span>
        <button
          type="button"
          onClick={() => void downloadMedia(rawUrl, filename)}
          aria-label={tf('runs.downloadNamed', humanize(artifact.role))}
          title={t('common.download')}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
        >
          <Icon name="download" size={15} />
        </button>
        <button
          type="button"
          onClick={copyUrl}
          aria-label={tf('runs.copyNamedUrl', humanize(artifact.role))}
          title={t('runs.copyUrl')}
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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  if (!run) {
    return (
      <EmptyState
        icon="stack"
        title={t('runs.pickAProduction')}
        hint={t('runs.pickAProductionHint')}
        className="flex-1"
      />
    );
  }
  const action = run.next_actions?.[0];
  // A failed run has nothing left to cancel.
  const canCancel = !['completed', 'cancelled', 'failed'].includes(run.status);
  const canAuth = Boolean(run.current_step) || canCancel;
  const cancelRun = async () => {
    setCancelling(true);
    try { await runAction('cancel', run.run_id); } finally { setCancelling(false); setConfirmCancel(false); }
  };
  const scenes = run.brief?.scenes || [];
  const created = fmtTime(run.created_at);
  const updated = fmtTime(run.updated_at);

  return (
    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* The lane is the kicker unless it is already the title (a brief with no title of its own). */}
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink3">
            {runDisplayTitle(run) === laneLabel(run.lane) ? t('runs.production') : laneLabel(run.lane)}
          </p>
          <h3 className="truncate text-[15px] font-semibold text-ink1">{runDisplayTitle(run)}</h3>
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink3" title={run.run_id}>{run.run_id}</p>
          {created || updated ? (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink3">
              {created ? <span>{t('runs.created')} <span className="font-mono text-ink2">{created}</span></span> : null}
              {updated ? <span>{t('runs.updated')} <span className="font-mono text-ink2">{updated}</span></span> : null}
            </p>
          ) : null}
        </div>
        <StatusPill status={run.status} />
      </div>

      {action ? (
        <Section title={t('runs.nextAction')}>
          <div className="rounded-lg border border-line1 bg-bg2 p-3">
            <b className="text-[13px] text-ink1">{humanize(action.intent)}</b>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink3">{action.reason}</p>
          </div>
        </Section>
      ) : null}

      {scenes.length ? (
        <Section title={t('runs.scenes')} right={<span className="font-mono text-[11px] text-ink3">{scenes.length}</span>}>
          <div className="flex flex-col gap-1">
            {scenes.map((scene, index) => (
              <div key={index} className="flex items-start gap-2.5 rounded-md border border-line1 bg-bg2 px-3 py-2">
                <span className="mt-0.5 font-mono text-[11px] text-ink3">{String(index + 1).padStart(2, '0')}</span>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13px] text-ink1">{scene.title || scene.beat || tf('runs.sceneNumber', index + 1)}</b>
                  {scene.beat && scene.beat !== scene.title ? <small className="block truncate text-[11px] text-ink3">{scene.beat}</small> : null}
                </span>
                {scene.duration_seconds ? <span className="shrink-0 font-mono text-[11px] text-ink3">{scene.duration_seconds}s</span> : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('runs.workflow')}>
        <div className="flex flex-col gap-1">
          {(run.steps || []).map((step) => (
            <div key={step.step_id} className="flex items-center gap-2.5 rounded-md border border-line1 bg-bg2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink1">{step.step_id}</span>
              <StatusPill status={step.status} dot={false} />
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('runs.artifacts')}>
        {run.artifact_records?.length ? (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
            {run.artifact_records.map((artifact) => (
              <ArtifactCard key={artifact.id} run={run} artifact={artifact} onOpen={setPreview} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink3">{t('runs.noArtifacts')}</p>
        )}
      </Section>

      <Section title={t('runs.actions')}>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => loadRunIntoSimpleComposer(run.run_id)}>{t('runs.usePromptAndSettings')}</Button>
          <Button size="sm" onClick={() => duplicateRun(run.run_id)}>{t('runs.duplicateAndEdit')}</Button>
          {run.current_step ? (
            <>
              <Button size="sm" onClick={() => runAction('resume', run.run_id)}>{t('runs.resume')}</Button>
              <Button size="sm" onClick={() => runAction('retry', run.run_id, run.current_step)}>{t('runs.retryStep')}</Button>
            </>
          ) : null}
          {canCancel ? <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)}>{t('runs.cancelRun')}</Button> : null}
        </div>
        {canAuth ? (
          <Field
            label={t('runs.operatorToken')}
            className="mt-1 max-w-sm"
            hint={t('runs.operatorTokenHint')}
          >
            <TextInput
              type="password"
              autoComplete="off"
              placeholder={t('runs.tokenPlaceholder')}
              value={operatorToken}
              onChange={(e) => setWorkflow({ operatorToken: e.target.value })}
            />
          </Field>
        ) : null}
      </Section>

      {preview ? (
        <Lightbox
          src={preview.src}
          kind={preview.isVideo ? 'video' : 'image'}
          title={preview.title}
          alt={preview.title}
          onClose={() => setPreview(null)}
        />
      ) : null}
      <ConfirmModal
        open={confirmCancel}
        onClose={() => (cancelling ? null : setConfirmCancel(false))}
        onConfirm={cancelRun}
        busy={cancelling}
        title={t('runs.cancelTitle')}
        confirmLabel={t('runs.cancelConfirm')}
        cancelLabel={t('runs.cancelKeep')}
        body={tf('runs.cancelBody', runDisplayTitle(run))}
      />
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
  // Activity used to be its own nav page that was empty for anyone who had not
  // run the Planner. It is the same productions, counted — so it lives here.
  const [tab, setTab] = useState('productions');
  const tabs = [
    { value: 'productions', label: t('nav.productions') },
    { value: 'activity', label: t('nav.activity') },
  ];

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker={t('runs.kicker')} title={t('nav.productions')}>
        <Segmented options={tabs} value={tab} onChange={setTab} />
        {tab === 'productions' ? <Segmented options={FILTERS} value={s.statusFilter} onChange={setStatusFilter} /> : null}
      </HubToolbar>

      {tab === 'activity' ? <TelemetryPanel /> : (
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="custom-scrollbar flex min-h-0 flex-col gap-2 overflow-y-auto border-b border-line1 p-3 md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-0.5 pb-1">
            <Pill tone="neutral" className="h-5 px-2 text-[10px]">{tf('runs.shownCount', runs.length)}</Pill>
          </div>
          {runs.length ? (
            runs.map((run) => (
              <RunCard key={run.run_id} run={run} selected={run.run_id === s.selectedRunId} onOpen={setSelectedRunId} />
            ))
          ) : (
            <EmptyState
              icon="stack"
              title={t('runs.noMatching')}
              hint={t('runs.noMatchingHint')}
            />
          )}
        </div>
        <RunDetail run={selected} operatorToken={s.workflow.operatorToken} />
      </div>
      )}
    </div>
  );
}
