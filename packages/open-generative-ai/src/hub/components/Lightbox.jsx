// Shared media preview for the hub (History outputs, run artifacts, generation
// cards). Built on the kit Modal so it behaves like every other dialog: Escape
// closes it, focus moves in and back out, the page behind stops scrolling.
// The two hand-rolled scrim-only lightboxes it replaces had none of that.
import { Modal } from '../../ui/Modal.jsx';

// `kind` is what the media IS, not how it was stored: an audio output opens a
// transport, never an <img> pointed at an MP3. The Music studio's tracks reach
// this component through History like every other output.
const TITLES = { video: 'Video preview', audio: 'Track preview', image: 'Image preview' };

export function Lightbox({ src, kind = 'image', alt = 'Preview', title, onClose, children }) {
  const media = TITLES[kind] ? kind : 'image';
  return (
    <Modal open onClose={onClose} title={title || TITLES[media]} size="xl">
      <div className="grid place-items-center">
        {children ? children : !src ? (
          <div className="h-64 w-full animate-pulse rounded-lg bg-bg2" aria-label="Loading preview" />
        ) : media === 'video' ? (
          <video
            src={src}
            controls controlsList="nodownload"
            autoPlay
            playsInline
            className="max-h-[72dvh] max-w-full rounded-lg bg-black object-contain"
          />
        ) : media === 'audio' ? (
          // Full width rather than centred: the browser's own transport is the
          // whole preview here, and a 300px player in a 72vh box reads as a
          // picture that failed to load.
          <div className="w-full px-2 py-6">
            <audio src={src} controls autoPlay preload="metadata" className="h-10 w-full" aria-label={alt} />
          </div>
        ) : (
          <img src={src} alt={alt} className="max-h-[72dvh] max-w-full rounded-lg object-contain" />
        )}
      </div>
    </Modal>
  );
}
