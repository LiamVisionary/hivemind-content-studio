// "Send to:" — choose the tab and the source BEFORE work leaves a studio.
//
// Where a production goes is two decisions, and both change what is sent. The
// tab decides whose settings and whose in-flight run it lands beside; the
// source decides the model, and the model decides everything else — a story
// sent to a rented MiniMax H3 travels as a cast, four reference pictures and a
// six-section prompt, while the same story sent to a cloud Seedance travels as
// labelled blocks with nothing attached at all (lib/videoDelivery.js).
//
// So the menu shows the consequence next to the choice: every row carries the
// model that source is on and one line saying what will actually travel there.
// Reusable on purpose — this is the shape any studio handing work to another
// one needs, and the Story studio is simply the first.
import { useEffect, useMemo, useState } from 'react';
import { Menu, MenuHeading } from '../ui/Menu.jsx';
import { Button, cx } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';
import {
  SEND_SOURCES, SOURCE_LABELS, listSendTargets, mergeSendTargets, selectSendTarget, subscribeSendTargets,
} from '../lib/studioTargets.js';

/**
 * Every place work can be sent — mounted or not.
 *
 * `resolve` answers for the tabs that are not mounted, from what the target
 * studio already has on disk. Without it a session that had never opened the
 * Video studio was told to go and open it and come back, which is not a
 * fallback, it is homework.
 */
