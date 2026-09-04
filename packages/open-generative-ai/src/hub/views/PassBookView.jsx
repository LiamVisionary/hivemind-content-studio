// PassBook — the machine's shared credential store, and who reads it.
//
// This is the first-run screen for a machine that has no HivemindOS. The store
// is shared with every other app that speaks PassBook, so a key pasted here
// works in all of them; that is the whole reason it is a machine-level surface
// and not a per-app setting.
//
// Three things it never does: show a value, offer a key this studio does not
// use, or replace a key another app may be relying on without being asked. The
// API enforces all three; the UI is written so they are also obvious.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MUAPI_CREDENTIAL } from '../../lib/muapiKey.js';
import { muapi } from '../../lib/muapi.js';
import { refreshMuapiKeyLocation } from '../../lib/providerReadiness.js';
import { Button, Card, Field, Pill, SectionLabel, Spinner, TextInput } from '../../ui/kit.jsx';
import { api } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { t, tf } from '../../lib/i18n.js';

function relative(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

function CredentialRow({ row, value, onChange, onSave, busy }) {
    const [editing, setEditing] = useState(false);
    const configured = row.configured;
    // A configured key is never shown, only replaced — there is no read-back
    // path for a value anywhere in this product, including for its owner.
    return (
        <Card className="flex flex-col gap-2 p-3.5">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <p className="truncate font-mono text-xs font-semibold text-ink1">{row.key}</p>
                    <p className="mt-0.5 truncate text-[11px] text-ink3">{row.label}</p>
                </div>
                <Pill tone={configured ? 'ok' : 'neutral'} dot>
                    {configured ? t('passbook.stored') : t('passbook.notSet')}
                </Pill>
            </div>
            {configured && !editing ? (
                <button
                    type="button"
                    className="self-start text-[11px] text-honey underline-offset-2 hover:underline"
                    onClick={() => setEditing(true)}
                >
                    {t('passbook.replaceKey')}
                </button>
            ) : (
                <div className="flex items-end gap-2">
                    <Field className="flex-1" label={t('passbook.key')}>
                        <TextInput
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={t('providers.pasteTheKey')}
                            value={value || ''}
                            onChange={(event) => onChange(row.key, event.target.value)}
                        />
                    </Field>
                    <Button
                        variant="primary"
                        disabled={busy || !String(value || '').trim()}
                        onClick={() => onSave(row.key, Boolean(configured)).then(() => setEditing(false))}
                    >
                        {configured ? t('passbook.replace') : t('common.save')}
                    </Button>
                </div>
            )}
        </Card>
    );
}

const MODE_COPY = () => ({
    always: { label: t('passbook.modeAlways'), hint: t('passbook.modeAlwaysHint') },
    ask: { label: t('passbook.modeAsk'), hint: t('passbook.modeAskHint') },
    window: { label: t('passbook.modeWindow'), hint: t('passbook.modeWindowHint') },
    never: { label: t('passbook.modeNever'), hint: t('passbook.modeNeverHint') },
});

/**
 * A panel whose own read FAILED, told apart from a component that is absent.
 *
 * `/api/passbook/policy`, `/links`, `/broker` and `/access` are each caught into
 * `null`, and a null used to render as "Not installed." / "Machine linking is
 * not set up." — an outage reported as a design decision. A failed read says so
 * and carries the retry; an absent component says there is nothing to fix.
 */
function PanelUnreadable({ busy, onRetry }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink2">{t('passbook.panelUnreadable')}</p>
            <Button size="sm" disabled={busy} onClick={onRetry}>{t('common.tryAgain')}</Button>
        </div>
    );
}

/** An absent optional component, and whether that matters (it does not). */
function PanelAbsent({ detail, fallback }) {
    return (
        <>
            <p className="text-xs text-ink3">{detail || fallback}</p>
            {detail ? null : <p className="text-[11px] text-ink3">{t('passbook.optionalPart')}</p>}
        </>
    );
}

