// LTX Ingredients reference panel for the Video Studio.
// Presentational: all upload/preview/selection logic lives in VideoStudio.jsx.
// Reference views get stitched into one sheet; uploaded finished sheets are used
// as-is. Exactly one sheet ('stitched' | a sheet url | '') conditions the next
// generation. Media srcs resolve through useMediaSrc (E2E decrypt, fail-open);
// the stitched preview is already an object URL and renders directly.
import { useRef, useState } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, Pill, SectionLabel, Spinner, TextInput, cx } from '../../ui/kit.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
function RefImage({ url, alt, className }) {
  const src = useMediaSrc(url);
  // Not lazy — these sit in the video settings panel, which often does not scroll,
  // and Chrome never revisits a deferral without a scroll or resize. See
  // GalleryAndViewer for the measurement.
  return <img src={src} alt={alt} className={className} />;
}

function SheetCard({ sheetId, label, detail, selected, onSelect, children, corner }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-pressed={selected}
        title={selected
          ? 'Tap again to turn ingredients off'
          : 'Use this ingredients sheet for the next generation'}
        onClick={onSelect}
        className={cx(
          'block w-full overflow-hidden rounded-md border bg-bg0 text-left transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-honey/40',
          selected ? 'border-honey' : 'border-line1 hover:border-line2',
        )}
      >
        <div className="grid h-24 place-items-center overflow-hidden bg-bg0">{children}</div>
        <div className="flex items-center justify-between gap-1 border-t border-line1 bg-bg2 px-2 py-1.5">
          <span className="min-w-0">
            <span className={cx('block truncate text-[11px] font-semibold', selected ? 'text-honey' : 'text-ink1')}>{label}</span>
            {detail ? <span className="block truncate text-[10px] text-ink3">{detail}</span> : null}
          </span>
          {selected ? <Pill tone="honey" className="h-4 px-1.5 text-[9px] uppercase">On</Pill> : null}
        </div>
      </button>
      {corner ? <div className="absolute right-1 top-1 z-10">{corner}</div> : null}
    </div>
  );
}

