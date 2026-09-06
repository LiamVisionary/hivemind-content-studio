// Developer tool: recover sealed clips with a private key pasted here.
// See lib/recoverWithKey.js for what it does and does not do. Shown from
// History only when developer.recovery_tools is on.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Modal } from '../../ui/Modal.jsx';
import { Button, Spinner } from '../../ui/kit.jsx';
import { t, tf } from '../../lib/i18n.js';
import { forgetResolvedMedia, isSealedEnvelopeResponse } from '../../lib/e2eMedia.js';
import { importPrivateKeyPem, keyFingerprint, reseal, scanForKey } from '../../lib/recoverWithKey.js';
import { api, loadPrompts } from '../hubData.js';

async function fetchEnvelope(url) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok || !isSealedEnvelopeResponse(response)) { try { response.body?.cancel(); } catch { /* consumed */ } return null; }
    return response.json();
}

export function RecoverWithKeyDialog({ open, onClose, items }) {
    const [pem, setPem] = useState('');
    const [phase, setPhase] = useState('idle'); // idle | scanning | scanned | resealing | done
    const [error, setError] = useState('');
    const [fingerprint, setFingerprint] = useState('');
    const [progress, setProgress] = useState({ done: 0, total: 0, opens: 0 });
    const [result, setResult] = useState(null); // { opens, refuses, skipped }
    const [resealed, setResealed] = useState({ ok: 0, failed: 0 });
    const keyRef = useRef(null);
    const fileRef = useRef(null);

    const candidates = useMemo(() => (items || []).map((entry) => ({
        id: entry.history_id, url: `/api/canvas/history/${entry.history_id}/media`, name: entry.output_basename || entry.history_id,
    })), [items]);

    const onFile = useCallback(async (event) => {
        const file = event.target.files?.[0];
        if (file) setPem(await file.text());
    }, []);

    const scan = useCallback(async () => {
        setError(''); setResult(null); setResealed({ ok: 0, failed: 0 });
        try {
            keyRef.current = await importPrivateKeyPem(pem);
            setFingerprint(await keyFingerprint(keyRef.current, pem));
        } catch (cause) { setError(cause?.message || String(cause)); return; }
        setPhase('scanning'); setProgress({ done: 0, total: candidates.length, opens: 0 });
        const found = await scanForKey(candidates, keyRef.current, fetchEnvelope, setProgress);
        setResult(found); setPhase('scanned');
    }, [pem, candidates]);

    const doReseal = useCallback(async () => {
        if (!result?.opens?.length || !keyRef.current) return;
        setPhase('resealing'); setError('');
        let vaultPub = '';
        try {
            const identity = await api('/api/vault/identity');
            vaultPub = identity?.public_key || identity?.identity?.public_key || '';
            if (!vaultPub) throw new Error(t('recover.noVaultKey'));
        } catch (cause) { setError(cause?.message || String(cause)); setPhase('scanned'); return; }
        let ok = 0, failed = 0;
        for (const item of result.opens) {
            try {
                const envelope = await reseal(item.envelope, keyRef.current, vaultPub);
                await api(`/api/canvas/history/${item.id}/reseal`, { method: 'PUT', body: JSON.stringify(envelope) });
                forgetResolvedMedia(item.url);
                ok += 1;
            } catch { failed += 1; }
            setResealed({ ok, failed });
        }
        keyRef.current = null; // the key's job is done; drop the handle
        setPhase('done');
        void loadPrompts({ quiet: true, force: true });
    }, [result]);

    const close = useCallback(() => { keyRef.current = null; setPem(''); setPhase('idle'); setResult(null); setError(''); onClose?.(); }, [onClose]);

    return (
        <Modal open={open} onClose={close} title={t('history.recoverWithKey')} size="md"
            footer={(
                <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={close}>{t('common.close')}</Button>
                    {phase === 'idle' || phase === 'scanned' ? (
                        <Button size="sm" disabled={!pem.trim()} onClick={scan}>{t('recover.scan')}</Button>
                    ) : null}
                    {phase === 'scanned' && result?.opens?.length ? (
                        <Button size="sm" onClick={doReseal}>{tf('recover.resealN', result.opens.length)}</Button>
                    ) : null}
                </div>
            )}>
            <div className="flex flex-col gap-3 text-sm text-ink2">
                <p className="text-xs text-ink3">{t('recover.explain')}</p>
                <textarea
                    className="min-h-[7rem] w-full rounded-md border border-line2 bg-bg1 p-2 font-mono text-xs text-ink1"
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    value={pem}
                    onChange={(e) => setPem(e.target.value)}
                    spellCheck={false}
                    disabled={phase === 'scanning' || phase === 'resealing'}
                />
                <div className="flex items-center gap-2 text-xs">
                    <input ref={fileRef} type="file" accept=".pem,.key,text/plain" className="hidden" onChange={onFile} />
                    <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>{t('recover.chooseFile')}</Button>
                    {fingerprint ? <span className="font-mono text-ink3">{t('recover.fingerprint')} {fingerprint}</span> : null}
                </div>
                {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
                {phase === 'scanning' ? (
                    <p className="flex items-center gap-2 text-xs"><Spinner size={14} className="text-honey" /> {tf('recover.scanning', progress.done, progress.total, progress.opens)}</p>
                ) : null}
                {phase === 'scanned' && result ? (
                    <p className="text-xs">{tf('recover.scanned', result.opens.length, result.refuses.length, result.skipped.length)}</p>
                ) : null}
                {phase === 'resealing' ? (
                    <p className="flex items-center gap-2 text-xs"><Spinner size={14} className="text-honey" /> {tf('recover.resealing', resealed.ok, result?.opens?.length || 0)}</p>
                ) : null}
                {phase === 'done' ? (
                    <p className="text-xs">{tf('recover.done', resealed.ok, resealed.failed)}</p>
                ) : null}
            </div>
        </Modal>
    );
}
