import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { JobQueue, downloadImage, parseImageResult, validateRequest } from '../lib/api.mjs';
import { createApiServer } from '../server.mjs';
import { imageApiUrl, isImageMessage } from '../public/perchance.mjs';

const result = { ok: true, url: 'https://user.uploads.dev/file/example.jpg', dataUrl: 'data:image/jpeg;base64,/9j/2Q==', seed: 7 };
const params = () => validateRequest({ prompt: 'local test fixture' });

test('request validation supports documented aliases and rejects unsupported values', () => {
  assert.deepEqual(validateRequest({ prompt: ' test ', size: '768x512', negative_prompt: '', guidance_scale: 9, seed: 7, remove_background: true, response_format: 'b64_json' }), {
    prompt: 'test', resolution: '768x512', negativePrompt: '', guidanceScale: 9, seed: 7, removeBackground: true, responseFormat: 'b64_json',
  });
  for (const body of [null, [], { prompt: '' }, { prompt: 'x', n: 2 }, { prompt: 'x', size: '1024x1024' }, { prompt: 'x', guidanceScale: Infinity }, { prompt: 'x', seed: 1.5 }, { prompt: 'x', remove_background: 'true' }, { prompt: 'x', resolution: '512x512', size: '512x512' }, { prompt: 'x', model: 'other' }, { prompt: 'x', style: 'Anime' }]) {
    assert.throws(() => validateRequest(body), { code: 'invalid_request' });
  }
});

test('result parser validates image data and restricts remote image hosts', () => {
  assert.deepEqual(parseImageResult(result), { url: result.url, b64: '/9j/2Q==', mimeType: 'image/jpeg', seed: 7 });
  for (const url of ['http://user.uploads.dev/file/x', 'https://user.uploads.dev.evil.example/x', 'https://127.0.0.1/x', 'https://user.uploads.dev:8443/x', 'https://user:pass@user.uploads.dev/x']) {
    assert.throws(() => parseImageResult({ ok: true, url }), { code: 'invalid_image_result' });
  }
  assert.throws(() => parseImageResult({ ok: false, error: 'upstream failed' }), { code: 'perchance_error', message: 'upstream failed' });
});

test('queue processes images sequentially and prevents foreign or stale results', async () => {
  const queue = new JobQueue({ maxPending: 2 });
  const messages = [];
  queue.connect({ id: 'browser', send: (type, data) => messages.push({ type, data }) });
  const first = queue.enqueue(params());
  const second = queue.enqueue(params());
  assert.equal(messages.length, 1);
  assert.throws(() => queue.enqueue(params()), { code: 'queue_full' });
  assert.throws(() => queue.complete('other', messages[0].data.id, result), { code: 'stale_result' });
  queue.complete('browser', messages[0].data.id, result);
  assert.equal((await first).url, result.url);
  assert.equal(messages.length, 2);
  queue.complete('browser', messages[1].data.id, result);
  await second;
  assert.deepEqual(queue.status(), { browser_connected: true, queued: 0, active: false, last_error: null });
  queue.close();
});

test('queue cancels abandoned requests and frees capacity', async () => {
  const queue = new JobQueue();
  const messages = [];
  queue.connect({ id: 'browser', send: (type, data) => messages.push({ type, data }) });
  const controller = new AbortController();
  const request = queue.enqueue(params(), controller.signal);
  const rejection = assert.rejects(request, { code: 'request_cancelled' });
  controller.abort();
  await rejection;
  assert.equal(messages[1].type, 'cancel');
  assert.equal(queue.status().active, false);
  queue.close();
});

test('queue expires both active and queued requests', async () => {
  const queue = new JobQueue({ timeoutMs: 30 });
  queue.connect({ id: 'browser', send: () => {} });
  const first = assert.rejects(queue.enqueue(params()), { code: 'generation_timeout' });
  const second = assert.rejects(queue.enqueue(params()), { code: 'generation_timeout' });
  await Promise.all([first, second, delay(50)]);
  assert.equal(queue.status().active, false);
  assert.equal(queue.status().queued, 0);
  queue.close();
});

test('worker loss rejects active requests and requires a new connection', async () => {
  const queue = new JobQueue();
  queue.connect({ id: 'browser', send: () => {} });
  const rejection = assert.rejects(queue.enqueue(params()), { code: 'bridge_disconnected' });
  queue.disconnect('browser');
  await rejection;
  assert.throws(() => queue.enqueue(params()), { code: 'bridge_not_connected' });
  queue.close();
});

