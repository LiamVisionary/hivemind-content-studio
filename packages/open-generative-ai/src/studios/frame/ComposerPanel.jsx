// The floating composer's insides — three rows, always in the same order:
//
//   1. what you typed          (large, borderless, the only thing at 16px)
//   2. the recipe line         (the settings, written as a sentence)
//   3. tools · eta · Generate  (round icon doors on the left, the press on the right)
//
// Cards that used to sit ABOVE the composer in the old column (the prompt
// helper, the style-tag enhancer, the extend banner) go in `above`, inside the
// same floating panel, so the studio never has two stacked surfaces.
//
// The panel chrome itself — radius, blur, shadow, the drop ring — belongs to
// StudioFrame's ComposerFloat, which measures this to keep the stage clear.
import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { Spinner } from '../../ui/kit.jsx';
import { cx } from '../../ui/kit.jsx';

/**
 * ComposerPanel
 *
 * @param {node} above    cards that open over the prompt (helper, enhancer, banners)
 * @param {node} prompt   the textarea (or whatever stands in for it)
 * @param {node} recipe   a <RecipeLine>
 * @param {node} tools    round icon doors, left of the action row
 * @param {node} meta     what sits before the primary button — eta, cost, prompt check
 * @param {node} primary  the Generate button
 * @param {node} secondary  Cancel, while a run is out
 */
export function ComposerPanel({ above = null, prompt, recipe = null, tools = null, meta = null, primary, secondary = null }) {
  return (
    <>
      {above}
      {prompt}
      {recipe}
      <div className="flex items-center gap-2">
        {tools}
        <div className="ml-auto flex min-w-0 items-center gap-[15px]">
          {meta}
          {secondary}
          {primary}
        </div>
      </div>
    </>
  );
}

/** A round 32px door in the composer's action row. The design gives these no
 *  label — the tooltip and aria-label carry the meaning, so every one of them
 *  MUST be given a `label`. */
export function ComposerTool({ icon, label, active = false, disabled = false, badge = null, onClick, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        'relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors',
        active ? 'bg-honey/[0.15] text-honey' : 'bg-white/5 text-inkSoft hover:bg-white/10 hover:text-ink1',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-white/5 hover:text-inkSoft',
      )}
    >
      <Icon name={icon} size={16} />
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-honey px-1 font-mono text-[9px] font-semibold text-on-honey">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/** The one press. A pill, honey, 40px tall — the only filled thing on the frame. */
export function ComposerPrimary({ children, loading = false, disabled = false, onClick, title, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      {...rest}
      className={cx(
        'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-6 text-[13.5px] font-semibold transition-colors',
        'bg-honey text-on-honey hover:bg-honey-bright',
        (disabled || loading) && 'cursor-not-allowed opacity-50 hover:bg-honey',
      )}
    >
      {loading ? <Spinner size={14} className="text-on-honey" /> : null}
      {children}
    </button>
  );
}

/** Cancel, beside Generate while a run is out. Quieter than the press it interrupts. */
export function ComposerSecondary({ children, onClick, title, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      {...rest}
      className="inline-flex h-10 shrink-0 items-center rounded-full border border-danger/40 px-4 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10"
    >
      {children}
    </button>
  );
}

/**
 * The second press, beside the first one.
 *
 * Not every studio's composer has one press. Restore has two, and the quieter
 * of them is the one it wants people to reach for FIRST: a two-second test
 * costs one chunk, where the button next to it costs an evening. So it is an
 * outlined pill rather than a round tool door — a tool door is where a control
 * goes to be found later, and this is the recommended way to start.
 *
 * Distinct from ComposerSecondary, which is Cancel: that one is danger-toned
 * because it interrupts, and this one is not because it makes something.
 */
export function ComposerAlternate({ children, loading = false, disabled = false, onClick, title, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      {...rest}
      className={cx(
        'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full border px-5 text-[13px] font-medium transition-colors',
        'border-line2 text-ink1 hover:bg-white/[0.06]',
        (disabled || loading) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      {loading ? <Spinner size={13} className="text-ink1" /> : null}
      {children}
    </button>
  );
}

/** The mono readout before Generate: "~14s · free", "~3m 20s · $0.42/hr". */
export function ComposerMeta({ children, title, tone = 'soft' }) {
  return (
    <span
      title={title}
      className={cx('hidden truncate font-mono text-[11px] sm:inline', tone === 'ok' ? 'text-ok' : 'text-inkSoft')}
    >
      {children}
    </span>
  );
}

/** How long an armed Clear waits for the second press before it forgets it was
 *  asked. Long enough to read the word, short enough that the corner is back to
 *  its icon by the time you look again. */
export const CLEAR_CONFIRM_MS = 3000;

/** A door in the prompt box's own corner — 22px, the size of the clear badge it
 *  sits beside. The action row's `ComposerTool` is 32px and lives under the
 *  recipe line; this is for the one or two things that belong ON the text. */
export function ComposerPromptAction({ icon, label, active = false, disabled = false, onClick, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        'grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full transition-colors',
        active ? 'bg-honey/[0.15] text-honey' : 'bg-white/5 text-ink3 hover:bg-white/10 hover:text-ink1',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-white/5 hover:text-ink3',
      )}
    >
      <Icon name={icon} size={12} />
    </button>
  );
}

