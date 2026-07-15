import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Workflow } from '@/api/types';
import {
  analyzeWorkflowModelLinks,
  downloadModelLink,
  resolveWorkflowModelLinks,
  type MissingModelLink,
  type ModelLinkerAnalyzeResult,
  type ModelLinkerDownloadSource,
  type ModelLinkerMatch,
  type ModelLinkerResolution,
} from '@/api/client';
import { formatBytes } from '@/utils/formatBytes';
import { CheckIcon, CloudDownloadIcon, DownloadIcon, ReloadIcon, XMarkIcon } from '@/components/icons';

interface ModelLinkerDialogProps {
  workflow: Workflow;
  onClose: () => void;
  onWorkflowUpdated: (workflow: Workflow) => void;
}

function modelLabel(match: ModelLinkerMatch): string {
  return match.model?.relative_path || match.filename || match.model?.filename || 'Unknown model';
}

function sourceLabel(source: ModelLinkerDownloadSource): string {
  const bits = [source.source, source.match_type].filter(Boolean);
  return bits.join(' · ');
}

function buildResolutions(missing: MissingModelLink, match: ModelLinkerMatch): ModelLinkerResolution[] {
  const refs = missing.all_node_refs?.length
    ? missing.all_node_refs
    : [{
        node_id: missing.node_id,
        widget_index: missing.widget_index,
        category: missing.category,
      }];

  return refs.map((ref) => ({
    node_id: ref.node_id,
    widget_index: ref.widget_index,
    resolved_path: match.model.path,
    category: match.model.category ?? ref.category ?? missing.category,
    resolved_model: match.model,
    subgraph_id: ref.subgraph_id ?? null,
    is_top_level: ref.is_top_level,
  }));
}

