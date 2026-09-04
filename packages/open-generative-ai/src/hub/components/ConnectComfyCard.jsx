// Connect ComfyUI — the card that makes the local engine optional.
//
// The studio used to refuse to come up at all until an external ComfyUI
// answered on :8188. It now boots on its own and ComfyUI is an engine you
// attach, exactly like a rented machine. This is the attach surface: what is
// already answering, what is on this disk, an address to paste, and — when
// there is nothing — where to get one.
//
// Three rules the card keeps, because they are the reason the item was opened:
//
//  * It NEVER modifies a ComfyUI the app did not create. No symlinking custom
//    nodes into somebody's install, no writes of any kind. Detection is a
//    directory listing and one HTTP GET, and the card says so out loud.
//  * There is no installer. v1 links to ComfyUI's own instructions.
//  * A refusal always carries its fix. "Nothing is serving ComfyUI there"
//    arrives with the address it tried and the button that tries again.
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/icons.jsx';
import { Button, Card, FailureCallout, Field, Pill, SectionLabel, Spinner, TextInput } from '../../ui/kit.jsx';
import { zh } from '../../lib/i18n.js';
import {
  connectComfy, disconnectComfy, fetchComfyConnection, useComfyConnection,
} from '../../lib/comfyConnection.js';

const t = (en, cn) => (zh() ? cn : en);

function LaneRow({ lane, onDetach, busy }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-ink1">{lane.label}</span>
          <Pill tone={lane.reachable ? 'ok' : 'neutral'} dot>
            {lane.reachable ? t('Answering', '已连接') : t('Not connected', '未连接')}
          </Pill>
          {lane.attached ? <Pill tone="honey">{t('Attached', '已附加')}</Pill> : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-ink3">{lane.url}</div>
      </div>
      {lane.attached ? (
        <Button size="sm" variant="neutral" disabled={busy} onClick={() => onDetach(lane.id)}>
          {t('Detach', '断开')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.state Optional pre-read connection state; the card
 *   fetches its own when this is omitted. Passed in by tests and by callers
 *   that already hold the answer.
 * @param {boolean} props.enabled False while the page is mounted but not shown,
 *   so a hidden hub page costs no probe.
 */
export function ConnectComfyCard({ state = null, enabled = true, className = '' }) {
  const fetched = useComfyConnection(!state && enabled);
  const connection = state || fetched;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  // Pre-fill with the first thing that is actually answering: on a machine
  // where ComfyUI Desktop is already open this turns Connect into one press.
  useEffect(() => {
    const first = connection.running?.[0]?.url;
    if (first && !url) setUrl(first);
  }, [connection.running, url]);

  const attach = useCallback(async (candidate) => {
    const target = String(candidate || url || '').trim();
    setBusy(true);
    setError('');
    setNote('');
    try {
      await connectComfy(target);
      setNote(t(`Connected to ${target}. Local models are available again.`, `已连接 ${target}。`));
    } catch (failure) {
      setError(String(failure?.message || t('Could not connect to that address.', '无法连接该地址。')));
    } finally {
      setBusy(false);
    }
  }, [url]);

  const detach = useCallback(async (lane) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await disconnectComfy(lane);
    } finally {
      setBusy(false);
    }
  }, []);

  const lanes = connection.lanes || [];
  const detected = connection.detected || [];
  const running = connection.running || [];

  return (
    <Card className={`flex flex-col gap-3 p-4 ${className}`} data-testid="connect-comfy">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-ink1">
            <Icon name="cpu" size={16} />
            {t('Connect ComfyUI', '连接 ComfyUI')}
          </div>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink3">
            {t(
              'ComfyUI is optional. Cloud and rented models work without it; connect one to use the local lanes. This studio only reads — it never changes a ComfyUI you installed yourself.',
              'ComfyUI 是可选的。云端与租用模型无需它；连接后可使用本地通道。本工作室只读取，绝不修改你自己安装的 ComfyUI。',
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="neutral"
          icon="refresh"
          disabled={busy}
          onClick={() => { void fetchComfyConnection({ force: true }); }}
        >
          {t('Check again', '重新检查')}
        </Button>
      </div>

      {error ? (
        <FailureCallout
          title={t('That address did not answer', '该地址没有响应')}
          detail={error}
          onRetry={() => { void attach(); }}
          retryLabel={t('Try again', '重试')}
          retryDisabled={busy}
        />
      ) : null}
      {note ? <div className="rounded-md border border-ok/40 bg-ok-tint px-3 py-2 text-[12px] text-ok">{note}</div> : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>{t('Lanes', '通道')}</SectionLabel>
        {lanes.length
          ? lanes.map((lane) => <LaneRow key={lane.id} lane={lane} onDetach={detach} busy={busy} />)
          : (
            <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2 text-[12px] text-ink3">
              <Spinner size={14} className="text-honey" />
              {t('Looking at this machine…', '正在检查这台机器…')}
            </div>
          )}
      </div>

      {running.length ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>{t('Answering right now', '正在响应')}</SectionLabel>
          {running.map((entry) => (
            <div key={entry.url} className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3 py-2">
              <span className="truncate font-mono text-[11px] text-ink2">{entry.url}</span>
              <Button size="sm" disabled={busy} onClick={() => { void attach(entry.url); }}>
                {t('Use this one', '使用它')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Field
        label={t('Or paste the address', '或粘贴地址')}
        hint={t(
          'The address in ComfyUI’s own window — usually http://127.0.0.1:8188, or http://127.0.0.1:8000 for ComfyUI Desktop.',
          'ComfyUI 窗口中的地址——通常是 http://127.0.0.1:8188，ComfyUI Desktop 为 http://127.0.0.1:8000。',
        )}
      >
        <div className="flex items-center gap-2">
          <TextInput
            value={url}
            placeholder="http://127.0.0.1:8188"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && url.trim()) { void attach(); } }}
          />
          <Button size="sm" icon="plug" disabled={busy || !url.trim()} loading={busy} onClick={() => { void attach(); }}>
            {t('Connect', '连接')}
          </Button>
        </div>
      </Field>

      {detected.length ? (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t('Found on this machine', '本机已找到')}</SectionLabel>
          {detected.map((entry) => (
            <div key={entry.path} className="rounded-md border border-line1 bg-bg2 px-3 py-2">
              <div className="text-[12px] font-medium text-ink2">{entry.label}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-ink3">{entry.detail}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] leading-relaxed text-ink3">
          {t('No ComfyUI found on this machine. ', '本机未找到 ComfyUI。')}
          <a
            className="text-honey underline underline-offset-2"
            href={connection.installUrl || 'https://docs.comfy.org/installation/comfyui_desktop/macos'}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('How to install it', '安装方法')}
          </a>
          {t(' — then come back and connect it here.', '——安装后回到这里连接。')}
        </p>
      )}
    </Card>
  );
}

/**
 * The one-line version for a studio's local section: the sentence and the
 * button, nothing else. Pressing it opens the card on the Machines page.
 */
export function connectComfySentence() {
  return t('ComfyUI is not connected.', '尚未连接 ComfyUI。');
}
