// One model, in full — everything the grid deliberately leaves out.
//
// The card is a picture and a sentence, because that is what a person chooses a
// model by. This is where the rest lives: what the model is, who publishes it,
// where to read about it, what it accepts, and the ids and defaults that matter
// when something has to be debugged rather than chosen. Splitting them this way
// is the whole point of the redesign — the technical half is one click away
// instead of printed on every tile.
//
// The description and the links are matched by the bridge on Civitai and
// Hugging Face, so they are labelled with where they came from. A weak match
// says so out loud rather than presenting a guess as this model's page.
import { toast } from 'react-hot-toast';
import { Button, CollapsibleSection, Pill, SectionLabel, cx } from '../../../ui/kit.jsx';
import { Modal } from '../../../ui/Modal.jsx';
import { Icon } from '../../../ui/icons.jsx';
import { modelCapabilityChips, modelTypeLabel } from '../../../lib/modelLibrary.js';
import { cardArtKind, cardIsGuess, cardSourceKind, modelBlurb } from '../../../lib/modelArt.js';
import { ModelArt } from './ModelArt.jsx';
import { openModelInStudio } from './openInStudio.js';
import { t, tf } from '../../../lib/i18n.js';

async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error(t('assets.copyFailed'));
  }
}

// `wrap` for the rows whose value is a LIST — samplers, aspect ratios, accepted
// inputs. Truncating those hides most of the answer, and the answer is the only
// reason the row is here.
// Three destinations, three labels: the open mirror is named as one rather than
// opening a civitai.red address under a button that says Civitai.
function linkLabel(link) {
  if (link?.kind === 'huggingface') return t('modelCard.readOnHuggingFace');
  if (link?.kind === 'civitai-mirror') return t('modelCard.readOnCivitaiMirror');
  return t('modelCard.readOnCivitai');
}

function Row({ label, children, wrap = false }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line1 py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-ink3">{label}</span>
      <span className={cx('min-w-0 text-right text-[13px] text-ink1', wrap ? 'break-words' : 'truncate')}>{children}</span>
    </div>
  );
}

