// H3 restyle picker — one visual-treatment preset at a time, applied to the
// prompt as an idempotent phrase (switching replaces, never stacks). Ported
// from Mix-Studio's Style Transfer presets; strongest with reference media,
// but the phrase steers any H3 generation.
import { H3_RESTYLE_PRESETS } from '../../lib/h3RestylePresets.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';

export function RestyleMenu({ activeId, onApply }) {
  const active = H3_RESTYLE_PRESETS.find((preset) => preset.id === activeId) || null;
  return (
    <Menu
      up
      width="w-[19rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="wand"
          label="Style"
          value={active ? active.label : ''}
          active={open || Boolean(active)}
          onClick={toggle}
          title="Pick an H3 visual-style preset — applied to the prompt, switching replaces it"
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          {H3_RESTYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => { onApply(preset.id === activeId ? null : preset.id); close(); }}
              className={cx(
                'flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left transition-colors',
                preset.id === activeId
                  ? 'border-honey/50 bg-honey-tint'
                  : 'border-line1 bg-bg1 hover:border-line2 hover:bg-bg2',
              )}
            >
              <span className={cx('text-[12px] font-semibold', preset.id === activeId ? 'text-honey' : 'text-ink1')}>
                {preset.label}
              </span>
              <span className="text-[10px] text-ink3">{preset.hint}</span>
            </button>
          ))}
          {active ? (
            <button
              type="button"
              onClick={() => { onApply(null); close(); }}
              className="rounded-md border border-line1 bg-bg1 px-2.5 py-1.5 text-left text-[12px] font-semibold text-ink1 transition-colors hover:border-line2"
            >
              Clear style
            </button>
          ) : null}
        </div>
      )}
    </Menu>
  );
}