/**
 * The clear badge, drawn in whichever of its two faces it is wearing.
 *
 * Presentational on purpose: `armed` comes from above, so both faces can be
 * rendered and read without driving a timer. The one press is `onPress` —
 * arming and confirming are the same button, and which one a press means is the
 * caller's business.
 *
 * The morph is a width transition on ONE element, not a swap of two: the round
 * icon widens leftwards into the pill (the cluster is right-anchored), both
 * faces cross-fading inside an `overflow-hidden` box. A swap would make the
 * second press land on a button that had just been unmounted and remounted
 * somewhere else.
 */
export function ClearPromptBadge({ armed = false, onPress, ...rest }) {
  return (
    <button
      type="button"
      onClick={onPress}
      title={armed ? t('composer.clearPromptConfirm') : t('composer.clearPrompt')}
      aria-label={armed ? t('composer.clearPromptConfirm') : t('composer.clearPrompt')}
      data-clear-armed={armed ? 'true' : 'false'}
      {...rest}
      className={cx(
        'relative flex h-[22px] shrink-0 items-center justify-center overflow-hidden rounded-full',
        'transition-[width,background-color,color] duration-200 ease-out',
        armed ? 'w-[52px] bg-honey/[0.15] text-honey hover:bg-honey/25' : 'w-[22px] bg-white/5 text-ink3 hover:bg-white/10 hover:text-ink1',
      )}
    >
      <span
        aria-hidden={armed ? 'true' : undefined}
        className={cx('absolute inset-0 grid place-items-center transition-opacity duration-150', armed ? 'opacity-0' : 'opacity-100')}
      >
        <Icon name="x" size={12} />
      </span>
      <span
        className={cx(
          'whitespace-nowrap px-2.5 text-[11px] font-semibold leading-none transition-opacity duration-150',
          armed ? 'opacity-100 delay-100' : 'opacity-0',
        )}
      >
        {t('common.clear')}
      </span>
    </button>
  );
}

/** The prompt box. Borderless and transparent — the panel is the surface.
 *
 *  `onClear` puts a small badge in the box's top-right corner while there is
 *  something to clear. It is the SMALL door: it empties this box and nothing
 *  else. "Start fresh" — one press deeper, behind a confirm — is the big one
 *  that also drops the attached pictures, frames and cast, and people were
 *  reaching for it when all they wanted was a blank line to type on.
 *
 *  It takes TWO presses. The first turns the icon into a pill that says Clear
 *  and the second empties the box; three seconds of nothing and it goes back to
 *  being an icon. A single press was too easy to hit on the way to the text —
 *  it is 22px, it sits on the first line, and what it throws away is what you
 *  just typed. The undo in the studios' toast stays: the pill is the cheap
 *  guard, not a replacement for it.
 *
 *  `corner` is what sits to the LEFT of the badge in the same cluster — the
 *  prompt helper, in both studios that use this. It collapses while the badge
 *  is armed so the pill has room to grow without the text having to reserve it,
 *  and because a corner that is asking a question should not also be a toolbar.
 */
export function ComposerPrompt({ inputRef, value, onChange, onKeyDown, placeholder, disabled = false, onClear = null, corner = null }) {
  const clearable = Boolean(onClear) && !disabled && Boolean(String(value || '').trim());
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);
  const disarm = () => { clearTimeout(timer.current); timer.current = null; setArmed(false); };
  // Nothing to clear (the box emptied under it, or the prompt went read-only)
  // and the question is moot. Also the unmount cleanup, so a studio switched
  // away from mid-question leaves no timer behind.
  useEffect(() => {
    if (!clearable) disarm();
    return () => clearTimeout(timer.current);
  }, [clearable]);

  const pressClear = () => {
    if (armed) { disarm(); onClear?.(); return; }
    setArmed(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setArmed(false); }, CLEAR_CONFIRM_MS);
  };

  return (
    <div className="relative">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={cx(
          'max-h-[150px] min-h-[26px] w-full resize-none overflow-y-auto border-none bg-transparent p-0 text-[16px] leading-[1.55] text-ink1 outline-none',
          'placeholder:text-ink3 disabled:cursor-not-allowed disabled:opacity-60 md:max-h-[220px]',
          // Room for the corner cluster, so a long first line never runs under
          // it. In pixels, not the rem scale: the cluster is measured in pixels
          // (22px doors) and this page's root is 14px, so `pr-14` reserves 49
          // and the armed pill is 52. It covers both faces — 48 for the pair,
          // 52 for the pill with the helper collapsed — so the text never
          // reflows mid-question.
          clearable ? 'pr-[56px]' : corner && !disabled ? 'pr-[30px]' : null,
        )}
      />
      {(corner && !disabled) || clearable ? (
        <div className="absolute right-0 top-[3px] flex items-center justify-end">
          {corner && !disabled ? (
            <span
              className={cx(
                'flex items-center overflow-hidden transition-[width,opacity] duration-200 ease-out',
                armed ? 'w-0 opacity-0' : 'w-[26px] opacity-100',
              )}
              // Nothing in a collapsed cluster is reachable by pointer or by Tab.
              inert={armed}
            >
              {corner}
            </span>
          ) : null}
          {clearable ? (
            <ClearPromptBadge
              armed={armed}
              onPress={pressClear}
              onBlur={disarm}
              onKeyDown={(e) => { if (e.key === 'Escape' && armed) { e.stopPropagation(); disarm(); } }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
