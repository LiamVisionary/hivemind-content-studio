// The cast strip — WHO is in the shot, shown above the prompt.
//
// One chip per member, numbered in subject order: "1 · Your references · 3
// pictures · voice", "2 · SpongeBob · known character". The strip is the one
// place every way of adding someone lands — pictures dropped in the References
// panel, a Persona ID loaded, a saved persona or a known character added from
// the + menu — because all of them are cast members (lib/promptWeave.js) and
// the weave recasts the prompt the moment the cast changes.
//
// Clicking a chip opens the member: name, gender and look for a person (the
// look is what the cast writes into <Subject N>'s definition instead of a
// blank, and a vision-capable helper can draft it from the pictures), its own
// "+ Pictures / + Motion clip / + Voice clip" buttons (media added there is
// claimed for THAT member — how a second person gets their own pictures), how
// a character is drawn and whether it speaks in its own voice. Chips DRAG to
// reorder — order is the <Subject N> numbering — and the arrows do the same.
//
// The right-hand side says which grammar the prompt is being woven into and
// whether it is — so the status of the "magic" is never hidden.
//
// This file is the panel; every rule lives in lib/promptWeave.js.
import { useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { PERSONA_DEFAULT_STYLE } from '../../lib/castPrompt.js';
import {
  CHARACTER_STYLES,
  REFERENCES_KEY,
  characterCastMember,
  describeMember,
  memberHasMedia,
  newPersonMember,
  personaMember,
} from '../../lib/promptWeave.js';
import {
  characterOriginText,
  characterPromptText,
  characterVoiceText,
  groupH3Characters,
  searchH3Characters,
} from '../../lib/h3Characters.js';
import { PERSONA_LOOK_MAX, normalizePersonaLook, personaSummary } from '../../lib/personaId.js';
import { LIBRARIES } from '../../lib/savedLibraryStore.js';
import { useSavedLibrary } from '../../hooks/hooks.js';
import { Menu, MenuHeading, useDismissable } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { LibraryStateNote } from '../../ui/SavedLibrary.jsx';
import { cx } from '../../ui/kit.jsx';
import { GenderChips } from './PersonaBar.jsx';
import { zh } from './videoLogic.js';

// The labels for lib/promptWeave.js's CHARACTER_STYLES — how a cartoon is
// DRAWN, which is not the same as who it is.
const STYLE_LABELS = {
  native: () => (zh() ? '原作画风' : 'As drawn'),
  cgi: () => (zh() ? '半写实 CGI' : 'Semi-real CGI'),
};

const isPersonaLike = (member) => member?.kind === 'persona';

function memberName(member) {
  if (member.name) return member.name;
  if (member.key === REFERENCES_KEY) return zh() ? '你的参考' : 'Your references';
  if (String(member.key || '').startsWith('person:')) return zh() ? '新成员' : 'New person';
  return zh() ? '角色 ID' : 'Persona';
}

/** Whether the member's NAME is this strip's to edit — a saved persona is renamed by saving. */
const nameEditable = (member) => isPersonaLike(member)
  && (member.key === REFERENCES_KEY || String(member.key || '').startsWith('person:'));

/* ---------------- adding members ---------------- */

function AddPersona({ members, onAdd }) {
  const { entries, loading, locked, retry } = useSavedLibrary(LIBRARIES.personas);
  const [open, setOpen] = useState(false);
  const taken = new Set(members.filter(isPersonaLike).map((member) => member.key));
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => { if (locked) retry(); setOpen((value) => !value); }}
        className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey hover:bg-honey-tint hover:text-honey"
      >
        <Icon name="persona" size={12} />
        {zh() ? '已保存的角色 ID' : 'A saved persona'}
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
        className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey hover:bg-honey-tint hover:text-honey"
      >
        <Icon name="clapper" size={12} />
        {zh() ? '已知角色' : 'A known character'}
      </button>
      {open ? (
        <div className="rounded-md border border-line1 bg-bg2 p-1">
          <div className="mb-1 flex items-center gap-2 rounded border border-line1 bg-bg1 px-2 focus-within:border-honey">
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
                      onClick={() => { onAdd(characterCastMember(entry)); setOpen(false); setQuery(''); }}
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

/* ---------------- one member ---------------- */

function NumberBadge({ index, kind }) {
  return (
    <span
      className={cx(
        'grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold',
        kind === 'character' ? 'bg-bg3 text-ink1' : 'bg-honey text-bg0',
      )}
      aria-label={`<Subject ${index + 1}>`}
    >
      {index + 1}
    </span>
  );
}

function MemberEditor({ member, index, total, onChange, onRemove, onMove, onDraftLook, onAddMedia, referenceLane, close }) {
  const [drafting, setDrafting] = useState(false);
  const subject = `<Subject ${index + 1}>`;
  const draftLook = async () => {
    if (!onDraftLook) return;
    setDrafting(true);
    try {
      const look = await onDraftLook(member);
      if (look) onChange(member.key, { data: { ...(member.data || {}), look: normalizePersonaLook(look) } });
    } catch (error) {
      toast.error(error?.message || (zh() ? '无法从图片生成外貌描述。' : 'Could not draft the look from the pictures.'));
    } finally {
      setDrafting(false);
    }
  };
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <NumberBadge index={index} kind={member.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-ink1">{memberName(member)}</span>
          <span className="block truncate font-mono text-[10px] text-honey">{subject}</span>
        </span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label={zh() ? '前移' : 'Move earlier'}
            title={zh() ? '前移（顺序即 <Subject N> 的编号）' : 'Move earlier — cast order is the <Subject N> numbering'}
            className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="arrowRight" size={11} className="rotate-180" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label={zh() ? '后移' : 'Move later'}
            className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="arrowRight" size={11} />
          </button>
          <button
            type="button"
            onClick={() => { onRemove(member.key); close(); }}
            aria-label={zh() ? `移出 ${memberName(member)}` : `Remove ${memberName(member)} from the shot`}
            title={isPersonaLike(member)
              ? (zh() ? '移出镜头——同时从参考行移除其图片与片段' : 'Remove from the shot — its pictures and clips leave the reference rows too')
              : (zh() ? '移出镜头' : 'Remove from the shot')}
            className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      {isPersonaLike(member) ? (
        <>
          <p className="text-[10px] leading-snug text-ink3">
            {zh()
              ? `${describeMember(member, { zh: true })} · 按真人实拍渲染`
              : `${describeMember(member)} · rendered photoreal`}
          </p>
          {nameEditable(member) ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{zh() ? '名字' : 'Name'}</span>
              <input
                type="text"
                value={member.name || ''}
                maxLength={80}
                onChange={(event) => onChange(member.key, { name: event.target.value })}
                placeholder={zh() ? '可选——没有图片时会写进提示词' : 'Optional — written into the prompt when there are no pictures'}
                className="h-7 w-full rounded-md border border-line1 bg-bg1 px-2 text-[11px] text-ink1 outline-none placeholder:text-ink3 focus:border-honey"
              />
            </div>
          ) : null}
          {referenceLane && onAddMedia ? (
            <div className="flex flex-wrap items-center gap-1">
              {[
                ['images', zh() ? '+ 图片' : '+ Pictures'],
                ['videos', zh() ? '+ 动作片段' : '+ Motion clip'],
                ['audios', zh() ? '+ 声音片段' : '+ Voice clip'],
              ].map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => { onAddMedia(member.key, kind); close(); }}
                  title={zh()
                    ? '为这位成员附加参考——归属这位成员，而不是并入第一位'
                    : 'Attach references FOR this member — they are claimed here, not merged into the first person'}
                  className="rounded-md border border-dashed border-line2 px-2 py-1 text-[10px] font-medium text-ink2 transition-colors hover:border-honey hover:bg-honey-tint hover:text-honey"
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {!memberHasMedia(member) ? (
            <p className="text-[10px] leading-snug text-ink3">
              {zh()
                ? '没有参考时，这位成员由名字、性别和外貌的文字定义。'
                : 'With no references, this member is defined by the name, gender and look written here.'}
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{zh() ? '性别' : 'Gender'}</span>
            <GenderChips
              compact
              value={member.data?.gender || ''}
              onChange={(value) => onChange(member.key, { data: { ...(member.data || {}), gender: value } })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
              <span>{zh() ? '外貌' : 'Look'}</span>
              {onDraftLook ? (
                <button
                  type="button"
                  disabled={drafting || !(member.data?.images || []).length}
                  onClick={draftLook}
                  title={zh()
                    ? '让本地助手看图写出发型、面部、体型和穿着（需要已加载的视觉模型）'
                    : 'Have the local helper look at the pictures and write hair, face, build and wardrobe (needs a vision-capable model loaded)'}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 normal-case tracking-normal text-honey transition-colors hover:bg-honey-tint disabled:opacity-40"
                >
                  <Icon name="sparkles" size={10} />
                  {drafting ? (zh() ? '正在看图…' : 'Looking…') : (zh() ? '从图片生成' : 'Draft from pictures')}
                </button>
              ) : null}
            </span>
            <textarea
              rows={2}
              maxLength={PERSONA_LOOK_MAX}
              value={member.data?.look || ''}
              onChange={(event) => onChange(member.key, { data: { ...(member.data || {}), look: event.target.value } })}
              placeholder={zh()
                ? '发型、面部、体型、穿着——写出来。模型靠这些文字和图片一起认人。'
                : 'Hair, face, build, wardrobe — write it out. The model holds identity from these words as much as from the pictures.'}
              className="w-full resize-none rounded-md border border-line1 bg-bg1 px-2 py-1.5 text-[11px] leading-snug text-ink1 outline-none placeholder:text-ink3 focus:border-honey"
            />
          </div>
        </>
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
              {STYLE_LABELS[option.id]?.() || option.id}
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

function MemberChip({
  member, index, total, onChange, onRemove, onMove, onDraftLook, onAddMedia, referenceLane,
  open, onOpenChange, drag,
}) {
  // Controlled, not a Menu: the strip auto-opens a just-added person so the
  // name/look/+ Pictures are one tap away, and a drag must never read as a
  // click that pops the editor.
  const ref = useDismissable(open, () => onOpenChange(false));
  return (
    <div
      ref={ref}
      className="relative inline-block"
      draggable
      onDragStart={(event) => drag.start(event, index)}
      onDragOver={(event) => drag.over(event, index)}
      onDrop={(event) => drag.drop(event, index)}
      onDragEnd={drag.end}
    >
      <button
        type="button"
        onClick={() => { if (!drag.happened()) onOpenChange(!open); }}
        title={isPersonaLike(member)
          ? (zh() ? '名字、性别、外貌、参考、顺序（可拖动排序）' : 'Name, gender, look, references, order — drag to reorder')
          : (zh() ? '画风、声音、顺序（可拖动排序）' : 'Style, voice, order — drag to reorder')}
        className={cx(
          'inline-flex h-7 max-w-[260px] cursor-grab items-center gap-1.5 rounded-md border px-1.5 text-[12px] transition-colors active:cursor-grabbing',
          open ? 'border-honey bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2 hover:bg-bg3',
          drag.overIndex === index && drag.fromIndex !== index && 'border-honey ring-1 ring-honey',
          drag.fromIndex === index && 'opacity-50',
        )}
      >
        <NumberBadge index={index} kind={member.kind} />
        <span className="truncate font-medium text-ink1">{memberName(member)}</span>
        <span className="hidden truncate text-[10px] text-ink3 sm:inline">
          {isPersonaLike(member) ? describeMember(member, { zh: zh() }) : (zh() ? '已知角色' : 'known character')}
        </span>
      </button>
      {open ? (
        <div className="hive-scale-in absolute bottom-[calc(100%+6px)] left-0 z-50 max-h-[min(420px,60vh)] w-[19rem] overflow-y-auto rounded-lg border border-line1 bg-bg1 p-1.5 shadow-pop" role="dialog">
          <MemberEditor
            member={member}
            index={index}
            total={total}
            onChange={onChange}
            onRemove={onRemove}
            onMove={onMove}
            onDraftLook={onDraftLook}
            onAddMedia={onAddMedia}
            referenceLane={referenceLane}
            close={() => onOpenChange(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- the strip ---------------- */

/**
 * @param {object}   props
 * @param {Array}    props.members          the cast, owned by the studio (already reconciled with the rows)
 * @param {Function} props.onMembersChange  (members) => void — applies at once: rows and prompt
 * @param {string}   props.target           'reference' | 'h3-text' | 'prose' (lib/promptWeave.js weaveTarget)
 * @param {boolean}  props.referenceLane    the workflow has reference slots, so a persona can join
 * @param {boolean}  props.h3               MiniMax H3 — the lane readout (reference / text) applies
 * @param {boolean}  props.woven            the prompt already carries this cast's definitions
 * @param {boolean}  props.promptEmpty      nothing written yet
 * @param {Array}    props.warnings         from the last weave
 * @param {Function} props.onAttach         open the References panel (pictures / clips by hand)
 * @param {Function} props.onWeave          the explicit weave
 * @param {Function} [props.onDraftLook]    (member) => Promise<string> — vision helper, or null when none
 * @param {Function} [props.onAddMedia]     (memberKey, 'images'|'videos'|'audios') => void — attach FOR one member
 */
export function CastStrip({
  members = [], onMembersChange, target = 'prose', referenceLane = false, h3 = false,
  woven = false, promptEmpty = true, warnings = [], onAttach, onWeave, onDraftLook = null, onAddMedia = null,
}) {
  const setMembers = (next, options) => onMembersChange?.(typeof next === 'function' ? next(members) : next, options);
  // Which member's editor is open — controlled here so a just-added person
  // opens ready to name, describe and fill with pictures.
  const [openKey, setOpenKey] = useState('');
  const add = (member) => setMembers((list) => (
    list.some((item) => item.key === member.key) ? list : [...list, member]
  ));
  const remove = (key) => {
    if (openKey === key) setOpenKey('');
    setMembers((list) => list.filter((item) => item.key !== key));
  };
  // An attribute edit re-weaves silently (no toast per keystroke).
  const change = (key, patch) => setMembers((list) => list.map((item) => (
    item.key === key ? { ...item, ...patch } : item
  )), { announce: false });
  const move = (index, delta) => setMembers((list) => {
    const next = [...list];
    const to = index + delta;
    if (to < 0 || to >= next.length) return list;
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });

  // Drag to reorder — order IS the <Subject N> numbering, so dragging chip 1
  // past chip 2 renumbers both. State lives in refs plus one render nudge: the
  // browser owns the drag, React only paints the highlight.
  const [dragPaint, setDragPaint] = useState({ from: -1, over: -1 });
  const dragFromRef = useRef(-1);
  const dragHappenedRef = useRef(0);
  const drag = {
    fromIndex: dragPaint.from,
    overIndex: dragPaint.over,
    start: (event, index) => {
      dragFromRef.current = index;
      dragHappenedRef.current = Date.now();
      event.dataTransfer.effectAllowed = 'move';
      try { event.dataTransfer.setData('text/plain', String(index)); } catch { /* older engines */ }
      setDragPaint({ from: index, over: -1 });
    },
    over: (event, index) => {
      if (dragFromRef.current === -1) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dragPaint.over !== index) setDragPaint((paint) => ({ ...paint, over: index }));
    },
    drop: (event, index) => {
      event.preventDefault();
      const from = dragFromRef.current;
      dragHappenedRef.current = Date.now();
      if (from !== -1 && from !== index) {
        setMembers((list) => {
          const next = [...list];
          const [taken] = next.splice(from, 1);
          next.splice(index, 0, taken);
          return next;
        });
      }
      dragFromRef.current = -1;
      setDragPaint({ from: -1, over: -1 });
    },
    end: () => {
      dragFromRef.current = -1;
      dragHappenedRef.current = Date.now();
      setDragPaint({ from: -1, over: -1 });
    },
    // A finished (or abandoned) drag must not read as the click that follows
    // it — the editor popping open after every reorder was noise.
    happened: () => Date.now() - dragHappenedRef.current < 250,
  };

  // Anyone can be a second subject: a person added here starts empty and is
  // filled by its own "+ Pictures", or stays defined by name, gender and look.
  const addPerson = (close) => {
    const person = newPersonMember(members);
    add(person);
    setOpenKey(person.key);
    close();
  };

  const lane = target === 'reference'
    ? (zh() ? '参考模式' : 'Reference lane')
    : target === 'h3-text'
      ? (zh() ? '文字模式' : 'Text lane')
      : '';
  const unwoven = target === 'reference' && members.length > 0 && !promptEmpty && !woven;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-cast-strip>
      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
        {zh() ? '镜头里是谁' : 'In the shot'}
      </span>
      {members.map((member, index) => (
        <MemberChip
          key={member.key}
          member={member}
          index={index}
          total={members.length}
          onChange={change}
          onRemove={remove}
          onMove={move}
          onDraftLook={isPersonaLike(member) ? onDraftLook : null}
          onAddMedia={onAddMedia}
          referenceLane={referenceLane}
          open={openKey === member.key}
          onOpenChange={(next) => setOpenKey(next ? member.key : '')}
          drag={drag}
        />
      ))}

      <Menu
        up
        width="w-[19rem]"
        trigger={(open, toggle) => (
          <button
            type="button"
            onClick={toggle}
            title={zh()
              ? '加入镜头：上传图片或片段、已保存的角色 ID、已知角色'
              : 'Put someone in the shot: upload pictures or clips, a saved persona, or a known character'}
            className={cx(
              'inline-flex h-7 items-center gap-1 rounded-md border border-dashed px-2 text-[12px] font-medium transition-colors',
              open ? 'border-honey bg-honey-tint text-honey' : 'border-line2 text-ink2 hover:border-honey hover:bg-honey-tint hover:text-honey',
            )}
          >
            <Icon name="plus" size={12} />
            {members.length ? (zh() ? '加入' : 'Add') : (zh() ? '加入某人' : 'Add someone')}
          </button>
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] leading-snug text-ink3">
              {zh()
                ? '顺序即编号：第一位是 <Subject 1>。提示词里用 <Subject N> 指代，换人也能用。'
                : 'Order is the numbering — the first member is <Subject 1>. Prompts written against <Subject N> work with any cast.'}
            </p>
            {referenceLane && !members.length ? (
              <button
                type="button"
                onClick={() => { onAttach?.(); close(); }}
                className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey hover:bg-honey-tint hover:text-honey"
              >
                <Icon name="upload" size={12} />
                {zh() ? '图片或片段（参考面板）' : 'Pictures or clips of a person'}
              </button>
            ) : null}
            {/* Anyone can be a second subject — a NEW person, never merged into
                the first. On a lane with reference slots they get their own
                pictures from the chip's + buttons; anywhere they can be defined
                by name, gender and look alone. */}
            <button
              type="button"
              onClick={() => addPerson(close)}
              title={referenceLane
                ? (zh()
                  ? '新增一位成员：用成员卡片上的 + 按钮为 TA 附加图片/片段，或仅用文字定义'
                  : "Add a new member — give them their own pictures with the chip's + buttons, or define them in text")
                : (zh()
                  ? '此模型没有参考槽位——新成员由名字、性别和外貌的文字定义'
                  : 'This model has no reference slots — the new member is defined by name, gender and look in text')}
              className="flex items-center gap-1.5 rounded-md border border-dashed border-line2 px-2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey hover:bg-honey-tint hover:text-honey"
            >
              <Icon name="plus" size={12} />
              {members.length ? (zh() ? '另一位成员' : 'Another person') : (zh() ? '仅用文字定义的成员' : 'A person described in text')}
            </button>
            {referenceLane ? <AddPersona members={members} onAdd={(member) => { add(member); close(); }} /> : null}
            <AddCharacter members={members} onAdd={(member) => { add(member); close(); }} />
            {members.length ? null : (
              <p className="text-[10px] leading-snug text-ink3">
                {zh() ? `角色 ID 默认${PERSONA_DEFAULT_STYLE}` : `A person from pictures is rendered ${PERSONA_DEFAULT_STYLE}.`}
              </p>
            )}
          </div>
        )}
      </Menu>

      <span className="min-w-2 flex-1" />

      {warnings.length ? (
        <Menu
          up
          align="end"
          width="w-[22rem]"
          trigger={(open, toggle) => (
            <button
              type="button"
              onClick={toggle}
              title={zh() ? '织入时的提醒' : 'Notes from the last weave'}
              className={cx(
                'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-colors',
                open ? 'bg-honey-tint text-honey' : 'text-honey hover:bg-honey-tint',
              )}
            >
              <Icon name="info" size={11} />
              {warnings.length}
            </button>
          )}
        >
          <ul className="flex flex-col gap-1">
            {warnings.map((text) => (
              <li key={text} className="text-[10px] leading-snug text-ink2">{text}</li>
            ))}
          </ul>
        </Menu>
      ) : null}

      {h3 && lane ? (
        <span className="inline-flex items-center gap-1.5 text-[10px] text-ink3" data-weave-status>
          <span>{lane}</span>
          {target === 'reference' && members.length ? (
            unwoven ? (
              <button
                type="button"
                onClick={onWeave}
                className="rounded border border-honey bg-honey-tint px-1.5 py-0.5 font-medium text-honey transition-colors hover:bg-bg2"
                title={zh()
                  ? '提示词还没有按参考改写——点此织入'
                  : 'The prompt does not address your references yet — weave them in'}
              >
                {zh() ? '织入提示词' : 'Weave into prompt'}
              </button>
            ) : (promptEmpty ? null : (
              <span className="inline-flex items-center gap-0.5 text-honey">
                <Icon name="check" size={10} />
                {zh() ? '已织入' : 'woven'}
              </span>
            ))
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
