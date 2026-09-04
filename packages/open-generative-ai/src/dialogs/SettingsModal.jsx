// Settings modal (React port of the retired vanilla studio).
// Contracts preserved: Save trims + rejects empty (t('settings.invalidKey')) +
// stores the key + closes; Cancel/X/backdrop/Escape close WITHOUT saving; the
// Local Models tab exists only when isLocalAIAvailable() and its panel stays
// MOUNTED across tab switches so in-flight downloads keep their progress
// subscriptions (old persistent-node behavior).
//
// What changed: the key field is no longer a second door onto localStorage. It
// writes through lib/muapiKey.js like every other entry point, and when this
// machine already holds MUAPI_API_KEY it becomes a status line instead — asking
// for a key the machine has is the prompt this whole gate exists to remove.
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useLang } from '../hooks/hooks.js';
import { t } from '../lib/i18n.js';
import { isHostedLocalAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { muapiKeyIsOnServer } from '../lib/modelRunner.js';
import { browserMuapiKey, forgetBrowserMuapiKey, storeMuapiKey } from '../lib/muapiKey.js';
import { Button, Field, SectionLabel, Tabs, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';
import { LocalModelManager } from './LocalModelManager.jsx';
import { PrivacyVaultPanel } from './PrivacyVaultPanel.jsx';

export function SettingsModal({ onClose }) {
  const { zh } = useLang();
  // Only the desktop build manages its own weights. In hosted mode these controls
  // are no-ops (install/download/delete all resolve without doing anything), and the
  // Models view is the real manager — so this section stays out of the way there.
  const hasLocalAI = isLocalAIAvailable() && !isHostedLocalAI();
  const [tab, setTab] = useState('api');
  // Seeded at mount — the modal remounts per open (App renders it lazily), so a
  // key changed via AuthModal in between is always re-read.
  const [apiKey, setApiKey] = useState(() => browserMuapiKey());
  const [saving, setSaving] = useState(false);
  // This machine holds the key (seeded at boot by lib/muapiKey.js). Then there
  // is nothing to type here: the field would collect a second copy of a secret
  // the cloud route never reads.
  const onMachine = muapiKeyIsOnServer();

  const tabs = [
    { value: 'api', label: t('settings.apiKey') },
    ...(hasLocalAI ? [{ value: 'local', label: t('settings.localModels') }] : []),
    // The only place a signed-in person can change their password or mint a new
    // recovery key. Before this existed, forgetting a password lost the library.
    { value: 'vault', label: zh ? '隐私与保险库' : 'Privacy & vault' },
  ];

  const hadKey = Boolean(browserMuapiKey());
  const save = async (event) => {
    event?.preventDefault?.();
    const key = apiKey.trim();
    if (!key) {
      if (hadKey) {
        // An emptied field is the only way to forget a stored key.
        forgetBrowserMuapiKey();
        toast.success(zh ? '已移除 API 密钥' : 'API key removed');
        onClose?.();
        return;
      }
      // Same gating as the old alert(t('settings.invalidKey')): abort, stay open.
      toast.error(t('settings.invalidKey'));
      return;
    }
    setSaving(true);
    let where = 'browser';
    try {
      ({ where } = await storeMuapiKey(key));
    } catch (error) {
      setSaving(false);
      toast.error(error?.detail?.message || error?.message || t('settings.invalidKey'));
      return;
    }
    setSaving(false);
    toast.success(where === 'machine'
      ? (zh ? '密钥已保存到本机的共享凭据库' : 'Key saved to this machine’s shared store')
      : (zh ? '已保存 API 密钥' : 'API key saved'));
    onClose?.();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('settings.title')}
      size="lg"
      footer={
        tab === 'api' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {onMachine ? (zh ? '关闭' : 'Close') : t('common.cancel')}
            </Button>
            {/* Nothing to save when the machine holds the key — the tab is a
                status line, and PassBook is where it is changed or removed. */}
            {onMachine ? null : (
              <Button variant="primary" type="submit" form="settings-api-form" disabled={saving}>
                {t('common.save')}
              </Button>
            )}
          </>
        ) : null
      }
    >
      {tabs.length > 1 ? <Tabs tabs={tabs} value={tab} onChange={setTab} className="-mt-1 mb-4" /> : null}

      {/* API key + preferences — a form so Enter saves like any one-field dialog. */}
      <form id="settings-api-form" onSubmit={save} className={tab === 'api' ? 'flex flex-col gap-4' : 'hidden'}>
        {onMachine ? (
          // A status line, not a field: this machine holds MUAPI_API_KEY and
          // cloud work already runs through it. The one action is the place the
          // key can actually be changed or removed.
          <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
            <div>
              <SectionLabel>{t('settings.keyOnMachine')}</SectionLabel>
              <p className="mt-1 text-xs leading-relaxed text-ink3">{t('settings.keyOnMachineNote')}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => {
                onClose?.();
                window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'passbook' } }));
              }}
            >
              {t('settings.manageKeys')}
            </Button>
          </div>
        ) : (
          <Field label={t('settings.muapiKeyLabel')} hint={hadKey ? `${t('settings.keyNote')} ${zh ? '清空后保存即可移除。' : 'Clear the field and save to remove it.'}` : t('settings.keyNote')}>
            <TextInput
              type="password"
              placeholder={t('settings.keyPlaceholder')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              autoFocus
            />
          </Field>
        )}

        {/* Language lived here. This build ships one language — LANGS_ENABLED in
            lib/i18n.js — because zh-CN covered the toolbars and left three
            studios, every dialog and most of the hub in English. The control
            comes back with the key table that makes the translation whole, and
            the stored choice is kept meanwhile, so it returns on the language
            the person last picked. */}
      </form>

      {/* Local models — mounted once per modal open, hidden (not unmounted) on tab
          switch so in-flight download progress keeps rendering. */}
      {hasLocalAI ? (
        <div className={tab === 'local' ? '' : 'hidden'}>
          <LocalModelManager />
        </div>
      ) : null}

      {/* Mounted only while shown: it holds password fields, and there is no
          in-flight work to keep alive across a tab switch. */}
      {tab === 'vault' ? <PrivacyVaultPanel onDone={onClose} /> : null}
    </Modal>
  );
}
