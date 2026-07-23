#!/usr/bin/env node
/* HTTPS reverse proxy for private Tailscale access.
 *
 * Browsers only expose some APIs (notably WebCrypto) in secure contexts.
 * ComfyUI Mobile needs WebCrypto for encrypted workflow storage/decryption, so
 * the private HTTP tailnet URL is not enough. This terminates HTTPS on the
 * Mac's Tailscale IP and forwards normal HTTP + WebSocket traffic to the local
 * Media Studio frontend on 127.0.0.1:8788.
 */
const fs = require('fs');
const http = require('http');
const http2 = require('http2');
const zlib = require('zlib');
const httpProxy = require('http-proxy');

const listenHost = process.env.TAILSCALE_IP;
const listenPort = Number(process.env.TAILSCALE_HTTPS_PORT || 8789);
const target = process.env.ZIMAGE_TARGET || 'http://127.0.0.1:8788';
const studioTarget = process.env.HIVEMIND_STUDIO_TARGET || 'http://127.0.0.1:8765';
const mcpTarget = process.env.MEDIA_STUDIO_MCP_TARGET || 'http://127.0.0.1:8796';
const cert = process.env.ZIMAGE_TLS_CERT;
const key = process.env.ZIMAGE_TLS_KEY;

if (!listenHost || !cert || !key) {
  console.error('Required env: TAILSCALE_IP, ZIMAGE_TLS_CERT, ZIMAGE_TLS_KEY');
  process.exit(2);
}

const proxy = httpProxy.createProxyServer({
  target,
  ws: true,
  changeOrigin: true,
  xfwd: true,
});

proxy.on('error', (err, req, res) => {
  console.error('[tailscale-https-proxy] proxy error:', err && err.message ? err.message : err);

  // http-proxy passes an http.ServerResponse for normal HTTP requests, but for
  // WebSocket upgrade failures it passes the raw net.Socket. The old handler
  // blindly called writeHead() on that socket, crashing the HTTPS tailnet proxy
  // and making subsequent remote uploads fail until the whole stack restarted.
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad gateway');
    } else if (!res.destroyed) {
      res.destroy();
    }
    return;
  }

  if (res && typeof res.destroy === 'function' && !res.destroyed) {
    res.destroy();
  }
});

