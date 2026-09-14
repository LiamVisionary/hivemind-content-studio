// Sharing credits with other workspaces: pick the cards, or lend to everyone.
//
// Every workspace on this Mac holds its own HivemindOS account, so a second
// person signing in no longer finds the first person's balance under their
// own name. What this sheet hands out is the one thing a workspace may give
// another: the right to SPEND its credits. The key never moves — the studio
// reads the sharer's policy at spend time — and the sharer's name, email,
// recovery key and plans stay the sharer's.
//
// Two ways to say who, and they are drawn as two controls rather than one
// list with an "all" row in it: the cards are a choice made today, and the
// toggle is a rule that also covers workspaces added tomorrow. With the rule
// on, the cards are shown selected and locked, so the sheet does not appear
// to offer a choice it would ignore.
import { useState } from 'react';
import toast from 'react-hot-toast';

import { setCreditShare } from '../lib/account.js';
import { t, tf } from '../lib/i18n.js';
import { announceAccountChanged } from '../app/AccountRow.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Toggle, cx } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

// The gate's tile colours, in the kit's own tones. The honey accent is the one
// coloured tile; the rest are neutrals, as the picker draws them.
const TILE = {
  amber: 'bg-honey-tint text-honey',
  sand: 'bg-bg3 text-ink1',
  stone: 'bg-bg3 text-ink2',
  slate: 'bg-bg3 text-ink3',
};

/**
 * Which ids the sheet should submit. Pure, so it can be asserted without a
 * render: with the rule on, the picks are KEPT rather than cleared — turning
 * the rule off again later gives back the choice that was made, instead of
 * an empty sheet.
 */
export function shareSelection({ everyone, chosen }) {
  return { everyone: Boolean(everyone), workspaces: [...chosen].map(Number).sort((a, b) => a - b) };
}

/** One workspace as a card: the gate's tile, drawn in the app's kit. */
export function WorkspaceCard({ workspace, on, locked, onToggle }) {
  const initial = String(workspace.name || '').trim().charAt(0).toUpperCase() || '?';
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={locked}
      aria-pressed={on}
      aria-label={tf(on ? 'credits.shareCardOn' : 'credits.shareCardOff', workspace.name)}
      className={cx(
        'flex items-center gap-3 rounded-[10px] border px-3 py-[11px] text-left transition-all duration-150 ease-swift',
        on ? 'border-honey bg-honey-tint' : 'border-line1 bg-bg2',
        locked ? 'cursor-default' : 'hover:border-line2',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'grid h-9 w-9 shrink-0 place-items-center rounded-full text-[15px] font-semibold',
          TILE[workspace.colour] || TILE.amber,
        )}
      >
        {initial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-semibold text-ink1">{workspace.name}</span>
        {workspace.isOwner ? (
          <span className="text-[11px] text-ink3">{t('credits.shareOwnerBadge')}</span>
        ) : null}
      </span>
      <span
        className={cx(
          'grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors duration-150',
          on ? 'border-honey bg-honey text-on-honey' : 'border-line2 text-transparent',
        )}
      >
        <Icon name="check" size={12} />
      </span>
    </button>
  );
}

export function ShareCreditsDialog({ sharing, onClose, onSaved }) {
  const workspaces = sharing?.workspaces || [];
  const [everyone, setEveryone] = useState(Boolean(sharing?.all));
  // The picks as the studio holds them, not as the cards happen to be lit: with
  // the rule on every card is lit, and reading the picks off the cards would
  // turn "everyone" off into "everyone, by hand".
  const [chosen, setChosen] = useState(() => new Set((sharing?.with || []).map(Number)));
  const [busy, setBusy] = useState(false);

  const toggle = (id) => setChosen((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const save = async () => {
    setBusy(true);
    try {
      await setCreditShare(shareSelection({ everyone, chosen }));
      toast.success(t('credits.shareSaved'));
      announceAccountChanged();
      onSaved?.();
      onClose?.();
    } catch (error) {
      toast.error(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  const count = everyone ? workspaces.length : [...chosen].filter((id) => workspaces.some((w) => w.id === id)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('credits.shareTitle')}
      size="md"
      footer={
        <>
          <span className="min-w-[160px] flex-1 text-[11px] leading-[1.45] text-ink3">
            {workspaces.length ? tf('credits.shareCount', count, workspaces.length) : ''}
          </span>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" loading={busy} disabled={!workspaces.length} onClick={() => void save()}>
            {t('credits.shareSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12.5px] leading-relaxed text-ink2">{t('credits.shareHint')}</p>

        {workspaces.length ? (
          <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={t('credits.shareTitle')}>
            {workspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                on={everyone || chosen.has(workspace.id)}
                locked={everyone}
                onToggle={() => toggle(workspace.id)}
              />
            ))}
          </div>
        ) : (
          <p className="rounded-[10px] border border-dashed border-line1 px-4 py-5 text-center text-[12px] text-ink3">
            {t('credits.shareNobodyYet')}
          </p>
        )}

        <label className="flex items-center gap-3 rounded-[10px] border border-line1 bg-bg2 px-[13px] py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold text-ink1">{t('credits.shareEveryone')}</span>
            <span className="text-[11.5px] leading-[1.45] text-ink3">{t('credits.shareEveryoneHint')}</span>
          </span>
          <Toggle
            checked={everyone}
            disabled={!workspaces.length}
            onChange={setEveryone}
            label={t('credits.shareEveryone')}
          />
        </label>
      </div>
    </Modal>
  );
}
