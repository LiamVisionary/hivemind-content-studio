// Persistent hub layer. App.jsx mounts this ONCE after the first hub navigation
// and never unmounts it — `visible` only toggles display, so the Canvas iframe
// (and all decrypted media, owner-unlock handshakes, and the history bridge)
// survives every page switch. All seven views stay mounted forever once this
// layer exists; only their display is toggled, keyed off the active view.
//
// Contract with App.jsx: <HubLayer visible={isHub} view={'create'|'canvas'|…} />.
// - on mount: startHub() (boot runs exactly once; it binds the window listeners
//   for 'hivemind-hub-refresh' / 'hivemind-owner-lock-broadcast' / message /
//   visibilitychange, and starts the 10s + 1s poll loops).
// - on view change: activateHubView(view) (store sync + per-view lazy work:
//   canvas → loadToolSurface, history → loadPrompts, telemetry → load…).
// - setHubRootEl wires this node so the poll loops can gate on root.isConnected.
import { useEffect, useRef } from 'react';
import { cx } from '../ui/kit.jsx';
import { activateHubView, setHubRootEl, startHub } from './hubData.js';
import { PlannerView } from './views/PlannerView.jsx';
import { CanvasView } from './views/CanvasView.jsx';
import { ModelsView } from './views/ModelsView.jsx';
import { RunsView } from './views/RunsView.jsx';
import { HistoryView } from './views/HistoryView.jsx';
import { TelemetryView } from './views/TelemetryView.jsx';
import { ProvidersView } from './views/ProvidersView.jsx';

export function HubLayer({ visible, view }) {
  const rootRef = useRef(null);

  // Boot once and register this node for the poll-loop isConnected gate.
  useEffect(() => {
    startHub();
    setHubRootEl(rootRef.current);
    return () => setHubRootEl(null);
  }, []);

  // Activate the requested view (store sync + lazy per-view work). `view` is only
  // null while a studio page is showing (visible === false) — skip activation then.
  useEffect(() => {
    if (view) activateHubView(view);
  }, [view]);

  // Display is driven straight off the router props so switching never flashes a
  // stale view; the data layer's activeView is kept in sync by the effect above.
  const current = visible ? view : null;

  return (
    <div ref={rootRef} className={cx('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
      <PlannerView active={current === 'create'} />
      <CanvasView active={current === 'canvas'} />
      <ModelsView active={current === 'models'} />
      <RunsView active={current === 'runs'} />
      <HistoryView active={current === 'history'} />
      <TelemetryView active={current === 'telemetry'} />
      <ProvidersView active={current === 'providers'} />
    </div>
  );
}
