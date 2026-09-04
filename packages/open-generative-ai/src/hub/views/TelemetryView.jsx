// Telemetry view — generation operations metadata (local only; no prompts,
// media, credentials, or provider payloads). Baseline for the phase-2 agent.
// Summary tiles, per-provider routing evidence, and recent attempts, all from
// the /api/telemetry/generations shape via hubData formatters.
import { Card, EmptyState, Pill, SectionLabel, Spinner } from '../../ui/kit.jsx';
import { formatTelemetryDuration, humanize, providerLabel, useHub } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { t, tf } from '../../lib/i18n.js';

function Tile({ label, value, detail }) {
  return (
    <Card className="flex flex-col gap-1 p-3.5">
      <span className="text-[11px] uppercase tracking-[0.06em] text-ink3">{label}</span>
      <b className="font-mono text-[22px] font-semibold text-ink1">{value}</b>
      <small className="text-[11px] text-ink3">{detail}</small>
    </Card>
  );
}

// The tiles themselves — rendered on the Productions page's Activity tab, and on
// this page, which stays routable for anyone with the link or an old bookmark.
export function TelemetryPanel() {
  const s = useHub();
  const telemetry = s.telemetry;
  const summary = telemetry?.summary || {};
  const rate = Number(summary.success_rate || 0) * 100;
  const providers = telemetry?.by_provider || [];
  const attempts = telemetry?.recent_attempts || [];

  return (
    <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {!telemetry && s.apiOnline === false ? (
          // The last refresh failed and nothing was ever loaded: an offline
          // state, not a spinner that never ends.
          <EmptyState
            icon="plug"
            title={t('app.notRunning')}
            hint={t('activity.offlineHint')}
          />
        ) : !telemetry ? (
          <div className="grid flex-1 place-items-center py-16"><Spinner size={22} className="text-ink2" /></div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
              <Tile label={t('activity.attempts')} value={summary.attempts || 0} detail={tf('activity.running', summary.running || 0)} />
              <Tile label={t('activity.successRate')} value={`${rate.toFixed(rate % 1 ? 1 : 0)}%`} detail={tf('activity.failed', summary.failed || 0)} />
              <Tile label={t('activity.averageTime')} value={formatTelemetryDuration(summary.average_duration_ms)} detail={tf('activity.p95', formatTelemetryDuration(summary.p95_duration_ms))} />
              <Tile label={t('activity.generationCost')} value={`$${Number(summary.charged_usd || 0).toFixed(2)}`} detail={tf('activity.artifacts', summary.artifacts || 0)} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="flex flex-col gap-3">
                <SectionLabel>{t('activity.routingEvidence')}</SectionLabel>
                {providers.length ? (
                  <div className="flex flex-col gap-2">
                    {providers.map((provider) => (
                      <div key={provider.provider} className="flex items-center justify-between gap-3 rounded-lg border border-line1 bg-bg2 p-3">
                        <div className="min-w-0">
                          <b className="block truncate text-[13px] font-semibold text-ink1">{providerLabel(provider.provider)}</b>
                          <small className="text-[11px] text-ink3">
                            {provider.attempts} attempt{provider.attempts === 1 ? '' : 's'} · {provider.completed} completed · {provider.failed} failed
                          </small>
                        </div>
                        <div className="shrink-0 text-right">
                          <b className="block font-mono text-[13px] text-ink1">{Math.round(Number(provider.success_rate || 0) * 100)}%</b>
                          <small className="text-[11px] text-ink3">{formatTelemetryDuration(provider.average_duration_ms)} avg · ${Number(provider.charged_usd || 0).toFixed(2)}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon="pulse"
                    title={t('activity.noSamples')}
                    hint={t('activity.noSamplesHint')}
                  />
                )}
              </section>

              <section className="flex flex-col gap-3">
                <SectionLabel>{t('activity.latestActivity')}</SectionLabel>
                {attempts.length ? (
                  <div className="flex flex-col gap-2">
                    {attempts.map((attempt, i) => (
                      <div key={`${attempt.run_id}-${i}`} className="flex flex-col gap-1 rounded-lg border border-line1 bg-bg2 p-3">
                        <div className="flex items-center gap-2">
                          <StatusPill status={attempt.status} />
                          <b className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink1">{humanize(attempt.kind)} · {providerLabel(attempt.provider)}</b>
                        </div>
                        <small className="text-[11px] text-ink3">
                          <span className="font-mono">{attempt.model || t('activity.automatic')}</span> · {formatTelemetryDuration(attempt.duration_ms)} · ${Number(attempt.charged_usd || 0).toFixed(2)}
                        </small>
                        <small className="truncate text-[11px] text-ink3">
                          {t('common.run')} <span className="font-mono">{attempt.run_id}</span>{attempt.error_type ? ` · ${attempt.error_type}` : ''}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon="pulse"
                    title={t('activity.noAttempts')}
                    hint={t('activity.noAttemptsHint')}
                  />
                )}
              </section>
            </div>
          </div>
        )}
    </div>
  );
}

export function TelemetryView({ active }) {
  const s = useHub();

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={t('activity.kicker')}
        title={t('nav.activity')}
        subtitle={t('activity.subtitle')}
      >
        {s.telemetry && s.apiOnline === false ? <Pill tone="warn" dot>{t('activity.offlinePill')}</Pill> : null}
      </HubToolbar>
      <TelemetryPanel />
    </div>
  );
}
