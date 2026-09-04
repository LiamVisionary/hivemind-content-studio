// Clip Prep — trim, crop, compress and frame-grab a source clip before it
// becomes an H3 reference, entirely on this device.
//
// The dialog is deliberately thin: every number it shows comes from
// planClip() in lib/clipPrep.js, so the readout and the encode can never
// disagree. Nothing here talks to the gateway — a sealed source is decrypted
// through resolveMediaSrc (the vault key lives in this browser and nowhere
// else), transformed by mediabunny, and handed back as a Blob for the caller
// to upload. That is the same constraint that keeps clipJoiner.js client-side.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import {
  CLIP_QUALITY_PRESETS,
  CROP_ASPECTS,
  centeredCrop,
  normalizeTrim,
  planClip,
  referenceBudget,
  storyboardTimestamps,
} from '../lib/clipPrepPlan.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { Button, Field, ProgressBar, SectionLabel, Segmented, Spinner, Toggle, cx } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';
import { t, tf } from '../lib/i18n.js';

const STORYBOARD_TILES = 6;

function seconds(value) {
  const total = Math.max(0, Number(value) || 0);
  const whole = Math.floor(total);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  const tenths = Math.floor((total - whole) * 10);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

function megabytes(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function ClipPrepDialog({
  open = true,
  sourceUrl,
  sourceName = '',
  // The length of the shot this reference will drive. The H3 budget is spent on
  // min(reference, clip), so without it the readout cannot say which side binds.
  clipSeconds = 0,
  onClose,
  onApply,
}) {
  const [blob, setBlob] = useState(null);
  const [source, setSource] = useState(null);
  const [loadError, setLoadError] = useState('');
  // Bumped by Retry so the decrypt+probe effect runs again for the same source.
  const [attempt, setAttempt] = useState(0);
  const [previewUrl, setPreviewUrl] = useState('');

  const [trim, setTrim] = useState({ start: 0, end: null });
  const [quality, setQuality] = useState('reference');
  const [aspect, setAspect] = useState('source');
  const [dropAudio, setDropAudio] = useState(false);

  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [board, setBoard] = useState([]);

  const videoRef = useRef(null);
  // Object URLs outlive the render that made them, so every one created here is
  // tracked and revoked on unmount — a storyboard of six tiles per open would
  // otherwise leak the whole session.
  const objectUrls = useRef([]);
  const track = useCallback((url) => { objectUrls.current.push(url); return url; }, []);

  useEffect(() => () => {
    objectUrls.current.forEach((url) => { try { URL.revokeObjectURL(url); } catch { /* already gone */ } });
    objectUrls.current = [];
  }, []);

  // Decrypt + probe once per source.
  useEffect(() => {
    let cancelled = false;
    if (!open || !sourceUrl) return undefined;
    setBlob(null); setSource(null); setLoadError(''); setBoard([]);
    (async () => {
      try {
        const src = await resolveMediaSrc(sourceUrl);
        const loaded = await (await fetch(src)).blob();
        if (cancelled) return;
        const { probeClip } = await import('../lib/clipPrep.js');
        const probed = await probeClip(loaded);
        if (cancelled) return;
        setBlob(loaded);
        setSource(probed);
        setTrim({ start: 0, end: probed.duration });
        setPreviewUrl(track(URL.createObjectURL(loaded)));
      } catch (error) {
        if (!cancelled) setLoadError(error?.message || 'could not read that clip');
      }
    })();
    return () => { cancelled = true; };
  }, [open, sourceUrl, track, attempt]);

  const crop = useMemo(() => {
    const ratio = CROP_ASPECTS.find((entry) => entry.id === aspect)?.ratio ?? null;
    return source ? centeredCrop(source, ratio) : null;
  }, [source, aspect]);

  const plan = useMemo(
    () => (source ? planClip(source, { trim, crop, quality, dropAudio }) : null),
    [source, trim, crop, quality, dropAudio],
  );
  const budget = useMemo(
    () => (plan ? referenceBudget(plan, clipSeconds) : null),
    [plan, clipSeconds],
  );

  const bounds = source ? normalizeTrim(trim, source.duration) : null;

  const scrubTo = (at) => {
    const video = videoRef.current;
    if (video) { video.currentTime = at; }
  };

  const runPrepare = async () => {
    if (!blob || !plan) return;
    setBusy('prepare'); setProgress(0);
    try {
      const { prepareClip } = await import('../lib/clipPrep.js');
      const result = await prepareClip(blob, { trim, crop, quality, dropAudio }, {
        // ProgressBar reads 0..1, so the fraction is kept as mediabunny reports it.
        onProgress: (value) => setProgress(Math.max(0, Math.min(1, value || 0))),
      });
      const base = (sourceName || 'clip').replace(/\.[^.]+$/, '');
      onApply?.({
        kind: 'video',
        blob: result.blob,
        name: `${base}-prep.mp4`,
        plan: result.plan,
        seconds: result.seconds,
        width: result.width,
        height: result.height,
      });
    } catch (error) {
      toast.error(error?.message || t('clipPrep.prepareFailed'));
    } finally {
      setBusy(''); setProgress(0);
    }
  };

  const runGrabFrame = async (at) => {
    if (!blob) return;
    setBusy('frame');
    try {
      const { grabFrame } = await import('../lib/clipPrep.js');
      // Pin BOTH edges to the plan so a grabbed start frame matches the
      // prepared reference clip exactly rather than landing 2px short.
      const frame = await grabFrame(blob, at, { crop, width: plan?.width || null, height: plan?.height || null });
      const base = (sourceName || 'clip').replace(/\.[^.]+$/, '');
      onApply?.({
        kind: 'image',
        blob: frame.blob,
        name: `${base}-${Math.round(at * 1000)}ms.png`,
        width: frame.width,
        height: frame.height,
      });
    } catch (error) {
      toast.error(error?.message || 'could not read a frame there');
    } finally {
      setBusy('');
    }
  };

  const runStoryboard = async () => {
    if (!blob || !bounds) return;
    setBusy('board'); setBoard([]);
    try {
      const { grabFrame } = await import('../lib/clipPrep.js');
      const stamps = storyboardTimestamps(bounds, STORYBOARD_TILES);
      const tiles = [];
      for (const at of stamps) {
        // Sequential rather than parallel: six concurrent decodes of a 4K clip
        // is how a tab runs out of memory mid-board.
        const frame = await grabFrame(blob, at, { crop, width: 320 });
        tiles.push({ at, url: track(URL.createObjectURL(frame.blob)) });
        setBoard([...tiles]);
      }
    } catch (error) {
      toast.error(error?.message || 'could not build a storyboard');
    } finally {
      setBusy('');
    }
  };

  const ready = Boolean(source && plan && !busy);

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      dismissable={!busy}
      title={t('clipPrep.title')}
      size="xl"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0 text-xs text-ink3">
            {plan ? (
              <>
                {plan.width}×{plan.height}
                {plan.frameRate ? ` · ${plan.frameRate}fps` : ''}
                {' · '}{seconds(plan.trim.seconds)}
                {plan.lossless ? ' · unchanged' : ''}
              </>
            ) : t('clipPrep.readingClip')}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={Boolean(busy)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={runPrepare} disabled={!ready} loading={busy === 'prepare'}>
              {t('clipPrep.useAsReference')}
            </Button>
          </div>
        </div>
      )}
    >
      {loadError ? (
        <div className="flex items-start gap-3 rounded-md border border-danger bg-danger-tint px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink1">{t('clipPrep.readFailed')}</div>
            <div className="mt-0.5 break-words font-mono text-xs text-danger">{loadError}</div>
          </div>
          <Button size="sm" variant="neutral" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>{t('common.retry')}</Button>
        </div>
      ) : !source ? (
        <div className="flex items-center gap-3 py-2 text-sm text-ink3"><Spinner /> {t('clipPrep.decrypting')}</div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-line1 bg-bg0">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            {/* nodownload: Chrome names a blob: download from the URL's UUID and
                ignores the File's name, so the native control could never agree
                with ours. One download path only — see downloadNames.js. */}
            <video
              ref={videoRef}
              src={previewUrl}
              className="mx-auto max-h-[38vh]"
              controls
              controlsList="nodownload"
              playsInline
            />
          </div>

          {/* Trim. Two ranges rather than a custom dual-handle: they are
              keyboard-operable for free, which a div with pointer handlers is not. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>{t('clipPrep.trim')}</SectionLabel>
              {/* Timecodes outside the uppercase kicker: "0:00.0 TO 0:05.0" is not a readout. */}
              <span className="font-mono text-xs text-ink2">
                {seconds(bounds.start)} – {seconds(bounds.end)} <span className="text-ink3">({seconds(bounds.seconds)})</span>
              </span>
            </div>
            <label className="flex items-center gap-2 text-xs text-ink3">
              <span className="w-8 shrink-0">{t('clipPrep.in')}</span>
              <input
                type="range" className="hive-range flex-1"
                min={0} max={source.duration} step={0.05}
                value={bounds.start}
                onChange={(e) => { const start = Number(e.target.value); setTrim((t) => ({ ...t, start })); scrubTo(start); }}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-ink3">
              <span className="w-8 shrink-0">{t('clipPrep.out')}</span>
              <input
                type="range" className="hive-range flex-1"
                min={0} max={source.duration} step={0.05}
                value={bounds.end}
                onChange={(e) => { const end = Number(e.target.value); setTrim((t) => ({ ...t, end })); scrubTo(end); }}
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('clipPrep.quality')} hint={t('clipPrep.qualityHint')}>
              <Segmented
                value={quality}
                onChange={setQuality}
                options={CLIP_QUALITY_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
              />
            </Field>
            <Field label={t('clipPrep.crop')} hint={t('clipPrep.cropHint')}>
              <Segmented
                value={aspect}
                onChange={setAspect}
                options={CROP_ASPECTS.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
            </Field>
          </div>

          {/* The budget readout. This is the whole reason compression is here:
              it says plainly whether trimming further would buy anything. */}
          {budget && clipSeconds > 0 ? (
            <div className={cx(
              'rounded-lg border px-3 py-2 text-xs',
              budget.limitedByReference ? 'border-line1 bg-bg0 text-ink3' : 'border-warn bg-bg0 text-ink2',
            )}>
              {budget.limitedByReference ? (
                <>{t('clipPrep.budgetKeepsBefore')}{' '}<strong>{seconds(budget.referenceSeconds)}</strong>{' '}{tf('clipPrep.budgetKeepsAfter', seconds(budget.referenceSeconds), seconds(clipSeconds))}</>
              ) : budget.referenceSeconds - clipSeconds < 0.05 ? (
                <>{tf('clipPrep.budgetAsLong', seconds(clipSeconds))}</>
              ) : (
                <>{tf('clipPrep.budgetLonger', seconds(clipSeconds))}</>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              icon="image"
              onClick={() => runGrabFrame(videoRef.current?.currentTime || bounds.start)}
              disabled={Boolean(busy)}
              title={t('clipPrep.useCurrentFrameTitle')}
            >
              {t('clipPrep.useCurrentFrame')}
            </Button>
            <Button icon="grid" onClick={runStoryboard} disabled={Boolean(busy)} loading={busy === 'board'}>
              {t('clipPrep.storyboard')}
            </Button>
            <span className="ml-auto flex items-center gap-2 text-xs text-ink3">
              {t('clipPrep.dropAudio')}{source.hasAudio ? '' : ` ${t('clipPrep.noAudio')}`}
              <Toggle checked={dropAudio} onChange={setDropAudio} label={t('clipPrep.dropAudio')} disabled={!source.hasAudio} />
            </span>
          </div>

          {board.length ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {board.map((tile) => (
                <button
                  key={tile.at}
                  type="button"
                  className="group overflow-hidden rounded-md border border-line1 hover:border-honey"
                  onClick={() => runGrabFrame(tile.at)}
                  title={tf('clipPrep.useFrameAt', seconds(tile.at))}
                >
                  <img src={tile.url} alt={tf('clipPrep.frameAt', seconds(tile.at))} className="aspect-video w-full object-cover" />
                  <span className="block py-0.5 text-center text-[10px] text-ink3">{seconds(tile.at)}</span>
                </button>
              ))}
            </div>
          ) : null}

          {busy === 'prepare' ? <ProgressBar value={progress} /> : null}

          <div className="text-[11px] text-ink3">
            {t('common.source')} {source.width}×{source.height}
            {source.frameRate ? ` · ${Math.round(source.frameRate)}fps` : ''}
            {' · '}{seconds(source.duration)}
            {blob ? ` · ${megabytes(blob.size)}` : ''}
            {` · ${t('clipPrep.preparedHere')}`}
          </div>
        </div>
      )}
    </Modal>
  );
}