test('shutdown does not dispatch queued requests', async () => {
  const queue = new JobQueue();
  const messages = [];
  queue.connect({ id: 'browser', send: (type) => messages.push(type) });
  const first = assert.rejects(queue.enqueue(params()), { code: 'server_stopping' });
  const second = assert.rejects(queue.enqueue(params()), { code: 'server_stopping' });
  queue.close();
  await Promise.all([first, second]);
  assert.deepEqual(messages, ['job']);
});

test('iframe protocol encodes prompts and rejects unrelated postMessage events', () => {
  const url = new URL(imageApiUrl('request-123', { ...params(), prompt: 'a & b + c', seed: 0, removeBackground: false }));
  assert.equal(url.origin, 'https://null.perchance.org');
  assert.equal(url.searchParams.get('prompt'), 'a & b + c');
  assert.equal(url.searchParams.get('seed'), '0');
  assert.equal(url.searchParams.get('removeBackground'), 'false');
  const event = { origin: 'https://abcdef.perchance.org', data: { api: 'perchance-image-api', result: { id: 'request-123' } } };
  assert.equal(isImageMessage(event, 'request-123'), true);
  assert.equal(isImageMessage({ ...event, origin: 'https://perchance.org.evil.example' }, 'request-123'), false);
  assert.equal(isImageMessage({ ...event, origin: 'http://perchance.org' }, 'request-123'), false);
  assert.equal(isImageMessage(event, 'different-id'), false);
});

test('download uses only the image host and rejects redirects or non-image responses', async () => {
  let called = false;
  await assert.rejects(downloadImage('https://localhost/internal', { fetchImpl: () => { called = true; } }));
  assert.equal(called, false);
  const image = await downloadImage(result.url, { fetchImpl: async (url, options) => {
    assert.equal(url, result.url);
    assert.equal(options.redirect, 'error');
    return new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.b64, '/9j/2Q==');
  await assert.rejects(downloadImage(result.url, { fetchImpl: async () => new Response('html', { headers: { 'content-type': 'text/html' } }) }), { code: 'image_download_failed' });
});

async function startServer(t, options = {}) {
  const { server, queue } = createApiServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    queue.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, queue };
}

test('HTTP API enforces authentication, validation and browser availability', async (t) => {
  const { base } = await startServer(t, { apiKey: 'test-key' });
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { Authorization: 'test-key' } })).status, 401);
  assert.equal((await fetch(`${base}/worker/connect`, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer test-key' } })).status, 403);
  const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
  const invalid = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers, body: '{broken' });
  assert.equal(invalid.status, 400);
  const missing = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'local fixture' }) });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'bridge_not_connected');
  const deniedCors = await fetch(`${base}/health`, { headers: { ...headers, Origin: 'https://evil.example' } });
  assert.equal(deniedCors.status, 403);
});

test('unauthenticated local mode rejects unexpected Host headers', async (t) => {
  const { base } = await startServer(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/health`, { headers: { Host: 'attacker.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('HTTP flow delivers a job over SSE and returns a correlated image response', async (t) => {
  const { base } = await startServer(t);
  const connected = await fetch(`${base}/worker/connect`, { method: 'POST', headers: { Origin: base } });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const controller = new AbortController();
  const stream = await fetch(`${base}/worker/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  let buffer = '';
  const readEvent = async (name) => {
    while (true) {
      const match = new RegExp(`event: ${name}\\ndata: ([^\\n]+)\\n\\n`).exec(buffer);
      if (match) {
        buffer = buffer.slice(match.index + match[0].length);
        return JSON.parse(match[1]);
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE closed before the job arrived.');
      buffer += new TextDecoder().decode(chunk.value);
    }
  };
  await readEvent('ready');
  const generation = fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'local fixture' }) });
  const job = await readEvent('job');
  assert.equal(job.params.prompt, 'local fixture');
  const complete = await fetch(`${base}/worker/result`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, result }) });
  assert.equal(complete.status, 200);
  const response = await generation;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ url: result.url, seed: 7 }]);
  const stale = await fetch(`${base}/worker/result`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: job.id, result }) });
  assert.equal(stale.status, 409);
  controller.abort();
});

test('HTTP base64 response downloads a URL-only result using the restricted downloader', async (t) => {
  const { base, queue } = await startServer(t, { fetchImpl: async () => new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } }) });
  queue.connect({ id: 'test-worker', send: (type, job) => {
    if (type === 'job') setImmediate(() => queue.complete('test-worker', job.id, { ok: true, url: result.url }));
  } });
  const response = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'local fixture', response_format: 'b64_json' }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ b64_json: '/9j/2Q==', mime_type: 'image/jpeg' }]);
});