function sendLanding(req, res) {
  const host = req.headers.host || `${listenHost}:${listenPort}`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>Media Studio private access</title>
  <style>
    html,body{margin:0;min-height:100%;background:#070811;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    body{display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 25% 10%,rgba(155,124,255,.34),transparent 32%),radial-gradient(circle at 80% 25%,rgba(67,231,255,.18),transparent 30%),linear-gradient(135deg,#070811,#111421 58%,#070811)}
    .card{width:min(520px,100%);box-sizing:border-box;border:1px solid rgba(255,255,255,.14);border-radius:28px;background:rgba(8,10,22,.88);box-shadow:0 30px 110px rgba(0,0,0,.48);padding:28px;display:grid;gap:14px}
    .eyebrow{margin:0;color:#9aa3b7;font-size:12px;text-transform:uppercase;letter-spacing:.14em}.title{margin:0;font-size:34px;letter-spacing:-.04em}.copy{margin:0;color:#c4cad8;line-height:1.45}.buttons{display:grid;gap:10px;margin-top:8px}.btn{display:block;text-decoration:none;text-align:center;border-radius:16px;padding:15px 16px;font-weight:800;color:#061018;background:linear-gradient(135deg,#9b7cff,#43e7ff)}.btn.secondary{color:#f6f7fb;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14)}.meta{font-size:12px;color:#9aa3b7;word-break:break-all}
  </style>
</head>
<body>
  <main class="card">
    <p class="eyebrow">Private Tailscale access</p>
    <h1 class="title">Media Studio is online</h1>
    <p class="copy">This is the plain fallback page. If the normal app was white on your phone, this page avoids the Next.js startup path.</p>
    <div class="buttons">
      <a class="btn" href="/app/">Open Media Studio</a>
      <a class="btn secondary" href="/mobile/">Open ComfyUI Mobile</a>
      <a class="btn secondary" href="http://${listenHost}:8788/">HTTP fallback</a>
    </div>
    <p class="meta">HTTPS origin: https://${host}</p>
  </main>
</body>
</html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

const targetUrl = new URL(target);
const studioTargetUrl = new URL(studioTarget);
const mcpTargetUrl = new URL(mcpTarget);
const GATEWAY_API_PREFIXES = [
  '/api/civitai',
  '/api/download',
  '/api/generate',
  '/api/history',
  '/api/job',
  '/api/library',
  '/api/loras',
  '/api/models',
  '/api/object_info',
  '/api/prompt',
  '/api/queue',
  '/api/view',
];
const GATEWAY_REFERER_PREFIXES = ['/app', '/gateway', '/mobile', '/comfy', '/models'];
// Keep-alive upstream pool: remote clients on high-RTT tailnet paths must not
// pay a fresh upstream TCP handshake per request.
const upstreamAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 256 });
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function startsWithRoute(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hasGatewayReferer(req) {
  try {
    const referer = new URL(req.headers.referer || req.headers.referrer || '');
    return GATEWAY_REFERER_PREFIXES.some((prefix) => startsWithRoute(referer.pathname, prefix));
  } catch {
    return false;
  }
}

function isGatewayApiRoute(pathname, req) {
  if (GATEWAY_API_PREFIXES.some((prefix) => startsWithRoute(pathname, prefix))) return true;
  if ((pathname === '/api/runtime' || pathname === '/healthz') && hasGatewayReferer(req)) return true;
  return false;
}

// HTTP/2 with HTTP/1.1 ALPN fallback. The old https/1.1 server serialized the
// gallery into (6 connections x RTT) waves; over a DERP-relayed tailnet path
// with multi-second RTT that made even tiny cached thumbnails crawl. With h2
// every request multiplexes onto one already-open connection, so latency is
// paid once per page, not once per image. http-proxy cannot handle h2 streams,
// so plain HTTP requests are forwarded by hand; WebSocket upgrades (h1-only by
// nature) still go through http-proxy below.
const server = http2.createSecureServer({
  cert: fs.readFileSync(cert),
  key: fs.readFileSync(key),
  allowHTTP1: true,
}, (req, res) => {
  let pathname = '/';
  try { pathname = new URL(req.url, `https://${req.headers[':authority'] || req.headers.host || 'localhost'}`).pathname; } catch {}
  if (pathname === '/__zdiag') {
    sendLanding(req, res);
    return;
  }
  let url = req.url;
  const gatewayRoute = pathname === '/app' || pathname.startsWith('/app/')
    || pathname === '/gateway' || pathname.startsWith('/gateway/')
    || pathname === '/mobile' || pathname.startsWith('/mobile/')
    || pathname === '/comfy' || pathname.startsWith('/comfy/')
    || pathname === '/models' || pathname.startsWith('/models/')
    || pathname === '/_next' || pathname.startsWith('/_next/')
    || pathname === '/image' || pathname.startsWith('/image/')
    || isGatewayApiRoute(pathname, req);
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    url = url.replace(/^\/app(?=\/|$)/, '') || '/';
  }
  if (pathname === '/gateway' || pathname.startsWith('/gateway/')) {
    url = url.replace(/^\/gateway(?=\/|$)/, '') || '/';
  }

  const routeTargetUrl = pathname === '/mcp' || pathname.startsWith('/mcp/')
    ? mcpTargetUrl
    : gatewayRoute ? targetUrl : studioTargetUrl;
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':') || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers.host = routeTargetUrl.host;
  headers['x-forwarded-proto'] = 'https';
  const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  headers['x-forwarded-for'] = remote;

  const upstreamReq = http.request({
    hostname: routeTargetUrl.hostname,
    port: routeTargetUrl.port || 80,
    path: url,
    method: req.method,
    headers,
    agent: upstreamAgent,
  }, (upstream) => {
    const outHeaders = {};
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP.has(name)) continue;
      outHeaders[name] = value;
    }
    // Remote tailnet clients sit on a ~240ms relayed path; large uncompressed
    // JSON (the outputs listing alone was 500KB per refresh) dominates load
    // time there. Gzip compressible responses at this edge when the upstream
    // did not already encode them; images/videos are skipped (already small
    // or already compressed).
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const contentType = String(outHeaders['content-type'] || '');
    const compressible = /^(application\/(json|javascript|xml|manifest\+json)|text\/|image\/svg)/i.test(contentType);
    const declaredLength = parseInt(String(outHeaders['content-length'] || ''), 10);
    const bigEnough = !Number.isFinite(declaredLength) || declaredLength > 1024;
    if (acceptsGzip && compressible && bigEnough && !outHeaders['content-encoding'] && req.method !== 'HEAD') {
      delete outHeaders['content-length'];
      outHeaders['content-encoding'] = 'gzip';
      outHeaders['vary'] = outHeaders['vary'] ? `${outHeaders['vary']}, Accept-Encoding` : 'Accept-Encoding';
      res.writeHead(upstream.statusCode || 502, outHeaders);
      upstream.pipe(zlib.createGzip({ level: 5 })).pipe(res);
      return;
    }
    res.writeHead(upstream.statusCode || 502, outHeaders);
    upstream.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    console.error('[tailscale-https-proxy] upstream error:', err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bad gateway');
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  // Bodyless requests can already be complete before the compatibility
  // request reaches this callback (notably after a fresh h2 connection). In
  // that case pipe() never closes the upstream request, so the browser waits
  // forever even though the local app is healthy.
  if (req.method === 'GET' || req.method === 'HEAD') {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
});

// The tailnet path to remote clients flaps (relayed CGNAT route): when it
// black-holes, the browser's single long-lived h2 session goes stale and page
// opens hang on it for ~20s before the browser gives up and reconnects. Ping
// each session on a short cycle and destroy it after two missed acks so the
// client fails over to a fresh connection in seconds instead.
server.on('connection', (socket) => {
  try { socket.setKeepAlive(true, 10000); } catch {}
});
server.on('session', (session) => {
  let missed = 0;
  const timer = setInterval(() => {
    if (session.destroyed) { clearInterval(timer); return; }
    if (missed >= 2) {
      clearInterval(timer);
      try { session.destroy(); } catch {}
      return;
    }
    missed += 1;
    try {
      session.ping((err) => { if (!err) missed = 0; });
    } catch {}
  }, 15000);
  timer.unref();
  session.on('close', () => clearInterval(timer));
});

server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(listenPort, listenHost, () => {
  console.log(`[tailscale-https-proxy] listening on https://${listenHost}:${listenPort} -> studio ${studioTarget}, gateway ${target}, mcp ${mcpTarget}`);
});
