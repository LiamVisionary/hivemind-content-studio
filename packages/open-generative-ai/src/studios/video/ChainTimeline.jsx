// The episode strip for a chained scene: every shot in order, then the joined
// cut as the last item.
//
// Chaining makes one clip per shot, so the finished episode only ever existed
// as a file the "Join" button downloaded — you could not see it, scrub it, or
// tell which shots were in it. This is that surface: click any shot to put it
// in the big preview, drop a shot you don't want, export one shot or the whole
// cut. The joined tile carries a honey border because it is the deliverable
// and the shots are its parts; the border only moves while the cut is being
// built.
import { Icon } from '../../ui/icons.jsx';
import { IconButton, Spinner, cx } from '../../ui/kit.jsx';
import { useMediaPoster } from '../../hooks/hooks.js';

// One decoded frame as an <img>, not a <video> per tile — the same poster
// pipeline the reference rows use. The clip is decrypted once (cached) and
// reused when it is picked onto the canvas.
function ShotThumb({ url }) {
  const { poster, resolved, pending } = useMediaPoster(url, { kind: 'video' });
  if (poster) return <img src={poster} alt="" className="aspect-video w-full bg-bg0 object-cover" />;
  if (!resolved || pending) return <div className="aspect-video w-full animate-pulse bg-bg2" />;
  return (
    <div className="grid aspect-video w-full place-items-center bg-bg0 text-ink3">
      <Icon name="film" size={16} />
    </div>
  );
}

export function ChainTimeline({
  model, activeUrl, zh,
  onSelect, onToggleExcluded, onExport, onBuild, onExportCombined, building,
}) {
  if (!model) return null;
  const { shots, combined, stale, canBuild, pending } = model;
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon name="layers" size={13} className="text-honey" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink2">
            {zh ? '场景时间线' : 'Scene timeline'}
          </span>
          <span className="font-mono text-[11px] text-ink3">
            {zh ? `${shots.length} 段` : `${shots.length} shot${shots.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {stale ? (
          <span className="text-[11px] text-ink3">
            {zh ? '镜头有变，请重新合成' : 'Shots changed — rebuild the cut'}
          </span>
        ) : null}
      </div>

      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {shots.map((shot) => {
          const active = activeUrl === shot.url;
          return (
            <div
              key={shot.id}
              role="button"
              tabIndex={0}
              title={shot.promptPrivate
                ? (zh ? '私密提示词（已隐去）' : 'Private prompt (hidden)')
                : (shot.prompt || (zh ? `第 ${shot.shot} 段` : `Shot ${shot.shot}`))}
              onClick={() => onSelect(shot.url, shot.model)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(shot.url, shot.model);
              }}
              className={cx(
                'group relative w-[132px] shrink-0 cursor-pointer overflow-hidden rounded-lg border bg-bg2 transition-colors duration-150',
                active ? 'border-honey' : 'border-line1 hover:border-line2',
                shot.excluded && 'opacity-40',
              )}
            >
              <ShotThumb url={shot.url} />
              <div className="absolute left-1.5 top-1.5 rounded bg-bg0/80 px-1.5 py-0.5 font-mono text-[10px] text-ink1">
                {shot.shot}
              </div>
              {shot.excluded ? (
                <div className="absolute inset-x-0 bottom-0 bg-bg0/80 px-1.5 py-0.5 text-center text-[10px] text-ink2">
                  {zh ? '已移除' : 'Dropped'}
                </div>
              ) : null}
              {/* Visible on keyboard focus too, not only under a pointer. */}
              <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                <IconButton
                  icon="download"
                  size="xs"
                  label={zh ? '导出这一段' : 'Export this shot'}
                  className="border border-line1 bg-bg0/85 hover:border-line2"
                  onClick={(event) => { event.stopPropagation(); onExport(shot); }}
                />
                <IconButton
                  icon={shot.excluded ? 'plus' : 'x'}
                  size="xs"
                  label={shot.excluded
                    ? (zh ? '放回合成片' : 'Put back in the cut')
                    : (zh ? '从合成片中移除（不删除该视频）' : 'Drop from the cut (the clip is kept)')}
                  className="border border-line1 bg-bg0/85 hover:border-line2"
                  onClick={(event) => { event.stopPropagation(); onToggleExcluded(shot.url); }}
                />
              </div>
            </div>
          );
        })}

        {/* The shot being written. Without it, pressing "Continue scene" —
            the action that starts an episode — showed nothing at all until a
            second clip existed. */}
        {pending ? (
          <div
            className="grid w-[132px] shrink-0 place-items-center rounded-lg border border-dashed border-honey/50 bg-honey-tint/30"
            title={zh ? '正在写下一段——生成后会出现在这里' : 'The next shot: write it below, and it lands here'}
          >
            <div className="px-2 py-4 text-center">
              <Icon name="arrowRight" size={14} className="mx-auto text-honey" />
              <div className="mt-1 text-[10px] font-semibold text-honey">
                {zh ? `第 ${shots.length + 1} 段` : `Shot ${shots.length + 1}`}
              </div>
              <div className="text-[10px] text-ink3">{zh ? '待生成' : 'to generate'}</div>
            </div>
          </div>
        ) : null}

        {/* The deliverable. Present from the start so the episode always ends
            somewhere, whether or not it has been built yet. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={zh ? '完整合成片' : 'Full combined clip'}
          title={combined
            ? (zh ? '完整合成片' : 'The full combined clip')
            : (zh ? '把所有镜头合成为一个视频' : 'Join every shot into one video')}
          onClick={() => (combined ? onSelect(combined.url, zh ? '合成片' : 'Joined episode') : onBuild())}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (combined) onSelect(combined.url, zh ? '合成片' : 'Joined episode'); else onBuild();
          }}
          className={cx(
            'chain-combined-tile group relative w-[132px] shrink-0 cursor-pointer overflow-hidden rounded-lg bg-bg2 p-[2px]',
            building && 'chain-combined-tile--building',
            !canBuild && 'pointer-events-none opacity-40',
            activeUrl && combined && activeUrl === combined.url && 'chain-combined-tile--active',
          )}
        >
          <div className="relative h-full overflow-hidden rounded-[6px] bg-bg1">
            {combined ? (
              <ShotThumb url={combined.url} />
            ) : (
              <div className="grid aspect-video w-full place-items-center bg-bg1">
                {building ? <Spinner size={16} className="text-honey" /> : <Icon name="layers" size={18} className="text-ink3" />}
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-bg0/80 px-1.5 py-1 text-center">
              <div className="truncate text-[10px] font-semibold text-ink1">
                {combined
                  ? (zh ? `完整片 · ${Math.round(combined.seconds)}秒` : `Full cut · ${Math.round(combined.seconds)}s`)
                  : building
                    ? (zh ? '合成中…' : 'Building…')
                    : (zh ? '合成完整片' : 'Build full cut')}
              </div>
            </div>
          </div>
          {combined ? (
            <IconButton
              icon="download"
              size="xs"
              label={zh ? '导出完整合成片' : 'Export the full cut'}
              className="absolute right-1.5 top-1.5 border border-line1 bg-bg0/85 opacity-0 transition-opacity duration-150 hover:border-line2 focus:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={(event) => { event.stopPropagation(); onExportCombined(); }}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