function Pending({ pending, busy, onResolve }) {
    // The request is waiting on this panel, so it leads. Anything below it is
    // configuration; this is someone standing at the door.
    if (!pending?.length) return null;
    return (
        <Card className="flex flex-col gap-3 border-honey/40 p-4">
            <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-ink1">
                    {tf('passbook.requestsWaiting', pending.length)}
                </h4>
            </div>
            {pending.map((item) => (
                <div key={item.id} className="flex flex-col gap-2 border-b border-line1 pb-3 last:border-0 last:pb-0">
                    <p className="text-xs text-ink1">
                        <span className="font-semibold">{item.app}</span>{' '}
                        {t('passbook.wants')} <span className="font-mono text-[11px]">{(item.keys || []).join(', ')}</span>
                    </p>
                    {item.reason ? <p className="text-[11px] text-ink3">{item.reason}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" disabled={busy} onClick={() => onResolve(item.id, true, '')}>
                            {t('passbook.justThisOnce')}
                        </Button>
                        <Button disabled={busy} onClick={() => onResolve(item.id, true, '1h')}>
                            {t('passbook.approveFor1h')}
                        </Button>
                        <Button disabled={busy} onClick={() => onResolve(item.id, false, '')}>
                            {t('passbook.decline')}
                        </Button>
                    </div>
                </div>
            ))}
        </Card>
    );
}

function Unlocks({ access, busy, onUnlock, onLock }) {
    // No `MODE_COPY()` here any more: this card used to end with a bare
    // `copy.ask.hint` — "the request waits until you answer" — a lowercase,
    // subjectless line about a control that lives in a different card further
    // down the page. It reads there, beside the "Ask me" button it describes.
    const open = access?.sessions || [];
    return (
        <Card className="flex flex-col gap-3 p-4">
            {open.length ? (
                <>
                    {open.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3">
                            <p className="text-xs text-ink1">
                                {(item.keys || []).length
                                    ? <span className="font-mono text-[11px]">{item.keys.join(', ')}</span>
                                    : t('passbook.everyKey')}
                                {item.app ? ` · ${item.app}` : ''}
                            </p>
                            <Pill tone="honey" dot>
                                {tf('passbook.minutesLeft', Math.round(item.remaining_seconds / 60))}
                            </Pill>
                        </div>
                    ))}
                    <Button className="self-start" disabled={busy} onClick={onLock}>
                        {t('passbook.closeNow')}
                    </Button>
                </>
            ) : (
                <>
                    <p className="text-xs text-ink2">
                        {t('passbook.stopBeingAskedBlurb')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {(access?.presets || ['15m', '1h', '4h']).map((preset) => (
                            <Button key={preset} disabled={busy} onClick={() => onUnlock(preset)}>{preset}</Button>
                        ))}
                    </div>
                    <p className="text-[11px] leading-relaxed text-ink3">
                        {t('passbook.whileOpenBlurb')}
                    </p>
                </>
            )}
        </Card>
    );
}

function AccessModes({ access, keys, busy, onSetMode, onRetry }) {
    const copy = MODE_COPY();
    // This panel governs THIS app's access to the shared store, so the app is
    // fixed rather than picked: PassBook's own UI is where another app's rules
    // are edited, and a picker here would offer to change a rule this studio
    // cannot then show the effect of.
    const app = 'hivemind-content-studio';
    if (!access) return <PanelUnreadable busy={busy} onRetry={onRetry} />;
    if (!access.available) {
        return <PanelAbsent detail={access.detail} fallback={t('passbook.notInstalled')} />;
    }
    const entry = (access.apps || {})[app] || {};
    const rules = entry.keys || {};
    const fallback = (entry.default || {}).mode || access.default_mode;
    return (
        <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink2">
                    {t('passbook.app')} <span className="font-mono text-[11px] text-ink1">{app}</span>
                </p>
                <Pill>{tf('passbook.defaultMode', fallback)}</Pill>
            </div>
            {(keys || []).map((key) => {
                const mode = (rules[key] || {}).mode || fallback;
                return (
                    <div key={key} className="flex flex-col gap-1.5 border-b border-line1 pb-2.5 last:border-0 last:pb-0">
                        <p className="font-mono text-[11px] text-ink1">{key}</p>
                        <div className="flex flex-wrap gap-1.5">
                            {(access.modes || []).filter((m) => m !== 'window').map((m) => (
                                <Button
                                    key={m}
                                    variant={mode === m ? 'primary' : undefined}
                                    disabled={busy}
                                    onClick={() => onSetMode({ app, key, mode: m })}
                                >
                                    {copy[m]?.label || m}
                                </Button>
                            ))}
                        </div>
                        <p className="text-[11px] text-ink3">{copy[mode]?.hint || ''}</p>
                    </div>
                );
            })}
            {!(keys || []).length ? (
                <p className="text-xs text-ink3">{t('passbook.noStoredKeys')}</p>
            ) : null}
        </Card>
    );
}

