export const API_URL = 'https://null.perchance.org/perchance-ai-api';

export function warmUpFrame(container) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.title = 'Perchance browser session';
    frame.referrerPolicy = 'no-referrer';
    const finish = () => { clearTimeout(timer); frame.remove(); resolve(); };
    const timer = setTimeout(finish, 15000);
    frame.onload = () => setTimeout(finish, 500);
    frame.src = API_URL;
    container.replaceChildren(frame);
  });
}

export function imageApiUrl(id, params) {
  const url = new URL(API_URL);
  url.searchParams.set('prompt', params.prompt);
  url.searchParams.set('format', 'json');
  url.searchParams.set('id', id);
  for (const key of ['resolution', 'guidanceScale', 'negativePrompt', 'seed', 'removeBackground']) {
    if (params[key] !== undefined) url.searchParams.set(key, String(params[key]));
  }
  return url.href;
}

export function isImageMessage(event, id) {
  let origin;
  try { origin = new URL(event.origin); } catch { return false; }
  return origin.protocol === 'https:' && (origin.hostname === 'perchance.org' || origin.hostname.endsWith('.perchance.org')) && event.data?.api === 'perchance-image-api' && event.data?.result?.id === id;
}

export function generateInFrame({ id, params, container, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.title = 'Perchance image generation';
    frame.referrerPolicy = 'no-referrer';
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal.removeEventListener('abort', onAbort);
      frame.remove();
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (event) => {
      if (isImageMessage(event, id)) finish(null, event.data.result);
    };
    const onAbort = () => finish(new Error('Request cancelled.'));
    if (signal.aborted) { onAbort(); return; }
    window.addEventListener('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Perchance timed out. Check the visible frame for a verification prompt or upstream error.')), timeoutMs);
    frame.src = imageApiUrl(id, params);
    container.replaceChildren(frame);
  });
}
