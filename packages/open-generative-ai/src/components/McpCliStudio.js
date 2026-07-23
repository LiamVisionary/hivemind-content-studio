// MCP & agent access page — documents THIS studio's own MCP endpoint and API
// surfaces so agents and IDEs can drive the local stack. No external services.

function mcpBaseUrl() {
    // Behind the Tailscale HTTPS proxy (8789) /mcp is same-origin; otherwise
    // the MCP HTTP server listens on 8796 locally.
    if (window.location.port === '8789') return `${window.location.origin}/mcp`;
    return `http://127.0.0.1:8796/mcp`;
}

function copyButton(value) {
    return `<button type="button" class="mcp-copy grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/5 text-secondary transition-colors hover:bg-white/10 hover:text-white" data-copy="${value.replaceAll('"', '&quot;')}" title="Copy" aria-label="Copy to clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
}

function codeRow(code) {
    return `<div class="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-black/30 px-4 py-3">
        <code class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-primary/90 no-scrollbar">${code}</code>
        ${copyButton(code.replaceAll('&lt;', '<').replaceAll('&gt;', '>'))}
    </div>`;
}

export function McpCliStudio() {
    const container = document.createElement('div');
    container.className = 'w-full h-full overflow-y-auto bg-transparent text-white custom-scrollbar';

    const mcpUrl = mcpBaseUrl();
    const addCommand = `claude mcp add --transport http hivemind-media ${mcpUrl}`;

    container.innerHTML = `
    <div class="mx-auto w-full max-w-4xl px-5 py-10 md:py-14 animate-fade-in-up">
        <div class="mb-10 text-center">
            <span class="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-secondary">For agents &amp; automation</span>
            <h1 class="font-display text-3xl md:text-4xl font-bold tracking-tight text-white mb-3">MCP &amp; API access</h1>
            <p class="mx-auto max-w-2xl text-[15px] leading-relaxed text-secondary">
                Everything this studio does — image, video, cinema, lip sync, durable runs — is also
                available to agents through the built-in Media Studio MCP server and the local REST API.
                Same engine, same history, same privacy boundary.
            </p>
        </div>

        <section class="mb-6 rounded-3xl border border-white/[0.07] bg-card-bg/80 p-6 shadow-panel">
            <div class="mb-4 flex items-center justify-between gap-3">
                <div><p class="text-[11px] font-semibold uppercase tracking-widest text-primary/80">MCP server</p>
                <h2 class="font-display text-lg font-semibold text-white">Media Studio MCP</h2></div>
                <span class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold text-secondary">HTTP transport</span>
            </div>
            <p class="mb-3 text-sm leading-relaxed text-secondary">Endpoint (this machine and any tailnet device):</p>
            ${codeRow(mcpUrl)}
            <p class="mb-3 mt-5 text-sm leading-relaxed text-secondary">Add it to Claude Code:</p>
            ${codeRow(addCommand)}
            <p class="mt-4 text-xs leading-relaxed text-muted">The server lives in this repository at <code class="font-mono text-secondary">packages/media-gateway/bin/media-studio-mcp.mjs</code> and is supervised by the local stack — no cloud account, no external keys.</p>
        </section>

        <section class="mb-6 grid gap-6 md:grid-cols-2">
            <div class="rounded-3xl border border-white/[0.07] bg-card-bg/80 p-6 shadow-panel">
                <p class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-primary/80">REST API</p>
                <h3 class="mb-3 font-display text-base font-semibold text-white">Durable runs</h3>
                <p class="mb-4 text-sm leading-relaxed text-secondary">Create and drive production runs the same way the Planner does — plans, scenes, artifacts, retries, and approvals are all API-first.</p>
                ${codeRow('POST /api/runs')}
                <div class="h-2"></div>
                ${codeRow('GET  /api/runs/&lt;run_id&gt;')}
            </div>
            <div class="rounded-3xl border border-white/[0.07] bg-card-bg/80 p-6 shadow-panel">
                <p class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-primary/80">Telemetry</p>
                <h3 class="mb-3 font-display text-base font-semibold text-white">Generation evidence</h3>
                <p class="mb-4 text-sm leading-relaxed text-secondary">Providers, latency, cost, and success rates for every generation attempt — local metadata only, no prompts or media.</p>
                ${codeRow('GET /api/telemetry/generations')}
                <div class="h-2"></div>
                ${codeRow('GET /api/providers')}
            </div>
        </section>

        <p class="text-center text-xs leading-relaxed text-muted">
            Owner-gated routes require the studio to be unlocked in this browser, or an operator token.
            Agent-safe routes (runs, catalog, telemetry) are available without a session on the local machine.
        </p>
    </div>`;

    container.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button) return;
        try {
            await navigator.clipboard.writeText(button.dataset.copy);
            button.classList.add('text-primary');
            setTimeout(() => button.classList.remove('text-primary'), 900);
        } catch { /* clipboard unavailable */ }
    });

    return container;
}
