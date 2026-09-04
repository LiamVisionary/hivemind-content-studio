// Camera motion picker — up to three ordered moves composed into one idempotent
// "Camera motion: …" prompt phrase. Selection order matters (begin/continue/
// finish), so each selected card shows its 1/2/3 position. Applying replaces the
// previously applied phrase in the prompt; it never stacks.
//
// UI pattern follows SavedPromptsMenu (ChipButton + Menu popover). Motion data
// and composer live in src/lib/cameraMotion.js (adapted from Mix-Studio, GPL-3.0).
import { useState } from 'react';
import {
  CAMERA_MOTIONS,
  MAX_CAMERA_MOTIONS,
  cameraMotionPhrase,
  normalizeCameraMotions,
} from '../../lib/cameraMotion.js';
// `zh` lives in lib/i18n.js; videoLogic re-exports it, which is the import every
// sibling panel here uses (see IngredientsPanel.jsx).
import { zh } from './videoLogic.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { Button, cx } from '../../ui/kit.jsx';

const COLLECTIONS = ['Core moves', 'Handheld & FPV'];

export function CameraMotionMenu({ selectedIds, onApply }) {
  const applied = normalizeCameraMotions(selectedIds);
  // Draft selection lives here while the menu is open; Apply commits it.
  const [draft, setDraft] = useState(null);
  const current = draft ?? applied;

  const toggle = (id) => {
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : normalizeCameraMotions([...current, id]);
    setDraft(next);
  };

  const phrase = cameraMotionPhrase(current);

  return (
    <Menu
      up
      width="w-[24rem] max-w-[calc(100vw-1.5rem)]"
      trigger={(open, toggleMenu) => (
        <ChipButton
          icon="camera"
          label={zh() ? '运镜' : 'Camera'}
          value={applied.length ? String(applied.length) : ''}
          active={open || applied.length > 0}
          onClick={() => { setDraft(null); toggleMenu(); }}
          title={zh()
            ? '选择最多三个镜头运动，按顺序合成提示词短语'
            : `Camera moves — pick up to ${MAX_CAMERA_MOTIONS}; their order becomes begin / continue / finish`}
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-1">
          {/* The 24-move grid is taller than the popover can be at laptop
              heights — it scrolls, while the phrase + actions stay pinned. */}
          <div className="max-h-[46vh] overflow-y-auto">
          {COLLECTIONS.map((collection) => (
            <div key={collection}>
              <div className="px-1.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
                {collection}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {CAMERA_MOTIONS.filter((m) => m.collection === collection).map((motion) => {
                  const index = current.indexOf(motion.id);
                  const selected = index >= 0;
                  return (
                    <button
                      key={motion.id}
                      type="button"
                      onClick={() => toggle(motion.id)}
                      title={motion.detail}
                      className={cx(
                        'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[12px] transition-colors',
                        selected
                          ? 'border-honey/50 bg-honey-tint text-honey'
                          : 'border-line1 bg-bg1 text-ink1 hover:border-line2 hover:bg-bg2',
                      )}
                    >
                      <span className="w-4 shrink-0 text-center font-mono">{motion.glyph}</span>
                      <span className="min-w-0 flex-1 truncate">{motion.label}</span>
                      {selected ? (
                        <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-honey font-mono text-[10px] font-bold text-bg0">
                          {index + 1}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          </div>

          {phrase ? (
            <div className="mt-1 rounded-md border border-line1 bg-bg0 px-2 py-1.5 text-[11px] leading-relaxed text-ink2">
              {phrase}
            </div>
          ) : null}

          <div className="mt-1 flex items-center gap-1.5">
            <Button
              size="sm"
              variant="primary"
              disabled={!current.length && !applied.length}
              onClick={() => { onApply(current); setDraft(null); close(); }}
            >
              {zh() ? '应用到提示词' : 'Apply to prompt'}
            </Button>
            {applied.length ? (
              <Button
                size="sm"
                variant="neutral"
                onClick={() => { onApply([]); setDraft(null); close(); }}
                title={zh() ? '从提示词中移除运镜短语' : 'Remove the camera phrase from the prompt'}
              >
                {zh() ? '清除' : 'Clear'}
              </Button>
            ) : null}
            <span className="ml-auto pr-1 text-[10px] text-ink3">
              {current.length}/{MAX_CAMERA_MOTIONS}
            </span>
          </div>
        </div>
      )}
    </Menu>
  );
}
