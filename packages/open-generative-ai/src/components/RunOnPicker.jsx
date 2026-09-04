// "Runs on: This Mac · Z-Image Turbo — free, stays here"
//
// One control for a question every studio was asking differently. It replaces
// the Image and Video studios' Local / API / Rented segmented control, and it
// speaks the text producer's vocabulary, because that one was already right:
// a section is a BILL, and there are three of them.
//
//   This Mac            free, private, as fast as the hardware
//   HivemindOS credits  one balance, the same one the HivemindOS app spends
//   Your accounts       billed to an account you already pay for
//
// A rented GPU is not a fourth group. It is what This Mac's work is landing on
// right now, so it appears as the place NAME on the readout ("Runs on: RTX 5090
// · $0.42/hr") with the per-tab pin behind the readout as the override — the
// same pin the gateway honours, unchanged. There is no rented MODE to be in
// with nothing rented, which is what the old segment offered.
//
// The default is Automatic (runTargets.pickRunTarget) and it says WHY in one
// line. One click overrides it, and the override is this tab's.
import { useState } from 'react';

import { RATING_LABELS, RATING_TONE } from '../lib/capabilityMatrix.js';
import { PLACE_THIS_MAC, groupRunTargets, readoutText, runOnReadout } from '../lib/runTargets.js';
import { RentedSourceStatus } from '../studios/RentedSourceStatus.jsx';
import { t } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Pill, SectionLabel, cx } from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';

/** One row: the model, where it runs, and — when it cannot — why not, on the
 *  row rather than at the press. */
