// The image studio's model picker — a ChipButton that opens the local/cloud
// catalogs. Lifted out of ImageStudio.jsx so both the settings panel and the
// composer carry the same readout without a second implementation.
import { useState } from 'react';

import { i2iModels, t2iModels } from '../../lib/models.js';
import { servedByAnyMachine } from '../../lib/rentedMachines.js';
import { t } from '../../lib/i18n.js';
import { Icon } from '../../ui/icons.jsx';
import { Pill } from '../../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';

// A cloud model only exists as an editing tool when it has no text-to-image row.
const apiModelRequiresImage = (id) => i2iModels.some((m) => m.id === id) && !t2iModels.some((m) => m.id === id);

export function ModelMenu({
  engine, modelLabel, hasRefs, onSelectLocal, onSelectApi,
  // The panel wants a full-width chip; the composer wants an ordinary one.
  className = 'w-full max-w-full justify-between',
}) {
  return (
    <Menu
      width="w-[300px]"
      panelClassName="max-h-[min(480px,70vh)]"
      trigger={(open, toggle) => (
        <ChipButton
          icon={engine.useLocalModel ? 'cpu' : 'cloud'}
          value={modelLabel}
          active={open}
          onClick={toggle}
          title={t('image.modelTooltip')}
          className={className}
        />
      )}
    >
      {(close) => (
        <ModelMenuList
          engine={engine}
          hasRefs={hasRefs}
          close={close}
          onSelectLocal={onSelectLocal}
          onSelectApi={onSelectApi}
        />
      )}
    </Menu>
  );
}

export function ModelMenuList({ engine: s, hasRefs, close, onSelectLocal, onSelectApi }) {
  const [filter, setFilter] = useState('');
  const query = filter.toLowerCase();
  const matches = (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);

  const search = (
    <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 border-b border-line1 bg-bg1 p-1.5">
      <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
        <Icon name="search" size={13} className="shrink-0 text-ink3" />
        <input
          type="text"
          autoFocus
          placeholder={t('common.searchModels')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
        />
      </div>
    </div>
  );

  if (s.useLocalModel) {
    // Runtime-discovered, launchable local image workflows — never filtered by refs.
    const list = (s.rentedOnly && s.rentedMachines?.length)
      ? s.localImageModels.filter((m) => servedByAnyMachine(s.rentedMachines, m))
      : s.localImageModels;
    const filtered = list.filter(matches);
    return (
      <>
        {search}
        {filtered.length === 0 ? (
          <div className="px-2.5 py-4 text-center text-xs text-ink3">{t('common.noResults')}</div>
        ) : (
          filtered.map((m) => (
            <MenuItem
              key={m.id}
              selected={s.selectedLocalModel === m.id}
              meta={`${String(m.type || 'image').toUpperCase()} · ${m.family || 'local'}`}
              onClick={() => { onSelectLocal(m); close(); }}
            >
              <span className="inline-flex items-center gap-1.5">
                {m.name}
                {m.featured ? <Pill tone="honey" className="h-4 px-1.5 text-[9px]">Featured</Pill> : null}
                {m.requires?.image ? <Pill tone="warn" className="h-4 px-1.5 text-[9px]">Image required</Pill> : null}
              </span>
            </MenuItem>
          ))
        )}
      </>
    );
  }

  // Remote (API) model list — two labeled sections; models are never hidden
  // because of references. Editing models lead when references are attached.
  const sections = [
    {
      label: hasRefs ? 'Text to image — ignores your reference' : 'Text to image',
      models: t2iModels.filter(matches),
      editing: false,
    },
    {
      label: hasRefs ? 'Image editing — uses your reference' : 'Image editing — works with a reference image',
      models: i2iModels.filter(matches),
      editing: true,
    },
  ];
  if (hasRefs) sections.reverse();
  const any = sections.some((section) => section.models.length);

  return (
    <>
      {search}
      {!any ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">{t('common.noResults')}</div>
      ) : (
        sections.map((section) => (
          section.models.length ? (
            <div key={section.label}>
              <MenuHeading>{section.label}</MenuHeading>
              {section.models.map((m) => {
                const requiresImage = section.editing && apiModelRequiresImage(m.id);
                return (
                  <MenuItem
                    key={m.id}
                    selected={s.selectedModel === m.id}
                    meta={m.family || ''}
                    onClick={() => { onSelectApi(m); close(); }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {m.name}
                      {requiresImage ? (
                        <Pill tone="warn" className="h-4 px-1.5 text-[9px]">Image required</Pill>
                      ) : section.editing ? (
                        <Pill tone="honey" className="h-4 px-1.5 text-[9px]">Image</Pill>
                      ) : null}
                    </span>
                  </MenuItem>
                );
              })}
            </div>
          ) : null
        ))
      )}
    </>
  );
}
