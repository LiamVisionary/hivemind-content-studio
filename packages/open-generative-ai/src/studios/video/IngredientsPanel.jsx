// LTX Ingredients reference panel for the Video Studio.
// Presentational: all upload/preview/selection logic lives in VideoStudio.jsx.
// Reference views get stitched into one sheet; uploaded finished sheets are used
// as-is. Exactly one sheet ('stitched' | a sheet url | '') conditions the next
// generation. Media srcs resolve through useMediaSrc (E2E decrypt, fail-open);
// the stitched preview is already an object URL and renders directly.
import { useRef } from 'react';
import { useMediaSrc } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Button, Pill, SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { zh } from './videoLogic.jsx';

function RefImage({ url, alt, className }) {
  const src = useMediaSrc(url);
  return <img src={src} alt={alt} loading="lazy" className={className} />;
}

function SheetCard({ sheetId, label, detail, selected, onSelect, children, corner }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-pressed={selected}
        title={selected
          ? (zh() ? '再次点击可关闭配料参考' : 'Tap again to turn ingredients off')
          : (zh() ? '将此配料表用于下一次生成' : 'Use this ingredients sheet for the next generation')}
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
          {selected ? <Pill tone="honey" className="h-4 px-1.5 text-[9px] uppercase">{zh() ? '启用' : 'On'}</Pill> : null}
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
  const maximum = Number(model?.ingredientInputs?.max_images || 12);
  const selectedSheetEntry = sheets.find((sheet) => sheet.url === selectedSheet) || null;

  const countsLine = [
    `${selection.length} / ${maximum} ${zh() ? '视图' : 'views'}`,
    ...(sheets.length ? [`${sheets.length} ${zh() ? '张已上传配料表' : `uploaded sheet${sheets.length === 1 ? '' : 's'}`}`] : []),
  ].join(' · ');

  const previewMatches = preview.signature === previewSignature;
  const previewStatus = previewMatches ? preview.status : 'loading';

  return (
    <section className="flex flex-col gap-3 border-t border-line1 pt-4" aria-label={zh() ? '配料参考' : 'Ingredient references'}>
      <input
        ref={viewsInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label={zh() ? '添加配料参考图片' : 'Add ingredient reference images'}
        onChange={(e) => { onAddViews(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
      <input
        ref={sheetsInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-label={zh() ? '上传成品配料表' : 'Upload finished ingredients sheets'}
        onChange={(e) => { onAddSheets(Array.from(e.target.files || [])); e.target.value = ''; }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <SectionLabel>{zh() ? '配料参考' : 'Ingredient references'}</SectionLabel>
          <div className="mt-1 text-[11px] text-ink3">{countsLine}</div>
        </div>
        {activeCount ? (
          <Pill tone="ok" dot>{zh() ? '下一次生成启用' : 'Active in next generation'}</Pill>
        ) : (selection.length || sheets.length) ? (
          <Pill tone="neutral" dot>{zh() ? '关闭 — 点击配料表启用' : 'Off — tap a sheet to use it'}</Pill>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="plus"
          disabled={selection.length >= maximum}
          title={zh() ? '添加会被拼接成一张配料表的参考视图' : 'Add reference views that get stitched into one sheet'}
          onClick={() => viewsInputRef.current?.click()}
        >
          {zh() ? '添加视图' : 'Add views'}
        </Button>
        <Button
          size="sm"
          icon="grid"
          disabled={sheets.length >= 12}
          title={zh() ? '上传一张成品配料表，原样使用不再拼接' : 'Upload a finished ingredients sheet, used as-is without stitching'}
          onClick={() => sheetsInputRef.current?.click()}
        >
          {zh() ? '添加配料表' : 'Add sheet'}
        </Button>
        {(selection.length || sheets.length) ? (
          <Button
            size="sm"
            variant="danger"
            title={zh() ? '移除所有配料参考和配料表' : 'Remove all ingredient references and sheets'}
            onClick={onClear}
          >
            {zh() ? '清除' : 'Clear'}
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
            <span className="text-[11px] font-semibold text-ink2">{zh() ? '配料表' : 'Ingredients sheet'}</span>
            <span className="text-[10px] text-ink3">{zh() ? '点击选择 · 再次点击关闭' : 'Tap to select · tap again to turn off'}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {selection.length ? (
              <SheetCard
                sheetId="stitched"
                label={zh() ? '拼接配料表' : 'Stitched sheet'}
                detail={previewStatus === 'ready' && (preview.width && preview.height)
                  ? [`${preview.width} × ${preview.height}`, preview.columns && preview.rows ? `${preview.columns} × ${preview.rows} grid` : `${preview.sourceCount} views`].filter(Boolean).join(' · ')
                  : `${selection.length} ${selection.length === 1 ? (zh() ? '个视图' : 'view') : (zh() ? '个视图' : 'views')}`}
                selected={selectedSheet === 'stitched'}
                onSelect={() => onToggleSheet('stitched')}
                corner={previewStatus === 'ready' && preview.url ? (
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={zh() ? '全尺寸打开拼接配料表' : 'Open stitched sheet full size'}
                    className="grid h-6 w-6 place-items-center rounded-md bg-bg0/70 text-ink2 backdrop-blur transition-colors hover:bg-bg0 hover:text-ink1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Icon name="external" size={12} />
                  </a>
                ) : previewStatus === 'error' ? (
                  <button
                    type="button"
                    title={zh() ? '重试拼接配料表预览' : 'Retry stitched sheet preview'}
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
                  <div className="px-2 text-center text-[10px] text-danger">{preview.error || (zh() ? '预览不可用' : 'Preview unavailable')}</div>
                ) : (
                  <div className="h-full w-full animate-pulse bg-bg2" role="status" aria-label={zh() ? '正在合成拼接配料表' : 'Composing stitched ingredient sheet'} />
                )}
              </SheetCard>
            ) : null}

            {sheets.map((sheet, index) => (
              <SheetCard
                key={sheet.url}
                sheetId={sheet.url}
                label={`${zh() ? '已上传配料表' : 'Uploaded sheet'} ${index + 1}`}
                detail={zh() ? '原样使用，不拼接' : 'Used as-is, no stitching'}
                selected={selectedSheet === sheet.url}
                onSelect={() => onToggleSheet(sheet.url)}
                corner={(
                  <button
                    type="button"
                    title={`${zh() ? '移除已上传配料表' : 'Remove uploaded ingredients sheet'} ${index + 1}`}
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
            <input
              type="text"
              maxLength={1000}
              value={selectedSheetEntry.description || ''}
              placeholder={zh() ? '描述这张配料表的每个画面（可选）' : 'Describe every panel in this sheet (optional)'}
              aria-label={zh() ? '所选配料表的描述' : 'Description for the selected ingredients sheet'}
              onChange={(e) => onSheetDescription(selectedSheetEntry.url, e.target.value)}
              className="w-full rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-[11px] text-ink1 outline-none transition-colors placeholder:text-ink3 focus:border-honey/60"
            />
          ) : null}
        </div>
      ) : null}

      {selection.length ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-ink2">{zh() ? '参考视图' : 'Reference views'}</span>
            <span className="text-[10px] text-ink3">{zh() ? '拼接进上方的配料表' : 'Stitched into the sheet above'}</span>
          </div>
          <div className="flex flex-col gap-2">
            {selection.map((item, index) => (
              <div key={item.url} className="grid grid-cols-[48px_minmax(0,1fr)_28px] items-center gap-2 rounded-md border border-line1 bg-bg2 p-1.5">
                <RefImage url={item.url} alt={`Ingredient reference ${index + 1}`} className="h-12 w-12 rounded-sm bg-bg0 object-contain" />
                <input
                  type="text"
                  maxLength={1000}
                  value={item.description || ''}
                  placeholder={`${zh() ? '视图' : 'View'} ${index + 1}: ${zh() ? '正面、侧面、全身…' : 'front, profile, full body…'}`}
                  aria-label={`Description for ingredient reference ${index + 1}`}
                  onChange={(e) => onViewDescription(index, e.target.value)}
                  className="min-w-0 rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-[11px] text-ink1 outline-none transition-colors placeholder:text-ink3 focus:border-honey/60"
                />
                <button
                  type="button"
                  title={`${zh() ? '移除配料参考' : 'Remove ingredient reference'} ${index + 1}`}
                  aria-label={`Remove ingredient reference ${index + 1}`}
                  className="grid h-7 w-7 place-items-center rounded-sm bg-danger-tint text-danger transition-colors hover:border hover:border-danger/40"
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
          <Spinner size={12} /> <span>{zh() ? '正在合成拼接配料表…' : 'Composing stitched sheet…'}</span>
        </div>
      ) : null}
    </section>
  );
}
