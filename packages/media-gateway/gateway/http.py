"""The HTTP layer: the request handler, its auth and CORS, the ComfyUI and
frontend proxies, and multipart parsing. Dispatch itself is in routes.py."""
import json
import mimetypes
import re
import socket
import sys
import threading
import email.policy
import io
import uuid
import shutil
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse, urlencode, unquote
from urllib.request import Request
from urllib.error import HTTPError

from gateway import config, graphs, history, jobs, lanes as _lanes, loras as _loras, media, models as _models, native_mlx, net, promptroutes, restore, routes, runners, util, workflow_index


class _MultipartPart:
    """One decoded multipart field, shaped like the cgi.FieldStorage item we used."""

    __slots__ = ('name', 'filename', 'value', 'file')

    def __init__(self, name, filename, payload):
        self.name = name
        self.filename = filename or ''
        self.value = payload
        self.file = io.BytesIO(payload) if filename else None


class MultipartForm:
    """Minimal stand-in for cgi.FieldStorage over a multipart/form-data body.

    The `cgi` module was removed in Python 3.13, and this app is launched with
    whatever `python3` resolves to — currently Homebrew's 3.14 — so importing it
    took the whole media gateway down at startup. Only the three operations the
    upload handler actually used are reimplemented here: `getfirst`, `in`, and
    item access returning something with `.file` and `.filename`.
    """

    def __init__(self, body, content_type):
        header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode('utf-8', 'replace')
        message = email.parser.BytesParser(policy=email.policy.default).parsebytes(header + body)
        self._parts = {}
        if not message.is_multipart():
            return
        for part in message.iter_parts():
            disposition = part.get('Content-Disposition')
            if not disposition:
                continue
            name = part.get_param('name', header='Content-Disposition')
            if not name:
                continue
            filename = part.get_filename() or ''
            payload = part.get_payload(decode=True) or b''
            self._parts.setdefault(str(name), []).append(_MultipartPart(str(name), filename, payload))

    def __contains__(self, key):
        return key in self._parts

    def __getitem__(self, key):
        return self._parts[key][0]

    def getfirst(self, key, default=None):
        items = self._parts.get(key)
        if not items:
            return default
        part = items[0]
        if part.filename:
            return default
        return part.value.decode('utf-8', 'replace')


CSS = """
:root{--bg:#08090d;--panel:rgba(255,255,255,.075);--panel2:rgba(255,255,255,.11);--stroke:rgba(255,255,255,.14);--text:#f7f7fb;--muted:#a8a9b8;--pink:#ff4ecd;--violet:#8b5cf6;--cyan:#22d3ee;--green:#34d399;--red:#fb7185;--shadow:0 24px 80px rgba(0,0,0,.45)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 15% 0%,rgba(139,92,246,.36),transparent 32rem),radial-gradient(circle at 90% 8%,rgba(34,211,238,.25),transparent 31rem),radial-gradient(circle at 50% 110%,rgba(255,78,205,.20),transparent 26rem),var(--bg)}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.8),transparent 72%)}
a{color:inherit}.wrap{width:min(1180px,calc(100% - 28px));margin:0 auto;padding:28px 0 112px}.top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:24px}.brand{display:flex;gap:13px;align-items:center}.orb{width:46px;height:46px;border-radius:15px;background:linear-gradient(135deg,var(--pink),var(--violet),var(--cyan));box-shadow:0 0 36px rgba(139,92,246,.75)}.eyebrow{color:var(--muted);font-size:13px;letter-spacing:.14em;text-transform:uppercase}.brand h1{margin:0;font-size:24px;line-height:1}.pills{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid var(--stroke);background:rgba(255,255,255,.06);border-radius:999px;padding:8px 12px;color:#d7d8e4;font-size:13px;backdrop-filter:blur(14px)}.tabs{position:sticky;top:10px;z-index:30;display:flex;gap:9px;flex-wrap:wrap;margin:-8px 0 20px;padding:8px;border:1px solid var(--stroke);background:rgba(8,9,13,.72);border-radius:999px;backdrop-filter:blur(18px);box-shadow:0 14px 44px rgba(0,0,0,.24)}.tab{border:1px solid var(--stroke);background:rgba(255,255,255,.06);border-radius:999px;padding:10px 14px;color:#e9e9f3;text-decoration:none;font-weight:750}.tab.active{background:linear-gradient(135deg,rgba(255,78,205,.36),rgba(34,211,238,.22));border-color:rgba(255,255,255,.28)}.bottom-tabs{position:fixed;left:50%;bottom:calc(12px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:1000;width:min(520px,calc(100% - 18px));display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px;border:1px solid rgba(255,255,255,.20);border-radius:24px;background:rgba(8,9,13,.82);backdrop-filter:blur(22px);box-shadow:0 18px 70px rgba(0,0,0,.55)}.bottom-tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:54px;border-radius:17px;text-decoration:none;color:#d8d9e6;font-size:12px;font-weight:850}.bottom-tab .ico{font-size:19px;line-height:1}.bottom-tab.active{color:#fff;background:linear-gradient(135deg,rgba(255,78,205,.42),rgba(139,92,246,.34),rgba(34,211,238,.24));box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(320px,.95fr);gap:20px;align-items:stretch}.glass{border:1px solid var(--stroke);background:linear-gradient(180deg,rgba(255,255,255,.12),rgba(255,255,255,.06));border-radius:28px;box-shadow:var(--shadow);backdrop-filter:blur(22px)}.composer{padding:24px}.composer h2{font-size:42px;letter-spacing:-.04em;line-height:1.02;margin:0 0 12px}.sub{color:var(--muted);line-height:1.6;margin:0 0 20px}.field{position:relative}textarea{width:100%;min-height:160px;resize:vertical;border:1px solid rgba(255,255,255,.16);outline:none;border-radius:22px;background:rgba(0,0,0,.28);color:var(--text);font:inherit;font-size:16px;line-height:1.55;padding:18px 18px 44px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}textarea:focus{border-color:rgba(34,211,238,.65);box-shadow:0 0 0 4px rgba(34,211,238,.12),inset 0 1px 0 rgba(255,255,255,.05)}.counter{position:absolute;right:16px;bottom:13px;color:var(--muted);font-size:12px}.actions{display:flex;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap}.btn{appearance:none;border:0;border-radius:999px;padding:14px 20px;font-weight:800;color:white;background:linear-gradient(135deg,var(--pink),var(--violet) 48%,var(--cyan));box-shadow:0 12px 32px rgba(139,92,246,.38);cursor:pointer;font-size:16px}.btn:hover{filter:brightness(1.08)}.btn:disabled{opacity:.65;cursor:wait}.hint{color:var(--muted);font-size:13px}.examples{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.chip{border:1px solid var(--stroke);background:rgba(255,255,255,.06);color:#e6e7ef;border-radius:999px;padding:8px 11px;font-size:13px;cursor:pointer}.chip:hover{background:rgba(255,255,255,.12)}
.live{padding:22px;display:flex;flex-direction:column;min-height:100%}.live-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.live h3,.history-head h2{margin:0;font-size:20px}.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--stroke);border-radius:999px;padding:7px 10px;text-transform:uppercase;font-size:12px;font-weight:800;letter-spacing:.05em}.dot{width:8px;height:8px;border-radius:99px;background:var(--muted)}.running .dot,.queued .dot{background:var(--cyan);box-shadow:0 0 16px var(--cyan);animation:pulse 1s infinite}.success .dot{background:var(--green)}.error .dot{background:var(--red)}@keyframes pulse{50%{opacity:.35}}.preview{flex:1;min-height:270px;border:1px dashed rgba(255,255,255,.18);border-radius:23px;background:rgba(0,0,0,.18);display:grid;place-items:center;overflow:hidden;text-align:center;color:var(--muted);padding:18px}.preview img{width:100%;height:100%;object-fit:contain;border-radius:18px}.spinner{width:46px;height:46px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:var(--cyan);animation:spin 1s linear infinite;margin:0 auto 14px}@keyframes spin{to{transform:rotate(360deg)}}.jobmeta{margin-top:14px;color:var(--muted);font-size:13px;line-height:1.55}.jobmeta code{color:#d8d8e6}.errorbox{color:#fecdd3;background:rgba(251,113,133,.12);border:1px solid rgba(251,113,133,.25);border-radius:16px;padding:12px;white-space:pre-wrap}
.history{margin-top:24px}.history-head{display:flex;align-items:end;justify-content:space-between;gap:14px;margin-bottom:14px}.history-head p{margin:5px 0 0;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border:1px solid var(--stroke);background:rgba(255,255,255,.07);border-radius:24px;overflow:hidden;box-shadow:0 12px 36px rgba(0,0,0,.25);backdrop-filter:blur(18px)}.thumb{aspect-ratio:1/1;background:rgba(0,0,0,.22);display:grid;place-items:center;color:var(--muted);overflow:hidden}.thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s}.card:hover .thumb img{transform:scale(1.035)}.card-body{padding:14px}.card-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}.prompt{font-size:14px;line-height:1.45;margin:0;color:#f0f0f6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.time{color:var(--muted);font-size:12px;white-space:nowrap}.empty{border:1px dashed var(--stroke);border-radius:24px;padding:32px;text-align:center;color:var(--muted);background:rgba(255,255,255,.045)}.footer{margin-top:22px;color:var(--muted);font-size:13px;text-align:center}pre{white-space:pre-wrap;word-break:break-word}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ram{padding:18px;margin-bottom:20px}.ram-top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.bar{height:13px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid var(--stroke)}.bar>span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--green),var(--cyan),var(--violet));width:0}.model-section{margin:18px 0 28px}.model-section h2{font-size:22px;margin:0 0 12px}.model-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.model{padding:14px;border:1px solid var(--stroke);background:rgba(255,255,255,.065);border-radius:20px}.model.equipped{border-color:rgba(52,211,153,.55);background:rgba(52,211,153,.08)}.model-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.model-name{font-weight:800;word-break:break-word}.model-meta{color:var(--muted);font-size:12px;margin-top:5px}.model-actions{display:flex;gap:8px;align-items:center;margin-top:12px}.mini{border:1px solid var(--stroke);background:rgba(255,255,255,.08);color:#fff;border-radius:999px;padding:8px 12px;font-weight:800;cursor:pointer}.mini.danger{background:rgba(251,113,133,.12)}.mini:disabled{opacity:.45;cursor:not-allowed}.badge{border-radius:999px;padding:5px 8px;font-size:11px;font-weight:900;text-transform:uppercase;background:rgba(255,255,255,.09);color:#dfe0ea}.badge.on{background:rgba(52,211,153,.16);color:#bbf7d0}
.cv-grid{display:flex!important;flex-direction:column;gap:8px;align-items:stretch}.cv-card{position:relative;display:grid;grid-template-columns:86px minmax(0,1fr);min-height:86px;overflow:hidden;padding:0;border-radius:14px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.055);box-shadow:0 6px 20px rgba(0,0,0,.18);backdrop-filter:blur(14px)}.cv-card:hover{border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.08)}.cv-thumb{position:relative;width:86px;height:86px;background:#11141a;border-right:1px solid rgba(255,255,255,.08);overflow:hidden}.cv-thumb img{width:100%;height:100%;object-fit:cover;display:block}.cv-thumb-empty{height:100%;display:grid;place-items:center;padding:8px;color:#7f8490;font-size:11px;line-height:1.15;text-align:center;background:radial-gradient(circle at 50% 0%,rgba(113,112,255,.18),transparent 60%),rgba(0,0,0,.28)}.cv-body{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title actions" "meta actions" "file actions";gap:4px 10px;padding:9px 10px;min-width:0}.cv-title-row{grid-area:title;display:flex;align-items:center;gap:8px;min-width:0}.cv-title{font-size:14px;line-height:1.18;font-weight:820;letter-spacing:-.015em;color:#f7f8f8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.cv-downloads{flex:0 0 auto;color:#c8ccda;font-size:11px;font-weight:760;white-space:nowrap}.cv-meta{grid-area:meta;display:flex;flex-wrap:nowrap;gap:5px;margin:0;min-width:0;overflow:hidden}.cv-chip{flex:0 0 auto;max-width:180px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.04);border-radius:7px;padding:3px 6px;color:#b8bdca;font-size:10.5px;font-weight:680;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cv-file{grid-area:file;color:#8f95a3;font-size:11px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.cv-stats{display:none}.cv-actions{grid-area:actions;align-self:center;display:flex;flex-direction:column;gap:6px;width:92px;margin:0;padding:0}.cv-actions .mini{border-radius:9px;text-align:center;text-decoration:none;padding:7px 8px;font-size:11.5px;line-height:1.1}.cv-actions .mini:first-child{background:#5e6ad2;border-color:#7479dd}.cv-actions .mini:first-child:hover{background:#7170ff}@media (max-width:560px){.cv-card{grid-template-columns:64px minmax(0,1fr);min-height:74px}.cv-thumb{width:64px;height:74px}.cv-body{grid-template-columns:minmax(0,1fr);grid-template-areas:"title" "meta" "file" "actions";gap:4px;padding:8px}.cv-actions{width:auto;flex-direction:row}.cv-actions .mini{flex:1}.cv-downloads{display:none}.cv-chip{max-width:130px}}
.cv-progress{grid-column:1/-1;margin-top:6px;display:none}.cv-progress.on{display:block}.cv-progress-bar{height:8px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.12)}.cv-progress-bar span{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--pink),var(--violet),var(--cyan));transition:width .25s}.cv-progress-text{margin-top:4px;color:#b8bdca;font-size:11px;font-weight:700}
@media (min-width:761px){.bottom-tabs{position:sticky;top:10px;bottom:auto;left:auto;transform:none;width:max-content;max-width:100%;display:flex;grid-template-columns:none;margin:-8px 0 20px;border-radius:999px}.bottom-tab{flex-direction:row;min-height:42px;padding:0 14px}.bottom-tab .ico{font-size:16px}}.mobile-frame{width:100%;height:78vh;border:1px solid var(--stroke);border-radius:26px;background:#000;box-shadow:var(--shadow)}
@media (max-width:900px){.hero{grid-template-columns:1fr}.composer h2{font-size:34px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.top{align-items:flex-start;flex-direction:column}}@media (max-width:560px){.wrap{width:min(100% - 18px,1180px);padding-top:14px}.composer,.live{padding:16px;border-radius:22px}.composer h2{font-size:30px}.grid{grid-template-columns:1fr}.pills{gap:6px}.pill{font-size:12px;padding:7px 9px}}
"""


