// The cast — who is in the shot, and the one control that turns that into a
// prompt plus a set of references.
//
// Two kinds of member, and the only difference is whether they bring media:
//
//   persona    a saved Hive Persona ID. Brings pictures, motion and voice, so
//              it OCCUPIES <Picture N> / <Video N> / <Audio N> slots.
//   character  a name H3 already knows (SpongeBob, Willow, Neo). Brings text
//              and a voice it can be asked for by name; occupies nothing.
//
// Both become a <Subject i>, which is the whole point: a prompt in the library
// addresses SUBJECTS, and this decides which pictures those subjects are. So
// one saved fight runs with one persona, with two, or with a persona and a
// cartoon, and the numbering underneath is re-derived every time instead of
// being baked into somebody's saved text.
//
// Applying does both halves at once, because doing one without the other is
// exactly how a prompt ends up addressing a <Picture 7> that is not attached:
// the personas' references are loaded into the rows, and the prompt's
// subject_definitions and retention_analysis are rewritten to match. The
// creative half — summary, description, soundscape, music — is left alone.
//
// The rules all live in lib/castPrompt.js; this file is the panel around them.
import { useState } from 'react';
import {
  PERSONA_DEFAULT_STYLE,
  applyCastToPrompt,
  castCharacter,
  castPersona,
} from '../../lib/castPrompt.js';
import {
  characterOriginText,
  characterPromptText,
  characterVoiceText,
  groupH3Characters,
  searchH3Characters,
} from '../../lib/h3Characters.js';
import { personaSummary } from '../../lib/personaId.js';
import { LIBRARIES } from '../../lib/savedLibraryStore.js';
import { useSavedLibrary } from '../../hooks/hooks.js';
import { ChipButton, Menu, MenuHeading } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { LibraryStateNote } from '../../ui/SavedLibrary.jsx';
import { SectionLabel, cx } from '../../ui/kit.jsx';
import { zh } from './videoLogic.js';

// How a cartoon is DRAWN, which is not the same as who it is. Left native by
// default; the CGI option exists because a flat-2D character standing next to a
// photographed person is the one combination people actually ask for, and
// because saying nothing let a scene style restyle BOTH of them (2026-08-12).
const CHARACTER_STYLES = [
  { id: 'native', label: () => (zh() ? '原作画风' : 'As drawn'), style: '' },
  {
    id: 'cgi',
    label: () => (zh() ? '半写实 CGI' : 'Semi-real CGI'),
    style: '3D CGI character animation with soft subsurface shading and cinematic lighting — '
      + 'semi-realistic and physically present in the scene, NOT flat 2D animation and NOT pixel art',
  },
];

const styleById = (id) => CHARACTER_STYLES.find((option) => option.id === id) || CHARACTER_STYLES[0];

/** A cast member as the panel holds it, before castPrompt.js sees it. */
const personaMember = (entry) => ({
  key: `persona:${entry.id}`,
  kind: 'persona',
  name: entry.name,
  data: entry.data,
});

const characterMember = (entry) => ({
  key: `character:${entry.name}`,
  kind: 'character',
  name: entry.name,
  entry,
  styleId: 'native',
  // A known character's voice is asked for by NAME, in the dialogue tag. On by
  // default: it is the only way this character can sound like itself, since it
  // brings no voice clip to clone.
  useVoice: true,
});

/** Panel member -> the cast description castPrompt.js compiles. */
function toCastMember(member) {
  if (member.kind === 'persona') return castPersona(member.name, member.data);
  return castCharacter(member.name, characterPromptText(member.entry), {
    style: styleById(member.styleId).style,
    voice: member.useVoice ? characterVoiceText(member.entry) : '',
  });
}

