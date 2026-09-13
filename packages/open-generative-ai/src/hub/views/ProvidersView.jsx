// Providers view — one board of names and dots, and a panel for the one being
// looked at.
//
// The board used to be 27 cards, each carrying its own sentence, env-var name,
// role chips, mode and cost. Reading twenty-five of those at once was the
// complaint, and no card was ever the one being read. So the board answers only
// "what is here, and is it ready" — a name and a dot — and everything else
// (the sentence, the fix, the key field, the metadata) moves into a single
// detail panel for the selected row.
//
// The two OAuth accounts are rows on that same board rather than a separate
// section above it. They are the only rows not built from the catalog: OAuth
// stays inside HivemindOS, so this surface receives status only and can kick
// off the connect flow (startOAuth). While this view is showing, hubData
// re-reads /api/oauth on every poll tick, so a sign-in finished in another tab
// lands here by itself.
//
// Two things the board is careful about, both of which the payload will let you
// get wrong:
//  - `provider.keys` is NOT the set of credentials this studio may write.
//    OPENAI_BASE_URL, UNIVERSAL_TTS_URL and ACE_STEP_API_BASE_URL are declared
//    keys that POST /api/passbook refuses, so a field rendered straight off
//    `keys` is a field that cannot be saved. The allow-list is asked for.
//  - `provider.fallback` is a written declaration, not a provider id. Seven of
//    the twenty-five name something that is not a row here ("local providers",
//    "ffmpeg", "edge-tts"), so it is printed and never looked up.
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Button, EmptyState, Field, Pill, SectionLabel, TextInput } from '../../ui/kit.jsx';
import { api, providerLabel, refreshAll, startOAuth, useHub } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { toastFailure } from '../../ui/failureToast.jsx';
import { t, tf } from '../../lib/i18n.js';

// The two accounts, and the field each one's readiness actually lives in. They
// are deliberately asymmetric: OpenAI reads `connected` and xAI reads `usable`,
// because a revoked xAI refresh token still reports itself connected and the
// studio only finds out at generation time.
const OAUTH_ACCOUNTS = [
  {
    id: 'openai-account',
    provider: 'openai',
    labelKey: 'providers.openai',
    noteKey: 'providers.openaiNote',
    isReady: (status) => Boolean(status?.connected),
    needsReconnect: () => false,
  },
  {
    id: 'xai-account',
    provider: 'xai',
    labelKey: 'providers.xai',
    noteKey: 'providers.xaiNote',
    isReady: (status) => Boolean(status?.usable),
    needsReconnect: (status) => Boolean(status?.needs_reconnect),
  },
];

// Four bands, not thirty-five. A header per capability turned the page into a
// stack of two-item lists; these group the roles that get chosen between in
// practice. `ids` is the order the rows read in — a provider the catalog grows
// later is not in it, so `roles` places that one instead, and anything matching
// neither still gets a home rather than disappearing off the board.
const BANDS = [
  {
    key: 'providers.groupAccounts',
    ids: OAUTH_ACCOUNTS.map((account) => account.id),
    roles: [],
  },
  {
    key: 'providers.groupPictureMotion',
    ids: [
      'stickman-renderer', 'static-text-renderer', 'comfyui', 'openai-gpt-image',
      'openai-gpt-image-oauth', 'xai-imagine-api', 'xai-imagine-oauth',
      'hivemindos-hosted-media', 'muapi', 'higgsfield-cloud', 'higgsfield-consumer',
      'media-studio-mcp',
    ],
    roles: [
      'image', 'keyframe', 'motion', 'video', 'image-to-video', 'image-editing',
      'video-editing', 'stickman', 'static-ad', 'ugc',
    ],
  },
  {
    key: 'providers.groupSoundStock',
    ids: ['universal-tts', 'elevenlabs', 'ace-step', 'pexels', 'pixabay'],
    roles: ['voice', 'line-voice', 'lip-sync-audio', 'lip-sync', 'music', 'stock-video', 'stock-image'],
  },
  {
    key: 'providers.groupPipeline',
    ids: [
      'agent-runtime', 'openai-compatible', 'auto-clipper', 'moneyprinterturbo',
      'palmier-pro', 'clueso-mcp', 'postiz', 'upload-post',
    ],
    roles: [
      'script', 'metadata', 'assembly', 'timeline', 'export', 'subtitles', 'faceless',
      'ingest', 'transcript', 'clip', 'rights', 'monetization', 'publish', 'schedule',
      'video-workflow', 'localization', 'documentation', 'analysis',
    ],
  },
  { key: 'providers.groupOther', ids: [], roles: [] },
];

const bandIndexFor = (row) => {
  const named = BANDS.findIndex((band) => band.ids.includes(row.id));
  if (named >= 0) return named;
  const byRole = BANDS.findIndex((band) => band.roles.some((role) => row.roles.includes(role)));
  return byRole >= 0 ? byRole : BANDS.length - 1;
};

