// Shared media preview for the hub (History outputs, run artifacts, generation
// cards). Built on the kit Modal so it behaves like every other dialog: Escape
// closes it, focus moves in and back out, the page behind stops scrolling.
// The two hand-rolled scrim-only lightboxes it replaces had none of that.
import { Modal } from '../../ui/Modal.jsx';

export function Lightbox({ src, kind = 'image', alt = 'Preview', title, onClose, children }) {
  const isVideo = kind === 'video';
  return (
    <Modal open onClose={onClose} title={title || (isVideo ? 'Video preview' : 'Image preview')} size="xl">
      <div className="grid place-items-center">
        {children ? children : !src ? (
          <div className="h-64 w-full animate-pulse rounded-lg bg-bg2" aria-label="Loading preview" />
        ) : isVideo ? (
          <video
            src={src}
            controls controlsList="nodownload"
            autoPlay
            playsInline
            className="max-h-[72vh] max-w-full rounded-lg bg-black object-contain"
          />
        ) : (
          <img src={src} alt={alt} className="max-h-[72vh] max-w-full rounded-lg object-contain" />
        )}
      </div>
    </Modal>
  );
}
