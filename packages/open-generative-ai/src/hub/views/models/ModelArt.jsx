// A model's picture, at whatever size it is asked for.
//
// Its own file because the grid and the detail panel both draw it, and having
// the detail import it from the grid made the two files import each other.
//
// A model nothing matched still gets a tile: a gradient in a hue derived from
// its own id, with its initials. That is deliberate — a grid where some cards
// have art and others have empty grey boxes reads as broken, where a grid of
// coloured tiles reads as a set of models, some of which have photographs.
import { modelInitials, modelTint } from '../../../lib/modelArt.js';
import { cx } from '../../../ui/kit.jsx';

export function ModelArt({ model, card, className = '', letters = true }) {
  return (
    <div
      className={cx('relative flex items-center justify-center overflow-hidden bg-bg3', className)}
      style={card?.artUrl ? undefined : { backgroundImage: modelTint(model) }}
    >
      {card?.artUrl ? (
        <img src={card.artUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : letters ? (
        <span className="select-none text-2xl font-semibold tracking-tight text-ink1/25">{modelInitials(model)}</span>
      ) : null}
    </div>
  );
}
