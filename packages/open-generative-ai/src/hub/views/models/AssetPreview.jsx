// Card art for an installed model file.
//
// The bridge hands over a still for every asset and an extra `motionUrl` only when
// the source is a video, so a grid of motion LoRAs costs about what a grid of stills
// costs: the animation is fetched when a card is actually looked at. Assets whose
// still cannot be resolved (the gateway reports sidecar previews that were never
// written) fall back to an icon rather than a broken image.
import { useState } from 'react';
import { useMediaSrc } from '../../../hooks/hooks.js';
import { Icon } from '../../../ui/icons.jsx';
import { cx } from '../../../ui/kit.jsx';

export function AssetPreview({ asset, className = '', playMotion = false }) {
  const [stillFailed, setStillFailed] = useState(false);
  const still = useMediaSrc(asset?.previewUrl || '');
  const hasMotion = Boolean(asset?.motionUrl);
  const motion = useMediaSrc(playMotion && hasMotion ? asset.motionUrl : '');
  const label = asset?.displayName || asset?.name || '';

  return (
    <div className={cx('relative flex items-center justify-center overflow-hidden bg-bg3', className)}>
      {playMotion && motion ? (
        <video src={motion} muted loop autoPlay playsInline className="h-full w-full object-cover" />
      ) : still && !stillFailed ? (
        <img
          src={still}
          alt={label ? `${label} preview` : ''}
          loading="lazy"
          onError={() => setStillFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Icon name={hasMotion ? 'film' : 'image'} size={18} className="text-ink3" />
      )}
      {hasMotion && !playMotion ? (
        <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded-sm bg-bg0/75 px-1 py-px text-[9px] font-semibold text-ink2">
          <Icon name="play" size={8} />
          motion
        </span>
      ) : null}
    </div>
  );
}
