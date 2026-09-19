import { CaretDownIcon, CloudDownloadIcon, DownloadIcon } from '@/components/icons';
import { openLoraManagerUiInNewTab } from '@/utils/loraManagerUi';
import { isEmbeddedInStudio, requestStudioPage } from '@/utils/studioNavigation';

interface MenuModelManagerSectionProps {
  open: boolean;
  sectionRef: React.RefObject<HTMLElement | null>;
  onToggle: () => void;
}

export function MenuModelManagerSection({
  open,
  sectionRef,
  onToggle,
}: MenuModelManagerSectionProps) {
  // Inside the studio this is the studio's own Models page — one manager, no
  // second tab. Standalone, it stays the external LoRA manager UI.
  const embedded = isEmbeddedInStudio();
  const openModelManager = () => {
    if (requestStudioPage('models')) return;
    openLoraManagerUiInNewTab();
  };

  return (
    <section ref={sectionRef} className="mb-6">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3"
        aria-expanded={open}
      >
        <span>Models & LoRAs</span>
        <CaretDownIcon className={`w-5 h-5 text-gray-400 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={openModelManager}
            className="w-full flex items-center gap-3 p-4 bg-white border border-gray-200
                       rounded-xl text-left hover:bg-gray-50 min-h-[56px]"
          >
            <CloudDownloadIcon className="w-6 h-6 text-gray-600" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-gray-900">Model Manager</span>
              <span className="text-xs text-gray-500">Browse installed files and Civitai downloads</span>
            </span>
            <span className="ml-auto text-gray-400">{embedded ? '→' : '↗'}</span>
          </button>

          <button
            type="button"
            onClick={openModelManager}
            className="w-full flex items-center gap-3 p-4 bg-white border border-gray-200
                       rounded-xl text-left hover:bg-gray-50 min-h-[56px]"
          >
            <DownloadIcon className="w-6 h-6 text-gray-600" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-gray-900">Download LoRA from Civitai</span>
              <span className="text-xs text-gray-500">Search or paste civitai.com / civitai.red URLs</span>
            </span>
            <span className="ml-auto text-gray-400">{embedded ? '→' : '↗'}</span>
          </button>
        </div>
      )}
    </section>
  );
}