def status_chip(status):
    s = util.h(status or "waiting")
    return f'<span class="status {s}"><span class="dot"></span>{s}</span>'


def render_job_page(rec):
    r = history.public_record(rec)
    status = r.get("status", "unknown")
    active = status in {"queued", "running"}
    refresh = '<meta http-equiv="refresh" content="2">' if active else ""
    urls = r.get("image_urls") or []
    img = f'<a href="{util.h(urls[0])}" target="_blank"><img src="{util.h(urls[0])}" alt="Generated image"></a>' if urls else ('<div><div class="spinner"></div><div>Rendering…</div></div>' if active else '<div>No image output.</div>')
    err = f'<div class="errorbox">{util.h(r.get("error"))}</div>' if r.get("error") else ""
    rid = util.h(r.get("id"))
    return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">{refresh}<title>Media Studio job {rid}</title><style>{CSS}</style></head><body>
<div class="wrap">
  <header class="top"><div class="brand"><div class="orb"></div><div><div class="eyebrow">Generation detail</div><h1>Media Studio</h1></div></div><a class="pill" href="/">← Back to history</a></header>
  <main class="hero">
    <section class="glass live"><div class="live-head"><h3>Job {rid}</h3>{status_chip(status)}</div><div class="preview">{img}</div><div class="jobmeta">{util.h(util.nice_time(r.get('finished_at') or r.get('created_at')))} · <code>{rid}</code></div></section>
    <section class="glass composer"><h2>{'Rendering…' if active else 'Result'}</h2><p class="sub">{util.h(r.get('prompt'))}</p>{err}</section>
  </main>