function Broker({ broker, busy, onRetry }) {
    // The limits ship with the status and are rendered, not summarised. This is
    // the one panel where an encouraging word would teach the owner something
    // false — "protected" here would mean "recorded", and they are not the same.
    if (!broker) return <PanelUnreadable busy={busy} onRetry={onRetry} />;
    if (!broker.available) {
        return <PanelAbsent detail={broker.detail} fallback={t('passbook.notInstalled')} />;
    }
    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink2">
                    {broker.running
                        ? tf('passbook.brokerRunning', broker.mode)
                        : t('passbook.brokerStopped')}
                </p>
                <Pill tone={broker.running ? 'ok' : 'warn'} dot>
                    {broker.running ? t('passbook.running') : t('passbook.stopped')}
                </Pill>
            </div>
            {!broker.running ? (
                <p className="text-[11px] text-ink3">
                    {`${t('passbook.startItWith')} `}<span className="font-mono">passbook broker start</span>
                </p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-ink3">{broker.limits}</p>
        </>
    );
}

function LinkedMachines({ links, busy, onRevoke, onRetry }) {
    // Read plus revoke only. Approving and accepting need a fingerprint compared
    // against a second machine's screen, and a button here could not do that —
    // one that looked like it could would be worse than no button at all.
    if (!links) return <PanelUnreadable busy={busy} onRetry={onRetry} />;
    if (!links.available) {
        return <PanelAbsent detail={links.detail} fallback={t('passbook.linkingNotSetUp')} />;
    }
    const rows = [
        ...(links.lent || []).map((row) => ({ ...row, lent: true })),
        ...(links.borrowed || []).map((row) => ({ ...row, lent: false })),
    ];
    return (
        <>
            <p className="text-[11px] text-ink3">
                {t('passbook.thisFingerprint')}{' '}
                <span className="font-mono text-ink2">{links.fingerprint}</span>
            </p>
            {rows.length === 0 ? (
                <p className="text-xs text-ink3">
                    {t('passbook.noLinkedMachines')}
                </p>
            ) : rows.map((row) => (
                <div key={`${row.role}-${row.did}`} className="flex flex-col gap-1 border-b border-line1 py-2 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-ink1">
                            {row.lent ? t('passbook.lentTo') : t('passbook.borrowedFrom')}{' '}
                            <span className="font-mono text-[11px] text-ink2">{row.fingerprint || row.did}</span>
                        </span>
                        <Pill tone={row.active ? 'ok' : row.revoked ? 'neutral' : 'warn'} dot>
                            {row.active ? t('common.active') : row.revoked ? t('passbook.linkRevoked') : t('passbook.linkExpired')}
                        </Pill>
                    </div>
                    <p className="font-mono text-[11px] text-ink3">{(row.keys || []).join(', ') || '—'}</p>
                    {row.lent && row.active ? (
                        <Button className="self-start" disabled={busy} onClick={() => onRevoke(row.did)}>
                            {t('passbook.revoke')}
                        </Button>
                    ) : null}
                </div>
            ))}
        </>
    );
}

export function PassBookView({ active = true }) {
    const [state, setState] = useState(null);
    const [ledger, setLedger] = useState(null);
    const [links, setLinks] = useState(null);
    const [broker, setBroker] = useState(null);
    const [access, setAccess] = useState(null);
    const [drafts, setDrafts] = useState({});
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    // True after a load that could not read the store: the page then offers a
    // way back in instead of spinning forever.
    const [failed, setFailed] = useState(false);
    const loadedRef = useRef(false);

    const load = useCallback(async () => {
        const [store, record, linked, brokered, rules] = await Promise.all([
            api('/api/passbook').catch(() => null),
            api('/api/passbook/access?limit=40').catch(() => null),
            api('/api/passbook/links').catch(() => null),
            api('/api/passbook/broker').catch(() => null),
            api('/api/passbook/policy').catch(() => null),
        ]);
        setState(store);
        setFailed(!store);
        setLedger(record);
        setLinks(linked);
        setBroker(brokered);
        setAccess(rules);
    }, []);

    // Every hub page stays mounted from the first hub navigation, so the five
    // requests wait for the page to actually be opened (same gate ModelsView
    // uses) — opening History must not read the credential store.
    useEffect(() => {
        if (!active || loadedRef.current) return;
        loadedRef.current = true;
        void load();
    }, [active, load]);

    // The topbar Refresh re-reads a page that has been opened at least once.
    useEffect(() => {
        const onRefresh = () => { if (loadedRef.current) void load(); };
        window.addEventListener('hivemind-hub-refresh', onRefresh);
        return () => window.removeEventListener('hivemind-hub-refresh', onRefresh);
    }, [load]);

    const save = async (key, replacing) => {
        const value = String(drafts[key] || '').trim();
        if (!value) return;
        setBusy(true);
        setNotice('');
        try {
            const result = await api('/api/passbook', {
                method: 'POST',
                body: JSON.stringify({ values: { [key]: value }, overwrite: replacing }),
            });
            setDrafts((current) => ({ ...current, [key]: '' }));
            // Say what actually happened. "kept" means another app's value was
            // already there and this did nothing — silence would read as success.
            setNotice(result.added?.length
                ? tf('passbook.keySaved', key)
                : result.updated?.length
                    ? tf('passbook.keyReplaced', key)
                    : tf('passbook.keyUnchanged', key));
            if (key === MUAPI_CREDENTIAL) {
                // The studios' client cached "no server key" at boot; forget it, or
                // the next Generate still asks this browser for a key it no longer needs.
                muapi.resetRoute();
                void refreshMuapiKeyLocation();
            }
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || error?.message || t('passbook.saveFailed'));
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (did) => {
        setBusy(true);
        setNotice('');
        try {
            const result = await api('/api/passbook/links/revoke', {
                method: 'POST',
                body: JSON.stringify({ did }),
            });
            // Never say only "revoked". Revoking stops the next envelope; the
            // delivered values are still live until they are rotated, and a
            // message that omitted that would be actively misleading.
            setNotice(result.rotate?.length
                ? tf('passbook.revokedRotate', result.rotate.join(', '))
                : t('passbook.revoked'));
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || t('passbook.revokeFailed'));
        } finally {
            setBusy(false);
        }
    };

    const act = async (path, body, describe) => {
        setBusy(true);
        setNotice('');
        try {
            const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
            setNotice(describe(result));
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || error?.message || t('passbook.actionFailed'));
        } finally {
            setBusy(false);
        }
    };

    const setMode = ({ app, key, mode }) => act('/api/passbook/policy/mode', { app, key, mode },
        () => tf('passbook.modeSet', key, mode, app));

    const unlock = (duration) => act('/api/passbook/policy/unlock', { duration },
        () => tf('passbook.unlockedFor', duration));

    const lock = () => act('/api/passbook/policy/lock', {},
        () => t('passbook.closed'));

    const resolve = (id, approve, remember) => act('/api/passbook/policy/resolve',
        { id, approve, remember },
        (result) => (approve
            ? tf('passbook.approved', remember, result.approved_by?.startsWith('passkey'))
            : t('passbook.declined')));

    const seal = async () => {
        setBusy(true);
        setNotice('');
        try {
            const result = await api('/api/passbook/seal', { method: 'POST' });
            setNotice(result.detail || t('passbook.encryptedAtRest'));
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || t('passbook.encryptFailed'));
        } finally {
            setBusy(false);
        }
    };

    const sealing = state?.sealing || {};
    const stored = (state?.settable || []).filter((row) => row.configured).length;

    // Every hub page stays MOUNTED and is display-toggled, so a view that does
    // not hide itself is painted on top of whichever page is actually open —
    // this one had no `active` prop at all and rendered its whole panel over
    // Machines, Providers, History and the rest. Same wrapper every other hub
    // view uses; the difference was never deliberate. The loading and
    // container branches live INSIDE it for the same reason: an early return
    // above the gate painted a spinner strip under every other hub page.
    return (
        <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <HubToolbar
                kicker={t('passbook.kicker')}
                title={t('nav.passbook')}
                right={<Button onClick={() => void load()} disabled={busy}>{t('app.refresh')}</Button>}
            />
            {/* The page scrolls INSIDE the view, the way every other hub
                page does. Without this the root was a plain `flex flex-col`
                with no `min-h-0 flex-1` and no scroll container, so anything
                past the fold was simply unreachable. */}
            <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 md:p-5">
                {!state ? (
                    failed ? (
                        <div className="flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger-tint px-4 py-3">
                            <p className="text-xs text-ink1">
                                {t('passbook.storeUnreadable')}
                            </p>
                            <Button size="sm" onClick={() => void load()}>{t('common.tryAgain')}</Button>
                        </div>
                    ) : (
                        <div className="flex h-40 items-center justify-center">
                            <Spinner />
                        </div>
                    )
                ) : state.home_is_container ? (
                    // A build that cannot reach the real home has a packaging
                    // problem, not a credential problem. Saying so here is the
                    // difference between a five-minute fix and a week of "why
                    // are all my keys missing".
                    <Card className="flex flex-col gap-2 border-danger/40 p-4">
                        <h4 className="text-sm font-semibold text-ink1">
                            {t('passbook.containerHome')}
                        </h4>
                        <p className="text-xs leading-relaxed text-ink2">{state.detail}</p>
                        <p className="text-xs leading-relaxed text-ink3">
                            {t('passbook.containerHomeFix')}
                        </p>
                    </Card>
                ) : (
                    <>
                        <Card className="flex flex-col gap-2 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                                <Pill>{tf('passbook.storedCount', stored)}</Pill>
                                <Pill>{tf('passbook.workspaceName', state.workspace || 'main')}</Pill>
                                {(state.apps || []).map((app) => <Pill key={app}>{app}</Pill>)}
                            </div>
                            <p className="text-xs leading-relaxed text-ink2">
                                {t('passbook.oneStoreBlurb')}
                            </p>
                            <p className="font-mono text-[10px] text-ink3">{state.path}</p>
                            {state.writes_to && state.writes_to !== state.path ? (
                                <p className="text-[11px] text-ink3">
                                    {`${t('passbook.newKeysWrittenTo')} `}
                                    <span className="font-mono">{state.writes_to}</span>
                                </p>
                            ) : null}
                        </Card>

                        <div>
                            <SectionLabel>{t('passbook.keysThisStudioUses')}</SectionLabel>
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                                {(state.settable || []).map((row) => (
                                    <CredentialRow
                                        key={row.key}
                                        row={row}
                                        value={drafts[row.key]}
                                        busy={busy}
                                        onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                                        onSave={save}
                                    />
                                ))}
                            </div>
                            {notice ? <p className="mt-2 text-xs text-ink2">{notice}</p> : null}
                        </div>

                        <div>
                            <SectionLabel>{t('passbook.encryptionAtRest')}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-xs text-ink2">{sealing.detail}</p>
                                    <Pill tone={sealing.fully_sealed ? 'ok' : 'warn'} dot>
                                        {sealing.fully_sealed ? t('passbook.encrypted') : t('passbook.plaintext')}
                                    </Pill>
                                </div>
                                <p className="text-[11px] leading-relaxed text-ink3">
                                    {t('passbook.atRestBlurb')}
                                </p>
                                {sealing.supported && !sealing.fully_sealed ? (
                                    <Button variant="primary" className="self-start" disabled={busy} onClick={seal}>
                                        {t('passbook.encryptTheStore')}
                                    </Button>
                                ) : null}
                                {!sealing.supported ? (
                                    <p className="text-[11px] text-ink3">{sealing.keystore || sealing.detail}</p>
                                ) : null}
                            </Card>
                        </div>

                        <Pending pending={access?.pending} busy={busy} onResolve={resolve} />

                        <div>
                            <SectionLabel>{t('passbook.stopBeingAsked')}</SectionLabel>
                            <div className="mt-2">
                                <Unlocks access={access} busy={busy} onUnlock={unlock} onLock={lock} />
                            </div>
                        </div>

                        <div>
                            <SectionLabel>{t('passbook.howEachKeyAnswered')}</SectionLabel>
                            <div className="mt-2">
                                <AccessModes access={access} keys={state.keys} busy={busy} onSetMode={setMode} onRetry={() => void load()} />
                            </div>
                        </div>

                        <div>
                            <SectionLabel>{t('passbook.linkedMachines')}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <LinkedMachines links={links} busy={busy} onRevoke={revoke} onRetry={() => void load()} />
                            </Card>
                        </div>

                        <div>
                            <SectionLabel>{t('passbook.readBroker')}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <Broker broker={broker} busy={busy} onRetry={() => void load()} />
                            </Card>
                        </div>

                        <div>
                            <SectionLabel>{t('passbook.accessRecord')}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                {ledger?.available ? (
                                    <>
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="text-xs text-ink2">{ledger.detail}</p>
                                            <Pill tone={ledger.intact ? 'ok' : 'danger'} dot>
                                                {ledger.intact ? t('passbook.unaltered') : t('passbook.altered')}
                                            </Pill>
                                        </div>
                                        <div className="max-h-64 overflow-y-auto">
                                            {(ledger.rows || []).slice().reverse().map((row) => (
                                                <div
                                                    key={row.proofHash || `${row.at}-${row.keyCount}`}
                                                    className="flex items-baseline justify-between gap-3 border-b border-line1 py-1.5 last:border-0"
                                                >
                                                    <span className="truncate font-mono text-[11px] text-ink2">
                                                        {(row.keys || []).join(', ') || '—'}
                                                    </span>
                                                    <span className="shrink-0 text-[10px] text-ink3">
                                                        {row.app} · {relative(row.at)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    ledger
                                        ? <PanelAbsent detail={ledger.detail} fallback={t('passbook.noAccessRecord')} />
                                        : <PanelUnreadable busy={busy} onRetry={() => void load()} />
                                )}
                            </Card>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
