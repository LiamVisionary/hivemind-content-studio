// Providers view — capability routing board + server-side OAuth accounts.
// OAuth stays inside HivemindOS; this surface receives status only and can kick
// off the connect flow (startOAuth). The provider board flattens
// catalog.providers_by_role and dedupes by id, exactly like the old
// renderProviders; readiness reads as a labelled StatusPill, and each
// provider's detail/requirement doubles as the remediation copy. The two OAuth
// cards are hardcoded exactly as renderOAuth (openai.connected / xai.usable +
// needs_reconnect, Connect vs Reconnect labels). While this view is showing,
// hubData re-reads /api/oauth on every poll tick, so a sign-in finished in
// another tab lands on its card by itself.
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { zh } from '../../lib/i18n.js';
import { Button, Card, EmptyState, Field, Pill, SectionLabel, TextInput } from '../../ui/kit.jsx';
import { api, providerLabel, refreshOAuth, startOAuth, useHub } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { toastFailure } from '../../ui/failureToast.jsx';

function OAuthCard({ card, link, checking, offline }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    await startOAuth(card.id);
    setBusy(false);
  };
  // Only say "Checking…" while the status really is unknown. Once /api/oauth
  // has answered, an unconnected account is "Not connected" plus what it needs;
  // a dead API is said outright instead of checking forever.
  const detail = card.detail
    || (offline
      ? (zh() ? '状态不可用 — 工作室没有运行。' : 'Status unavailable — the studio is not running.')
      : checking
        ? (zh() ? '正在检查 HivemindOS 的 OAuth 会话…' : `Checking the HivemindOS ${card.label} OAuth session…`)
        : card.ready
          ? (zh() ? '已连接。' : 'Connected.')
          : (zh() ? '未连接。' : 'Not connected.'));
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink1">{card.label}</h4>
        <StatusPill
          status={card.ready ? 'ready' : checking ? 'pending' : 'idle'}
          label={card.ready ? (zh() ? '已连接' : 'Connected') : checking ? (zh() ? '检查中' : 'Checking') : (zh() ? '需要设置' : 'Needs setup')}
        />
      </div>
      <p className="break-words text-[12px] leading-relaxed text-ink3 [overflow-wrap:anywhere]">
        {detail}
        <br />
        {card.note}
      </p>
      {link ? (
        <p className="text-[12px] text-ink2">
          {zh() ? '登录标签页被阻止。' : 'The sign-in tab was blocked.'}{' '}
          <a href={link} target="_blank" rel="noopener noreferrer" className="font-medium text-honey underline-offset-2 hover:underline">
            {zh() ? '在此打开登录页面' : 'Open the sign-in page here'}
          </a>
        </p>
      ) : null}
      <Button size="sm" icon="external" loading={busy} onClick={connect} className="self-start">
        {card.ready || card.needsReconnect
          ? (zh() ? `重新连接 ${card.label}` : `Reconnect ${card.label}`)
          : (zh() ? `连接 ${card.label}` : `Connect ${card.label}`)}
      </Button>
    </Card>
  );
}

/**
 * The key a card is waiting for, set here rather than somewhere else.
 *
 * It writes through the same `/api/passbook` route the producer picker's own
 * key field uses (localProducer.saveProviderKey), which applies the value to
 * this process and forgets the account cache — so the card flips to Ready on
 * the next catalog poll with no second write path and no restart.
 */
function AddKeyRow({ name, configured, onSaved }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('/api/passbook', { method: 'POST', body: JSON.stringify({ values: { [name]: value } }) });
      setValue('');
      setOpen(false);
      toast.success(zh() ? `${name} 已保存。` : `${name} saved.`);
      onSaved?.();
    } catch (error) {
      // api() has already turned the refusal into a sentence.
      toastFailure(error, { operation: 'Saving the key' });
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <Button size="sm" className="self-start" onClick={() => setOpen(true)}>
        {configured
          ? (zh() ? `替换 ${name}` : `Replace ${name}`)
          : (zh() ? `添加 ${name}` : `Add ${name}`)}
      </Button>
    );
  }
  return (
    <div className="flex items-end gap-2">
      {/* The env-var name is the field's own label — visible, never a tooltip
          on its own, because it is what somebody pasting a key looks for. */}
      <Field className="min-w-0 flex-1" label={<span className="font-mono">{name}</span>}>
        <TextInput
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={zh() ? '粘贴密钥' : 'Paste the key'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button size="sm" variant="primary" loading={busy} disabled={busy || !value.trim()} onClick={save}>
        {zh() ? '保存' : 'Save'}
      </Button>
      <Button size="sm" onClick={() => { setOpen(false); setValue(''); }}>{zh() ? '取消' : 'Cancel'}</Button>
    </div>
  );
}

