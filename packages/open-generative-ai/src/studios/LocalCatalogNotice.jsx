// What the Model section says when there is nothing local to pick, and what to
// press about it.
//
// Owner rule: never present a problem without its fix in the same component.
// "No models" on its own sent people looking for a settings screen; each state
// here carries the one action that resolves it — check the engine again, or go
// install a model. There is deliberately no "Restart engine": the shell does
// not own the engine's lifecycle yet, and a button that cannot do what it says
// is worse than no button.
import { Button, EmptyState, Spinner, cx } from '../ui/kit.jsx';
import { getLang } from '../lib/i18n.js';

const zh = () => getLang() === 'zh-CN';

const openModels = () => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }));

/** One sentence per status — shared so Image, Story and Sprite say the same thing. */
export function localCatalogSentence(status) {
  if (status === 'unreachable') {
    return zh() ? '本地引擎正在启动——它还没有响应。' : 'The local engine is starting — it has not answered yet.';
  }
  if (status === 'empty') {
    return zh() ? '尚未安装图像模型。' : 'No image model installed yet.';
  }
  if (status === 'discovering') {
    return zh() ? '正在查看这台机器能运行什么…' : 'Looking at what this machine can run…';
  }
  return '';
}

/**
 * The Model section's stand-in while nothing local can be picked.
 *
 * `onCheckAgain` re-runs discovery; `onSwitchToCloud` is optional and only
 * offered where a source switch exists to make.
 */
export function LocalCatalogNotice({ status, onCheckAgain, onSwitchToCloud = null, className = '' }) {
  if (status === 'ready') return null;

  if (status === 'discovering') {
    return (
      <div className={cx('flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-3 py-3 text-xs text-ink3', className)}>
        <Spinner size={14} className="text-honey" />
        {localCatalogSentence('discovering')}
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
          hint={zh()
            ? '安装一个模型后，它会出现在这里。'
            : 'Install one and it shows up here.'}
          action={<Button size="sm" icon="download" onClick={openModels}>{zh() ? '打开模型' : 'Open Models'}</Button>}
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
        hint={zh()
          ? '它启动后会自动出现在这里，或者现在改用云端。'
          : 'It appears here as soon as it answers — or use the cloud for this one.'}
        action={(
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" icon="refresh" onClick={onCheckAgain}>{zh() ? '再试一次' : 'Check again'}</Button>
            {onSwitchToCloud
              ? <Button size="sm" variant="neutral" icon="cloud" onClick={onSwitchToCloud}>{zh() ? '改用云端' : 'Switch to cloud'}</Button>
              : null}
          </div>
        )}
      />
    </div>
  );
}
