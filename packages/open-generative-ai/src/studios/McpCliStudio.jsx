// Agents & API page (React port of the retired vanilla studio).
// Documents THIS studio's own MCP endpoint and API surfaces — display-only, no
// fetches. Load-bearing runtime logic preserved: the port-8789 sniff (Tailscale
// HTTPS proxy serves /mcp same-origin; otherwise the MCP HTTP server is local
// on 8796) and the byte-identical `claude mcp add` command string.
import { useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Icon } from '../ui/icons.jsx';
import { Card, IconButton, Pill, SectionLabel } from '../ui/kit.jsx';

function mcpBaseUrl() {
  // Behind the Tailscale HTTPS proxy (8789) /mcp is same-origin; otherwise
  // the MCP HTTP server listens on 8796 locally.
  if (window.location.port === '8789') return `${window.location.origin}/mcp`;
  return `http://127.0.0.1:8796/mcp`;
}

// Where the endpoint shown above is reachable FROM — the old copy claimed "this
// machine and any tailnet device" for a 127.0.0.1 URL that only this machine can
// open. Behind the 8789 proxy the same-origin /mcp really is tailnet-reachable.
function endpointReach() {
  const { port } = window.location;
  if (port === '8789') {
    return 'Endpoint (this machine and any tailnet device, through the HTTPS proxy):';
  }
  return 'Endpoint (this machine only — the MCP server listens on 127.0.0.1):';
}

function CopyRow({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {
      // navigator.clipboard is undefined over plain http on a LAN/tailnet IP.
      toast.error('Copy failed — select the text');
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg0 py-1.5 pl-3.5 pr-1.5">
      <code className="no-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] leading-relaxed text-ink1">
        {code}
      </code>
      <IconButton
        icon={copied ? 'check' : 'copy'}
        size="sm"
        label={copied ? 'Copied' : 'Copy to clipboard'}
        onClick={copy}
        className={copied ? 'text-honey' : ''}
      />
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

export function McpCliStudio({ active = true }) {
  const mcpUrl = useMemo(() => mcpBaseUrl(), []);
  const reach = useMemo(() => endpointReach(), []);
  const addCommand = `claude mcp add --transport http hivemind-media ${mcpUrl}`;

  // Rendered by the hub layer, which keeps every page mounted and toggles
  // display — so this one hides itself when it is not the open page.
  return (
    <div className={active ? 'min-h-0 flex-1 overflow-y-auto' : 'hidden'}>
      <div className="mx-auto w-full max-w-3xl px-5 py-6">
        {/* Slim intro row — workspace-first, no hero */}
        <div className="mb-5 flex flex-wrap items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-honey-tint text-honey">
            <Icon name="terminal" size={16} />
          </span>
          <h1 className="text-[15px] font-semibold text-ink1">{'Agents & API'}</h1>
          <Pill tone="neutral">{'For agents & automation'}</Pill>
        </div>
        <p className="mb-6 max-w-2xl text-[13px] leading-relaxed text-ink2">
          Agents can drive image and video generation, workflows, LoRAs, model management and job history through the built-in media MCP server, and durable runs through the local REST API. Same engine, same history, same privacy boundary.
        </p>

        <div className="flex flex-col gap-4">
          <SectionCard
            kicker="MCP server"
            title="Media MCP"
            meta={<Pill tone="honey">HTTP transport</Pill>}
          >
            <p className="mb-2 text-[13px] text-ink2">{reach}</p>
            <CopyRow code={mcpUrl} />
            <p className="mb-2 mt-4 text-[13px] text-ink2">Add it to Claude Code:</p>
            <CopyRow code={addCommand} />
            <p className="mt-3.5 text-xs leading-relaxed text-ink3">
              The server ships with the studio and is kept running by the local stack — no cloud account, no external keys.
            </p>
          </SectionCard>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard kicker="REST API" title="Durable runs">
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                Create and drive production runs the same way the Planner does — plans, scenes, artifacts, retries, and approvals are all API-first.
              </p>
              <div className="flex flex-col gap-2">
                <CopyRow code="POST /api/runs" />
                <CopyRow code={'GET  /api/runs/<run_id>'} />
              </div>
            </SectionCard>

            <SectionCard kicker="Telemetry" title="Generation evidence">
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                Providers, latency, cost, and success rates for every generation attempt — local metadata only, no prompts or media.
              </p>
              <div className="flex flex-col gap-2">
                <CopyRow code="GET /api/telemetry/generations" />
                <CopyRow code="GET /api/providers" />
              </div>
            </SectionCard>
          </div>

          {/* Truthful about the gate (control_api._machine_route_allowed +
              require_owner_or_control): creating or driving a run needs the
              owner session or an operator token; the read-only routes answer
              without one. */}
          <p className="pb-4 text-xs leading-relaxed text-ink3">
            Creating or driving a run (POST /api/runs, retry, cancel) needs the studio unlocked in this browser or an operator token (agents send it as a Bearer header). The read-only routes — catalog, providers, telemetry and run status — answer without a session.
          </p>
        </div>
      </div>
    </div>
  );
}