export function IngredientsPanel({
  model,
  selection,
  sheets,
  selectedSheet,
  preview,
  previewSignature,
  uploadMessage,
  activeCount,
  onAddViews,
  onAddSheets,
  onClear,
  onToggleSheet,
  onRemoveSheet,
  onRemoveView,
  onViewDescription,
  onSheetDescription,
  onRetryPreview,
}) {
  const viewsInputRef = useRef(null);
  const sheetsInputRef = useRef(null);
  // "Clear" deletes every uploaded view and sheet — irreversible, so it asks.
  const [confirmClear, setConfirmClear] = useState(false);
  const maximum = Number(model?.ingredientInputs?.max_images || 12);
  const selectedSheetEntry = sheets.find((sheet) => sheet.url === selectedSheet) || null;

  const countsLine = [
    `${selection.length} / ${maximum} ${'views'}`,
    ...(sheets.length ? [`${sheets.length} ${`uploaded sheet${sheets.length === 1 ? '' : 's'}`}`] : []),
  ].join(' · ');

  const previewMatches = preview.signature === previewSignature;
  const previewStatus = previewMatches ? preview.status : 'loading';

  return (
    <section className="flex flex-col gap-3" aria-label="Ingredient references">
      <input
        ref={viewsInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label="Add ingredient reference images"
        onChange={(e) => { onAddViews(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
      <input
        ref={sheetsInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label="Upload finished ingredients sheets"
        onChange={(e) => { onAddSheets(Array.from(e.target.files || [])); e.target.value = ''; }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <SectionLabel>Ingredient references</SectionLabel>
          <div className="mt-1 text-[11px] text-ink3">{countsLine}</div>
        </div>
        {activeCount ? (
          <Pill tone="ok" dot>Active in next generation</Pill>
        ) : (selection.length || sheets.length) ? (
          <Pill tone="neutral" dot>Off — tap a sheet to use it</Pill>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="plus"
          disabled={selection.length >= maximum}
          title="Add reference views that get stitched into one sheet"
          onClick={() => viewsInputRef.current?.click()}
        >
          Add views
        </Button>
        <Button
          size="sm"
          icon="grid"
          disabled={sheets.length >= 12}
          title="Upload a finished ingredients sheet, used as-is without stitching"
          onClick={() => sheetsInputRef.current?.click()}
        >
          Add sheet
        </Button>
        {(selection.length || sheets.length) ? (
          <Button
            size="sm"
            variant="danger"
            title="Remove all ingredient references and sheets"
            onClick={() => setConfirmClear(true)}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {uploadMessage ? (
        <div role="status" className="rounded-md border border-line1 bg-bg2 px-3 py-2 text-[11px] text-ink3">
          {uploadMessage}
        </div>
      ) : null}

      {(selection.length || sheets.length) ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-ink2">Ingredients sheet</span>
            <span className="text-[10px] text-ink3">Tap to select · tap again to turn off</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {selection.length ? (
              <SheetCard
                sheetId="stitched"
                label="Stitched sheet"
                detail={previewStatus === 'ready' && (preview.width && preview.height)
                  ? [`${preview.width} × ${preview.height}`, preview.columns && preview.rows ? `${preview.columns} × ${preview.rows} grid` : `${preview.sourceCount} views`].filter(Boolean).join(' · ')
                  : `${selection.length} ${selection.length === 1 ? 'view' : 'views'}`}
                selected={selectedSheet === 'stitched'}
                onSelect={() => onToggleSheet('stitched')}
                corner={previewStatus === 'ready' && preview.url ? (
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open stitched sheet full size"
                    className="grid h-6 w-6 place-items-center rounded-md bg-bg0/70 text-ink2 backdrop-blur transition-colors hover:bg-bg0 hover:text-ink1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external" size={12} />
                  </a>
                ) : previewStatus === 'error' ? (
                  <button
                    type="button"
                    title="Retry stitched sheet preview"
                    className="grid h-6 w-6 place-items-center rounded-md bg-bg0/70 text-ink2 backdrop-blur transition-colors hover:bg-bg0 hover:text-ink1"
                    onClick={(e) => { e.stopPropagation(); onRetryPreview(); }}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                ) : null}
              >
                {previewStatus === 'ready' && preview.url ? (
                  <img src={preview.url} alt={`Stitched ingredient sheet containing ${preview.sourceCount} reference views`} className="h-24 w-full bg-bg0 object-contain" />
                ) : previewStatus === 'error' ? (
                  <div className="px-2 text-center text-[10px] text-danger">{preview.error || 'Preview unavailable'}</div>
                ) : (
                  <div className="h-full w-full animate-pulse bg-bg2" role="status" aria-label="Composing stitched ingredient sheet" />
                )}
              </SheetCard>
            ) : null}

            {sheets.map((sheet, index) => (
              <SheetCard
                key={sheet.url}
                sheetId={sheet.url}
                label={`${'Uploaded sheet'} ${index + 1}`}
                detail="Used as-is, no stitching"
                selected={selectedSheet === sheet.url}
                onSelect={() => onToggleSheet(sheet.url)}
                corner={(
                  <button
                    type="button"
                    title={`${'Remove uploaded ingredients sheet'} ${index + 1}`}
                    className="grid h-6 w-6 place-items-center rounded-md bg-bg0/70 text-danger backdrop-blur transition-colors hover:bg-bg0"
                    onClick={(e) => { e.stopPropagation(); onRemoveSheet(sheet.url); }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              >
                <RefImage url={sheet.url} alt={`Uploaded ingredients sheet ${index + 1}`} className="h-24 w-full bg-bg0 object-contain" />
              </SheetCard>
            ))}
          </div>

          {selectedSheetEntry ? (
            <TextInput
              type="text"
              maxLength={1000}
              value={selectedSheetEntry.description || ''}
              placeholder="Describe every panel in this sheet (optional)"
              aria-label="Description for the selected ingredients sheet"
              onChange={(e) => onSheetDescription(selectedSheetEntry.url, e.target.value)}
              className="text-[11px]"
            />
          ) : null}
        </div>
      ) : null}

      {selection.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-ink2">Reference views</span>
            <span className="text-[10px] text-ink3">Stitched into the sheet above</span>
          </div>
          <div className="flex flex-col gap-2">
            {selection.map((item, index) => (
              <div key={item.url} className="grid grid-cols-[48px_minmax(0,1fr)_28px] items-center gap-2 rounded-md border border-line1 bg-bg2 p-1.5">
                <RefImage url={item.url} alt={`Ingredient reference ${index + 1}`} className="h-12 w-12 rounded-sm bg-bg0 object-contain" />
                <TextInput
                  type="text"
                  maxLength={1000}
                  value={item.description || ''}
                  placeholder={`${'View'} ${index + 1}: ${'front, profile, full body…'}`}
                  aria-label={`Description for ingredient reference ${index + 1}`}
                  onChange={(e) => onViewDescription(index, e.target.value)}
                  className="min-w-0 text-[11px]"
                />
                <button
                  type="button"
                  title={`${'Remove ingredient reference'} ${index + 1}`}
                  aria-label={`Remove ingredient reference ${index + 1}`}
                  className="grid h-7 w-7 place-items-center rounded-sm border border-transparent bg-danger-tint text-danger transition-colors hover:border-danger/40"
                  onClick={() => onRemoveView(index)}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {preview.status === 'loading' && selection.length ? (
        <div className="flex items-center gap-2 text-[11px] text-ink3">
          <Spinner size={12} /> <span>Composing stitched sheet…</span>
        </div>
      ) : null}

      <ConfirmModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => { setConfirmClear(false); onClear(); }}
        title="Clear ingredient references?"
        body={`This deletes the uploads behind ${selection.length} view${selection.length === 1 ? '' : 's'} and ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}. It cannot be undone.`}
        confirmLabel="Clear"
      />
    </section>
  );
}
