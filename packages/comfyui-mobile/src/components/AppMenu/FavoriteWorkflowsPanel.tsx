import { useEffect, useState } from 'react';
import { listWorkflowFavorites, deleteWorkflowFavorite, type WorkflowFavoriteRecord } from '@/api/client';
import { MenuSubPageHeader } from './MenuSubPageHeader';
import { BookmarkIconSvg, TrashIcon, WorkflowIcon } from '@/components/icons';

interface FavoriteWorkflowsPanelProps {
  onBack: () => void;
  onLoadWorkflow: (record: WorkflowFavoriteRecord) => void;
}

export function FavoriteWorkflowsPanel({ onBack, onLoadWorkflow }: FavoriteWorkflowsPanelProps) {
  const [favorites, setFavorites] = useState<WorkflowFavoriteRecord[] | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    listWorkflowFavorites()
      .then(setFavorites)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load favorites'));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleDelete = async (event: React.MouseEvent, groupKey: string) => {
    event.stopPropagation();
    try {
      await deleteWorkflowFavorite(groupKey);
      setFavorites((prev) => prev ? prev.filter((item) => item.groupKey !== groupKey) : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete favorite');
    }
  };

  const imageIdToSrc = (imageId: string): string => {
    const [source, ...pathParts] = imageId.split('/');
    const path = pathParts.join('/');
    const slash = path.lastIndexOf('/');
    const subfolder = slash >= 0 ? path.slice(0, slash) : '';
    const filename = slash >= 0 ? path.slice(slash + 1) : path;
    return `/comfy/view?filename=${encodeURIComponent(filename)}&type=${encodeURIComponent(source || 'output')}&subfolder=${encodeURIComponent(subfolder)}`;
  };

  const outputName = (imageId: string): string => imageId.split('/').pop() || imageId;

  const toggleExpanded = (event: React.MouseEvent, groupKey: string) => {
    event.stopPropagation();
    setExpandedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  return (
    <div>
      <MenuSubPageHeader title="Favorite Workflows" onBack={onBack} />
      <p className="px-4 pb-3 text-xs leading-5 text-gray-500">
        One shortcut appears for each seedless workflow + input-image set once any generated image is favorited.
      </p>
      {error && (
        <div className="mx-4 mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {favorites === null && (
        <div className="px-4 py-8 text-center text-sm text-gray-400">Loading favorite workflows…</div>
      )}
      {favorites?.length === 0 && (
        <div className="mx-4 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center">
          <BookmarkIconSvg className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm font-semibold text-gray-700">No favorite workflow shortcuts yet</p>
          <p className="mt-1 text-xs text-gray-500">Favorite an image from Queue or the image viewer to create one.</p>
        </div>
      )}
      <div className="space-y-3 px-4 pb-6">
        {favorites?.map((favorite) => {
          const imgSrc = favorite.representativeImage.src || '';
          const imageIds = favorite.imageIds?.length ? favorite.imageIds : [];
          const isExpanded = Boolean(expandedGroups[favorite.groupKey]);
          const subtitle = [
            favorite.inputRefs.length ? `${favorite.inputRefs.length} input ref${favorite.inputRefs.length === 1 ? '' : 's'}` : 'No input image refs found',
            `${imageIds.length || favorite.favoriteCount || 1} output favorite${(imageIds.length || favorite.favoriteCount || 1) === 1 ? '' : 's'}`,
          ].join(' · ');
          return (
            <div
              key={favorite.groupKey}
              className="w-full overflow-hidden rounded-xl border border-gray-200 bg-white text-left shadow-sm"
            >
              <button
                type="button"
                onClick={() => onLoadWorkflow(favorite)}
                className="w-full text-left hover:bg-gray-50"
              >
                <div className="flex gap-3 p-3">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100 flex items-center justify-center">
                    {imgSrc ? (
                      <img src={imgSrc} alt="Favorite output" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <WorkflowIcon className="h-8 w-8 text-gray-300" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 py-0.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-gray-900">{favorite.title || 'Favorited workflow'}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-gray-500">{subtitle}</p>
                        {favorite.inputRefs[0] && (
                          <p className="mt-1 truncate text-[11px] text-gray-400">Input: {favorite.inputRefs[0]}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </button>
              <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2">
                {imageIds.length > 1 && (
                  <button
                    type="button"
                    onClick={(event) => toggleExpanded(event, favorite.groupKey)}
                    className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-200"
                  >
                    {isExpanded ? 'Hide outputs' : `Show ${imageIds.length} outputs`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={(event) => handleDelete(event, favorite.groupKey)}
                  className="ml-auto rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Delete favorite workflow shortcut"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
              {isExpanded && imageIds.length > 1 && (
                <div className="grid grid-cols-4 gap-2 border-t border-gray-100 bg-gray-50 p-3">
                  {imageIds.map((imageId) => (
                    <div key={imageId} className="min-w-0">
                      <div className="aspect-square overflow-hidden rounded-lg bg-gray-100">
                        <img src={imageIdToSrc(imageId)} alt={outputName(imageId)} className="h-full w-full object-cover" loading="lazy" />
                      </div>
                      <p className="mt-1 truncate text-[10px] text-gray-500">{outputName(imageId)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
