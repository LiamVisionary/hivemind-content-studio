// Providers view — capability routing board + server-side OAuth accounts.
// OAuth stays inside HivemindOS; this surface receives status only and can kick
// off the connect flow (startOAuth). The provider board flattens
// catalog.providers_by_role and dedupes by id, exactly like the old
// renderProviders; readiness now reads as a labelled StatusPill instead of a
// bare tooltip dot, and each provider's detail/requirement doubles as the
// remediation copy. The two OAuth cards are hardcoded exactly as renderOAuth
// (openai.connected / xai.usable + needs_reconnect, Connect vs Reconnect labels).
import { useState } from 'react';
import { Button, Card, EmptyState, SectionLabel } from '../../ui/kit.jsx';
import { providerLabel, startOAuth, useHub } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { StatusPill } from '../components/StatusPill.jsx';

function OAuthCard({ card }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    await startOAuth(card.id);
    setBusy(false);
  };
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink1">{card.label}</h4>
        <StatusPill status={card.ready ? 'ready' : 'idle'} label={card.ready ? 'Connected' : 'Needs setup'} />
      </div>
      <p className="text-[12px] leading-relaxed text-ink3">{card.detail}<br />{card.note}</p>
      <Button size="sm" icon="external" loading={busy} onClick={connect} className="self-start">
        {card.ready || card.needsReconnect ? `Reconnect ${card.label}` : `Connect ${card.label}`}
      </Button>
    </Card>
  );
}

function ProviderCard({ provider }) {
  return (
    <Card className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-ink1">{providerLabel(provider.id)}</h3>
        <StatusPill
          status={provider.available ? 'ready' : 'idle'}
          label={provider.available ? 'Ready' : 'Needs setup'}
          className="h-5 px-2 text-[10px]"
        />
      </div>
      <p className="text-[12px] leading-relaxed text-ink3">{provider.detail || provider.requirement}</p>
      {provider.roles?.length ? (
        <div className="flex flex-wrap gap-1">
          {provider.roles.map((role) => (
            <span key={role} className="rounded-sm bg-bg1 px-1.5 py-0.5 text-[10px] text-ink3">{role}</span>
          ))}
        </div>
      ) : null}
      <div className="mt-auto pt-1 font-mono text-[11px] text-ink3">{provider.mode} · {provider.cost}</div>
    </Card>
  );
}

export function ProvidersView({ active }) {
  const s = useHub();
  const oauth = s.oauth?.providers || {};
  const oauthCards = [
    {
      id: 'openai',
      label: 'OpenAI',
      ready: Boolean(oauth.openai?.connected),
      needsReconnect: false,
      detail: oauth.openai?.detail || 'Checking the HivemindOS OpenAI OAuth session…',
      note: 'GPT Image OAuth uses the Codex Responses image tool. The official Image API remains a separate OPENAI_API_KEY provider.',
    },
    {
      id: 'xai',
      label: 'xAI',
      ready: Boolean(oauth.xai?.usable),
      needsReconnect: Boolean(oauth.xai?.needs_reconnect),
      detail: oauth.xai?.detail || 'Checking the HivemindOS xAI OAuth session…',
      note: 'A usable api:access session enables Grok Imagine image and video generation.',
    },
  ];

  const providers = s.catalog
    ? [...new Map(Object.values(s.catalog.providers_by_role).flat().map((provider) => [provider.id, provider])).values()]
    : [];

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker="Capability routing" title="Providers" />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div>
              <SectionLabel>Server-side authentication</SectionLabel>
              <p className="mt-1 text-xs text-ink3">OAuth stays inside HivemindOS. This studio receives status only.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {oauthCards.map((card) => <OAuthCard key={card.id} card={card} />)}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel>Generation routes · capability providers</SectionLabel>
            {providers.length ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
              </div>
            ) : (
              <EmptyState icon="plug" title="No providers advertised" hint="Provider readiness and routing appear once the studio API is reachable." />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
