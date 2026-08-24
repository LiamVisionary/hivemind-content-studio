// The app had no error boundary: one render-time TypeError in any view (a
// surprising API shape was enough) unmounted the whole tree and left a black
// page with no message and no way back but a reload. Studios and hub views are
// independent, so each gets its own boundary — a broken History must not take
// the running video generation down with it.
//
// The fallback shows the error MESSAGE only (never a stack, never props) — a
// render error can originate in a component holding a prompt, and the message
// is the part that cannot carry one.
import { Component } from 'react';
import { Button } from '../ui/kit.jsx';
import { Icon } from '../ui/icons.jsx';

const MESSAGE_MAX = 240;

function describe(error) {
  const raw = String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
  return raw.length > MESSAGE_MAX ? `${raw.slice(0, MESSAGE_MAX - 1)}…` : raw;
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // React already logs the error; the component stack is the useful extra.
    console.error(`[studio] "${this.props.label || 'view'}" crashed:`, error, info?.componentStack || '');
    this.props.onError?.(error, info);
  }

  retry() {
    // Bumping the key remounts the subtree from scratch (fresh state, re-run
    // discovery) rather than re-rendering the component that just threw.
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  }

  render() {
    const { error, attempt } = this.state;
    const { children, label = 'This view', compact = false, fallback = null, hidden = false } = this.props;
    if (!error) {
      return <div key={attempt} className="contents">{children}</div>;
    }
    // A display-toggled view (hub pages stay mounted) must not show its fallback
    // while another page is the visible one.
    if (hidden) return null;
    if (typeof fallback === 'function') return fallback({ error, retry: this.retry });
    return (
      <div
        role="alert"
        className={compact
          ? 'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center'
          : 'flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center'}
      >
        <div className="grid h-12 w-12 place-items-center rounded-lg border border-line1 bg-bg2 text-danger">
          <Icon name="warning" size={22} />
        </div>
        <div className="max-w-md">
          <div className="text-sm font-semibold text-ink1">{label} hit an error</div>
          <div className="mt-1 text-[13px] leading-relaxed text-ink3">
            Your other tabs and running generations are unaffected. Try again, or reload the page if it keeps happening.
          </div>
          <div className="mt-3 rounded-md border border-line1 bg-bg2 px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-ink2 break-words">
            {describe(error)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" icon="refresh" onClick={this.retry}>Try again</Button>
          <Button size="sm" onClick={() => window.location.reload()}>Reload page</Button>
        </div>
      </div>
    );
  }
}
