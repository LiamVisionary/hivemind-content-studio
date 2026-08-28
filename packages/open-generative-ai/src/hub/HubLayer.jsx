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
import { ErrorBoundary } from '../app/ErrorBoundary.jsx';
import { cx } from '../ui/kit.jsx';
import { activateHubView, setHubRootEl, setHubVisible, startHub } from './hubData.js';
import { PlannerView } from './views/PlannerView.jsx';
import { CanvasView } from './views/CanvasView.jsx';
import { InspoView } from './views/InspoView.jsx';
import { ModelsView } from './views/ModelsView.jsx';
import { RunsView } from './views/RunsView.jsx';
import { HistoryView } from './views/HistoryView.jsx';
import { TelemetryView } from './views/TelemetryView.jsx';
import { GpuMachinesView } from './views/GpuMachinesView.jsx';
import { ProvidersView } from './views/ProvidersView.jsx';
import { PassBookView } from './views/PassBookView.jsx';

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

  // The data layer's view-scoped polls (History prompts, Providers OAuth) need
  // to know when a studio page has taken over the screen — activeView alone
  // stayed 'history' and kept the archive re-fetching behind the Video studio.
  useEffect(() => {
    setHubVisible(visible);
    return () => setHubVisible(false);
  }, [visible]);

  // Display is driven straight off the router props so switching never flashes a
  // stale view; the data layer's activeView is kept in sync by the effect above.
  const current = visible ? view : null;

  return (
    <div ref={rootRef} className={cx('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}>
      {/* One boundary per view: a surprising payload in one page must not blank
          the others (they all stay mounted, so a crash here used to take the
          Canvas iframe and every decrypted thumbnail with it). */}
      <ErrorBoundary label="Planner" hidden={current !== 'create'}><PlannerView active={current === 'create'} /></ErrorBoundary>
      <ErrorBoundary label="Canvas" hidden={current !== 'canvas'}><CanvasView active={current === 'canvas'} /></ErrorBoundary>
      <ErrorBoundary label="Inspo" hidden={current !== 'inspo'}><InspoView active={current === 'inspo'} /></ErrorBoundary>
      <ErrorBoundary label="Models" hidden={current !== 'models'}><ModelsView active={current === 'models'} /></ErrorBoundary>
      <ErrorBoundary label="Runs" hidden={current !== 'runs'}><RunsView active={current === 'runs'} /></ErrorBoundary>
      <ErrorBoundary label="History" hidden={current !== 'history'}><HistoryView active={current === 'history'} /></ErrorBoundary>
      <ErrorBoundary label="Telemetry" hidden={current !== 'telemetry'}><TelemetryView active={current === 'telemetry'} /></ErrorBoundary>
      <ErrorBoundary label="Providers" hidden={current !== 'providers'}><ProvidersView active={current === 'providers'} /></ErrorBoundary>
      <ErrorBoundary label="PassBook" hidden={current !== 'passbook'}><PassBookView active={current === 'passbook'} /></ErrorBoundary>
      <ErrorBoundary label="Machines" hidden={current !== 'machines'}><GpuMachinesView active={current === 'machines'} /></ErrorBoundary>
    </div>
  );
}
