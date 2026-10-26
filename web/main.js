// Page logic: choose files (or fetch via the optional local server), parse in a worker, hand the
// payload to the animation frame. Everything runs in the browser; files are never uploaded.
import { MAX_INPUT_BYTES } from './lib/limits.js';
import { EPTS_TXT_SUFFIX, EPTS_XML_SUFFIX } from './lib/archive.js';
import { classifyName, scanFiles, summarise } from './lib/package.js';
import { getVodUrls, validateStreamUrl } from './vod-provider.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), warnings: $('warnings'), frame: $('frame'), empty: $('empty'), emptyText: $('empty-text'),
  loadBtn: $('load-btn'), bundle: $('f-bundle'), txt: $('f-txt'), xml: $('f-xml'),
  events: $('f-events'), stats: $('f-stats'), phases: $('f-phases'), runs: $('f-runs'),
  modeSwitch: $('mode-switch'), modePkg: $('mode-pkg'), modeLocal: $('mode-local'), modeSdapi: $('mode-sdapi'),
  pkgPanel: $('pkg-panel'), localPanel: $('local-panel'), sdapiPanel: $('sdapi-panel'),
};

// Sidebar show/hide
function setSidebar(open) {
  document.body.classList.toggle('side-collapsed', !open);
  $('side-open').hidden = open;
  $('side-close').setAttribute('aria-expanded', String(open));
  $('side-open').setAttribute('aria-expanded', String(open));
  (open ? $('side-close') : $('side-open')).focus();
}
$('side-close').addEventListener('click', () => setSidebar(false));
$('side-open').addEventListener('click', () => setSidebar(true));

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
  if (busy) return false;
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
    return true;
  } catch (e) {
    setStatus(e.message, true);
    return false;
  } finally {
    busy = false;
  }
}

