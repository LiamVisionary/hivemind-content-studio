// Muapi API-key entry modal (React port of the retired vanilla studio).
// Contract preserved: trimmed key -> localStorage 'muapi_key', close, then onSaved
// (the UploadPicker retry continuation). Empty submit aborts with inline feedback.
import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Field, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

export function AuthModal({ onClose, onSaved }) {
  const [key, setKey] = useState('');
  const [invalid, setInvalid] = useState(false);

  const save = (event) => {
    event?.preventDefault?.();
    const trimmed = key.trim();
    if (!trimmed) {
      // Old UI flashed a red border for 2s with no message; keep the abort
      // semantics but show a persistent inline error until the field changes.
      setInvalid(true);
      return;
    }
    localStorage.setItem('muapi_key', trimmed);
    onClose?.();
    onSaved?.();
  };

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
          hint={invalid ? undefined : t('auth.keyNote')}
          error={invalid ? t('settings.invalidKey') : undefined}
        >
          <TextInput
            type="password"
            autoFocus
            placeholder={t('auth.keyPlaceholder')}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (invalid) setInvalid(false);
            }}
            className={invalid ? 'border-danger/60' : ''}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Button type="submit" variant="primary" size="lg" className="w-full">
            {t('auth.initBtn')}
          </Button>
          {/* The icon says "opens muapi.ai in a new tab"; the label must not
              carry its own arrow as well (the zh string still ends in one). */}
          <a
            href="https://muapi.ai/access-keys"
            target="_blank"
            rel="noreferrer"
            title="Opens muapi.ai in a new tab"
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
