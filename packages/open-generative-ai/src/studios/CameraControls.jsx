// Camera rig control — the body / lens / focal / aperture pickers.
//
// Built for the retired Cinema studio; now mounted by the Image composer's
// Camera menu (studios/image/CameraMenu.jsx), which is where the rig lives.
//
// The old wheel-picker (scroll-to-center columns, blurred inactive options, no
// keyboard access) is replaced by elegant labelled list pickers that surface the
// descriptive effect text from promptUtils as hint lines. ALL option values are
// kept. Controlled: parent owns { camera, lens, focal, aperture } and receives the
// full updated state on every change. Focal is coerced to a Number at the boundary
// so downstream state stays typed (buildNanoBananaPrompt's FOCAL_PERSPECTIVE lookup
// tolerates either, but the old normalizer stores a Number).
import { CAMERA_MAP, LENS_MAP, FOCAL_PERSPECTIVE, APERTURE_EFFECT } from '../lib/promptUtils.js';
import { APERTURE_OPTIONS, CAMERA_OPTIONS, FOCAL_OPTIONS, LENS_OPTIONS } from '../lib/cameraRig.js';
import { zh } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { ChipButton, Menu } from '../ui/Menu.jsx';
import { Segmented, cx } from '../ui/kit.jsx';


function PickerRow({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink2">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-ink3">{hint}</span> : null}
    </div>
  );
}

function MenuOption({ name, hint, selected, onClick }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-150',
        selected ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
      )}
    >
      <span className="flex w-full items-center gap-2 text-[13px] font-medium">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {selected ? <Icon name="check" size={14} className="shrink-0 text-honey" /> : null}
      </span>
      {hint ? <span className="text-[11px] leading-snug text-ink3">{hint}</span> : null}
    </button>
  );
}

function ListPicker({ label, options, value, hintFor, onChange }) {
  return (
    <PickerRow label={label} hint={hintFor(value)}>
      <Menu
        width="w-[280px]"
        panelClassName="max-h-[min(340px,50vh)]"
        trigger={(open, toggle) => (
          <ChipButton value={value} active={open} onClick={toggle} className="w-full max-w-full justify-between" />
        )}
      >
        {(close) =>
          options.map((opt) => (
            <MenuOption
              key={opt}
              name={opt}
              hint={hintFor(opt)}
              selected={opt === value}
              onClick={() => {
                onChange(opt);
                close();
              }}
            />
          ))
        }
      </Menu>
    </PickerRow>
  );
}

// Controlled rig. `value` = { camera, lens, focal, aperture (plus any other fields
// the parent tracks — they pass through untouched). `onChange` fires with the full
// merged object every time a value changes (same contract as the old onChange(state)).
export function CameraControls({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const focal = Number(value.focal);
  return (
    <div className="flex flex-col gap-4">
      <ListPicker
        label={zh() ? '摄像机' : 'Camera'}
        options={CAMERA_OPTIONS}
        value={value.camera}
        hintFor={(v) => CAMERA_MAP[v] || ''}
        onChange={(v) => set({ camera: v })}
      />
      <ListPicker
        label={zh() ? '镜头' : 'Lens'}
        options={LENS_OPTIONS}
        value={value.lens}
        hintFor={(v) => LENS_MAP[v] || ''}
        onChange={(v) => set({ lens: v })}
      />
      <PickerRow label={zh() ? '焦距' : 'Focal'} hint={`${focal}mm · ${FOCAL_PERSPECTIVE[focal] || ''}`}>
        <Segmented
          size="sm"
          value={focal}
          onChange={(v) => set({ focal: Number(v) })}
          options={FOCAL_OPTIONS.map((f) => ({ value: f, label: String(f) }))}
        />
      </PickerRow>
      <PickerRow label={zh() ? '光圈' : 'Aperture'} hint={APERTURE_EFFECT[value.aperture] || ''}>
        <Segmented size="sm" value={value.aperture} onChange={(v) => set({ aperture: v })} options={APERTURE_OPTIONS} />
      </PickerRow>
    </div>
  );
}