/**
 * The OAuth accounts as board rows.
 *
 * The sentence is the server's own `detail` where there is one, and otherwise
 * the state said outright — an unread status says it is being read rather than
 * reporting "not connected", which is a verdict and not a waiting state.
 */
export function accountRows(oauth, statusKnown, offline) {
  return OAUTH_ACCOUNTS.map((account) => {
    const status = oauth[account.provider];
    const label = t(account.labelKey);
    const ready = statusKnown && account.isReady(status);
    const needsReconnect = statusKnown && account.needsReconnect(status);
    const sentence = status?.detail
      || (offline
        ? t('providers.statusUnavailable')
        : !statusKnown
          ? tf('providers.checkingSession', label)
          : ready
            ? t('providers.connectedSentence')
            : t('providers.notConnectedSentence'));
    return {
      id: account.id,
      kind: 'account',
      label: tf('providers.accountNamed', label),
      ready,
      // Three states, not two: no grant at all is "Not connected", a grant that
      // has gone stale is "Needs setup" — which is what its Reconnect button is
      // for, and calling that one "Not connected" contradicts the button.
      state: offline
        ? t('providers.offline')
        : !statusKnown
          ? t('providers.checking')
          : ready
            ? t('providers.connected')
            : needsReconnect
              ? t('providers.needsSetup')
              : t('common.notConnected'),
      // Everything not-ready is honey, including "still being read": the dot and
      // this line say the same thing, and the sentence says which it is.
      stateTone: ready ? 'text-ok' : 'text-honey',
      // One paragraph, the way the account reads: what the status is, and what a
      // connected one buys. Where the sign-in happens is only worth saying while
      // there is a sign-in left to finish.
      main: [sentence, t(account.noteKey), ready ? '' : t('providers.oauthBlurb')]
        .filter(Boolean)
        .join(' '),
      extra: '',
      keys: [],
      configured: [],
      roles: [],
      oauth: account.provider,
      needsReconnect,
    };
  });
}

/**
 * A catalog provider as a board row.
 *
 * `needs` is the humanized sentence the provider matrix writes ("Needs a MUAPI
 * key"); nine providers have no `detail` override and fall through to the raw
 * env-var prose, which is why the second line is whichever of detail/requirement
 * the first line did not already use. It is shown only while the row is not
 * ready — that is when it is the fix, and for a ready provider it is noise the
 * metadata block already covers.
 */
function routeRow(provider, settable) {
  const main = provider.needs || provider.detail || provider.requirement || '';
  const extra = [provider.detail, provider.requirement].find((line) => line && line !== main) || '';
  return {
    id: provider.id,
    kind: 'route',
    label: providerLabel(provider.id),
    ready: Boolean(provider.available),
    state: provider.available ? t('common.ready') : t('providers.needsSetup'),
    stateTone: provider.available ? 'text-ok' : 'text-honey',
    main,
    extra: provider.available ? '' : extra,
    keys: (provider.keys || []).filter((key) => settable.has(key)),
    // Which of those the store already holds. A row can be half-configured —
    // a Higgsfield id with no secret is not `available` — so "is this a
    // replacement" is a fact about the key, never about the provider.
    configured: (provider.keys || []).filter((key) => settable.get(key)),
    roles: provider.roles || [],
    // An id ending in -oauth is ready when a HivemindOS account is, so the
    // repair it needs is that account's sign-in and not a key.
    oauth: provider.id.endsWith('-oauth')
      ? (OAUTH_ACCOUNTS.find((account) => provider.id.startsWith(account.provider))?.provider || '')
      : '',
    needsReconnect: false,
    mode: provider.mode || '',
    cost: provider.cost || '',
    fallback: provider.fallback || '',
  };
}

/**
 * The keys a row is waiting for, set here rather than somewhere else.
 *
 * It writes through the same `/api/passbook` route the producer picker's own
 * key field uses, which applies the value to this process and forgets the
 * account cache. Every field the row declares is saved in one request, because
 * two of them (a Higgsfield id and its secret, an Upload-Post key and its
 * account name) are useless one at a time.
 *
 * Two things that route will do quietly if they are not asked for:
 *  - The write is ADDITIVE by default. A name the store already holds is
 *    returned in `kept` with its old value intact, and the answer is still a
 *    200 — so a button that says Replace has to send `overwrite`, and the
 *    notice has to read `added`/`updated`/`kept` rather than assume. A green
 *    "saved" over a rotated key the store discarded is the worst outcome this
 *    panel can produce: every generation then fails on a revoked credential
 *    that the board insists is fine.
 *  - `refreshAll` skips /api/catalog on a quiet tick, so the readiness dot
 *    only moves on a non-quiet one. It is called directly rather than through
 *    pollTick, which would hand back an in-flight quiet refresh and return
 *    without ever re-reading the catalog.
 */