function AddPersona({ members, onAdd }) {
  const { entries, loading, locked, retry } = useSavedLibrary(LIBRARIES.personas);
  const [open, setOpen] = useState(false);
  const taken = new Set(members.filter((member) => member.kind === 'persona').map((member) => member.key));
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => { if (locked) retry(); setOpen((value) => !value); }}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey/60 hover:bg-honey-tint hover:text-honey"
      >
        <Icon name="persona" size={12} />
        {zh() ? '加入角色 ID' : 'Add a persona'}
      </button>
      {open ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-line1 bg-bg2 p-1">
          <LibraryStateNote
            loading={loading}
            locked={locked}
            empty={!entries.length}
            emptyHint={zh()
              ? '还没有保存的角色 ID。先在参考面板里保存一个。'
              : 'No personas saved yet — save one from the References panel first.'}
          />
          {entries.map((entry) => {
            const already = taken.has(`persona:${entry.id}`);
            return (
              <button
                key={entry.id}
                type="button"
                disabled={already}
                onClick={() => { onAdd(personaMember(entry)); setOpen(false); }}
                className={cx(
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors',
                  already ? 'opacity-40' : 'hover:bg-bg3',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-semibold text-ink1">{entry.name}</span>
                  <span className="block truncate text-[10px] text-ink3">{personaSummary(entry.data)}</span>
                </span>
                {already ? <Icon name="check" size={12} className="shrink-0 text-honey" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AddCharacter({ members, onAdd }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const taken = new Set(members.filter((member) => member.kind === 'character').map((member) => member.key));
  const groups = open ? groupH3Characters(searchH3Characters(query)) : [];
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey/60 hover:bg-honey-tint hover:text-honey"
      >
        <Icon name="clapper" size={12} />
        {zh() ? '加入已知角色' : 'Add a known character'}
      </button>
      {open ? (
        <div className="rounded-md border border-line1 bg-bg2 p-1">
          <div className="mb-1 flex items-center gap-2 rounded border border-line1 bg-bg1 px-2 focus-within:border-honey/60">
            <Icon name="search" size={12} className="shrink-0 text-ink3" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh() ? '搜索角色或作品…' : 'Search characters or series…'}
              className="h-7 w-full border-none bg-transparent text-[11px] text-ink1 outline-none placeholder:text-ink3"
            />
          </div>
          <div className="max-h-40 overflow-y-auto">
            {groups.length ? null : (
              <p className="px-2 py-3 text-center text-[10px] text-ink3">
                {zh() ? '没有匹配的角色。' : 'No characters match.'}
              </p>
            )}
            {groups.map((group) => (
              <div key={group.series}>
                <MenuHeading>{group.series}</MenuHeading>
                {group.characters.map((entry) => {
                  const already = taken.has(`character:${entry.name}`);
                  return (
                    <button
                      key={entry.name}
                      type="button"
                      disabled={already}
                      onClick={() => { onAdd(characterMember(entry)); setOpen(false); setQuery(''); }}
                      title={characterPromptText(entry)}
                      className={cx(
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors',
                        already ? 'opacity-40' : 'hover:bg-bg3',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-ink1">{entry.name}</span>
                        <span className="block truncate text-[10px] text-ink3">{characterOriginText(entry)}</span>
                      </span>
                      {already ? <Icon name="check" size={12} className="shrink-0 text-honey" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CastRow({ member, index, total, onChange, onRemove, onMove }) {
  const subject = `<Subject ${index + 1}>`;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line1 bg-bg2 p-1.5">
      <div className="flex items-center gap-2">
        <Icon
          name={member.kind === 'persona' ? 'persona' : 'clapper'}
          size={13}
          className="shrink-0 text-ink3"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-semibold text-ink1">{member.name}</span>
          <span className="block truncate font-mono text-[10px] text-honey">{subject}</span>
        </span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label={zh() ? '上移' : 'Move up'}
            title={zh() ? '上移（决定 <Subject N> 的编号）' : 'Move up — cast order is the <Subject N> numbering'}
            className="grid h-6 w-5 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="chevronDown" size={11} className="rotate-180" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label={zh() ? '下移' : 'Move down'}
            className="grid h-6 w-5 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="chevronDown" size={11} />
          </button>
          <button
            type="button"
            onClick={() => onRemove(member.key)}
            aria-label={zh() ? `移出 ${member.name}` : `Remove ${member.name}`}
            className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      {member.kind === 'persona' ? (
        // Stated, not offered: a person defined by photographs is photoreal, and
        // the failure this prevents is a scene style ("fighting game") turning
        // her into a sprite because nothing said how she should be drawn.
        <p className="text-[10px] leading-snug text-ink3">
          {zh()
            ? `${personaSummary(member.data)} · 按真人实拍渲染`
            : `${personaSummary(member.data)} · rendered photoreal`}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {CHARACTER_STYLES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(member.key, { styleId: option.id })}
              className={cx(
                'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                member.styleId === option.id ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
              )}
            >
              {option.label()}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(member.key, { useVoice: !member.useVoice })}
            title={characterVoiceText(member.entry)}
            className={cx(
              'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              member.useVoice ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
            )}
          >
            {zh() ? '本人声音' : 'own voice'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {string}   props.prompt           what is in the composer now
 * @param {object}   props.limits           the running workflow's slot counts
 * @param {number}   props.durationSeconds  what the run is set to produce
 * @param {Function} props.onApply          ({ prompt, images, videos, audios, warnings }) => void
 */
export function CastMenu({ prompt = '', limits, durationSeconds = 0, onApply }) {
  const [members, setMembers] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const add = (member) => setMembers((list) => (
    list.some((item) => item.key === member.key) ? list : [...list, member]
  ));
  const remove = (key) => setMembers((list) => list.filter((item) => item.key !== key));
  const change = (key, patch) => setMembers((list) => list.map((item) => (
    item.key === key ? { ...item, ...patch } : item
  )));
  const move = (index, delta) => setMembers((list) => {
    const next = [...list];
    const to = index + delta;
    if (to < 0 || to >= next.length) return list;
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });

  const apply = () => {
    const cast = members.map(toCastMember);
    const result = applyCastToPrompt(prompt, { members: cast, limits, durationSeconds });
    setWarnings(result.warnings);
    const { images, videos, audios } = result.allocation;
    // A cast of exactly one persona leaves the rows still BEING that saved
    // character, so it keeps its name. Two personas, or a persona beside a
    // cartoon, and the name would misdescribe what is attached.
    const only = members.length === 1 && members[0].kind === 'persona' ? members[0] : null;
    onApply?.({
      prompt: result.prompt,
      images,
      videos,
      audios,
      warnings: result.warnings,
      persona: only ? { id: only.key.slice('persona:'.length), name: only.name } : null,
    });
  };

  return (
    <Menu
      up
      align="end"
      width="w-[21rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="persona"
          label={zh() ? '演员表' : 'Cast'}
          value={members.length ? String(members.length) : ''}
          active={open || members.length > 0}
          onClick={toggle}
          title={zh()
            ? '把角色 ID 和已知角色组成演员表：一次写好主体定义、参考标签与参考行'
            : 'Build the shot from personas and known characters — writes the subject definitions, the reference tags, and the reference rows in one step'}
        />
      )}
    >
      {() => (
        <div className="flex flex-col gap-2">
          <div>
            <SectionLabel>{zh() ? '演员表' : 'Cast'}</SectionLabel>
            <p className="mt-1 text-[10px] leading-snug text-ink3">
              {zh()
                ? '顺序即编号：第一位是 <Subject 1>。提示词里请用 <Subject N> 指代，这样同一段提示词换人也能用。'
                : 'Order is the numbering — the first member is <Subject 1>. Write prompts against <Subject N> and the same prompt works with any cast.'}
            </p>
          </div>

          {members.map((member, index) => (
            <CastRow
              key={member.key}
              member={member}
              index={index}
              total={members.length}
              onChange={change}
              onRemove={remove}
              onMove={move}
            />
          ))}

          <AddPersona members={members} onAdd={add} />
          <AddCharacter members={members} onAdd={add} />

          {warnings.length ? (
            <ul className="flex flex-col gap-1 rounded-md border border-honey/40 bg-honey-tint p-1.5">
              {warnings.map((text) => (
                <li key={text} className="text-[10px] leading-snug text-honey">{text}</li>
              ))}
            </ul>
          ) : null}

          <button
            type="button"
            disabled={!members.length}
            onClick={apply}
            title={zh()
              ? '写入主体定义与 retention_analysis，并把角色 ID 的参考载入参考行'
              : "Writes subject_definitions and retention_analysis, and loads the personas' references into the reference rows"}
            className={cx(
              'rounded-md border px-2 py-1.5 text-[11px] font-semibold transition-colors',
              members.length
                ? 'border-honey/50 bg-honey-tint text-honey hover:border-honey'
                : 'cursor-not-allowed border-line1 bg-bg1 text-ink3 opacity-50',
            )}
          >
            {zh() ? '应用到提示词与参考' : 'Apply to prompt + references'}
          </button>
          <p className="text-[10px] leading-snug text-ink3">
            {zh()
              ? '只重写主体定义与 retention_analysis，其余（摘要、镜头描述、音景、配乐）保持不变。'
              : 'Only subject_definitions and retention_analysis are rewritten. Your summary, description, soundscape and music are left as written.'}
          </p>
          {members.length ? null : (
            <p className="text-[10px] leading-snug text-ink3">
              {zh() ? `角色 ID 默认${PERSONA_DEFAULT_STYLE}` : `A persona is rendered ${PERSONA_DEFAULT_STYLE}.`}
            </p>
          )}
        </div>
      )}
    </Menu>
  );
}
