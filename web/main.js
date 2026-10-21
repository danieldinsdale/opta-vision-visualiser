// Page logic: choose files (or fetch via the optional local server), parse in a worker, hand the
// payload to the animation frame. Everything runs in the browser; files are never uploaded.
import { MAX_INPUT_BYTES } from './lib/limits.js';
import { getVodUrls, validateStreamUrl } from './vod-provider.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), warnings: $('warnings'), frame: $('frame'), empty: $('empty'), emptyText: $('empty-text'),
  loadBtn: $('load-btn'), bundle: $('f-bundle'), txt: $('f-txt'), xml: $('f-xml'),
  events: $('f-events'), stats: $('f-stats'), phases: $('f-phases'), runs: $('f-runs'),
  modeSwitch: $('mode-switch'), modeLocal: $('mode-local'), modeSdapi: $('mode-sdapi'),
  localPanel: $('local-panel'), sdapiPanel: $('sdapi-panel'),
};

let busy = false;
const setStatus = (text, isError = false) => { els.status.textContent = text; els.status.classList.toggle('error', isError); };
const setWarnings = (list) => { els.warnings.replaceChildren(...list.map((w) => Object.assign(document.createElement('li'), { textContent: w }))); };

// ── Shared: bytes -> worker -> animation frame ────────────────────────────────

let cachedStatic = null;
async function staticOptions() {
  if (cachedStatic) return cachedStatic;
  const [types, quals, ball] = await Promise.all([
    fetch('data/event_type_names.json').then((r) => r.json()),
    fetch('data/qualifier_names.json').then((r) => r.json()),
    fetch('data/ball.svg').then((r) => r.arrayBuffer()),
  ]);
  let bin = '';
  for (const b of new Uint8Array(ball)) bin += String.fromCharCode(b);
  cachedStatic = { names: { eventTypes: types.event_types, qualifiers: quals.qualifiers }, ballImage: `data:image/svg+xml;base64,${btoa(bin)}` };
  return cachedStatic;
}

async function readVodUrls(matchContext) {
  const urls = {};
  const provided = await getVodUrls(matchContext).catch(() => null);
  for (const [p, u] of Object.entries(provided || {})) urls[p] = validateStreamUrl(u);
  for (const p of [1, 2]) {
    const v = $(`vod-${p}`).value.trim();
    if (v) urls[p] = validateStreamUrl(v);
  }
  return urls;
}

function runWorker(inputs, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') setStatus(`${data.text}...`);
      else { worker.terminate(); data.type === 'done' ? resolve(data) : reject(new Error(data.message)); }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('The data could not be processed in this browser.')); };
    const transfer = Object.values(inputs).filter((v) => v instanceof Uint8Array).map((v) => v.buffer);
    worker.postMessage({ inputs, options }, transfer);
  });
}

async function loadMatch(inputs) {
  if (busy) return;
  busy = true;
  setWarnings([]);
  try {
    const vodUrls = await readVodUrls({ matchUuid: '', periods: [1, 2] });
    const { payload, warnings } = await runWorker(inputs, { ...(await staticOptions()), vodUrls });
    window.OPTA_PAYLOAD = payload;                 // read by the animation frame (same origin)
    els.frame.src = `animation/frame.html?load=${Date.now()}`;
    els.frame.hidden = false;
    els.empty.hidden = true;
    setWarnings(warnings);
    setStatus('');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    busy = false;
  }
}

