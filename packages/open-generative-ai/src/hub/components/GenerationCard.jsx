// Run generation stage card — the image/video result cards that stream into the
// Planner thread. Derivations (stages, status, timing, estimated progress) all
// live in hubData (buildRunGenerationCards etc.); this only renders them. Media
// flows through useMediaSrc so E2E-encrypted artifacts keep decrypting client
// side, and the 1s running-ticker re-renders via React state instead of the old
// innerHTML churn — so a playing <video> preview is never restarted.
import { memo, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, ProgressBar, cx } from '../../ui/kit.jsx';
import {
  generationArtifactUrl, generationProgressPct, generationStatusLabel,
  generationTiming, providerLabel,
} from '../hubData.js';
import { Lightbox } from './Lightbox.jsx';
import { StatusPill } from './StatusPill.jsx';

// useMediaSrc hands back '' while a sealed artifact decrypts; an <img src="">
// is a React warning and a broken-image glyph, so show a skeleton until then.
function ArtifactImage({ run, artifact, index, onOpen }) {
  const src = useMediaSrc(generationArtifactUrl(run, artifact));
  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      disabled={!src}
      aria-label={`Open generated image ${index + 1}`}
      className="group relative aspect-square overflow-hidden rounded-md border border-line1 bg-bg3 transition-colors hover:border-line2"
    >
      {src
        ? <img src={src} alt={`Generated ${index + 1}`} loading="lazy" className="h-full w-full object-cover" />
        : <span className="block h-full w-full animate-pulse bg-bg2" />}
    </button>
  );
}

function ArtifactVideo({ run, artifact }) {
  const src = useMediaSrc(generationArtifactUrl(run, artifact));
  return (
    <video
      src={src}
      controls controlsList="nodownload"
      preload="metadata"
      className="w-full rounded-md border border-line1 bg-black"
    />
  );
}

function SourceThumb({ run, artifact, onOpen }) {
  const src = useMediaSrc(generationArtifactUrl(run, artifact));
  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      disabled={!src}
      aria-label="Open source image preview"
      className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-line1 bg-bg3"
    >
      {src
        ? <img src={src} alt="Source" className="h-full w-full object-cover" />
        : <span className="block h-full w-full animate-pulse bg-bg2" />}
    </button>
  );
}

export const GenerationCard = memo(function GenerationCard({ run, card, onOpenRun }) {
  const [preview, setPreview] = useState(null);
  const progress = generationProgressPct(card);
  const headerIcon = card.status === 'running' ? 'sparkles' : card.kind === 'video' ? 'video' : 'image';

  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line1 bg-bg2 p-3.5 shadow-card">
      <header className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-honey-tint text-honey">
          <Icon name={headerIcon} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-semibold text-ink1">{card.title}</strong>
          <small className="block truncate text-[11px] text-ink3">
            {providerLabel(card.provider)} · <span className="font-mono">{card.model}</span>
            <span className="font-mono">{generationTiming(card)}</span>
          </small>
        </span>
        <StatusPill status={card.status} label={generationStatusLabel(card.status)} />
      </header>

      {card.artifacts.length ? (
        card.kind === 'video' ? (
          <div className="flex flex-col gap-2">
            {card.artifacts.map((artifact) => <ArtifactVideo key={artifact.id} run={run} artifact={artifact} />)}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
            {card.artifacts.map((artifact, index) => (
              <ArtifactImage key={artifact.id} run={run} artifact={artifact} index={index} onOpen={setPreview} />
            ))}
          </div>
        )
      ) : (
        <div
          className={cx(
            'grid min-h-[96px] place-items-center rounded-md border border-dashed border-line1 px-4 py-6 text-center text-xs',
            card.status === 'running' ? 'text-honey' : 'text-ink3',
          )}
        >
          <span>{card.status === 'running' ? 'Generating with the selected provider' : card.detail}</span>
        </div>
      )}

      {progress != null ? <ProgressBar value={progress / 100} /> : null}

      {card.status === 'error' ? (
        <p className="rounded-md bg-danger-tint px-3 py-2 font-mono text-xs text-danger">{card.error || card.detail}</p>
      ) : null}

      <div className="flex items-start gap-3 rounded-md bg-bg1 p-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink3">Prompt</div>
          {/* A machine-redacted run carries no prompt text; say so rather than
              printing the run id in its place. */}
          <p className={cx('mt-0.5 line-clamp-3 text-[13px] leading-relaxed', card.prompt ? 'text-ink2' : 'text-ink3')}>
            {card.prompt || 'Prompt not available for this run'}
          </p>
        </div>
        {card.sourceArtifacts?.[0] ? (
          <SourceThumb run={run} artifact={card.sourceArtifacts[0]} onOpen={setPreview} />
        ) : null}
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="ghost" icon="arrowRight" onClick={() => onOpenRun?.(run.run_id)}>
          Open generation step
        </Button>
      </div>

      {preview ? <Lightbox src={preview} kind="image" title="Generated image" alt="Generated image" onClose={() => setPreview(null)} /> : null}
    </article>
  );
});
