// Which animation models the Sprite stage can actually send a sprite to.
//
// The stage hands the lane a START FRAME: the sprite, promoted to a reference
// that is sealed to the owner vault and readable only by this machine's studio.
// That fixes the transport before the model is picked — the request the stage
// builds is a Media Studio lane job, and nothing else understands it. A row
// the picker rates highly but this stage cannot reach is still shown, with the
// reason on the row, and never chosen by default.
//
// Pure so the routing can be pinned without rendering the studio: the bug this
// replaced (every pick rewritten to a `media-studio-mcp` row, so a Higgsfield
// model id was posted to the local lane as an unknown workflow) lived in the
// component and was invisible to every test.
import { clipRouteFor } from '../../lib/modelRunner.js';

/** The transports the animation stage builds a request for. Keyed the way
 *  `runVideo`'s `extra` is, so the same set declares it at the call site. */
export const SPRITE_CLIP_TRANSPORTS = Object.freeze(['studio']);

/**
 * The routing identity of a picked row: `{ id, provider, source }`, taken FROM
 * the pick. The row is what the picker offered, so the provider is the one the
 * matrix rated — not whichever one the stage assumed.
 */
export function animationRow(pick) {
  return { id: pick.id, provider: pick.provider, source: pick.source || 'cloud' };
}

/**
 * Mark each ranked row with whether THIS stage can run it, and why not.
 *
 * `available` from the matrix means the provider answered its probe. A row
 * also has to resolve to a transport the stage built a request for, or the
 * picker offers a model whose Animate button can only fail.
 */
export function animationChoices(rows) {
  return rows.map((row) => {
    const route = clipRouteFor(animationRow(row));
    const reachable = route.runnable && SPRITE_CLIP_TRANSPORTS.includes(route.transport);
    let reason = '';
    if (!route.runnable) reason = route.reason;
    else if (!reachable) {
      reason = `The sprite is sealed on this machine, so this stage runs on this machine only — ${route.label} is not wired in here yet. Pick a model that runs here.`;
    }
    return {
      ...row,
      available: row.available !== false && reachable,
      unavailableReason: reason,
      transport: route.transport,
    };
  });
}
