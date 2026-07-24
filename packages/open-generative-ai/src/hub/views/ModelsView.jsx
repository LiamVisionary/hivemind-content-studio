// Models view — persistent local model manager surface (embedded gateway app).
import { ToolSurface } from '../components/ToolSurface.jsx';

export function ModelsView({ active }) {
  return <ToolSurface name="models" title="Models" kicker="Local runtime" active={active} />;
}
