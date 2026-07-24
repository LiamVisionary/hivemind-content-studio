// Settings modal (React port of components/SettingsModal.js).
// Contracts preserved: API key seeded from localStorage 'muapi_key' at open;
// Save trims + rejects empty (t('settings.invalidKey')) + writes the key + closes;
// Cancel/X/backdrop/Escape close WITHOUT saving; the Local Models tab exists only
// when isLocalAIAvailable() and its panel stays MOUNTED across tab switches so
// in-flight downloads keep their progress subscriptions (old persistent-node
// behavior). Adds a Language section (the sidebar toggle's setting, surfaced here).
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useLang } from '../hooks/hooks.js';
import { getLang, setLang, t } from '../lib/i18n.js';
import { isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { Button, Divider, Field, SectionLabel, Segmented, Tabs, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';
import { LocalModelManager } from './LocalModelManager.jsx';

export function SettingsModal({ onClose }) {
  const { zh } = useLang();
  const hasLocalAI = isLocalAIAvailable();
  const [tab, setTab] = useState('api');
  // Seeded at mount — the modal remounts per open (App renders it lazily), so a
  // key changed via AuthModal in between is always re-read.
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('muapi_key') || '');

  const tabs = [
    { value: 'api', label: t('settings.apiKey') },
    ...(hasLocalAI ? [{ value: 'local', label: t('settings.localModels') }] : []),
  ];

  const save = () => {
    const key = apiKey.trim();
    if (!key) {
      // Same gating as the old alert(t('settings.invalidKey')): abort, stay open.
      toast.error(t('settings.invalidKey'));
      return;
    }
    localStorage.setItem('muapi_key', key);
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
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={save}>
              {t('common.save')}
            </Button>
          </>
        ) : null
      }
    >
      {tabs.length > 1 ? <Tabs tabs={tabs} value={tab} onChange={setTab} className="-mt-1 mb-4" /> : null}

      {/* API key + preferences */}
      <div className={tab === 'api' ? 'flex flex-col gap-4' : 'hidden'}>
        <Field label={t('settings.muapiKeyLabel')} hint={t('settings.keyNote')}>
          <TextInput
            type="password"
            placeholder={t('settings.keyPlaceholder')}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
        </Field>

        <Divider />

        <div className="flex items-center justify-between gap-3">
          <div>
            <SectionLabel>{zh ? '语言' : 'Language'}</SectionLabel>
            <p className="mt-1 text-xs text-ink3">
              {zh ? '切换界面语言（页面将重新加载）。' : 'Switch the interface language (the page reloads).'}
            </p>
          </div>
          <Segmented
            options={[
              { value: 'en', label: 'English' },
              { value: 'zh-CN', label: '中文' },
            ]}
            value={getLang() === 'zh-CN' ? 'zh-CN' : 'en'}
            onChange={(lang) => {
              if (lang !== getLang()) setLang(lang); // keeps its page-reload behavior
            }}
          />
        </div>
      </div>

      {/* Local models — mounted once per modal open, hidden (not unmounted) on tab
          switch so in-flight download progress keeps rendering. */}
      {hasLocalAI ? (
        <div className={tab === 'local' ? '' : 'hidden'}>
          <LocalModelManager />
        </div>
      ) : null}
    </Modal>
  );
}
