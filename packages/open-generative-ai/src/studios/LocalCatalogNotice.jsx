// What the Model section says when there is nothing local to pick, and what to
// press about it.
//
// Owner rule: never present a problem without its fix in the same component.
// "No models" on its own sent people looking for a settings screen; each state
// here carries the one action that resolves it — check the engine again, or go
// install a model. There is deliberately no "Restart engine": the shell does
// not own the engine's lifecycle yet, and a button that cannot do what it says
// is worse than no button.
//
// One state is not about models at all. ComfyUI is OPTIONAL: the studio boots
// without one, and cloud and rented models keep working. On a machine with no
// ComfyUI connected, "no image model installed" is the wrong sentence and
// "Open Models" is the wrong button — nothing downloaded there can run. That
// case says "Connect ComfyUI" and opens the card on the Machines page, which is
// the only action that changes anything. It is checked ONLY when the section
// already has nothing to offer, so a healthy machine never pays for the probe.
import { Button, EmptyState, Spinner, cx } from '../ui/kit.jsx';
import { t } from '../lib/i18n.js';
import { useComfyConnection } from '../lib/comfyConnection.js';
import { navigateHub } from '../hub/hubData.js';

const openModels = () => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }));
const openConnectComfy = () => navigateHub('machines');

/** One sentence per status — shared so Image, Story and Sprite say the same thing. */
export function localCatalogSentence(status) {
  if (status === 'no-comfy') return t('setup.comfyNotConnected');
  if (status === 'unreachable') return t('localModels.engineStarting');
  if (status === 'empty') return t('setup.noImageModel');
  if (status === 'discovering') return t('setup.discovering');
  return '';
}

/**
 * The Model section's stand-in while nothing local can be picked.
 *
 * `onCheckAgain` re-runs discovery; `onSwitchToCloud` is optional and only
 * offered where a source switch exists to make. `comfyConnected` is tri-state:
 * `false` means this machine has no ComfyUI answering (the Connect state),
 * `null` means it has not been established and the model-shaped sentences stand.
 */
export function LocalCatalogNotice({
  status,
  onCheckAgain,
  onSwitchToCloud = null,
  className = '',
  comfyConnected = undefined,
}) {
  // Asked only from this component, and only while the section is already
  // empty. A picker with local rows never renders this, so never probes.
  const probed = useComfyConnection(comfyConnected === undefined && status !== 'ready');
  const connected = comfyConnected === undefined ? probed.connected : comfyConnected;

  if (status === 'ready') return null;

  if (status === 'discovering') {
    return (
      <div className={cx('flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-3 text-xs text-ink3', className)}>
        <Spinner size={14} className="text-honey" />
        {localCatalogSentence('discovering')}
      </div>
    );
  }

  // Wins over both sentences below: with no engine attached there is nothing to
  // install into and nothing to wait for.
  if (connected === false) {
    return (
      <div className={cx('rounded-md border border-line1 bg-bg2', className)} data-testid="connect-comfy-notice">
        <EmptyState
          icon="cpu"
          className="px-4 py-8"
          title={localCatalogSentence('no-comfy')}
          hint={t('setup.comfyHint')}
          action={(
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" icon="plug" onClick={openConnectComfy}>
                {t('common.connectComfy')}
              </Button>
              {onSwitchToCloud
                ? <Button size="sm" variant="neutral" icon="cloud" onClick={onSwitchToCloud}>{t('common.switchToCloud')}</Button>
                : null}
            </div>
          )}
        />
      </div>
    );
  }

  if (status === 'empty') {
    return (
      <div className={cx('rounded-md border border-line1 bg-bg2', className)}>
        <EmptyState
          icon="cpu"
          className="px-4 py-8"
          title={localCatalogSentence('empty')}
          hint={t('setup.noImageModelHint')}
          action={<Button size="sm" icon="download" onClick={openModels}>{t('common.openModels')}</Button>}
        />
      </div>
    );
  }

  return (
    <div className={cx('rounded-md border border-line1 bg-bg2', className)}>
      <EmptyState
        icon="cpu"
        className="px-4 py-8"
        title={localCatalogSentence('unreachable')}
        hint={t('setup.engineHint')}
        action={(
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" icon="refresh" onClick={onCheckAgain}>{t('common.checkAgain')}</Button>
            {onSwitchToCloud
              ? <Button size="sm" variant="neutral" icon="cloud" onClick={onSwitchToCloud}>{t('common.switchToCloud')}</Button>
              : null}
          </div>
        )}
      />
    </div>
  );
}