async function bytesOf(file) {
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name} is larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB`);
  return new Uint8Array(await file.arrayBuffer());
}

// ── Data package and own files ────────────────────────────────────────────────
// Whatever the user gives us (a zip, a tar.gz, loose files, a folder) is searched by file name for the
// tracking data and the optional feeds, so they never have to say which file is which.

const MAX_DROPPED_FILES = 2000;
const FORCED_NAMES = {
  txt: `manual${EPTS_TXT_SUFFIX}`, xml: `manual${EPTS_XML_SUFFIX}`, events: 'remoteevents.json',
  matchstats: 'matchstats.json', phases: 'remotephasesofplay.json', runs: 'remoteplayerruns.json',
};

async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (out.length > MAX_DROPPED_FILES) throw new Error('That folder contains too many files.');
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function renderResult(host, { title, meta, summary, busy }) {
  const card = Object.assign(document.createElement('div'), { className: 'pkg-card' });
  card.append(Object.assign(document.createElement('div'), { className: 'pkg-name', textContent: title }),
    Object.assign(document.createElement('div'), { className: 'pkg-meta', textContent: meta }));
  if (busy) {
    const bar = Object.assign(document.createElement('div'), { className: 'bar' });
    bar.append(document.createElement('i'));
    card.append(bar);
  }
  if (summary) {
    const ul = document.createElement('ul');
    for (const it of summary.items) {
      const li = document.createElement('li');
      const mark = Object.assign(document.createElement('span'), { className: `mark ${it.state}`, textContent: it.state === 'found' ? '✓' : it.state === 'absent' ? '–' : '!' });
      const tag = Object.assign(document.createElement('span'), { className: 'tag', textContent: it.note || '' });
      li.title = it.name || '';
      li.append(mark, Object.assign(document.createElement('span'), { textContent: it.label }), tag);
      ul.append(li);
    }
    card.append(ul);
  }
  host.replaceChildren(card);
  if (summary) {
    for (const e of summary.errors) host.append(Object.assign(document.createElement('div'), { className: 'notice err', textContent: e }));
    for (const n of summary.notes) host.append(Object.assign(document.createElement('div'), { className: /different match|More than one/.test(n) ? 'notice warn' : 'notice', textContent: n }));
  }
  host.hidden = false;
}

function describeFiles(files) {
  const total = files.reduce((a, f) => a + f.size, 0);
  const size = total >= 1024 * 1024 ? `${(total / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(total / 1024))} KB`;
  return { title: files.length === 1 ? files[0].name : `${files.length} files`, meta: size };
}

// One state per panel. Newest files go first, so choosing a replacement file wins over an earlier one.
function makePanel({ host, drop, input, autoLoad }) {
  const state = { staged: [], summary: null, chain: Promise.resolve() };
  async function run(fileList, role) {
    const files = [...fileList];
    if (!files.length) return;
    const { title, meta } = describeFiles(files);
    renderResult(host, { title, meta: `${meta} · Unpacking…`, busy: true });
    setStatus('');
    try {
      const fresh = [];
      for (const f of files) {
        const own = f.webkitRelativePath || f.name;
        // a file chosen in a specific picker counts as that item even if its name is not the usual one
        const c = classifyName(own);
        fresh.push({ name: role && !(c && c.role === role) ? FORCED_NAMES[role] : own, bytes: await bytesOf(f), size: f.size });
      }
      const names = new Set(fresh.map((f) => f.name));
      state.staged = [...fresh, ...state.staged.filter((f) => !names.has(f.name))];
      const summary = summarise(await scanFiles(state.staged));
      state.summary = summary;
      const all = describeFiles(state.staged);
      renderResult(host, { title: all.title, meta: all.meta, summary });
      if (autoLoad && summary.ready) {
        host.querySelector('.pkg-meta').textContent = `${all.meta} · Loading…`;
        const ok = await loadMatch(summary.inputs);
        host.querySelector('.pkg-meta').textContent = `${all.meta} · ${ok ? 'Loaded. Drop another package any time to replace it.' : 'Could not be loaded'}`;
      }
    } catch (e) {
      state.summary = null;
      renderResult(host, { title, meta, summary: { items: [], errors: [e.message], notes: [] } });
    }
    state.onChange && state.onChange(state.summary);
  }
  input.addEventListener('change', () => { state.stage(input.files); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'dragend']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    try { state.stage(await filesFromDrop(e.dataTransfer)); } catch (err) { setStatus(err.message, true); }
  });
  state.stage = (fileList, role) => { const files = [...fileList]; state.chain = state.chain.then(() => run(files, role)); return state.chain; };
  return state;
}

const pkgPanel = makePanel({ host: $('pkg-result'), drop: $('pkg-drop'), input: $('f-package'), autoLoad: true });
const ownPanel = makePanel({ host: $('own-result'), drop: $('own-drop'), input: $('f-own'), autoLoad: false });
ownPanel.onChange = (summary) => { els.loadBtn.disabled = !(summary && summary.ready); };
// The individual pickers feed the same staging, so the checklist and the load button stay in step
for (const [el, role] of [[els.bundle, null], [els.txt, 'txt'], [els.xml, 'xml'], [els.events, 'events'], [els.stats, 'matchstats'], [els.phases, 'phases'], [els.runs, 'runs']]) {
  el.addEventListener('change', () => { ownPanel.stage(el.files, role); });
}

els.loadBtn.addEventListener('click', async () => {
  if (ownPanel.summary && ownPanel.summary.ready) await loadMatch(ownPanel.summary.inputs);
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
  if (!$('api-key').value.trim() && !$('use-cache').checked) { setStatus('Enter your SDAPI key first.', true); return; }
  const want = Object.fromEntries([...document.querySelectorAll('#feeds input')].filter((i) => !i.disabled).map((i) => [i.dataset.key, i.checked]));
  try {
    setStatus('Fetching from SDAPI...');
    const res = await (await api('api/fetch', { gameId, apiKey: $('api-key').value.trim(), referral: $('api-referral').value.trim(), want, useCache: $('use-cache').checked, refresh: $('refresh').checked })).json();
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

function setMode(mode) {
  const panels = { pkg: els.pkgPanel, local: els.localPanel, sdapi: els.sdapiPanel };
  const tabs = { pkg: els.modePkg, local: els.modeLocal, sdapi: els.modeSdapi };
  for (const k of Object.keys(panels)) {
    panels[k].hidden = k !== mode;
    tabs[k].classList.toggle('on', k === mode);
    tabs[k].setAttribute('aria-selected', String(k === mode));
  }
  els.emptyText.textContent = {
    pkg: 'Drop your data package into the sidebar to get started.',
    local: 'Drop your match files into the sidebar, then click Load data.',
    sdapi: 'Enter your SDAPI key and an Opta Game UUID in the sidebar, then click Fetch from SDAPI.',
  }[mode];
}
els.modePkg.addEventListener('click', () => setMode('pkg'));
els.modeLocal.addEventListener('click', () => setMode('local'));

async function initSdapi() {
  let config;
  try {
    const res = await fetch('api/config');
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;   // static hosting: no server
    config = await res.json();
  } catch { return; }
  els.modeSdapi.hidden = false;
  $('cache-note').textContent = `Cache folder: ${config.cacheDir}`;
  renderFeeds();
  $('game-id').addEventListener('input', renderFeeds);
  els.modeSdapi.addEventListener('click', () => setMode('sdapi'));
  $('fetch-btn').addEventListener('click', fetchFromSdapi);
  $('delete-cache').addEventListener('click', async () => {
    try { await api('api/cache/delete', { gameId: $('game-id').value.trim() }); feedStatus = null; renderFeeds(); $('delete-cache').hidden = true; setStatus('Cached files deleted.'); }
    catch (e) { setStatus(e.message, true); }
  });
}

initSdapi();
