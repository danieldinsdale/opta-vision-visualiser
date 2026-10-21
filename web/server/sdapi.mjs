// Stats Perform SDAPI client + local cache for the optional local server.
// Port of sdapi.py: HTTPS only, redirects refused, allow-listed feeds, validated game ids and
// download hosts, size caps, key never logged or returned (errors show a masked URL).
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export const BASE_URL = 'https://api.performfeeds.com';
export const MAX_INPUT_BYTES = 600 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const ALLOWED_FEEDS = new Set(['remotematchtrackingepts', 'remoteevents', 'matchstats', 'remotephasesofplay', 'remoteplayerruns']);
const GAME_ID_RE = /^[A-Za-z0-9]{10,40}$/;

export class SdapiError extends Error {}

export const OPTIONAL_FEEDS = [
  // [key, display label, feed name]
  ['events', 'Events', 'remoteevents'],
  ['matchstats', 'Lineup and kit colours', 'matchstats'],
  ['phases', 'Phases of play', 'remotephasesofplay'],
  ['runs', 'Player runs', 'remoteplayerruns'],
];
const CACHE_NAMES = { raw: 'epts_raw_data.txt', spec: 'epts_format_specification.xml', events: 'remoteevents.json', matchstats: 'matchstats.json', phases: 'remotephasesofplay.json', runs: 'remoteplayerruns.json' };
export const FILE_KEYS = Object.keys(CACHE_NAMES);

export function validateGameId(gameId) {
  const id = String(gameId ?? '').trim();
  if (!GAME_ID_RE.test(id)) throw new SdapiError('Game id must be 10-40 alphanumeric characters');
  return id;
}

/** Minimal TOML reader for the two string keys we need (KEY = "value" lines; # comments). */
export function parseSecrets(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (m) out[m[1]] = (m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : m[3]).trim();
  }
  return out;
}

export function checkReferer(value) {
  const v = (value || '').trim();
  if (/[\r\n\0]/.test(v) || v.length > 255) throw new SdapiError('API_REFERER contains invalid characters or is too long');
  return v;
}

// ── Outbound request safety ───────────────────────────────────────────────────

const blocked = new net.BlockList();
for (const [net4, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(net6, bits, 'ipv6');

const redact = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}${u.pathname}`; } catch { return '[invalid url]'; } };

export function normaliseDownloadUrl(url) {
  let u = String(url || '').trim();
  if (u.startsWith('//')) u = `https:${u}`;
  else if (/^http:\/\//i.test(u)) u = `https://${u.slice(7)}`;     // upgrade, never fetch in clear text
  let parsed;
  try { parsed = new URL(u); } catch { throw new SdapiError(`Refusing to fetch an unsupported file link: ${redact(u)}`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw new SdapiError(`Refusing to fetch an unsupported file link: ${redact(u)}`);
  return u;
}

async function assertPublicHost(url) {
  const { hostname } = new URL(url);
  let infos;
  try { infos = await dns.lookup(hostname, { all: true }); } catch { throw new SdapiError(`Download host could not be resolved: ${hostname}`); }
  for (const { address, family } of infos) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (blocked.check(mapped ? mapped[1] : address, mapped ? 'ipv4' : `ipv${family}`)) throw new SdapiError(`Refusing to fetch from a non-public address: ${hostname}`);
  }
}

/** GET with an idle timeout, no redirects and a hard size cap. Returns a Buffer. */
async function boundedGet(url, headers, shown, what) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, redirect: 'manual', signal: ac.signal });
    if (res.status !== 200) throw new SdapiError(`${what}: HTTP ${res.status} for ${shown}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      clearTimeout(timer); timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) throw new SdapiError(`${what}: file exceeds the size limit (${shown})`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof SdapiError) throw e;
    throw new SdapiError(`${what}: request failed (${e.name === 'AbortError' ? 'timeout' : e.name}) for ${shown}`);
  } finally { clearTimeout(timer); }
}

export class SdapiClient {
  constructor(outletKey, referer = '') {
    if (!outletKey) throw new SdapiError('No SDAPI outlet key configured (set API_OUTLET_KEY in .streamlit/secrets.toml)');
    this.key = outletKey;
    this.headers = { Accept: 'application/json', ...(referer ? { Referer: referer } : {}) };
  }

  async getFeed(feed, gameId) {
    if (!ALLOWED_FEEDS.has(feed)) throw new SdapiError(`Unsupported feed '${feed}'`);
    const id = validateGameId(gameId);
    const shown = `${BASE_URL}/soccerdata/${feed}/<API_OUTLET_KEY>/${id}?_fmt=json&_rt=c`;   // the only form ever shown or logged
    console.log(`GET ${shown}`);
    const body = await boundedGet(`${BASE_URL}/soccerdata/${feed}/${this.key}/${id}?_fmt=json&_rt=c`, this.headers, shown, feed);
    try { JSON.parse(body.toString('utf8')); } catch { throw new SdapiError(`${feed}: response was not JSON`); }
    return body;
  }

  async download(url) {
    const safe = normaliseDownloadUrl(url);
    await assertPublicHost(safe);
    const shown = redact(safe);
    console.log(`GET ${shown}`);
    return boundedGet(safe, this.headers, shown, 'download');
  }

  async getEptsFiles(gameId) {
    const data = JSON.parse((await this.getFeed('remotematchtrackingepts', gameId)).toString('utf8'));
    const files = data?.trackingFiles?.fps25;
    const metaUrl = files?.metadata?.value, dataUrl = files?.trackingData?.value;
    if (!metaUrl || !dataUrl) throw new SdapiError('EPTS feed has no 25 Hz tracking files for this match');
    return { raw: await this.download(dataUrl), spec: await this.download(metaUrl) };
  }
}

// ── Local cache (one folder per game id; never holds the key) ─────────────────

export class FeedCache {
  constructor(root) { this.root = root; }
  dir(gameId) { return path.join(this.root, validateGameId(gameId)); }       // validated: no separators / traversal
  async get(gameId, key) {
    try {
      const file = path.join(this.dir(gameId), CACHE_NAMES[key]);
      const st = await fs.stat(file);
      return st.isFile() && st.size <= MAX_INPUT_BYTES ? await fs.readFile(file) : null;
    } catch { return null; }
  }
  async put(gameId, key, data) {
    const dir = this.dir(gameId);
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}`);
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, path.join(dir, CACHE_NAMES[key]));
      return true;
    } catch (e) { console.warn(`Could not write cache file ${key} (${e.code || e.name})`); return false; }
  }
  async has(gameId) { try { return (await fs.readdir(this.dir(gameId))).length > 0; } catch { return false; } }
  async clear(gameId) { await fs.rm(this.dir(gameId), { recursive: true, force: true }); }
}

