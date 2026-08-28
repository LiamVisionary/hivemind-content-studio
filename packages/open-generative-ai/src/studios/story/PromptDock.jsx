// The strip along the bottom: what would travel, and where it would go.
//
// It is the same on all four stages on purpose. The script is being built from
// the whole production as you write it, and the reference chips are the only
// place that says out loud which of the four pictures actually exist — which is
// the fact that decides whether the Video studio gets a reference prompt or a
// paragraph about references that are not there.
import { useState } from 'react';

import { Button, TextArea, cx } from '../../ui/kit.jsx';
import { SendToMenu } from '../../components/SendToMenu.jsx';
import { producerIsRunning } from './state.js';
import { resolveVideoSendTargets } from '../video/videoSendTargets.js';

/** One letter for a character, from the first word that is actually their name
 *  — "the moth" is M, not T. */
function initial(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const first = words.find((word) => !/^(the|a|an)$/i.test(word)) || words[0] || '';
  return first.slice(0, 1).toUpperCase() || '?';
}

/** Every picture this production can carry, and whether each is drawn. */
function referenceChips(story) {
  const chips = story.characters.map((character, index) => ({
    key: character.id || `c${index}`,
    short: initial(character.name),
    label: `${character.name || `character ${index + 1}`} — sheet${character.sheetUrl ? '' : ' (not drawn)'}`,
    drawn: Boolean(character.sheetUrl),
  }));
  chips.push({
    key: 'plate',
    short: 'P',
    label: `${story.location.place || 'The place'} — plate${story.location.plateUrl ? '' : ' (not drawn)'}`,
    drawn: Boolean(story.location.plateUrl),
  });
  chips.push({
    key: 'board',
    short: 'B',
    label: `Storyboard — ${story.board.panels.length} panels${story.board.sheetUrl ? '' : ' (not drawn)'}`,
    drawn: Boolean(story.board.sheetUrl),
  });
  return chips;
}

export function PromptDock({
  story, script, overridden, budget, open, onToggle, onScript, onRevert, onTighten, onCompress,
  busy, onCopy, onSend, describeSendTo,
}) {
  const [tip, setTip] = useState(false);
  const chips = referenceChips(story);
  const drawn = chips.filter((chip) => chip.drawn).length;

  return (
    <div className="flex w-full flex-col">
      {open ? (
        <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto border-b border-line1 px-5 py-3.5">
          <TextArea
            rows={10}
            value={script}
            onChange={(event) => onScript(event.target.value)}
            placeholder="Write beats on the “What happens” stage and the script builds itself here."
            className="!border-0 !bg-transparent !px-0 !py-0 font-mono !text-[11px] !leading-[1.65] !text-ink2"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-ink3">
              {overridden
                ? 'Edited by hand — the fields no longer rewrite it.'
                : 'Built from this page as you type. Edit it by hand and the fields stop rewriting it.'}
            </span>
            {overridden ? (
              <Button size="sm" onClick={onRevert}>Back to the built one</Button>
            ) : null}
            {budget.savings > 0 ? (
              <Button size="sm" onClick={onTighten} className="!text-warn">
                Cut {budget.savings} characters that say nothing
                {budget.emptyPhrases.length ? ` (${budget.emptyPhrases.slice(0, 3).join(', ')})` : ''}
              </Button>
            ) : null}
            {budget.over ? (
              <Button
                size="sm"
                icon="scissors"
                onClick={onCompress}
                loading={producerIsRunning(busy, 'compress')}
                disabled={Boolean(busy)}
              >
                Compress by {budget.over}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-5 py-2.5">
        <div className="flex min-w-0 flex-[1_1_200px] items-center gap-1.5 overflow-hidden">
          {chips.map((chip) => (
            <span
              key={chip.key}
              title={chip.label}
              className={cx(
                'grid h-[26px] w-5 shrink-0 place-items-center rounded-sm border font-mono text-[10px]',
                chip.drawn ? 'border-line2 bg-bg3 text-ink2' : 'border-dashed border-line2 text-ink3',
              )}
            >
              {chip.short}
            </span>
          ))}
          <span className="ml-1 min-w-0 truncate text-[11px] text-ink3">
            {drawn} of {chips.length} references drawn · {budget.chars} chars
            {budget.limit ? ` of ${budget.limit}` : ''}
          </span>
        </div>

        <Button size="sm" icon="eye" onClick={onToggle} aria-expanded={open}>
          {open ? 'Hide the prompt' : 'View the prompt'}
        </Button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button icon="copy" onClick={onCopy} disabled={!script}>Copy</Button>
          <span
            className="relative inline-flex"
            onMouseEnter={() => setTip(true)}
            onMouseLeave={() => setTip(false)}
            onFocus={() => setTip(true)}
            onBlur={() => setTip(false)}
          >
            {tip ? (
              <span className="hive-fade-in pointer-events-none absolute bottom-[calc(100%+8px)] right-0 z-40 w-[248px] rounded-sm border border-line1 bg-bg3 px-2.5 py-2 text-[11px] font-medium leading-relaxed text-ink1 shadow-pop">
                Sends the script, every drawn sheet, the plate and the board to the Video studio —
                sheets as subjects, plate and board as places. Nothing is generated here.
              </span>
            ) : null}
            <SendToMenu
              section="video"
              icon="film"
              variant="primary"
              label="Generate in Video studio"
              disabled={!script}
              resolve={resolveVideoSendTargets}
              describeFor={describeSendTo}
              onSend={onSend}
            />
          </span>
        </div>
      </div>
    </div>
  );
}