function KeyForm({ row, onSaved }) {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const filled = row.keys.filter((key) => (values[key] || '').trim());
  // The button says what pressing it will do, before anything is typed —
  // so it reads from the store's state, not from the draft. The REQUEST's
  // flag is narrower: only the names actually being written decide it.
  const held = row.configured.length > 0;
  const replacing = filled.some((key) => row.configured.includes(key));
  const save = async () => {
    setBusy(true);
    try {
      const payload = Object.fromEntries(filled.map((key) => [key, values[key].trim()]));
      const result = await api('/api/passbook', {
        method: 'POST',
        body: JSON.stringify({ values: payload, overwrite: replacing }),
      });
      setValues({});
      const named = filled.join(' · ');
      // Say what actually happened. "kept" means the store already held that
      // name and this wrote nothing; silence would read as success.
      toast.success(result?.added?.length
        ? tf('passbook.keySaved', named)
        : result?.updated?.length
          ? tf('passbook.keyReplaced', named)
          : tf('passbook.keyUnchanged', named));
      // The catalog moves the dot; the allow-list moves Save to Replace. The
      // second is a separate read, and without it this row would offer to add
      // a name the store now holds and send the write that keeps the old one.
      onSaved?.();
      await refreshAll({ quiet: false });
    } catch (error) {
      // api() has already turned the refusal into a sentence.
      toastFailure(error, { operation: t('providers.savingTheKey') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {row.keys.map((key) => (
        // The env-var name is the field's own label — visible, never a tooltip
        // on its own, because it is what somebody pasting a key looks for.
        <Field key={key} label={<span className="font-mono text-[10.5px] text-ink3">{key}</span>}>
          <TextInput
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('providers.pasteTheKey')}
            value={values[key] || ''}
            onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
          />
        </Field>
      ))}
      <Button
        size="sm"
        variant="primary"
        className="self-start"
        loading={busy}
        disabled={busy || !filled.length}
        onClick={save}
      >
        {held ? t('common.replace') : t('common.save')}
      </Button>
    </div>
  );
}

function OAuthAction({ row, link }) {
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    await startOAuth(row.oauth);
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-3">
      {link ? (
        <p className="text-[12px] leading-relaxed text-ink2">
          {t('providers.signInBlocked')}{' '}
          <a href={link} target="_blank" rel="noopener noreferrer" className="font-medium text-honey underline-offset-2 hover:underline">
            {t('providers.openSignInHere')}
          </a>
        </p>
      ) : null}
      <Button size="sm" variant="primary" icon="external" className="self-start" loading={busy} onClick={connect}>
        {row.ready || row.needsReconnect ? t('providers.reconnect') : t('common.connect')}
      </Button>
    </div>
  );
}

// Everything about the one row being looked at. A row with no field to offer
// and no account to connect still gets its sentence and its metadata — the
// panel is never empty, because the board's dot is never the whole answer.
function DetailPanel({ row, link, onSaved }) {
  return (
    <aside className="flex min-h-0 flex-col gap-[18px] overflow-y-auto border-t border-line1 bg-bg1 px-6 py-7 lg:border-l lg:border-t-0">
      <div>
        <h3 className="text-base font-semibold leading-tight text-ink1">{row.label}</h3>
        <div className={`mt-1.5 text-xs font-medium ${row.stateTone}`}>{row.state}</div>
      </div>
      {row.main ? (
        <p className="break-words text-[13px] leading-relaxed text-ink2 [overflow-wrap:anywhere]">{row.main}</p>
      ) : null}
      {row.extra ? (
        <p className="break-words text-[11px] leading-relaxed text-ink3 [overflow-wrap:anywhere]">{row.extra}</p>
      ) : null}
      {row.keys.length ? <KeyForm key={row.id} row={row} onSaved={onSaved} /> : null}
      {row.oauth ? <OAuthAction key={row.id} row={row} link={link} /> : null}
      {row.kind === 'route' ? (
        <div className="flex flex-col gap-1.5 border-t border-line1 pt-4 font-mono text-[11px] leading-relaxed text-ink3">
          <div className="break-words [overflow-wrap:anywhere]">
            {[row.mode, row.cost, row.fallback ? tf('providers.fallsBackTo', row.fallback) : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
          {row.roles.length ? (
            <div className="break-words [overflow-wrap:anywhere]">{row.roles.join(' · ')}</div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

/** Every row the board draws: the two accounts, then the catalog's routes. */
export function boardRows({ providers, oauth, statusKnown, offline, settable }) {
  return [
    ...accountRows(oauth, statusKnown, offline),
    ...providers.map((provider) => routeRow(provider, settable)),
  ];
}

/**
 * Those rows filed into their bands, in the order they read in: the declared
 * ids first, then anything the catalog grew since, so a provider added later
 * lands at the end of its band instead of reordering the page. A band with
 * nothing in it does not draw a header.
 */
export function boardBands(rows) {
  const filed = BANDS.map(() => []);
  rows.forEach((row) => { filed[bandIndexFor(row)].push(row); });
  return BANDS.map((band, index) => ({
    key: band.key,
    items: [
      ...band.ids.map((id) => filed[index].find((row) => row.id === id)).filter(Boolean),
      ...filed[index].filter((row) => !band.ids.includes(row.id)),
    ],
  })).filter((band) => band.items.length);
}

export function ProvidersView({ active }) {
  const s = useHub();
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState('');
  // Which credential names this studio may write, and which of them the store
  // already holds — the same allow-list the PassBook page reads. Unknown until
  // it answers; an empty map just means no inline field, never a broken one,
  // and the requirement sentence is then the only instruction the row has.
  const [settable, setSettable] = useState(() => new Map());
  const [keyEpoch, setKeyEpoch] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void api('/api/passbook')
      .then((payload) => {
        if (live) setSettable(new Map((payload?.settable || []).map((entry) => [entry.key, Boolean(entry.configured)])));
      })
      .catch(() => { /* no allow-list means no inline field, which is fine */ });
    return () => { live = false; };
  }, [active, keyEpoch]);

  const oauth = s.oauth?.providers || {};
  const statusKnown = Boolean(s.oauth);
  const offline = !statusKnown && s.apiOnline === false;

  // A provider is listed once per role and BY REFERENCE, so muapi arrives seven
  // times; dedupe by id before anything counts them.
  const routes = useMemo(() => (s.catalog
    ? [...new Map(Object.values(s.catalog.providers_by_role).flat().map((provider) => [provider.id, provider])).values()]
    : []), [s.catalog]);

  const rows = useMemo(
    () => boardRows({ providers: routes, oauth, statusKnown, offline, settable }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.oauth, statusKnown, offline, routes, settable],
  );

  const bands = useMemo(() => boardBands(rows), [rows]);

  // The counters describe the dots on screen, so they count every row the board
  // draws — the two accounts included. One denominator, both numbers.
  const readyCount = rows.filter((row) => row.ready).length;
  const brokenCount = rows.length - readyCount;
  const current = rows.find((row) => row.id === selected) || rows[0] || null;

  const checkStatus = async () => {
    setChecking(true);
    // Not refreshOAuth: the board's dots are the catalog's readiness, and a
    // "Check status" that re-read only the two accounts would leave twenty-five
    // rows saying whatever they said a poll ago. A non-quiet tick re-probes both
    // and reports its own failure.
    try { await refreshAll({ quiet: false }); } finally { setChecking(false); }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar kicker={t('providers.kicker')} title={t('nav.providers')}>
        {s.apiOnline === false ? <Pill tone="warn" dot>{t('providers.offline')}</Pill> : null}
        <Button size="sm" icon="refresh" loading={checking} onClick={checkStatus}>
          {t('providers.checkStatus')}
        </Button>
      </HubToolbar>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(250px,320px)]">
        <div className="min-h-0 overflow-y-auto">
          <div className="w-full max-w-[860px] px-4 pb-12 pt-6 lg:px-8">
            <div className="mb-6 flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[12.5px] text-ink3">
              <span className="inline-flex items-center gap-[7px]">
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-ok" />
                {tf('providers.countReady', readyCount)}
              </span>
              <span className="inline-flex items-center gap-[7px]">
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-honey" />
                {tf('providers.countNeedSetup', brokenCount)}
              </span>
            </div>
            {bands.map((band) => (
              <section key={band.key} className="mb-[26px]">
                <SectionLabel className="mb-1.5">{t(band.key)}</SectionLabel>
                <div className="grid gap-x-5 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
                  {band.items.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setSelected(row.id)}
                      aria-pressed={row.id === current?.id}
                      className={`-ml-2 flex h-[30px] w-full items-center gap-[9px] rounded-md px-2 text-left text-[12.5px] transition-colors duration-150 ${
                        row.id === current?.id ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:text-ink1'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.ready ? 'bg-ok' : 'bg-honey'}`} />
                      <span className="min-w-0 truncate">{row.label}</span>
                      <span className="sr-only">{row.state}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {s.catalog && !routes.length ? (
              <EmptyState
                icon="plug"
                title={t('providers.noneAdvertised')}
                hint={t('providers.noneAdvertisedHint')}
              />
            ) : null}
          </div>
        </div>
        {current ? (
          <DetailPanel
            row={current}
            link={s.oauthLinks?.[current.oauth] || ''}
            onSaved={() => setKeyEpoch((epoch) => epoch + 1)}
          />
        ) : null}
      </div>
    </div>
  );
}
