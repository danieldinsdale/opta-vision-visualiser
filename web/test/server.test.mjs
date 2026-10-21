// The optional local server: same-origin only, allow-listed files, validated ids, cache served
// without any network access (no outlet key is configured in tests, so SDAPI itself is off).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSecrets } from '../server/sdapi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GAME = 'abcdefghij1234';
const port = 20000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
const cacheDir = mkdtempSync(join(tmpdir(), 'ovv-cache-'));
let proc;

before(async () => {
  mkdirSync(join(cacheDir, GAME), { recursive: true });
  copyFileSync(join(here, 'fixtures', 'raw.txt'), join(cacheDir, GAME, 'epts_raw_data.txt'));
  copyFileSync(join(here, 'fixtures', 'spec.xml'), join(cacheDir, GAME, 'epts_format_specification.xml'));
  copyFileSync(join(here, 'fixtures', 'events.json'), join(cacheDir, GAME, 'remoteevents.json'));
  proc = spawn(process.execPath, [join(here, '..', 'server', 'server.mjs')], {
    env: { ...process.env, OPTA_VISUALISER_PORT: String(port), OPTA_VISUALISER_CACHE_DIR: cacheDir, OPTA_VISUALISER_SECRETS_FILE: join(cacheDir, 'no-secrets.toml') }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => String(d).includes('http://') && resolve()));
});
after(() => { proc.kill(); rmSync(cacheDir, { recursive: true, force: true }); });

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body),
});

test('serves the page and only allow-listed files', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/animation/frame.html`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/three.min.js`)).status, 200);
  for (const hidden of ['/server/server.mjs', '/package.json', '/test/fixtures/raw.txt', '/..%2f..%2f.streamlit/secrets.toml', '/lib/../server/sdapi.mjs']) {
    assert.equal((await fetch(base + hidden)).status, 404, hidden);
  }
  const r = await fetch(`${base}/`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('config reports SDAPI off without a key and never exposes secrets', async () => {
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.sdapi, false);
  assert.deepEqual(Object.keys(cfg).sort(), ['cacheDir', 'sdapi']);
});

test('rejects foreign Host headers (DNS rebinding) and cross-site posts', async () => {
  const res = await new Promise((resolve) => {
    import('node:http').then(({ default: http }) => http.get({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'evil.example' } }, resolve));
  });
  assert.equal(res.statusCode, 421);
  assert.equal((await post('/api/fetch', { gameId: GAME }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/fetch', { gameId: GAME }, { 'Content-Type': 'text/plain' })).status, 403);
});

test('validates game ids and file names', async () => {
  assert.equal((await post('/api/fetch', { gameId: '../etc/passwd' })).status, 400);
  assert.equal((await fetch(`${base}/api/file/${GAME}/..%2f..%2fsecrets`)).status, 400);
  assert.equal((await fetch(`${base}/api/file/short/raw`)).status, 400);
});

test('serves cached files with per-feed status and no network', async () => {
  const res = await (await post('/api/fetch', { gameId: GAME, want: { events: true, matchstats: true }, useCache: true })).json();
  const by = Object.fromEntries(res.statuses.map((s) => [s.label, s]));
  assert.equal(by['EPTS tracking'].state, 'ok'); assert.equal(by['EPTS tracking'].cached, true);
  assert.equal(by.Events.state, 'ok'); assert.equal(by.Events.cached, true);
  assert.equal(by['Lineup and kit colours'].state, 'failed');                 // not cached, no key
  assert.match(by['Lineup and kit colours'].detail, /no API key/);
  assert.equal(res.files.raw, true); assert.equal(res.files.matchstats, false); assert.equal(res.cached, true);
  const raw = Buffer.from(await (await fetch(`${base}/api/file/${GAME}/raw`)).arrayBuffer());
  assert.ok(raw.length > 1000);
});

test('without a cache and key, tracking fails cleanly', async () => {
  const res = await (await post('/api/fetch', { gameId: 'zzzzzzzzzz9999', want: {}, useCache: true })).json();
  assert.equal(res.statuses[0].state, 'failed');
  assert.equal(res.files.raw, false);
});

test('delete removes the cached files', async () => {
  assert.equal((await post('/api/cache/delete', { gameId: GAME })).status, 200);
  const res = await (await post('/api/fetch', { gameId: GAME, want: {}, useCache: true })).json();
  assert.equal(res.statuses[0].state, 'failed');
});

test('secrets.toml parsing reads quoted values and ignores comments', () => {
  const s = parseSecrets('# note\nAPI_OUTLET_KEY = "abc123"  # trailing\nAPI_REFERER=\'www.example.com\'\nOTHER = 5\n');
  assert.deepEqual(s, { API_OUTLET_KEY: 'abc123', API_REFERER: 'www.example.com' });
  assert.deepEqual(parseSecrets(''), {});
});
