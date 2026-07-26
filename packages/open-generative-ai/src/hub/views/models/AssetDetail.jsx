// One installed model file, in full. Everything the library grid has to leave out:
// the description, every trigger word (copyable — they only matter in a prompt), the
// folder it lives in, and the Civitai version it came from.
import { toast } from 'react-hot-toast';
import { Button, Pill, SectionLabel } from '../../../ui/kit.jsx';
import { Modal } from '../../../ui/Modal.jsx';
import { civitaiAssetUrl, formatBytes, formatDate } from '../../../lib/modelLibrary.js';
import { AssetPreview } from './AssetPreview.jsx';

const KIND_LABELS = { lora: 'LoRA', checkpoint: 'Checkpoint', embedding: 'Embedding', other: 'Support file' };

async function copy(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
  } catch {
    toast.error('Could not copy to the clipboard.');
  }
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line1 py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-ink3">{label}</span>
      <span className="min-w-0 truncate text-right text-[13px] text-ink1">{children}</span>
    </div>
  );
}

export function AssetDetail({ asset, onClose }) {
  if (!asset) return null;
  const civitai = civitaiAssetUrl(asset);
  return (
    <Modal
      open
      onClose={onClose}
      title={asset.displayName || asset.name}
      size="lg"
      footer={
        <>
          <Button size="sm" icon="copy" onClick={() => copy(asset.name, 'Filename copied.')}>Copy filename</Button>
          {civitai ? (
            <Button size="sm" icon="external" onClick={() => window.open(civitai, '_blank', 'noopener,noreferrer')}>
              View on Civitai
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Motion plays here without asking: this is the one place the asset is
            being looked at deliberately. */}
        <AssetPreview asset={asset} playMotion className="aspect-video w-full rounded-md" />

        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="honey">{KIND_LABELS[asset.kind] || asset.kind}</Pill>
          <Pill>{asset.baseModel}</Pill>
          {asset.versionName ? <Pill>{asset.versionName}</Pill> : null}
          {asset.creator ? <Pill>by {asset.creator}</Pill> : null}
        </div>

        {asset.triggerWords?.length ? (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Trigger words</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {asset.triggerWords.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => copy(word, `Copied “${word}”.`)}
                  title="Copy to the clipboard"
                  className="rounded-sm border border-line1 bg-bg2 px-2 py-1 font-mono text-[11px] text-ink1 transition-colors hover:border-honey/50 hover:text-honey"
                >
                  {word}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {asset.description ? (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Description</SectionLabel>
            <p className="text-[13px] leading-relaxed text-ink2">{asset.description}</p>
          </div>
        ) : null}

        {asset.notes ? (
          <div className="flex flex-col gap-1.5">
            <SectionLabel>Notes</SectionLabel>
            <p className="text-[13px] leading-relaxed text-ink2">{asset.notes}</p>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <SectionLabel>File</SectionLabel>
          <div>
            <Row label="Name"><span className="font-mono text-xs">{asset.name}</span></Row>
            <Row label="Folder"><span className="font-mono text-xs">models/{asset.folder}</span></Row>
            <Row label="Size">{formatBytes(asset.sizeBytes)}</Row>
            {asset.category ? <Row label="Used by">{asset.category}</Row> : null}
            {asset.dateAdded ? <Row label="Added">{formatDate(asset.dateAdded)}</Row> : null}
          </div>
        </div>

        {asset.tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {asset.tags.map((tag) => (
              <span key={tag} className="rounded-sm bg-bg2 px-1.5 py-0.5 text-[10px] text-ink3">{tag}</span>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
