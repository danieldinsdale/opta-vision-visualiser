// SDAPI client safety and the local cache (no network: fetch is stubbed).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { FeedCache, SdapiClient, SdapiError, checkReferer, fetchMatch, normaliseDownloadUrl, validateGameId } from '../server/sdapi.mjs';

const GAME = 'abcdefghij1234';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const tmp = () => mkdtempSync(join(tmpdir(), 'ovv-'));

test('game ids and referers are validated', () => {
  for (const bad of ['../etc/passwd', 'abc', 'a'.repeat(50), 'id with space1', '', null]) assert.throws(() => validateGameId(bad), SdapiError);
  assert.equal(validateGameId(` ${GAME} `), GAME);
  assert.equal(checkReferer(' www.example.com '), 'www.example.com');
  assert.throws(() => checkReferer('bad\r\nX-Evil: 1'), SdapiError);
  assert.throws(() => new SdapiClient(''), SdapiError);
});

test('download links: http and protocol-relative are upgraded, everything else refused', () => {
  assert.equal(normaliseDownloadUrl('http://files.example.com/a?x=1'), 'https://files.example.com/a?x=1');
  assert.equal(normaliseDownloadUrl('//files.example.com/a'), 'https://files.example.com/a');
  for (const bad of ['ftp://x/y', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url']) assert.throws(() => normaliseDownloadUrl(bad), SdapiError);
});

test('errors never contain the outlet key and refuse unknown feeds', async () => {
  const client = new SdapiClient('SECRETKEY123');
  globalThis.fetch = async () => new Response('denied', { status: 403 });
  await assert.rejects(client.getFeed('remotematchtrackingepts', GAME), (e) => {
    assert.match(e.message, /HTTP 403/);
    assert.ok(e.message.includes('/soccerdata/remotematchtrackingepts/<API_OUTLET_KEY>/'));
    assert.ok(!e.message.includes('SECRETKEY123'));
    return true;
  });
  globalThis.fetch = async () => { throw new TypeError('connect ECONNREFUSED'); };
  await assert.rejects(client.getFeed('remoteevents', GAME), (e) => !e.message.includes('SECRETKEY123'));
  await assert.rejects(client.getFeed('somethingelse', GAME), /Unsupported feed/);
});

test('redirects are refused and the key is never sent as a header', async () => {
  let init;
  globalThis.fetch = async (url, i) => { init = i; return new Response('', { status: 302, headers: { location: 'https://evil.example/' } }); };
  await assert.rejects(new SdapiClient('K12345', 'www.example.com').getFeed('remoteevents', GAME), /HTTP 302/);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Referer, 'www.example.com');
  assert.ok(!JSON.stringify(init.headers).includes('K12345'));
});

// ── fetchMatch with a fake client ─────────────────────────────────────────────

function fakeClient(opts = {}) {
  const calls = [];
  return {
    calls,
    async getEptsFiles() {
      calls.push('epts');
      if (opts.eptsFails) throw new SdapiError('remotematchtrackingepts: HTTP 403 for https://x/<API_OUTLET_KEY>/id');
      return { raw: Buffer.from('raw'), spec: Buffer.from('<xml/>') };
    },
    async getFeed(feed) {
      calls.push(feed);
      if (opts.failFeed === feed) throw new SdapiError(`${feed}: HTTP 500 for https://x/`);
      return Buffer.from(`{"feed":"${feed}"}`);
    },
  };
}
const states = (r) => Object.fromEntries(r.statuses.map((s) => [s.label, s.state]));

test('optional feed failures do not block; tracking failure blocks everything', async () => {
  const ok = await fetchMatch(fakeClient({ failFeed: 'matchstats' }), GAME, { events: true, matchstats: true }, null, false);
  assert.deepEqual(states(ok), { 'EPTS tracking': 'ok', Events: 'ok', 'Lineup and kit colours': 'failed', 'Phases of play': 'skipped', 'Player runs': 'skipped' });
  assert.ok(ok.files.raw && ok.files.events && !ok.files.matchstats);
  const down = await fetchMatch(fakeClient({ eptsFails: true }), GAME, { events: true }, null, false);
  assert.equal(down.files, null);
  assert.equal(states(down)['EPTS tracking'], 'failed');
  assert.equal(states(down).Events, 'skipped');
});

test('cache: second fetch makes no API calls; refresh re-downloads; only missing pieces are fetched', async () => {
  const dir = tmp();
  try {
    const cache = new FeedCache(dir);
    const first = fakeClient();
    await fetchMatch(first, GAME, { events: true }, cache, false);
    assert.deepEqual(first.calls, ['epts', 'remoteevents']);

    const second = fakeClient();
    const r = await fetchMatch(second, GAME, { events: true }, cache, false);
    assert.deepEqual(second.calls, []);
    assert.ok(r.statuses.filter((s) => s.state === 'ok').every((s) => s.cached));

    const third = fakeClient();
    await fetchMatch(third, GAME, { events: true, runs: true }, cache, false);       // runs is new
    assert.deepEqual(third.calls, ['remoteplayerruns']);

    const fourth = fakeClient();
    await fetchMatch(fourth, GAME, { events: true }, cache, true);                   // refresh
    assert.deepEqual(fourth.calls, ['epts', 'remoteevents']);

    const noKey = await fetchMatch(null, GAME, { events: true }, cache, false);      // fully cached: no client needed
    assert.equal(states(noKey).Events, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache: failures are never stored; files are private; traversal is rejected; clear works', async () => {
  const dir = tmp();
  try {
    const cache = new FeedCache(dir);
    await fetchMatch(fakeClient({ failFeed: 'remoteevents' }), GAME, { events: true }, cache, false);
    const names = readdirSync(join(dir, GAME));
    assert.ok(!names.some((n) => n.includes('events')));
    for (const n of names) assert.equal(statSync(join(dir, GAME, n)).mode & 0o077, 0, `${n} must be owner-only`);
    assert.equal(statSync(join(dir, GAME)).mode & 0o077, 0);
    assert.ok(!names.join().includes('SECRET'));
    assert.throws(() => cache.dir('../../etc'), SdapiError);
    assert.equal(await cache.has(GAME), true);
    await cache.clear(GAME);
    assert.equal(await cache.has(GAME), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unwritable cache degrades to no cache instead of failing', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'blocker'), 'a file where the cache folder should be');
    const cache = new FeedCache(join(dir, 'blocker', 'cache'));
    const r = await fetchMatch(fakeClient(), GAME, { events: true }, cache, false);
    assert.equal(states(r)['EPTS tracking'], 'ok');
    assert.ok(r.files.raw);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
