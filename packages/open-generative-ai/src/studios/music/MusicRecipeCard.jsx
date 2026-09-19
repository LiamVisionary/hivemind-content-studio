// The recipe card — how tracks in a style are usually built, applied in one press.
//
// TWO DOORS INTO THE SAME LIBRARY, AND ONLY ONE OF THEM LEAVES THE MACHINE.
// The list is local: pick a style, its section order and tempo land in the
// composer. Suggest asks a hosted decision model which recipe the style line
// matches, so it is opt-in — it runs on a press, after the server's own
// disclosure of what is sent and where, and it says so again every time rather
// than hiding behind a remembered checkbox.
//
// ACT, RECEIPT, OR ASK. A confident match is applied and the card says what it
// changed, with an undo. A spread is never applied: the top few are offered as
// buttons, because a model that must pick one of N cannot say "none of these",
// and a low-confidence pick is how it says it.
//
// NOTHING HERE IS A DEAD END. No OpenRouter account, the API not answering, the
// model timing out — each says so in a line and leaves the list, which needs
// none of them, right underneath.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyRecipe, hasSuggestConsent, recipeFormLine, recipesByFamily,
  rememberSuggestConsent, suggestDisclosure, suggestMusicRecipe,
} from '../../lib/musicRecipes.js';
import { Icon } from '../../ui/icons.jsx';
import { Spinner, cx } from '../../ui/kit.jsx';

const percent = (value) => `${Math.round(Number(value) * 100)}%`;

// `min-h` rather than a second height: it outranks the 24.5px `h-7` whatever
// order the two land in, so one string covers both pointers.
const chip = 'inline-flex h-7 items-center rounded-md px-2 text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 touch:min-h-[35px] touch:px-2.5';

const LOADING_BOOK = { status: 'loading', recipes: [], families: [], suggest: { available: false } };

/**
 * @param {object} book  the library as fetchMusicRecipes() answers it. The STUDIO
 *                       holds it, so the list is read once per visit rather than
 *                       on every open of this card, and survives closing it.
 */