async function bytesOf(file) {
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name} is larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB`);
  return new Uint8Array(await file.arrayBuffer());
}

// ── Local files ───────────────────────────────────────────────────────────────

const refreshLoadButton = () => { els.loadBtn.disabled = !(els.bundle.files[0] || (els.txt.files[0] && els.xml.files[0])); };
for (const el of [els.bundle, els.txt, els.xml]) el.addEventListener('change', refreshLoadButton);

els.loadBtn.addEventListener('click', async () => {
  try {
    setStatus('Reading files...');
    const optional = { events: els.events, matchstats: els.stats, phases: els.phases, runs: els.runs };
    const inputs = {};
    if (els.bundle.files[0]) inputs.bundle = await bytesOf(els.bundle.files[0]);
    else { inputs.txt = await bytesOf(els.txt.files[0]); inputs.xml = await bytesOf(els.xml.files[0]); }
    for (const [key, el] of Object.entries(optional)) if (el.files[0]) inputs[key] = await bytesOf(el.files[0]);
    await loadMatch(inputs);
  } catch (e) { setStatus(e.message, true); }
});

// ── Optional SDAPI (only when the local server is running) ────────────────────

const FEEDS = [
  { key: 'epts', label: 'EPTS tracking (required)', fixed: true },
  { key: 'events', label: 'Events', on: true },
  { key: 'matchstats', label: 'Lineup and kit colours', on: true },
  { key: 'phases', label: 'Phases of play', on: false },
  { key: 'runs', label: 'Player runs', on: false },
];
const STATUS_NAMES = { epts: 'EPTS tracking', events: 'Events', matchstats: 'Lineup and kit colours', phases: 'Phases of play', runs: 'Player runs' };
let feedStatus = null;   // {gameId, statuses}

function renderFeeds() {
  const gameId = $('game-id').value.trim();
  const byLabel = feedStatus && feedStatus.gameId === gameId ? Object.fromEntries(feedStatus.statuses.map((s) => [s.label, s])) : {};
  const old = Object.fromEntries([...document.querySelectorAll('#feeds input')].map((i) => [i.dataset.key, i.checked]));
  els.feedList = els.feedList || $('feeds');
  els.feedList.replaceChildren(...FEEDS.map((f) => {
    const li = document.createElement('li');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: f.fixed ? true : (old[f.key] ?? f.on), disabled: !!f.fixed });
    box.dataset.key = f.key;
    const name = document.createElement('span');
    const tag = Object.assign(document.createElement('span'), { className: 'tag' });
    const s = byLabel[STATUS_NAMES[f.key]];
    name.textContent = f.label;
    if (s && s.state === 'ok') { li.className = 'ok'; tag.textContent = s.cached ? 'cached' : 'loaded'; }
    else if (s && s.state === 'failed') { li.className = 'bad'; tag.textContent = (/HTTP (\d{3})/.exec(s.detail) || [, 'error'])[0]; li.title = s.detail; }
    li.append(box, name, tag);
    return li;
  }));
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (HTTP ${res.status})`);
  return res;
}

async function fetchFromSdapi() {
  const gameId = $('game-id').value.trim();
  if (!gameId) { setStatus('Enter an Opta Game UUID first.', true); return; }
  const want = Object.fromEntries([...document.querySelectorAll('#feeds input')].filter((i) => !i.disabled).map((i) => [i.dataset.key, i.checked]));
  try {
    setStatus('Fetching from SDAPI...');
    const res = await (await api('api/fetch', { gameId, want, useCache: $('use-cache').checked, refresh: $('refresh').checked })).json();
    feedStatus = { gameId, statuses: res.statuses };
    renderFeeds();
    $('delete-cache').hidden = !(res.cached && $('use-cache').checked);
    if (!res.files.raw) { setStatus('EPTS tracking could not be fetched. Hover a red row for details.', true); return; }
    const inputs = {};
    setStatus('Downloading from the local server...');
    const get = async (name) => new Uint8Array(await (await api(`api/file/${encodeURIComponent(gameId)}/${name}`)).arrayBuffer());
    inputs.txt = await get('raw'); inputs.xml = await get('spec');
    for (const key of ['events', 'matchstats', 'phases', 'runs']) if (res.files[key]) inputs[key] = await get(key);
    await loadMatch(inputs);                      // one click: fetch and show
  } catch (e) { setStatus(e.message, true); }
}

function setMode(sdapi) {
  els.localPanel.hidden = sdapi; els.sdapiPanel.hidden = !sdapi;
  els.modeLocal.classList.toggle('on', !sdapi); els.modeSdapi.classList.toggle('on', sdapi);
  els.modeLocal.setAttribute('aria-selected', String(!sdapi)); els.modeSdapi.setAttribute('aria-selected', String(sdapi));
  els.emptyText.textContent = sdapi
    ? 'Enter an Opta Game UUID in the sidebar and click Fetch from SDAPI.'
    : 'Choose an EPTS dataset in the sidebar, then click Load data.';
}

async function initSdapi() {
  let config;
  try {
    const res = await fetch('api/config');
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;   // static hosting: no server
    config = await res.json();
  } catch { return; }
  if (!config.sdapi) return;
  els.modeSwitch.hidden = false;
  $('cache-note').textContent = `Cache folder: ${config.cacheDir}`;
  renderFeeds();
  $('game-id').addEventListener('input', renderFeeds);
  els.modeLocal.addEventListener('click', () => setMode(false));
  els.modeSdapi.addEventListener('click', () => setMode(true));
  $('fetch-btn').addEventListener('click', fetchFromSdapi);
  $('delete-cache').addEventListener('click', async () => {
    try { await api('api/cache/delete', { gameId: $('game-id').value.trim() }); feedStatus = null; renderFeeds(); $('delete-cache').hidden = true; setStatus('Cached files deleted.'); }
    catch (e) { setStatus(e.message, true); }
  });
}

initSdapi();
