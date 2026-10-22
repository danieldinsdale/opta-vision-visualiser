// UI wiring of the page (main.js) against a stubbed browser: jsdom for the DOM, a fake Worker that
// runs the real pipeline, and a fake fetch for the data files and the optional local server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildMatchPayload } from '../lib/pipeline.js';
import { fixture } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8').replace(/<script[^>]*src="main.js"[^>]*><\/script>/, '');
let version = 0;

const fakeFile = (name, buf) => ({ name, size: buf.length, arrayBuffer: async () => new Uint8Array(buf).buffer });
const pick = (window, id, file) => {
  const el = window.document.getElementById(id);
  Object.defineProperty(el, 'files', { value: [file], configurable: true });
  el.dispatchEvent(new window.Event('change'));
};
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

class FakeWorker {
  postMessage({ inputs, options }) {
    buildMatchPayload(inputs, options, (text) => this.onmessage({ data: { type: 'progress', text } }))
      .then((r) => this.onmessage({ data: { type: 'done', ...r } }))
      .catch((e) => this.onmessage({ data: { type: 'error', message: e.name === 'InputError' ? e.message : 'Unexpected error' } }));
  }
  terminate() {}
}

async function boot(apiHandler) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8765/' });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document, Worker: FakeWorker });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('api/')) return apiHandler(u, init);
    return new Response(readFileSync(join(root, u)), { status: 200 });
  };
  await import(`../main.js?v=${++version}`);
  await new Promise((r) => setTimeout(r, 20));
  return window;
}
const notFound = () => new Response('nope', { status: 404 });
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

test('static hosting: files enable Load; payload reaches the frame', async () => {
  const window = await boot(notFound);
  const $ = (id) => window.document.getElementById(id);
  assert.equal($('load-btn').disabled, true);
  pick(window, 'f-txt', fakeFile('a_epts_raw_data.txt', fixture('raw.txt')));
  assert.equal($('load-btn').disabled, true);                       // needs the spec too
  pick(window, 'f-xml', fakeFile('a_epts_format_specification.xml', fixture('spec.xml')));
  pick(window, 'f-events', fakeFile('events.json', fixture('events.json')));
  assert.equal($('load-btn').disabled, false);
  $('load-btn').click();
  await until(() => window.OPTA_PAYLOAD);
  assert.ok(window.OPTA_PAYLOAD.frameIds.length > 0);
  assert.ok(window.OPTA_PAYLOAD.events.length > 0);
  assert.equal($('frame').hidden, false);
  assert.match($('frame').src, /animation\/frame\.html/);
  assert.equal($('empty').hidden, true);
  assert.equal($('status').textContent, '');
});

test('a bad file shows a readable error and keeps the page usable', async () => {
  const window = await boot(notFound);
  const $ = (id) => window.document.getElementById(id);
  pick(window, 'f-txt', fakeFile('x.txt', Buffer.from('not tracking data\n')));
  pick(window, 'f-xml', fakeFile('x.xml', fixture('spec.xml')));
  $('load-btn').click();
  await until(() => $('status').textContent.includes('could not be parsed'));
  assert.ok($('status').classList.contains('error'));
  assert.equal($('frame').hidden, true);
});

test('invalid VOD URLs are rejected before loading', async () => {
  const window = await boot(notFound);
  const $ = (id) => window.document.getElementById(id);
  $('vod-1').value = 'javascript:alert(1)';
  pick(window, 'f-txt', fakeFile('a.txt', fixture('raw.txt')));
  pick(window, 'f-xml', fakeFile('a.xml', fixture('spec.xml')));
  $('load-btn').click();
  await until(() => $('status').classList.contains('error'));
  assert.match($('status').textContent, /https/);
  assert.equal($('frame').hidden, true);
});

test('with the local server: SDAPI panel, per-feed status, one-click fetch and show', async () => {
  const seen = [];
  const window = await boot(async (u, init) => {
    seen.push(u);
    if (u === 'api/config') return json({ sdapi: true, cacheDir: 'data/sdapi_cache' });
    if (u === 'api/fetch') {
      assert.equal(JSON.parse(init.body).gameId, 'abcdefghij1234');
      return json({
        statuses: [
          { label: 'EPTS tracking', state: 'ok', cached: true }, { label: 'Events', state: 'ok', cached: false },
          { label: 'Lineup and kit colours', state: 'failed', detail: 'matchstats: HTTP 403 for https://x/<API_OUTLET_KEY>/id' },
          { label: 'Phases of play', state: 'skipped' }, { label: 'Player runs', state: 'skipped' }],
        files: { raw: true, spec: true, events: true, matchstats: false, phases: false, runs: false }, cached: true,
      });
    }
    const name = u.split('/').pop();
    const file = { raw: 'raw.txt', spec: 'spec.xml', events: 'events.json' }[name];
    return new Response(fixture(file), { status: 200 });
  });
  const $ = (id) => window.document.getElementById(id);
  assert.equal($('mode-switch').hidden, false);
  assert.equal($('sdapi-panel').hidden, true);
  $('mode-sdapi').click();
  assert.equal($('sdapi-panel').hidden, false);
  assert.equal($('local-panel').hidden, true);
  assert.equal($('feeds').children.length, 5);
  $('game-id').value = 'abcdefghij1234';
  $('game-id').dispatchEvent(new window.Event('input'));
  $('fetch-btn').click();
  await until(() => window.OPTA_PAYLOAD);
  const rows = [...$('feeds').children];
  assert.equal(rows[0].className, 'ok'); assert.match(rows[0].textContent, /cached/);
  assert.equal(rows[1].className, 'ok'); assert.match(rows[1].textContent, /loaded/);
  assert.equal(rows[2].className, 'bad'); assert.match(rows[2].textContent, /HTTP 403/);
  assert.ok(rows[2].title.includes('<API_OUTLET_KEY>'));            // the masked URL, never the key
  assert.equal($('frame').hidden, false);
  assert.equal($('delete-cache').hidden, false);
  assert.ok(seen.includes('api/file/abcdefghij1234/raw'));
});

test('sidebar can be hidden and shown again', async () => {
  const window = await boot(notFound);
  const $ = (id) => window.document.getElementById(id);
  assert.equal($('side-open').hidden, true);
  $('side-close').click();
  assert.equal(window.document.body.classList.contains('side-collapsed'), true);
  assert.equal($('side-open').hidden, false);
  $('side-open').click();
  assert.equal(window.document.body.classList.contains('side-collapsed'), false);
  assert.equal($('side-open').hidden, true);
});

test('static hosting: SDAPI is offered, server-only controls are hidden, key is never stored', async () => {
  const window = await boot(notFound);
  const $ = (id) => window.document.getElementById(id);
  assert.equal($('mode-switch').hidden, false);
  for (const el of window.document.querySelectorAll('.server-only')) assert.equal(el.hidden, true);
  $('mode-sdapi').click();
  $('game-id').value = 'abcdefghij1234';
  $('api-key').value = 'secretkey12345';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new TypeError('Failed to fetch'); };   // as when CORS blocks the request
  $('fetch-btn').click();
  await until(() => $('status').textContent.includes('could not be fetched'));
  globalThis.fetch = realFetch;
  assert.ok(calls[0].startsWith('https://api.performfeeds.com/soccerdata/remotematchtrackingepts/secretkey12345/abcdefghij1234'));
  assert.ok(!window.document.body.textContent.includes('secretkey12345'));
  assert.ok(![...window.document.querySelectorAll('[title]')].some((e) => e.title.includes('secretkey12345')));   // masked in errors
  assert.equal(window.localStorage.length, 0);
});
