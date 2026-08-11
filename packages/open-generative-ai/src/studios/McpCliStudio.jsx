// MCP & agent access page (React port of the retired vanilla studio).
// Documents THIS studio's own MCP endpoint and API surfaces — display-only, no
// fetches. Load-bearing runtime logic preserved: the port-8789 sniff (Tailscale
// HTTPS proxy serves /mcp same-origin; otherwise the MCP HTTP server is local
// on 8796) and the byte-identical `claude mcp add` command string.
import { useMemo, useState } from 'react';
import { Icon } from '../ui/icons.jsx';
import { Card, Pill, SectionLabel, cx } from '../ui/kit.jsx';

function mcpBaseUrl() {
  // Behind the Tailscale HTTPS proxy (8789) /mcp is same-origin; otherwise
  // the MCP HTTP server listens on 8796 locally.
  if (window.location.port === '8789') return `${window.location.origin}/mcp`;
  return `http://127.0.0.1:8796/mcp`;
}

function CopyRow({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg0 py-2 pl-3.5 pr-2">
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] leading-relaxed text-ink1">
        {code}
      </code>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        aria-label="Copy to clipboard"
        className={cx(
          'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150',
          copied ? 'text-honey' : 'text-ink3 hover:bg-bg2 hover:text-ink1',
        )}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}

function SectionCard({ kicker, title, meta, children }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <SectionLabel className="text-honey">{kicker}</SectionLabel>
          <h2 className="mt-1 text-[15px] font-semibold text-ink1">{title}</h2>
        </div>
        {meta}
      </div>
      {children}
    </Card>
  );
}

export function McpCliStudio() {
  const mcpUrl = useMemo(() => mcpBaseUrl(), []);
  const addCommand = `claude mcp add --transport http hivemind-media ${mcpUrl}`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-5 py-6">
        {/* Slim intro row — workspace-first, no hero */}
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="terminal" size={16} />
          </span>
          <h1 className="text-[15px] font-semibold text-ink1">MCP &amp; API access</h1>
          <Pill tone="neutral">For agents &amp; automation</Pill>
        </div>
        <p className="mb-6 max-w-2xl text-[13px] leading-relaxed text-ink2">
          Everything this studio does — image, video, cinema, lip sync, durable runs — is also
          available to agents through the built-in Media Studio MCP server and the local REST API.
          Same engine, same history, same privacy boundary.
        </p>

        <div className="flex flex-col gap-4">
          <SectionCard
            kicker="MCP server"
            title="Media Studio MCP"
            meta={<Pill tone="honey">HTTP transport</Pill>}
          >
            <p className="mb-2 text-[13px] text-ink2">Endpoint (this machine and any tailnet device):</p>
            <CopyRow code={mcpUrl} />
            <p className="mb-2 mt-4 text-[13px] text-ink2">Add it to Claude Code:</p>
            <CopyRow code={addCommand} />
            <p className="mt-3.5 text-xs leading-relaxed text-ink3">
              The server lives in this repository at{' '}
              <code className="font-mono text-ink2">packages/media-gateway/bin/media-studio-mcp.mjs</code> and is
              supervised by the local stack — no cloud account, no external keys.
            </p>
          </SectionCard>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard kicker="REST API" title="Durable runs">
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                Create and drive production runs the same way the Planner does — plans, scenes,
                artifacts, retries, and approvals are all API-first.
              </p>
              <div className="flex flex-col gap-2">
                <CopyRow code="POST /api/runs" />
                <CopyRow code={'GET  /api/runs/<run_id>'} />
              </div>
            </SectionCard>

            <SectionCard kicker="Telemetry" title="Generation evidence">
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                Providers, latency, cost, and success rates for every generation attempt — local
                metadata only, no prompts or media.
              </p>
              <div className="flex flex-col gap-2">
                <CopyRow code="GET /api/telemetry/generations" />
                <CopyRow code="GET /api/providers" />
              </div>
            </SectionCard>
          </div>

          <p className="pb-4 text-xs leading-relaxed text-ink3">
            Owner-gated routes require the studio to be unlocked in this browser, or an operator
            token. Agent-safe routes (runs, catalog, telemetry) are available without a session on
            the local machine.
          </p>
        </div>
      </div>
    </div>
  );
}
