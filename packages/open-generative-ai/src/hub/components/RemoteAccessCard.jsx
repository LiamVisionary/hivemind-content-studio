// "Open on my other devices" — the switch that replaced a boot-time proxy.
//
// The stack used to publish the studio on the tailnet at every launch, through
// a hand-rolled HTTPS proxy holding a self-signed certificate, in front of a
// Canvas port that authenticated nothing. Now nothing is published until this
// switch is on, and when it is, `tailscale serve` does it with a real
// certificate and publishes only the studio's own port.
//
// Everything this card can say carries its fix in the same card: Tailscale not
// installed, this Mac not signed in, the tailnet's HTTPS certificates turned
// off. There is no state here whose only remedy is somewhere else.
import { useCallback, useEffect, useState } from 'react';
import { zh } from '../../lib/i18n.js';
import { Button, Card, FailureCallout, Pill, SectionLabel, Spinner, Toggle } from '../../ui/kit.jsx';
import { api } from '../hubData.js';

export function RemoteAccessCard() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api('/api/remote-access'));
      setFailure(null);
    } catch (error) {
      setState(null);
      setFailure({
        title: zh() ? '无法读取远程访问状态' : 'Could not read the remote access setting',
        detail: String(error?.message || ''),
      });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = useCallback(async (next) => {
    setBusy(true);
    setFailure(null);
    try {
      setState(await api('/api/remote-access', { method: 'POST', body: JSON.stringify({ enabled: next }) }));
    } catch (error) {
      setFailure({
        title: String(error?.message || (zh() ? '无法更改远程访问' : 'Could not change remote access')),
        detail: String(error?.remedy || ''),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async () => {
    if (!state?.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard is unavailable over plain http on some hosts; the URL is
      // selectable text right beside this button, so there is nothing to fix.
    }
  }, [state?.url]);

  const enabled = Boolean(state?.enabled);
  const supported = Boolean(state?.supported);

  return (
    <section className="flex flex-col gap-3" aria-label="Remote access">
      <SectionLabel>{zh() ? '在我的其他设备上打开' : 'Open on my other devices'}</SectionLabel>
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <b className="text-[13px] text-ink1">
                {zh() ? '通过 Tailscale 发布这个工作室' : 'Publish this studio on my tailnet'}
              </b>
              {enabled ? <Pill tone="honey">{zh() ? '已发布' : 'Published'}</Pill> : null}
            </div>
            <small className="text-[12px] leading-relaxed text-ink3">
              {zh()
                ? '默认关闭。开启后只会发布工作室自身的端口——画布端口始终只在本机。'
                : 'Off by default. Turning it on publishes only the studio’s own port; the Canvas port stays on this Mac either way.'}
            </small>
          </div>
          {state === null && !failure
            ? <Spinner size={16} className="text-ink2" />
            : (
              <Toggle
                checked={enabled}
                disabled={busy || !supported}
                onChange={toggle}
                label={zh() ? '发布到 tailnet' : 'Publish on my tailnet'}
              />
            )}
        </div>

        {state && !supported ? (
          <div className="rounded-md border border-line1 bg-bg1 px-3 py-2">
            <small className="block text-[12px] text-ink2">{state.detail}</small>
            <small className="mt-1 block text-[12px] text-ink3">{state.remedy}</small>
          </div>
        ) : null}

        {state && supported && enabled && state.url ? (
          <div className="flex flex-col gap-2 rounded-md border border-line1 bg-bg1 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-ink1">{state.url}</code>
              <Button size="sm" variant="neutral" icon="copy" onClick={copy}>
                {copied ? (zh() ? '已复制' : 'Copied') : (zh() ? '复制' : 'Copy')}
              </Button>
            </div>
            <small className="text-[12px] leading-relaxed text-ink2">{state.audience}</small>
          </div>
        ) : null}

        {state && supported && !enabled ? (
          <small className="text-[12px] text-ink3">{state.remedy}</small>
        ) : null}

        {failure ? (
          <FailureCallout
            title={failure.title}
            detail={failure.detail}
            onRetry={() => { void load(); }}
            retryLabel={zh() ? '再检查一次' : 'Check again'}
            onDismiss={() => setFailure(null)}
          />
        ) : null}
      </Card>
    </section>
  );
}