function ProviderCard({ provider, settable, onSaved }) {
  // Which of this provider's credentials this studio is allowed to write. A
  // provider whose readiness is a binary on the machine (ffmpeg, a local
  // renderer) has none, and gets its requirement sentence instead of a field
  // that would write nothing.
  const settableKeys = (provider.keys || []).filter((key) => settable.has(key));
  return (
    <Card className="flex min-w-0 flex-col gap-2.5 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-[13px] font-semibold text-ink1">{providerLabel(provider.id)}</h3>
        <StatusPill
          status={provider.available ? 'ready' : 'idle'}
          label={provider.available ? (zh() ? '就绪' : 'Ready') : (zh() ? '需要设置' : 'Needs setup')}
          className="h-5 px-2 text-[10px]"
        />
      </div>
      {/* `needs` is the humanized sentence the provider matrix writes ("Needs a
          MUAPI key"); the env-var name it stands for is one hover away in the
          title, and spelled out in full on the field below. Long names
          (CONTENT_STUDIO_RUNTIME_<ID>_…) must wrap inside the card rather than
          run out of it. */}
      <p
        className="break-words text-[12px] leading-relaxed text-ink3 [overflow-wrap:anywhere]"
        title={(provider.keys || []).join(' · ') || undefined}
      >
        {provider.needs || provider.detail || provider.requirement}
      </p>
      {/* Whatever the readiness check learned that the sentence above does not
          already say — "use the separate OAuth provider", a URL that did not
          answer. The env-var prose (`requirement`) only appears for providers
          with no field to offer, where it is the only instruction there is. */}
      {!provider.available && provider.detail && provider.detail !== (provider.needs || provider.detail) ? (
        <p className="break-words text-[11px] leading-relaxed text-ink2 [overflow-wrap:anywhere]">{provider.detail}</p>
      ) : null}
      {!provider.available && !settableKeys.length && !provider.needs && provider.requirement && provider.requirement !== provider.detail ? (
        <p className="break-words text-[11px] leading-relaxed text-ink2 [overflow-wrap:anywhere]">{provider.requirement}</p>
      ) : null}
      {/* Never a problem without its fix: the key this card is waiting for is
          set on the card, not on another page. */}
      {settableKeys.map((key) => (
        <AddKeyRow key={key} name={key} configured={provider.available} onSaved={onSaved} />
      ))}
      {provider.roles?.length ? (
        <div className="flex flex-wrap gap-1">
          {provider.roles.map((role) => (
            <span key={role} className="rounded-sm bg-bg1 px-1.5 py-0.5 text-[10px] text-ink3">{role}</span>
          ))}
        </div>
      ) : null}
      <div className="mt-auto break-words pt-1 font-mono text-[11px] text-ink3 [overflow-wrap:anywhere]">{provider.mode} · {provider.cost}</div>
    </Card>
  );
}

export function ProvidersView({ active }) {
  const s = useHub();
  const [checking, setChecking] = useState(false);
  // Which credential names this studio may write, from the same allow-list the
  // PassBook page uses. Unknown until it answers — an empty set just means no
  // inline field, never a broken one.
  const [settable, setSettable] = useState(() => new Set());
  const [keyEpoch, setKeyEpoch] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void api('/api/passbook')
      .then((payload) => {
        if (live) setSettable(new Set((payload?.settable || []).map((row) => row.key)));
      })
      .catch(() => { /* no allow-list means no inline field, which is fine */ });
    return () => { live = false; };
  }, [active, keyEpoch]);
  const oauth = s.oauth?.providers || {};
  const statusKnown = Boolean(s.oauth);
  const oauthCards = [
    {
      id: 'openai',
      label: 'OpenAI',
      ready: Boolean(oauth.openai?.connected),
      needsReconnect: false,
      detail: oauth.openai?.detail || '',
      note: 'GPT Image OAuth uses the Codex Responses image tool. The official Image API remains a separate OPENAI_API_KEY provider.',
    },
    {
      id: 'xai',
      label: 'xAI',
      ready: Boolean(oauth.xai?.usable),
      needsReconnect: Boolean(oauth.xai?.needs_reconnect),
      detail: oauth.xai?.detail || '',
      note: 'A usable api:access session enables Grok Imagine image and video generation.',
    },
  ];

  const providers = s.catalog
    ? [...new Map(Object.values(s.catalog.providers_by_role).flat().map((provider) => [provider.id, provider])).values()]
    : [];

  const checkStatus = async () => {
    setChecking(true);
    try { await refreshOAuth(); } finally { setChecking(false); }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker={zh() ? '能力路由' : 'Capability routing'} title={zh() ? '提供商' : 'Providers'}>
        {s.apiOnline === false ? <Pill tone="warn" dot>{zh() ? '离线' : 'Offline'}</Pill> : null}
        <Button size="sm" icon="refresh" loading={checking} onClick={checkStatus}>
          {zh() ? '检查状态' : 'Check status'}
        </Button>
      </HubToolbar>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <div>
              <SectionLabel>{zh() ? '服务端身份验证' : 'Server-side authentication'}</SectionLabel>
              <p className="mt-1 text-xs text-ink3">
                {zh()
                  ? 'OAuth 保留在 HivemindOS 内。这个工作室只接收状态。'
                  : 'OAuth stays inside HivemindOS. This studio receives status only — finish a sign-in in its tab and the card updates here.'}
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {oauthCards.map((card) => (
                <OAuthCard
                  key={card.id}
                  card={card}
                  link={s.oauthLinks?.[card.id] || ''}
                  checking={!statusKnown && s.apiOnline !== false}
                  offline={!statusKnown && s.apiOnline === false}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <SectionLabel>{zh() ? '生成路由 · 能力提供商' : 'Generation routes · capability providers'}</SectionLabel>
            {providers.length ? (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                {providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    settable={settable}
                    onSaved={() => setKeyEpoch((epoch) => epoch + 1)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="plug"
                title={zh() ? '没有可用的提供商' : 'No providers advertised'}
                hint={zh() ? '工作室运行后，提供商的就绪状态和路由会出现在这里。' : 'Provider readiness and routing appear once the studio is running.'}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