</div></body></html>'''


_LOOPBACK_ORIGIN_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _is_loopback_origin(origin):
    """Is this Origin a page served from this machine?

    Only these get a CORS header back. Anything else — including a page that
    has pointed its own DNS name at 127.0.0.1 — can still make the request, but
    cannot read the answer.
    """
    try:
        host = (urlparse(origin.strip()).hostname or "").lower()
    except ValueError:
        return False
    return host in _LOOPBACK_ORIGIN_HOSTS


class Handler(BaseHTTPRequestHandler):
    server_version = "ZImageEndpoint/1.1"

    def log_message(self, fmt, *args):
        rendered = util.redact_access_log_message(fmt % args)
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), rendered))

    def auth_cookie_header(self):
        # Query-token auth is awkward for embedded apps because Vite/React emits
        # absolute asset/API URLs without ?token=. Once a user reaches an
        # authenticated wrapper page, persist that auth to a same-origin cookie so
        # iframe assets, /mobile/api/* calls, and /comfy/* proxy calls can load.
        #
        # Kept on purpose after the gateway stopped EMITTING ?token= (2026-09-03):
        # this promotion is what the Canvas and mobile iframes still depend on,
        # and it is now the only place a token in a URL turns into anything. The
        # links and JSON this server hands out carry bare paths.
        return f"zimg_token={config.TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"

    def authed(self, query=None):
        if query and query.get("token", [None])[0] == config.TOKEN:
            self._set_auth_cookie = True
            return True
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {config.TOKEN}":
            return True
        if self.headers.get("X-Token") == config.TOKEN:
            return True
        cookie = self.headers.get("Cookie", "")
        if any(part.strip() == f"zimg_token={config.TOKEN}" for part in cookie.split(";")):
            return True
        return False

    def maybe_auth_cookie(self):
        if getattr(self, "_set_auth_cookie", False):
            self.send_header("Set-Cookie", self.auth_cookie_header())

    def cors_headers(self):
        """CORS, plus the referrer rule every response here needs.

        The wildcard origin this used to send bought nothing: 8787 listens on
        loopback and its real callers are server-to-server (the studio proxies,
        the wrapper, the MCP), which do not consult CORS at all. What it did buy
        was that any origin which ever learned the capability token could spend
        it cross-origin from a browser. Loopback origins are echoed instead —
        that is the embedded Canvas and mobile UI — with Vary so no cache hands
        one origin's answer to another, and everything else gets no CORS header
        and so cannot read the response.

        Referrer-Policy is here rather than beside each Content-Type because
        every responder below goes through this one method: the gateway's HTML
        pages link out, and without it the Referer carried this origin (and,
        until this change, a token in the query string) to wherever the owner
        clicked.
        """
        origin = (self.headers.get("Origin") or "").strip()
        if origin and _is_loopback_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Token")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors_headers()
        self.end_headers()

    def send_json(self, data, status=200):
        # Handing a caller a NEW job id (202 Accepted) is the one moment we know
        # both the job and who asked for it, for every generate route at once —
        # so that is where an agent registers as a second seal recipient. A 202
        # is always returned before the job finishes, so registration lands well
        # ahead of output sealing. No-op unless ZIMG_AGENT_DUAL_SEAL=1 and the
        # request presented X-E2E-Requester-Pub.
        if status == 202 and isinstance(data, dict) and data.get("id"):
            try:
                media.register_agent_seal_recipient(data["id"], self.headers.get(promptroutes.REQUESTER_PUB_HEADER))
            except Exception as exc:
                print(f"[agent-seal] register failed: {exc}", file=sys.stderr)
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.maybe_auth_cookie()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text, status=200, ctype="text/html; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.maybe_auth_cookie()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, max_bytes=None):
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n > (max_bytes or config.MAX_JSON_BODY_BYTES):
            raise ValueError("request body too large")
        return self.rfile.read(n) if n else b""

    def stream_body_to_file(self, destination, max_bytes):
        """Write a raw request body to disk a block at a time.

        The whole point is that no copy of the clip exists in memory: this is
        how a two-gigabyte restore source gets here at all. It lands on a
        `.part` file and is renamed only once the declared length has arrived,
        so a dropped connection leaves nothing another request could mistake
        for a complete upload. Returns the byte count written.
        """
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            raise ValueError("that upload arrived with no body")
        if length > max_bytes:
            raise restore.RestoreTooLarge(length, max_bytes)
        destination.parent.mkdir(parents=True, exist_ok=True)
        part = destination.with_name(destination.name + ".part")
        written = 0
        try:
            with part.open("wb") as handle:
                while written < length:
                    block = self.rfile.read(min(restore.RESTORE_UPLOAD_BLOCK_BYTES, length - written))
                    if not block:
                        break
                    handle.write(block)
                    written += len(block)
            if written != length:
                raise ValueError("that upload stopped part way — try it again")
            part.replace(destination)
        finally:
            part.unlink(missing_ok=True)
        return written

    def proxy_to_frontend(self, parsed):
        target_path = parsed.path
        if target_path in {"/models", "/history", "/workbench"}:
            target_path = "/"
        query = parsed.query
        url = config.FRONTEND_HTTP + target_path + (("?" + query) if query else "")
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "content-length", "authorization", "x-token", "connection", "accept-encoding"}}
        try:
            req = Request(url, method="GET", headers=headers)
            with net.urlopen(req, timeout=30) as r:
                data = r.read()
                ctype = r.headers.get("Content-Type", mimetypes.guess_type(target_path)[0] or "application/octet-stream")
                self.send_response(r.status)
                self.send_header("Content-Type", ctype)
                if "Cache-Control" in r.headers:
                    self.send_header("Cache-Control", r.headers["Cache-Control"])
                else:
                    self.send_header("Cache-Control", "no-store, max-age=0")
                self.maybe_auth_cookie()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_text(f"Next.js frontend proxy error: {e}\n", 502, "text/plain")

    def comfy_target(self, parsed):
        target_path = parsed.path
        if target_path.startswith("/comfy"):
            target_path = target_path[len("/comfy"):] or "/"
        qs = parse_qs(parsed.query, keep_blank_values=True)
        qs.pop("token", None)
        query = urlencode(qs, doseq=True)
        return target_path, query

    def proxy_to_comfy(self, parsed, method="GET"):
        target_path, query = self.comfy_target(parsed)
        body = self.read_body() if method not in ("GET", "HEAD") else None
        upstream_base = config.COMFY_HTTP_DEFAULT
        lane_name = "default"
        submit_route_meta = None
        if method == "POST" and target_path in {"/api/prompt", "/prompt"} and body:
            try:
                lane_name = _lanes.comfy_lane_for_prompt_body(body, run_on=_lanes._run_on_from_comfy_prompt_body(body))
            except _lanes.ComfyLanePinError as exc:
                # Operational, like a dead tunnel: names the machine, carries no
                # prompt content, and so survives machine-private redaction.
                return self.send_json({"error": str(exc), "operational": True}, 409)
            upstream_base = _lanes.COMFY_LANES.get(lane_name, config.COMFY_HTTP_DEFAULT)
        if method in ("GET", "HEAD"):
            history_match = re.match(r"^/(?:api/)?history/([^/?]+)$", target_path)
            if history_match:
                pid = unquote(history_match.group(1))
                route = promptroutes.comfy_prompt_route(pid)
                if route:
                    # Scope status to the requester that owns this prompt.
                    if not promptroutes.requester_may_read_prompt(route, self.headers.get(promptroutes.REQUESTER_PUB_HEADER)):
                        return self.send_json({}, 404)
                    if route.get("remote"):
                        # Remote prompts are answered from the gateway's route
                        # record in every phase: the lane's live history must
                        # not stream through this proxy, and after harvest the
                        # lane entry is scrubbed anyway.
                        return self.send_json(promptroutes.synthetic_comfy_history_for_route(pid, route))
                    lane_name = route.get("lane") or "default"
                    upstream_base = _lanes.COMFY_LANES.get(lane_name, config.COMFY_HTTP_DEFAULT)
        url = upstream_base + target_path + (("?" + query) if query else "")
        if method == "POST" and target_path in {"/api/prompt", "/prompt"} and body:
            _loras.record_mobile_prompt_lora_trace(body)
            native_ltx = graphs.detect_native_mlx_ltx_prompt(body)
            if native_ltx:
                try:
                    studio_lane = graphs._studio_lane_from_comfy_prompt_body(body)
                    if studio_lane:
                        native_ltx['options'] = {
                            **dict(native_ltx.get('options') or {}),
                            'studio_lane': studio_lane,
                        }
                    workflow = graphs._mobile_prompt_workflow_from_body(body)
                    job_id = native_mlx.queue_native_mlx_ltx_job(native_ltx, workflow)
                    return self.send_json({
                        "prompt_id": job_id,
                        "number": 0,
                        "node_errors": {},
                        "native_mlx": True,
                        "native_video": True,
                        "backend": graphs._ltx_mlx_backend_name(config.LTX2_MLX_VARIANTS.get(native_ltx.get('variant')) or {}, native_ltx.get('variant')),
                        "status": "queued",
                    }, 200)
                except Exception as e:
                    return self.send_json({"error": f"native LTX route failed before Comfy fallback: {e}"}, 500)
            native = graphs.detect_native_mlx_biglove_prompt(body)
            if native:
                try:
                    studio_lane = graphs._studio_lane_from_comfy_prompt_body(body)
                    if studio_lane:
                        native['options'] = {
                            **dict(native.get('options') or {}),
                            'studio_lane': studio_lane,
                        }
                    workflow = graphs._mobile_prompt_workflow_from_body(body)
                    job_id = native_mlx.queue_native_mlx_biglove_job(native['prompt'], native['image_path'], native.get('options') or {}, workflow)
                    return self.send_json({
                        "prompt_id": job_id,
                        "number": 0,
                        "node_errors": {},
                        "native_mlx": True,
                        "backend": "mlx-mxfp8-bigloves-klein3-edit",
                        "status": "queued",
                    }, 200)
                except Exception as e:
                    return self.send_json({"error": f"native BigLove route failed before Comfy fallback: {e}"}, 500)
            body = graphs.exact_comfy_biglove_prompt_body(body)
            body = graphs.exact_comfy_krea2_turbo_pre_lora_prompt_body(body)
            requester_spki = promptroutes.normalized_requester_spki(self.headers.get(promptroutes.REQUESTER_PUB_HEADER))
            pushed_inputs = []
            if _lanes.comfy_lane_is_remote(lane_name):
                transport_error = _lanes.comfy_lane_transport_error(lane_name)
                if transport_error:
                    return self.send_json({"error": transport_error, "operational": True}, 502)
                if not (requester_spki or media.vault_public_key_spki()):
                    return self.send_json({
                        "error": "remote lane requires a sealing key: present "
                                 f"{promptroutes.REQUESTER_PUB_HEADER} with the job or create the owner vault",
                    }, 409)
                # Only once the lane is both permitted AND sealable: ask whether
                # it is still there, before staging anything on it. Staging into
                # a dead tunnel hangs for minutes and then surfaces as an
                # unexplained timeout. This costs one round trip and names the
                # real problem while it is still actionable. It stays BELOW the
                # sealing-key refusal so a lane we may not use is never touched.
                liveness_error = _lanes.comfy_lane_liveness_error(lane_name)
                if liveness_error:
                    return self.send_json({"error": liveness_error, "operational": True}, 502)
                try:
                    pushed_inputs = promptroutes.push_prompt_inputs_to_lane(body, lane_name)
                except Exception as e:
                    # Also operational: a staging failure is the transport
                    # giving out mid-upload, which the liveness probe above
                    # cannot predict — a small GET succeeds on a path that
                    # still cannot carry a multi-megabyte reference.
                    return self.send_json({
                        "error": f"could not stage inputs on remote lane '{lane_name}': {e}",
                        "operational": True,
                    }, 502)
            else:
                # The local half of the same courtesy. ComfyUI is optional now,
                # so a machine with none is an ordinary machine — and a submit
                # against a lane nobody is running used to surface as a raw
                # connection refused from urlopen() several frames down. One
                # cached probe (5s TTL) turns it into the sentence with the
                # button: connect a ComfyUI, or run this in the cloud.
                liveness_error = _lanes.comfy_lane_liveness_error(lane_name)
                if liveness_error:
                    return self.send_json({"error": liveness_error, "operational": True}, 502)
            # What the MCP priced this graph at, and the card it is about to run
            # on: the pair that turns an OOM (or a clean finish) into a fact
            # about this card size rather than an anecdote.
            priced_rows = _lanes._packed_rows_from_comfy_prompt_body(body)
            card_vram_gb = None
            if priced_rows:
                try:
                    card_vram_gb = _lanes._comfy_lane_system_probe(lane_name)[1]
                except Exception:
                    card_vram_gb = None
            submit_route_meta = {
                "lane": lane_name,
                "requester_spki": requester_spki,
                "pushed_inputs": pushed_inputs,
                "packed_rows": priced_rows,
                "card_vram_gb": card_vram_gb,
                # Staging a reference job's inputs (above) runs inside this
                # request and can outlast the caller's timeout. Keeping the
                # submitter's own client_id is what lets it find the job again
                # instead of leaving it queued with nobody holding its id.
                "client_id": graphs._prompt_body_client_id(body),
            }
        # ComfyUI's aiohttp server rejects cross-origin-looking browser requests
        # (403) when forwarded with the wrapper's Origin/Referer. Strip browser
        # origin metadata so this remains a same-machine server-to-server proxy.
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "content-length", "authorization", "x-token", "connection", "origin", "referer", promptroutes.REQUESTER_PUB_HEADER.lower()}}
        lane_auth = _lanes.comfy_lane_token(lane_name)
        if lane_auth:
            headers["Authorization"] = f"Bearer {lane_auth}"
        try:
            req = Request(url, data=body, method=method, headers=headers)
            with net.urlopen(req, timeout=60) as r:
                data = r.read()
                if submit_route_meta is not None and r.status < 400:
                    try:
                        submitted_pid = str(json.loads(data.decode("utf-8")).get("prompt_id") or "")
                    except Exception:
                        submitted_pid = ""
                    if submitted_pid:
                        promptroutes.record_comfy_prompt_route(
                            submitted_pid, submit_route_meta["lane"],
                            requester_spki=submit_route_meta["requester_spki"],
                            pushed_inputs=submit_route_meta["pushed_inputs"],
                            client_id=submit_route_meta["client_id"],
                        )
                        if submit_route_meta.get("packed_rows"):
                            promptroutes.update_comfy_prompt_route(
                                submitted_pid,
                                packed_rows=submit_route_meta["packed_rows"],
                                card_vram_gb=submit_route_meta["card_vram_gb"],
                            )
                        if _lanes.comfy_lane_is_remote(submit_route_meta["lane"]):
                            threading.Thread(target=promptroutes.watch_remote_comfy_prompt, args=(submitted_pid,), daemon=True).start()
                ctype = r.headers.get("Content-Type", mimetypes.guess_type(target_path)[0] or "application/octet-stream")
                if ("text/html" in ctype or "javascript" in ctype) and data:
                    text = data.decode("utf-8", errors="replace")
                    text = text.replace('"/api/', '"/comfy/api/').replace("'/api/", "'/comfy/api/").replace('`/api/', '`/comfy/api/')
                    text = text.replace('"/system_stats', '"/comfy/system_stats').replace("'/system_stats", "'/comfy/system_stats").replace('`/system_stats', '`/comfy/system_stats')
                    text = text.replace('"/view?', '"/comfy/view?').replace("'/view?", "'/comfy/view?").replace('`/view?', '`/comfy/view?')
                    text = text.replace('"/upload/', '"/comfy/upload/').replace("'/upload/", "'/comfy/upload/").replace('`/upload/', '`/comfy/upload/')
                    # Vite's production HTML adds bare `crossorigin` to module/CSS
                    # assets. In Chromium that makes requests omit credentials, so
                    # token-cookie auth is not sent and the module quietly fails,
                    # leaving the iframe as a blank black rectangle.
                    if "text/html" in ctype:
                        text = text.replace(" crossorigin", "")
                    data = text.encode("utf-8")
                self.send_response(r.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.maybe_auth_cookie()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_text(f"Comfy proxy error: {e}\n", 502, "text/plain")

    def proxy_websocket_to_comfy(self, parsed):
        target_path, query = self.comfy_target(parsed)
        # Progress websockets can follow a prompt to its lane: ?lane=<name>
        # (stripped before forwarding). Unknown lanes fall back to default.
        ws_qs = parse_qs(query, keep_blank_values=True)
        lane_values = ws_qs.pop("lane", [])
        lane_name = (lane_values[0].strip().lower() if lane_values else "") or "default"
        if lane_name not in _lanes.COMFY_LANES:
            lane_name = "default"
        query = urlencode(ws_qs, doseq=True)
        upstream = urlparse(_lanes.COMFY_LANES.get(lane_name, config.COMFY_HTTP_DEFAULT))
        host = upstream.hostname or "127.0.0.1"
        port = upstream.port or (443 if upstream.scheme == "https" else 80)
        if upstream.scheme == "https":
            # Graceful degrade: no live progress tunnel for TLS lanes - the
            # client's history polling still observes completion.
            return self.send_text("WebSocket proxy supports http lanes only; poll history for progress on this lane\n", 502, "text/plain")
        path = target_path + (("?" + query) if query else "")
        try:
            sock = socket.create_connection((host, port), timeout=10)
            lines = [f"GET {path} HTTP/1.1", f"Host: {host}:{port}"]
            lane_auth = _lanes.comfy_lane_token(lane_name)
            if lane_auth:
                lines.append(f"Authorization: Bearer {lane_auth}")
            skip = {"host", "origin", "referer", "authorization", "x-token", "cookie", "connection"}
            for k, v in self.headers.items():
                kl = k.lower()
                if kl in skip:
                    continue
                lines.append(f"{k}: {v}")
            lines.extend(["Connection: Upgrade", "", ""])
            sock.sendall("\r\n".join(lines).encode("utf-8"))

            # Relay the upstream handshake, then tunnel WebSocket frames both ways.
            self.close_connection = True
            handshake = b""
            while b"\r\n\r\n" not in handshake:
                data = sock.recv(4096)
                if not data:
                    sock.close()
                    return
                self.connection.sendall(data)
                handshake += data
            # Two blocking pump threads. The previous non-blocking select loop called
            # sendall() on non-blocking sockets: whenever the tailnet client couldn't
            # drain Comfy's binary latent-preview frames fast enough, sendall raised
            # BlockingIOError mid-frame (or wrote a partial frame, desyncing the
            # WebSocket stream) and the tunnel died mid-generation - clients then
            # missed the 'executed' event and image delivery fell back to slow
            # history polling. Blocking sockets make sendall apply backpressure
            # instead of dying. Timeouts are cleared so an idle-but-healthy tunnel
            # does not inherit create_connection's 10s recv timeout.
            self.connection.setblocking(True)
            self.connection.settimeout(None)
            sock.setblocking(True)
            sock.settimeout(None)

            def pump(src, dst):
                try:
                    while True:
                        chunk = src.recv(65536)
                        if not chunk:
                            break
                        dst.sendall(chunk)
                except Exception:
                    pass
                finally:
                    for s in (src, dst):
                        try:
                            s.shutdown(socket.SHUT_RDWR)
                        except Exception:
                            pass

            downstream = threading.Thread(target=pump, args=(self.connection, sock), daemon=True)
            downstream.start()
            pump(sock, self.connection)
            downstream.join(timeout=5)
            sock.close()
            return
        except Exception as e:
            try:
                sock.close()
            except Exception:
                pass
            return self.send_text(f"Comfy WebSocket proxy error: {e}\n", 502, "text/plain")

    def find_job(self, jid):
        with jobs.jobs_lock:
            rec = jobs.jobs.get(jid)
        if rec:
            return rec
        for r in history.load_history(500):
            if r.get("id") == jid:
                return r
        return None

    def do_GET(self):
        return self.dispatch("GET")

    def do_POST(self):
        return self.dispatch("POST")

    def do_DELETE(self):
        return self.dispatch("DELETE")

    def dispatch(self, method):
        """The route table decides what runs. Nothing else does.

        Order is the contract: the table is matched top down, exactly as the
        if-chain this replaced was read, so a broad prefix still cannot take a
        path an exact route above it claims.
        """
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        index, route = routes.match(method, parsed.path)
        if route is not None and not route.auth:
            return getattr(self, route.handler)(parsed, qs)
        if not self.authed(qs):
            return routes.unauthorized(self, method)
        if routes.REFRESHES_LANES[method]:
            # One stat() per request; picks up an attach/detach without a restart.
            _lanes.refresh_comfy_lanes()
        while route is not None:
            answer = getattr(self, route.handler)(parsed, qs)
            if answer is not routes.NEXT:
                return answer
            index, route = routes.match(method, parsed.path, start=index + 1)
        return routes.not_found(self, method)

    def get_health(self, parsed, qs):
        # `ok` is about THIS process; the lanes are reported separately.
        # /health used to say ok:true while every ComfyUI was down, so the
        # supervisor, the MCP status tool and the studio's catalog all
        # believed the engine was there and the user found out on the first
        # 502 — after composing a prompt. The lane URLs stay behind the
        # token: an unauthenticated caller learns that a lane is degraded,
        # not where a rented machine lives.
        #
        # And not where anything else lives either. `comfy` is a filesystem
        # path with the account name in it, and the version, the build flag and
        # the accelerator answers fingerprint the machine — none of which is
        # liveness. The project's own norm for an unauthenticated health answer
        # is written down in lib/canvas-gate.js: liveness "and nothing else —
        # no lane list, no version, no paths". The lane liveness IS the
        # exception here, argued above and pinned by test_route_gates.py;
        # everything else moves behind the token, where the lane URLs already
        # are. Nothing in this repository read these fields unauthenticated.
        _lanes.refresh_comfy_lanes()
        authed = self.authed(qs)
        lanes = {
            lane: {**({"url": _lanes.COMFY_LANES.get(lane) or ""} if authed else {}), **health}
            for lane, health in _lanes.comfy_lane_health_snapshot().items()
        }
        machine = {
            "version": config.GATEWAY_VERSION,
            "comfy": str(config.COMFY),
            "runner": config.RUNNER.exists(),
            "ui": "v2",
            "accelerator_profile": config.accelerator_profile(),
            "native_mlx_ltx": config.supports_native_mlx_ltx_route(),
        } if authed else {}
        return self.send_json({
            "ok": True,
            **machine,
            "lanes": lanes,
            "degraded": [lane for lane, state in lanes.items() if not state.get("alive")],
        })

    def get_workflow_key(self, parsed, qs):
        # Deprecated: old builds exposed a backend-derived workflow metadata
        # key. ComfyUI Mobile now uses a user-only browser unlock key kept
        # only in loaded-tab memory, so the backend must not return a
        # decrypt key.
        return self.send_json({"error": "workflow key endpoint disabled; unlock in the browser"}, status=410)

    def get_api_e2e_vault_identity(self, parsed, qs):
        identity = media.vault_identity_json()
        return self.send_json({"ok": True, "exists": identity is not None, "identity": identity})

    def get_workflow_for_output(self, parsed, qs):
        name = util.safe_name(qs.get('filename', [''])[0])
        envelope = workflow_index.workflow_envelope_for_filename(name) if name else None
        if envelope:
            return self.send_json({"workflow": envelope})
        return self.send_json({"error": "no workflow recorded for this output"}, 404)

    def get_ws(self, parsed, qs):
        return self.proxy_websocket_to_comfy(parsed)

    def get_frontend(self, parsed, qs):
        return self.proxy_to_frontend(parsed)

    def get_api_models(self, parsed, qs):
        models = _models.scan_models()
        return self.send_json({"models": models, "bundles": _models.model_bundles(models), "equipped": _models.load_equipped(), "ram": _models.ram_info(), "civitaiInstalled": _models.scan_civitai_downloads()})

    def get_api_library(self, parsed, qs):
        return self.send_json(_models.scan_library())

    def get_api_model_preview(self, parsed, qs):
        target = qs.get('path', [''])[0]
        p = Path(target).resolve()
        allowed = [config.COMFY.resolve(), config.BASE.resolve(), config.OUT_DIR.resolve()]
        if not any(str(p).startswith(str(a)) for a in allowed) or not p.exists() or not p.is_file():
            return self.send_text("not found\n", 404, "text/plain")
        ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        data = p.read_bytes()
        self.send_response(200)
        self.cors_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        return

    def get_api_loras_preview(self, parsed, qs):
        lora_id = qs.get('id', [''])[0]
        item = next((value for value in _models.local_loras_unfiltered() if value.get('id') == lora_id), None)
        if not item:
            return self.send_text("not found\n", 404, "text/plain")
        source = _models.lora_preview_source(item['path'], item.get('metadata') or {})
        if not source:
            return self.send_text("not found\n", 404, "text/plain")
        try:
            if source.startswith(('http://', 'https://')):
                # Civitai-hosted card art: fetched once, then served from the
                # encrypted cache until this LoRA file changes or goes away.
                cached = _loras.cached_lora_preview(item, source)
                if cached:
                    data, ctype = cached
                else:
                    preview_request = Request(source, headers={'User-Agent': 'HivemindContentStudio/1.0'})
                    with net.urlopen(preview_request, timeout=30) as upstream:
                        data = upstream.read()
                        ctype = upstream.headers.get('Content-Type', 'image/jpeg').split(';', 1)[0]
                    _loras.cache_lora_preview(item, source, data, ctype)
            else:
                preview_path = Path(source).resolve()
                lora_root = (config.COMFY / 'models' / 'loras').resolve()
                if not preview_path.exists() or not preview_path.is_file() or not util._is_under(preview_path, lora_root):
                    return self.send_text("not found\n", 404, "text/plain")
                data = preview_path.read_bytes()
                ctype = mimetypes.guess_type(str(preview_path))[0] or 'application/octet-stream'
            self.send_response(200)
            self.cors_headers()
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "private, max-age=3600")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception:
            return self.send_text("not found\n", 404, "text/plain")

    def get_api_loras(self, parsed, qs):
        requested_bases = []
        for raw in qs.get('baseModels', []):
            requested_bases.extend(value.strip() for value in raw.split(',') if value.strip())
        if qs.get('compact', [''])[0].lower() in {'1', 'true', 'yes'}:
            base_models = requested_bases or _models.current_base_models()
            return self.send_json({"baseModels": base_models, "loras": _models.local_lora_catalog(base_models)})
        return self.send_json({"baseModels": _models.current_base_models(), "loras": _models.local_loras(), "selected": _models.load_selected_loras()})

    def get_api_civitai_lora_updates(self, parsed, qs):
        requested_bases = []
        for raw in qs.get('baseModels', []):
            requested_bases.extend(value.strip() for value in raw.split(',') if value.strip())
        force = qs.get('refresh', [''])[0] in {'1', 'true', 'yes'}
        try:
            updates = _models.civitai_lora_updates(requested_bases or _models.current_base_models(), force=force)
            return self.send_json({"updates": updates})
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)

    def get_api_civitai_base_models(self, parsed, qs):
        force = qs.get('refresh', [''])[0] in {'1', 'true', 'yes'}
        return self.send_json({"baseModels": _models.civitai_base_model_options(force=force), "currentBaseModels": _models.current_base_models()})

    def get_api_civitai_images(self, parsed, qs):
        params = {k: qs.get(k, [None])[0] for k in ['username', 'sort', 'period', 'cursor', 'limit', 'postId', 'modelId', 'modelVersionId']}
        # Civitai's own vocabulary, echoed back rather than trusted: an
        # unknown `type` is dropped instead of forwarded, so a stray value
        # cannot turn into a 400 the finder has to explain.
        kind = qs.get('type', [None])[0]
        if kind in {'image', 'video'}:
            params['type'] = kind
        nsfw = qs.get('nsfw', [None])[0]
        if nsfw in {'true', 'false', 'None', 'Soft', 'Mature', 'X'}:
            params['nsfw'] = nsfw
        bases = qs.get('baseModels', [])
        if bases:
            params['baseModels'] = ','.join(bases)
        if not params.get('limit'):
            params['limit'] = '24'
        try:
            data = _models.civitai_search_images(params)
            return self.send_json({
                "items": [_models.summarize_civitai_image(i) for i in data.get('items', [])],
                "metadata": data.get('metadata', {}),
                "baseModelOptions": _models.civitai_base_model_options(),
            })
        except Exception as e:
            # Civitai 503s under load often enough to matter (seen on a
            # plain baseModels query, fine on retry), so the finder gets the
            # reason and offers a retry rather than an empty grid.
            return self.send_json({"error": str(e)}, 502)

    def get_api_civitai_search(self, parsed, qs):
        params = {k: qs.get(k, [None])[0] for k in ['query','tag','username','sort','period','supportsGeneration','fromPlatform','earlyAccess','primaryFileOnly','cursor','page','limit']}
        nsfw = qs.get('nsfw', [None])[0]
        if nsfw in {'true', 'false'}:
            params['nsfw'] = nsfw
        checkpoint_type = qs.get('checkpointType', [None])[0]
        if checkpoint_type in {'Trained', 'Merge'}:
            params['checkpointType'] = checkpoint_type
        for multi in ['types','baseModels']:
            vals = qs.get(multi, [])
            if vals:
                params[multi] = ','.join(vals)
        if not params.get('limit'):
            params['limit'] = '24'
        try:
            data = _models.civitai_search_models(params)
            return self.send_json({"items": [_models.summarize_civitai_item(i) for i in data.get('items', [])], "metadata": data.get('metadata', {}), "baseModels": _models.current_base_models(), "baseModelOptions": _models.civitai_base_model_options(), "installed": _models.scan_civitai_downloads()})
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)

    def get_api_civitai_download(self, parsed, qs):
        jid = parsed.path.rsplit("/", 1)[-1]
        with history.download_jobs_lock:
            rec = history.download_jobs.get(jid)
        return self.send_json(_models.public_download_job(rec) if rec else {"error": "not found"}, 200 if rec else 404)

    def get_api_comfy_prompt_by_client(self, parsed, qs):
        # Hand a submitter back the prompt id it never received. Staging a
        # reference job's inputs on a remote lane happens inside the submit
        # request, so a caller can time out while the job goes on to queue,
        # run and be harvested with nobody holding its id. Scoped the same
        # way history is: the requester key that submitted it may read it.
        client_id = unquote(parsed.path.rsplit("/", 1)[-1])
        prompt_id, route = promptroutes.comfy_prompt_id_for_client(client_id)
        if not prompt_id:
            return self.send_json({"error": "no prompt recorded for this client id"}, 404)
        if not promptroutes.requester_may_read_prompt(route, self.headers.get(promptroutes.REQUESTER_PUB_HEADER)):
            return self.send_json({"error": "not found"}, 404)
        return self.send_json({
            "prompt_id": prompt_id,
            "lane": route.get("lane"),
            "remote": bool(route.get("remote")),
            "status": route.get("status"),
            "created_at": route.get("created_at"),
        })

    def get_comfy_view(self, parsed, qs):
        name = util.safe_name(qs.get('filename', [''])[0])
        p = media.find_output_logical_path(name)
        if p:
            try:
                media.send_output_file(self, p)
                return
            except Exception as e:
                print(f"[output-encryption] failed to serve {name}: {e}", file=sys.stderr)
                return self.send_text("not found\n", 404, "text/plain")
        # If this is not one of our native/private outputs, let ComfyUI answer normally.
        # Not one of our own outputs: hand the path to the /comfy/ route
        # below, which proxies it to ComfyUI.
        return routes.NEXT

    def get_output(self, parsed, qs):
        p = media.find_exact_output_logical_path(qs.get('path', [''])[0])
        if not p:
            return self.send_text("not found\n", 404, "text/plain")
        try:
            media.send_output_file(self, p)
        except Exception as e:
            print(f"[output-encryption] failed to serve exact output: {e}", file=sys.stderr)
            return self.send_text("not found\n", 404, "text/plain")
        return

    def get_mobile_app(self, parsed, qs):
        return self.proxy_to_comfy(parsed, "GET")

    def get_api_restore_projects(self, parsed, qs):
        return self.send_json({
            "ok": True,
            "projects": restore.restore_projects_summary(int(qs.get("limit", ["50"])[0] or 50)),
        })

    def get_api_restore_capabilities(self, parsed, qs):
        # Which machines can restore, and which of them costs money. The
        # studio needs both to offer "free, on this Mac" and "paid, on the
        # rented box" as the same button with a different price.
        lanes = []
        for lane_name, lane_url in sorted(_lanes.COMFY_LANES.items()):
            capability = restore.lane_restore_capability(lane_url)
            remote = _lanes.comfy_lane_is_remote(lane_name)
            lanes.append({
                "lane": lane_name,
                "remote": remote,
                # A rented machine bills by the hour whether it is restoring
                # or idle, so a restore on one is the paid rail by
                # definition; a local lane is the free one.
                "paid": remote,
                "available": capability.get("available"),
                "missing": capability.get("missing") or [],
                "models": capability.get("models") or [],
                "devices": capability.get("devices") or [],
                "attention_modes": capability.get("attention_modes") or [],
                # Only a local lane can be assembled by the gateway; a
                # rented one is joined in the browser, which the studio has
                # to know before it starts rather than after.
                "assembles_here": not remote,
            })
        # And the machine nobody owns. Listed last on purpose: it is the
        # paid one, and a paid lane above a free one that can do the job is
        # a bill somebody did not choose.
        hosted = config.cloud_restore.status()
        lanes.append({
            "lane": config.video_restore.CLOUD_LANE,
            "remote": True,
            "paid": True,
            # The one that changes what the panel says about money: an
            # hourly lane is metered by the box, this one is metered by the
            # render and quoted before it starts.
            "metered": "per-render",
            "available": bool(hosted.get("available")),
            "missing": [] if hosted.get("available") else ["hosted service"],
            "reason": hosted.get("reason") or "",
            "models": list(config.video_restore.CLOUD_MODELS),
            "devices": [],
            "attention_modes": ["sdpa"],
            # It CAN be assembled here: a hosted chunk comes back as
            # ordinary bytes, unlike a rented one. That is why this lane
            # keeps seam dissolves and re-finishing, and the panel says so.
            "assembles_here": True,
        })
        return self.send_json({
            "ok": True,
            "lanes": lanes,
            "models": list(config.video_restore.DIT_MODELS),
            "color_corrections": list(config.video_restore.COLOR_CORRECTIONS),
            "resolutions": config.video_restore.RESOLUTION_PRESETS,
            "any": any(lane["available"] for lane in lanes),
            # The two facts the studio cannot work out for itself and has to
            # state BEFORE the wait: how big a source this machine takes,
            # and how long its working files are kept. Both are configured
            # here and were, until now, announced only in the service log.
            "retention": restore.restore_retention(),
            "max_source_bytes": restore.RESTORE_MAX_SOURCE_BYTES,
        })

    def get_api_restore_project(self, parsed, qs):
        project_id = util.safe_name(parsed.path.rsplit("/", 1)[-1])
        try:
            manifest = restore.restore_manifest_path(project_id)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        if not manifest.is_file():
            return self.send_json({"error": "no such restoration project"}, 404)
        project = config.video_restore.read_project(manifest)
        return self.send_json({
            "ok": True,
            "project": project,
            "progress": config.video_restore.project_progress(project),
            "resume_from": config.video_restore.first_unfinished_chunk(project),
            "assembly": config.video_restore.assembly_steps(project.get("plan") or {}),
        })

    def get_api_restore_source(self, parsed, qs):
        # The original, for the compare view when a project is REOPENED and
        # the browser no longer holds the file the owner first picked.
        # Whole-body, no ranges: every other clip in this app reaches the
        # page as a blob too, and adding a second serving convention for one
        # route would be the one place seeking silently behaves differently.
        project_id = util.safe_name(parsed.path.rsplit("/", 1)[-1])
        try:
            source = restore.restore_project_dir(project_id) / "source.mp4"
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        if not source.is_file():
            return self.send_json({"error": "this project has no staged source"}, 404)
        body = source.read_bytes()
        self.send_response(200)
        self.cors_headers()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Cache-Control", "private, no-store, max-age=0")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return self.wfile.write(body)

    def get_api_history(self, parsed, qs):
        return self.send_json({"history": [history.public_record(r) for r in jobs.all_records(200)]})

    def get_api_job(self, parsed, qs):
        jid = parsed.path.rsplit("/", 1)[-1]
        rec = self.find_job(jid)
        if rec:
            return self.send_json(history.public_record(rec), 200)
        # A prompt routed to a remote lane has no local wrapper job, so this
        # used to 404 for its whole life - which is exactly how a finished
        # remote generation left the studio spinning: the trusted
        # server-side channel had no record to report completion (or
        # progress) from. Serve the route record in job shape instead.
        routed = promptroutes.remote_comfy_job_record(jid)
        return self.send_json(routed or {"error": "not found"}, 200 if routed else 404)

    def get_job(self, parsed, qs):
        jid = parsed.path.rsplit("/", 1)[-1]
        rec = self.find_job(jid)
        if not rec:
            return self.send_text("job not found\n", 404, "text/plain")
        return self.send_text(render_job_page(rec))

    def get_image(self, parsed, qs):
        name = util.safe_name(parsed.path.rsplit("/", 1)[-1])
        p = media.find_output_logical_path(name)
        if not p:
            return self.send_text("not found\n", 404, "text/plain")
        try:
            media.send_output_file(self, p)
        except Exception as e:
            print(f"[output-encryption] failed to serve {name}: {e}", file=sys.stderr)
            return self.send_text("not found\n", 404, "text/plain")
        return

    def post_job_cancel(self, parsed, qs):
        jid = parsed.path[len("/api/job/"):-len("/cancel")].strip("/")
        return self.send_json(jobs.cancel_generation_job(jid))

    def post_api_cancel(self, parsed, qs):
        return self.send_json(jobs.cancel_generation_job(parsed.path.rsplit("/", 1)[-1]))

    def post_api_delete_output(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            if data.get("confirm") is not True:
                return self.send_json({"error": "permanent deletion requires confirm=true"}, 400)
            result = jobs.delete_output_everywhere(str(data.get("filename") or ""))
            return self.send_json(result)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except RuntimeError as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_lanes_resolve(self, parsed, qs):
        # Which lane a graph would route to, and what that lane's ComfyUI
        # was launched with. The MCP's motion-reference guard asks this
        # before pricing a reference job: its budget was measured with
        # --vram-headroom, and a lane without the flag is held to the
        # registry's smaller ceiling (comfy_lane_vram_headroom). Answered
        # here, not in the MCP, because only the gateway knows the lanes —
        # the same first-match rules that will route the submission.
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, 400)
        graph = data.get("graph") if isinstance(data, dict) else None
        if not isinstance(graph, dict):
            return self.send_json({"error": "graph (a ComfyUI API prompt graph) is required"}, 400)
        try:
            lane = _lanes.comfy_lane_for_prompt_body(
                json.dumps({"prompt": graph}).encode("utf-8"), run_on=data.get("run_on"),
            )
        except _lanes.ComfyLanePinError as exc:
            return self.send_json({"error": str(exc), "operational": True}, 409)
        return self.send_json({"ok": True, **_lanes.comfy_lane_vram_headroom(lane)})

    def post_api_delete_input(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            return self.send_json({"ok": True, "deleted": media.delete_private_input(data.get("filename"))})
        except (json.JSONDecodeError, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def post_api_interpolate(self, parsed, qs):
        try:
            data = json.loads((self.read_body(max_bytes=runners.INTERPOLATE_MAX_BODY_BYTES) or b"{}").decode("utf-8"))
            staged = runners.stage_inline_video_base64(data.get("video_base64"))
            if staged is None:
                return self.send_json({"error": "video_base64 is required"}, 400)
            factor = 4 if str(data.get("factor")) == "4" else 2
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "rife-interpolation", "mode": f"{factor}x", "options": {"factor": factor}}
            t = threading.Thread(target=runners.run_video_interpolation, args=(job_id, staged, {"factor": factor}), daemon=True)
            t.start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "rife-interpolation",
                "mode": f"{factor}x",
                "job_url": f"/api/job/{job_id}",
                "page_url": f"/job/{job_id}",
                "history_url": "/api/history",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_smart_mask(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            staged = media.stage_inline_image_base64(data.get("image_base64"))
            if staged is None:
                return self.send_json({"error": "image_base64 is required"}, 400)
            options = {
                "prompt": str(data.get("prompt") or "")[:400],
                "points": data.get("points"),
                "confidence": data.get("confidence"),
            }
            if not options["prompt"].strip() and not options["points"]:
                return self.send_json({"error": "describe an object or tap the image"}, 400)
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "sam3-smart-mask"}
            threading.Thread(
                target=runners.run_sam3_smart_mask, args=(job_id, staged, options), daemon=True,
            ).start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "sam3-smart-mask",
                "job_url": f"/api/job/{job_id}",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_ltx_director(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            project = data.get("project")
            if not isinstance(project, dict):
                return self.send_json({"error": "project is required"}, 400)
            options = {
                "width": data.get("width"),
                "height": data.get("height"),
                "seed": data.get("seed"),
                "loras": data.get("loras"),
            }
            options = {k: v for k, v in options.items() if v is not None}
            # Validate before queueing so a malformed timeline answers the
            # caller directly instead of failing inside a background job.
            config.build_ltx_director_prompt(project, options)
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "ltx-director"}
            threading.Thread(
                target=runners.run_ltx_director, args=(job_id, project, options), daemon=True,
            ).start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "ltx-director",
                "job_url": f"/api/job/{job_id}",
            }, 202)
        except config.DirectorProjectError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_episode(self, parsed, qs):
        try:
            data = json.loads((self.read_body(max_bytes=runners.INTERPOLATE_MAX_BODY_BYTES) or b"{}").decode("utf-8"))
            staged = runners.stage_inline_video_base64(data.get("video_base64"))
            if staged is None:
                return self.send_json({"error": "video_base64 is required"}, 400)
            shots = util.int_option(data, "shots", 0, 0, 512)
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "episode-join", "options": {"shots": shots}}
            threading.Thread(
                target=runners.run_episode_save, args=(job_id, staged, {"shots": shots}), daemon=True,
            ).start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "episode-join",
                "job_url": f"/api/job/{job_id}",
                "page_url": f"/job/{job_id}",
                "history_url": "/api/history",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_upscale(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            staged = media.stage_inline_image_base64(data.get("image_base64"))
            if staged is None:
                return self.send_json({"error": "image_base64 is required"}, 400)
            options = {
                "mode": data.get("mode"),
                "scale": data.get("scale"),
                "prompt": data.get("prompt"),
                "negative_prompt": data.get("negative_prompt"),
                "refine_steps": data.get("refine_steps"),
                "refine_denoise": data.get("refine_denoise"),
                "seed": data.get("seed"),
                "run_on": data.get("run_on"),
            }
            # A stale "Run on" pin is refused here, before a job exists to
            # fail, so the studio hears the reason instead of a dead job.
            try:
                _lanes.comfy_lane_for_pin(options.get("run_on"))
            except _lanes.ComfyLanePinError as exc:
                return self.send_json({"error": str(exc), "operational": True}, 409)
            job_id = uuid.uuid4().hex[:12]
            mode = "max" if str(data.get("mode") or "fast").lower() == "max" else "fast"
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "comfy-upscale", "mode": mode, "options": {"mode": mode}}
            t = threading.Thread(target=runners.run_comfy_upscale, args=(job_id, staged, options), daemon=True)
            t.start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "comfy-upscale",
                "mode": mode,
                "job_url": f"/api/job/{job_id}",
                "page_url": f"/job/{job_id}",
                "history_url": "/api/history",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_restore_upload(self, parsed, qs):
        # The source, as raw bytes, written straight to disk in blocks.
        #
        # No JSON, no base64, no copy in memory anywhere along the way: the
        # start request that follows names the id this hands back. This is
        # the route that makes a multi-hundred-megabyte restore possible at
        # all — the old inline-base64 transport cost three full copies and
        # simply refused past a few hundred megabytes, which is the size of
        # the footage this studio exists for.
        restore.reap_restore_uploads()
        source_id = f"u{uuid.uuid4().hex[:16]}"
        try:
            written = self.stream_body_to_file(
                restore.restore_upload_path(source_id), restore.RESTORE_MAX_SOURCE_BYTES)
        except restore.RestoreTooLarge as exc:
            return self.send_json({
                "error": str(exc), "operational": True,
                "max_source_bytes": exc.max_bytes, "bytes": exc.size_bytes,
            }, 413)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except OSError as exc:
            return self.send_json({"error": f"that upload could not be written: {exc}"}, 507)
        return self.send_json({
            "ok": True, "source_id": source_id, "bytes": written,
            **restore.restore_retention(),
        }, 201)

    def post_api_restore(self, parsed, qs):
        # Start a restoration, or resume one. The same route for both: a
        # resume is a start that already has finished chunks, and making it
        # a second endpoint would be two ways to get the plan wrong.
        try:
            # The ordinary JSON cap now, not a 768MB one: the body is a
            # set of dials and a staged id. It still leaves room for the
            # small inline clip an older client might send.
            data = json.loads((self.read_body(max_bytes=config.MAX_JSON_BODY_BYTES) or b"{}").decode("utf-8"))
            project_id = util.safe_name(str(data.get("project_id") or ""))
            staged = restore._claim_restore_source(data)
            if staged is None and not project_id:
                return self.send_json({"error": "a source clip is required to start a restoration"}, 400)
            options = {
                key: data.get(key) for key in (
                    "model", "resolution", "max_resolution", "batch_size", "chunk_seconds",
                    "context_frames", "seam_frames", "temporal_overlap", "color_correction",
                    "seed", "preview_frames", "preview_start_frame", "device", "offload_device",
                    "attention_mode", "cache_models", "tiled_vae", "tile_size", "torch_compile",
                    "run_on", "max_spend_usd",
                ) if data.get(key) is not None
            }
            if isinstance(data.get("finish"), dict):
                options["finish"] = data["finish"]
            # The hosted lane's two extras, read SEPARATELY from the options
            # above because `options` is written into the project manifest
            # verbatim. The token belongs in memory for the life of one
            # render and nowhere else; it is attached by the control API,
            # which is the only side that can read the owner's account.
            credit_token = str(data.get("credit_token") or "")
            if credit_token:
                options["credit_token"] = credit_token
            # Settled HERE rather than inside the runner, so the 202 can
            # name the project the studio is about to poll. Without it the
            # studio would have to guess, or poll the whole project list.
            project_id = project_id or f"r{uuid.uuid4().hex[:10]}"
            options["project_id"] = project_id
            pin_error = restore.restore_pin_error(options)
            if pin_error:
                if staged is not None:
                    staged.unlink(missing_ok=True)
                return self.send_json({"error": pin_error, "operational": True}, 409)
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {
                    "id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued",
                    "created_at": util.now_iso(), "backend": "seedvr2-restore",
                }
            threading.Thread(
                target=restore.run_video_restore, args=(job_id, staged, options), daemon=True,
            ).start()
            return self.send_json({
                "id": job_id,
                "status": "queued",
                "backend": "seedvr2-restore",
                "project_id": project_id,
                "job_url": f"/api/job/{job_id}",
                "project_url": f"/api/restore/project/{project_id}",
                "history_url": "/api/history",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_restore_plan(self, parsed, qs):
        # What a render WOULD be, before a byte is uploaded: chunk count,
        # output size, and which machine would run it. The studio mirrors
        # this arithmetic to keep its own dials honest; this is the copy
        # that decides, so the two are compared rather than trusted.
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            plan = config.video_restore.restore_plan(
                frames=int(data.get("frames") or 0),
                fps=float(data.get("fps") or 24.0),
                width=int(data.get("width") or 0),
                height=int(data.get("height") or 0),
                options=data.get("options") if isinstance(data.get("options"), dict) else {},
            )
            lane = None
            try:
                lane_name, lane_url, capability = restore._resolve_restore_lane(plan, data.get("options") or {})
                # The same two questions the runner asks, so the plan the
                # panel shows is the plan the render will run: a sealed
                # sink cannot dissolve, and a lane with no machine of the
                # owner's is the paid one whether or not it is "remote".
                sink = restore._restore_sink_for_lane(lane_name)
                remote = _lanes.comfy_lane_is_remote(lane_name)
                if not config.video_restore.sink_supports_seams(sink):
                    plan["seam_frames"] = 0
                lane = {
                    "lane": lane_name,
                    "remote": remote or lane_name == config.video_restore.CLOUD_LANE,
                    "paid": remote or lane_name == config.video_restore.CLOUD_LANE,
                    "assembles_here": config.video_restore.sink_assembles_locally(sink),
                    "models": capability.get("models") or [],
                    "devices": capability.get("devices") or [],
                    "attention_modes": capability.get("attention_modes") or [],
                }
                if lane_name == config.video_restore.CLOUD_LANE:
                    # The price, before a byte is uploaded, for THIS plan.
                    # One round trip for the whole render rather than one
                    # per chunk — and the studio sends the figure back as
                    # the approved ceiling, so a price that moved between
                    # the quote and the start is refused rather than
                    # quietly charged.
                    lane["metered"] = "per-render"
                    try:
                        lane["quote"] = config.cloud_restore.quote(config.video_restore.cloud_quote_request(plan))
                    except config.cloud_restore.CloudRestoreError as exc:
                        # A lane that cannot be priced is not offered as
                        # free — it is offered as unpriced, and the studio
                        # says which.
                        lane["quote_error"] = str(exc)
            except (RuntimeError, _lanes.ComfyLanePinError) as exc:
                lane = {"error": str(exc)}
            return self.send_json({"ok": True, "plan": plan, "lane": lane})
        except config.video_restore.RestoreError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except (TypeError, ValueError) as exc:
            return self.send_json({"error": str(exc)}, 400)

    def post_api_restore_finish(self, parsed, qs):
        # Re-finish, without re-restoring. The expensive half is already on
        # disk; sharpening, grain, softening and the reframe are one ffmpeg
        # pass over it.
        try:
            data = json.loads((self.read_body(max_bytes=config.MAX_JSON_BODY_BYTES) or b"{}").decode("utf-8"))
            project_id = util.safe_name(str(data.get("project_id") or ""))
            if not project_id or not restore.restore_manifest_path(project_id).is_file():
                return self.send_json({"error": "no such restoration project"}, 404)
            finish = data.get("finish") if isinstance(data.get("finish"), dict) else {}
            # A project whose chunks are sealed is finished from the clip the
            # BROWSER joined — the gateway cannot read those chunks, so the
            # assembled master has to arrive from the side that can. It
            # arrives the same way a source does: streamed to disk first,
            # named here by its id.
            assembled = restore._claim_restore_source(data)
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {
                    "id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued",
                    "created_at": util.now_iso(), "backend": "seedvr2-finish",
                }
            threading.Thread(
                target=restore.run_restore_finish, args=(job_id, project_id, finish, assembled), daemon=True,
            ).start()
            return self.send_json({
                "id": job_id, "status": "queued", "backend": "seedvr2-finish",
                "project_id": project_id,
                "job_url": f"/api/job/{job_id}",
                "project_url": f"/api/restore/project/{project_id}",
            }, 202)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self.send_json({"error": str(exc)}, 500)

    def post_api_restore_cancel(self, parsed, qs):
        project_id = util.safe_name(parsed.path.rsplit("/", 1)[-1])
        if not project_id:
            return self.send_json({"error": "which project?"}, 400)
        restore.request_restore_cancel(project_id)
        # Not an error and not a silent no-op: the chunks already finished
        # are the reason resume is worth offering.
        return self.send_json({
            "ok": True,
            "stopping": True,
            "message": "Stopping after the chunk in flight. Finished chunks are kept.",
        })

    def post_api_restore_delete(self, parsed, qs):
        project_id = util.safe_name(parsed.path.rsplit("/", 1)[-1])
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
        except ValueError:
            data = {}
        if data.get("confirm") is not True:
            return self.send_json({"error": "permanent deletion requires confirm=true"}, 400)
        try:
            directory = restore.restore_project_dir(project_id)
        except ValueError as exc:
            return self.send_json({"error": str(exc)}, 400)
        if not directory.is_dir():
            return self.send_json({"error": "no such restoration project"}, 404)
        restore.request_restore_cancel(project_id)
        shutil.rmtree(directory, ignore_errors=True)
        # The master is an ordinary output and stays where it is; deleting a
        # project throws away the working files, not the film.
        return self.send_json({"ok": True, "deleted": project_id})

    def post_api_models_equip_or_unequip(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            mid = str(data.get("id", ""))
            if parsed.path.endswith("/equip"):
                ok, msg = _models.equip_model(mid)
                return self.send_json({"ok": ok, "message": msg, "equipped": _models.load_equipped(), "selected": _models.load_selected_loras(), "ram": _models.ram_info()}, 200 if ok else 409)
            changed = _models.unequip_model(mid)
            return self.send_json({"ok": True, "changed": changed, "equipped": _models.load_equipped(), "selected": _models.load_selected_loras(), "ram": _models.ram_info()})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def post_api_loras_select(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            selected = _models.save_selected_loras(data.get('loras', []))
            return self.send_json({"ok": True, "selected": selected, "loras": _models.local_loras()})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def post_api_civitai_download(self, parsed, qs):
        try:
            data = json.loads((self.read_body() or b"{}").decode("utf-8"))
            civitai_key = data.get('civitai_key') or data.get('civitai_token') or data.get('civitaiToken') or data.get('civitaiApiKey')
            if data.get('url'):
                resolved = _models.resolve_civitai_url(data.get('url'))
                _models.validate_civitai_expected_type(resolved.get('version') or {}, data.get('expectedType'))
                job = _models.start_civitai_download_job(
                    resolved.get('versionId'),
                    data.get('fileId') or resolved.get('fileId'),
                    token_override=civitai_key,
                    name=_models.civitai_version_display_name(resolved.get('version') or {}),
                    replace_id=data.get('replaceId') or data.get('replace_id'),
                )
                job['resolved'] = {'versionId': resolved.get('versionId'), 'fileId': data.get('fileId') or resolved.get('fileId')}
                return self.send_json(job, 202)
            job = _models.start_civitai_download_job(data.get('versionId') or data.get('modelVersionId'), data.get('fileId'), token_override=civitai_key)
            return self.send_json(job, 202)
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)

    def post_api_civitai_cancel_download(self, parsed, qs):
        jid = parsed.path.rsplit("/", 1)[-1]
        rec = _models.cancel_civitai_download_job(jid)
        return self.send_json(_models.public_download_job(rec) if rec else {"error": "not found"}, 200 if rec else 404)

    def post_comfy(self, parsed, qs):
        return self.proxy_to_comfy(parsed, "POST")

    def post_generate(self, parsed, qs):
        try:
            ctype = self.headers.get("Content-Type", "")
            data = {}
            uploaded_image = None
            if "multipart/form-data" in ctype:
                try:
                    content_length = int(self.headers.get('Content-Length') or 0)
                except (TypeError, ValueError):
                    content_length = 0
                form = MultipartForm(self.rfile.read(content_length) if content_length > 0 else b'', ctype)
                prompt = str(form.getfirst("prompt", "")).strip()
                for key in ['backend', 'width', 'height', 'steps', 'cfg', 'guidance', 'seed', 'mlx_cache_limit_gb', 'ref_boost', 'identity_strength', 'grounding_px', 'studio_lane', 'run_on']:
                    if key in form:
                        data[key] = form.getfirst(key)
                image_item = form['image'] if 'image' in form else None
                if image_item is not None and getattr(image_item, 'file', None) and getattr(image_item, 'filename', ''):
                    ext = Path(image_item.filename).suffix.lower()
                    if ext not in {'.png', '.jpg', '.jpeg', '.webp'}:
                        ext = '.png'
                    upload_dir = config.OUT_DIR / 'mlx-inputs'
                    upload_dir.mkdir(parents=True, exist_ok=True)
                    uploaded_image = upload_dir / f"{uuid.uuid4().hex[:12]}{ext}"
                    with uploaded_image.open('wb') as f:
                        while True:
                            chunk = image_item.file.read(1024 * 1024)
                            if not chunk:
                                break
                            f.write(chunk)
            else:
                body = self.read_body()
                if "application/json" in ctype:
                    data = json.loads(body.decode("utf-8") or "{}")
                    prompt = str(data.get("prompt", "")).strip()
                    uploaded_image = media.stage_inline_image_base64(data.get("image_base64"))
                else:
                    data = parse_qs(body.decode("utf-8"))
                    prompt = str(data.get("prompt", [""])[0]).strip()
            wants_character_sheet = isinstance(data, dict) and isinstance(data.get('character_sheet'), dict)
            if not prompt and not wants_character_sheet:
                # A character sheet works from the reference alone — its view
                # prompts are built server-side; the user prompt is optional.
                return self.send_json({"error": "prompt required"}, 400)
            options = {}
            if isinstance(data, dict):
                for key in ['width', 'height', 'steps', 'cfg', 'cfgScale', 'guidance', 'seed', 'sampler_name', 'scheduler', 'negative_prompt', 'mlx_cache_limit_gb', 'ref_boost', 'identity_strength', 'grounding_px', 'couple_mode', 'couple_shared', 'couple_split', 'couple_direction', 'couple_pair', 'studio_lane', 'run_on']:
                    if key in data:
                        options[key] = data.get(key)
                graphs._normalize_couple_options(options)
                # The studio's per-tab "Run on" pin. Refused up front when it
                # names a machine that is no longer attached: a queued job that
                # fails seconds later would reach the tab as a bare failure.
                try:
                    _lanes.comfy_lane_for_pin(options.get('run_on'))
                except _lanes.ComfyLanePinError as exc:
                    return self.send_json({"error": str(exc), "operational": True}, 409)
            backend = str(data.get('backend', '') if isinstance(data, dict) else '')
            if wants_character_sheet:
                # The Klein edit branch is the only lane that honors
                # character_sheet; it is reached by naming a Klein backend
                # (image_path/image_paths references are collected there) or by
                # sending an inline image with no other backend claim. Fail
                # loudly instead of letting the request fall through to a lane
                # that would silently ignore the key.
                klein_reachable = (
                    backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'}
                    or (uploaded_image is not None and backend != 'comfy-api-image' and backend not in config.KREA2_IDENTITY_BACKENDS)
                )
                if not klein_reachable:
                    return self.send_json({"error": "character sheet runs on the Klein edit backend and requires a reference image (image_base64 or image_path)"}, 400)
            if backend == 'comfy-api-image':
                options['workflow_file'] = str(data.get('workflow_file', '') if isinstance(data, dict) else '')
                if isinstance(data, dict) and isinstance(data.get('loras'), list):
                    options['loras'] = data.get('loras')
                if isinstance(data, dict):
                    # H3 Studio graphs size from aspect_ratio + megapixels (or
                    # the studio's Resolution tier) and pick their own sampler
                    # from a profile, so none of these reach the request
                    # through the shared width/height/steps keys above.
                    for key in ('aspect_ratio', 'base_size', 'megapixels', 'sampling_profile',
                                'frame_profile', 'route', 'adherence'):
                        if key in data:
                            options[key] = data.get(key)
                    try:
                        options['reference_image_paths'] = [
                            str(path) for path in media.collect_reference_image_paths(data, uploaded_image)
                        ]
                    except ValueError as exc:
                        return self.send_json({"error": str(exc)}, 400)
                job_id = uuid.uuid4().hex[:12]
                with jobs.jobs_lock:
                    jobs.jobs[job_id] = {
                        "id": job_id,
                        "prompt": history.PRIVATE_PROMPT_LABEL,
                        "status": "queued",
                        "created_at": util.now_iso(),
                        "backend": "comfy-api-image",
                        "options": {k: v for k, v in options.items() if k not in ('negative_prompt', 'workflow_file', 'loras')},
                    }
                jobs.start_studio_generation_thread(
                    'image', options, runners.run_comfy_api_image, (job_id, prompt, options))
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "comfy-api-image",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            if backend in config.KREA2_IDENTITY_BACKENDS:
                if isinstance(data, dict) and data.get('loras') is not None:
                    krea_loras = _models.resolve_lora_selection(data.get('loras') or [], ['Krea 2'])
                    options['loras'] = [
                        {'id': item['id'], 'strength': item['strength']}
                        for item in krea_loras
                    ]
                if uploaded_image is None:
                    maybe_image = str(data.get('image_path', '') if isinstance(data, dict) else '')
                    if maybe_image:
                        uploaded_image = Path(maybe_image).expanduser()
                        if not uploaded_image.is_absolute():
                            uploaded_image = config.COMFY_INPUT_DIR / maybe_image
                # Masked edit (soft inpaint): a white-on-black mask PNG rides
                # along as mask_base64; only the painted area (plus a small
                # grown collar) changes, the rest is composited back untouched.
                inpaint_req = data.get('inpaint') if isinstance(data, dict) else None
                if isinstance(inpaint_req, dict) and inpaint_req.get('mask_base64'):
                    if uploaded_image is None:
                        return self.send_json({"error": "inpaint requires a source image"}, 400)
                    try:
                        mask_path = media.stage_inline_image_base64(inpaint_req.get('mask_base64'))
                    except ValueError as exc:
                        return self.send_json({"error": f"inpaint mask: {exc}"}, 400)
                    for key in ('mask_expand', 'mask_influence'):
                        if inpaint_req.get(key) is not None:
                            options[key] = inpaint_req.get(key)
                    job_id = uuid.uuid4().hex[:12]
                    with jobs.jobs_lock:
                        jobs.jobs[job_id] = {
                            "id": job_id,
                            "prompt": history.PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": util.now_iso(),
                            "backend": "comfy-krea2-inpaint",
                            "mode": "inpaint",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    jobs.start_studio_generation_thread(
                        'image', options, runners.run_comfy_krea2_inpaint,
                        (job_id, prompt, uploaded_image, mask_path, options),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-inpaint",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                # Canvas expansion: pixel-preserving centered outpaint on the
                # same lane (Mix-Studio port; the LTX anchor pipeline's graph).
                outpaint_req = data.get('outpaint') if isinstance(data, dict) else None
                if isinstance(outpaint_req, dict) and outpaint_req.get('width') and outpaint_req.get('height'):
                    if uploaded_image is None:
                        return self.send_json({"error": "outpaint requires a source image"}, 400)
                    job_id = uuid.uuid4().hex[:12]
                    with jobs.jobs_lock:
                        jobs.jobs[job_id] = {
                            "id": job_id,
                            "prompt": history.PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": util.now_iso(),
                            "backend": "comfy-krea2-outpaint",
                            "mode": "outpaint",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    jobs.start_studio_generation_thread(
                        'image', options, runners.run_comfy_krea2_outpaint,
                        (job_id, prompt, uploaded_image, options, outpaint_req),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-outpaint",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                # Strength Hunt: same lane, but sweeps 1-2 selected LoRA
                # strengths across a fixed prompt+seed and adds a labeled
                # comparison sheet (see strength_hunt.py).
                hunt = data.get('strength_hunt') if isinstance(data, dict) else None
                if isinstance(hunt, dict) and hunt.get('lora_ids'):
                    job_id = uuid.uuid4().hex[:12]
                    with jobs.jobs_lock:
                        jobs.jobs[job_id] = {
                            "id": job_id,
                            "prompt": history.PRIVATE_PROMPT_LABEL,
                            "status": "queued",
                            "created_at": util.now_iso(),
                            "backend": "comfy-krea2-strength-hunt",
                            "mode": "identity-edit" if uploaded_image else "text-to-image",
                            "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                        }
                    jobs.start_studio_generation_thread(
                        'image', options, runners.run_comfy_krea2_strength_hunt,
                        (job_id, prompt, uploaded_image, options, hunt),
                    )
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": "comfy-krea2-strength-hunt",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                job_id = uuid.uuid4().hex[:12]
                with jobs.jobs_lock:
                    jobs.jobs[job_id] = {
                        "id": job_id,
                        "prompt": history.PRIVATE_PROMPT_LABEL,
                        "status": "queued",
                        "created_at": util.now_iso(),
                        "backend": "comfy-krea2-turbo-identity-edit",
                        "mode": "identity-edit" if uploaded_image else "text-to-image",
                        "options": {k: v for k, v in options.items() if k != 'negative_prompt'},
                    }
                jobs.start_studio_generation_thread(
                    'image', options, runners.run_comfy_krea2_identity,
                    (job_id, prompt, uploaded_image, options),
                )
                return self.send_json({
                    "id": job_id,
                    "status": "queued",
                    "backend": "comfy-krea2-turbo-identity-edit",
                    "mode": "identity-edit" if uploaded_image else "text-to-image",
                    "job_url": f"/api/job/{job_id}",
                    "page_url": f"/job/{job_id}",
                    "history_url": "/api/history",
                }, 202)
            if backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'} or uploaded_image is not None:
                native_loras = _loras._native_loras_from_generation_request(data, ['Flux.2 Klein 9B'])
                if native_loras:
                    options['loras'] = native_loras
                # Klein conditions on up to BIGLOVE_KLEIN3_MAX_REFERENCES
                # images (identity across views, character sheets).
                reference_images = media.collect_reference_image_paths(data, uploaded_image)[:graphs.BIGLOVE_KLEIN3_MAX_REFERENCES]
                if not reference_images:
                    return self.send_json({"error": "image required for BigLoveKlein3 edit"}, 400)
                uploaded_image = reference_images[0]
                if len(reference_images) > 1:
                    options['image_paths'] = [str(p) for p in reference_images]
                # Character sheet: N per-view edits of the same reference(s) on
                # the native Klein lane, composited into one labeled sheet.
                if wants_character_sheet:
                    sheet_req = data.get('character_sheet')
                    try:
                        sheet_views = config.resolve_character_sheet_views(sheet_req)
                    except ValueError as exc:
                        return self.send_json({"error": str(exc)}, 400)
                    if not config.supports_native_mlx_biglove_route():
                        return self.send_json({"error": f"character sheet needs the native MLX Klein route (accelerator profile {config.accelerator_profile()})"}, 400)
                    sheet_preset = str(sheet_req.get('preset') or '').strip().lower() or None
                    job_id = native_mlx.queue_klein_character_sheet(prompt, reference_images, options, sheet_views, preset=sheet_preset)
                    return self.send_json({
                        "id": job_id,
                        "status": "queued",
                        "backend": native_mlx.KLEIN_CHARACTER_SHEET_BACKEND,
                        "mode": "character-sheet",
                        "job_url": f"/api/job/{job_id}",
                        "page_url": f"/job/{job_id}",
                        "history_url": "/api/history",
                    }, 202)
                if config.supports_native_mlx_biglove_route():
                    job_id = native_mlx.queue_native_mlx_biglove_job(prompt, uploaded_image, options)
                    return self.send_json({"id": job_id, "status": "queued", "backend": "mlx-mxfp8-bigloves-klein3-edit", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
                if backend in {'mlx-bigloves-klein3-edit', 'mlx-mxfp8-bigloves-klein3-edit'}:
                    return self.send_json({"error": f"native MLX BigLove route is not available for accelerator profile {config.accelerator_profile()}"}, 400)
                job_id = uuid.uuid4().hex[:12]
                with jobs.jobs_lock:
                    jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "backend": "comfy-bigloves-klein3-edit", "options": {k: v for k, v in options.items() if k != 'negative_prompt'}}
                jobs.start_studio_generation_thread(
                    'image', options, runners.run_comfy_klein3_edit,
                    (job_id, prompt, uploaded_image, options),
                )
                return self.send_json({"id": job_id, "status": "queued", "backend": "comfy-bigloves-klein3-edit", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
            req_loras = data.get('loras') if isinstance(data, dict) else None
            loras = _models.resolve_lora_selection(req_loras, _models.current_base_models()) if req_loras is not None else _models.load_selected_loras()
            job_id = uuid.uuid4().hex[:12]
            with jobs.jobs_lock:
                jobs.jobs[job_id] = {"id": job_id, "prompt": history.PRIVATE_PROMPT_LABEL, "status": "queued", "created_at": util.now_iso(), "loras": loras, "options": {k: v for k, v in options.items() if k != 'negative_prompt'}}
            jobs.start_studio_generation_thread(
                'image', options, runners.run_generation, (job_id, prompt, loras, options))
            if parsed.path == "/generate":
                return self.send_text(f"<meta http-equiv='refresh' content='0; url=/job/{job_id}'>Queued job {job_id}. Opening live status page...", 202)
            return self.send_json({"id": job_id, "status": "queued", "job_url": f"/api/job/{job_id}", "page_url": f"/job/{job_id}", "history_url": "/api/history"}, 202)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def delete_comfy(self, parsed, qs):
        return self.proxy_to_comfy(parsed, "DELETE")
