// ONE tile for reference pictures and clips alike, and the whole point of it is
// not drawing 36 pixels from a multi-megabyte original.
//
// `posterUrl` is a few-KB sealed thumbnail the server built at upload; with one
// the tile costs a single small decrypt. Without one — every reference sealed
// before posters existed — the browser falls back to decrypting the original,
// draws the thumbnail itself, and hands it back through onPosterCaptured so the
// next session is cheap. A clip additionally needs a frame DECODED: a <video>
// pointed at a blob paints nothing until it has one, which is why sealed clips
// used to render as identical placeholder icons.
import { useEffect } from 'react';
import { useMediaPoster } from '../../hooks/hooks.js';
import { Icon } from '../../ui/icons.jsx';
import { Thumb } from '../UploadPicker.jsx';
export function ReferenceThumb({ url, posterUrl = null, kind = 'video', alt = '', icon, onPosterCaptured }) {
  const { poster, resolved, pending } = useMediaPoster(posterUrl ? '' : url, { kind });
  useEffect(() => {
    if (posterUrl || !poster || !onPosterCaptured) return;
    onPosterCaptured(url, poster);
  }, [posterUrl, poster, url, onPosterCaptured]);

  if (posterUrl) return <Thumb src={posterUrl} alt={alt} />;
  if (!resolved || pending) {
    return <div className="h-full w-full animate-pulse bg-bg3" aria-label="Decrypting" />;
  }
  if (!poster) {
    // Nothing decodable. A picture can still be shown as itself; a clip cannot.
    if (kind === 'image') return <Thumb src={url} alt={alt} />;
    return (
      <span className="grid h-full w-full place-items-center bg-bg3 text-ink3" title="This clip could not be previewed">
        <Icon name={icon || 'film'} size={12} />
      </span>
    );
  }
  if (kind === 'image') return <img src={poster} alt={alt} className="h-full w-full object-cover" />;
  return (
    <video
      src={resolved}
      poster={poster}
      muted
      playsInline
      preload="none"
      className="h-full w-full object-cover"
    />
  );
}
