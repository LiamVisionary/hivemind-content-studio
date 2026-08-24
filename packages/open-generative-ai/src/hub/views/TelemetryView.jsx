// Telemetry view — generation operations metadata (local only; no prompts,
// media, credentials, or provider payloads). Baseline for the phase-2 agent.
// Summary tiles, per-provider routing evidence, and recent attempts, all from
// the /api/telemetry/generations shape via hubData formatters.
import { getLang } from '../../lib/i18n.js';
import { Card, EmptyState, Pill, SectionLabel, Spinner } from '../../ui/kit.jsx';
import { formatTelemetryDuration, humanize, providerLabel, useHub } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { StatusPill } from '../components/StatusPill.jsx';

const zh = () => getLang() === 'zh-CN';

function Tile({ label, value, detail }) {
  return (
    <Card className="flex flex-col gap-1 p-3.5">
      <span className="text-[11px] uppercase tracking-[0.06em] text-ink3">{label}</span>
      <b className="font-mono text-[22px] font-semibold text-ink1">{value}</b>
      <small className="text-[11px] text-ink3">{detail}</small>
    </Card>
  );
}

export function TelemetryView({ active }) {
  const s = useHub();
  const telemetry = s.telemetry;
  const summary = telemetry?.summary || {};
  const rate = Number(summary.success_rate || 0) * 100;
  const providers = telemetry?.by_provider || [];
  const attempts = telemetry?.recent_attempts || [];

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={zh() ? '生成运营' : 'Generation operations'}
        title={zh() ? '遥测' : 'Telemetry'}
        subtitle={zh()
          ? '仅智能体路由的制作 · 仅本地元数据，无提示词、媒体、凭据或提供商负载'
          : 'Agent-routed productions only · local metadata, no prompts, media, credentials, or provider payloads'}
      >
        {telemetry && s.apiOnline === false ? <Pill tone="warn" dot>{zh() ? '离线 · 显示上次读取' : 'Offline · showing the last reading'}</Pill> : null}
      </HubToolbar>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {!telemetry && s.apiOnline === false ? (
          // The last refresh failed and nothing was ever loaded: an offline
          // state, not a spinner that never ends.
          <EmptyState
            icon="plug"
            title={zh() ? '工作室 API 不可达' : 'Studio API unreachable'}
            hint={zh() ? '遥测来自本地控制 API。它恢复后会自动重试。' : 'Telemetry comes from the local control API. It retries on its own once the API is back.'}
          />
        ) : !telemetry ? (
          <div className="grid flex-1 place-items-center py-16"><Spinner size={22} className="text-ink2" /></div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
              <Tile label="Attempts" value={summary.attempts || 0} detail={`${summary.running || 0} running`} />
              <Tile label="Success rate" value={`${rate.toFixed(rate % 1 ? 1 : 0)}%`} detail={`${summary.failed || 0} failed`} />
              <Tile label="Average time" value={formatTelemetryDuration(summary.average_duration_ms)} detail={`p95 ${formatTelemetryDuration(summary.p95_duration_ms)}`} />
              <Tile label="Generation cost" value={`$${Number(summary.charged_usd || 0).toFixed(2)}`} detail={`${summary.artifacts || 0} artifacts`} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="flex flex-col gap-3">
                <SectionLabel>Routing evidence · by provider</SectionLabel>
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
                    title={zh() ? '还没有生成样本' : 'No generation samples yet'}
                    hint={zh() ? '规划器运行中的图像、视频、语音和音乐尝试会显示在这里 — 工作室的生成不计入。' : 'Image, video, voice, and music attempts made by Planner runs appear here — studio generations are not counted.'}
                  />
                )}
              </section>

              <section className="flex flex-col gap-3">
                <SectionLabel>Latest activity · generation attempts</SectionLabel>
                {attempts.length ? (
                  <div className="flex flex-col gap-2">
                    {attempts.map((attempt, i) => (
                      <div key={`${attempt.run_id}-${i}`} className="flex flex-col gap-1 rounded-lg border border-line1 bg-bg2 p-3">
                        <div className="flex items-center gap-2">
                          <StatusPill status={attempt.status} />
                          <b className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink1">{humanize(attempt.kind)} · {providerLabel(attempt.provider)}</b>
                        </div>
                        <small className="text-[11px] text-ink3">
                          <span className="font-mono">{attempt.model || 'automatic'}</span> · {formatTelemetryDuration(attempt.duration_ms)} · ${Number(attempt.charged_usd || 0).toFixed(2)}
                        </small>
                        <small className="truncate text-[11px] text-ink3">
                          Run <span className="font-mono">{attempt.run_id}</span>{attempt.error_type ? ` · ${attempt.error_type}` : ''}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon="pulse"
                    title={zh() ? '没有最近的尝试' : 'No recent attempts'}
                    hint={zh() ? '当一个运行分派生成意图时，遥测开始。' : 'Telemetry begins when a run dispatches a generation intent.'}
                  />
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
