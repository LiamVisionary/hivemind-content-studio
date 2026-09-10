// Models tab — what this machine can actually generate with.
//
// Until this page existed the list only lived inside each studio's picker, so
// there was no answer to "what is installed and what can it do" without opening
// a studio and scrolling a dropdown.
//
// The first version of this grid answered that question in the wrong currency.
// Every card carried an id in monospace, a pixel size, a step count and a row of
// base-model chips — six technical facts about a lane, none of which tells you
// what the model MAKES. A page of those reads as a config file. So the card now
// shows the two things a person chooses by, a picture and a sentence, and every
// number moved behind a click: the card opens ModelDetail, which is where the
// id, the defaults and the accepted inputs live for the times they matter.
//
// The picture comes from the bridge (lib/modelArt.js → model-artwork.js), which
// matches the model on Civitai and Hugging Face and keeps the answer. A model
// nothing matched keeps a tinted tile of its own colour rather than a hole.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { filterModels, modelTypeLabel, sortModels } from '../../../lib/modelLibrary.js';
import { loadModelCard, modelBlurb } from '../../../lib/modelArt.js';
import { localAI, isLocalAIAvailable } from '../../../lib/localInferenceClient.js';
import { Button, EmptyState, Pill, Segmented, TextInput, cx } from '../../../ui/kit.jsx';
import { Icon } from '../../../ui/icons.jsx';
import { ModelArt } from './ModelArt.jsx';
import { ModelDetail } from './ModelDetail.jsx';
import { openModelInStudio } from './openInStudio.js';
import { t, tf } from '../../../lib/i18n.js';

// Holding a model in memory (or handing the memory back) is housekeeping for
// THIS MACHINE, not a setting for the picture about to be made — it sat at the
// bottom of the Image studio's Advanced section, where a Video or Restore user
// could not reach it and an image user had to scroll past it every time.
function MachineMemory() {
  const [busy, setBusy] = useState('');
  if (!isLocalAIAvailable()) return null;

  const run = async (what, call, done, failed) => {
    if (busy) return;
    setBusy(what);
    try {
      await call();
      toast.success(done);
    } catch (error) {
      toast.error(error?.message || failed);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line1 px-4 py-2.5 md:px-5">
      <span className="text-xs text-ink3">
        {t('runnable.warmBlurb')}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          loading={busy === 'warm'}
          onClick={() => void run('warm', () => localAI.warmIdeogram4(), t('runnable.modelIsWarm'), t('runnable.warmFailed'))}
        >
          {t('runnable.warmUp')}
        </Button>
        {/* Unloading is housekeeping, not destruction — neutral, not danger. */}
        <Button
          size="sm"
          variant="neutral"
          loading={busy === 'unload'}
          onClick={() => void run('unload', () => localAI.unloadIdeogram4(), t('runnable.modelUnloaded'), t('runnable.unloadFailed'))}
        >
          {t('runnable.freeMemory')}
        </Button>
      </div>
    </div>
  );
}

function ModelCard({ model, onOpen }) {
  const [card, setCard] = useState(null);
  const unavailable = model.ready === false;
  const isVideo = String(model.type || '').toLowerCase() === 'video';

  useEffect(() => {
    let alive = true;
    void loadModelCard(model).then((resolved) => { if (alive) setCard(resolved); });
    return () => { alive = false; };
  }, [model.id]);

  return (
    // The whole card opens the model. It is a button, not a div with a click
    // handler, so it is reachable by keyboard and announced as one thing.
    <button
      type="button"
      onClick={() => onOpen(model, card)}
      className={cx(
        'group flex flex-col overflow-hidden rounded-md border border-line1 bg-bg2 text-left',
        'transition-colors hover:border-line2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-honey/60',
      )}
    >
      <div className="relative">
        <ModelArt model={model} card={card} className="aspect-[4/3] w-full" />
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          <Pill tone="neutral" className="bg-bg0/70 backdrop-blur-sm">{modelTypeLabel(model)}</Pill>
          {/* Only the exception is worth a badge. A green "Ready" on every card
              is a row of noise that makes the one offline model harder to see. */}
          {unavailable ? <Pill tone="warn" dot className="bg-bg0/70 backdrop-blur-sm">{t('providers.offline')}</Pill> : null}
        </div>
        {/* Straight to the studio without reading the details first. */}
        <div className="absolute inset-x-2 bottom-2 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            size="sm"
            variant="primary"
            icon={isVideo ? 'video' : 'image'}
            disabled={unavailable}
            title={isVideo ? t('runnable.openInVideo') : t('runnable.openInImage')}
            onClick={(event) => { event.stopPropagation(); openModelInStudio(model); }}
          >
            {t('runnable.open')}
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1 p-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="min-w-0 truncate text-[13px] font-semibold text-ink1">{model.name}</h3>
          {model.featured ? <Icon name="star" size={12} className="shrink-0 text-honey" /> : null}
        </div>
        <p className="line-clamp-2 text-xs leading-relaxed text-ink3">{modelBlurb(model, card)}</p>
      </div>
    </button>
  );
}

export function RunnableModels({ models, loading, onOpenStore = null }) {
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState(null);

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
      <MachineMemory />
      <div className="flex flex-wrap items-center gap-2 border-b border-line1 px-4 py-2.5 md:px-5">
        <Segmented
          options={[
            // A count of 0 is not a count worth advertising on a filter chip.
            { value: 'all', label: counts.all ? tf('runnable.countedFilter', t('runs.filterAll'), counts.all) : t('runs.filterAll') },
            { value: 'image', label: counts.image ? tf('runnable.countedFilter', t('nav.image'), counts.image) : t('nav.image') },
            { value: 'video', label: counts.video ? tf('runnable.countedFilter', t('common.video'), counts.video) : t('common.video') },
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
            placeholder={t('runnable.searchPlaceholder')}
            className="pl-8"
          />
        </div>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {visible.length ? (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {visible.map((model) => (
              <ModelCard key={model.id} model={model} onOpen={(picked, card) => setOpened({ model: picked, card })} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={type === 'video' && !counts.video ? 'video' : 'cpu'}
            title={loading
              ? t('runnable.readingCatalog')
              : type === 'video' && !counts.video ? t('runnable.noVideoModels') : t('runnable.noMatchingModels')}
            hint={loading
              ? undefined
              : type === 'video' && !counts.video
                ? t('runnable.videoModelsHint')
                // An empty machine used to be told to hand-write a workflow file
                // into a folder. The answer to "nothing installed" is the store.
                : t('runnable.nothingInstalledHint')}
            action={!loading && onOpenStore && !(type === 'video' && !counts.video)
              ? <Button size="sm" variant="primary" icon="download" onClick={onOpenStore}>{t('runnable.browseModels')}</Button>
              : undefined}
          />
        )}
      </div>

      {opened ? (
        <ModelDetail
          model={opened.model}
          card={opened.card}
          onOpenStore={onOpenStore}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
