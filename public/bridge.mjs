import { generateInFrame, warmUpFrame } from './perchance.mjs';

const el = (id) => document.getElementById(id);
let events;
let current;
let completed = 0;
let warmedUp = false;
let processing = Promise.resolve();
const cancelled = new Set();
el('endpoint').textContent = `${location.origin}/v1/images/generations`;

function showError(message) {
  el('error').textContent = message;
  el('error').hidden = !message;
}

function setConnected(connected) {
  el('status').textContent = connected ? '\u0110\u00e3 k\u1ebft n\u1ed1i' : 'Ch\u01b0a k\u1ebft n\u1ed1i';
  el('status').dataset.connected = String(connected);
  el('connect').disabled = connected;
  el('disconnect').disabled = !connected;
}

async function post(path, data, headers = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  return result;
}

async function runJob(job) {
  if (!events || cancelled.delete(job.id)) return;
  const controller = new AbortController();
  current = { id: job.id, controller };
  el('activity').textContent = '\u0110ang t\u1ea1o \u1ea3nh';
  showError('');
  let result;
  try {
    result = await generateInFrame({ ...job, container: el('frame-container'), signal: controller.signal });
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  if (!controller.signal.aborted) {
    try {
      await post('/worker/result', { id: job.id, result });
      if (result.ok) {
        completed += 1;
        el('count').textContent = String(completed);
      } else showError(result.error || 'Perchance kh\u00f4ng tr\u1ea3 v\u1ec1 \u1ea3nh.');
    } catch (error) { showError(error.message); }
  }
  current = null;
  el('activity').textContent = events ? '\u0110ang ch\u1edd y\u00eau c\u1ea7u' : '\u0110\u00e3 ng\u1eaft k\u1ebft n\u1ed1i';
}

function disconnect() {
  events?.close();
  events = null;
  current?.controller.abort();
  setConnected(false);
  el('activity').textContent = '\u0110\u00e3 ng\u1eaft k\u1ebft n\u1ed1i';
}

el('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  el('connect').disabled = true;
  showError('');
  try {
    const apiKey = el('api-key').value;
    await post('/worker/connect', {}, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    el('api-key').value = '';
    if (!warmedUp) {
      el('activity').textContent = '\u0110ang kh\u1edfi t\u1ea1o phi\u00ean Perchance';
      await warmUpFrame(el('frame-container'));
      warmedUp = true;
    }
    events = new EventSource('/worker/events');
    events.addEventListener('ready', () => {
      setConnected(true);
      el('activity').textContent = '\u0110ang ch\u1edd y\u00eau c\u1ea7u';
    });
    events.addEventListener('job', (event) => {
      const job = JSON.parse(event.data);
      processing = processing.then(() => runJob(job)).catch((error) => showError(error.message));
    });
    events.addEventListener('cancel', (event) => {
      const id = JSON.parse(event.data).id;
      if (current?.id === id) current.controller.abort();
      else cancelled.add(id);
    });
    events.onerror = () => {
      disconnect();
      showError('K\u1ebft n\u1ed1i b\u1ecb ng\u1eaft ho\u1eb7c m\u1ed9t trang bridge kh\u00e1c \u0111ang ho\u1ea1t \u0111\u1ed9ng.');
    };
  } catch (error) {
    setConnected(false);
    showError(error.message);
  }
});
el('disconnect').addEventListener('click', disconnect);
window.addEventListener('pagehide', disconnect);