function TargetRow({ target, selected, onSelect, readiness = null, onFixReadiness = null, busyAction = '' }) {
  // The place, never the provider id: "This Mac", "RTX 5090 · $0.42/hr",
  // "Your OpenAI account", "HivemindOS credits".
  const meta = target.machine
    ? `${target.placeLabel} · $${(Number(target.machine.usd_per_hour) || 0).toFixed(2)}/hr`
    // A row that IS its own place says it once, not twice.
    : (target.placeLabel === target.label ? '' : target.placeLabel);
  // Why the row is rated the way it is, or why it cannot run at all. It used to
  // live only on the fit picker's cards, and dropping it here would have made
  // this control worse than the two it replaces in Story and Sprite.
  const blocked = readiness && readiness.state !== 'ready';
  // Said once. A row whose readiness block already carries the sentence must
  // not print it again two lines above itself.
  const note = target.ready
    ? (target.ratingReason || '')
    : (blocked && readiness.detail ? '' : target.reason);
  const actionKey = readiness?.action ? `${readiness.action.kind}:${readiness.action.provider || target.key}` : '';
  return (
    <div className="flex flex-col">
      <MenuItem
        selected={selected}
        disabled={!target.ready}
        meta={meta}
        title={note}
        onClick={() => { if (target.ready) onSelect(target); }}
      >
        <span className="flex min-w-0 flex-col">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{target.label}</span>
            {target.badge ? (
              <Pill tone={target.badge.tone || 'neutral'} className="h-4 shrink-0 px-1.5 text-[9px]">
                {target.badge.label}
              </Pill>
            ) : null}
            {target.rating ? (
              <Pill tone={RATING_TONE[target.rating] || 'neutral'} className="h-4 shrink-0 px-1.5 text-[9px]">
                {RATING_LABELS[target.rating] || target.rating}
              </Pill>
            ) : null}
          </span>
          {note ? <span className="line-clamp-2 text-[11px] leading-snug text-ink3">{note}</span> : null}
        </span>
      </MenuItem>
      {/* The state of the account, and the button that repairs it, under the row
          that offers the model — never nested INSIDE it, because a button inside
          a disabled button never receives a click. */}
      {blocked ? (
        <div className={cx('flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5 text-[10px] leading-snug',
          readiness.blocks ? 'text-warn' : 'text-ink3')}
        >
          <b>{readiness.label}</b>
          {readiness.detail ? <span className="opacity-90">{readiness.detail}</span> : null}
          {readiness.action && onFixReadiness ? (
            <Button
              size="sm"
              icon={readiness.state === 'reconnect' ? 'refresh' : 'key'}
              loading={busyAction === actionKey}
              onClick={() => onFixReadiness(readiness.action, target)}
            >
              {readiness.action.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The list behind the readout: three groups, never four.
 *
 * `automatic` sits at the top as a real row, so choosing it again is possible
 * after an override — the alternative (a default you can leave but not return
 * to) is how per-tab pins became permanent by accident.
 */
export function RunOnList({
  targets, value, onChange, automatic = null, onAutomatic = null, isAutomatic = false, close = () => {},
  engine = null, page = '', pinned = '', onPin = null,
  // A handful of rows is not a list to search. Restore has three lanes and the
  // Send-to menu has two places; a search box over either is furniture.
  searchable = true,
  readinessFor = null, onFixReadiness = null, busyAction = '',
}) {
  const [filter, setFilter] = useState('');
  const query = searchable ? filter.trim().toLowerCase() : '';
  const matches = (target) => !query || target.label.toLowerCase().includes(query)
    || target.placeLabel.toLowerCase().includes(query);
  const groups = groupRunTargets((targets || []).filter(matches));
  const showMachines = Boolean(engine && page);

  return (
    <>
      {searchable ? (
        <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 border-b border-line1 bg-bg1 p-1.5">
          <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
            <Icon name="search" size={13} className="shrink-0 text-ink3" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('common.searchModels')}
              className="h-8 w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
            />
          </div>
        </div>
      ) : null}

      {automatic?.target && onAutomatic ? (
        <div>
          <MenuHeading>{t('runOn.automatic')}</MenuHeading>
          <MenuItem
            selected={isAutomatic}
            meta={automatic.target.placeLabel}
            onClick={() => { onAutomatic(); close(); }}
          >
            <span className="inline-flex min-w-0 flex-col">
              <span className="truncate">{automatic.target.label}</span>
              {automatic.reason ? <span className="truncate text-[11px] text-ink3">{automatic.reason}</span> : null}
            </span>
          </MenuItem>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">
          {t('common.noResults')}
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.id}>
          <MenuHeading>{group.label}</MenuHeading>
          {group.targets.map((target) => (
            <TargetRow
              key={target.key}
              target={target}
              selected={!isAutomatic && value?.provider === target.provider && value?.id === target.id}
              onSelect={(chosen) => { onChange(chosen); close(); }}
              readiness={readinessFor?.(target) || null}
              onFixReadiness={onFixReadiness}
              busyAction={busyAction}
            />
          ))}
          {/* The rental lives under This Mac, because that is what it is: the
              hardware this Mac's generations are landing on. The compact card
              is the existing status panel — pin, attach, reconnect, and the
              rent CTA with its confirmation — so a creator whose Mac cannot run
              a model can rent one without ever opening the console. */}
          {group.id === PLACE_THIS_MAC && showMachines ? (
            <div className="border-t border-line1 px-2.5 py-2">
              <RentedSourceStatus engine={engine} page={page} pinned={pinned} onPin={onPin} />
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * The compact readout, and the list behind it.
 *
 * @param {object} props
 * @param {Array} props.targets from useRunTargets
 * @param {object|null} props.value the chosen target ({id, provider} is enough)
 * @param {function} props.onChange called with the chosen target
 * @param {object|null} props.automatic {target, reason} from pickRunTarget
 * @param {function|null} props.onAutomatic go back to the Automatic pick
 * @param {boolean} props.isAutomatic this tab is following Automatic
 */
export function RunOnPicker({
  targets = [], value = null, onChange, automatic = null, onAutomatic = null, isAutomatic = false,
  engine = null, page = '', pinned = '', onPin = null, className = '',
  // The composer wants the chip alone, on one wrapping row of chips; the
  // settings panel wants the labelled block. Same control, same list.
  compact = false,
  // A studio with TWO of these on one stage has to be able to say which is
  // which ("Character sheets", "The plate"). The default is the question.
  label = '',
  searchable = true,
  readinessFor = null, onFixReadiness = null, busyAction = '',
}) {
  const shown = isAutomatic ? (automatic?.target || value) : value;
  const readout = runOnReadout(shown, {
    reason: isAutomatic ? (automatic?.reason || '') : '',
    automatic: isAutomatic,
  });
  return (
    <div className={cx(compact ? 'contents' : 'flex flex-col gap-2', className)}>
      {compact ? null : <SectionLabel>{label || t('runOn.label')}</SectionLabel>}
      <Menu
        width="w-[320px]"
        panelClassName="max-h-[min(480px,70vh)]"
        trigger={(open, toggle) => (
          <ChipButton
            icon={shown?.place === PLACE_THIS_MAC ? 'cpu' : 'cloud'}
            value={readoutText(readout)}
            active={open}
            onClick={toggle}
            title={readoutText(readout)}
            label={compact ? t('runOn.label') : ''}
            className={compact ? '' : 'w-full max-w-full justify-between'}
          />
        )}
      >
        {(close) => (
          <RunOnList
            targets={targets}
            value={shown}
            onChange={onChange}
            automatic={automatic}
            onAutomatic={onAutomatic}
            isAutomatic={isAutomatic}
            close={close}
            engine={engine}
            page={page}
            pinned={pinned}
            onPin={onPin}
            searchable={searchable}
            readinessFor={readinessFor}
            onFixReadiness={onFixReadiness}
            busyAction={busyAction}
          />
        )}
      </Menu>
      {!compact && isAutomatic && readout.note ? (
        <small className="text-[11px] text-ink3">
          {t('runOn.automaticPrefix')}{readout.note}
        </small>
      ) : null}
    </div>
  );
}
