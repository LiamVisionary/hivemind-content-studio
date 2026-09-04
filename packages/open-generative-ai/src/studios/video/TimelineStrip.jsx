// The Scene strip: ONE sequence surface for the Video studio. Segment cards the
// user fills by generating, dragging clips in, or reordering — plus the "+"
// card that opens the next slot.
//
// It used to have a derived twin (ChainTimeline.jsx) that drew a chained
// episode from its lineage and was shown INSTEAD of this one, so the same
// episode appeared as two different strips depending on which was opened first.
// That component is retired: this strip is seeded from the chain lineage on
// open and on restore, and carries what the derived one had — per-shot export,
// and a non-destructive drop-from-the-cut with a put-back.
//
// Drag rules, all resolved by timelineDropPlan in the lib:
//   - a CARD dragged between its siblings moves (the gap indicator shows where)
//   - a CLIP (history tile, gallery, OS file) dropped on an empty card fills it
//   - ...on a filled card replaces it, behind a confirm the parent owns
//   - ...between cards inserts a new segment there
//   - ...on the "+" card appends
// The strip marks itself data-upload-picker so the window-level restore zone
// (OutputRestoreDropZone) leaves its drops alone.
import { useRef, useState } from 'react';

import { HIVEMIND_OUTPUT_DRAG_TYPE } from '../../lib/referenceDrop.js';
import { Icon } from '../../ui/icons.jsx';
import { IconButton, Segmented, Spinner, Toggle, cx } from '../../ui/kit.jsx';
import { useMediaPoster } from '../../hooks/hooks.js';

// One drag vocabulary for the whole strip. Same-constant discipline as the
// output payload: the writer and the reader can never drift apart.
export const TIMELINE_SEGMENT_DRAG_TYPE = 'application/x-hivemind-timeline-segment';

// One decoded frame as an <img>, not a <video> per tile — the same poster
// pipeline the chain strip and reference rows use.
function SegmentThumb({ url }) {
  const { poster, resolved, pending } = useMediaPoster(url, { kind: 'video' });
  if (poster) return <img src={poster} alt="" className="pointer-events-none aspect-video w-full bg-bg0 object-cover" />;
  if (!resolved || pending) return <div className="aspect-video w-full animate-pulse bg-bg2" />;
  return (
    <div className="grid aspect-video w-full place-items-center bg-bg0 text-ink3">
      <Icon name="film" size={16} />
    </div>
  );
}

// Which drop region the pointer is in. The outer quarters of a card are the
// gaps beside it; the middle half is the card itself.
function dropRegionFor(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
  if (x < 0.25) return 'before';
  if (x > 0.75) return 'after';
  return 'on';
}

const dragIsSegment = (dataTransfer) => Array.from(dataTransfer?.types || [])
  .includes(TIMELINE_SEGMENT_DRAG_TYPE);
const dragIsDroppable = (dataTransfer) => {
  const types = Array.from(dataTransfer?.types || []);
  return types.includes(TIMELINE_SEGMENT_DRAG_TYPE)
    || types.includes(HIVEMIND_OUTPUT_DRAG_TYPE)
    || types.includes('Files');
};

// The honey bar that opens in a gap while a drop would insert there.
function InsertBar({ active }) {
  return (
    <div
      aria-hidden
      className={cx(
        'self-stretch shrink-0 rounded-full bg-honey transition-all duration-150 ease-swift',
        active ? 'mx-0.5 w-[3px] opacity-100' : 'w-0 opacity-0',
      )}
    />
  );
}

