// Optional local server: serves this folder and (when an outlet key is configured) proxies the
// Stats Perform SDAPI so the key stays on your machine and never reaches the browser.
//
//   npm start                       # from the web/ folder -> http://127.0.0.1:8765
//
// The SDAPI key and referral are typed into the page and sent to this server per request; they are never stored,
// logged or written to disk. The server binds to 127.0.0.1, checks
// the Host and Origin headers (DNS-rebinding / cross-site request protection), serves only an
// allow-list of static files and exposes four small JSON/binary endpoints under /api.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_KEYS, FeedCache, SdapiClient, SdapiError, checkReferer, fetchMatch, validateApiKey, validateGameId } from './sdapi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..');
const HOST = '127.0.0.1';
const PORT_CHOSEN = Boolean(process.env.OPTA_VISUALISER_PORT);   // an explicit port is never silently changed
let PORT = Number(process.env.OPTA_VISUALISER_PORT || 8765);
const LAST_FALLBACK_PORT = PORT + 9;                              // without an explicit port, try the next few if one is busy
const CACHE_DIR = path.resolve(process.env.OPTA_VISUALISER_CACHE_DIR || path.join(REPO_ROOT, 'data', 'sdapi_cache'));
const MAX_BODY = 4096;

const cache = new FeedCache(CACHE_DIR);
let lastFetch = null;   // {gameId, files}: kept in memory when "store locally" is off (single user)

// ── Helpers ───────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'main.js', 'worker.js', 'vod-provider.js']);
const PUBLIC_DIRS = ['lib/', 'data/', 'assets/', 'vendor/', 'animation/', 'fonts/'];

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
    return sendJson(res, 200, { sdapi: true, cacheDir: shown });
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
      // Key and referral are optional: without a key only cached files can be served.
      const client = body.apiKey ? new SdapiClient(validateApiKey(body.apiKey), checkReferer(body.referral)) : null;
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
function start() {
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    if (!PORT_CHOSEN && PORT < LAST_FALLBACK_PORT) {
      console.log(`Port ${PORT} is already in use, trying ${PORT + 1}...`);
      PORT += 1;
      return start();
    }
    console.error(`Port ${PORT} is already in use on this computer.`);
    console.error(PORT_CHOSEN
      ? 'Close whatever is using it, or pick another port, for example:  OPTA_VISUALISER_PORT=9000 npm start'
      : `Tried ${LAST_FALLBACK_PORT - 9}-${LAST_FALLBACK_PORT}. A previous copy of this app may still be running in another terminal window (press Ctrl+C there), or pick a port:  OPTA_VISUALISER_PORT=9000 npm start`);
    process.exit(1);
  });
  server.listen(PORT, HOST);
}
server.on('listening', () => console.log(`Opta Vision Visualiser: http://${HOST}:${PORT}`));
start();
