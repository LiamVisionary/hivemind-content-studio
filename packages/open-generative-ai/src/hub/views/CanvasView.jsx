// Canvas view — persistent ComfyUI workflow surface. All the iframe lifecycle,
// owner-unlock, and history-bridge plumbing lives in hubData + ToolSurface; this
// is just the framed embed with its slim toolbar.
import { ToolSurface } from '../components/ToolSurface.jsx';
import { t } from '../../lib/i18n.js';

export function CanvasView({ active }) {
  return <ToolSurface name="canvas" title={t('nav.canvas')} kicker={t('canvas.kicker')} active={active} />;
}
