// Local model manager panel (React port of the retired vanilla studio).
// Embedded by the Models page's Engine tab (its only consumer).
// All localAI flows preserved: binary install, aux downloads (__llm__/__vae__),
// wan2gp config probe, per-model download/delete with progress subscriptions
// that always unsubscribe on success AND error.
//
// It is also the STORE: the only place in the app that installs a model. Each
// card says what the model is for, what the server's capability matrix rates it
// good at, what it costs to download, and — from /api/doctor — whether this
// particular machine can run it. A model already on disk offers "Try it",
// which opens the Image studio on that model with a starter prompt in the box,
// so an empty machine reaches its first picture without a studio menu.
import { useCallback, useEffect, useState } from 'react';
import { fetchCapabilityMatrix } from '../lib/capabilityMatrix.js';
import { t, tf } from '../lib/i18n.js';
import { isLocalAIAvailable, localAI } from '../lib/localInferenceClient.js';
import {
  capabilityBadges, fetchDoctor, modelFit, modelPurpose, recommendedModelId, starterPromptFor,
} from '../lib/modelStore.js';
import { openModelInStudio } from '../hub/views/models/openInStudio.js';
import { Icon } from '../ui/icons.jsx';
import { Button, EmptyState, Field, Pill, ProgressBar, SectionLabel, Spinner, TextInput, cx } from '../ui/kit.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { toastFailure } from '../ui/failureToast.jsx';

