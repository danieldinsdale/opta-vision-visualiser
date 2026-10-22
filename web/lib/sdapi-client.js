// Browser-side SDAPI client, used when no local server is available (e.g. GitHub Pages).
// The key is typed by the user, kept in memory for one request and never stored, logged or shown:
// errors carry a masked URL. HTTPS only, redirects refused, allow-listed feeds, validated ids,
// idle timeout and a hard size cap. Whether the API permits browser (CORS) access is decided by
// the API, not by this code; a blocked request is reported as such.
import { MAX_INPUT_BYTES } from './limits.js';

export const BASE_URL = 'https://api.performfeeds.com';
const TIMEOUT_MS = 30_000;
const GAME_ID_RE = /^[A-Za-z0-9]{10,40}$/;
const KEY_RE = /^[A-Za-z0-9._~-]{8,128}$/;
const OPTIONAL_FEEDS = [
  // [key, display label, feed name]
  ['events', 'Events', 'remoteevents'],
  ['matchstats', 'Lineup and kit colours', 'matchstats'],
  ['phases', 'Phases of play', 'remotephasesofplay'],
  ['runs', 'Player runs', 'remoteplayerruns'],
];

export class SdapiError extends Error {}

export const validateGameId = (id) => {
  const v = String(id ?? '').trim();
  if (!GAME_ID_RE.test(v)) throw new SdapiError('Game id must be 10-40 alphanumeric characters');
  return v;
};
export const validateApiKey = (key) => {
  const v = String(key ?? '').trim();
  if (!KEY_RE.test(v)) throw new SdapiError('SDAPI key is missing or has an unexpected format');
  return v;
};

/** Download links come from the API response: https only (http is upgraded), never anything else. */
export function normaliseDownloadUrl(url) {
  let u = String(url || '').trim();
  if (u.startsWith('//')) u = `https:${u}`;
  else if (/^http:\/\//i.test(u)) u = `https://${u.slice(7)}`;
  let parsed;
  try { parsed = new URL(u); } catch { throw new SdapiError('Refusing to fetch an unsupported file link'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw new SdapiError('Refusing to fetch an unsupported file link');
  return u;
}

const redact = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.hostname}${u.pathname}`; } catch { return '[invalid url]'; } };

async function boundedGet(url, shown, what) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // credentials omitted and no referrer: nothing but the URL itself identifies the caller
    const res = await fetch(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal });
    if (res.status !== 200) throw new SdapiError(`${what}: HTTP ${res.status} for ${shown}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(timer); timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      size += value.length;
      if (size > MAX_INPUT_BYTES) { await reader.cancel(); throw new SdapiError(`${what}: file exceeds the size limit`); }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  } catch (e) {
    if (e instanceof SdapiError) throw e;
    if (e.name === 'AbortError') throw new SdapiError(`${what}: request timed out for ${shown}`);
    throw new SdapiError(`${what}: blocked by the browser (the API may not allow browser access from this site) or a network error for ${shown}`);
  } finally { clearTimeout(timer); }
}

export class BrowserSdapiClient {
  #key;
  constructor(apiKey) { this.#key = validateApiKey(apiKey); }

  async getFeed(feed, gameId) {
    const id = validateGameId(gameId);
    const shown = `${BASE_URL}/soccerdata/${feed}/<API_OUTLET_KEY>/${id}?_fmt=json&_rt=c`;
    const body = await boundedGet(`${BASE_URL}/soccerdata/${feed}/${this.#key}/${id}?_fmt=json&_rt=c`, shown, feed);
    try { JSON.parse(new TextDecoder().decode(body)); } catch { throw new SdapiError(`${feed}: response was not JSON`); }
    return body;
  }

  async getEptsFiles(gameId) {
    const data = JSON.parse(new TextDecoder().decode(await this.getFeed('remotematchtrackingepts', gameId)));
    const files = data?.trackingFiles?.fps25;
    const metaUrl = files?.metadata?.value, dataUrl = files?.trackingData?.value;
    if (!metaUrl || !dataUrl) throw new SdapiError('EPTS feed has no 25 Hz tracking files for this match');
    const get = (u) => { const safe = normaliseDownloadUrl(u); return boundedGet(safe, redact(safe), 'download'); };
    return { raw: await get(dataUrl), spec: await get(metaUrl) };
  }
}

/** Same shape as the local server's result: {files, statuses}; files is null if tracking failed. */
export async function fetchMatchInBrowser(apiKey, gameId, want) {
  const statuses = [];
  const files = {};
  const client = new BrowserSdapiClient(apiKey);
  validateGameId(gameId);
  try {
    ({ raw: files.raw, spec: files.spec } = await client.getEptsFiles(gameId));
    statuses.push({ label: 'EPTS tracking', state: 'ok', detail: '', cached: false });
  } catch (e) {
    if (!(e instanceof SdapiError)) throw e;
    statuses.push({ label: 'EPTS tracking', state: 'failed', detail: e.message, cached: false });
    for (const [key, label] of OPTIONAL_FEEDS) statuses.push({ label, state: 'skipped', detail: want[key] ? 'not fetched (tracking failed)' : 'not requested', cached: false });
    return { files: null, statuses };
  }
  for (const [key, label, feed] of OPTIONAL_FEEDS) {
    if (!want[key]) { statuses.push({ label, state: 'skipped', detail: 'not requested', cached: false }); continue; }
    try {
      files[key] = await client.getFeed(feed, gameId);
      statuses.push({ label, state: 'ok', detail: '', cached: false });
    } catch (e) {
      if (!(e instanceof SdapiError)) throw e;
      statuses.push({ label, state: 'failed', detail: e.message, cached: false });
    }
  }
  return { files, statuses };
}