export function MusicRecipeCard({
  model, setup, plan, prompt, onApply, onClose, disabled = false, book: givenBook = null,
  askSuggestion = suggestMusicRecipe,
}) {
  const book = givenBook || LOADING_BOOK;
  const [ask, setAsk] = useState({ phase: 'idle' }); // idle | consent | asking | spread | failed
  const [receipt, setReceipt] = useState(null); // { label, changes, note, before }
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const groups = useMemo(() => recipesByFamily(book.recipes, book.families), [book]);
  const byId = useMemo(() => new Map(book.recipes.map((row) => [row.id, row])), [book]);
  const style = String(prompt || '').trim();

  const apply = (recipe, { explicitBpm = null, note = '' } = {}) => {
    const next = applyRecipe(model, setup, plan, recipe, { explicitBpm });
    // Undo restores exactly what was on screen before THIS apply, not some
    // earlier default — two recipes in a row undo one at a time.
    setReceipt({ label: recipe.label, changes: next.changes, note, before: { setup, plan } });
    onApply({ setup: next.setup, plan: next.plan });
  };

  const runSuggest = async () => {
    setAsk({ phase: 'asking' });
    try {
      const answer = await askSuggestion(style);
      if (!alive.current) return;
      const chosen = byId.get(answer.recipe);
      if (answer.confident && chosen) {
        setAsk({ phase: 'idle' });
        apply(chosen, { explicitBpm: answer.explicit_bpm, note: `matched at ${percent(answer.confidence)}` });
        return;
      }
      setAsk({
        phase: 'spread',
        explicitBpm: answer.explicit_bpm,
        options: (answer.alternatives || []).map((row) => ({ recipe: byId.get(row.id), probability: row.probability })).filter((row) => row.recipe),
      });
    } catch (error) {
      if (alive.current) setAsk({ phase: 'failed', message: error?.message || 'Suggest did not answer.' });
    }
  };

  const pressSuggest = () => {
    if (!style) { setAsk({ phase: 'failed', message: 'Describe the sound first — the style line is what gets matched.' }); return; }
    if (!hasSuggestConsent()) { setAsk({ phase: 'consent' }); return; }
    void runSuggest();
  };

  const canSuggest = book.status === 'ready' && book.suggest?.available;

  return (
    <div className="rounded-xl border border-line2 bg-white/[0.03] px-3 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-inkSoft">Recipes</span>
        <span className="text-[11px] text-ink3">How tracks in a style are usually built</span>
        <button
          type="button"
          onClick={onClose}
          title="Hide the recipes"
          aria-label="Hide the recipes"
          className="ml-auto grid h-6 w-6 place-items-center rounded-full text-ink3 transition-colors hover:bg-white/10 hover:text-ink1 touch:h-10 touch:w-10"
        >
          <Icon name="chevronUp" size={13} />
        </button>
      </div>

      {book.status === 'loading' ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-ink3"><Spinner size={12} /> Reading the recipes…</div>
      ) : null}
      {book.status === 'unreachable' || book.status === 'empty' ? (
        <p className="py-2 text-[12px] leading-relaxed text-ink2">
          The recipe library did not load — it is served by this studio&apos;s own API, which is not answering.
          Nothing is lost: set the structure and tempo by hand, and reopen this once the studio is signed in.
        </p>
      ) : null}

      {book.status === 'ready' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled || !canSuggest || ask.phase === 'asking'}
              onClick={pressSuggest}
              className={cx(chip, 'gap-1.5 bg-honey/[0.15] font-medium text-honey hover:bg-honey/[0.22]')}
            >
              {ask.phase === 'asking' ? <Spinner size={11} /> : <Icon name="wand" size={12} />}
              {ask.phase === 'asking' ? 'Matching…' : 'Suggest from my style line'}
            </button>
            <span className="text-[11px] leading-relaxed text-ink3">
              {canSuggest
                ? 'Sends your style line — nothing else — to a hosted decision model.'
                : 'Suggest needs an OpenRouter account connected on this machine. Picking from the list below works without one.'}
            </span>
          </div>

          {ask.phase === 'consent' ? (
            <div className="mt-2 rounded-md border border-line2 bg-black/20 px-2.5 py-2">
              <p className="text-[11.5px] leading-relaxed text-ink2">{suggestDisclosure(book.suggest)}</p>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  onClick={() => { rememberSuggestConsent(); void runSuggest(); }}
                  className={cx(chip, 'bg-honey/[0.15] font-medium text-honey hover:bg-honey/[0.22]')}
                >
                  Send my style line
                </button>
                <button type="button" onClick={() => setAsk({ phase: 'idle' })} className={cx(chip, 'bg-white/[0.05] text-inkSoft hover:text-ink1')}>
                  Not now
                </button>
              </div>
            </div>
          ) : null}

          {ask.phase === 'failed' ? (
            <p role="status" className="mt-2 text-[11.5px] leading-relaxed text-ink2">{ask.message}</p>
          ) : null}

          {ask.phase === 'spread' ? (
            <div className="mt-2" role="group" aria-label="Closest recipes">
              <p className="text-[11.5px] leading-relaxed text-ink2">
                {ask.options.length
                  ? 'Not sure enough to choose for you — the closest, by how likely each is:'
                  : 'Nothing in the library is a clear match. Pick the nearest below, or set it by hand.'}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {ask.options.map(({ recipe, probability }) => (
                  <button
                    key={recipe.id}
                    type="button"
                    disabled={disabled}
                    title={recipeFormLine(recipe)}
                    onClick={() => { setAsk({ phase: 'idle' }); apply(recipe, { explicitBpm: ask.explicitBpm, note: 'your pick' }); }}
                    className={cx(chip, 'gap-1.5 bg-honey/[0.13] text-honey hover:bg-honey/[0.2]')}
                  >
                    {recipe.label}
                    <span className="font-mono text-[10px] opacity-70">{percent(probability)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {receipt ? (
            <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-relaxed text-ink2">
              <Icon name="check" size={11} />
              <span>
                <span className="font-medium text-ink1">{receipt.label}</span>
                {receipt.note ? ` (${receipt.note})` : ''}
                {receipt.changes.length
                  ? ` — set ${receipt.changes.join(', ')}.`
                  : ' — this model takes none of what that recipe sets, so nothing changed.'}
              </span>
              {receipt.changes.length ? (
                <button
                  type="button"
                  onClick={() => { onApply(receipt.before); setReceipt(null); }}
                  className="text-honey underline-offset-2 hover:underline"
                >
                  Undo
                </button>
              ) : null}
            </p>
          ) : null}

          <div className="mt-2 max-h-[190px] overflow-y-auto pr-1">
            {groups.map((group) => (
              <div key={group.id} className="mb-1.5">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink3">{group.label}</div>
                <div className="flex flex-wrap gap-1 touch:gap-2">
                  {group.recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      type="button"
                      disabled={disabled}
                      title={[recipeFormLine(recipe), recipe.bpm ? `${recipe.bpm} BPM` : '', recipe.form_note || ''].filter(Boolean).join(' — ')}
                      onClick={() => { setAsk({ phase: 'idle' }); apply(recipe, { note: '' }); }}
                      className={cx(chip, 'bg-white/[0.05] text-inkSoft hover:text-ink1', 'touch:h-auto touch:flex-col touch:items-start touch:justify-center touch:py-1')}
                    >
                      {recipe.label}
                      {/* Forty-five labels that differ only in what they BUILD,
                          and the difference lived in a `title` — which a finger
                          cannot open. Under a thumb each chip carries the form
                          it sets, cut to the chip's width; the whole line is
                          still on the tooltip for a pointer. */}
                      <span className="hidden max-w-[210px] truncate font-mono text-[10px] text-ink3 touch:block">
                        {recipeFormLine(recipe)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