// ── A whole match, with a status per feed for the UI ──────────────────────────

/**
 * Returns {files: {raw, spec, events?, ...: Buffer}, statuses}. ``files`` is null if the EPTS
 * tracking could not be obtained (nothing can be shown without it). Optional feeds fail
 * independently and failed downloads are never cached.
 */
export async function fetchMatch(client, gameId, want, cache, refresh) {
  const useCache = !!cache && !refresh;
  const statuses = [];
  const files = {};
  let raw = useCache ? await cache.get(gameId, 'raw') : null;
  let spec = useCache ? await cache.get(gameId, 'spec') : null;
  const fromCache = !!(raw && spec);
  try {
    if (!fromCache) {
      if (!client) throw new SdapiError('not cached and no API key configured');
      ({ raw, spec } = await client.getEptsFiles(gameId));
      if (cache) { await cache.put(gameId, 'raw', raw); await cache.put(gameId, 'spec', spec); }
    }
    files.raw = raw; files.spec = spec;
    statuses.push({ label: 'EPTS tracking', state: 'ok', detail: '', cached: fromCache });
  } catch (e) {
    if (!(e instanceof SdapiError)) throw e;
    statuses.push({ label: 'EPTS tracking', state: 'failed', detail: e.message, cached: false });
    for (const [key, label] of OPTIONAL_FEEDS) statuses.push({ label, state: 'skipped', detail: want[key] ? 'not fetched (tracking failed)' : 'not requested', cached: false });
    return { files: null, statuses };
  }
  for (const [key, label, feed] of OPTIONAL_FEEDS) {
    if (!want[key]) { statuses.push({ label, state: 'skipped', detail: 'not requested', cached: false }); continue; }
    const hit = useCache ? await cache.get(gameId, key) : null;
    if (hit) { files[key] = hit; statuses.push({ label, state: 'ok', detail: '', cached: true }); continue; }
    try {
      if (!client) throw new SdapiError('not cached and no API key configured');
      files[key] = await client.getFeed(feed, gameId);
      if (cache) await cache.put(gameId, key, files[key]);
      statuses.push({ label, state: 'ok', detail: '', cached: false });
    } catch (e) {
      if (!(e instanceof SdapiError)) throw e;
      statuses.push({ label, state: 'failed', detail: e.message, cached: false });
    }
  }
  return { files, statuses };
}
