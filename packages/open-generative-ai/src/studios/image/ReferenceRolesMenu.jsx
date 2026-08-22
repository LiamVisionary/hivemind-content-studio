// What each attached reference is FOR.
//
// An edit with four references and nothing said about them is a guess: the
// model decides on its own which picture supplies the face, which supplies the
// jacket, and which was only ever the room. This is the control that says so —
// one role per reference, written into the prompt as an ownership block that
// names what each picture does NOT supply as well as what it does.
//
// The block is the durable part. It lives in the prompt, so it travels with a
// saved prompt and survives a reload; the rows here are only the way it gets
// written, and applying replaces the previous block rather than stacking a
// second one. Rules live in lib/imageReferenceRoles.js.
import { useState } from 'react';
import {
  DEFAULT_IMAGE_REFERENCE_ROLE,
  IMAGE_REFERENCE_ROLES,
  normalizeReferenceRoles,
  referenceLabelFor,
  referenceOwnershipBlock,
  referenceRolesAreSet,
} from '../../lib/imageReferenceRoles.js';
import { ChipButton, Menu } from '../../ui/Menu.jsx';
import { NativeSelect, SectionLabel, TextInput, cx } from '../../ui/kit.jsx';

const ROLE_HINT = new Map(IMAGE_REFERENCE_ROLES.map(([id, , hint]) => [id, hint]));

/**
 * @param {object}   props
 * @param {number}   props.count       how many references are attached
 * @param {Array}    props.roles       [{ role, note }] held by the studio
 * @param {string}   props.labelStyle  'h3' for <Picture N>, else by position
 * @param {Function} props.onApply     (roles) => void — writes the block
 */
export function ReferenceRolesMenu({ count = 0, roles = [], labelStyle = 'ordinal', onApply }) {
  const applied = normalizeReferenceRoles(roles, count);
  // Draft lives here while the menu is open; Apply commits it, the same way
  // the camera-motion picker works.
  const [draft, setDraft] = useState(null);
  const current = draft ?? applied;
  const set = (index, patch) => setDraft(current.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const isSet = referenceRolesAreSet(applied, count);
  const preview = referenceOwnershipBlock(current, count, { labelStyle });

  if (!count) return null;

  return (
    <Menu
      up
      align="end"
      width="w-[24rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="layers"
          label="Roles"
          value={isSet ? String(count) : ''}
          active={open || isSet}
          onClick={() => { setDraft(null); toggle(); }}
          title="Say what each reference supplies — identity, wardrobe, environment, lighting, pose — so the model stops deciding for you"
        />
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-2">
          <div>
            <SectionLabel>Reference roles</SectionLabel>
            <p className="mt-1 text-[10px] leading-snug text-ink3">
              Each line says what one reference supplies — and what must not carry from it. Written into the
              prompt, so it travels with a saved prompt.
            </p>
          </div>

          <div className="flex max-h-[38vh] flex-col gap-1.5 overflow-y-auto">
            {current.map((row, index) => (
              <div key={index} className="rounded-md border border-line1 bg-bg0 p-1.5">
                <div className="mb-1 flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-honey">{referenceLabelFor(index, labelStyle)}</span>
                  <span className="ml-auto text-[10px] text-ink3">{ROLE_HINT.get(row.role)}</span>
                </div>
                <NativeSelect value={row.role} onChange={(e) => set(index, { role: e.target.value })}>
                  {IMAGE_REFERENCE_ROLES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </NativeSelect>
                {row.role === 'custom' || row.note ? (
                  <TextInput
                    className="mt-1"
                    value={row.note}
                    onChange={(e) => set(index, { note: e.target.value })}
                    placeholder={row.role === 'custom' ? 'supplies only the tattoo on her forearm.' : 'anything else this one must or must not control'}
                  />
                ) : null}
              </div>
            ))}
          </div>

          {preview ? (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line1 bg-bg0 p-2 font-mono text-[10px] leading-relaxed text-ink2">
              {preview}
            </pre>
          ) : null}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => { onApply?.(current); setDraft(null); close(); }}
              className="rounded-sm border border-honey bg-honey-tint px-2 py-1 text-[11px] font-semibold text-honey transition-colors hover:border-honey"
            >
              Apply to prompt
            </button>
            {isSet ? (
              <button
                type="button"
                onClick={() => {
                  const cleared = current.map(() => ({ role: DEFAULT_IMAGE_REFERENCE_ROLE, note: '' }));
                  onApply?.(cleared);
                  setDraft(null);
                  close();
                }}
                title="Take the ownership block back out of the prompt"
                className={cx(
                  'rounded-sm border border-line1 bg-bg1 px-2 py-1 text-[11px] font-semibold text-ink1',
                  'transition-colors hover:border-line2',
                )}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Menu>
  );
}
