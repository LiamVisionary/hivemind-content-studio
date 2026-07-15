import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadConfig } from './config.mjs';
import { bootstrapRepositories, repositoryStatus } from './repository-manager.mjs';
import { doctor, runAction, status } from './service-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, body, statusCode = 200) {
  const data = JSON.stringify(body, null, 2);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0'
  });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('not file');
    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'cache-control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300'
    });
    response.end(readFileSync(filePath));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

export function createStudioServer(config = loadConfig()) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return json(response, await status(config));
      }
      if (request.method === 'GET' && url.pathname === '/api/doctor') {
        return json(response, { checks: doctor(config) });
      }
      if (request.method === 'GET' && url.pathname === '/api/repositories') {
        return json(response, repositoryStatus(config));
      }
      if (request.method === 'POST' && url.pathname === '/api/bootstrap') {
        const body = await readJson(request);
        const result = bootstrapRepositories(config, {
          update: Boolean(body.update),
          install: Boolean(body.install)
        });
        return json(response, result, result.ok ? 200 : 500);
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readJson(request);
        const result = await runAction(config, body.action);
        const nextStatus = await status(config);
        return json(response, { result, status: nextStatus }, result.ok ? 200 : 500);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return serveStatic(request, response);
      }
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
    } catch (error) {
      json(response, { error: error.message || String(error) }, 500);
    }
  });
}

export function listen(config = loadConfig()) {
  const server = createStudioServer(config);
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}