// A capability in words rather than in field names: "Up to 4 reference images"
// beats `maxReferenceImages: 4`, and it is the same fact.
function Ability({ icon, children }) {
  return (
    <li className="flex items-start gap-2 text-[13px] leading-relaxed text-ink2">
      <Icon name={icon} size={13} className="mt-0.5 shrink-0 text-honey" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function abilities(model) {
  const found = [];
  const isVideo = String(model.type || '').toLowerCase() === 'video';
  const references = Number(model.maxReferenceImages || model.referenceSlots?.images || 0);
  const needsImage = Boolean(model.requires?.image || model.needsImage);
  found.push({
    icon: needsImage ? 'image' : 'wand',
    text: needsImage ? t('modelCard.needsPicture') : t('modelCard.fromPrompt'),
  });
  // "Takes up to 1 reference pictures" is the kind of sentence that tells a
  // reader the machine wrote it.
  if (references > 1) found.push({ icon: 'layers', text: tf('modelCard.referenceImages', references) });
  else if (references === 1 || model.supportsImage) found.push({ icon: 'layers', text: t('modelCard.oneReference') });
  if (model.supportsLoras) found.push({ icon: 'sliders', text: t('modelCard.loras') });
  if (model.promptHelper) found.push({ icon: 'sparkles', text: t('modelCard.promptHelper') });
  if (isVideo && Array.isArray(model.durations) && model.durations.length) {
    found.push({ icon: 'clock', text: tf('modelCard.upToSeconds', Math.max(...model.durations)) });
  }
  if (model.supportsMotionContext) found.push({ icon: 'film', text: t('modelCard.motionContext') });
  if (model.supportsHeadReplacement) found.push({ icon: 'persona', text: t('modelCard.headReplacement') });
  return found;
}

// Which sentence names the source, written out four ways rather than composed
// from a computed key: every one of them is then a call site the key-table test
// can see, and a renamed key fails the suite instead of the page.
function attribution(card, source) {
  const name = card?.sourceName || '';
  if (source === 'huggingface') {
    return cardIsGuess(card) ? tf('modelCard.guessedHuggingFace', name) : tf('modelCard.matchedHuggingFace', name);
  }
  return cardIsGuess(card) ? tf('modelCard.guessedCivitai', name) : tf('modelCard.matchedCivitai', name);
}

// The picture and the paragraph can come from different places — Civitai had
// Krea 2's gallery, the repo had its words — and a line that names only one of
// them attributes the other to it. Said only when they actually differ.
function artAttribution(card, source) {
  const art = cardArtKind(card);
  if (!art || art === source) return '';
  return art === 'huggingface' ? t('modelCard.artFromHuggingFace') : t('modelCard.artFromCivitai');
}

// Why a model is greyed out, and what to do about it — never the state on its
// own. Missing weights are a download; a lane that is not answering is a lane.
function unavailableNotice(model) {
  if (model.ready !== false) return null;
  if (model.readyReason === 'missing-weights') {
    return { text: t('modelCard.missingWeights'), files: (model.missingWeights || []).slice(0, 4), store: true };
  }
  if (model.readyReason === 'engine-offline') return { text: t('modelCard.engineOffline'), files: [], store: false };
  return { text: model.detail || t('modelCard.notAvailable'), files: [], store: false };
}

// The two halves are exported on their own because Modal is a createPortal
// call, which react-dom/server refuses — rendering them directly is how the
// tests assert on what a person reads here instead of grepping this file.
export function ModelDetailActions({ model, onClose }) {
  const isVideo = String(model?.type || '').toLowerCase() === 'video';
  const identifier = model?.workflowId || model?.id || '';
  return (
    <>
      <Button size="sm" icon="copy" onClick={() => copy(identifier, t('modelCard.idCopied'))}>{t('modelCard.copyId')}</Button>
      <Button
        size="sm"
        variant="primary"
        icon={isVideo ? 'video' : 'image'}
        disabled={model?.ready === false}
        onClick={() => { openModelInStudio(model); onClose?.(); }}
      >
        {isVideo ? t('runnable.openInVideo') : t('runnable.openInImage')}
      </Button>
    </>
  );
}

export function ModelDetailBody({ model, card, onClose = null, onOpenStore = null }) {
  const blurb = modelBlurb(model, card);
  const source = cardSourceKind(card);
  const notice = unavailableNotice(model);
  const chips = modelCapabilityChips(model);
  const bases = model.compatibleBaseModels || [];
  const identifier = model.workflowId || model.id;

  return (
    <div className="flex flex-col gap-4">
      {/* Art beside the words, not above them: a full-width hero pushed every
          sentence below the fold, and the picture is the smaller half of what
          this panel is for. It stacks under 640px, where a row would not fit. */}
      <div className="flex flex-col gap-4 sm:flex-row">
        <ModelArt
          model={model}
          card={card}
          className="aspect-[4/3] w-full shrink-0 rounded-md sm:aspect-[3/4] sm:w-44"
          letters={false}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone="honey">{modelTypeLabel(model)}</Pill>
            {model.featured ? <Pill tone="neutral">{t('localModels.featured')}</Pill> : null}
            {model.beta ? <Pill tone="info">{t('modelCard.beta')}</Pill> : null}
            {bases.slice(0, 2).map((base) => <Pill key={base} tone="neutral">{base}</Pill>)}
            <Pill tone={model.ready === false ? 'warn' : 'ok'} dot>
              {model.ready === false ? t('providers.offline') : t('common.ready')}
            </Pill>
          </div>

          {notice ? (
            <div className="flex flex-col gap-2 rounded-md border border-warn/30 bg-warn/5 p-3">
              <p className="text-[13px] leading-relaxed text-ink2">{notice.text}</p>
              {notice.files.length ? (
                <ul className="flex flex-col gap-0.5">
                  {notice.files.map((file) => (
                    <li key={file} className="truncate font-mono text-[11px] text-ink3">{file}</li>
                  ))}
                </ul>
              ) : null}
              {notice.store && onOpenStore ? (
                <div>
                  <Button size="sm" icon="download" onClick={() => { onOpenStore(); onClose?.(); }}>
                    {t('runnable.browseModels')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {blurb ? (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>{t('modelCard.about')}</SectionLabel>
              <p className="text-[13px] leading-relaxed text-ink2">{blurb}</p>
              {source ? (
                <p className="text-[11px] text-ink3">
                  {attribution(card, source)} {artAttribution(card, source)}
                </p>
              ) : null}
            </div>
          ) : null}

          {card?.links?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {card.links.map((link) => (
                <Button
                  key={link.url}
                  size="sm"
                  icon="external"
                  onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
                >
                  {linkLabel(link)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

        {/* The registry's own sentence, which describes THIS lane rather than
            the model behind it — a distinction that matters most where the two
            differ, such as an edit lane built on a text-to-image model. Shown
            only when a source supplied the paragraph above it, since otherwise
            this is already the paragraph above it. */}
        {model.description && model.description !== blurb ? (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>{t('modelCard.thisLane')}</SectionLabel>
            <p className="text-[13px] leading-relaxed text-ink2">{model.description}</p>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t('modelCard.abilities')}</SectionLabel>
          <ul className="flex flex-col gap-1">
            {abilities(model).map((ability) => (
              <Ability key={ability.text} icon={ability.icon}>{ability.text}</Ability>
            ))}
          </ul>
        </div>

        {/* Collapsed by default and remembered: the numbers are here for the
            times they matter, not on the way to everything else. */}
        <CollapsibleSection title={t('modelCard.technical')} storageKey="modelDetailTechnical">
          <div>
            <Row label={t('modelCard.identifier')}><span className="font-mono text-xs">{identifier}</span></Row>
            {model.family ? <Row label={t('modelCard.family')}>{model.workflowFamily || model.family}</Row> : null}
            {model.backend ? <Row label={t('modelCard.backend')}><span className="font-mono text-xs">{model.backend}</span></Row> : null}
            {bases.length ? <Row label={t('modelCard.baseModels')} wrap>{bases.join(', ')}</Row> : null}
            {chips.length ? <Row label={t('modelCard.defaults')}>{chips.join(' · ')}</Row> : null}
            {model.defaultGuidance ? <Row label={t('modelCard.guidance')}>{model.defaultGuidance}</Row> : null}
            {Array.isArray(model.samplers) && model.samplers.length
              ? <Row label={t('modelCard.samplers')} wrap>{model.samplers.join(', ')}</Row>
              : null}
            {Array.isArray(model.aspectRatios) && model.aspectRatios.length
              ? <Row label={t('modelCard.aspectRatios')} wrap>{model.aspectRatios.join(', ')}</Row>
              : null}
            {Array.isArray(model.accepts) && model.accepts.length
              ? <Row label={t('modelCard.accepts')} wrap>{model.accepts.join(', ')}</Row>
              : null}
          </div>
      </CollapsibleSection>
    </div>
  );
}

export function ModelDetail({ model, card, onClose, onOpenStore = null }) {
  if (!model) return null;
  return (
    <Modal open onClose={onClose} title={model.name} size="xl" footer={<ModelDetailActions model={model} onClose={onClose} />}>
      <ModelDetailBody model={model} card={card} onClose={onClose} onOpenStore={onOpenStore} />
    </Modal>
  );
}
