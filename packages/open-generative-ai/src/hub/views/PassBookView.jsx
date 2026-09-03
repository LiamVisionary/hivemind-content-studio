// PassBook — the machine's shared credential store, and who reads it.
//
// This is the machine-level surface, not the first-run screen: a machine with no
// source shows the Setup state inside the studio it is already looking at
// (components/SetupState.jsx), and only arrives here when it wants the whole
// store. The store is shared with every other app that speaks PassBook, so a key
// pasted here works in all of them — which is why it is machine-level and not a
// per-app setting. A "key not set" remedy elsewhere links straight to the row it
// named (?page=passbook&key=NAME), rather than to this page in general.
//
// Three things it never does: show a value, offer a key this studio does not
// use, or replace a key another app may be relying on without being asked. The
// API enforces all three; the UI is written so they are also obvious.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLang } from '../../lib/i18n.js';
import { MUAPI_CREDENTIAL } from '../../lib/muapiKey.js';
import { muapi } from '../../lib/muapi.js';
import {
    PASSBOOK_FOCUS_EVENT, clearRequestedPassBookKey, requestedPassBookKey,
} from '../../lib/passbookLink.js';
import { refreshMuapiKeyLocation } from '../../lib/providerReadiness.js';
import { Button, Card, Field, Pill, SectionLabel, Spinner, TextInput } from '../../ui/kit.jsx';
import { api } from '../hubData.js';
import { HubToolbar } from '../components/HubToolbar.jsx';

const zh = () => getLang() === 'zh-CN';

