// What the Model section says about a workflow you dropped in that did not
// become a model.
//
// Owner rule: never present a problem without its fix in the same component.
// Before this, a drop-in the loader could not read simply never appeared —
// inspectAutoWorkflow returned null and the loop moved on — so the person who
// exported that file had no way to learn anything at all. Each row names the
// file, says what is wrong with it in a sentence they can act on, and the
// component carries the one action that changes the outcome: fix it on disk and
// check again.
//
// It renders nothing when the folder is clean, which is almost always, so it
// costs a healthy machine no room in the panel.
import { Button, cx } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import { t } from '../lib/i18n.js';

/**
 * @param {object} props
 * @param {Array<{file: string, reason: string}>} props.skipped from /local-ai/workflow-drop-ins
 * @param {string[]} props.directories the folders that were scanned
 * @param {function} props.onCheckAgain re-runs discovery
 */
export function WorkflowDropInNotice({ skipped = [], directories = [], onCheckAgain = null, className = '' }) {
  if (!skipped.length) return null;
  return (
    <div
      className={cx('rounded-md border border-line1 bg-bg2 px-3 py-3', className)}
      data-testid="workflow-drop-in-notice"
    >
      <div className="flex items-start gap-2">
        <Icon name="warning" size={14} className="mt-[2px] shrink-0 text-honey" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-ink1">
            {skipped.length === 1 ? t('dropIns.titleOne') : t('dropIns.title')}
          </div>
          {/* The file and the reason, not a count. A count tells someone that
              something of theirs is missing without telling them which. */}
          <ul className="mt-2 flex flex-col gap-1">
            {skipped.map((entry) => (
              <li key={entry.file} className="text-[11px] leading-relaxed text-ink3">
                <span className="break-all font-medium text-ink2">{entry.file}</span>
                {' — '}
                {entry.reason}
              </li>
            ))}
          </ul>
          {directories.length ? (
            <div className="mt-2 text-[11px] text-ink3">
              {t('dropIns.folder')}{' '}
              {/* break-all, because these are absolute paths and a panel this
                  narrow would otherwise push the whole drawer sideways. */}
              <span className="break-all font-mono">{directories.join(', ')}</span>
            </div>
          ) : null}
          <div className="mt-1 text-[11px] text-ink3">{t('dropIns.hint')}</div>
          {onCheckAgain ? (
            <div className="mt-2">
              <Button size="sm" variant="neutral" icon="refresh" onClick={onCheckAgain}>
                {t('common.checkAgain')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
