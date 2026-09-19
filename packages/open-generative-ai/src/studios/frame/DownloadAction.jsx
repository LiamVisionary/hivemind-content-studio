// The stage's Download door, and the three things that live behind its arrow.
//
// Download used to be one round button doing one thing, which was right until
// there were three ways to take a finished generation out of the studio and
// only one of them belonged on the front of the button:
//
//   press          save it (unchanged, still the plain plaintext file)
//   arrow ▸ save with the settings written in — the prompt, seed, model and
//                  LoRAs stamped into the file itself
//           ▸ hand it to the system share sheet
//           ▸ the switch that decides whether the first of those does anything
//           ▸ (video) the clip in pieces: its sound alone, its picture alone,
//                  or its sound separated into dialogue, effects, music and
//                  a track per voice (lib/soundExport.js)
//
// The switch is the reason this is a menu rather than three buttons. Stamping
// is not undoable in any copy somebody already has: once the prompt is inside
// the file, it is inside every copy of it, forever, and a person who wanted a
// picture has published a recipe. So it is armed deliberately, it is armed per
// studio (lib/prefs.js — reference sheets and the clips you send to a group
// chat are not the same decision), and the switch sits directly under the item
// it governs so the disabled row explains itself instead of just being grey.
//
// Shared by the Image and Video stages, like everything else in this folder:
// one definition, so the two studios cannot drift into two answers about what
// leaves the machine.
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';

import { t, tf } from '../../lib/i18n.js';
import { canShareMedia, downloadMediaWithSettings, shareMedia } from '../../lib/mediaExport.js';
import { lazyChunk } from '../../lib/lazyChunk.js';
import { allowsUnencryptedDownload, setAllowUnencryptedDownload, subscribePrefs } from '../../lib/prefs.js';
import { downloadTrack } from '../../lib/soundExport.js';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { Spinner, Toggle, cx } from '../../ui/kit.jsx';

// Shut on arrival, and this file is part of the LANDING studio's stage: a
// static import would make every first paint download a dialog that only a
// video's menu can open.
const SoundSplitDialogLazy = lazyChunk(() => import('./SoundSplitDialog.jsx').then((m) => ({ default: m.SoundSplitDialog })));

/**
 * @param {'image'|'video'} studio   which switch this menu reads and writes
 * @param {string} url               the output, sealed or not — resolved on press
 * @param {string} filename          the model-derived name (downloadNames.js)
 * @param {func}   onDownload        the plain save; the front of the button
 * @param {func=}  settings          () => meta, computed on press from the context
 *                                   captured for THIS output. Omit when the studio
 *                                   has no settings for it — the stamped save is
 *                                   then offered as unavailable rather than as a
 *                                   button that writes an empty recipe.
 * @param {string=} label            the main button's tooltip
 */