export function ModelLinkerDialog({
  workflow,
  onClose,
  onWorkflowUpdated,
}: ModelLinkerDialogProps) {
  const [workingWorkflow, setWorkingWorkflow] = useState(workflow);
  const [analysis, setAnalysis] = useState<ModelLinkerAnalyzeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, string>>({});

  const missingModels = analysis?.missing_models ?? [];
  const hardwareProfile = analysis?.hardware_profile
    ?? missingModels.find((item) => item.hardware_profile)?.hardware_profile
    ?? 'unknown';

  const perfectOrHardwareCount = useMemo(
    () => missingModels.filter((item) =>
      item.matches.some((match) => match.confidence >= 100 || match.hardware_recommended || match.hardware_preferred),
    ).length,
    [missingModels],
  );

  const refreshAnalysis = async (targetWorkflow = workingWorkflow) => {
    setLoading(true);
    setError(null);
    try {
      const result = await analyzeWorkflowModelLinks(targetWorkflow);
      setAnalysis(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Model linker is unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAnalysis(workflow);
    // Run only for the workflow snapshot that opened the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyMatch = async (missing: MissingModelLink, match: ModelLinkerMatch) => {
    const key = `${missing.original_path}:${modelLabel(match)}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const resolutions = buildResolutions(missing, match);
      const result = await resolveWorkflowModelLinks(workingWorkflow, resolutions);
      setWorkingWorkflow(result.workflow);
      onWorkflowUpdated(result.workflow);
      setNotice(`Relinked ${missing.original_path} to ${modelLabel(match)}.`);
      await refreshAnalysis(result.workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to relink model');
    } finally {
      setBusyKey(null);
    }
  };

  const applyBestAvailable = async () => {
    const entries = missingModels
      .map((missing) => ({ missing, match: missing.matches[0] }))
      .filter((entry): entry is { missing: MissingModelLink; match: ModelLinkerMatch } => Boolean(entry.match));

    if (entries.length === 0) return;
    setBusyKey('__bulk__');
    setError(null);
    setNotice(null);
    try {
      const resolutions = entries.flatMap((entry) => buildResolutions(entry.missing, entry.match));
      const result = await resolveWorkflowModelLinks(workingWorkflow, resolutions);
      setWorkingWorkflow(result.workflow);
      onWorkflowUpdated(result.workflow);
      setNotice(`Relinked ${entries.length} missing model${entries.length === 1 ? '' : 's'}.`);
      await refreshAnalysis(result.workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to relink models');
    } finally {
      setBusyKey(null);
    }
  };

  const startDownload = async (source: ModelLinkerDownloadSource) => {
    const key = source.filename || source.url;
    setBusyKey(`download:${key}`);
    setError(null);
    try {
      const result = await downloadModelLink(source);
      setDownloads((current) => ({
        ...current,
        [key]: `Download queued: ${result.download_id}`,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start download');
    } finally {
      setBusyKey(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[2300] bg-black/50 flex items-center justify-center p-3"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl max-h-[88vh] overflow-hidden rounded-xl border border-white/10 bg-slate-950 text-slate-100 shadow-2xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-white/10">
          <div className="min-w-0">
            <div className="text-base font-semibold">Relink workflow models</div>
            <div className="text-xs text-slate-400 mt-1">
              Hardware profile: <span className="text-cyan-300">{hardwareProfile}</span>
            </div>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-white/10"
            onClick={onClose}
            aria-label="Close model relinker"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold text-slate-950 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50"
            onClick={applyBestAvailable}
            disabled={loading || busyKey !== null || missingModels.length === 0}
          >
            <CheckIcon className="w-4 h-4" />
            Use best matches
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50"
            onClick={() => void refreshAnalysis()}
            disabled={loading || busyKey !== null}
          >
            <ReloadIcon className="w-4 h-4" />
            Rescan
          </button>
          <div className="ml-auto text-xs text-slate-400">
            {analysis ? `${analysis.total_missing} missing / ${analysis.total_models_analyzed} scanned` : 'Scanning'}
            {perfectOrHardwareCount > 0 ? ` · ${perfectOrHardwareCount} strong match${perfectOrHardwareCount === 1 ? '' : 'es'}` : ''}
          </div>
        </div>

        {(error || notice) && (
          <div className={`px-4 py-2 text-sm border-b ${error ? 'border-red-500/20 bg-red-500/10 text-red-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'}`}>
            {error || notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-400">Scanning workflow model references...</div>
          ) : missingModels.length === 0 && !error ? (
            <div className="py-10 text-center">
              <div className="text-sm font-semibold text-slate-100">All referenced models are present.</div>
              <div className="text-xs text-slate-400 mt-1">This workflow does not need relinking on the current Comfy server.</div>
            </div>
          ) : (
            missingModels.map((missing) => {
              const best = missing.matches[0];
              const recommendation = missing.hardware_recommendations?.[0];
              const download = missing.download_source ?? recommendation?.download;
              const downloadKey = download?.filename || download?.url || '';
              return (
                <div key={`${missing.original_path}:${missing.node_id}:${missing.widget_index}`} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-slate-100 break-words">{missing.original_path}</div>
                      <div className="text-xs text-slate-400 mt-1">
                        {missing.category ?? 'unknown'} · {missing.all_node_refs?.length ?? 1} reference{(missing.all_node_refs?.length ?? 1) === 1 ? '' : 's'}
                      </div>
                    </div>
                    {best && (
                      <button
                        type="button"
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-950 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50"
                        onClick={() => void applyMatch(missing, best)}
                        disabled={busyKey !== null}
                      >
                        Use best
                      </button>
                    )}
                  </div>

                  {recommendation?.reason && (
                    <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs text-cyan-100">
                      {recommendation.label ? <span className="font-semibold">{recommendation.label}: </span> : null}
                      {recommendation.reason}
                    </div>
                  )}

                  {missing.matches.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {missing.matches.slice(0, 4).map((match) => {
                        const key = `${missing.original_path}:${modelLabel(match)}`;
                        return (
                          <div key={key} className="flex items-center gap-2 rounded-lg bg-slate-900/80 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-xs text-slate-100 truncate">{modelLabel(match)}</div>
                              <div className="text-[11px] text-slate-400 truncate">
                                {match.confidence}% match
                                {match.hardware_score ? ` · hardware ${match.hardware_score > 0 ? '+' : ''}${match.hardware_score}` : ''}
                                {match.hardware_recommended || match.hardware_preferred ? ' · recommended' : ''}
                              </div>
                              {match.hardware_reasons?.[0] && (
                                <div className="text-[11px] text-cyan-200 truncate">{match.hardware_reasons[0]}</div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-200 border border-white/10 hover:bg-white/10 disabled:opacity-50"
                              onClick={() => void applyMatch(missing, match)}
                              disabled={busyKey !== null}
                            >
                              {busyKey === key ? 'Applying' : 'Use'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {download && (
                    <div className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-white/15 bg-slate-900/60 px-3 py-2">
                      <CloudDownloadIcon className="w-5 h-5 text-slate-300 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-slate-100 truncate">{download.filename}</div>
                        <div className="text-[11px] text-slate-400 truncate">
                          {sourceLabel(download)}
                          {download.size ? ` · ${formatBytes(download.size)}` : ''}
                        </div>
                        {download.hardware_reason && (
                          <div className="text-[11px] text-cyan-200 truncate">{download.hardware_reason}</div>
                        )}
                        {downloadKey && downloads[downloadKey] && (
                          <div className="text-[11px] text-emerald-300">{downloads[downloadKey]}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50"
                        onClick={() => void startDownload(download)}
                        disabled={busyKey !== null || !download.url}
                      >
                        <DownloadIcon className="w-3.5 h-3.5" />
                        {busyKey === `download:${downloadKey}` ? 'Starting' : 'Download'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="px-4 py-3 border-t border-white/10 text-[11px] text-slate-400">
          Relinking changes the loaded workflow. Use Save afterward to persist the fixed model paths.
        </div>
      </div>
    </div>,
    document.body,
  );
}
