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
import {
  connectComfy, disconnectComfy, fetchComfyConnection, useComfyConnection,
} from '../../lib/comfyConnection.js';
import { t, tf } from '../../lib/i18n.js';

function LaneRow({ lane, onDetach, busy }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-ink1">{lane.label}</span>
          <Pill tone={lane.reachable ? 'ok' : 'neutral'} dot>
            {lane.reachable ? t('setup.comfyAnswering') : t('setup.comfyNotAnswering')}
          </Pill>
          {lane.attached ? <Pill tone="honey">{t('setup.comfyAttached')}</Pill> : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-ink3">{lane.url}</div>
      </div>
      {lane.attached ? (
        <Button size="sm" variant="neutral" disabled={busy} onClick={() => onDetach(lane.id)}>
          {t('common.detach')}
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
      setNote(tf('setup.comfyConnected', target));
    } catch (failure) {
      setError(String(failure?.message || t('setup.comfyRefused')));
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
            {t('common.connectComfy')}
          </div>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink3">
            {t('setup.comfyBlurb')}
          </p>
        </div>
        <Button
          size="sm"
          variant="neutral"
          icon="refresh"
          disabled={busy}
          onClick={() => { void fetchComfyConnection({ force: true }); }}
        >
          {t('common.checkAgain')}
        </Button>
      </div>

      {error ? (
        <FailureCallout
          title={t('setup.comfyNoAnswer')}
          detail={error}
          onRetry={() => { void attach(); }}
          retryLabel={t('common.tryAgain')}
          retryDisabled={busy}
        />
      ) : null}
      {note ? <div className="rounded-md border border-ok/40 bg-ok-tint px-3 py-2 text-[12px] text-ok">{note}</div> : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>{t('setup.comfyLanes')}</SectionLabel>
        {lanes.length
          ? lanes.map((lane) => <LaneRow key={lane.id} lane={lane} onDetach={detach} busy={busy} />)
          : (
            <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-2 text-[12px] text-ink3">
              <Spinner size={14} className="text-honey" />
              {t('setup.comfyLooking')}
            </div>
          )}
      </div>

      {running.length ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>{t('setup.comfyAnsweringNow')}</SectionLabel>
          {running.map((entry) => (
            <div key={entry.url} className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3 py-2">
              <span className="truncate font-mono text-[11px] text-ink2">{entry.url}</span>
              <Button size="sm" disabled={busy} onClick={() => { void attach(entry.url); }}>
                {t('setup.comfyUseThis')}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Field
        label={t('setup.comfyPasteAddress')}
        hint={t('setup.comfyAddressHint')}
      >
        <div className="flex items-center gap-2">
          <TextInput
            value={url}
            placeholder="http://127.0.0.1:8188"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && url.trim()) { void attach(); } }}
          />
          <Button size="sm" icon="plug" disabled={busy || !url.trim()} loading={busy} onClick={() => { void attach(); }}>
            {t('common.connect')}
          </Button>
        </div>
      </Field>

      {detected.length ? (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t('setup.comfyFoundHere')}</SectionLabel>
          {detected.map((entry) => (
            <div key={entry.path} className="rounded-md border border-line1 bg-bg2 px-3 py-2">
              <div className="text-[12px] font-medium text-ink2">{entry.label}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-ink3">{entry.detail}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] leading-relaxed text-ink3">
          {t('setup.comfyNoneFound')}
          <a
            className="text-honey underline underline-offset-2"
            href={connection.installUrl || 'https://docs.comfy.org/installation/comfyui_desktop/macos'}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('setup.comfyHowToInstall')}
          </a>
          {t('setup.comfyThenComeBack')}
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
  return t('setup.comfyNotConnected');
}
