// Agents & API page (React port of the retired vanilla studio).
// Documents THIS studio's own MCP endpoint and API surfaces — display-only, no
// fetches. Load-bearing runtime logic preserved: the port-8789 sniff (Tailscale
// HTTPS proxy serves /mcp same-origin; otherwise the MCP HTTP server is local
// on 8796) and the byte-identical `claude mcp add` command string.
import { useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { getLang } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Card, IconButton, Pill, SectionLabel } from '../ui/kit.jsx';

const zh = () => getLang() === 'zh-CN';

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
    return zh() ? '端点（本机以及 tailnet 中的任何设备，经 HTTPS 代理）：' : 'Endpoint (this machine and any tailnet device, through the HTTPS proxy):';
  }
  return zh() ? '端点（仅本机 — MCP 服务器监听在 127.0.0.1）：' : 'Endpoint (this machine only — the MCP server listens on 127.0.0.1):';
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
      toast.error(zh() ? '复制失败 — 请手动选中文本' : 'Copy failed — select the text');
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
        label={copied ? (zh() ? '已复制' : 'Copied') : (zh() ? '复制' : 'Copy to clipboard')}
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
          <h1 className="text-[15px] font-semibold text-ink1">{zh() ? '智能体与 API' : 'Agents & API'}</h1>
          <Pill tone="neutral">{zh() ? '面向智能体与自动化' : 'For agents & automation'}</Pill>
        </div>
        <p className="mb-6 max-w-2xl text-[13px] leading-relaxed text-ink2">
          {zh()
            ? '智能体可以通过内置的媒体 MCP 服务器驱动图像与视频生成、工作流、LoRA、模型管理和作业历史，持久运行则通过本地 REST API。同一个引擎，同一份历史，同一条隐私边界。'
            : 'Agents can drive image and video generation, workflows, LoRAs, model management and job history through the built-in media MCP server, and durable runs through the local REST API. Same engine, same history, same privacy boundary.'}
        </p>

        <div className="flex flex-col gap-4">
          <SectionCard
            kicker={zh() ? 'MCP 服务器' : 'MCP server'}
            title={zh() ? '媒体 MCP' : 'Media MCP'}
            meta={<Pill tone="honey">{zh() ? 'HTTP 传输' : 'HTTP transport'}</Pill>}
          >
            <p className="mb-2 text-[13px] text-ink2">{reach}</p>
            <CopyRow code={mcpUrl} />
            <p className="mb-2 mt-4 text-[13px] text-ink2">{zh() ? '添加到 Claude Code：' : 'Add it to Claude Code:'}</p>
            <CopyRow code={addCommand} />
            <p className="mt-3.5 text-xs leading-relaxed text-ink3">
              {zh()
                ? '这个服务器随工作室一起安装，由本地服务栈管理 — 不需要云账号，也不需要外部密钥。'
                : 'The server ships with the studio and is kept running by the local stack — no cloud account, no external keys.'}
            </p>
          </SectionCard>

          <div className="grid gap-4 md:grid-cols-2">
            <SectionCard kicker="REST API" title={zh() ? '持久运行' : 'Durable runs'}>
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                {zh()
                  ? '像 Planner 一样创建和推进制作运行 — 计划、场景、产物、重试和审批都是 API 优先的。'
                  : 'Create and drive production runs the same way the Planner does — plans, scenes, artifacts, retries, and approvals are all API-first.'}
              </p>
              <div className="flex flex-col gap-2">
                <CopyRow code="POST /api/runs" />
                <CopyRow code={'GET  /api/runs/<run_id>'} />
              </div>
            </SectionCard>

            <SectionCard kicker={zh() ? '遥测' : 'Telemetry'} title={zh() ? '生成证据' : 'Generation evidence'}>
              <p className="mb-3 text-[13px] leading-relaxed text-ink2">
                {zh()
                  ? '每次生成尝试的提供方、延迟、成本和成功率 — 只有本地元数据，不含提示词或媒体。'
                  : 'Providers, latency, cost, and success rates for every generation attempt — local metadata only, no prompts or media.'}
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
            {zh()
              ? '创建或推进运行（POST /api/runs、重试、取消）需要在此浏览器中解锁工作室，或使用操作员令牌（智能体以 Bearer 头发送）。只读路由 — 目录、提供方、遥测和运行状态 — 无需会话即可访问。'
              : 'Creating or driving a run (POST /api/runs, retry, cancel) needs the studio unlocked in this browser or an operator token (agents send it as a Bearer header). The read-only routes — catalog, providers, telemetry and run status — answer without a session.'}
          </p>
        </div>
      </div>
    </div>
  );
}
