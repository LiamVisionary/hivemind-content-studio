// Settings > Privacy — what is sealed to your key, and what is only encrypted
// on this Mac.
//
// This panel exists because the sign-in gate used to promise more than the code
// delivers: "each workspace keeps its own encryption key, nothing in one can be
// opened from another". True of the vault and of sealed media, which are per
// account. Not true of run files — briefs, scripts, prompt lists — which are
// written with one process-wide cipher whose key lives in this Mac's keychain,
// where any process running as you can read it, and which the owner can read
// across workspaces. The gate now says the narrower true thing and points here
// for the detail, so somebody deciding what to keep in which workspace is
// deciding on the real boundary.
import { toast } from 'react-hot-toast';
import { clearOwnerHandoff, resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Button, SectionLabel } from '../ui/kit.jsx';
import { t } from '../lib/i18n.js';

function Row({ icon, tone, title, items }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
      <Icon name={icon} size={18} className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-tight text-ink1">{title}</p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {items.map((item) => (
            <li key={item} className="text-xs leading-relaxed text-ink2">{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function PrivacyPanel({ onClose }) {

  // Adding a workspace happens on the sign-in screen, which needs this session
  // closed first — the same lock the topbar button performs, so a half-signed-in
  // state is impossible either way.
  const addWorkspace = async () => {
    window.dispatchEvent(new Event('hivemind-owner-lock-broadcast'));
    clearOwnerHandoff();
    resetVaultSession();
    try {
      await fetch('/api/owner/lock', { method: 'POST' });
    } catch {
      toast.error('Could not lock the studio — try again');
      return;
    }
    onClose?.();
    location.href = '/?workspace=new';
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionLabel>{t('privacy.twoKeys')}</SectionLabel>
        <p className="mt-1 text-xs leading-relaxed text-ink3">
          {t('privacy.twoKeysBlurb')}
        </p>
      </div>

      <Row
        icon="shield"
        tone="text-honey"
        title={t('privacy.sealedToYourKey')}
        items={[
          t('privacy.yourKeyLibrary'),
          t('privacy.yourKeyDrafts'),
          t('privacy.yourKeyOnlyYou'),
        ]}
      />

      <Row
        icon="lock"
        tone="text-ink2"
        title={t('privacy.macKey')}
        items={[
          t('privacy.macKeyRunFiles'),
          t('privacy.macKeyKeychain'),
          t('privacy.macKeyOwnerSees'),
        ]}
      />

      <p className="text-xs leading-relaxed text-ink3">
        {t('privacy.neitherLeaves')}
      </p>

      <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
        <div className="min-w-0">
          <SectionLabel>{t('privacy.workspaces')}</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-ink3">
            {t('privacy.workspacesBlurb')}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={addWorkspace}>
          {t('privacy.addWorkspace')}
        </Button>
      </div>
    </div>
  );
}
