import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BridgeControlError, createBridgeSupervisor } from './harbor-bridge-supervisor.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultPort = 4173;
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function responseJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function safeDistPath(distRoot, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0]);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(distRoot, relative);
  return candidate.startsWith(`${distRoot}${path.sep}`) ? candidate : null;
}

function readJsonBody(request, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        rejected = true;
        reject(new BridgeControlError('request_too_large', 'The bridge control request is too large.', 413));
      }
    });
    request.once('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new BridgeControlError('invalid_json', 'The bridge control request must contain valid JSON.', 400));
      }
    });
    request.once('error', (error) => reject(new BridgeControlError('request_failed', error.message, 400)));
  });
}

function controlOriginAllowed(request, port) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}`
    || origin === `http://localhost:${port}`
    || origin === 'harbor://app';
}

function controlResponseHeaders(request, port) {
  const origin = request.headers.origin;
  if (!origin || !controlOriginAllowed(request, port)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

export function createProductionServer({
  rootDirectory = root,
  port = Number(process.env.HARBOR_WEB_PORT || defaultPort),
  supervisor = createBridgeSupervisor()
} = {}) {
  const distRoot = path.join(rootDirectory, 'dist');

  return createServer(async (request, response) => {
    let errorResponseHeaders = {};
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);

      if (url.pathname === '/health') {
        if (request.method !== 'GET') {
          responseJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET for dashboard health.' } }, { Allow: 'GET' });
          return;
        }
        responseJson(response, 200, { ok: true, service: 'zoid-bank-dashboard', build: 'dist' });
        return;
      }

      if (url.pathname === '/api/messages-bridge') {
        if (!controlOriginAllowed(request, port)) {
          responseJson(response, 403, { ok: false, error: { code: 'origin_not_allowed', message: 'Bridge controls are available only from this local dashboard.' } });
          return;
        }
        const controlHeaders = controlResponseHeaders(request, port);
        errorResponseHeaders = controlHeaders;
        if (request.method === 'OPTIONS') {
          response.writeHead(204, controlHeaders);
          response.end();
          return;
        }
        if (request.method === 'GET') {
          responseJson(response, 200, await supervisor.status(), controlHeaders);
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          responseJson(response, 200, await supervisor.perform(body.action), controlHeaders);
          return;
        }
        responseJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET for status or POST for bridge controls.' } }, { ...controlHeaders, Allow: 'GET, POST, OPTIONS' });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        responseJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Local API route not found.' } });
        return;
      }

      if (request.method !== 'GET') {
        responseJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Only GET requests are supported for dashboard files.' } }, { Allow: 'GET' });
        return;
      }

      const candidate = safeDistPath(distRoot, url.pathname);
      if (!candidate) {
        responseJson(response, 400, { ok: false, error: { code: 'invalid_path', message: 'Invalid dashboard path.' } });
        return;
      }

      let filePath = candidate;
      try {
        if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html');
        await stat(filePath);
      } catch {
        filePath = path.join(distRoot, 'index.html');
        await stat(filePath);
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(body);
    } catch (error) {
      const known = error instanceof BridgeControlError;
      console.error('Dashboard request failed:', known ? error.code : error instanceof Error ? error.message : 'unknown error');
      if (!response.headersSent) {
        responseJson(response, known ? error.status : 500, {
          ok: false,
          error: {
            code: known ? error.code : 'internal_error',
            message: known ? error.message : 'The local dashboard encountered an unexpected error.'
          }
        }, errorResponseHeaders);
      } else {
        response.end();
      }
    }
  });
}

function parsePort(value) {
  const port = Number(value || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HARBOR_WEB_PORT must be a valid TCP port.');
  }
  return port;
}

export function startProductionServer() {
  const port = parsePort(process.env.HARBOR_WEB_PORT);
  const server = createProductionServer({ port });
  server.on('error', (error) => {
    console.error('Dashboard could not start:', error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Zoid Bank production dashboard listening on http://127.0.0.1:${port}`));

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startProductionServer();
}
