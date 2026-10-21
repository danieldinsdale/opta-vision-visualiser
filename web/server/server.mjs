// Optional local server: serves this folder and (when an outlet key is configured) proxies the
// Stats Perform SDAPI so the key stays on your machine and never reaches the browser.
//
//   npm start                       # from the web/ folder -> http://127.0.0.1:8765
//
// Credentials come from ../.streamlit/secrets.toml only (never from environment variables). The server binds to 127.0.0.1, checks
// the Host and Origin headers (DNS-rebinding / cross-site request protection), serves only an
// allow-list of static files and exposes four small JSON/binary endpoints under /api.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_KEYS, FeedCache, SdapiClient, SdapiError, checkReferer, fetchMatch, parseSecrets, validateGameId } from './sdapi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.OPTA_VISUALISER_PORT || 8765);
const CACHE_DIR = path.resolve(process.env.OPTA_VISUALISER_CACHE_DIR || path.join(REPO_ROOT, 'data', 'sdapi_cache'));
const MAX_BODY = 4096;

// ── Credentials (secrets.toml only) ───────────────────────────────────────────
// OPTA_VISUALISER_SECRETS_FILE only changes *where* the file is (the tests point it at an empty one).
const SECRETS_FILE = process.env.OPTA_VISUALISER_SECRETS_FILE || path.join(REPO_ROOT, '.streamlit', 'secrets.toml');
let client = null;
try {
  const secrets = parseSecrets(await fs.readFile(SECRETS_FILE, 'utf8'));
  if (secrets.API_OUTLET_KEY) client = new SdapiClient(secrets.API_OUTLET_KEY, checkReferer(secrets.API_REFERER));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`Could not read secrets.toml: ${e instanceof SdapiError ? e.message : e.code || e.name}`);
}

const cache = new FeedCache(CACHE_DIR);
let lastFetch = null;   // {gameId, files}: kept in memory when "store locally" is off (single user)

// ── Helpers ───────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'main.js', 'worker.js', 'vod-provider.js']);
const PUBLIC_DIRS = ['lib/', 'data/', 'assets/', 'vendor/', 'animation/'];

const baseHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...baseHeaders, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new SdapiError('Request body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new SdapiError('Request body is not valid JSON'); }
}

const hostOk = (req) => [`${HOST}:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);
const originOk = (req) => { const o = req.headers.origin; return o === `http://${HOST}:${PORT}` || o === `http://localhost:${PORT}`; };

// ── API ───────────────────────────────────────────────────────────────────────
async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const shown = CACHE_DIR.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, CACHE_DIR) : 'custom folder';
    return sendJson(res, 200, { sdapi: !!client, cacheDir: shown });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
    const [, , , id, name] = url.pathname.split('/');
    const gameId = validateGameId(decodeURIComponent(id || ''));
    if (!FILE_KEYS.includes(name)) throw new SdapiError('Unknown file');
    const data = lastFetch?.gameId === gameId && lastFetch.files[name] ? lastFetch.files[name] : await cache.get(gameId, name);
    if (!data) return sendJson(res, 404, { error: 'File not available. Fetch the match first.' });
    return send(res, 200, data, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  }
  if (req.method === 'POST') {
    if (!originOk(req) || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
    }
    const body = await readJson(req);
    if (url.pathname === '/api/fetch') {
      const gameId = validateGameId(body.gameId);
      const want = Object.fromEntries(['events', 'matchstats', 'phases', 'runs'].map((k) => [k, !!body.want?.[k]]));
      const useCache = !!body.useCache;
      const { files, statuses } = await fetchMatch(client, gameId, want, useCache ? cache : null, !!body.refresh);
      lastFetch = files ? { gameId, files } : null;
      return sendJson(res, 200, {
        statuses, files: Object.fromEntries(FILE_KEYS.map((k) => [k, !!files?.[k]])), cached: useCache && await cache.has(gameId),
      });
    }
    if (url.pathname === '/api/cache/delete') {
      const gameId = validateGameId(body.gameId);
      await cache.clear(gameId);
      if (lastFetch?.gameId === gameId) lastFetch = null;
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ── Static files (allow-list) ─────────────────────────────────────────────────
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'; } catch { return send(res, 400, 'Bad request'); }
  if (!PUBLIC_FILES.has(rel) && !PUBLIC_DIRS.some((d) => rel.startsWith(d))) return send(res, 404, 'Not found');
  const file = path.resolve(WEB_ROOT, rel);
  if (!file.startsWith(WEB_ROOT + path.sep)) return send(res, 404, 'Not found');      // traversal guard
  try {
    const data = await fs.readFile(file);
    return send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch { return send(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 421, 'Misdirected request');
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    return url.pathname.startsWith('/api/') ? await api(req, res, url) : await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof SdapiError) return sendJson(res, 400, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: 'Unexpected server error' });
  }
});
server.requestTimeout = 0;           // large downloads from the local server can take a while
server.listen(PORT, HOST, () => {
  console.log(`Opta Vision Visualiser: http://${HOST}:${PORT}`);
  console.log(client ? 'SDAPI: enabled (key read from .streamlit/secrets.toml)' : 'SDAPI: off (add API_OUTLET_KEY to .streamlit/secrets.toml to enable it)');
});
