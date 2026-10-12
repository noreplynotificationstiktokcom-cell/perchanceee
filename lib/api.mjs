import { randomUUID, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function keyMatches(actual, expected) {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const resolutions = ['512x512', '512x768', '768x512', '768x768'];

export function validateRequest(body) {
  const invalid = (message) => { throw new ApiError(400, 'invalid_request', message); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Body must be a JSON object.');
  const allowed = new Set(['prompt', 'negative_prompt', 'negativePrompt', 'size', 'resolution', 'guidance_scale', 'guidanceScale', 'seed', 'remove_background', 'removeBackground', 'n', 'response_format', 'model']);
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) invalid(`Unsupported field: ${field}.`);
  }
  for (const [left, right] of [['size', 'resolution'], ['negative_prompt', 'negativePrompt'], ['guidance_scale', 'guidanceScale'], ['remove_background', 'removeBackground']]) {
    if (body[left] !== undefined && body[right] !== undefined) invalid(`Use either ${left} or ${right}.`);
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000) invalid('prompt must contain 1-4000 characters.');
  if (body.n !== undefined && body.n !== 1) invalid('n must be 1. Submit additional requests for more images.');
  if (body.model !== undefined && body.model !== 'perchance') invalid('Only model=perchance is supported.');
  const resolution = body.size ?? body.resolution ?? '512x512';
  if (!resolutions.includes(resolution)) invalid(`size must be one of: ${resolutions.join(', ')}.`);
  const guidanceScale = body.guidance_scale ?? body.guidanceScale ?? 7;
  if (typeof guidanceScale !== 'number' || !Number.isFinite(guidanceScale) || guidanceScale < 1 || guidanceScale > 30) invalid('guidance_scale must be a number from 1 to 30.');
  const negativePrompt = body.negative_prompt ?? body.negativePrompt;
  if (negativePrompt !== undefined && (typeof negativePrompt !== 'string' || negativePrompt.length > 4000)) invalid('negative_prompt must be a string of at most 4000 characters.');
  const removeBackground = body.remove_background ?? body.removeBackground ?? false;
  if (typeof removeBackground !== 'boolean') invalid('remove_background must be a boolean.');
  if (body.seed !== undefined && (!Number.isSafeInteger(body.seed) || body.seed < -1 || body.seed > 2147483647)) invalid('seed must be an integer from -1 to 2147483647.');
  const responseFormat = body.response_format ?? 'url';
  if (!['url', 'b64_json'].includes(responseFormat)) invalid('response_format must be url or b64_json.');
  return { prompt: body.prompt.trim(), resolution, guidanceScale, negativePrompt, removeBackground, seed: body.seed, responseFormat };
}

export function parseImageResult(result) {
  if (!result || result.ok !== true) {
    throw new ApiError(502, 'perchance_error', typeof result?.error === 'string' ? result.error.slice(0, 500) : 'Perchance did not return an image.');
  }
  let url;
  if (typeof result.url === 'string') {
    try {
      const parsed = new URL(result.url);
      if (parsed.protocol === 'https:' && parsed.hostname === 'user.uploads.dev' && !parsed.username && !parsed.password && !parsed.port) url = parsed.href;
    } catch { /* A malformed upstream URL is not accepted. */ }
  }
  let b64;
  let mimeType;
  if (typeof result.dataUrl === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.dataUrl);
    if (match && match[2].length % 4 === 0) {
      mimeType = match[1];
      b64 = match[2];
    }
  }
  if (!url && !b64) throw new ApiError(502, 'invalid_image_result', 'Perchance returned an invalid image URL or data URL.');
  return { url, b64, mimeType, seed: Number.isSafeInteger(result.seed) ? result.seed : undefined };
}

export class JobQueue {
  constructor({ timeoutMs = 180000, maxPending = 8 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.pending = [];
    this.active = null;
    this.worker = null;
    this.lastError = null;
  }

  status() {
    return { browser_connected: Boolean(this.worker), queued: this.pending.length, active: Boolean(this.active), last_error: this.lastError };
  }

  connect(worker) {
    if (this.worker) throw new ApiError(409, 'bridge_already_connected', 'Another browser bridge is already connected.');
    this.worker = worker;
    this.lastError = null;
    this.dispatch();
  }

  disconnect(id) {
    if (this.worker?.id !== id) return;
    this.worker = null;
    if (this.active) this.fail(this.active, new ApiError(503, 'bridge_disconnected', 'Browser bridge disconnected during generation.'));
  }

  enqueue(params, signal) {
    if (!this.worker) throw new ApiError(503, 'bridge_not_connected', 'Open /bridge in a browser and connect it before generating images.');
    if (this.pending.length + Number(Boolean(this.active)) >= this.maxPending) throw new ApiError(429, 'queue_full', 'The generation queue is full. Try again later.');
    if (signal?.aborted) throw new ApiError(499, 'request_cancelled', 'Request was cancelled.');
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), params, resolve, reject, signal };
      job.abort = () => this.fail(job, new ApiError(499, 'request_cancelled', 'Request was cancelled.'));
      job.timer = setTimeout(() => this.fail(job, new ApiError(504, 'generation_timeout', 'Generation timed out, including time spent waiting in the queue. Check the browser bridge.')), this.timeoutMs);
      job.timer.unref();
      signal?.addEventListener('abort', job.abort, { once: true });
      this.pending.push(job);
      this.dispatch();
    });
  }

  dispatch() {
    if (!this.worker || this.active || !this.pending.length) return;
    this.active = this.pending.shift();
    this.active.workerId = this.worker.id;
    try { this.worker.send('job', { id: this.active.id, params: this.active.params, timeoutMs: this.timeoutMs }); }
    catch { this.disconnect(this.worker.id); }
  }

  cleanup(job) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    const active = this.active === job;
    if (active) this.active = null;
    else this.pending = this.pending.filter((item) => item !== job);
    return active;
  }

  fail(job, error) {
    if (this.active !== job && !this.pending.includes(job)) return;
    const active = this.cleanup(job);
    this.lastError = error.message;
    job.reject(error);
    if (active && this.worker) {
      try { this.worker.send('cancel', { id: job.id }); }
      catch { this.disconnect(this.worker.id); }
    }
    this.dispatch();
  }

  complete(workerId, jobId, result) {
    const job = this.active;
    if (!job || job.id !== jobId || job.workerId !== workerId) throw new ApiError(409, 'stale_result', 'This result does not belong to the current job.');
    let image;
    try {
      image = parseImageResult(result);
      if (job.params.responseFormat === 'url' && !image.url) throw new ApiError(502, 'missing_image_url', 'Perchance returned image data without a hosted URL. Use response_format=b64_json.');
    } catch (error) {
      this.fail(job, error);
      return;
    }
    this.cleanup(job);
    this.lastError = null;
    job.resolve(image);
    this.dispatch();
  }

  close() {
    this.worker = null;
    for (const job of [this.active, ...this.pending].filter(Boolean)) this.fail(job, new ApiError(503, 'server_stopping', 'Server is stopping.'));
  }
}

export async function downloadImage(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const parsed = parseImageResult({ ok: true, url });
  if (!parsed.url) throw new ApiError(502, 'invalid_image_url', 'Upstream image host is not allowed.');
  let response;
  try {
    response = await fetchImpl(parsed.url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new Error('Unsupported image content type.');
    const maxBytes = 8 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Image exceeds 8 MB.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Image exceeds 8 MB.');
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error('Image is empty.');
    return { b64: Buffer.concat(chunks).toString('base64'), mimeType };
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    throw new ApiError(502, 'image_download_failed', `Could not download the generated image: ${error.message}`);
  }
}