function relative(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 60) return zh() ? '刚刚' : 'just now';
    if (seconds < 3600) return zh() ? `${Math.round(seconds / 60)} 分钟前` : `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return zh() ? `${Math.round(seconds / 3600)} 小时前` : `${Math.round(seconds / 3600)}h ago`;
    return zh() ? `${Math.round(seconds / 86400)} 天前` : `${Math.round(seconds / 86400)}d ago`;
}

function CredentialRow({ row, value, onChange, onSave, busy, focus = false }) {
    const [editing, setEditing] = useState(false);
    const configured = row.configured;
    const inputRef = useRef(null);
    // Arrived here from a "key not set" remedy that named this key: open the
    // field, put the row on screen and take the caret. A deep link that lands on
    // a page of twelve rows and leaves the finding to you is the remedy hiding
    // the fix it just named.
    useEffect(() => {
        if (!focus) return;
        setEditing(true);
        const node = inputRef.current;
        if (!node) return;
        try { node.scrollIntoView({ block: 'center' }); } catch { /* older engines */ }
        node.focus();
    }, [focus, editing]);
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
                    {configured ? (zh() ? '已保存' : 'Stored') : (zh() ? '未设置' : 'Not set')}
                </Pill>
            </div>
            {configured && !editing ? (
                <button
                    type="button"
                    className="self-start text-[11px] text-honey underline-offset-2 hover:underline"
                    onClick={() => setEditing(true)}
                >
                    {zh() ? '替换密钥' : 'Replace key'}
                </button>
            ) : (
                <div className="flex items-end gap-2">
                    <Field className="flex-1" label={zh() ? '密钥' : 'Key'}>
                        <TextInput
                            ref={inputRef}
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={zh() ? '粘贴密钥' : 'Paste the key'}
                            value={value || ''}
                            onChange={(event) => onChange(row.key, event.target.value)}
                        />
                    </Field>
                    <Button
                        variant="primary"
                        disabled={busy || !String(value || '').trim()}
                        onClick={() => onSave(row.key, Boolean(configured)).then(() => setEditing(false))}
                    >
                        {configured ? (zh() ? '替换' : 'Replace') : (zh() ? '保存' : 'Save')}
                    </Button>
                </div>
            )}
        </Card>
    );
}

const MODE_COPY = () => (zh() ? {
    always: { label: '始终允许', hint: '直接给出，不打扰' },
    ask: { label: '每次询问', hint: '请求会等待你的批准' },
    window: { label: '时间段内', hint: '仅在设定时段内允许' },
    never: { label: '从不', hint: '始终拒绝' },
} : {
    always: { label: 'Always', hint: 'handed over without interruption' },
    ask: { label: 'Ask me', hint: 'the request waits until you answer' },
    window: { label: 'In hours', hint: 'allowed inside a schedule, refused outside' },
    never: { label: 'Never', hint: 'always refused' },
});

function Pending({ pending, busy, onResolve }) {
    // The request is waiting on this panel, so it leads. Anything below it is
    // configuration; this is someone standing at the door.
    if (!pending?.length) return null;
    return (
        <Card className="flex flex-col gap-3 border-honey/40 p-4">
            <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold text-ink1">
                    {zh() ? `${pending.length} 个请求等待批准` : `${pending.length} request${pending.length > 1 ? 's' : ''} waiting on you`}
                </h4>
            </div>
            {pending.map((item) => (
                <div key={item.id} className="flex flex-col gap-2 border-b border-line1 pb-3 last:border-0 last:pb-0">
                    <p className="text-xs text-ink1">
                        <span className="font-semibold">{item.app}</span>{' '}
                        {zh() ? '请求' : 'wants'} <span className="font-mono text-[11px]">{(item.keys || []).join(', ')}</span>
                    </p>
                    {item.reason ? <p className="text-[11px] text-ink3">{item.reason}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" disabled={busy} onClick={() => onResolve(item.id, true, '')}>
                            {zh() ? '仅此一次' : 'Just this once'}
                        </Button>
                        <Button disabled={busy} onClick={() => onResolve(item.id, true, '1h')}>
                            {zh() ? '批准 1 小时' : 'Approve for 1h'}
                        </Button>
                        <Button disabled={busy} onClick={() => onResolve(item.id, false, '')}>
                            {zh() ? '拒绝' : 'Decline'}
                        </Button>
                    </div>
                </div>
            ))}
        </Card>
    );
}

function Unlocks({ access, busy, onUnlock, onLock }) {
    const copy = MODE_COPY();
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
                                    : (zh() ? '所有密钥' : 'Every key')}
                                {item.app ? ` · ${item.app}` : ''}
                            </p>
                            <Pill tone="honey" dot>
                                {zh() ? `剩余 ${Math.round(item.remaining_seconds / 60)} 分钟` : `${Math.round(item.remaining_seconds / 60)}m left`}
                            </Pill>
                        </div>
                    ))}
                    <Button className="self-start" disabled={busy} onClick={onLock}>
                        {zh() ? '立即关闭' : 'Close now'}
                    </Button>
                </>
            ) : (
                <>
                    <p className="text-xs text-ink2">
                        {zh()
                            ? '开启后，在设定时间内不再询问。到期自动关闭。'
                            : 'Stop being asked for a while. It closes on its own when the time is up.'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {(access?.presets || ['15m', '1h', '4h']).map((preset) => (
                            <Button key={preset} disabled={busy} onClick={() => onUnlock(preset)}>{preset}</Button>
                        ))}
                    </div>
                    <p className="text-[11px] leading-relaxed text-ink3">
                        {zh()
                            ? '开启期间，本机上以你的身份运行的任何程序都可以使用密钥而无需询问。'
                            : 'While it is open, anything running as you can use these keys without asking. That is what it is for — but it should never be something you did without noticing.'}
                    </p>
                </>
            )}
            <p className="text-[11px] text-ink3">{copy.ask.hint}</p>
        </Card>
    );
}

function AccessModes({ access, keys, busy, onSetMode }) {
    const copy = MODE_COPY();
    const [app, setApp] = useState('hivemind-content-studio');
    if (!access?.available) {
        return <p className="text-xs text-ink3">{access?.detail || (zh() ? '未安装。' : 'Not installed.')}</p>;
    }
    const entry = (access.apps || {})[app] || {};
    const rules = entry.keys || {};
    const fallback = (entry.default || {}).mode || access.default_mode;
    return (
        <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink2">
                    {zh() ? '应用' : 'App'} <span className="font-mono text-[11px] text-ink1">{app}</span>
                </p>
                <Pill>{zh() ? `默认 ${fallback}` : `default ${fallback}`}</Pill>
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
                <p className="text-xs text-ink3">{zh() ? '尚无已保存的密钥。' : 'No stored keys yet.'}</p>
            ) : null}
        </Card>
    );
}

function Broker({ broker }) {
    // The limits ship with the status and are rendered, not summarised. This is
    // the one panel where an encouraging word would teach the owner something
    // false — "protected" here would mean "recorded", and they are not the same.
    if (!broker?.available) {
        return <p className="text-xs text-ink3">{broker?.detail || (zh() ? '未安装。' : 'Not installed.')}</p>;
    }
    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink2">
                    {broker.running
                        ? (zh() ? `所有读取都经过代理，模式 ${broker.mode}。` : `Reads go through the broker, in ${broker.mode} mode.`)
                        : (zh() ? '未运行，每个应用各自记录读取。' : 'Not running — each app records its own reads, so the record has gaps.')}
                </p>
                <Pill tone={broker.running ? 'ok' : 'warn'} dot>
                    {broker.running ? (zh() ? '运行中' : 'Running') : (zh() ? '已停止' : 'Stopped')}
                </Pill>
            </div>
            {!broker.running ? (
                <p className="text-[11px] text-ink3">
                    {zh() ? '启动：' : 'Start it with '}<span className="font-mono">passbook broker start</span>
                </p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-ink3">{broker.limits}</p>
        </>
    );
}

function LinkedMachines({ links, busy, onRevoke }) {
    // Read plus revoke only. Approving and accepting need a fingerprint compared
    // against a second machine's screen, and a button here could not do that —
    // one that looked like it could would be worse than no button at all.
    if (!links?.available) {
        return <p className="text-xs text-ink3">{links?.detail || (zh() ? '未安装机器链接。' : 'Machine linking is not set up.')}</p>;
    }
    const rows = [
        ...(links.lent || []).map((row) => ({ ...row, lent: true })),
        ...(links.borrowed || []).map((row) => ({ ...row, lent: false })),
    ];
    return (
        <>
            <p className="text-[11px] text-ink3">
                {zh() ? '本机指纹' : "This machine's fingerprint"}:{' '}
                <span className="font-mono text-ink2">{links.fingerprint}</span>
            </p>
            {rows.length === 0 ? (
                <p className="text-xs text-ink3">
                    {zh()
                        ? '尚无链接。使用 `passbook-link request` 添加机器。'
                        : 'No linked machines. Add one with `passbook-link request` on the machine that needs keys.'}
                </p>
            ) : rows.map((row) => (
                <div key={`${row.role}-${row.did}`} className="flex flex-col gap-1 border-b border-line1 py-2 last:border-0">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-ink1">
                            {row.lent ? (zh() ? '借出给' : 'Lent to') : (zh() ? '借自' : 'Borrowed from')}{' '}
                            <span className="font-mono text-[11px] text-ink2">{row.fingerprint || row.did}</span>
                        </span>
                        <Pill tone={row.active ? 'ok' : row.revoked ? 'neutral' : 'warn'} dot>
                            {row.active ? (zh() ? '有效' : 'Active') : row.revoked ? (zh() ? '已撤销' : 'Revoked') : (zh() ? '已过期' : 'Expired')}
                        </Pill>
                    </div>
                    <p className="font-mono text-[11px] text-ink3">{(row.keys || []).join(', ') || '—'}</p>
                    {row.lent && row.active ? (
                        <Button className="self-start" disabled={busy} onClick={() => onRevoke(row.did)}>
                            {zh() ? '撤销' : 'Revoke'}
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
    // The one key this page was opened for, from ?page=passbook&key=NAME or from
    // a press made while PassBook was already the open page.
    const [focusKey, setFocusKey] = useState(requestedPassBookKey);
    useEffect(() => {
        const onFocus = (event) => setFocusKey(String(event?.detail?.key || ''));
        window.addEventListener(PASSBOOK_FOCUS_EVENT, onFocus);
        return () => window.removeEventListener(PASSBOOK_FOCUS_EVENT, onFocus);
    }, []);
    // Honoured once: a later reload of the same URL should not steal the caret.
    useEffect(() => { if (focusKey) clearRequestedPassBookKey(); }, [focusKey]);

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
                ? (zh() ? `${key} 已保存，所有 Hive 应用均可使用。` : `${key} saved — every Hive app on this machine can use it now.`)
                : result.updated?.length
                    ? (zh() ? `${key} 已替换。` : `${key} replaced.`)
                    : (zh() ? `${key} 已存在，未更改。` : `${key} was already stored; nothing changed.`));
            if (key === MUAPI_CREDENTIAL) {
                // The studios' client cached "no server key" at boot; forget it, or
                // the next Generate still asks this browser for a key it no longer needs.
                muapi.resetRoute();
                void refreshMuapiKeyLocation();
            }
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || error?.message || (zh() ? '保存失败。' : 'Could not save that key.'));
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
                ? (zh()
                    ? `已撤销。请在服务商处轮换：${result.rotate.join('、')}——撤销无法收回已发送的值。`
                    : `Revoked. Rotate these at the provider — revoking cannot unsend them: ${result.rotate.join(', ')}`)
                : (zh() ? '已撤销。' : 'Revoked.'));
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || (zh() ? '无法撤销。' : 'Could not revoke that link.'));
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
            setNotice(error?.detail?.message || error?.message || (zh() ? '操作失败。' : 'That did not work.'));
        } finally {
            setBusy(false);
        }
    };

    const setMode = ({ app, key, mode }) => act('/api/passbook/policy/mode', { app, key, mode },
        () => (zh() ? `${key}: ${mode}` : `${key} is now "${mode}" for ${app}.`));

    const unlock = (duration) => act('/api/passbook/policy/unlock', { duration },
        () => (zh() ? `已开启 ${duration}。` : `Unlocked for ${duration}. It closes on its own.`));

    const lock = () => act('/api/passbook/policy/lock', {},
        () => (zh() ? '已关闭。' : 'Closed.'));

    const resolve = (id, approve, remember) => act('/api/passbook/policy/resolve',
        { id, approve, remember },
        (result) => (approve
            ? (zh() ? '已批准。' : `Approved${remember ? ` for ${remember}` : ''}${result.approved_by?.startsWith('passkey') ? ' with your passkey' : ''}.`)
            : (zh() ? '已拒绝。' : 'Declined.')));

    const seal = async () => {
        setBusy(true);
        setNotice('');
        try {
            const result = await api('/api/passbook/seal', { method: 'POST' });
            setNotice(result.detail || (zh() ? '已加密。' : 'Encrypted at rest.'));
            await load();
        } catch (error) {
            setNotice(error?.detail?.message || (zh() ? '无法加密。' : 'Could not encrypt the store.'));
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
                kicker={zh() ? '本机共享凭据' : 'Shared on this machine'}
                title="PassBook"
                right={<Button onClick={() => void load()} disabled={busy}>{zh() ? '刷新' : 'Refresh'}</Button>}
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
                                {zh() ? '无法读取共享存储。' : 'Could not read the shared store.'}
                            </p>
                            <Button size="sm" onClick={() => void load()}>{zh() ? '重试' : 'Try again'}</Button>
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
                            {zh() ? '此版本无法访问共享存储' : 'This build cannot reach the shared store'}
                        </h4>
                        <p className="text-xs leading-relaxed text-ink2">{state.detail}</p>
                        <p className="text-xs leading-relaxed text-ink3">
                            {zh()
                                ? '请在不启用 App Sandbox 的情况下发布，或使用 HIVE_HOME 指向真实存储启动。'
                                : 'Ship this build without the App Sandbox, or launch it with HIVE_HOME pointing at the real store.'}
                        </p>
                    </Card>
                ) : (
                    <>
                        <Card className="flex flex-col gap-2 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                                <Pill>{zh() ? `${stored} 个已保存` : `${stored} stored`}</Pill>
                                <Pill>{zh() ? `工作区 ${state.workspace || 'main'}` : `workspace ${state.workspace || 'main'}`}</Pill>
                                {(state.apps || []).map((app) => <Pill key={app}>{app}</Pill>)}
                            </div>
                            <p className="text-xs leading-relaxed text-ink2">
                                {zh()
                                    ? '这些密钥保存在本机的共享存储中，本机上每个 Hive 应用都能使用。在此粘贴一次即可，安装 HivemindOS 后会沿用同一存储。'
                                    : 'These keys live in one store shared by every Hive app on this machine. Paste a key once and they all have it — and installing HivemindOS later adopts this same store rather than starting another.'}
                            </p>
                            <p className="font-mono text-[10px] text-ink3">{state.path}</p>
                            {state.writes_to && state.writes_to !== state.path ? (
                                <p className="text-[11px] text-ink3">
                                    {zh() ? '新密钥将写入此工作区：' : 'New keys are written to this workspace: '}
                                    <span className="font-mono">{state.writes_to}</span>
                                </p>
                            ) : null}
                        </Card>

                        <div>
                            <SectionLabel>{zh() ? '此工作室使用的密钥' : 'Keys this studio uses'}</SectionLabel>
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                                {(state.settable || []).map((row) => (
                                    <CredentialRow
                                        key={row.key}
                                        row={row}
                                        value={drafts[row.key]}
                                        busy={busy}
                                        focus={Boolean(focusKey) && row.key === focusKey}
                                        onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                                        onSave={save}
                                    />
                                ))}
                            </div>
                            {notice ? <p className="mt-2 text-xs text-ink2">{notice}</p> : null}
                        </div>

                        <div>
                            <SectionLabel>{zh() ? '静态加密' : 'Encryption at rest'}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-xs text-ink2">{sealing.detail}</p>
                                    <Pill tone={sealing.fully_sealed ? 'ok' : 'warn'} dot>
                                        {sealing.fully_sealed ? (zh() ? '已加密' : 'Encrypted') : (zh() ? '明文' : 'Plaintext')}
                                    </Pill>
                                </div>
                                <p className="text-[11px] leading-relaxed text-ink3">
                                    {zh()
                                        ? '加密可防止磁盘泄露：被盗的笔记本、备份或同步的主目录。它无法阻止以你的身份运行的程序读取密钥。'
                                        : 'This protects the store at rest — a stolen laptop, a backup, a synced home folder. It does not stop code running as you from reading a key.'}
                                </p>
                                {sealing.supported && !sealing.fully_sealed ? (
                                    <Button variant="primary" className="self-start" disabled={busy} onClick={seal}>
                                        {zh() ? '加密存储' : 'Encrypt the store'}
                                    </Button>
                                ) : null}
                                {!sealing.supported ? (
                                    <p className="text-[11px] text-ink3">{sealing.keystore || sealing.detail}</p>
                                ) : null}
                            </Card>
                        </div>

                        <Pending pending={access?.pending} busy={busy} onResolve={resolve} />

                        <div>
                            <SectionLabel>{zh() ? '暂停询问' : 'Stop being asked'}</SectionLabel>
                            <div className="mt-2">
                                <Unlocks access={access} busy={busy} onUnlock={unlock} onLock={lock} />
                            </div>
                        </div>

                        <div>
                            <SectionLabel>{zh() ? '访问方式' : 'How each key is answered'}</SectionLabel>
                            <div className="mt-2">
                                <AccessModes access={access} keys={state.keys} busy={busy} onSetMode={setMode} />
                            </div>
                        </div>

                        <div>
                            <SectionLabel>{zh() ? '已链接的机器' : 'Linked machines'}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <LinkedMachines links={links} busy={busy} onRevoke={revoke} />
                            </Card>
                        </div>

                        <div>
                            <SectionLabel>{zh() ? '读取代理' : 'Read broker'}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                <Broker broker={broker} />
                            </Card>
                        </div>

                        <div>
                            <SectionLabel>{zh() ? '访问记录' : 'Access record'}</SectionLabel>
                            <Card className="mt-2 flex flex-col gap-2 p-4">
                                {ledger?.available ? (
                                    <>
                                        <div className="flex items-center justify-between gap-3">
                                            <p className="text-xs text-ink2">{ledger.detail}</p>
                                            <Pill tone={ledger.intact ? 'ok' : 'danger'} dot>
                                                {ledger.intact ? (zh() ? '未被篡改' : 'Unaltered') : (zh() ? '已被更改' : 'Altered')}
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
                                    <p className="text-xs text-ink3">{ledger?.detail || (zh() ? '未记录访问。' : 'No access record on this machine.')}</p>
                                )}
                            </Card>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
