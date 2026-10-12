import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiError, JobQueue, downloadImage, keyMatches, validateRequest } from './lib/api.mjs';

const publicDir = new URL('./public/', import.meta.url);

export function createApiServer({ apiKey = '', timeoutMs = 180000, maxPending = 8, corsOrigins = [], fetchImpl = fetch } = {}) {
  const queue = new JobQueue({ timeoutMs, maxPending });
  const sessions = new Map();
  const heartbeats = new Set();
  const json = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const authenticate = (req) => {
    const authorization = req.headers.authorization ?? '';
    if (apiKey && (!authorization.startsWith('Bearer ') || !keyMatches(authorization.slice(7), apiKey))) throw new ApiError(401, 'unauthorized', 'A valid Authorization: Bearer token is required.');
  };
  const sameOrigin = (req) => {
    if (!req.headers.origin) throw new ApiError(403, 'origin_required', 'Browser worker requests must include an Origin header.');
    let origin;
    try { origin = new URL(req.headers.origin); }
    catch { throw new ApiError(403, 'invalid_origin', 'Invalid browser origin.'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new ApiError(403, 'invalid_origin', 'The browser bridge must use this server origin.');
  };
  const body = async (req, limit = 65536) => {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'content_type_required', 'Use Content-Type: application/json.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new ApiError(413, 'body_too_large', 'Request body is too large.');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'); }
  };
  const sessionToken = (req) => /(?:^|;\s*)perchance_worker=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const workerSession = (req) => {
    const token = sessionToken(req);
    const session = sessions.get(token);
    if (!session || (session.expiresAt < Date.now() && queue.worker?.id !== token)) throw new ApiError(401, 'worker_unauthorized', 'Connect the browser bridge again.');
    return { token, session };
  };

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!apiKey) {
        const hostname = new URL(`http://${req.headers.host}`).hostname;
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new ApiError(403, 'invalid_host', 'Unauthenticated mode only accepts localhost hostnames.');
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const workerRoute = path.startsWith('/worker/');
      if (!workerRoute && req.headers.origin) {
        const origin = req.headers.origin;
        let ownOrigin = false;
        try { ownOrigin = new URL(origin).host === req.headers.host; } catch { /* Reject invalid origins. */ }
        if (!ownOrigin && !corsOrigins.includes(origin)) throw new ApiError(403, 'cors_origin_denied', 'This browser origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
        res.end();
        return;
      }
      if (req.method === 'GET' && ['/', '/bridge', '/bridge.mjs', '/perchance.mjs', '/bridge.css'].includes(path)) {
        const files = { '/': 'bridge.html', '/bridge': 'bridge.html', '/bridge.mjs': 'bridge.mjs', '/perchance.mjs': 'perchance.mjs', '/bridge.css': 'bridge.css' };
        const file = files[path];
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src https://perchance.org https://*.perchance.org; img-src 'self' data: https://user.uploads.dev; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        res.writeHead(200, { 'Content-Type': file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
        res.end(await readFile(new URL(file, publicDir)));
        return;
      }
      if (req.method === 'GET' && path === '/health') {
        authenticate(req);
        json(res, 200, { status: queue.worker ? 'ready' : 'waiting_for_browser', ...queue.status() });
        return;
      }
      if (req.method === 'POST' && path === '/worker/connect') {
        sameOrigin(req);
        authenticate(req);
        if (queue.worker) throw new ApiError(409, 'bridge_already_connected', 'Another browser bridge is already connected.');
        for (const [key, session] of sessions) if (session.expiresAt < Date.now() && queue.worker?.id !== key) sessions.delete(key);
        if (sessions.size >= 16) throw new ApiError(429, 'too_many_sessions', 'Too many browser sessions.');
        const token = randomBytes(32).toString('hex');
        sessions.set(token, { expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        res.setHeader('Set-Cookie', `perchance_worker=${token}; HttpOnly; SameSite=Strict; Path=/worker; Max-Age=86400${req.socket.encrypted ? '; Secure' : ''}`);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && path === '/worker/events') {
        const { token } = workerSession(req);
        if (queue.worker) throw new ApiError(409, 'bridge_already_connected', 'Another browser bridge is connected.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const send = (event, data) => {
          if (res.destroyed) throw new Error('Worker connection is closed.');
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('ready', { timeoutMs });
        queue.connect({ id: token, send });
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(': keepalive\n\n');
        }, 15000);
        heartbeat.unref();
        heartbeats.add(heartbeat);
        res.on('close', () => {
          clearInterval(heartbeat);
          heartbeats.delete(heartbeat);
          queue.disconnect(token);
          sessions.delete(token);
        });
        return;
      }
      if (req.method === 'POST' && path === '/worker/result') {
        sameOrigin(req);
        const { token } = workerSession(req);
        const data = await body(req, 16 * 1024 * 1024);
        queue.complete(token, data?.id, data?.result);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'POST' && ['/v1/images/generations', '/api/generate'].includes(path)) {
        authenticate(req);
        const params = validateRequest(await body(req));
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        try {
          const image = await queue.enqueue(params, controller.signal);
          if (params.responseFormat === 'b64_json' && !image.b64) Object.assign(image, await downloadImage(image.url, { fetchImpl }));
          json(res, 200, { created: Math.floor(Date.now() / 1000), data: [params.responseFormat === 'url' ? { url: image.url, seed: image.seed } : { b64_json: image.b64, mime_type: image.mimeType, seed: image.seed }] });
        } finally { res.off('close', cancel); }
        return;
      }
      throw new ApiError(404, 'not_found', 'Endpoint not found.');
    } catch (error) {
      json(res, error.status ?? 500, { error: { code: error.code ?? 'internal_error', message: error.status ? error.message : 'Unexpected server error.' } });
      if (!error.status) console.error(error);
    }
  });
  server.requestTimeout = Math.max(timeoutMs + 30000, 300000);
  server.on('close', () => {
    for (const heartbeat of heartbeats) clearInterval(heartbeat);
    queue.close();
  });
  return { server, queue };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const integerEnv = (name, fallback, min, max) => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const host = process.env.HOST || '127.0.0.1';
  const port = integerEnv('PORT', 3000, 1, 65535);
  const apiKey = process.env.API_KEY || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && apiKey.length < 24) throw new Error('Set API_KEY with at least 24 characters before listening on a non-local host.');
  const { server, queue } = createApiServer({ apiKey, timeoutMs: integerEnv('GENERATION_TIMEOUT_MS', 180000, 1000, 600000), maxPending: integerEnv('MAX_PENDING', 8, 1, 100), corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean) });
  server.listen(port, host, () => {
    console.log(`Perchance REST API: http://${host === '::1' ? '[::1]' : host}:${port}`);
    console.log('Open /bridge in a browser, then connect it.');
  });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    queue.close();
    server.close();
    server.closeAllConnections();
  });
}