export function StageDownloadAction({
  studio,
  url,
  filename,
  onDownload,
  settings = null,
  label = '',
}) {
  const [allowed, setAllowed] = useState(() => allowsUnencryptedDownload(studio));
  const [busy, setBusy] = useState('');
  const [splitting, setSplitting] = useState(false);
  // Two tabs, one document: a switch thrown in the Image studio must not leave
  // a stale copy of itself on a stage that is still mounted behind it.
  useEffect(() => subscribePrefs(() => setAllowed(allowsUnencryptedDownload(studio))), [studio]);

  // Asked once per render rather than cached at module load: a browser can gain
  // the capability between mounts (a page opened over http, then over its https
  // tailnet URL, is a different secure-context answer for the same install).
  const canShare = canShareMedia();
  const saveLabel = label || t('common.download');

  const runStamped = async (close) => {
    close();
    setBusy('settings');
    try {
      const result = await downloadMediaWithSettings(url, filename, settings?.() || {});
      // A sealed output this tab cannot open already raised the vault's own
      // message through MEDIA_DOWNLOAD_BLOCKED_EVENT (App.jsx). Saying anything
      // else here would put a second, vaguer toast over a precise one.
      if (result.blocked || result.cancelled) return;
      if (!result.ok) {
        toast.error(t('download.settingsFailed'));
        return;
      }
      // The stamp is best-effort by design — no Pillow, no ffmpeg, or a
      // container that will not carry tags. The file is still saved, and saying
      // so beats letting someone believe a recipe travelled that did not.
      toast.success(result.embedded ? t('download.settingsSaved') : t('download.settingsNotWritten'));
    } finally {
      setBusy('');
    }
  };

  // The clip in halves. Neither half carries the settings stamp, whatever the
  // switch below says: a WAV has nowhere the ecosystem would read one, and a
  // person who asked for "the video without sound" did not ask to publish a
  // prompt with it.
  const runTrack = async (close, mode) => {
    close();
    setBusy(mode);
    try {
      const result = await downloadTrack(url, filename, mode);
      if (result.blocked || result.cancelled) return;
      if (result.ok) {
        toast.success(tf('sound.saved', result.filename));
        return;
      }
      // "This clip has no sound" is an answer about the file, said as it is.
      toast.error(result.message || t('sound.failed'));
    } finally {
      setBusy('');
    }
  };

  const runShare = async (close) => {
    close();
    setBusy('share');
    try {
      const result = await shareMedia(url, filename, { title: filename || '' });
      if (result.blocked || result.cancelled || result.ok) return;
      // Never a dead end: the one thing that always works is right above it.
      toast.error(result.unsupported ? t('download.shareUnsupported') : t('download.shareFailed'));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
    <Menu
      align="end"
      width="w-[268px]"
      trigger={(open, toggle) => (
        // One pill, two halves. The divider is what says "these are two
        // buttons" — without it the arrow reads as decoration on a wide button.
        <div
          className={cx(
            'flex h-8 items-center overflow-hidden rounded-full backdrop-blur transition-colors touch:h-[44px]',
            open ? 'bg-honey text-on-honey' : 'bg-bg0/[0.72] text-ink1',
          )}
        >
          <button
            type="button"
            onClick={onDownload}
            disabled={Boolean(busy)}
            title={saveLabel}
            aria-label={saveLabel}
            className={cx(
              'grid h-8 w-8 place-items-center transition-colors touch:h-[44px] touch:w-[44px]',
              open ? 'hover:bg-black/10' : 'hover:bg-bg0',
              busy && 'cursor-not-allowed opacity-40',
            )}
          >
            {busy ? <Spinner size={14} /> : <Icon name="download" size={15} />}
          </button>
          <span className={cx('h-4 w-px', open ? 'bg-on-honey/30' : 'bg-line1')} aria-hidden="true" />
          <button
            type="button"
            onClick={toggle}
            title={t('download.moreWays')}
            aria-label={t('download.moreWays')}
            aria-haspopup="menu"
            aria-expanded={open}
            className={cx(
              // 21px wide, and the only door to Share, the stamped save and the
              // sound split. Half a finger under a thumb.
              'grid h-8 w-6 place-items-center transition-colors touch:h-[44px] touch:w-[44px]',
              open ? 'hover:bg-black/10' : 'hover:bg-bg0',
            )}
          >
            <Icon name="chevronDown" size={13} />
          </button>
        </div>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon="download"
            disabled={!allowed || !settings || Boolean(busy)}
            onClick={() => void runStamped(close)}
            title={settings
              ? t('download.unencryptedHint')
              : t('download.noSettingsRecorded')}
          >
            {busy === 'settings' ? t('download.writingSettings') : t('download.unencrypted')}
          </MenuItem>
          <MenuItem
            icon="share"
            disabled={!canShare || Boolean(busy)}
            onClick={() => void runShare(close)}
            title={canShare ? t('download.shareHint') : t('download.shareUnsupported')}
          >
            {t('download.share')}
          </MenuItem>

          {/* The switch, under the row it governs. Not a MenuItem: pressing it
              must not close the menu, because the point is to see the row above
              stop being grey. */}
          <div className="mt-1 border-t border-line1 px-2.5 pb-1 pt-2">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-[12.5px] text-ink2">{t('download.allowUnencrypted')}</span>
              <Toggle
                checked={allowed}
                label={t('download.allowUnencrypted')}
                onChange={(next) => setAllowed(setAllowUnencryptedDownload(studio, next))}
              />
            </div>
            <p className="mt-1 text-[11px] leading-snug text-ink3">
              {t('download.allowUnencryptedHint')}
            </p>
          </div>

          {/* A clip is a picture AND a soundtrack, and an editor wants them
              apart more often than together. Video only: a still has neither
              half to take. BELOW the switch, not above it: the switch has to
              stay touching the row it governs, or a grey "Download
              unencrypted" stops explaining itself. */}
          {studio === 'video' ? (
            <>
              <div className="mb-0.5 mt-1.5 h-px bg-line1" />
              <MenuItem
                icon="music"
                disabled={Boolean(busy)}
                onClick={() => void runTrack(close, 'audio')}
                title={t('sound.audioOnlyHint')}
              >
                {busy === 'audio' ? t('sound.working') : t('sound.audioOnly')}
              </MenuItem>
              <MenuItem
                icon="film"
                disabled={Boolean(busy)}
                onClick={() => void runTrack(close, 'silent')}
                title={t('sound.silentVideoHint')}
              >
                {busy === 'silent' ? t('sound.working') : t('sound.silentVideo')}
              </MenuItem>
              <MenuItem
                icon="scissors"
                disabled={Boolean(busy)}
                onClick={() => { close(); setSplitting(true); }}
                title={t('sound.splitHint')}
              >
                {t('sound.split')}
              </MenuItem>
            </>
          ) : null}
        </>
      )}
    </Menu>
    {splitting ? (
      <Suspense fallback={null}>
        <SoundSplitDialogLazy url={url} filename={filename} onClose={() => setSplitting(false)} />
      </Suspense>
    ) : null}
    </>
  );
}
