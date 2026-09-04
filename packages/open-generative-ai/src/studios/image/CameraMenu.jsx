// Camera rig picker for the Image composer — what used to be the Cinema studio.
//
// Cinema was a camera rig plus a string joiner wearing a tab: one hardcoded
// cloud model, no references, no lane choice, an ephemeral history. The rig
// itself is good, and it is just prose, so it lives here beside UGC mode and the
// style presets, where every provider can read it.
//
// UI pattern follows UgcMenu (ChipButton + Menu popover); the block composer
// lives in src/lib/cameraRig.js, and the controls in studios/CameraControls.jsx.
import { getLang } from '../../lib/i18n.js';
import { cameraRigSentence } from '../../lib/cameraRig.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';
import { CameraControls } from '../CameraControls.jsx';

const zh = () => getLang() === 'zh-CN';

export function CameraMenu({
  // The rig this composer holds — { camera, lens, focal, aperture }.
  rig,
  // Whether the PROMPT actually carries the rig clause right now. Read from the
  // prompt, not from a flag, so "Start fresh" turns the chip off with it.
  active = false,
  // ?page=cinema routes here and asks for this menu; the studio owns the flag so
  // it survives the request landing before the menu has rendered.
  open = false,
  onOpenChange,
  // A control moved. The rig is remembered either way; while the clause is in
  // the prompt it is rewritten in place, so the preview and the prompt agree.
  onChange,
  // (rig | null) — writes the clause, or null to clear it out of the prompt.
  onArm,
}) {
  const armed = Boolean(active);
  const preview = cameraRigSentence(rig);

  return (
    <Menu
      up
      width="w-[23rem]"
      // The rig pickers are popovers of their own; give the panel room so they
      // are not opening inside a scrollbar.
      panelClassName="max-h-[min(560px,78vh)]"
      open={open}
      onOpenChange={onOpenChange}
      trigger={(isOpen, toggle) => (
        <ChipButton
          icon="camera"
          label={zh() ? '机位' : 'Camera'}
          value={armed ? `${rig.focal}mm · ${rig.aperture}` : ''}
          active={isOpen || armed}
          onClick={toggle}
          title={zh()
            ? '把机身、镜头、焦距与光圈写成提示词中的一句机位描述'
            : 'Writes the body, lens, focal length and aperture into the prompt as one camera sentence'}
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-3">
          {/* Cinema's own headline, carried over — the composer's placeholder is
              fixed, so this is where the line still gets to ask its question. */}
          <p className="text-[13px] font-medium leading-snug text-ink1">
            {zh() ? '如果预算无限，你会拍什么？' : 'What would you shoot with infinite budget?'}
          </p>
          <p className="-mt-1 text-[11px] leading-relaxed text-ink3">
            {zh()
              ? '把机位写成提示词里的一句话。换设置会替换这一句，不会叠加。'
              : 'One editable camera sentence at the end of the prompt. Changing it replaces that sentence rather than stacking another.'}
          </p>
          <CameraControls value={rig} onChange={(next) => onChange?.(next)} />

          <div className="rounded-md border border-line1 bg-bg0 px-2 py-2 text-[11px] leading-relaxed text-ink2">
            {preview}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { onArm?.(rig); close(); }}
              className="rounded-sm border border-honey/50 bg-honey-tint px-2 py-1 text-[11px] font-semibold text-honey transition-colors hover:border-honey"
            >
              {armed
                ? (zh() ? '更新提示词' : 'Update the prompt')
                : (zh() ? '写入提示词' : 'Add to the prompt')}
            </button>
            {armed ? (
              <button
                type="button"
                onClick={() => { onArm?.(null); close(); }}
                title={zh() ? '从提示词中移除机位描述' : 'Remove the camera sentence from the prompt'}
                className={cx(
                  'rounded-sm border border-line1 bg-bg1 px-2 py-1 text-[11px] font-semibold',
                  'text-ink1 transition-colors hover:border-line2',
                )}
              >
                {zh() ? '关闭' : 'Turn off'}
              </button>
            ) : null}
            <span className="ml-auto pr-1 text-[10px] text-ink3">
              {zh() ? '适用于任何模型' : 'works with any model'}
            </span>
          </div>
        </div>
      )}
    </Menu>
  );
}
