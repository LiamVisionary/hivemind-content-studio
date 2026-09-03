// Canvas view — persistent ComfyUI workflow surface. All the iframe lifecycle,
// owner-unlock, and history-bridge plumbing lives in hubData + ToolSurface; this
// is just the framed embed with its slim toolbar.
import { zh } from '../../lib/i18n.js';
import { ToolSurface } from '../components/ToolSurface.jsx';

export function CanvasView({ active }) {
  return <ToolSurface name="canvas" title="Canvas" kicker={zh() ? '节点工作流' : 'Node workflow'} active={active} />;
}
