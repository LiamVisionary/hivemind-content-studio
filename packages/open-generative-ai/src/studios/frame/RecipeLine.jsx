// The recipe line — the settings people actually change, written as a sentence.
//
//   Make [1 image] at [9:16] in [photoreal] with [2 references] on [this Mac · Z-Image] .  Advanced →
//
// It replaces the composer's chip toolbar. A row of eight labelled chips reads
// as a toolbar and stops reading as a prompt bar; the same eight values written
// into a sentence read as a sentence, and each underlined value is still the
// control it replaced — pressing it opens the same menu the chip did.
//
// Connector words ("Make", "at", "in", "with", "on", ".") are not controls and
// never highlight. A token whose value is the ACTIVE, non-default choice draws
// in honey — that is how "photoreal" and "continuing shot 03" stand out without
// a second colour or a badge.
import { Icon } from '../../ui/icons.jsx';
import { Menu } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';

const TOKEN_BASE = 'inline-flex max-w-[220px] items-center rounded-md px-2 py-[3px] text-[12.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-45';
const TOKEN_TONE = {
  neutral: 'bg-white/[0.06] text-ink1 hover:bg-white/[0.11]',
  honey: 'bg-honey/[0.15] text-honey hover:bg-honey/25',
  // A token the current model cannot honour — attached references on a model
  // that reads none, say. Still pressable (that is how you remove them).
  muted: 'bg-white/[0.04] text-inkSoft line-through hover:bg-white/[0.08]',
};

/** One value in the sentence. Used on its own by callers that need to place a
 *  token somewhere else (the stage's own overlays reuse it). */
export function RecipeToken({ value, tone = 'neutral', active = false, className = '', ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(TOKEN_BASE, TOKEN_TONE[tone] || TOKEN_TONE.neutral, active && 'ring-1 ring-inset ring-honey/60', 'truncate', className)}
    >
      <span className="truncate">{value}</span>
    </button>
  );
}

/**
 * RecipeLine
 *
 * @param {Array} parts   each entry is one of
 *    { text: 'at' }                                   a connector word
 *    { key, value, tone?, menu: (close) => node }     a token that opens a popover
 *    { key, value, tone?, onClick, title? }           a token that fires directly
 *    { key, node }                                    an existing control, rendered in token position
 *   Falsy entries are skipped, so a caller can inline conditionals.
 * @param {bool} advancedOpen
 * @param {func} onToggleAdvanced
 * @param {string} advancedLabel
 */
export function RecipeLine({ parts = [], advancedOpen = false, onToggleAdvanced, advancedLabel = 'Advanced' }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[12.5px] leading-[2] text-inkSoft">
      {parts.filter(Boolean).map((part, index) => {
        const key = part.key || `${part.text || 'part'}-${index}`;
        if (part.node) return <span key={key} className="inline-flex items-center">{part.node}</span>;
        if (part.text !== undefined) return <span key={key} className="select-none">{part.text}</span>;

        const token = (
          <RecipeToken
            value={part.value}
            tone={part.tone}
            disabled={part.disabled}
            title={part.title}
            aria-label={part.ariaLabel || part.title || undefined}
          />
        );

        if (typeof part.menu === 'function') {
          return (
            <Menu
              key={key}
              up
              width={part.menuWidth || 'w-72'}
              align={part.align || 'start'}
              trigger={(open, toggle) => (
                <RecipeToken
                  value={part.value}
                  tone={part.tone}
                  active={open}
                  disabled={part.disabled}
                  title={part.title}
                  aria-label={part.ariaLabel || part.title || undefined}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={toggle}
                />
              )}
            >
              {part.menu}
            </Menu>
          );
        }

        return (
          <span key={key} className="inline-flex items-center">
            {part.onClick
              ? (
                <RecipeToken
                  value={part.value}
                  tone={part.tone}
                  disabled={part.disabled}
                  title={part.title}
                  aria-label={part.ariaLabel || part.title || undefined}
                  onClick={part.onClick}
                />
              )
              : token}
          </span>
        );
      })}

      {onToggleAdvanced ? (
        <button
          type="button"
          onClick={onToggleAdvanced}
          aria-expanded={advancedOpen}
          title="Every remaining control for this studio"
          className={cx(
            'ml-2.5 inline-flex items-center gap-[5px] rounded-md px-1.5 py-0.5 text-[12.5px] transition-colors',
            advancedOpen ? 'text-honey' : 'text-inkSoft hover:text-ink1',
          )}
        >
          {advancedLabel}
          <Icon name={advancedOpen ? 'arrowLeft' : 'arrowRight'} size={13} />
        </button>
      ) : null}
    </div>
  );
}