export function TimelineStrip({
  zh, segments, selectedId, pendingSegmentId = '',
  extendAvailable = false, extendMode = '', extendOn = false, onToggleExtend,
  canCombine = false, showCombined = false, combined = null, building = false, buildError = '',
  onToggleCombined, onExportCombined,
  onSelect, onAdd, onRemove, onClose, onDrop, promptFor,
  // Carried over from the derived chain strip: export one shot, and drop a shot
  // from the cut without losing it.
  onExportSegment, onToggleExcluded,
}) {
  // Transient drag paint state: which target the pointer is over, and which
  // card is being dragged (dimmed). Local — nothing outside the strip cares.
  const [over, setOver] = useState(null); // { id, region } | { region: 'end' }
  const [draggingId, setDraggingId] = useState('');
  // Suppress the click that follows a completed drag (CastStrip idiom).
  const dragHappenedRef = useRef(false);

  const overMatches = (id, region) => over && over.id === id && over.region === region;

  const cardDragProps = (seg) => ({
    draggable: true,
    onDragStart: (event) => {
      dragHappenedRef.current = true;
      setDraggingId(seg.id);
      try {
        event.dataTransfer.setData(TIMELINE_SEGMENT_DRAG_TYPE, JSON.stringify({ id: seg.id }));
        // A filled card is also one of our outputs, so it can leave the strip
        // and land in the composer or the references like any history tile.
        if (seg.url) {
          event.dataTransfer.setData(HIVEMIND_OUTPUT_DRAG_TYPE, JSON.stringify({ url: seg.url, section: 'video', mediaType: 'video/*' }));
          event.dataTransfer.setData('text/uri-list', seg.url);
        }
        event.dataTransfer.effectAllowed = 'copyMove';
      } catch { /* non-critical */ }
    },
    onDragEnd: () => {
      setDraggingId('');
      setOver(null);
      // The click event fires after dragend; clear the flag a beat later.
      setTimeout(() => { dragHappenedRef.current = false; }, 0);
    },
  });

  const dropProps = (target) => ({
    onDragOver: (event) => {
      if (!dragIsDroppable(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const region = target.region === 'end' ? 'end' : dropRegionFor(event);
      // A segment drag has no "on" meaning — snap it to the nearest gap.
      const snapped = region === 'on' && dragIsSegment(event.dataTransfer) ? 'after' : region;
      if (!overMatches(target.id, snapped) || over?.region !== snapped) setOver({ id: target.id, region: snapped });
      event.dataTransfer.dropEffect = dragIsSegment(event.dataTransfer) ? 'move' : 'copy';
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      setOver((current) => (current && current.id === target.id ? null : current));
    },
    onDrop: (event) => {
      if (!dragIsDroppable(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const region = target.region === 'end' ? 'end' : dropRegionFor(event);
      const snapped = region === 'on' && dragIsSegment(event.dataTransfer) ? 'after' : region;
      setOver(null);
      onDrop({ id: target.id || '', region: snapped }, event.dataTransfer);
    },
  });

  const combinedSeconds = Number(combined?.seconds) || 0;
  const filled = (segments || []).filter((seg) => seg.url).length;

  return (
    <div className="flex flex-col gap-2" data-upload-picker="">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="layers" size={13} className="text-honey" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink2">
            {zh ? '场景' : 'Scene'}
          </span>
          <span className="font-mono text-[11px] text-ink3">
            {zh ? `${filled} 段` : `${filled} clip${filled === 1 ? '' : 's'}`}
            {combinedSeconds > 0 && !buildError ? ` · ${Math.round(combinedSeconds)}s` : ''}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {extendAvailable ? (
            <label
              className="flex cursor-pointer items-center gap-1.5"
              title={extendMode === 'chain'
                ? (zh
                  ? '开启后，每个新片段都从上一段的结尾接续生成（画面与环境音无缝衔接）'
                  : 'Each new segment continues exactly where the previous clip ended — motion and room tone carry across the cut (MiniMax scene chaining)')
                : (zh
                  ? '开启后，每个新片段以上一段的最后一帧作为起始帧'
                  : "Each new segment opens on the previous clip's last frame, grabbed on this device as its start frame")}
            >
              <Toggle checked={extendOn} onChange={onToggleExtend} label={zh ? '自动接续' : 'Auto-continue'} />
              <span className="text-[11px] text-ink2">{zh ? '自动接续' : 'Auto-continue'}</span>
            </label>
          ) : null}

          <div className="flex items-center gap-1" title={buildError
            ? (zh ? `无法无损拼接：${buildError}` : `Cannot combine losslessly: ${buildError}`)
            : (canCombine
              ? (zh ? '在主画布预览单段或完整合成片' : 'Preview one shot, or the whole cut, in the player above')
              : (zh ? '至少需要两段片段才能合成' : 'Add a second clip to build the full cut'))}
          >
            <Segmented
              size="sm"
              value={showCombined ? 'combined' : 'shot'}
              onChange={(value) => onToggleCombined(value === 'combined')}
              options={[
                { value: 'shot', label: zh ? '单段' : 'Shot' },
                {
                  value: 'combined',
                  label: (
                    <span className="flex items-center gap-1">
                      {building ? <Spinner size={10} className="text-honey" /> : null}
                      {buildError ? <Icon name="warning" size={10} className="text-warn" /> : null}
                      {zh ? '完整片' : 'Full cut'}
                    </span>
                  ),
                },
              ]}
            />
            {combined?.url && !buildError ? (
              <IconButton
                icon="download"
                size="sm"
                label={zh ? '导出完整合成片' : 'Export the full cut'}
                onClick={onExportCombined}
              />
            ) : null}
          </div>

          <IconButton
            icon="x"
            size="sm"
            label={zh ? '关闭场景（片段会保留）' : 'Close the scene (your clips are kept)'}
            onClick={onClose}
          />
        </div>
      </div>

      {buildError ? (
        <p className="text-[11px] text-warn">
          {zh
            ? `完整片暂不可用：${buildError} 同一模型、同一分辨率的片段可以无损合成。`
            : `Full cut unavailable: ${buildError} Clips from the same model at the same resolution combine losslessly.`}
        </p>
      ) : null}

      <div className="flex items-stretch gap-1 overflow-x-auto pb-1 pt-0.5">
        {(segments || []).map((seg, index) => {
          const selected = selectedId === seg.id && !showCombined;
          const pending = pendingSegmentId && pendingSegmentId === seg.id;
          const replaceHover = overMatches(seg.id, 'on') && seg.url;
          const fillHover = overMatches(seg.id, 'on') && !seg.url;
          return (
            // eslint-disable-next-line react/no-array-index-key
            <div key={seg.id} className="flex items-stretch">
              <InsertBar active={overMatches(seg.id, 'before')} />
              <div
                role="button"
                tabIndex={0}
                aria-label={zh ? `第 ${index + 1} 段` : `Segment ${index + 1}`}
                aria-current={selected ? 'true' : undefined}
                title={seg.url
                  ? (promptFor?.(seg) || (zh ? `第 ${index + 1} 段` : `Segment ${index + 1}`))
                  : (zh ? '空片段——生成的视频会落在这里' : 'Empty segment — the next generated clip lands here')}
                onClick={() => { if (!dragHappenedRef.current) onSelect(seg); }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onSelect(seg);
                }}
                {...cardDragProps(seg)}
                {...dropProps({ id: seg.id, region: 'card' })}
                className={cx(
                  'hive-scale-in group relative w-[132px] shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-bg2 transition-all duration-150 ease-swift',
                  seg.url ? '' : 'border-dashed',
                  selected ? 'border-honey' : 'border-line1 hover:border-line2',
                  (draggingId === seg.id || seg.excluded) && 'opacity-40',
                  replaceHover && 'border-honey ring-2 ring-honey/40',
                  fillHover && 'border-honey bg-honey-tint/30',
                )}
              >
                {seg.url ? (
                  <SegmentThumb url={seg.url} />
                ) : (
                  <div className="grid aspect-video w-full place-items-center bg-bg1/60">
                    <div className="px-2 py-1 text-center">
                      {pending
                        ? <Spinner size={14} className="mx-auto text-honey" />
                        : <Icon name="clapper" size={14} className="mx-auto text-ink3" />}
                      <div className="mt-1 text-[10px] font-semibold text-ink2">
                        {zh ? `第 ${index + 1} 段` : `Shot ${index + 1}`}
                      </div>
                      <div className="text-[10px] text-ink3">
                        {pending ? (zh ? '生成中…' : 'rendering…') : (zh ? '待生成' : 'to generate')}
                      </div>
                    </div>
                  </div>
                )}
                {seg.url ? (
                  <div className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-bg0/80 px-1.5 py-0.5 font-mono text-[10px] text-ink1">
                    {index + 1}
                  </div>
                ) : null}
                {replaceHover ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-bg0/85 px-1.5 py-0.5 text-center text-[10px] font-semibold text-honey">
                    {zh ? '替换这一段' : 'Replace this clip'}
                  </div>
                ) : null}
                {seg.excluded ? (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-bg0/80 px-1.5 py-0.5 text-center text-[10px] text-ink2">
                    {zh ? '已移出合成片' : 'Dropped from the cut'}
                  </div>
                ) : null}
                {/* Visible on keyboard focus too, not only under a pointer. */}
                <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
                  {seg.url && onExportSegment ? (
                    <IconButton
                      icon="download"
                      size="xs"
                      label={zh ? '导出这一段' : 'Export this shot'}
                      className="border border-line1 bg-bg0/85 hover:border-line2"
                      onClick={(event) => { event.stopPropagation(); onExportSegment(seg); }}
                    />
                  ) : null}
                  {seg.url && onToggleExcluded ? (
                    <IconButton
                      icon={seg.excluded ? 'plus' : 'minus'}
                      size="xs"
                      label={seg.excluded
                        ? (zh ? '放回合成片' : 'Put back in the cut')
                        : (zh ? '从合成片中移除（不删除该视频）' : 'Drop from the cut — the clip is kept')}
                      className="border border-line1 bg-bg0/85 hover:border-line2"
                      onClick={(event) => { event.stopPropagation(); onToggleExcluded(seg); }}
                    />
                  ) : null}
                  <IconButton
                    icon="x"
                    size="xs"
                    label={zh ? '移除这一段' : 'Remove this segment'}
                    className="border border-line1 bg-bg0/85 hover:border-danger/40"
                    onClick={(event) => { event.stopPropagation(); onRemove(seg); }}
                  />
                </div>
              </div>
              <InsertBar active={overMatches(seg.id, 'after')} />
            </div>
          );
        })}

        {/* The "+" card: click to open the next slot, or drop a clip to append. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={zh ? '添加片段' : 'Add a segment'}
          title={zh ? '添加下一段（也可以把片段拖到这里）' : 'Add the next segment — or drop a clip here'}
          onClick={() => { if (!dragHappenedRef.current) onAdd(); }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onAdd();
          }}
          {...dropProps({ id: '', region: 'end' })}
          className={cx(
            'grid w-[132px] shrink-0 cursor-pointer place-items-center rounded-lg border border-dashed transition-all duration-150 ease-swift',
            over?.region === 'end'
              ? 'border-honey bg-honey-tint/40'
              : 'border-line2 bg-bg1/40 hover:border-honey/60 hover:bg-honey-tint/20',
          )}
        >
          <div className="px-2 py-4 text-center">
            <Icon name="plus" size={16} className="mx-auto text-honey" />
            <div className="mt-1 text-[10px] font-semibold text-ink2">{zh ? '添加片段' : 'Add segment'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
