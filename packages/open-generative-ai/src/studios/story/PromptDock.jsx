// The strip along the bottom: what would travel, and where it would go.
//
// It is the same on all four stages on purpose. The script is being built from
// the whole production as you write it, and the reference chips are the only
// place that says out loud which of the four pictures actually exist — which is
// the fact that decides whether the Video studio gets a reference prompt or a
// paragraph about references that are not there.
import { Button, TextArea, cx, useHint } from '../../ui/kit.jsx';
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
  // The kit's own bubble rather than a second hand-rolled one: it is themed
  // with everything else, it is gated on a pointer that can actually hover, and
  // it follows the anchor when the composer scrolls.
  const sends = 'Sends the script, every drawn sheet, the plate and the board to the Video studio — '
    + 'sheets as subjects, plate and board as places. Nothing is generated here.';
  const bubble = useHint('top');
  const chips = referenceChips(story);
  const drawn = chips.filter((chip) => chip.drawn).length;

  return (
    <div className="flex w-full flex-col">
      {open ? (
        <div className="flex max-h-[260px] flex-col gap-2 overflow-y-auto border-b border-line1 px-3.5 py-3.5 sm:px-5">
          <TextArea
            rows={10}
            value={script}
            onChange={(event) => onScript(event.target.value)}
            placeholder="Write beats on the “What happens” stage and the script builds itself here."
            className="!border-0 !bg-transparent !px-0 !py-0 font-mono !text-[11px] touch:!text-[16px] !leading-[1.65] !text-ink2"
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

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-3.5 py-2.5 sm:px-5">
        <div className="flex min-w-0 flex-[1_1_100%] flex-wrap items-center gap-1.5 sm:flex-[1_1_200px]">
          {chips.map((chip) => (
            <span
              key={chip.key}
              title={chip.label}
              className={cx(
                'grid h-[26px] w-5 shrink-0 place-items-center rounded-sm border font-mono text-[10px]',
                'touch:h-ctl-sm touch:w-7 touch:text-[12px]',
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
          <span className="relative inline-flex" {...bubble.bind({})}>
            {bubble.render(sends)}
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
