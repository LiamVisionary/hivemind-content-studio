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

/** The prompt box. Borderless and transparent — the panel is the surface.
 *
 *  `onClear` puts a small badge in the box's top-right corner while there is
 *  something to clear. It is the SMALL door: it empties this box and nothing
 *  else. "Start fresh" — one press deeper, behind a confirm — is the big one
 *  that also drops the attached pictures, frames and cast, and people were
 *  reaching for it when all they wanted was a blank line to type on. */
export function ComposerPrompt({ inputRef, value, onChange, onKeyDown, placeholder, disabled = false, onClear = null }) {
  const clearable = Boolean(onClear) && !disabled && Boolean(String(value || '').trim());
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
          // Room for the badge, so a long first line never runs under it.
          clearable && 'pr-8',
        )}
      />
      {clearable ? (
        <button
          type="button"
          onClick={onClear}
          title={t('composer.clearPrompt')}
          aria-label={t('composer.clearPrompt')}
          className={cx(
            'absolute right-0 top-[3px] grid h-[22px] w-[22px] place-items-center rounded-full transition-colors',
            'bg-white/5 text-ink3 hover:bg-white/10 hover:text-ink1',
          )}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}
