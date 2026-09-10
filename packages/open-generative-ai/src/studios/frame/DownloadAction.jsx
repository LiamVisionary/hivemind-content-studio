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
import { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';

import { t } from '../../lib/i18n.js';
import { canShareMedia, downloadMediaWithSettings, shareMedia } from '../../lib/mediaExport.js';
import { allowsUnencryptedDownload, setAllowUnencryptedDownload, subscribePrefs } from '../../lib/prefs.js';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuItem } from '../../ui/Menu.jsx';
import { Spinner, Toggle, cx } from '../../ui/kit.jsx';

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
    <Menu
      align="end"
      width="w-[268px]"
      trigger={(open, toggle) => (
        // One pill, two halves. The divider is what says "these are two
        // buttons" — without it the arrow reads as decoration on a wide button.
        <div
          className={cx(
            'flex h-8 items-center overflow-hidden rounded-full backdrop-blur transition-colors',
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
              'grid h-8 w-8 place-items-center transition-colors',
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
              'grid h-8 w-6 place-items-center transition-colors',
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
        </>
      )}
    </Menu>
  );
}
