// The one place a MUAPI key is entered.
//
// It used to write `localStorage.muapi_key` and nothing else, which put a
// paid credential in the browser on a machine that already has a credential
// store. It now hands the key to lib/muapiKey.js, which saves it as
// MUAPI_API_KEY in this machine's shared store when the studio is there and
// falls back to the browser only for the standalone build. Either way the
// client's cached route is forgotten before `onSaved` runs, so the retry
// continuation the caller passed (the picker's held files, a re-entered
// generate) works on the very next call without a reload.
import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { isHivemindStudioEnabled } from '../lib/hivemindStudio.js';
import { storeMuapiKey } from '../lib/muapiKey.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

export function AuthModal({ onClose, onSaved }) {
  const [key, setKey] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (event) => {
    event?.preventDefault?.();
    const trimmed = key.trim();
    if (!trimmed) {
      // Old UI flashed a red border for 2s with no message; keep the abort
      // semantics but show a persistent inline error until the field changes.
      setInvalid(true);
      return;
    }
    setSaving(true);
    setFailure('');
    try {
      await storeMuapiKey(trimmed);
    } catch (error) {
      // The store refused this value for a reason the owner has to act on.
      // Shown here, beside the field that caused it — never a page away.
      setSaving(false);
      setFailure(error?.detail?.message || error?.message || t('settings.invalidKey'));
      return;
    }
    setSaving(false);
    onClose?.();
    onSaved?.();
  };

  // Where the key will land, said BEFORE it is pasted rather than after.
  const note = isHivemindStudioEnabled() ? t('auth.storedOnMachine') : t('settings.keyInBrowser');

  return (
    <Modal open onClose={onClose} title={t('auth.title')} size="md">
      <form onSubmit={save} className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="key" size={16} />
          </span>
          <p className="text-[13px] leading-relaxed text-ink2">{t('auth.subtitle')}</p>
        </div>

        <Field
          label={t('auth.keyLabel')}
          hint={invalid || failure ? undefined : `${t('auth.keyNote')} ${note}`}
          error={failure || (invalid ? t('settings.invalidKey') : undefined)}
        >
          <TextInput
            type="password"
            autoFocus
            placeholder={t('auth.keyPlaceholder')}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (invalid) setInvalid(false);
              if (failure) setFailure('');
            }}
            className={invalid || failure ? 'border-danger/60' : ''}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={saving}>
            {saving ? t('auth.saving') : t('auth.initBtn')}
          </Button>
          {/* The icon says "opens muapi.ai in a new tab"; the label must not
              carry its own arrow as well (the zh string still ends in one). */}
          <a
            href="https://muapi.ai/access-keys"
            target="_blank"
            rel="noreferrer"
            title={t('auth.opensInTab')}
            className="inline-flex items-center justify-center gap-1.5 py-1.5 text-center text-xs font-medium text-ink3 transition-colors hover:text-ink1"
          >
            {String(t('auth.createKey')).replace(/\s*→\s*$/, '')}
            <Icon name="external" size={12} aria-hidden="true" />
          </a>
        </div>
      </form>
    </Modal>
  );
}
