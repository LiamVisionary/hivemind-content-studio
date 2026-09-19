// The fight preset door.
//
// Unlike every other chip on this bar it does not write a prompt and stop: it
// MOVES the settings drawer's own controls. So the panel's whole job is to say
// which ones, on the lane you are actually on, before it touches anything —
// and to state, in the same list, what this lane cannot do. A preset that
// silently arms three of five things on the hosted lane and five on a rented
// 5090 would be the same button meaning two different renders.
//
// The rules, the dial values and the reasons are in lib/h3CombatPreset.js;
// this only draws the plan it returns.
import { COMBAT_LORA, COMBAT_NOTES } from '../../lib/h3CombatPreset.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { cx } from '../../ui/kit.jsx';

function DialRow({ label, detail, from = '', muted = false }) {
  return (
    <div className="flex gap-2 text-[11px] leading-relaxed">
      <span className={cx('w-[5.5rem] shrink-0 pt-px text-[10px] font-semibold uppercase tracking-[0.06em]', muted ? 'text-ink3' : 'text-ink2')}>
        {label}
      </span>
      <span className="min-w-0 flex-1 text-ink2">
        {detail}
        {from ? <span className="text-ink3">{` (now ${from})`}</span> : null}
      </span>
    </div>
  );
}

/**
 * The panel body, exported so it can be RENDERED on its own: a Menu's popover
 * is closed under a static render, and what this door has to get right is
 * precisely the copy inside it — which dials it is about to move on this lane,
 * and which the lane does not have.
 */
export function CombatPanel({ armed = false, plan = null, onApply, close }) {
  const changes = plan?.changes || [];
  const alreadySet = plan?.alreadySet || [];
  const unavailable = plan?.unavailable || [];
  const lora = plan?.lora || null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-ink2">
        Combat is where H3 shows its seams: fast motion jitters, and the detail that sells an
        impact is the first thing the speed shortcuts spend. This moves the settings this lane
        has toward the picture and away from the clock, and adds one line of fight direction to
        the prompt. Turning it off restores every dial to what it held.
      </p>

      <div className="flex flex-col gap-1 rounded-md border border-line1 bg-bg0 px-2 py-2">
        <div className="pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
          {armed ? 'Holding' : 'On this lane'}
        </div>
        {changes.length === 0 && alreadySet.length === 0 ? (
          <DialRow label="Nothing" detail="This lane exposes none of the settings the preset moves — only the fight direction would be written." muted />
        ) : null}
        {changes.map((change) => (
          <DialRow key={change.key} label={change.label} detail={change.why} from={armed ? '' : change.from} />
        ))}
        {alreadySet.map((change) => (
          <DialRow key={change.key} label={change.label} detail={`Already set the way the preset wants it — ${change.why}`} muted />
        ))}
        {unavailable.length ? (
          <DialRow
            label="Not here"
            muted
            detail={`${unavailable.map((entry) => entry.label).join(', ')} — this lane's graph has no such control, so the preset leaves ${unavailable.length === 1 ? 'it' : 'them'} alone.`}
          />
        ) : null}
        <DialRow
          label="LoRA"
          muted={!lora}
          detail={lora
            ? `${lora.displayName || lora.name} is installed on this lane and will be switched on at its own weight.`
            : `No fight LoRA is installed on this lane. Combat is the one thing H3 does not do well unarmed — ${COMBAT_LORA.sourceLabel} is the one this recipe was tested with; install it from the LoRA panel and arm the preset again.`}
        />
      </div>

      <ul className="flex flex-col gap-1 pl-3 text-[11px] leading-relaxed text-ink3">
        {COMBAT_NOTES.map((note) => (
          <li key={note} className="list-disc">{note}</li>
        ))}
      </ul>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => { onApply?.(!armed); close(); }}
          className={cx(
            'rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors',
            armed
              ? 'border border-line1 bg-bg1 text-ink1 hover:border-line2'
              : 'border border-honey/50 bg-honey-tint text-honey hover:border-honey',
          )}
        >
          {armed ? 'Turn off and restore' : 'Tune for combat'}
        </button>
        <span className="ml-auto pr-1 text-[10px] text-ink3">
          {armed ? 'restores the dials it moved' : 'slower per clip, by design'}
        </span>
      </div>
    </div>
  );
}

export function CombatMenu({ armed = false, plan = null, onApply }) {
  return (
    <Menu
      up
      width="w-[25rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="shield"
          label="Fight"
          value={armed ? 'on' : ''}
          active={open || armed}
          onClick={toggle}
          title="Tune this H3 lane for combat — size, sampling, motion smoothing and a fight LoRA. Turning it off puts every one of them back."
        />
      )}
    >
      {(close) => <CombatPanel armed={armed} plan={plan} onApply={onApply} close={close} />}
    </Menu>
  );
}
