// "Separate voices and sound…" — the one way of taking a clip apart that needs
// a dialog, because it is the only one with something to LISTEN to first.
//
// The two remuxes (sound only, video without sound) are rows in the download
// menu: they are instant and there is nothing to decide. This is neither. It
// runs two separation models on this machine for a few times the clip's
// length, and what comes back is up to five files of which a person usually
// wants one or two — and cannot know which without hearing them, because which
// speaker the model calls "Voice 1" is a coin toss it makes per clip.
//
// So each stem is a row with a player and its own Save, a stem the model found
// nothing for says so instead of offering a file of silence, and the stems live
// exactly as long as the dialog does: they are blobs in this tab's memory,
// revoked on close. Nothing is added to History, and the gateway forgets its
// own copy ten minutes later (gateway/stems.py).
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';

import { t, tf } from '../../lib/i18n.js';
import { saveStem, splitSound } from '../../lib/soundExport.js';
import { Modal } from '../../ui/Modal.jsx';
import { Button, FailureCallout, ProgressBar } from '../../ui/kit.jsx';

const VOICE_KEYS = new Set(['voice_1', 'voice_2']);

// One phrase, one key: "Music" is already the studio's word for it in the nav,
// and the dialog's title is the menu row that opened it, minus the ellipsis
// that on the row means "this opens something".
const STEM_LABEL_KEY = { music: 'nav.music' };
const stemLabel = (key) => t(STEM_LABEL_KEY[key] || `sound.stem.${key}`);
const dialogTitle = () => t('sound.split').replace(/…$/, '');

function stemHint(key) {
  return VOICE_KEYS.has(key) ? t('sound.stem.voiceHint') : t(`sound.stem.${key}Hint`);
}

function StemRow({ stem, url, busy, onSave }) {
  const label = stemLabel(stem.key);
  return (
    <li className="rounded-md border border-line1 bg-bg0 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink1">{label}</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-ink3">
            {stem.silent ? t('sound.stem.empty') : stemHint(stem.key)}
          </div>
        </div>
        {stem.silent ? null : (
          <Button size="sm" icon="download" loading={busy} onClick={onSave} aria-label={tf('sound.saveStem', label)}>
            {t('common.download')}
          </Button>
        )}
      </div>
      {stem.silent ? null : (
        // The browser's own transport: a scrubber, a time and a volume that a
        // keyboard and a screen reader already know how to drive. Its own
        // download entry is switched off because it would save the stem under
        // the blob's random name; the button above saves it under the clip's.
        //
        // Its height is a class rather than a pinned 34px style: iOS draws its
        // own transport at a fixed ~44px and clips it inside a shorter box, and
        // up to five of these stack here — the one dialog where losing the play
        // button loses the whole point.
        <audio controls controlsList="nodownload" preload="metadata" src={url} className="mt-2 h-[34px] w-full touch:h-[44px]" />
      )}
    </li>
  );
}

/**
 * @param {string} url       the clip, sealed or not — resolved when Split is pressed
 * @param {string} filename  the clip's model-derived name; each stem is saved under it
 * @param {func}   onClose
 */
