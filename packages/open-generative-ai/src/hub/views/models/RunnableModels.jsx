// Models tab — what this machine can actually generate with.
//
// Until now this list only existed inside each studio's picker, so there was no
// answer to "what is installed and what can it do" without opening a studio and
// scrolling a dropdown. Each card names the workflow, what it accepts, and hands
// straight over to the studio that runs it.
import { useMemo, useState } from 'react';
import { filterModels, modelCapabilityChips, modelTypeLabel, sortModels } from '../../../lib/modelLibrary.js';
import { Button, EmptyState, Pill, Segmented, TextInput } from '../../../ui/kit.jsx';
import { Icon } from '../../../ui/icons.jsx';
import { openModelInStudio } from './openInStudio.js';

function Chip({ children }) {
  return (
    <span className="rounded-sm bg-bg3 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink3">{children}</span>
  );
}

function ModelCard({ model }) {
  const chips = modelCapabilityChips(model);
  const isVideo = String(model.type || '').toLowerCase() === 'video';
  const unavailable = model.ready === false;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line1 bg-bg2 p-3.5 transition-colors hover:border-line2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 truncate text-[13px] font-semibold text-ink1">{model.name}</h3>
            {model.featured ? <Pill tone="honey">Featured</Pill> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink3">{model.description}</p>
        </div>
        {/* Two facts, two pills: what kind of model, and whether it can run
            right now — a ready model used to show a green "Image" and an
            offline one lost its type. */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Pill tone="neutral">{modelTypeLabel(model)}</Pill>
          <Pill tone={unavailable ? 'warn' : 'ok'} dot>{unavailable ? 'Offline' : 'Ready'}</Pill>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => <Chip key={chip}>{chip}</Chip>)}
        {(model.compatibleBaseModels || []).slice(0, 2).map((base) => <Chip key={base}>{base}</Chip>)}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
        <span className="min-w-0 truncate font-mono text-[10px] text-ink3" title={model.id}>{model.id}</span>
        <Button
          size="sm"
          variant="neutral"
          icon={isVideo ? 'video' : 'image'}
          disabled={unavailable}
          onClick={() => openModelInStudio(model)}
          title={isVideo ? 'Open in the Video studio' : 'Open in the Image studio'}
        >
          Open
        </Button>
      </div>
    </div>
  );
}

export function RunnableModels({ models, loading }) {
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => ({
    all: models.length,
    image: models.filter((model) => String(model.type).toLowerCase() !== 'video').length,
    video: models.filter((model) => String(model.type).toLowerCase() === 'video').length,
  }), [models]);

  const visible = useMemo(() => {
    const byType = type === 'all'
      ? models
      : models.filter((model) => (String(model.type).toLowerCase() === 'video') === (type === 'video'));
    return sortModels(filterModels(byType, query));
  }, [models, type, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line1 px-4 py-2.5 md:px-5">
        <Segmented
          options={[
            // A count of 0 is not a count worth advertising on a filter chip.
            { value: 'all', label: counts.all ? `All ${counts.all}` : 'All' },
            { value: 'image', label: counts.image ? `Image ${counts.image}` : 'Image' },
            { value: 'video', label: counts.video ? `Video ${counts.video}` : 'Video' },
          ]}
          value={type}
          onChange={setType}
          size="sm"
        />
        <div className="relative min-w-[180px] flex-1">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink3" />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workflows…"
            className="pl-8"
          />
        </div>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {visible.length ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {visible.map((model) => <ModelCard key={model.id} model={model} />)}
          </div>
        ) : (
          <EmptyState
            icon={type === 'video' && !counts.video ? 'video' : 'cpu'}
            title={loading
              ? 'Reading the local model catalog…'
              : type === 'video' && !counts.video ? 'No video models advertised here' : 'No matching models'}
            hint={loading
              ? undefined
              : type === 'video' && !counts.video
                ? 'Video models come from the studio catalog and run in the Video studio — open it to see what is installed.'
                : 'Workflow JSON dropped into ComfyUI/workflows/auto/ shows up here as a local model.'}
          />
        )}
      </div>
    </div>
  );
}