export function useSendTargets(section = 'video', resolve = null) {
  const [, bump] = useState(0);
  const [resolved, setResolved] = useState([]);
  useEffect(() => subscribeSendTargets(() => bump((n) => n + 1)), []);
  // Once per open: the catalog and the rentals both move, and this hook is only
  // mounted while the panel is.
  useEffect(() => {
    if (!resolve) return undefined;
    let alive = true;
    Promise.resolve(resolve())
      .then((list) => { if (alive) setResolved(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setResolved([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return mergeSendTargets(listSendTargets(section), resolved);
}

function SourceRow({ source, descriptor, describeFor, selected, onSelect }) {
  const label = SOURCE_LABELS[source] || source;
  const available = Boolean(descriptor?.available);
  // The sender describes its own trip: how much of a production survives is a
  // property of the production and the target together, so a picture count
  // measured here would be a guess about somebody else's payload.
  const consequence = available
    ? [descriptor.note, describeFor?.(descriptor.plan) || ''].filter(Boolean).join(' · ')
    : (descriptor?.reason || '');
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!available}
      onClick={() => onSelect(source)}
      className={cx(
        'flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors duration-150',
        selected
          ? 'border-honey/40 bg-honey-tint text-ink1'
          : 'border-transparent text-ink2',
        // Hover classes are emitted ONLY when the row can be chosen. Adding a
        // disabled override alongside them left both in the class list and let
        // stylesheet order decide, which is not a decision anybody made.
        available && !selected && 'hover:border-line2 hover:bg-bg3 hover:text-ink1',
        !available && 'cursor-not-allowed opacity-45',
      )}
    >
      {/* Selection is a CONTROL, not a background tint. bg-bg2 over a bg-bg1
          panel is six units of difference — hover and selected read as the same
          ambiguous shading, and which row is armed becomes a guess. */}
      <span
        aria-hidden="true"
        className={cx(
          'mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border transition-colors duration-150',
          selected ? 'border-honey' : 'border-line2',
        )}
      >
        {selected ? <span className="h-1.5 w-1.5 rounded-full bg-honey" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[13px] font-medium">
          <Icon name={source === 'api' ? 'cloud' : 'cpu'} size={12} className="shrink-0 text-ink3" />
          {label}
        </span>
        {/* The subtitle IS the point: a source with no model named under it is a
            choice made blind. `switches` matters as much as the name — this
            source does not offer what is loaded now, so picking it moves the tab. */}
        <span className="truncate text-[11px] text-ink3">
          {available
            ? `${descriptor.switches ? 'switches to ' : ''}${descriptor.modelName || descriptor.modelId}`
            : consequence}
        </span>
        {available && consequence ? (
          <span className="truncate text-[10px] text-ink3/80">{consequence}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The panel's contents, mounted only while it is open.
 *
 * Its own component so the unmounted-target resolve runs once per OPEN rather
 * than once per page: the catalog and the rentals both move, and a menu that
 * answered from whatever was cached when the page loaded would offer a machine
 * that has since gone away.
 */
function SendToBody({ section, resolve, describeFor, onSend, close }) {
  const targets = useSendTargets(section, resolve);
  const [tabId, setTabId] = useState(null);
  const [source, setSource] = useState('');

  // Default to the tab that is already in front and the source it is already
  // on — the choice somebody would make by doing nothing.
  const target = useMemo(
    () => targets.find((entry) => entry.tabId === tabId) || targets.find((entry) => entry.active) || targets[0] || null,
    [targets, tabId],
  );
  const chosen = source || target?.current || 'local';
  const descriptor = target?.sources?.[chosen] || null;
  const ready = Boolean(target && descriptor?.available);

  if (!target) {
    return (
      <p className="px-2.5 py-4 text-center text-[11px] leading-snug text-ink3">
        Reading the Video studio’s settings…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Only when there is a choice to make. One tab is not a decision. */}
      {targets.length > 1 ? (
        <>
          <MenuHeading>Which tab</MenuHeading>
          <div className="flex flex-wrap gap-1 px-1.5 pb-1" role="radiogroup">
            {targets.map((entry) => (
              <button
                key={entry.tabId}
                type="button"
                role="radio"
                aria-checked={entry.tabId === target.tabId}
                onClick={() => { setTabId(entry.tabId); setSource(''); }}
                className={cx(
                  'rounded px-2 py-1 text-[11px] transition-colors',
                  entry.tabId === target.tabId
                    ? 'bg-honey-tint text-honey'
                    : 'text-ink3 hover:bg-bg3 hover:text-ink2',
                )}
              >
                {entry.label}
                {entry.active ? ` · ${'front'}` : ''}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <MenuHeading>Run it on</MenuHeading>
      <div role="radiogroup" className="flex flex-col">
        {SEND_SOURCES.map((entry) => (
          <SourceRow
            key={entry}
            source={entry}
            descriptor={target.sources?.[entry] || null}
            describeFor={describeFor}
            selected={entry === chosen}
            onSelect={setSource}
          />
        ))}
      </div>
      <div className="mt-1 border-t border-line1 px-1.5 pb-0.5 pt-2">
        <Button
          variant="primary"
          className="w-full justify-center"
          disabled={!ready}
          onClick={() => {
            if (!ready) return;
            onSend?.({ tabId: target.tabId, source: chosen, descriptor, target });
            close();
          }}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * The picker.
 *
 * `resolve()` answers for targets that are not mounted — the Video studio does
 * not have to have been opened for this session to know what it would run.
 * `describeFor(plan)` is the sender's own one-line answer to "what would
 * actually travel there"; it is given the target's delivery plan and knows its
 * payload, which nothing here does. `onSend({ tabId, source, descriptor })` is
 * called once, on Send — never on a row click, because choosing where to look
 * is not choosing to go.
 */
export function SendToMenu({
  section = 'video', resolve = null, describeFor = null, disabled = false, label, icon = 'film', onSend,
  // The Story studio's dock makes this the page's primary action, so the
  // trigger has to be able to look like one.
  variant = 'neutral',
}) {
  return (
    <Menu
      up
      width="w-[19rem]"
      trigger={(open, toggle) => (
        <Button variant={variant} icon={icon} disabled={disabled} onClick={toggle} aria-expanded={open}>
          {label || 'Send to…'}
        </Button>
      )}
    >
      {(close) => (
        <SendToBody
          section={section}
          resolve={resolve}
          describeFor={describeFor}
          onSend={onSend}
          close={close}
        />
      )}
    </Menu>
  );
}

export { selectSendTarget };
