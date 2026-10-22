// Browser SDAPI client: validation, masked errors, size cap, redirects refused, never leaks the key.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { BrowserSdapiClient, SdapiError, fetchMatchInBrowser, normaliseDownloadUrl, validateApiKey } from '../lib/sdapi-client.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const KEY = 'secretkey12345', GAME = 'abcdefghij1234';
const ok = (body) => new Response(body, { status: 200 });

test('keys, ids and links are validated', () => {
  for (const bad of ['', 'short', 'a/b/c/d/e/f/g/h', 'has space1234', null]) assert.throws(() => validateApiKey(bad), SdapiError);
  assert.throws(() => new BrowserSdapiClient('bad'), SdapiError);
  assert.equal(normaliseDownloadUrl('http://x.example/a'), 'https://x.example/a');
  assert.equal(normaliseDownloadUrl('//x.example/a'), 'https://x.example/a');
  for (const bad of ['ftp://x.example/a', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@x.example/a', 'nonsense']) assert.throws(() => normaliseDownloadUrl(bad), SdapiError, bad);
});

test('requests carry no cookies or referrer and refuse redirects', async () => {
  let init;
  globalThis.fetch = async (u, i) => { init = i; return ok('{}'); };
  await new BrowserSdapiClient(KEY).getFeed('remoteevents', GAME);
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer');
});

test('blocked, failing and non-JSON responses give masked errors', async () => {
  const client = new BrowserSdapiClient(KEY);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => client.getFeed('remoteevents', GAME), (e) => e instanceof SdapiError && /blocked by the browser/.test(e.message) && !e.message.includes(KEY) && e.message.includes('<API_OUTLET_KEY>'));
  globalThis.fetch = async () => new Response('no', { status: 403 });
  await assert.rejects(() => client.getFeed('remoteevents', GAME), (e) => /HTTP 403/.test(e.message) && !e.message.includes(KEY));
  globalThis.fetch = async () => ok('<html>');
  await assert.rejects(() => client.getFeed('remoteevents', GAME), /not JSON/);
});

test('whole match: tracking required, optional feeds fail independently', async () => {
  const epts = JSON.stringify({ trackingFiles: { fps25: { metadata: { value: 'https://files.example/spec.xml' }, trackingData: { value: 'http://files.example/raw.txt' } } } });
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    if (u.includes('remotematchtrackingepts')) return ok(epts);
    if (u.includes('files.example/raw')) return ok('RAW');
    if (u.includes('files.example/spec')) return ok('SPEC');
    if (u.includes('remoteevents')) return ok('{"e":1}');
    return new Response('x', { status: 403 });
  };
  const r = await fetchMatchInBrowser(KEY, GAME, { events: true, matchstats: true });
  assert.equal(new TextDecoder().decode(r.files.raw), 'RAW');
  assert.ok(seen.every((u) => u.startsWith('https://')));
  const by = Object.fromEntries(r.statuses.map((s) => [s.label, s.state]));
  assert.deepEqual([by['EPTS tracking'], by.Events, by['Lineup and kit colours'], by['Phases of play']], ['ok', 'ok', 'failed', 'skipped']);
  globalThis.fetch = async () => new Response('x', { status: 403 });
  const bad = await fetchMatchInBrowser(KEY, GAME, { events: true });
  assert.equal(bad.files, null); assert.equal(bad.statuses[0].state, 'failed');
});
