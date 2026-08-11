// H3 character quick-add — searchable catalog of community-reported names
// (lib/h3Characters.js). Picking one hands the ENTRY to the studio's handler,
// which inserts the full source form ("Name as played by Actor from the
// television series X (1997)") — enriching a bare name already in the prompt
// in place, else appending. Rows whose full text is already present show a
// check and re-picking them is a no-op (dedupe lives in the lib).
import { useState } from 'react';
import {
  characterPromptText,
  groupH3Characters,
  searchH3Characters,
} from '../../lib/h3Characters.js';
import { zh } from './videoLogic.js';
import { ChipButton, Menu, MenuHeading } from '../../ui/Menu.jsx';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

// Inner panel so the search query lives only while the menu is open — closing
// and reopening always starts from the full list.
function CharacterPanel({ prompt, onPick, close }) {
  const [query, setQuery] = useState('');
  const groups = groupH3Characters(searchH3Characters(query));
  const promptLower = String(prompt || '').toLowerCase();
  return (
    <div className="flex flex-col gap-1">
      <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 border-b border-line1 bg-bg1 p-1.5">
        <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
          <Icon name="search" size={13} className="shrink-0 text-ink3" />
          <input
            type="text"
            autoFocus
            placeholder={zh() ? '搜索角色或作品…' : 'Search characters or series…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
          />
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">
          {zh() ? '没有匹配的角色。' : 'No characters match.'}
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.series}>
          <MenuHeading>{group.series}</MenuHeading>
          {group.characters.map((entry) => {
            const text = characterPromptText(entry);
            const added = promptLower.includes(text.toLowerCase());
            // "Sarah Michelle Gellar · 1997" — the casting and year that ride
            // along in the inserted text, so the pick is informed.
            const sub = [
              entry.actor,
              entry.year || (entry.origin?.match(/\((\d{4})\)/)?.[1] ?? ''),
              entry.hint,
            ].filter(Boolean).join(' · ');
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => { onPick(entry); close(); }}
                className={cx(
                  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
                  added ? 'bg-honey-tint' : 'hover:bg-bg2',
                )}
                title={entry.hint || text}
              >
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[12px] font-semibold', added ? 'text-honey' : 'text-ink1')}>
                    {entry.name}
                  </span>
                  {sub ? <span className="block truncate text-[10px] text-ink3">{sub}</span> : null}
                </span>
                {entry.filled ? (
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-ink3">
                    {zh() ? '系列补充' : 'series pick'}
                  </span>
                ) : null}
                {added ? <Icon name="check" size={13} className="shrink-0 text-honey" /> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CharacterMenu({ prompt, onPick }) {
  return (
    <Menu
      up
      align="end"
      width="w-[20rem]"
      trigger={(open, toggle) => (
        <ChipButton
          icon="clapper"
          label={zh() ? '角色' : 'Character'}
          active={open}
          onClick={toggle}
          title={zh()
            ? '插入社区验证过的 H3 角色名（追加到提示词）'
            : 'Insert a community-confirmed H3 character name into the prompt'}
        />
      )}
    >
      {(close) => <CharacterPanel prompt={prompt} onPick={onPick} close={close} />}
    </Menu>
  );
}