export function SoundSplitDialog({ url, filename, onClose }) {
  const [phase, setPhase] = useState('idle'); // idle | working | done | failed
  const [progress, setProgress] = useState({ stage: 'preparing', progress: 0 });
  const [stems, setStems] = useState([]);
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState('');
  const abortRef = useRef(null);

  // One object URL per stem, made once and revoked when the stems are replaced
  // or the dialog goes: these are the only handles to somebody's dialogue in
  // this tab, and a leaked one keeps the bytes alive for the life of the page.
  const urls = useMemo(() => {
    const made = {};
    for (const stem of stems) if (!stem.silent) made[stem.key] = URL.createObjectURL(stem.blob);
    return made;
  }, [stems]);
  useEffect(() => () => { for (const made of Object.values(urls)) URL.revokeObjectURL(made); }, [urls]);
  // Closing mid-split stops the polling. The lane finishes the graph it was
  // given — ComfyUI has no partial result to hand back — and the gateway drops
  // the stems nobody collected.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('working');
    setFailure('');
    setStems([]);
    setProgress({ stage: 'preparing', progress: 0 });
    const result = await splitSound(url, { signal: controller.signal, onProgress: setProgress });
    if (controller.signal.aborted || result.cancelled) return;
    // A sealed clip this tab cannot open has already raised the vault's own
    // message (MEDIA_DOWNLOAD_BLOCKED_EVENT, App.jsx) — close rather than put a
    // vaguer sentence underneath a precise one.
    if (result.blocked) { onClose?.(); return; }
    if (!result.ok) {
      setFailure(result.unreachable ? t('sound.unreachable') : (result.message || t('sound.splitFailed')));
      setPhase('failed');
      return;
    }
    setStems(result.stems);
    setPhase('done');
  };

  const stop = () => {
    abortRef.current?.abort();
    setPhase('idle');
  };

  const save = async (stem) => {
    setSaving(stem.key);
    try {
      const saved = await saveStem(stem, filename);
      if (saved.ok) toast.success(tf('sound.saved', saved.filename));
    } finally {
      setSaving('');
    }
  };

  const audible = stems.filter((stem) => !stem.silent);
  const saveAll = async () => {
    setSaving('all');
    try {
      // One after another, not at once: a browser that is asked for five
      // downloads in the same tick blocks all but the first.
      for (const stem of audible) {
        const saved = await saveStem(stem, filename);
        if (saved.cancelled) break;
      }
    } finally {
      setSaving('');
    }
  };

  const voices = stems.filter((stem) => VOICE_KEYS.has(stem.key));
  const oneVoice = voices.length === 2 && voices.filter((stem) => !stem.silent).length === 1;
  // While installing there is a real fraction (bytes of 20 MB). While splitting
  // the lane reports none, and an invented bar is worse than an honest sweep.
  const fraction = progress.stage === 'installing' ? progress.progress : null;

  return (
    <Modal
      title={dialogTitle()}
      size="md"
      onClose={onClose}
      footer={phase === 'done' ? (
        <>
          <Button variant="neutral" icon="refresh" onClick={() => void run()} disabled={Boolean(saving)}>
            {t('sound.again')}
          </Button>
          {audible.length > 1 ? (
            <Button variant="primary" icon="download" loading={saving === 'all'} disabled={Boolean(saving)} onClick={() => void saveAll()}>
              {tf('sound.saveAll', audible.length)}
            </Button>
          ) : null}
        </>
      ) : null}
    >
      {phase === 'idle' ? (
        <div className="flex flex-col items-start gap-4">
          <p className="text-[13px] leading-relaxed text-ink2">{t('sound.dialogIntro')}</p>
          <Button variant="primary" icon="scissors" data-autofocus onClick={() => void run()}>
            {t('sound.start')}
          </Button>
        </div>
      ) : null}

      {phase === 'working' ? (
        <div className="flex flex-col gap-3 py-2" aria-live="polite">
          <p className="text-[13px] leading-relaxed text-ink2">
            {t(`sound.stage.${progress.stage}`) === `sound.stage.${progress.stage}`
              ? t('sound.stage.splitting')
              : t(`sound.stage.${progress.stage}`)}
          </p>
          <ProgressBar value={fraction} label={t('sound.working')} />
          <div>
            <Button size="sm" variant="neutral" icon="x" onClick={stop}>{t('sound.stop')}</Button>
          </div>
        </div>
      ) : null}

      {/* The gateway's refusals are written for the person reading them, so the
          sentence IS the title rather than a detail folded away under it. */}
      {phase === 'failed' ? (
        <FailureCallout title={failure || t('sound.splitFailed')} onRetry={() => void run()} />
      ) : null}

      {phase === 'done' ? (
        <div className="flex flex-col gap-2.5">
          <ul className="flex flex-col gap-2">
            {stems.filter((stem) => !(oneVoice && stem.silent && VOICE_KEYS.has(stem.key))).map((stem) => (
              <StemRow
                key={stem.key}
                stem={stem}
                url={urls[stem.key]}
                busy={saving === stem.key}
                onSave={() => void save(stem)}
              />
            ))}
          </ul>
          {oneVoice ? <p className="text-[11.5px] leading-snug text-ink3">{t('sound.oneVoice')}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}