function fmtGB(gb) {
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(gb * 1024).toFixed(0)} MB`;
}

function Tag({ children }) {
  return (
    <span className="rounded-sm bg-bg3 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink3">
      {children}
    </span>
  );
}

function MiniProgress({ progress, label }) {
  return (
    <div className="mt-1.5 w-full">
      <ProgressBar value={Math.max(0, Math.min(1, Number(progress) || 0))} label={label} />
      <span className="mt-1 block text-[11px] text-ink3">{label}</span>
    </div>
  );
}

/* ---------------- sd.cpp engine status ---------------- */

function BinaryStatusBar() {
  const [exists, setExists] = useState(null); // null = checking
  const [phase, setPhase] = useState(null); // { progress, label } while installing
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const status = await localAI.getBinaryStatus();
    setExists(Boolean(status.exists));
  }, []);

  useEffect(() => {
    refresh().catch(() => setExists(false));
  }, [refresh]);

  const install = async () => {
    setBusy(true);
    setError(null);
    setPhase({ progress: 0, label: t('localModels.downloading') });
    const unsub = localAI.onDownloadProgress(({ id, phase: p, progress }) => {
      if (id !== '__binary__') return;
      setPhase({
        progress,
        label:
          p === 'extracting'
            ? t('localModels.extracting')
            : `${t('localModels.downloading')} ${Math.round(progress * 100)}%`,
      });
    });
    try {
      await localAI.downloadBinary();
      unsub();
      setPhase(null);
      await refresh();
    } catch (err) {
      unsub();
      setPhase(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line1 bg-bg2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink1">sd.cpp inference engine</div>
          <div className="mt-0.5 text-xs">
            {exists === null ? (
              <span className="text-ink3">{t('localModels.checking')}</span>
            ) : exists ? (
              <span className="text-ok">{t('localModels.installed')}</span>
            ) : error ? (
              <span className="font-mono text-danger">Error: {error}</span>
            ) : phase ? (
              <span className="text-ink3">{phase.label}</span>
            ) : (
              <span className="text-warn">{t('localModels.notInstalled')}</span>
            )}
          </div>
        </div>
        {exists === false && !phase ? (
          <Button variant="primary" size="sm" onClick={install} loading={busy}>
            {error ? t('common.retry') : t('localModels.installEngine')}
          </Button>
        ) : null}
      </div>
      {phase ? <MiniProgress progress={phase.progress} label={phase.label} /> : null}
    </div>
  );
}

/* ---------------- Wan2GP server config ---------------- */

function Wan2gpConfigBar({ onChange }) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState({ text: t('localModels.notConfigured'), kind: 'muted' });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const cfg = await localAI.getWan2gpConfig();
      if (!alive) return;
      if (cfg.url) {
        setUrl(cfg.url);
        const r = await localAI.probeWan2gp(cfg.url);
        if (!alive) return;
        setStatus(
          r.ok
            ? { text: `Connected · Gradio ${r.version}`, kind: 'ok' }
            : { text: `Saved URL not reachable: ${r.error}`, kind: 'warn' },
        );
      } else {
        setStatus({ text: t('localModels.notConfiguredNote'), kind: 'muted' });
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const test = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setStatus({ text: t('localModels.enterUrlFirst'), kind: 'warn' });
      return;
    }
    setStatus({ text: t('localModels.probing'), kind: 'muted' });
    setTesting(true);
    try {
      const r = await localAI.probeWan2gp(trimmed);
      setStatus(
        r.ok
          ? { text: tf('localModels.reachable', r.version), kind: 'ok' }
          : { text: tf('localModels.unreachable', r.error), kind: 'err' },
      );
    } catch (err) {
      // A throwing probe used to leave "Probing…" on screen for good.
      setStatus({ text: err?.message || t('localModels.probeFailed'), kind: 'err' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const trimmed = url.trim();
    setSaving(true);
    try {
      await localAI.setWan2gpUrl(trimmed);
      const r = trimmed ? await localAI.probeWan2gp(trimmed) : { ok: false, error: 'cleared' };
      setStatus(
        r.ok
          ? { text: `Saved · Connected to Gradio ${r.version}`, kind: 'ok' }
          : trimmed
            ? { text: `Saved, not reachable: ${r.error}`, kind: 'warn' }
            : { text: 'Cleared', kind: 'warn' },
      );
      onChange?.();
    } catch (err) {
      setStatus({ text: err?.message || t('localModels.saveUrlFailed'), kind: 'err' });
    } finally {
      setSaving(false);
    }
  };

  const statusColor = { muted: 'text-ink3', ok: 'text-ok', warn: 'text-warn', err: 'text-danger' }[status.kind] || 'text-ink3';

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line1 bg-bg2 p-3">
      <div>
        <div className="text-[13px] font-medium text-ink1">{t('localModels.wan2gpTitle')}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-ink3">
          {t('common.run')}{' '}
          <a
            href="https://github.com/deepbeepmeep/Wan2GP"
            target="_blank"
            rel="noreferrer"
            className="text-honey hover:underline"
          >
            {t('localModels.wan2gpName')}
          </a>{' '}
          {/* A <code> element splits this sentence, so the table holds the two
              halves the element leaves — never one string with markup in it. */}
          {t('localModels.wan2gpOnCuda')}<code className="font-mono text-ink2">python wgp.py --listen --server-name 0.0.0.0</code>{t('localModels.wan2gpUnlocks')}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <Field label={t('localModels.serverUrl')} className="flex-1">
          <TextInput
            type="text"
            placeholder={t('localModels.urlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </Field>
        <Button onClick={test} loading={testing}>
          {t('common.test')}
        </Button>
        {/* Neutral: the panel's one primary is Install engine. */}
        <Button variant="neutral" onClick={save} loading={saving}>
          {t('common.save')}
        </Button>
      </div>
      <div className={cx('text-[11px]', statusColor)}>{status.text}</div>
    </div>
  );
}

/* ---------------- Auxiliary component rows ---------------- */

function AuxRow({ label, auxKey, status, onStateChange }) {
  const isReady = status === 'downloaded';
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    setError(null);
    setPhase({ progress: 0, label: t('localModels.downloading') });
    const auxId = auxKey === 'llm' ? '__llm__' : '__vae__';
    const unsub = localAI.onDownloadProgress(({ id, phase: p, progress }) => {
      if (id !== auxId) return;
      setPhase({
        progress,
        label:
          p === 'done'
            ? t('localModels.complete')
            : `${t('localModels.downloading')} ${Math.round(progress * 100)}%`,
      });
    });
    try {
      await localAI.downloadAuxiliary(auxKey);
      unsub();
      onStateChange?.();
    } catch (err) {
      unsub();
      setPhase(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line1 bg-bg1 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isReady ? (
            <Icon name="check" size={13} className="shrink-0 text-ok" />
          ) : (
            <Icon name="warning" size={13} className="shrink-0 text-warn" />
          )}
          <span className="truncate text-xs text-ink1">{label}</span>
        </div>
        <div className="shrink-0">
          {isReady ? (
            <span className="text-[11px] font-medium text-ok">{t('common.ready')}</span>
          ) : (
            <Button size="sm" icon="download" onClick={download} loading={busy}>
              {error ? t('common.retry') : t('localModels.get')}
            </Button>
          )}
        </div>
      </div>
      {error ? <div className="mt-1 font-mono text-[11px] text-danger">Error: {error}</div> : null}
      {phase && !error ? <MiniProgress progress={phase.progress} label={phase.label} /> : null}
    </div>
  );
}

/* ---------------- Hardware fit ---------------- */

// "Fits your 36 GB Mac." / "Too big for your 16 GB Mac — needs a rented GPU."
// A blocked verdict always carries the way out beside it: the fit line is the
// only place in the app that tells someone their machine is not enough, so it
// cannot be the place that leaves them there.
function FitLine({ fit }) {
  if (!fit) return null;
  const tone = {
    ok: 'text-ok',
    warn: 'text-warn',
    blocked: 'text-danger',
    unknown: 'text-ink3',
  }[fit.tone] || 'text-ink3';
  const icon = { ok: 'check', warn: 'warning', blocked: 'warning' }[fit.tone] || 'cpu';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cx('flex min-w-0 items-center gap-1.5 text-[11px]', tone)}>
        <Icon name={icon} size={12} className="shrink-0" />
        <span className="min-w-0 truncate" title={fit.text}>{fit.text}</span>
      </span>
      {fit.action ? (
        <Button
          size="sm"
          variant="neutral"
          className="shrink-0"
          onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: fit.action.page } }))}
        >
          {fit.action.label}
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------- Model cards ---------------- */

function Wan2gpModelCard({ model }) {
  const ready = Boolean(model.ready);
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg2 p-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink1">{model.name}</span>
          {ready ? <Icon name="check" size={13} className="text-ok" /> : null}
        </div>
        <p className="text-xs leading-relaxed text-ink3">{model.description}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Tag>{model.type.toUpperCase()}</Tag>
          <Tag>via Wan2GP</Tag>
          {(model.tags || [])
            .filter((tag) => !['featured', 'remote'].includes(tag))
            .map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
        </div>
      </div>
      <div className="shrink-0">
        <Pill tone={ready ? 'ok' : 'warn'} dot>
          {ready ? t('localModels.available') : t('localModels.offline')}
        </Pill>
      </div>
    </div>
  );
}

function ModelCard({ model, onStateChange, hardware = null, matrix = null, recommended = false }) {
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (model.provider === 'wan2gp') return <Wan2gpModelCard model={model} />;

  const isDownloaded = model.state === 'downloaded';
  const auxStatus = model.auxiliaryStatus || {};
  const auxReady = !model.requiresAuxiliary || (auxStatus.llm === 'downloaded' && auxStatus.vae === 'downloaded');
  const fullyReady = isDownloaded && auxReady;
  const fit = modelFit(model, hardware);
  const badges = capabilityBadges(matrix, model);

  const download = async () => {
    setBusy(true);
    setError(null);
    setPhase({ progress: 0, label: t('localModels.preparing') });
    const unsub = localAI.onDownloadProgress(({ id, phase: p, progress }) => {
      if (id !== model.id) return;
      setPhase({
        progress,
        label:
          p === 'done'
            ? t('localModels.complete')
            : `${t('localModels.downloading')} ${Math.round(progress * 100)}%`,
      });
    });
    try {
      await localAI.downloadModel(model.id);
      unsub();
      onStateChange?.();
    } catch (err) {
      unsub();
      setPhase(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await localAI.deleteModel(model.id);
      setConfirmOpen(false);
      onStateChange?.();
    } catch (err) {
      toastFailure(err, { operation: t('localModels.modelAction') });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line1 bg-bg2 p-3.5 transition-colors hover:border-line2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-ink1">{model.name}</span>
            {recommended ? <Pill tone="honey">{t('localModels.startHere')}</Pill> : null}
            {model.featured && !recommended ? <Pill tone="honey">{t('localModels.featured')}</Pill> : null}
            {fullyReady ? <Icon name="check" size={13} className="text-ok" /> : null}
          </div>
          {/* What it is FOR, then what it is. The second line is the catalog's
              own description and stays as the detail behind the headline. */}
          <p className="text-xs font-medium leading-relaxed text-ink2">{modelPurpose(model)}</p>
          <p className="text-xs leading-relaxed text-ink3">{model.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Tag>{model.type.toUpperCase()}</Tag>
            <Tag>{fmtGB(model.sizeGB)}</Tag>
            {/* Rated GOOD by the server's capability matrix — never a second
                table of opinions written in the browser. */}
            {badges.map((badge) => <Tag key={badge}>{badge}</Tag>)}
            {(model.tags || [])
              .filter((tag) => tag !== 'featured')
              .map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isDownloaded ? (
            <>
              {/* The whole point of installing one: a first picture, without
                  opening a studio and hunting through its model menu. */}
              <Button
                variant="primary"
                size="sm"
                icon="sparkles"
                disabled={!auxReady}
                title={auxReady ? t('localModels.tryItTitle') : t('localModels.tryItNeedsAux')}
                onClick={() => openModelInStudio(model, { prompt: starterPromptFor(model) })}
              >
                {t('localModels.tryIt')}
              </Button>
              <Button variant="danger" size="sm" icon="trash" onClick={() => setConfirmOpen(true)} aria-label={tf('localModels.deleteLabel', model.name)} />
            </>
          ) : (
            <Button
              variant={recommended ? 'primary' : 'neutral'}
              size="sm"
              icon="download"
              onClick={download}
              loading={busy}
              disabled={Boolean(fit.blocksInstall)}
              title={fit.blocksInstall ? fit.text : undefined}
            >
              {error ? t('common.retry') : busy ? t('localModels.starting') : t('common.download')}
            </Button>
          )}
        </div>
      </div>
      <FitLine fit={fit} />
      {error ? <div className="font-mono text-[11px] text-danger">Error: {error}</div> : null}
      {phase && !error ? <MiniProgress progress={phase.progress} label={phase.label} /> : null}
      {model.requiresAuxiliary ? (
        <div className="flex flex-col gap-1.5 border-t border-line1 pt-2.5">
          <SectionLabel>{t('localModels.requiredComponents')}</SectionLabel>
          <AuxRow label={t('localModels.auxTextEncoder')} auxKey="llm" status={auxStatus.llm} onStateChange={onStateChange} />
          <AuxRow label={t('localModels.auxVae')} auxKey="vae" status={auxStatus.vae} onStateChange={onStateChange} />
        </div>
      ) : null}
      <ConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doDelete}
        title={t('localModels.deleteTitle')}
        body={tf('localModels.deleteConfirm', model.name)}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        busy={deleting}
      />
    </div>
  );
}

/* ---------------- Main panel ---------------- */

// `initialModels` / `initialHardware` / `initialMatrix` are the test seam, the
// same one SettingsView carries: a card only exists once the bridge and
// /api/doctor have answered, and effects do not run under the static render the
// tests use — so without a way in, the store card would be unrendered code. The
// app passes none of them.
export function LocalModelManager({ initialModels = null, initialHardware = null, initialMatrix = null }) {
  const available = isLocalAIAvailable();
  const [models, setModels] = useState(initialModels); // null = loading
  const [listError, setListError] = useState(null);
  const [storage, setStorage] = useState({ text: t('localModels.checkingStorage'), title: undefined });
  // What this machine is, and what the server rates each model good at. Both
  // are decoration on a card: a probe that never answers must leave the store
  // usable, so neither has an error state — the fit line simply says it is
  // still checking, and the badges are absent rather than wrong.
  const [hardware, setHardware] = useState(initialHardware);
  const [matrix, setMatrix] = useState(initialMatrix);

  const refreshModels = useCallback(async () => {
    setListError(null);
    try {
      const { models: list, status } = await localAI.listModels();
      setModels(list);
      // The catalog fetch reports why it is empty instead of rejecting, so an
      // engine that is not answering still has to reach the banner.
      if (status === 'unreachable') setListError(t('localModels.engineStarting'));
    } catch (err) {
      setListError(err.message);
      setModels([]);
    }
  }, []);

  useEffect(() => {
    if (!available) return;
    refreshModels();
    (async () => {
      try {
        const status = await localAI.getBinaryStatus();
        const storagePath = status.modelsDir || status.dataDir;
        setStorage({
          text: storagePath ? `${t('localModels.storedIn')} ${storagePath}` : t('localModels.storedDefault'),
          title:
            storagePath && status.envVar
              ? `Set ${status.envVar} before launch to change this location`
              : undefined,
        });
      } catch {
        setStorage({ text: t('localModels.storedDefault'), title: undefined });
      }
    })();
    fetchDoctor().then((report) => setHardware(report?.hardware || null)).catch(() => {});
    fetchCapabilityMatrix().then(setMatrix).catch(() => {});
  }, [available, refreshModels]);

  // One model wears "Start here" — on Apple Silicon that is Z-Image Turbo,
  // 3.4 GB and eight steps, the shortest road from an empty machine to a
  // picture. A machine with everything installed recommends nothing.
  const recommended = recommendedModelId(models || [], hardware);

  if (!available) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-sm font-medium text-ink1">{t('localModels.title')}</p>
        <p className="max-w-xs text-xs leading-relaxed text-ink3">{t('localModels.webOnly')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <SectionLabel>{t('localModels.inferenceEngine')}</SectionLabel>
        <BinaryStatusBar />
        <Wan2gpConfigBar onChange={refreshModels} />
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel className="shrink-0">{t('localModels.title')}</SectionLabel>
          <span className="min-w-0 truncate text-right font-mono text-[10px] text-ink3" title={storage.title}>
            {storage.text}
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          {models === null ? (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-ink3">
              <Spinner size={14} />
              {t('localModels.loading')}
            </div>
          ) : listError ? (
            <EmptyState
              icon="warning"
              title={t('localModels.listFailed')}
              hint={<span className="font-mono text-xs text-danger">{listError}</span>}
              action={<Button size="sm" icon="refresh" onClick={refreshModels}>{t('common.retry')}</Button>}
              className="py-8"
            />
          ) : models.length === 0 ? (
            <EmptyState
              icon="cpu"
              title={t('localModels.noneYet')}
              hint={t('localModels.noneYetHint')}
              action={<Button size="sm" icon="refresh" onClick={refreshModels}>{t('common.retry')}</Button>}
              className="py-8"
            />
          ) : (
            models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                onStateChange={refreshModels}
                hardware={hardware}
                matrix={matrix}
                recommended={model.id === recommended}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
