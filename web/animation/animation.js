// ═════════════════════════════════════════════════════════════════════════════
//  Opta Vision Visualiser - animation component (single script, no build step)
//
//  Sections, in file order (search for the banner text):
//    Data & state ........ DATA, VOD video state, State, Coordinate helpers
//    Drawing ............. Pitch rendering, Entity rendering, Possession highlight,
//                          Motion tails, Events rendering, Event labels, Main render
//    Info panels ......... Phase-of-play window, Runs panel, Pressure panel,
//                          Defensive Compactness, Player hover tooltip
//    Overlays ............ Run highlights, Pressure arrows, Phase overlay,
//                          Overload overlay, Run Info, Pressure Info
//    Controls ............ Meta display + time input, Playback, Source toggles, Wiring
//    3D .................. 3D renderer (Three.js, loaded on first use)
//    Tables .............. Events, Runs and Phases tables (one open at a time)
//    Export & layout ..... GIF + Video export, Auto-fit of the host iframe
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
//  DATA and third-party scripts
// ─────────────────────────────────────────────────────────────────────────────
// The payload is handed over by the page that hosts this one (window.parent.OPTA_PAYLOAD, same
// origin); see web/main.js.
const D = (() => {
  try { if (window.parent !== window) return window.parent.OPTA_PAYLOAD; } catch (e) { /* cross-origin */ }
  return undefined;
})();
if (!D) throw new Error('No match data: open the visualiser page (index.html) and load a match.');

// Optional third-party scripts (3D, GIF export, HLS video): vendored copies in web/vendor, set by
// vendor-config.js, so no request ever leaves the page.
const VENDOR = window.OPTA_VENDOR;

// Brand typeface: Roboto (declared in fonts/fonts.css). Canvas text uses this stack.
const FONT_SANS = '"Roboto", Calibri, "Segoe UI", Arial, sans-serif';

// ─────────────────────────────────────────────────────────────────────────────
//  VOD video state
// ─────────────────────────────────────────────────────────────────────────────
const videoWrap    = document.getElementById('video-wrap');
const rightColEl   = document.getElementById('right-col');
const offsetRow    = document.getElementById('video-offset-row');
const offsetSlider = document.getElementById('video-offset-slider');
const offsetVal    = document.getElementById('video-offset-val');
const videoOverlay = document.getElementById('video-overlay');
const hasVod = Object.keys(D.vodUrls).length > 0;

// vodPlayers[periodStr] = { el: <video element> }
// Each period has its own pre-loaded <video> element — no source-swapping needed.
const vodPlayers = {};
let vodActivePeriod = null;
let videoOffset = 0;  // frame offset — positive means video runs ahead of tracker

function loadHlsJs(callback) {
  if (window.Hls) { callback(); return; }
  const s = document.createElement('script');
  s.src = VENDOR.hls;
  s.onload = callback;
  document.head.appendChild(s);
}

function initAllVideos() {
  // Map period "1" to vod-video-1, all others to vod-video-2
  const elMap = { '1': document.getElementById('vod-video-1') };
  const el2 = document.getElementById('vod-video-2');
  Object.keys(D.vodUrls).forEach(p => { if (p !== '1') elMap[p] = el2; });

  function setupPlayer(periodStr, url, videoEl) {
    vodPlayers[periodStr] = { el: videoEl, url, hls: null };
    function doAttach() {
      if (window.Hls && Hls.isSupported() && url.includes('.m3u8')) {
        const hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(videoEl);
        vodPlayers[periodStr].hls = hls;
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) reloadPlayer(periodStr);
        });
      } else {
        videoEl.src = url;
        videoEl.load();
      }
    }
    if (url.includes('.m3u8') && !window.Hls) {
      loadHlsJs(doAttach);
    } else {
      doAttach();
    }
  }

  Object.entries(D.vodUrls).forEach(([p, url]) => {
    if (elMap[p]) setupPlayer(p, url, elMap[p]);
  });
}

function reloadPlayer(periodStr) {
  const player = vodPlayers[periodStr];
  if (!player) return;
  const { el, url } = player;
  const periodStart = D.periodStartTimes[periodStr] || 0;
  const targetTime = Math.max(0, D.meta.time[currentFi] - periodStart + videoOffset / 25.0);

  // Tear down existing HLS instance if present
  if (player.hls) { player.hls.destroy(); player.hls = null; }

  function doReattach() {
    if (window.Hls && Hls.isSupported() && url.includes('.m3u8')) {
      const hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(el);
      player.hls = hls;
      hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) reloadPlayer(periodStr); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        el.currentTime = targetTime;
        if (isPlaying) { el.playbackRate = speed; el.play().catch(() => {}); }
      });
    } else {
      el.src = url;
      el.load();
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = targetTime;
        if (isPlaying) { el.playbackRate = speed; el.play().catch(() => {}); }
      }, { once: true });
    }
  }
  if (url.includes('.m3u8') && !window.Hls) { loadHlsJs(doReattach); } else { doReattach(); }
}

// Seek a player to targetTime, deferring until media metadata is available.
// Stores the latest requested position so rapid scrubs across a period boundary
// always land at the correct final frame, not an earlier intermediate one.
function _seekWhenReady(player, targetTime) {
  player._seekTarget = targetTime;
  if (player.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
    player.el.currentTime = targetTime;
    if (isPlaying) { player.el.playbackRate = speed; player.el.play().catch(() => {}); }
    else player.el.pause();
  } else if (!player._seekPending) {
    player._seekPending = true;
    const apply = () => {
      player._seekPending = false;
      player.el.currentTime = player._seekTarget;
      if (isPlaying) { player.el.playbackRate = speed; player.el.play().catch(() => {}); }
      else player.el.pause();
    };
    if (player.hls) {
      player.hls.once(Hls.Events.MANIFEST_PARSED, apply);
    } else {
      player.el.addEventListener('loadedmetadata', apply, { once: true });
    }
  }
}

function syncVideo(fi) {
  if (!hasVod) return;
  const period = D.meta.period[fi];
  const periodStr = String(period);
  const player = vodPlayers[periodStr];
  if (!player) return;

  // Subtract the period's start time so targetTime is always relative to the
  // beginning of the period — matching the VOD clip fetched with time_in=0.
  const periodStart = D.periodStartTimes[periodStr] || 0;
  const targetTime = Math.max(0, D.meta.time[fi] - periodStart + videoOffset / 25.0);

  // Show the correct video element, hide the others
  if (vodActivePeriod !== periodStr) {
    Object.entries(vodPlayers).forEach(([p, pl]) => {
      pl.el.style.display = p === periodStr ? 'block' : 'none';
    });
    vodActivePeriod = periodStr;
    // Defer the seek if the manifest/metadata hasn't loaded yet for this period
    _seekWhenReady(player, targetTime);
    return;
  }

  if (isPlaying) {
    // During playback let the video run freely — only correct large drift to avoid
    // seek-induced stuttering from constant keyframe decodes.
    if (Math.abs(player.el.currentTime - targetTime) > 0.5) {
      player.el.currentTime = targetTime;
    }
  } else {
    // Paused or scrubbing: seek precisely to the current frame.
    player.el.currentTime = targetTime;
  }

  videoOverlay.textContent = 'P' + period + '  offset: ' + (videoOffset >= 0 ? '+' : '') + videoOffset + 'f';
}

if (hasVod) {
  videoWrap.classList.add('active');
  offsetRow.classList.add('active');
  initAllVideos();
  const firstPeriod = String(D.meta.period[0] || 1);
  vodActivePeriod = firstPeriod;
  // All videos except the first period start hidden
  // (their display:none inline style is set in HTML; first period's el is visible)
}

// Offset slider wiring
offsetSlider.addEventListener('input', () => {
  videoOffset = parseInt(offsetSlider.value, 10);
  offsetVal.textContent = (videoOffset >= 0 ? '+' : '') + videoOffset + ' frames';
  syncVideo(currentFi);
});
document.getElementById('btn-offset-reset').addEventListener('click', () => {
  videoOffset = 0;
  offsetSlider.value = 0;
  offsetVal.textContent = '0 frames';
  syncVideo(currentFi);
});
document.getElementById('btn-video-reload').addEventListener('click', () => {
  if (vodActivePeriod) reloadPlayer(vodActivePeriod);
});

// ─────────────────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────────────────
const canvas  = document.getElementById('pc');
const ctx     = canvas.getContext('2d');
const slider  = document.getElementById('frame-slider');
const btnPlay = document.getElementById('btn-play');
const metaDiv = document.getElementById('meta-display');
const inpPeriod = document.getElementById('inp-period');
const inpMin    = document.getElementById('inp-min');
const inpSec    = document.getElementById('inp-sec');

let currentFi  = 0;
let isPlaying  = false;
let timerId    = null;
let speed      = 1.0;
let updatingTimeInputs = false;  // prevent infinite loops

// Hover tooltip state
const tooltipEl   = document.getElementById('hover-tooltip');
let hoveredEntity = null;
let _lastMouseX   = 0;
let _lastMouseY   = 0;

// Which sources are visible (all on by default)
const visibleSources = new Set(D.sources.map(s => s.id));

// Whether the event marker is visible
let showEvents = true;


// Whether the 3D renderer is active (defaults to 2D)
let is3D = false;

// Motion tails state
let showTails  = false;
let tailLength = 50;
let overlayTextSize = 1.0;

// In-view mode — cycles through 3 states:
//   0 = all players at full alpha (default)
//   1 = hide out-of-view players entirely
//   2 = show out-of-view players at reduced alpha
let inViewMode = 0;

// Pre-compute broadcast-visible Sets for O(1) per-frame lookup
for (const entity of D.entities) {
  entity._bvSet = entity.bv ? new Set(entity.bv) : null;
}

// Pre-compute start frame index (_sf) for each run using binary search on meta.time.
// Groups frame indices by period first so the search only scans the relevant slice.
if (D.runs) {
  const _periodFiArr = {};
  for (let i = 0; i < D.meta.period.length; i++) {
    const p = String(D.meta.period[i]);
    (_periodFiArr[p] = _periodFiArr[p] || []).push(i);
  }
  for (const [period, rs] of Object.entries(D.runs)) {
    const fiArr = _periodFiArr[period] || [];
    for (const run of rs) {
      // Binary search: first fi where D.meta.time[fi] >= run.s
      let lo = 0, hi = fiArr.length - 1, found = fiArr[0] || 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (D.meta.time[fiArr[mid]] >= run.s) { found = fiArr[mid]; hi = mid - 1; }
        else lo = mid + 1;
      }
      run._sf = found;
    }
  }
}

// Source index map (for radius offset)
const srcIndexMap = {};
D.sources.forEach((s, i) => { srcIndexMap[s.id] = i; });

// Transform state (updated on resize)
let T = {};

// ─────────────────────────────────────────────────────────────────────────────
//  Coordinate helpers
// ─────────────────────────────────────────────────────────────────────────────
const MARGIN = 4;
const GRASS_RUNOFF = 3.5;     // grass beyond the touchlines/goal lines (metres, must stay below MARGIN so a thin dark rim remains)
const GOAL_W = 7.32, GOAL_NET_D = 2.0, NET_CELL = 0.3;   // goal mouth width, net depth behind the line, net mesh size (metres)

function setupTransform(W, H) {
  const L = D.pitch.L, Wp = D.pitch.W;
  const dataW = L + 2 * MARGIN;
  const dataH = Wp + 2 * MARGIN;
  const sc = Math.min(W / dataW, H / dataH);
  const ox = (W - dataW * sc) / 2;
  const oy = (H - dataH * sc) / 2;
  T = { sc, ox, oy, L, Wp };
}

// Bounding box of the pitch area (including margin) in canvas pixels.
// Width/height are rounded to even numbers — required by VP9/H.264 encoders.
function pitchRect() {
  const w = Math.floor((T.L  + 2 * MARGIN) * T.sc / 2) * 2;
  const h = Math.floor((T.Wp + 2 * MARGIN) * T.sc / 2) * 2;
  return { x: Math.round(T.ox), y: Math.round(T.oy), w, h };
}

function tc(x, y) {
  return [T.ox + (x + T.L / 2 + MARGIN) * T.sc,
          T.oy + (T.Wp / 2 + MARGIN - y) * T.sc];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pitch rendering
// ─────────────────────────────────────────────────────────────────────────────
// Pitch grass pattern, shared by the 2D canvas and the 3D scene: 10 vertical stripes.
// (PITCH_ROWS = 1 gives stripes; a larger value would make a chequerboard.)
const PITCH_COLS = 10, PITCH_ROWS = 1;
const PITCH_TILE_CSS = ['#22663a', '#1f6035'];
const PITCH_TILE_HEX = [0x22663a, 0x1f6035];

// Grass texture: a seamless greyscale tile (mean 0.86, fine detail only), repeated across the pitch and
// multiplied over the stripes. One tile is as wide as one stripe, so tiles line up with stripe edges. Because it
// darkens by its mean, the stripe colours are brightened by 1/mean first, so the average colour stays
// the two stripe greens. Until the image has loaded (or if it fails) the plain colours are used.
const TEX_MEAN = 0.86;
const TEX_URL = '../assets/grass-texture.jpg';
const TEX_IMG = new Image();
TEX_IMG.onload = () => { if (typeof currentFi !== 'undefined') render(currentFi); };
TEX_IMG.src = TEX_URL;
const texReady = () => TEX_IMG.complete && TEX_IMG.naturalWidth > 0;
const brightenHex = (hex) => {
  const c = [16, 8, 0].map((sh) => Math.min(255, Math.round(((hex >> sh) & 255) / TEX_MEAN)));
  return (c[0] << 16) | (c[1] << 8) | c[2];
};
const tileHex = (k) => (texReady() ? brightenHex(PITCH_TILE_HEX[k]) : PITCH_TILE_HEX[k]);
const texTileM = (L) => L / PITCH_COLS;            // tile size on the pitch, metres (square)
// Pattern for ctx: tile edges start at world (x0, y0) given in canvas pixels; k = canvas px per metre.
function texPattern(g, L, x0, y0, k) {
  const pat = g.createPattern(TEX_IMG, 'repeat');
  pat.setTransform(new DOMMatrix().translate(x0, y0).scale(texTileM(L) * k / TEX_IMG.naturalWidth));
  return pat;
}
const tileCss = (k) => '#' + tileHex(k).toString(16).padStart(6, '0');

function drawPitch(W, H) {
  const L = T.L, Wp = T.Wp, sc = T.sc;

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // Vertical grass stripes: subtle two-tone, pixel-snapped so no seams show between stripes
  const cw = L / PITCH_COLS, rh = Wp / PITCH_ROWS;
  const [px1, py1] = tc(-L / 2, Wp / 2);
  const [px2, py2] = tc(L / 2, -Wp / 2);
  const RUN = Math.min(GRASS_RUNOFF, MARGIN - 0.25);
  const [gx1, gy1] = tc(-L / 2 - RUN, Wp / 2 + RUN);         // grass area: the pitch plus a run-off all round
  const [gx2, gy2] = tc(L / 2 + RUN, -Wp / 2 - RUN);
  ctx.fillStyle = tileCss(0);
  ctx.fillRect(Math.floor(gx1), Math.floor(gy1), Math.ceil(gx2) - Math.floor(gx1), Math.ceil(gy2) - Math.floor(gy1));
  ctx.fillStyle = tileCss(1);
  for (let i = 0; i < PITCH_COLS; i++) {
    for (let j = 0; j < PITCH_ROWS; j++) {
      if ((i + j) % 2 === 0) continue;
      const [cx1, cy1] = tc(-L / 2 + i * cw - (i === 0 ? RUN : 0), Wp / 2 - j * rh + (j === 0 ? RUN : 0));
      const [cx2, cy2] = tc(-L / 2 + (i + 1) * cw + (i === PITCH_COLS - 1 ? RUN : 0), Wp / 2 - (j + 1) * rh - (j === PITCH_ROWS - 1 ? RUN : 0));
      const x1 = Math.floor(cx1), y1 = Math.floor(cy1);
      ctx.fillRect(x1, y1, Math.ceil(cx2) - x1, Math.ceil(cy2) - y1);
    }
  }

  // Opta logo: on the grass, below every line
  if (logoReady()) {
    const [lcx, lcy] = tc(0, 0);
    const m = logoMetres(L);
    const w = Math.round(m.w * sc), h = Math.round(m.h * sc);
    ctx.drawImage(logoCanvas(w, h, L), Math.round(lcx - w / 2), Math.round(lcy - h / 2));
  }

  // Grass texture over stripes and logo, below every line
  if (texReady()) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = texPattern(ctx, L, px1, py1, sc);
    ctx.fillRect(Math.floor(gx1), Math.floor(gy1), Math.ceil(gx2) - Math.floor(gx1), Math.ceil(gy2) - Math.floor(gy1));
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.fillStyle   = 'rgba(255,255,255,0.82)';
  ctx.lineWidth   = Math.max(1.2, sc * 0.12);
  ctx.setLineDash([]);

  const sRect = (x1, yb, x2, yt) => {
    const [ax, ay] = tc(x1, yt);
    const [bx, by] = tc(x2, yb);
    ctx.strokeRect(ax, ay, bx - ax, by - ay);
  };

  sRect(-L/2, -Wp/2, L/2, Wp/2);

  ctx.beginPath();
  const [lx, ly] = tc(0, -Wp/2);
  const [rx, ry] = tc(0,  Wp/2);
  ctx.moveTo(lx, ly); ctx.lineTo(rx, ry); ctx.stroke();

  const [ccx, ccy] = tc(0, 0);
  ctx.beginPath(); ctx.arc(ccx, ccy, 9.15 * sc, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(ccx, ccy, 0.5 * sc, 0, 2 * Math.PI); ctx.fill();

  sRect(-L/2, -20.15, -L/2 + 16.5, 20.15);
  sRect( L/2, -20.15,  L/2 - 16.5, 20.15);
  sRect(-L/2, -9.15, -L/2 + 5.5, 9.15);
  sRect( L/2, -9.15,  L/2 - 5.5, 9.15);

  const dot = (x, y) => {
    const [dx, dy] = tc(x, y);
    ctx.beginPath(); ctx.arc(dx, dy, 0.5 * sc, 0, 2 * Math.PI); ctx.fill();
  };
  dot(-L/2 + 11, 0); dot(L/2 - 11, 0);

  const arc = (x, y, r, th1, th2) => {
    const [ax, ay] = tc(x, y);
    ctx.beginPath();
    ctx.arc(ax, ay, r * sc, -th1 * Math.PI / 180, -th2 * Math.PI / 180, true);
    ctx.stroke();
  };
  arc(-L/2 + 11, 0, 10, 305, 55);
  arc( L/2 - 11, 0, 10, 125, 235);
  arc(-L/2, -Wp/2, 1, 0, 90);
  arc( L/2, -Wp/2, 1, 90, 180);
  arc( L/2,  Wp/2, 1, 180, 270);
  arc(-L/2,  Wp/2, 1, 270, 360);

  // Goal nets seen from above: shaded floor, diamond mesh, white frame (posts, goal-line bar, rear bar, side bars)
  const drawNet = (gx) => {
    const sign = gx < 0 ? -1 : 1, hw = GOAL_W / 2;
    const [x1, y1] = tc(gx, hw), [x2, y2] = tc(gx + sign * GOAL_NET_D, -hw);
    const rx = Math.min(x1, x2), ry = Math.min(y1, y2), rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';                       // shade under the net, so the mesh reads against the grass
    ctx.fillRect(rx, ry, rw, rh);
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = Math.max(0.7, sc * 0.03);
    const step = NET_CELL * sc;
    ctx.beginPath();
    for (let d = -rh; d < rw; d += step) {                    // two sets of 45-degree lines = diamond mesh
      ctx.moveTo(rx + d, ry);      ctx.lineTo(rx + d + rh, ry + rh);
      ctx.moveTo(rx + d, ry + rh); ctx.lineTo(rx + d + rh, ry);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = Math.max(1.4, sc * 0.1);
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = '#ffffff';
    for (const [px, py, r] of [[gx, hw, 0.17], [gx, -hw, 0.17], [gx + sign * GOAL_NET_D, hw, 0.11], [gx + sign * GOAL_NET_D, -hw, 0.11]]) {
      const [cx, cy] = tc(px, py);
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, r * sc), 0, 2 * Math.PI); ctx.fill();   // posts: front ones larger
    }
  };
  drawNet(-L / 2); drawNet(L / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entity rendering — sources get visually distinct styles
// ─────────────────────────────────────────────────────────────────────────────

function bsearch(arr, fi) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] === fi) return mid;
    if (arr[mid] < fi) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function getPos(entity, srcId, fi) {
  const src = entity.s[srcId];
  if (!src) return null;
  const idx = bsearch(src.fi, fi);
  return idx >= 0 ? [src.x[idx], src.y[idx]] : null;
}

function getZ(entity, srcId, fi) {
  const src = entity.s[srcId];
  if (!src || !src.z) return 0;
  const idx = bsearch(src.fi, fi);
  return idx >= 0 ? src.z[idx] : 0;
}

// Football sprite (data URL from the payload). Falls back to a plain circle until loaded.
const BALL_IMG = new Image();
if (D.ballImage) {
  BALL_IMG.onload = () => { if (typeof currentFi !== 'undefined') render(currentFi); };
  BALL_IMG.src = D.ballImage;
}
// Opta logo across the middle of the pitch (2D canvas and 3D scene), tone-on-tone with the grass:
// wherever the logo lies over one stripe colour it is drawn in the other stripe colour, nothing more.
// It stays clear of both penalty areas (a few metres of grass between each box and the logo's ends).
const LOGO_URL = '../assets/opta-ai-logo_white.png';      // the same logo as the sidebar; only its shape is used
const LOGO_BOX_GAP = 3.5;                          // metres between a penalty area (16.5 m deep) and the logo
const LOGO_IMG = new Image();
LOGO_IMG.onload = () => { if (typeof currentFi !== 'undefined') render(currentFi); };
LOGO_IMG.src = LOGO_URL;
const logoReady = () => LOGO_IMG.complete && LOGO_IMG.naturalWidth > 0;
const logoMetres = (L) => {                        // logo size on the pitch: as long as fits between the boxes and within whole stripes
  const clearOfBoxes = L - 2 * (16.5 + LOGO_BOX_GAP);
  const insideStripes = (PITCH_COLS - 4) * L / PITCH_COLS - 1;   // ends 1 m inside a stripe edge, so no end sits on a colour change
  const w = Math.max(10, Math.min(clearOfBoxes, insideStripes));
  return { w, h: w * LOGO_IMG.naturalHeight / LOGO_IMG.naturalWidth };
};
let logoCache = null;                              // {key, canvas}: the recoloured logo at the current size
function logoCanvas(wPx, hPx, L, bake) {          // bake {Wp}: also multiply the grass texture in (for 3D, where the logo is its own mesh)
  const key = wPx + 'x' + hPx + ':' + L + ':' + texReady() + ':' + (bake ? bake.Wp : '');
  if (logoCache && logoCache.key === key) return logoCache.canvas;
  const c = document.createElement('canvas');
  c.width = wPx; c.height = hPx;
  const g = c.getContext('2d');
  g.drawImage(LOGO_IMG, 0, 0, wPx, hPx);
  g.globalCompositeOperation = 'source-in';        // whole canvas: keep only the logo's shape, filled with tile 1's green
  g.fillStyle = tileCss(1); g.fillRect(0, 0, wPx, hPx);
  g.globalCompositeOperation = 'source-atop';      // stripes of tile 1 (odd) get tile 0's green; touches only logo pixels
  g.fillStyle = tileCss(0);
  const cw = L / PITCH_COLS, logoW = logoMetres(L).w;
  for (let i = 1; i < PITCH_COLS; i += 2) {        // stripe i spans world x in [-L/2 + i*cw, -L/2 + (i+1)*cw]
    const x0 = Math.floor((-L / 2 + i * cw + logoW / 2) / logoW * wPx);
    const x1 = Math.ceil((-L / 2 + (i + 1) * cw + logoW / 2) / logoW * wPx);
    if (x1 > 0 && x0 < wPx) g.fillRect(Math.max(0, x0), 0, Math.min(wPx, x1) - Math.max(0, x0), hPx);
  }
  if (bake && texReady()) {
    const m = logoMetres(L), k = wPx / m.w;
    g.globalCompositeOperation = 'multiply';       // the tiled texture that lies under the logo (tiles start at the pitch's top-left corner)...
    g.fillStyle = texPattern(g, L, (m.w / 2 - L / 2) * k, (m.h / 2 - bake.Wp / 2) * k, k);
    g.fillRect(0, 0, wPx, hPx);
    g.globalCompositeOperation = 'destination-in'; // ...then cut back to the logo's shape
    g.drawImage(LOGO_IMG, 0, 0, wPx, hPx);
  }
  logoCache = { key, canvas: c };
  return c;
}
const BALL_SPRITE_SCALE = 0.85;
const ballImgReady = () => BALL_IMG.complete && BALL_IMG.naturalWidth > 0;

// True for light colours (relative luminance above 0.4), where a white outline would disappear.
// Second colour per team (null = single-colour team). Players are drawn half and half when it is set.
const teamColour2 = (g) => (D.colors2 && D.colors2[g]) || null;

function isLightColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map(i => {
    const v = parseInt(m[1].substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

// pass: 'players' (everyone except the ball) or 'ball'. The ball is drawn in a
// second pass after the possession highlight so it always sits on top of it.
function drawEntities(fi, pass) {
  const sc = T.sc;
  const nSrc = D.sources.length;

  for (const entity of D.entities) {
    const isBall    = entity.g === 4;
    if ((pass === 'ball') !== isBall) continue;
    const teamColor = D.colors[entity.g] || '#888';
    const baseR     = isBall ? 0.7 : 1.4;

    // Draw sources in reverse order so the first (primary) source renders on top
    for (let si = nSrc - 1; si >= 0; si--) {
      const src = D.sources[si];
      if (!visibleSources.has(src.id)) continue;

      const pos = getPos(entity, src.id, fi);
      if (!pos) continue;

      // Check if this specific player is detected/visible in this source at this frame
      const detectedList = src.detected && src.detected[fi];
      const inView = isBall || (detectedList && detectedList.includes(`${entity.g}:${entity.j}`));
      // Mode 1: skip out-of-view players entirely
      if (inViewMode === 1 && !inView) continue;
      // Mode 2: out-of-view players rendered at 20% of their normal alpha
      const alphaScale = (inViewMode === 2 && !inView) ? 0.2 : 1.0;

      const [cx, cy] = tc(pos[0], pos[1]);

      // ── Radius offset — secondary sources slightly larger so they "ring" around primary
      const rOffset = isBall ? 0 : si * 0.18;
      let r = (baseR + rOffset) * sc;

      // ── Height scaling for ball: z=0 → ×1, z≥20 → ×5, linear
      // Apply to any ball source that has Z coordinates (any source that provides it)
      if (isBall) {
        const z = getZ(entity, src.id, fi);
        if (z > 0) {
          r *= 1 + 4 * Math.min(Math.max(z, 0), 20) / 20;
        }
      }

      // Apply appearance overrides from interactive controls
      const style = window._sourceStyles ? window._sourceStyles[src.id] : null;
      const alpha = style ? style.alpha : src.alpha;
      const fill = style ? style.fill : src.fill;
      const dash = style ? style.dash : src.dash;
      const suffix = style ? style.suffix : src.suffix;

      ctx.globalAlpha = alpha * alphaScale;

      const effectiveFill = fill;

      // ── Dash pattern per source
      if (dash) {
        ctx.setLineDash([Math.max(4, sc * 0.35), Math.max(3, sc * 0.25)]);
      } else {
        ctx.setLineDash([]);
      }

      // ── Stroke width — outline-only sources get thicker stroke for visibility
      ctx.lineWidth = effectiveFill ? Math.max(1, sc * 0.08) : Math.max(2, sc * 0.16);

      // ── Ball: football sprite (secondary sources also get their dashed/outline ring) ──
      if (isBall && ballImgReady()) {
        const sr = r * BALL_SPRITE_SCALE;   // sprite scale relative to the tracked ball radius
        ctx.drawImage(BALL_IMG, cx - sr, cy - sr, 2 * sr, 2 * sr);
        if (si > 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, sr, 0, 2 * Math.PI);
          ctx.strokeStyle = teamColor;
          ctx.stroke();
        }
        continue;
      }

      // ── Circle (two-colour teams: left half colour 1, right half colour 2) ──
      const color2 = isBall ? null : teamColour2(entity.g);
      const light1 = isLightColour(teamColor), light2 = color2 ? isLightColour(color2) : light1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);

      if (effectiveFill) {
        ctx.fillStyle   = teamColor;
        // dark outline when every colour is light, white otherwise (a mixed kit keeps the light outline)
        ctx.strokeStyle = (light1 && light2) ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.45)';
        ctx.fill();
        if (color2) {
          ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2); ctx.closePath();
          ctx.fillStyle = color2; ctx.fill();
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        }
        ctx.stroke();
      } else if (color2) {
        ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI / 2, Math.PI * 1.5);
        ctx.strokeStyle = teamColor; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
        ctx.strokeStyle = color2; ctx.stroke();
      } else {
        ctx.strokeStyle = teamColor;
        ctx.stroke();
      }

      // ── Label ──
      if (!isBall) {
        const label    = src.prefix + entity.j + suffix;
        const fontSize = Math.max(7, baseR * sc * 1.1);
        const labelY   = fill ? cy : cy - r - fontSize * 0.6;
        // save/restore isolates all text state so nothing bleeds into subsequent draws
        ctx.save();
        ctx.setLineDash([]);
        ctx.font         = '700 ' + fontSize + 'px ' + FONT_SANS;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin     = 'round';
        if (fill && light1 !== light2) {
          // Two-colour kit with one light and one dark colour: white number with a dark outline, readable on both halves
          ctx.fillStyle   = '#ffffff';
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.lineWidth   = Math.max(2, fontSize * 0.28);
          ctx.strokeText(label, cx, labelY);
        } else if (fill) {
          // Number inside a filled player: same tone as the player's outline (black on light kits, white on dark), no text outline
          ctx.fillStyle = light1 ? '#000000' : '#ffffff';
        } else {
          // Outline-only player: the number sits beside the ring on the grass, so it keeps its dark text outline
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.lineWidth   = Math.max(2, fontSize * 0.28);
          ctx.strokeText(label, cx, labelY);
          ctx.fillStyle   = teamColor;
        }
        ctx.fillText(label, cx, labelY);
        ctx.restore();
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Possession highlight
// ─────────────────────────────────────────────────────────────────────────────

function drawPossessionHighlight(fi) {
  const sc = T.sc;
  const baseR = 1.4;
  const nSrc = D.sources.length;

  // Draw possession rings for each source independently
  let labelPos = null;
  let lastPoss = null;  // Track possession for label rendering
  for (let si = nSrc - 1; si >= 0; si--) {
    const src = D.sources[si];
    if (!visibleSources.has(src.id)) continue;

    // Use source-specific possession if available, otherwise skip
    if (!src.possession || !src.possession[fi]) continue;
    const poss = src.possession[fi];
    if (!lastPoss) lastPoss = poss;  // Keep first possession for label

    const entity = D.entities.find(e => e.g === poss.g && e.j === poss.j);
    if (!entity) continue;

    // In mode 1 (hide out-of-view) suppress the ring too; mode 2 keeps it at full alpha
    const detectedList = src.detected && src.detected[fi];
    const inView = detectedList && detectedList.includes(`${entity.g}:${entity.j}`);
    if (inViewMode === 1 && !inView) continue;

    const pos = getPos(entity, src.id, fi);
    if (!pos) continue;

    if (si === 0 || labelPos === null) labelPos = pos;

    const [cx, cy] = tc(pos[0], pos[1]);
    const rOffset = si * 0.18;  // matches drawEntities radius offset per source
    const entityR = (baseR + rOffset) * sc;
    const ringR = entityR + Math.max(2.5, sc * 0.2);

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(2.5, sc * 0.22);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, 2 * Math.PI);
    ctx.stroke();

    // Thin white outer ring so the black reads on a dark pitch
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, sc * 0.09);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR + Math.max(1.5, sc * 0.13), 0, 2 * Math.PI);
    ctx.stroke();
  }

  if (!labelPos || !lastPoss) return;

  const displayName = (D.lineup && D.lineup[lastPoss.g + ':' + lastPoss.j]) || ('#' + lastPoss.j);

  // Anchor label to the primary (first visible) source position
  const [cx, cy] = tc(labelPos[0], labelPos[1]);
  const primaryRingR = baseR * sc + Math.max(2.5, sc * 0.2);

  const fontSize = Math.max(9, sc * 0.28);
  ctx.font = '700 ' + fontSize + 'px ' + FONT_SANS;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.setLineDash([]);

  const tw = ctx.measureText(displayName).width + 8;
  const th = fontSize + 5;
  const lx = cx + primaryRingR + Math.max(3, sc * 0.12);

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  ctx.roundRect(lx, cy - th / 2, tw, th, 3);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.fillText(displayName, lx + 4, cy);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phase-of-play info window
// ─────────────────────────────────────────────────────────────────────────────

const phasesPanelEl  = document.getElementById('phases-panel');
const phaseTitleEl   = document.getElementById('phase-title');
const phaseInitVal   = document.getElementById('phase-init-val');
const phaseFirstVal  = document.getElementById('phase-first-val');
const phasePassesVal = document.getElementById('phase-passes-val');
const phaseGoalVal   = document.getElementById('phase-goal-val');
const phaseShotsVal  = document.getElementById('phase-shots-val');
const phaseQualList  = document.getElementById('phase-qual-list');
let showPhases = false;

const runsPanelEl     = document.getElementById('runs-panel');
const runsListEl      = document.getElementById('runs-list');
let showRuns = false;

const pressurePanelEl = document.getElementById('pressure-panel');
const pressureListEl  = document.getElementById('pressure-list');
const dcPanelEl       = document.getElementById('dc-panel');
const dcLabelVal      = document.getElementById('dc-label-val');
const dcAdcVal        = document.getElementById('dc-adc-val');

const _hasPhases    = D.phases    && Object.keys(D.phases).length    > 0;
const _hasRuns      = D.runs      && Object.keys(D.runs).length      > 0;
let   showPressures      = false;
const _hasPressures      = D.pressures && D.pressures.length > 0;
let   showDefCompactness  = false;
let   showPhaseOverlay    = false;
let   showOverloadOverlay = false;
let   showRunInfo         = false;
let   showPressureInfo    = false;

function _setRightCol() {
  const needRight = hasVod || (showPhases && _hasPhases) || (showRuns && _hasRuns) ||
                    (showPressures && _hasPressures) || (showDefCompactness && _hasPhases);
  rightColEl.classList.toggle('active', needRight);
  phasesPanelEl.classList.toggle('active',   showPhases        && _hasPhases);
  runsPanelEl.classList.toggle('active',     showRuns          && _hasRuns);
  pressurePanelEl.classList.toggle('active', showPressures     && _hasPressures);
  dcPanelEl.classList.toggle('active',       showDefCompactness && _hasPhases);
}

function _hidePhasePanel() {
  phasesPanelEl.classList.remove('active');
  const others = hasVod || (showRuns && _hasRuns) || (showPressures && _hasPressures) || (showDefCompactness && _hasPhases);
  if (!others) rightColEl.classList.remove('active');
}

function _boolLabel(v) {
  if (v === 'True')  return 'Yes';
  if (v === 'False') return 'No';
  return v || '—';
}

function formatRunLabel(s) {
  if (!s) return '—';
  return s.split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
}

function formatRunType(s) {
  if (!s) return '—';
  return s.replace(/([A-Z])/g, ' $1').trim().replace(/^./, c => c.toUpperCase());
}

function _clearPhasePanel() {
  phaseTitleEl.textContent   = '—';
  phaseInitVal.textContent   = '—';
  phaseFirstVal.textContent  = '—';
  phasePassesVal.textContent = '—';
  phaseGoalVal.textContent   = '—';
  phaseShotsVal.textContent  = '—';
  phaseQualList.innerHTML    = '';
}

function updatePhaseOverlay(fi) {
  if (!showPhases || !_hasPhases) return;
  const period = String(D.meta.period[fi]);
  const t = D.meta.time[fi];
  const ps = D.phases[period];

  // No data for this period or no active phase → show empty state, panel stays open
  if (!ps || ps.length === 0) { _clearPhasePanel(); return; }

  // Binary search: find last phase whose start <= t
  let lo = 0, hi = ps.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ps[mid].s <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (idx < 0 || ps[idx].e < t) { _clearPhasePanel(); return; }

  const ph = ps[idx];

  phaseTitleEl.textContent   = ph.l;
  phaseInitVal.textContent   = ph.init   || '—';
  phaseFirstVal.textContent  = ph.first  || '—';
  phasePassesVal.textContent = ph.passes || '—';
  phaseGoalVal.textContent   = _boolLabel(ph.goal);
  phaseShotsVal.textContent  = _boolLabel(ph.shots);

  phaseQualList.innerHTML = '';

  const fp = ph.fp || [];
  for (let i = 0; i < fp.length; i++) {
    if (fp[i].s <= t && fp[i].e >= t) {
      const b = document.createElement('span');
      b.className = 'phase-badge';
      b.textContent = 'Fast Passing';
      phaseQualList.appendChild(b);
      break;
    }
  }

  const dp = ph.dp || [];
  for (let i = 0; i < dp.length; i++) {
    if (dp[i].s <= t && dp[i].e >= t) {
      const b = document.createElement('span');
      b.className = 'phase-badge';
      b.textContent = 'Direct Passing';
      phaseQualList.appendChild(b);
      break;
    }
  }

  const ol = ph.ol || [];
  for (let i = 0; i < ol.length; i++) {
    if (ol[i].s <= t && ol[i].e >= t) {
      const b = document.createElement('span');
      b.className = 'phase-badge';
      b.textContent = (ol[i].att || '?') + ' vs ' + (ol[i].def || '?') +
                      (ol[i].t ? ' ' + ol[i].t : '') + ' Overload';
      phaseQualList.appendChild(b);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Runs panel
// ─────────────────────────────────────────────────────────────────────────────

function updateRunsPanel(fi) {
  if (!showRuns || !_hasRuns) return;
  const period = String(D.meta.period[fi]);
  const t = D.meta.time[fi];
  const rs = (D.runs && D.runs[period]) || [];
  const active = rs.filter(r => r.s <= t && r.e >= t);

  runsListEl.innerHTML = '';
  if (active.length === 0) {
    // Keep panel open with empty state
    const empty = document.createElement('div');
    empty.id = 'runs-empty';
    empty.textContent = '—';
    runsListEl.appendChild(empty);
    return;
  }
  for (const r of active) {
    const item = document.createElement('div');
    item.className = 'run-item';
    item.innerHTML =
      '<div class="run-row"><span class="run-lbl">Player:</span><span class="run-val">' + (r.player || '—')          + '</span></div>' +
      '<div class="run-row"><span class="run-lbl">Label:</span><span class="run-val">'  + formatRunLabel(r.label)    + '</span></div>' +
      '<div class="run-row"><span class="run-lbl">Type:</span><span class="run-val">'   + formatRunType(r.type)      + '</span></div>';
    runsListEl.appendChild(item);
  }
}

// Phases toggle button
const btnPhases = document.getElementById('btn-phases');
if (_hasPhases) {
  btnPhases.style.display = '';
  btnPhases.classList.add('btn-secondary');
  btnPhases.classList.remove('btn-primary');
  btnPhases.addEventListener('click', () => {
    showPhases = !showPhases;
    btnPhases.classList.toggle('btn-primary',   showPhases);
    btnPhases.classList.toggle('btn-secondary', !showPhases);
    _setRightCol();
    if (showPhases) render(currentFi);
  });
}

// Runs toggle button
const btnRuns = document.getElementById('btn-runs');
if (_hasRuns) {
  btnRuns.style.display = '';
  btnRuns.classList.add('btn-secondary');
  btnRuns.classList.remove('btn-primary');
  btnRuns.addEventListener('click', () => {
    showRuns = !showRuns;
    btnRuns.classList.toggle('btn-primary',   showRuns);
    btnRuns.classList.toggle('btn-secondary', !showRuns);
    _setRightCol();
    if (showRuns) render(currentFi);
  });
}

// Run highlights toggle button
const btnRunHighlights = document.getElementById('btn-run-highlights');
if (_hasRuns) {
  btnRunHighlights.style.display = '';
  btnRunHighlights.classList.add('btn-secondary');
  btnRunHighlights.classList.remove('btn-primary');
  btnRunHighlights.addEventListener('click', () => {
    showRunHighlights = !showRunHighlights;
    btnRunHighlights.classList.toggle('btn-primary',   showRunHighlights);
    btnRunHighlights.classList.toggle('btn-secondary', !showRunHighlights);
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Player hover tooltip
// ─────────────────────────────────────────────────────────────────────────────

function findHoveredEntity(cx, cy) {
  if (!T.sc) return null;
  const hitR = (1.4 + 0.5) * T.sc;
  let closest = null, closestDist = hitR;
  for (const entity of D.entities) {
    if (entity.g === 4) continue;
    const inView = entity._bvSet && entity._bvSet.has(currentFi);
    if (inViewMode === 1 && !inView) continue;
    for (const src of D.sources) {
      if (!visibleSources.has(src.id)) continue;
      const pos = getPos(entity, src.id, currentFi);
      if (!pos) break;
      const [ex, ey] = tc(pos[0], pos[1]);
      const d = Math.sqrt((cx - ex) ** 2 + (cy - ey) ** 2);
      if (d < closestDist) { closestDist = d; closest = entity; }
      break;
    }
  }
  return closest;
}

function renderTooltip(entity, cx, cy) {
  if (!entity) {
    tooltipEl.classList.remove('visible');
    hoveredEntity = null;
    return;
  }
  hoveredEntity = entity;

  const name = (D.lineup && D.lineup[entity.g + ':' + entity.j]) || ('#' + entity.j);
  const period = String(D.meta.period[currentFi]);
  const t = D.meta.time[currentFi];
  const run = ((D.runs && D.runs[period]) || [])
    .find(r => r.g === entity.g && r.j === entity.j && r.s <= t && r.e >= t);

  let html = '<div class="tt-name">' + name + '</div>';
  if (run) {
    if (run.label) html += '<div class="tt-row"><span class="tt-lbl">Label:</span><span class="tt-val">' + formatRunLabel(run.label) + '</span></div>';
    if (run.type)  html += '<div class="tt-row"><span class="tt-lbl">Type:</span><span class="tt-val">'  + formatRunType(run.type)   + '</span></div>';
  }
  html += _pressureTooltipExtra(entity.g, entity.j);
  tooltipEl.innerHTML = html;

  const W = canvas.width, H = canvas.height;
  const ttW = tooltipEl.offsetWidth || 160, ttH = tooltipEl.offsetHeight || 38;
  let tx = cx + 14, ty = cy - ttH - 10;
  if (tx + ttW > W) tx = cx - ttW - 14;
  if (ty < 0) ty = cy + 14;
  tooltipEl.style.left = tx + 'px';
  tooltipEl.style.top  = ty + 'px';
  tooltipEl.classList.add('visible');
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  _lastMouseX = (e.clientX - rect.left) * (canvas.width  / rect.width);
  _lastMouseY = (e.clientY - rect.top)  * (canvas.height / rect.height);
  renderTooltip(findHoveredEntity(_lastMouseX, _lastMouseY), _lastMouseX, _lastMouseY);
});

canvas.addEventListener('mouseleave', () => {
  tooltipEl.classList.remove('visible');
  hoveredEntity = null;
});

// ─────────────────────────────────────────────────────────────────────────────
//  Run highlights — glowing aura drawn under player circles
// ─────────────────────────────────────────────────────────────────────────────

let showRunHighlights = false;

function drawRunHighlights(fi) {
  if (!showRunHighlights || !_hasRuns) return;
  const period = String(D.meta.period[fi]);
  const t = D.meta.time[fi];
  const rs = (D.runs && D.runs[period]) || [];

  const sc = T.sc;
  const baseR = 1.4;
  // Glow ring sits just outside the player circle
  const ringR = (baseR + 0.55) * sc;

  ctx.save();
  ctx.setLineDash([]);

  for (const run of rs) {
    if (run.s > t || run.e < t || !run.g) continue;
    const entity = D.entities.find(e => e.g === run.g && e.j === run.j);
    if (!entity) continue;

    // Use the first visible source that has a position
    let pos = null;
    for (const src of D.sources) {
      if (!visibleSources.has(src.id)) continue;
      pos = getPos(entity, src.id, fi);
      if (pos) break;
    }
    if (!pos) continue;

    const [cx, cy] = tc(pos[0], pos[1]);
    const glowColor = D.colors[String(run.g)] || '#ffffff';

    ctx.globalAlpha = 0.9;
    ctx.shadowBlur    = Math.max(10, sc * 0.9);
    ctx.shadowColor   = glowColor;
    ctx.strokeStyle   = glowColor;
    ctx.lineWidth     = Math.max(1.5, sc * 0.13);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, 2 * Math.PI);
    ctx.stroke();
  }

  ctx.restore();
  // Reset shadow so it doesn't bleed into subsequent draw calls
  ctx.shadowBlur  = 0;
  ctx.shadowColor = 'transparent';
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pressure arrows
// ─────────────────────────────────────────────────────────────────────────────

function _pressureEntityPos(g, j, fallbackX, fallbackY) {
  // Live tracked position, falling back to the static MA35 snapshot
  if (g && j) {
    const ent = D.entities.find(e => e.g === g && e.j === j);
    if (ent) {
      for (const src of D.sources) {
        if (!visibleSources.has(src.id)) continue;
        const pos = getPos(ent, src.id, currentFi);
        if (pos) return tc(pos[0], pos[1]);
        break;
      }
    }
  }
  return tc(fallbackX, fallbackY);
}

function drawPressureArrow(x1, y1, x2, y2, color, alpha, sc) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < sc * 0.5) return;
  const angle = Math.atan2(dy, dx);
  const headLen = Math.max(18, sc * 1.2);   // much larger head
  const headAng = Math.PI / 5;
  const stopR   = (1.4 + 0.8) * sc;
  const ratio   = Math.max(0, (len - stopR) / len);
  const ex = x1 + dx * ratio, ey = y1 + dy * ratio;

  ctx.save();
  ctx.globalAlpha = alpha * 0.92;
  ctx.strokeStyle = color;
  ctx.fillStyle   = color;
  ctx.lineWidth   = Math.max(3, sc * 0.32);   // thicker shaft
  ctx.setLineDash([Math.max(5, sc * 0.35), Math.max(3, sc * 0.2)]);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - headLen * Math.cos(angle - headAng),
             ey - headLen * Math.sin(angle - headAng));
  ctx.lineTo(ex - headLen * Math.cos(angle + headAng),
             ey - headLen * Math.sin(angle + headAng));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPressures(fi) {
  if (!showPressures || !_hasPressures) return;
  const period = D.meta.period[fi];
  const t = D.meta.time[fi];
  const sc = T.sc;

  for (const pr of D.pressures) {
    if (pr.p !== period) continue;
    const dt = t - pr.t;
    if (dt < -1.0 || dt > 1.0) continue;
    const alpha = 1.0 - Math.abs(dt);

    // Live receiver position (tracked data) with static fallback
    const [rx, ry] = _pressureEntityPos(pr.rg, pr.rj, pr.rx, pr.ry);

    // Receiver highlight — white glow ring
    ctx.save();
    ctx.globalAlpha  = alpha * 0.9;
    ctx.strokeStyle  = '#ffffff';
    ctx.lineWidth    = Math.max(2.5, sc * 0.2);
    ctx.shadowBlur   = Math.max(10, sc * 0.7);
    ctx.shadowColor  = '#ffffff';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(rx, ry, (1.4 + 0.8) * sc, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

    // Arrow from each pressor's live position to receiver's live position
    for (const prs of pr.prs) {
      const [px, py] = _pressureEntityPos(prs.g, prs.j, prs.x, prs.y);
      const color = D.colors[String(prs.g)] || '#ff8800';
      drawPressureArrow(px, py, rx, ry, color, alpha, sc);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// ── Pressure panel ───────────────────────────────────────────────────────────

function updatePressurePanel(fi) {
  if (!showPressures || !_hasPressures) return;
  const period = D.meta.period[fi];
  const t = D.meta.time[fi];
  pressureListEl.innerHTML = '';
  const active = D.pressures.filter(pr => pr.p === period && Math.abs(t - pr.t) <= 1.0);
  if (active.length === 0) {
    const el = document.createElement('div'); el.id = 'runs-empty'; el.textContent = '—';
    pressureListEl.appendChild(el); return;
  }
  for (const pr of active) {
    const item = document.createElement('div');
    item.className = 'run-item';
    const recvName = (D.lineup && D.lineup[pr.rg + ':' + pr.rj]) || ('#' + pr.rj);
    const pressorNames = pr.prs
      .map(p => (D.lineup && D.lineup[p.g + ':' + p.j]) || ('#' + p.j))
      .join(', ');
    const intensity = pr.pr ? pr.pr.charAt(0).toUpperCase() + pr.pr.slice(1) : '—';
    item.innerHTML =
      '<div class="run-row"><span class="run-lbl">Under Pressure:</span><span class="run-val">' + recvName + '</span></div>' +
      '<div class="run-row"><span class="run-lbl">Pressuring:</span><span class="run-val">' + pressorNames + '</span></div>' +
      '<div class="run-row"><span class="run-lbl">Intensity:</span><span class="run-val">' + intensity + '</span></div>';
    pressureListEl.appendChild(item);
  }
}

// ── Pressure-aware tooltip helper ────────────────────────────────────────────

function _pressureTooltipExtra(g, j) {
  if (!showPressures || !_hasPressures) return '';
  const period = D.meta.period[currentFi];
  const t = D.meta.time[currentFi];
  let extra = '';
  for (const pr of D.pressures) {
    if (pr.p !== period || Math.abs(t - pr.t) > 1.0) continue;
    const intensity = pr.pr ? pr.pr.charAt(0).toUpperCase() + pr.pr.slice(1) : '';
    if (pr.rg === g && pr.rj === j) {
      // This player is receiving pressure
      const names = pr.prs.map(p => (D.lineup && D.lineup[p.g + ':' + p.j]) || ('#' + p.j)).join(', ');
      extra += '<div class="tt-sep"></div>';
      extra += '<div class="tt-row"><span class="tt-lbl">Pressure:</span><span class="tt-val">' + intensity + '</span></div>';
      extra += '<div class="tt-row"><span class="tt-lbl">From:</span><span class="tt-val">' + names + '</span></div>';
    } else {
      for (const prs of pr.prs) {
        if (prs.g === g && prs.j === j) {
          // This player is a pressor
          const recv = (D.lineup && D.lineup[pr.rg + ':' + pr.rj]) || ('#' + pr.rj);
          extra += '<div class="tt-sep"></div>';
          extra += '<div class="tt-row"><span class="tt-lbl">Pressing:</span><span class="tt-val">' + recv + '</span></div>';
          extra += '<div class="tt-row"><span class="tt-lbl">Intensity:</span><span class="tt-val">' + intensity + '</span></div>';
          break;
        }
      }
    }
  }
  return extra;
}

// Pressures toggle button (defaults off)
const btnPressures = document.getElementById('btn-pressures');
if (_hasPressures) {
  btnPressures.style.display = '';
  btnPressures.addEventListener('click', () => {
    showPressures = !showPressures;
    btnPressures.classList.toggle('btn-primary',   showPressures);
    btnPressures.classList.toggle('btn-secondary', !showPressures);
    _setRightCol();
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Defensive Compactness — convex hull + panel
// ─────────────────────────────────────────────────────────────────────────────

function convexHull(pts) {
  if (pts.length < 3) return pts;
  pts = pts.slice().sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length-1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function _findActivePhase(fi) {
  if (!_hasPhases) return null;
  const period = String(D.meta.period[fi]);
  const t = D.meta.time[fi];
  const ps = D.phases[period];
  if (!ps) return null;
  let lo = 0, hi = ps.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ps[mid].s <= t) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return (idx >= 0 && ps[idx].e >= t) ? ps[idx] : null;
}

function drawDefCompactness(fi) {
  if (!showDefCompactness || !_hasPhases) return;
  const ph = _findActivePhase(fi);
  if (!ph || !ph.defG) return;

  const defG = ph.defG;
  const canvasPositions = [];
  for (const entity of D.entities) {
    if (entity.g !== defG || entity.gk) continue;
    const inView = entity._bvSet && entity._bvSet.has(fi);
    if (inViewMode === 1 && !inView) continue;
    for (const src of D.sources) {
      if (!visibleSources.has(src.id)) continue;
      const pos = getPos(entity, src.id, fi);
      if (pos) { canvasPositions.push(tc(pos[0], pos[1])); break; }
    }
  }
  if (canvasPositions.length < 3) return;

  const hull = convexHull(canvasPositions);
  if (hull.length < 3) return;

  const teamColor = D.colors[String(defG)] || '#888';
  ctx.beginPath();
  ctx.moveTo(hull[0][0], hull[0][1]);
  for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i][0], hull[i][1]);
  ctx.closePath();

  ctx.globalAlpha = 0.10;
  ctx.fillStyle = teamColor;
  ctx.fill();

  ctx.globalAlpha = 0.38;
  ctx.strokeStyle = teamColor;
  ctx.lineWidth = Math.max(1.5, T.sc * 0.1);
  ctx.setLineDash([Math.max(4, T.sc * 0.25), Math.max(2, T.sc * 0.15)]);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

function updateDCPanel(fi) {
  if (!showDefCompactness || !_hasPhases) return;
  const ph = _findActivePhase(fi);
  if (!ph) { dcLabelVal.textContent = '—'; dcAdcVal.textContent = '—'; return; }

  const t = D.meta.time[fi];
  const dc = ph.dc || [];
  let dcLabel = '—', dcAdc = '—';
  for (let i = 0; i < dc.length; i++) {
    if (dc[i].s <= t && dc[i].e >= t) {
      dcLabel = dc[i].v || '—';
      dcAdc   = dc[i].adc ? Math.round(parseFloat(dc[i].adc)).toLocaleString() : '—';
      break;
    }
  }
  dcLabelVal.textContent = dcLabel;
  dcAdcVal.textContent   = dcAdc;
}

// Def Compactness toggle button
const btnDefCompactness = document.getElementById('btn-def-compactness');
if (_hasPhases) {
  btnDefCompactness.style.display = '';
  btnDefCompactness.addEventListener('click', () => {
    showDefCompactness = !showDefCompactness;
    btnDefCompactness.classList.toggle('btn-primary',   showDefCompactness);
    btnDefCompactness.classList.toggle('btn-secondary', !showDefCompactness);
    _setRightCol();
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phase overlay — label + attack-direction arrow on the pitch
// ─────────────────────────────────────────────────────────────────────────────

function _getAttackDir(possG, fi) {
  // Determine attack direction from the possessing team's goalkeeper x-position.
  // A goalkeeper on the left side (x < 0) means that team's goal is on the left,
  // so they attack towards the right (+x), and vice-versa.
  for (const entity of D.entities) {
    if (entity.g !== possG || !entity.gk) continue;
    for (const src of D.sources) {
      if (!visibleSources.has(src.id)) continue;
      const pos = getPos(entity, src.id, fi);
      if (pos) return pos[0] < 0 ? 'right' : 'left';
      break;
    }
  }
  // Fallback: assume home team (tg=1) attacks right in P1, left in P2
  return (possG === 1) === (D.meta.period[fi] === 1) ? 'right' : 'left';
}

function drawPhaseOverlay(fi) {
  if (!showPhaseOverlay || !_hasPhases) return;
  const ph = _findActivePhase(fi);
  if (!ph || !ph.possG) return;

  const possG     = ph.possG;
  const teamColor = D.colors[String(possG)] || '#ffffff';
  const sc        = T.sc;
  const attackDir = _getAttackDir(possG, fi);

  // Position text 10m above the bottom touchline, centered horizontally
  const [, innerBottomY] = tc(0, -(D.pitch.W / 2) + 10);
  const fontSize  = Math.max(54, sc * 4.8) * 0.6;   // 40% smaller than the original size
  const textY     = innerBottomY;
  const textX     = canvas.width / 2;
  const arrowY    = textY + fontSize + Math.max(10, sc * 0.4);

  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.setLineDash([]);

  // ── Phase label with black outline ────────────────────────────────────────
  const label = ph.l.toUpperCase();
  ctx.font          = '700 ' + fontSize + 'px ' + FONT_SANS;
  ctx.letterSpacing = '0.06em';
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'middle';
  ctx.lineJoin      = 'round';
  ctx.strokeStyle   = 'rgba(0,0,0,0.9)';
  ctx.lineWidth     = Math.max(3, fontSize * 0.12);
  ctx.strokeText(label, textX, textY);
  ctx.fillStyle     = teamColor;
  ctx.fillText(label, textX, textY);
  ctx.letterSpacing = '0px';  // reset so it doesn't affect other draws

  // ── Attack direction arrow ────────────────────────────────────────────────
  const arrowHalfW = Math.max(40, sc * 3.2);
  const headLen    = Math.max(12, sc * 0.9);
  const headAngle  = Math.PI / 4.5;
  const angle      = attackDir === 'right' ? 0 : Math.PI;
  const ax1 = textX + (attackDir === 'right' ? -arrowHalfW :  arrowHalfW);
  const ax2 = textX + (attackDir === 'right' ?  arrowHalfW : -arrowHalfW);
  // Arrowhead triangle vertices
  const hx1 = ax2 - headLen * Math.cos(angle - headAngle);
  const hy1 = arrowY - headLen * Math.sin(angle - headAngle);
  const hx2 = ax2 - headLen * Math.cos(angle + headAngle);
  const hy2 = arrowY - headLen * Math.sin(angle + headAngle);
  // Shaft ends just behind the arrowhead
  const shaftEnd = ax2 - headLen * Math.cos(angle) * 0.65;

  // Draw twice: black outline first, team colour on top
  for (const [lw, col] of [
      [Math.max(4.5, sc * 0.32), 'rgba(0,0,0,0.9)'],
      [Math.max(2.5, sc * 0.18), teamColor],
  ]) {
    ctx.lineWidth   = lw;
    ctx.strokeStyle = col;
    ctx.fillStyle   = col;
    ctx.lineJoin    = 'round';
    ctx.beginPath(); ctx.moveTo(ax1, arrowY); ctx.lineTo(shaftEnd, arrowY); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax2, arrowY);
    ctx.lineTo(hx1, hy1);
    ctx.lineTo(hx2, hy2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// Phase Overlay toggle button
const btnPhaseOverlay = document.getElementById('btn-phase-overlay');
if (_hasPhases) {
  btnPhaseOverlay.style.display = '';
  btnPhaseOverlay.addEventListener('click', () => {
    showPhaseOverlay = !showPhaseOverlay;
    btnPhaseOverlay.classList.toggle('btn-primary',   showPhaseOverlay);
    btnPhaseOverlay.classList.toggle('btn-secondary', !showPhaseOverlay);
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Overload overlay — glow ring on ball + label during active overload
// ─────────────────────────────────────────────────────────────────────────────

function drawOverloadOverlay(fi) {
  if (!showOverloadOverlay || !_hasPhases) return;
  const ph = _findActivePhase(fi);
  if (!ph) return;

  const t = D.meta.time[fi];
  const ol = ph.ol || [];
  let activeOl = null;
  for (let i = 0; i < ol.length; i++) {
    if (ol[i].s <= t && ol[i].e >= t) { activeOl = ol[i]; break; }
  }
  if (!activeOl) return;

  // Find ball position via first visible source
  const ballEntity = D.entities.find(e => e.g === 4);
  if (!ballEntity) return;
  let ballPos = null;
  for (const src of D.sources) {
    if (!visibleSources.has(src.id)) continue;
    ballPos = getPos(ballEntity, src.id, fi);
    if (ballPos) break;
  }
  if (!ballPos) return;

  const [bx, by] = tc(ballPos[0], ballPos[1]);
  const sc = T.sc;
  const ballColor = D.colors['4'] || '#f5c518';

  // ── Glow ring around ball ──
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha  = 0.88;
  ctx.strokeStyle  = ballColor;
  ctx.lineWidth    = Math.max(2, sc * 0.18);
  ctx.shadowBlur   = Math.max(12, sc * 0.9);
  ctx.shadowColor  = ballColor;
  ctx.beginPath();
  ctx.arc(bx, by, (0.7 + 0.7) * sc, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  // ── Label: "X vs Y Z Overload" ──
  const text = (activeOl.att || '?') + ' vs ' + (activeOl.def || '?') +
               (activeOl.t ? ' ' + activeOl.t : '') + ' Overload';
  const fontSize = Math.max(11, sc * 0.9);
  const ty = by - (0.7 + 0.7) * sc - Math.max(5, sc * 0.25);

  ctx.save();
  ctx.font          = '700 ' + fontSize + 'px ' + FONT_SANS;
  ctx.letterSpacing = '0.03em';
  ctx.textAlign     = 'center';
  ctx.textBaseline  = 'bottom';
  ctx.lineJoin      = 'round';
  ctx.strokeStyle   = 'rgba(0,0,0,0.85)';
  ctx.lineWidth     = Math.max(2, fontSize * 0.14);
  ctx.strokeText(text, bx, ty);
  ctx.fillStyle     = ballColor;
  ctx.fillText(text, bx, ty);
  ctx.letterSpacing = '0px';
  ctx.restore();
}

// Overload Overlay toggle button
const btnOverloadOverlay = document.getElementById('btn-overload-overlay');
if (_hasPhases) {
  btnOverloadOverlay.style.display = '';
  btnOverloadOverlay.addEventListener('click', () => {
    showOverloadOverlay = !showOverloadOverlay;
    btnOverloadOverlay.classList.toggle('btn-primary',   showOverloadOverlay);
    btnOverloadOverlay.classList.toggle('btn-secondary', !showOverloadOverlay);
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Run Info overlay — display label and type below player
// ─────────────────────────────────────────────────────────────────────────────

function drawRunInfo(fi) {
  if (!showRunInfo || !_hasRuns) return;
  const period = String(D.meta.period[fi]);
  const t = D.meta.time[fi];
  const rs = (D.runs && D.runs[period]) || [];

  const sc = T.sc;
  const fontSize = Math.max(9, sc * 0.7 * overlayTextSize);
  const offsetY = (1.4 + 0.5) * sc;

  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.95;
  ctx.font = '400 ' + fontSize + 'px ' + FONT_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const run of rs) {
    if (run.s > t || run.e < t || !run.g || !run.j) continue;
    const entity = D.entities.find(e => e.g === run.g && e.j === run.j);
    if (!entity) continue;

    let pos = null;
    for (const src of D.sources) {
      if (!visibleSources.has(src.id)) continue;
      pos = getPos(entity, src.id, fi);
      if (pos) break;
    }
    if (!pos) continue;

    const [cx, cy] = tc(pos[0], pos[1]);
    const teamColor = D.colors[String(run.g)] || '#ffffff';

    // Draw Label only
    if (run.label) {
      const label = formatRunLabel(run.label);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(2, fontSize * 0.2);
      ctx.strokeText(label, cx, cy + offsetY);
      ctx.fillStyle = teamColor;
      ctx.fillText(label, cx, cy + offsetY);
    }
  }

  ctx.restore();
}

// Run Info toggle button
const btnRunInfo = document.getElementById('btn-run-info');
if (_hasRuns) {
  btnRunInfo.style.display = '';
  btnRunInfo.addEventListener('click', () => {
    showRunInfo = !showRunInfo;
    btnRunInfo.classList.toggle('btn-primary',   showRunInfo);
    btnRunInfo.classList.toggle('btn-secondary', !showRunInfo);
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pressure Info overlay — display pressure details below player
// ─────────────────────────────────────────────────────────────────────────────

function drawPressureInfo(fi) {
  if (!showPressureInfo || !_hasPressures) return;
  const period = D.meta.period[fi];
  const t = D.meta.time[fi];

  const sc = T.sc;
  const fontSize = Math.max(9, sc * 0.7 * overlayTextSize);
  const offsetY = (1.4 + 0.5) * sc;
  const pressureOffsetY = offsetY + fontSize + 2;  // Below Run Info
  const pressingOffsetY = pressureOffsetY + fontSize + 2;  // Below Pressure

  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.95;
  ctx.font = '400 ' + fontSize + 'px ' + FONT_SANS;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Process all pressures for this frame
  for (const pr of D.pressures) {
    if (pr.p !== period || Math.abs(t - pr.t) > 1.0) continue;

    // Check receiver (being pressed) — positioned below Run Info
    if (pr.rg && pr.rj) {
      const entity = D.entities.find(e => e.g === pr.rg && e.j === pr.rj);
      if (entity) {
        let pos = null;
        for (const src of D.sources) {
          if (!visibleSources.has(src.id)) continue;
          pos = getPos(entity, src.id, fi);
          if (pos) break;
        }
        if (pos) {
          const [cx, cy] = tc(pos[0], pos[1]);
          const intensity = pr.pr ? pr.pr.charAt(0).toUpperCase() + pr.pr.slice(1) : 'Moderate';
          const text = 'Pressure: ' + intensity;
          const teamColor = D.colors[String(pr.rg)] || '#ffffff';
          ctx.strokeStyle = 'rgba(0,0,0,0.5)';
          ctx.lineWidth = Math.max(2, fontSize * 0.2);
          ctx.fillStyle = teamColor;
          ctx.strokeText(text, cx, cy + pressureOffsetY);
          ctx.fillText(text, cx, cy + pressureOffsetY);
        }
      }
    }

    // Check pressors (applying pressure) — positioned even lower
    for (const prs of pr.prs) {
      if (prs.g && prs.j) {
        const entity = D.entities.find(e => e.g === prs.g && e.j === prs.j);
        if (entity) {
          let pos = null;
          for (const src of D.sources) {
            if (!visibleSources.has(src.id)) continue;
            pos = getPos(entity, src.id, fi);
            if (pos) break;
          }
          if (pos) {
            const [cx, cy] = tc(pos[0], pos[1]);
            const text = 'Pressing';
            const teamColor = D.colors[String(prs.g)] || '#ffffff';
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = Math.max(2, fontSize * 0.2);
            ctx.fillStyle = teamColor;
            ctx.strokeText(text, cx, cy + pressingOffsetY);
            ctx.fillText(text, cx, cy + pressingOffsetY);
          }
        }
      }
    }
  }

  ctx.restore();
}

// Pressure Info toggle button
const btnPressureInfo = document.getElementById('btn-pressure-info');
if (_hasPressures) {
  btnPressureInfo.style.display = '';
  btnPressureInfo.addEventListener('click', () => {
    showPressureInfo = !showPressureInfo;
    btnPressureInfo.classList.toggle('btn-primary',   showPressureInfo);
    btnPressureInfo.classList.toggle('btn-secondary', !showPressureInfo);
    render(currentFi);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event labels — helpers for drawing an event name beneath the player who makes the action
// ─────────────────────────────────────────────────────────────────────────────

// Position of the player who made `evt` (first visible source that has them at
// frame `fi`), or null when the event has no player or they are not on the pitch.
function actorPosFor(evt, fi) {
  if (!evt || evt.jn === null || evt.g === null) return null;
  const entity = D.entities.find(e => e.g === evt.g && e.j === evt.jn);
  if (!entity) return null;
  for (const src of D.sources) {
    if (!visibleSources.has(src.id)) continue;
    const pos = getPos(entity, src.id, fi);
    if (pos) return pos;
  }
  return null;
}

// Black rounded box with white text; (cx, topY) is the top-centre of the box.
function drawEventLabel(text, cx, topY, fontSize) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = '400 ' + fontSize + 'px ' + FONT_SANS;
  const tw = ctx.measureText(text).width + 12;
  const th = fontSize + 5;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath(); ctx.roundRect(cx - tw / 2, topY, tw, th, 4); ctx.fill();
  ctx.fillStyle    = '#fff';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, topY + th / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Motion tails rendering
// ─────────────────────────────────────────────────────────────────────────────

function drawTails(fi) {
  if (tailLength < 1) return;
  const sc = T.sc;
  const globalStartFi = Math.max(0, fi - tailLength);
  const globalSteps   = fi - globalStartFi;
  if (globalSteps === 0) return;

  // Build map of run entities: key → pre-computed run start frame index (_sf)
  const runPeriod = String(D.meta.period[fi]);
  const runTime   = D.meta.time[fi];
  const runEntityKeys    = new Set();
  const runEntityStartFi = new Map();
  if (showRunHighlights && _hasRuns) {
    for (const run of ((D.runs && D.runs[runPeriod]) || [])) {
      if (run.s <= runTime && run.e >= runTime && run.g) {
        const key = run.g + ':' + run.j;
        runEntityKeys.add(key);
        if (run._sf !== undefined) runEntityStartFi.set(key, run._sf);
      }
    }
  }

  for (const entity of D.entities) {
    const isBall = entity.g === 4;
    const inView = isBall || (entity._bvSet && entity._bvSet.has(fi));
    if (inViewMode === 1 && !inView) continue;

    const eKey = entity.g + ':' + entity.j;
    const isRunEntity = runEntityKeys.has(eKey);

    // When global tails are off, only draw tails for run entities
    if (!showTails && !isRunEntity) continue;

    const alphaScale = (inViewMode === 2 && !inView) ? 0.2 : 1.0;
    const teamColor  = D.colors[entity.g] || '#888';
    const baseR      = 0.7;

    // Clamp run entities' trail to their run start frame
    const startFi = (isRunEntity && runEntityStartFi.has(eKey))
      ? Math.max(globalStartFi, runEntityStartFi.get(eKey))
      : globalStartFi;
    const steps = fi - startFi;
    if (steps <= 0) continue;

    for (let si = D.sources.length - 1; si >= 0; si--) {
      const src = D.sources[si];
      if (!visibleSources.has(src.id)) continue;

      // Apply appearance overrides from interactive controls
      const style = window._sourceStyles ? window._sourceStyles[src.id] : null;
      const srcAlpha = style ? style.alpha : src.alpha;
      const srcFill = style ? style.fill : src.fill;

      const dotR = baseR * sc;

      for (let k = 0; k < steps; k++) {
        const pastFi = startFi + k;
        const pos = getPos(entity, src.id, pastFi);
        if (!pos) continue;

        const t = (k + 1) / steps;
        const alpha = t * t * srcAlpha * 0.6 * alphaScale;
        const tailR = dotR * (0.25 + 0.55 * t);

        const [cx, cy] = tc(pos[0], pos[1]);
        ctx.globalAlpha = alpha;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(cx, cy, tailR, 0, 2 * Math.PI);

        if (srcFill) {
          ctx.fillStyle = teamColor;
          ctx.fill();
        } else {
          ctx.strokeStyle = teamColor;
          ctx.lineWidth = Math.max(1, sc * 0.1);
          ctx.stroke();
        }
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Events rendering
// ─────────────────────────────────────────────────────────────────────────────

function lastEventBefore(fi) {
  let lo = 0, hi = D.events.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (D.events[mid].fi <= fi) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result >= 0 ? D.events[result] : null;
}

// How long (seconds of match time) an event marker/label stays on screen.
const EVENT_DISPLAY_SECONDS = 2.0;

// Seconds since `evt` happened at frame `fi`; Infinity if it belongs to another period.
function eventAge(evt, fi) {
  if (D.meta.period[fi] !== evt.p) return Infinity;
  return D.meta.time[fi] - D.meta.time[evt.fi];
}

function drawEvent(fi) {
  const evt = lastEventBefore(fi);
  if (!evt || eventAge(evt, fi) > EVENT_DISPLAY_SECONDS) return;

  const [cx, cy] = tc(evt.x, evt.y);
  const color    = D.colors[evt.g] || '#fff';
  const s        = Math.max(6, T.sc * 0.35);

  // Attached to a player on the pitch: label beneath that player, no marker.
  const pos = actorPosFor(evt, fi);
  if (pos) {
    const [px, py] = tc(pos[0], pos[1]);
    drawEventLabel(evt.t, px, py + 1.4 * T.sc + 4, 11);
    return;
  }

  // No player: keep the x marker at the event coordinates, label above it.
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s);
  ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s);
  ctx.stroke();
  drawEventLabel(evt.t, cx, cy - s - 20, 11);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Meta display + time input sync
// ─────────────────────────────────────────────────────────────────────────────

function updateMeta(fi) {
  const period  = D.meta.period[fi];
  const timeSec = D.meta.time[fi];
  const impliedFrame = D.meta.impliedFrame ? D.meta.impliedFrame[fi] : 0;
  const periodOffset = D.meta.periodFrameOffsets ? (D.meta.periodFrameOffsets[period] || 0) : 0;
  // Convert from 100Hz to 25Hz space: divide by 4
  const frameIn25Hz = Math.floor(impliedFrame / 4);
  const displayFrame = frameIn25Hz + periodOffset;
  const mm = String(Math.floor(timeSec / 60) + (period - 1) * 45).padStart(2, '0');
  const ss = String(Math.floor(timeSec % 60)).padStart(2, '0');
  const ms = Math.round(timeSec * 1000);
  metaDiv.innerHTML = 'P' + period + ' &nbsp;|&nbsp; ' + mm + ':' + ss + ' &nbsp;|&nbsp; MS:' + ms + ' | FC:' + displayFrame;

  // Sync time inputs (without triggering their change handlers)
  updatingTimeInputs = true;
  inpPeriod.value = period;
  inpMin.value    = Math.floor(timeSec / 60) + (period - 1) * 45;
  inpSec.value    = Math.floor(timeSec % 60);
  updatingTimeInputs = false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Live scoreboard (2D canvas, so it is part of GIF / video exports)
// ─────────────────────────────────────────────────────────────────────────────
// Score at any moment = goal events up to the current frame. Own goals (qualifier 28) are credited to the
// opposing side; if that disagrees with the final score in matchstats while the other reading agrees, the
// other reading is used (the feed's team attribution for own goals is not assumed). Without an events
// feed there is nothing to count, so the score shows dashes rather than a misleading 0 - 0.
const scoreboardGoals = (() => {
  const goals = D.events.filter(e => e.t === 'goal' && (e.ti === 0 || e.ti === 1))
    .map(e => ({ fi: e.fi, ti: e.ti, own: (e.quals || []).some(q => q.id === 28) }));
  const final = [parseInt(D.lineup['match_home_score'], 10), parseInt(D.lineup['match_away_score'], 10)];
  const tally = (ownToOpponent) => goals.reduce((t, g) => { t[g.own && ownToOpponent ? 1 - g.ti : g.ti]++; return t; }, [0, 0]);
  const matches = (t) => t[0] === final[0] && t[1] === final[1];
  const ownToOpponent = !(goals.some(g => g.own) && !matches(tally(true)) && matches(tally(false)));
  return goals.map(g => ({ fi: g.fi, scorer: g.own && ownToOpponent ? 1 - g.ti : g.ti }));
})();
const scoreAt = (fi) => { const s = [0, 0]; for (const g of scoreboardGoals) { if (g.fi > fi) break; s[g.scorer]++; } return s; };
const teamCode = (n) => {
  const code = D.lineup['teamcode_' + n];
  if (code) return String(code).toUpperCase().slice(0, 4);
  const name = D.lineup['teamname_' + n] || (n === 1 ? 'Home' : 'Away');
  return name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
};

const BOARD_LOGO = new Image();                                   // colour brand logo for the scoreboard tab
BOARD_LOGO.onload = () => { if (typeof currentFi !== 'undefined') render(currentFi); };
BOARD_LOGO.src = '../assets/opta-logo.png';

// The logo is much larger than its slot, and a single big downscale looks jagged. Halve it step by step
// (smoothing on) down to the exact pixel size once, cache that, and draw it unscaled at whole pixels.
let boardLogoCache = null;
function boardLogoAt(w, h) {
  const key = w + 'x' + h;
  if (boardLogoCache && boardLogoCache.key === key) return boardLogoCache.canvas;
  let src = BOARD_LOGO, sw = BOARD_LOGO.naturalWidth, sh = BOARD_LOGO.naturalHeight;
  while (sw / 2 > w && sh / 2 > h) {
    const c = document.createElement('canvas');
    c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  boardLogoCache = { key, canvas: out };
  return out;
}

function drawScoreboard(fi) {
  const mm = String(Math.floor(D.meta.time[fi] / 60) + (D.meta.period[fi] - 1) * 45).padStart(2, '0');
  const ss = String(Math.floor(D.meta.time[fi] % 60)).padStart(2, '0');
  const known = D.events.length > 0;
  const sc2 = scoreAt(fi);

  const bandH = MARGIN * T.sc;                                   // the grass strip above the touchline
  const h = Math.max(22, Math.min(40, bandH * 0.8));
  const widths = [2.5 * h, 2.3 * h, 2.2 * h, 2.3 * h];            // clock | home | score | away
  const tabW = 1.15 * h;                                         // white tab with the brand logo, before the clock
  const total = tabW + widths.reduce((a, b) => a + b, 0);
  const xTab = T.ox + (T.L + 2 * MARGIN) * T.sc / 2 - total / 2;
  const x0 = xTab + tabW;                                        // the clock and everything after it start here
  const y0 = T.oy + (bandH - h) / 2;
  const NAVY = '#3F1568', PANEL = '#f3f3f6', INK = '#16161d';

  const rr = (x, y, w, hh, r, fill) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  };
  const text = (str, cx, cy, size, colour) => {
    ctx.font = '700 ' + size + 'px ' + FONT_SANS;
    ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(str, cx, cy);
  };

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = h * 0.3; ctx.shadowOffsetY = h * 0.08;
  rr(xTab, y0, total, h, h * 0.18, PANEL);                        // one white plate behind everything
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(xTab, y0, total, h); ctx.clip();

  // brand logo tab (far left)
  ctx.fillStyle = '#ffffff'; ctx.fillRect(xTab, y0, tabW, h);
  if (BOARD_LOGO.complete && BOARD_LOGO.naturalWidth > 0) {
    const lh = h * 0.68, lw = lh * BOARD_LOGO.naturalWidth / BOARD_LOGO.naturalHeight;
    ctx.drawImage(boardLogoAt(Math.round(lw), Math.round(lh)), Math.round(xTab + (tabW - lw) / 2), Math.round(y0 + (h - lh) / 2));
  }

  // clock

  ctx.fillStyle = NAVY; ctx.fillRect(x0, y0, widths[0], h);
  text(mm + ':' + ss, x0 + widths[0] / 2, y0 + h / 2, h * 0.5, '#ffffff');

  // team code panels with the team colour underneath
  const codePanel = (n, x, w) => {
    text(teamCode(n), x + w / 2, y0 + h * 0.45, h * 0.56, INK);
    const c2 = teamColour2(n);
    ctx.fillStyle = D.colors[String(n)] || '#888888';
    ctx.fillRect(x, y0 + h * 0.84, c2 ? w / 2 : w, h * 0.16);      // two-colour team: half the bar each
    if (c2) { ctx.fillStyle = c2; ctx.fillRect(x + w / 2, y0 + h * 0.84, w / 2, h * 0.16); }
  };
  codePanel(1, x0 + widths[0], widths[1]);
  const xAway = x0 + widths[0] + widths[1] + widths[2];
  codePanel(2, xAway, widths[3]);

  // score pill
  const xs = x0 + widths[0] + widths[1];
  ctx.fillStyle = NAVY; ctx.fillRect(xs, y0, widths[2], h);
  const cy = y0 + h / 2, third = widths[2] / 3;
  text(known ? String(sc2[0]) : '–', xs + third * 0.62, cy, h * 0.56, '#ffffff');
  text(known ? String(sc2[1]) : '–', xs + widths[2] - third * 0.62, cy, h * 0.56, '#ffffff');
  ctx.fillStyle = '#FAA51A';                                      // brand orange
  ctx.beginPath(); ctx.arc(xs + widths[2] / 2, cy, Math.max(2, h * 0.07), 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Time input → frame lookup
// ─────────────────────────────────────────────────────────────────────────────

function findFrameByTime(period, matchMinute, second) {
  // Convert match minute back to period-relative seconds
  const periodRelMin = matchMinute - (period - 1) * 45;
  const targetSec = periodRelMin * 60 + second;

  let bestFi = 0, bestDist = Infinity;
  for (let fi = 0; fi < D.meta.period.length; fi++) {
    if (D.meta.period[fi] !== period) continue;
    const dist = Math.abs(D.meta.time[fi] - targetSec);
    if (dist < bestDist) { bestDist = dist; bestFi = fi; }
    if (dist < 0.5) break;  // close enough
  }
  return bestFi;
}

function onTimeInputChange() {
  if (updatingTimeInputs) return;
  const period = parseInt(inpPeriod.value, 10) || 1;
  const minute = parseInt(inpMin.value, 10) || 0;
  const second = parseInt(inpSec.value, 10) || 0;
  const fi = findFrameByTime(period, minute, second);
  stopPlayback();
  render(fi);
}

// ─────────────────────────────────────────────────────────────────────────────
//  3D renderer — lazy-loaded Three.js (r134 UMD) on first toggle
// ─────────────────────────────────────────────────────────────────────────────

let _three      = null;   // THREE namespace once loaded
let scene3D     = null;
let camera3D    = null;
let renderer3D  = null;
let controls3D  = null;
let raf3D       = null;
const playerMeshes3D = {};  // "g:j" → THREE.Mesh
const ballMeshes3D   = {};  // srcId  → THREE.Mesh (one sphere per source with ball data)

const _PLAYER_H = 1.85;
const _PLAYER_R = 0.3;    // cylinder visual radius
const _BALL_R   = 0.11;

// pitch (x right, y up) → Three.js world (x right, y=height, z toward viewer → -pitch_y)
function _p2w(px, py, h) { return [px, h || 0, -(py || 0)]; }

function _loadThree(cb) {
  if (_three) { cb(); return; }
  const btn = document.getElementById('btn-3d');
  if (btn) { btn.textContent = '3D ⟳'; btn.disabled = true; }
  const done = () => {
    if (btn) { btn.textContent = '3D'; btn.disabled = false; }
    cb();
  };
  const fail = (what) => {
    if (btn) { btn.textContent = '3D ✕'; btn.disabled = false; }
    console.error('Failed to load ' + what + '.');
  };
  const s1 = document.createElement('script');
  // r128: last Three.js release where examples/js/controls/OrbitControls.js
  // extends the global THREE namespace (UMD-compatible, no ES-module syntax)
  s1.src = VENDOR.three;
  s1.onerror = () => fail('Three.js');
  s1.onload  = () => {
    const s2 = document.createElement('script');
    s2.src = VENDOR.orbit;
    s2.onerror = () => fail('OrbitControls');
    s2.onload  = () => { _three = window.THREE; done(); };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

function _build3DPitchLines() {
  const THREE = _three;
  const L = D.pitch.L, W = D.pitch.W;
  const pts = [];
  const RAD = Math.PI / 180;

  const seg = (x1, y1, x2, y2) => {
    pts.push(x1, 0.02, -y1, x2, 0.02, -y2);
  };
  const circPts = (cx, cy, r, n) => {
    for (let i = 0; i < n; i++) {
      const a1 = (i / n) * 2 * Math.PI, a2 = ((i + 1) / n) * 2 * Math.PI;
      pts.push(cx + r * Math.cos(a1), 0.02, -(cy + r * Math.sin(a1)));
      pts.push(cx + r * Math.cos(a2), 0.02, -(cy + r * Math.sin(a2)));
    }
  };
  const arcPts = (cx, cy, r, a1, a2, n) => {
    const step = (a2 - a1) / n;
    for (let i = 0; i < n; i++) {
      const t1 = a1 + i * step, t2 = a1 + (i + 1) * step;
      pts.push(cx + r * Math.cos(t1), 0.02, -(cy + r * Math.sin(t1)));
      pts.push(cx + r * Math.cos(t2), 0.02, -(cy + r * Math.sin(t2)));
    }
  };

  // Pitch boundary
  seg(-L/2, -W/2,  L/2, -W/2);
  seg( L/2, -W/2,  L/2,  W/2);
  seg( L/2,  W/2, -L/2,  W/2);
  seg(-L/2,  W/2, -L/2, -W/2);
  // Halfway line
  seg(0, -W/2, 0, W/2);
  // Centre circle + spot
  circPts(0, 0, 9.15, 48);
  circPts(0, 0, 0.15, 8);
  // Penalty areas
  seg(-L/2, -20.15, -L/2+16.5, -20.15);  seg(-L/2+16.5, -20.15, -L/2+16.5, 20.15);  seg(-L/2+16.5, 20.15, -L/2, 20.15);
  seg( L/2, -20.15,  L/2-16.5, -20.15);  seg( L/2-16.5, -20.15,  L/2-16.5, 20.15);  seg( L/2-16.5, 20.15,  L/2, 20.15);
  // Goal areas
  seg(-L/2, -9.15, -L/2+5.5, -9.15);  seg(-L/2+5.5, -9.15, -L/2+5.5, 9.15);  seg(-L/2+5.5, 9.15, -L/2, 9.15);
  seg( L/2, -9.15,  L/2-5.5, -9.15);  seg( L/2-5.5, -9.15,  L/2-5.5, 9.15);  seg( L/2-5.5, 9.15,  L/2, 9.15);
  // Penalty spots
  circPts(-L/2+11, 0, 0.15, 8);
  circPts( L/2-11, 0, 0.15, 8);
  // Penalty D arcs (the portion outside each penalty area, ≈±57° from the goal axis)
  arcPts(-L/2+11, 0, 10,  -57*RAD,   57*RAD, 20);
  arcPts( L/2-11, 0, 10, 123*RAD,  237*RAD, 20);
  // Corner arcs (r = 1 m)
  arcPts(-L/2, -W/2, 1,    0*RAD,  90*RAD, 8);
  arcPts( L/2, -W/2, 1,   90*RAD, 180*RAD, 8);
  arcPts( L/2,  W/2, 1,  180*RAD, 270*RAD, 8);
  arcPts(-L/2,  W/2, 1,  270*RAD, 360*RAD, 8);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(pts), 3));
  return new THREE.LineSegments(
    geo, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.85, transparent: true }));
}

function _addGoals3D() {
  const THREE   = _three;
  const POST_R  = 0.0635;          // 5 in diameter → 2.5 in radius = 0.0635 m
  const POST_H  = 2.4384;          // 8 ft = 2.4384 m
  const GOAL_W  = 7.3152;          // 24 ft = 7.3152 m (centre-to-centre of posts)
  const gx      = D.pitch.L / 2;   // goal line x (pitch coords → Three.js x)

  const postGeo = new THREE.CylinderGeometry(POST_R, POST_R, POST_H, 10);
  const barGeo  = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_W, 10);
  const mat     = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 80 });
  const rearPostGeo = new THREE.CylinderGeometry(POST_R * 0.6, POST_R * 0.6, POST_H, 8);
  const sideBarGeo  = new THREE.CylinderGeometry(POST_R * 0.6, POST_R * 0.6, GOAL_NET_D, 8);
  // One mesh cell: a pair of diagonals. Tiled (one tile = NET_CELL metres) it becomes a diamond net.
  const nc = document.createElement('canvas'); nc.width = nc.height = 64;
  const ng = nc.getContext('2d');
  ng.strokeStyle = 'rgba(255,255,255,0.75)'; ng.lineWidth = 2.5;
  ng.beginPath(); ng.moveTo(0, 0); ng.lineTo(64, 64); ng.moveTo(0, 64); ng.lineTo(64, 0); ng.stroke();
  const netTex = new THREE.CanvasTexture(nc);
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;

  // Build one goal at the given x position (positive or negative)
  const addGoal = (goalX) => {
    // Left and right vertical posts (in Three.js: z = ±GOAL_W/2, pitch y = ∓GOAL_W/2)
    [-1, 1].forEach(side => {
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(goalX, POST_H / 2, side * GOAL_W / 2);
      scene3D.add(post);
    });

    // Crossbar — CylinderGeometry axis is Y by default; rotate 90° around X to lay along Z
    const bar = new THREE.Mesh(barGeo, mat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(goalX, POST_H, 0);
    scene3D.add(bar);

    // Net: rear posts and top bars as a thin white frame, diamond mesh on the top, back and both sides
    const sign = goalX < 0 ? -1 : 1, D = GOAL_NET_D, rearX = goalX + sign * D;
    [-1, 1].forEach(side => {
      const rp = new THREE.Mesh(rearPostGeo, mat);
      rp.position.set(rearX, POST_H / 2, side * GOAL_W / 2);
      scene3D.add(rp);
      const sb = new THREE.Mesh(sideBarGeo, mat);                          // top side bar, goal post to rear post
      sb.rotation.z = Math.PI / 2;
      sb.position.set(goalX + sign * D / 2, POST_H, side * GOAL_W / 2);
      scene3D.add(sb);
    });
    const rb = new THREE.Mesh(barGeo, mat);                                // top rear bar
    rb.rotation.x = Math.PI / 2;
    rb.position.set(rearX, POST_H, 0);
    scene3D.add(rb);
    const panel = (w, h, repeatW, repeatH, rx, ry, x, y, z) => {
      const t = netTex.clone(); t.needsUpdate = true;
      t.repeat.set(repeatW / NET_CELL, repeatH / NET_CELL);
      const pm = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      pm.rotation.set(rx, ry, 0);
      pm.position.set(x, y, z);
      scene3D.add(pm);
    };
    panel(D, GOAL_W, D, GOAL_W, -Math.PI / 2, 0, goalX + sign * D / 2, POST_H, 0);               // top
    panel(GOAL_W, POST_H, GOAL_W, POST_H, 0, Math.PI / 2, rearX, POST_H / 2, 0);                 // back
    panel(D, POST_H, D, POST_H, 0, 0, goalX + sign * D / 2, POST_H / 2, -GOAL_W / 2);            // sides
    panel(D, POST_H, D, POST_H, 0, 0, goalX + sign * D / 2, POST_H / 2, GOAL_W / 2);
  };

  addGoal(-gx);
  addGoal( gx);
}

function _init3DScene() {
  const THREE = _three;
  const wrap  = document.getElementById('pitch-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const L = D.pitch.L, Wp = D.pitch.W;

  scene3D = new THREE.Scene();
  scene3D.background = new THREE.Color(0x111111);

  camera3D = new THREE.PerspectiveCamera(45, W / H, 0.1, 500);
  camera3D.position.set(0, 30, 0);
  camera3D.up.set(0, 0, -1);
  camera3D.lookAt(0, 0, 0);

  renderer3D = new THREE.WebGLRenderer({ antialias: true });
  renderer3D.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer3D.setSize(W, H);
  renderer3D.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2';
  wrap.appendChild(renderer3D.domElement);

  // Lighting: soft ambient + directional key light
  scene3D.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.80);
  dl.position.set(20, 60, -30);
  scene3D.add(dl);

  // Pitch surface — alternating flat stripes (PlaneGeometry rotated -90° about X)
  const tw = L / PITCH_COLS, th = Wp / PITCH_ROWS;
  const stripes3D = [];
  for (let i = 0; i < PITCH_COLS; i++) {
    for (let j = 0; j < PITCH_ROWS; j++) {
      // The outer stripes also cover the run-off beyond the touchlines and goal lines.
      const extL = i === 0 ? GRASS_RUNOFF : 0, extR = i === PITCH_COLS - 1 ? GRASS_RUNOFF : 0;
      const extT = j === 0 ? GRASS_RUNOFF : 0, extB = j === PITCH_ROWS - 1 ? GRASS_RUNOFF : 0;
      const geo = new THREE.PlaneGeometry(tw + extL + extR, th + extT + extB);
      const mat = new THREE.MeshLambertMaterial({ color: PITCH_TILE_HEX[(i + j) % 2] });
      stripes3D.push({ mat, i, j });
      const m   = new THREE.Mesh(geo, mat);
      const cx = -L/2 + (i + 0.5) * tw + (extR - extL) / 2;
      const pitchYc = Wp/2 - (j + 0.5) * th + (extT - extB) / 2;           // pitch y of the plane centre (z = -y)
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, 0, -pitchYc);
      // UVs follow the stripe's own tile grid (u: one tile per stripe width; v: 0..1 over the stripe height),
      // so the texture lines up with the 2D pitch and simply continues into the run-off.
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) {
        uv.setXY(k, (cx + pos.getX(k) - (-L/2 + i * tw)) / tw, (pitchYc + pos.getY(k) - (Wp/2 - (j + 1) * th)) / th);
      }
      scene3D.add(m);
    }
  }
  // Grass texture on the stripes: each stripe shows its own slice of the one texture image
  const imgLoaded = (img) => new Promise((resolve) => {
    if (img.complete) resolve(); else { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }
  });
  const addLogo3D = () => {                                     // flat on the grass, under the lines; lit like the stripes
    const m = logoMetres(L);
    const wPx = 2048, hPx = Math.round(wPx * m.h / m.w);
    const tex = new THREE.CanvasTexture(logoCanvas(wPx, hPx, L, { Wp }));
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h),
      new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mesh.renderOrder = -1;                                       // drawn before the pitch lines, which stay on top
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.01, 0);
    scene3D.add(mesh);
  };
  Promise.all([imgLoaded(LOGO_IMG), imgLoaded(TEX_IMG)]).then(() => {   // build both once the images are known
    if (texReady()) {
      const tex = new THREE.Texture(TEX_IMG);          // one texture shared by all stripes: one tile across each stripe, repeating down the pitch
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      const rows = Wp / texTileM(L);
      tex.repeat.set(1, rows);
      tex.offset.set(0, 1 - rows);                       // a tile edge sits exactly on the top touchline
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      for (const { mat, i, j } of stripes3D) {
        mat.map = tex;
        mat.color.setHex(brightenHex(PITCH_TILE_HEX[(i + j) % 2]));
        mat.needsUpdate = true;
      }
    }
    if (logoReady()) addLogo3D();
  });
  scene3D.add(_build3DPitchLines());
  _addGoals3D();

  // Camera orbit controls
  controls3D = new THREE.OrbitControls(camera3D, renderer3D.domElement);
  controls3D.target.set(0, 0, 0);
  controls3D.enableDamping = true;
  controls3D.dampingFactor = 0.08;
  controls3D.minDistance   = 2;
  controls3D.maxDistance   = 200;
  controls3D.update();

  // One mesh per entity — created once, positions updated every frame
  for (const entity of D.entities) {
    const isBall = entity.g === 4;
    const col    = new THREE.Color(D.colors[entity.g] || '#888888');
    if (isBall) {
      // One mesh per source that carries ball data — visual style mirrors 2D fill/dash rules:
      //   fill:true  → solid MeshPhongMaterial
      //   fill:false → wireframe MeshBasicMaterial (dashed outline in 2D → wireframe in 3D)
      for (const src of D.sources) {
        if (!entity.s[src.id]) continue;  // this source has no data for the ball entity
        let mat;
        const m = new THREE.Mesh(new THREE.SphereGeometry(_BALL_R, 16, 12), null);
        mat = src.fill
          ? new THREE.MeshPhongMaterial({ color: col, shininess: 60 })
          : new THREE.MeshBasicMaterial({ color: col, wireframe: true });
        m.material = mat;
        m.visible = false;
        scene3D.add(m);
        ballMeshes3D[src.id] = m;
      }
    } else {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(_PLAYER_R, _PLAYER_R, _PLAYER_H, 12),
        new THREE.MeshLambertMaterial({ color: col })
      );
      m.visible = false;
      scene3D.add(m);
      playerMeshes3D[entity.g + ':' + entity.j] = m;
    }
  }
}

function _update3DFrame(fi) {
  if (!scene3D) return;

  for (const entity of D.entities) {
    const isBall = entity.g === 4;

    if (isBall) {
      // Apply the same per-source visibility rules as drawEntities() in 2D:
      //   • skip if source is toggled off
      for (const src of D.sources) {
        const m = ballMeshes3D[src.id];
        if (!m) continue;
        if (!visibleSources.has(src.id))               { m.visible = false; continue; }
        const pos = getPos(entity, src.id, fi);
        if (pos) {
          const z = getZ(entity, src.id, fi) || 0;
          m.position.set(pos[0], _BALL_R + z, -pos[1]);
          m.visible = true;
        } else {
          m.visible = false;
        }
      }
    } else {
      // Players — use the first visible source (same as 2D primary)
      const primarySrc = D.sources.find(s => visibleSources.has(s.id));
      const m = playerMeshes3D[entity.g + ':' + entity.j];
      if (!m) continue;
      const pos = primarySrc ? getPos(entity, primarySrc.id, fi) : null;
      if (pos) {
        m.position.set(pos[0], _PLAYER_H / 2, -pos[1]);
        m.visible = true;
      } else {
        m.visible = false;
      }
    }
  }
}

function _sync3DColors() {
  if (!scene3D || !_three) return;
  const THREE = _three;
  const ballCol = new THREE.Color(D.colors['4'] || '#f5c518');
  for (const m of Object.values(ballMeshes3D)) {
    m.material.color.set(ballCol);
    if (m.userData.fillMat) m.userData.fillMat.color.set(ballCol);
    if (m.userData.wireMat) m.userData.wireMat.color.set(ballCol);
  }
  for (const entity of D.entities) {
    if (entity.g === 4) continue;
    const col = new THREE.Color(D.colors[entity.g] || '#888888');
    const m = playerMeshes3D[entity.g + ':' + entity.j];
    if (m) m.material.color.set(col);
  }
}

function _start3DLoop() {
  if (raf3D) return;
  (function loop() {
    raf3D = requestAnimationFrame(loop);
    controls3D.update();
    _update3DFrame(currentFi);
    renderer3D.render(scene3D, camera3D);
  })();
}

function _stop3DLoop() {
  if (raf3D) { cancelAnimationFrame(raf3D); raf3D = null; }
}

// Pan the camera and orbit target together along the ground plane so the
// orbit centre follows — arrow keys call this to shift the view left/right/fwd/back.
function _pan3D(rightSteps, fwdSteps) {
  if (!camera3D || !controls3D || !_three) return;
  const THREE = _three;
  const STEP  = 3.0;  // metres per key press

  // Project the camera look-direction onto the ground plane (XZ) so vertical
  // tilt doesn't cause the view to drift up or down when panning.
  const fwd = new THREE.Vector3();
  camera3D.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);  // near-vertical fallback
  fwd.normalize();

  // Right vector is perpendicular to fwd in the ground plane
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

  const delta = new THREE.Vector3()
    .addScaledVector(right, rightSteps * STEP)
    .addScaledVector(fwd,   fwdSteps   * STEP);

  camera3D.position.add(delta);
  controls3D.target.add(delta);
  controls3D.update();
}

function enter3D() {
  canvas.style.display = 'none';
  if (!renderer3D) {
    _loadThree(() => { _init3DScene(); _start3DLoop(); });
  } else {
    renderer3D.domElement.style.display = '';
    _start3DLoop();
  }
}

function exit3D() {
  _stop3DLoop();
  if (renderer3D) renderer3D.domElement.style.display = 'none';
  canvas.style.display = '';
  render(currentFi);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main render
// ─────────────────────────────────────────────────────────────────────────────

function render(fi) {
  // State updates always run (VOD sync, panel content, meta, slider position)
  syncVideo(fi);
  updatePhaseOverlay(fi);
  updateRunsPanel(fi);
  updatePressurePanel(fi);
  updateDCPanel(fi);
  updateMeta(fi);
  slider.value = fi;
  currentFi    = fi;

  // 3D RAF loop handles visual update; skip 2D canvas drawing
  if (is3D) return;

  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  setupTransform(W, H);
  drawPitch(W, H);
  if (showEvents) drawEvent(fi);
  drawDefCompactness(fi);
  drawPhaseOverlay(fi);
  drawOverloadOverlay(fi);
  if (showTails || showRunHighlights) drawTails(fi);
  drawRunHighlights(fi);
  drawEntities(fi, 'players');
  drawRunInfo(fi);
  drawPressureInfo(fi);
  drawPressures(fi);
  drawPossessionHighlight(fi);
  drawEntities(fi, 'ball');   // ball above the possession highlight
  drawScoreboard(fi);
  if (hoveredEntity) renderTooltip(hoveredEntity, _lastMouseX, _lastMouseY);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Playback
// ─────────────────────────────────────────────────────────────────────────────
const BASE_FPS     = 25;
const TOTAL_FRAMES = D.frameIds.length;

function scheduleNext() {
  const ms = Math.round(1000 / (BASE_FPS * speed));
  timerId = setTimeout(() => {
    if (!isPlaying) return;
    const next = currentFi + 1;
    if (next >= TOTAL_FRAMES) { stopPlayback(); return; }
    render(next);
    scheduleNext();
  }, ms);
}

function startPlayback() {
  isPlaying = true;
  btnPlay.innerHTML = '&#9646;&#9646;';
  btnPlay.className = 'btn btn-primary';
  if (hasVod && vodActivePeriod && vodPlayers[vodActivePeriod]) {
    const pl = vodPlayers[vodActivePeriod].el;
    pl.playbackRate = speed;
    pl.play().catch(() => {});
  }
  scheduleNext();
}

// Syncs GIF/Video export time inputs to the current frame position.
// Called on pause; user edits set _gifTimeUserEdited to suppress auto-sync.
let _gifTimeUserEdited = false;
function _syncGifTimes() {
  if (_gifTimeUserEdited) return;
  const period = D.meta.period[currentFi] || 1;
  const t      = D.meta.time[currentFi]   || 0;
  const matchMin = Math.floor(t / 60) + (period - 1) * 45;
  const sec      = Math.floor(t % 60);
  const endT     = t + 5;
  const endMatchMin = Math.floor(endT / 60) + (period - 1) * 45;
  const endSec      = Math.floor(endT % 60);
  const _s = id => document.getElementById(id);
  if (_s('gif-period'))    _s('gif-period').value    = period;
  if (_s('gif-start-min')) _s('gif-start-min').value = matchMin;
  if (_s('gif-start-sec')) _s('gif-start-sec').value = sec;
  if (_s('gif-end-min'))   _s('gif-end-min').value   = endMatchMin;
  if (_s('gif-end-sec'))   _s('gif-end-sec').value   = Math.min(59, endSec);
}

function stopPlayback() {
  isPlaying = false;
  if (timerId) { clearTimeout(timerId); timerId = null; }
  btnPlay.innerHTML = '&#9654;';
  btnPlay.className = 'btn btn-secondary';
  if (hasVod) Object.values(vodPlayers).forEach(pl => pl.el.pause());
  _syncGifTimes();
}

function togglePlay() {
  if (isPlaying) stopPlayback(); else startPlayback();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Source toggle buttons
// ─────────────────────────────────────────────────────────────────────────────

function buildSourceToggles() {
  const container = document.getElementById('source-toggles');
  for (const src of D.sources) {
    const btn = document.createElement('div');
    btn.className = 'src-btn active';
    btn.style.borderColor = '#FAA51A44';
    btn.style.background  = 'rgba(250,165,26,0.10)';
    btn.dataset.srcId     = src.id;

    const dot = document.createElement('div');
    dot.className = 'src-dot';
    dot.style.background = src.fill ? '#FAA51A' : 'transparent';
    dot.style.border     = src.fill ? 'none' : '2px solid #FAA51A';
    if (src.dash) dot.style.background = 'repeating-linear-gradient(90deg,#FAA51A 0 4px,transparent 4px 7px)';

    const lbl = document.createElement('span');
    lbl.textContent = src.label;

    btn.appendChild(dot);
    btn.appendChild(lbl);
    container.appendChild(btn);

    btn.addEventListener('click', () => {
      if (visibleSources.has(src.id)) {
        visibleSources.delete(src.id);
        btn.className = 'src-btn inactive';
      } else {
        visibleSources.add(src.id);
        btn.className = 'src-btn active';
      }
      render(currentFi);
    });
  }

  // Events toggle — only shown when there is event data
  if (D.events.length > 0) {
    const btn = document.createElement('div');
    btn.className = 'src-btn active';
    btn.style.borderColor = '#ffffff44';
    btn.style.background  = 'rgba(255,255,255,0.08)';

    const dot = document.createElement('span');
    dot.textContent = '✕';
    dot.style.cssText = 'font-size:11px;color:#fff;line-height:1';

    const lbl = document.createElement('span');
    lbl.textContent = 'Events';

    btn.appendChild(dot);
    btn.appendChild(lbl);
    container.appendChild(btn);

    btn.addEventListener('click', () => {
      showEvents = !showEvents;
      btn.className = showEvents ? 'src-btn active' : 'src-btn inactive';
      render(currentFi);
    });
  }
}

function buildAppearanceControls() {
  const container = document.getElementById('appearance-controls');
  // Store source-specific style state (will be applied during render)
  window._sourceStyles = {};

  for (const src of D.sources) {
    window._sourceStyles[src.id] = {
      fill: src.fill,
      dash: src.dash,
      alpha: src.alpha,
      suffix: src.suffix
    };

    const group = document.createElement('div');
    group.style.cssText = 'display:flex;gap:4px;align-items:center;padding:4px 6px;background:rgba(255,255,255,0.02);border-radius:3px;border:1px solid rgba(255,255,255,0.08)';

    const label = document.createElement('span');
    label.textContent = src.label;
    label.style.cssText = 'font-size:11px;color:#aaa;font-weight:600;min-width:60px;white-space:nowrap';
    group.appendChild(label);

    // Filled checkbox
    const fillLabel = document.createElement('label');
    fillLabel.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:#ccc';
    const fillCb = document.createElement('input');
    fillCb.type = 'checkbox';
    fillCb.checked = src.fill;
    fillCb.style.cursor = 'pointer';
    fillCb.addEventListener('change', () => {
      window._sourceStyles[src.id].fill = fillCb.checked;
      render(currentFi);
    });
    fillLabel.appendChild(fillCb);
    fillLabel.appendChild(document.createTextNode('Fill'));
    group.appendChild(fillLabel);

    // Dashed checkbox
    const dashLabel = document.createElement('label');
    dashLabel.style.cssText = 'display:flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:#ccc';
    const dashCb = document.createElement('input');
    dashCb.type = 'checkbox';
    dashCb.checked = src.dash;
    dashCb.style.cursor = 'pointer';
    dashCb.addEventListener('change', () => {
      window._sourceStyles[src.id].dash = dashCb.checked;
      render(currentFi);
    });
    dashLabel.appendChild(dashCb);
    dashLabel.appendChild(document.createTextNode('Dash'));
    group.appendChild(dashLabel);

    // Opacity slider
    const opacityLabel = document.createElement('label');
    opacityLabel.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:#ccc';
    opacityLabel.appendChild(document.createTextNode('α'));
    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0.1';
    opacitySlider.max = '1.0';
    opacitySlider.step = '0.05';
    opacitySlider.value = src.alpha;
    opacitySlider.style.cssText = 'width:40px;accent-color:#FAA51A;cursor:pointer';
    opacitySlider.addEventListener('change', () => {
      window._sourceStyles[src.id].alpha = parseFloat(opacitySlider.value);
      render(currentFi);
    });
    opacityLabel.appendChild(opacitySlider);
    group.appendChild(opacityLabel);

    // Suffix input
    const suffixLabel = document.createElement('label');
    suffixLabel.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:#ccc';
    suffixLabel.appendChild(document.createTextNode('Suffix'));
    const suffixInput = document.createElement('input');
    suffixInput.type = 'text';
    suffixInput.value = src.suffix;
    suffixInput.maxLength = '3';
    suffixInput.style.cssText = 'width:30px;padding:2px 4px;font-size:10px;background:#1a1a1a;border:1px solid #333;color:#ccc;border-radius:2px';
    suffixInput.addEventListener('change', () => {
      window._sourceStyles[src.id].suffix = suffixInput.value;
      render(currentFi);
    });
    suffixLabel.appendChild(suffixInput);
    group.appendChild(suffixLabel);

    container.appendChild(group);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Wiring
// ─────────────────────────────────────────────────────────────────────────────

slider.max   = TOTAL_FRAMES - 1;
slider.value = 0;
slider.addEventListener('input', () => { stopPlayback(); render(parseInt(slider.value, 10)); });

btnPlay.addEventListener('click', togglePlay);

document.getElementById('btn-reset').addEventListener('click', () => { stopPlayback(); render(0); });

document.getElementById('speed-select').addEventListener('change', (e) => {
  speed = parseFloat(e.target.value);
  if (hasVod && vodActivePeriod && vodPlayers[vodActivePeriod]) {
    vodPlayers[vodActivePeriod].el.playbackRate = speed;
  }
});

// Time input handlers
inpPeriod.addEventListener('change', onTimeInputChange);
inpMin.addEventListener('change', onTimeInputChange);
// Seconds roll over: stepping below 0 goes to :59 of the previous minute, above 59 to :00 of the next.
inpSec.addEventListener('change', () => {
  let minute = parseInt(inpMin.value, 10) || 0;
  let second = parseInt(inpSec.value, 10) || 0;
  minute += Math.floor(second / 60);
  second = ((second % 60) + 60) % 60;
  if (minute < 0) { minute = 0; second = 0; }
  inpMin.value = minute;
  inpSec.value = second;
  onTimeInputChange();
});

// Canvas resize
function resizeCanvas() {
  const wrap = document.getElementById('pitch-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  canvas.width  = W;
  canvas.height = H;
  if (is3D && renderer3D) {
    renderer3D.setSize(W, H);
    camera3D.aspect = W / H;
    camera3D.updateProjectionMatrix();
  }
  render(currentFi);
}

const ro = new ResizeObserver(resizeCanvas);
ro.observe(document.getElementById('pitch-wrap'));

buildSourceToggles();
buildAppearanceControls();

// Setup Overlays collapsible section
const overlaysToggle = document.getElementById('overlays-toggle');
const overlaysLabel = overlaysToggle.nextElementSibling;
const overlaysContent = document.getElementById('overlays-content');

function updateOverlaysDisplay() {
  if (overlaysToggle.checked) {
    overlaysContent.style.display = 'block';
    overlaysLabel.querySelector('span').textContent = '▼ Overlays';
  } else {
    overlaysContent.style.display = 'none';
    overlaysLabel.querySelector('span').textContent = '▶ Overlays';
  }
}

overlaysToggle.addEventListener('change', updateOverlaysDisplay);
updateOverlaysDisplay(); // Initialize

_setRightCol();

document.getElementById('btn-3d').addEventListener('click', () => {
  is3D = !is3D;
  const btn = document.getElementById('btn-3d');
  btn.classList.toggle('btn-primary',   is3D);
  btn.classList.toggle('btn-secondary', !is3D);
  if (is3D) enter3D(); else exit3D();
});

// Arrow-key panning in 3D mode (left/right and forward/back along the ground plane)
document.addEventListener('keydown', (e) => {
  if (!is3D) return;
  if (e.key === 'ArrowLeft')  { _pan3D(-1,  0); e.preventDefault(); }
  if (e.key === 'ArrowRight') { _pan3D( 1,  0); e.preventDefault(); }
  if (e.key === 'ArrowUp')    { _pan3D( 0,  1); e.preventDefault(); }
  if (e.key === 'ArrowDown')  { _pan3D( 0, -1); e.preventDefault(); }
});

// ── Team colour pickers ───────────────────────────────────────────────────────
const colorPick1 = document.getElementById('color-team1');
const colorPick2 = document.getElementById('color-team2');
const colorPickB = document.getElementById('color-ball');

// Initialise from payload colours
colorPick1.value = D.colors['1'] || '#4682b4';
colorPick2.value = D.colors['2'] || '#cd5c5c';
colorPickB.value = D.colors['4'] || '#f5c518';

// Second colour per team: a checkbox switches it on, a second picker sets it. D.colors2 holds only the active ones.
D.colors2 = D.colors2 || {};
for (const g of [1, 2]) {
  const box = document.getElementById('two-team' + g), pick = document.getElementById('color-team' + g + 'b');
  let remembered = D.colors2[g] || '#ffffff';                    // survives switching the option off and on
  pick.value = remembered;
  box.checked = !!D.colors2[g];
  pick.hidden = !box.checked;
  box.addEventListener('change', () => {
    pick.hidden = !box.checked;
    if (box.checked) D.colors2[g] = remembered; else delete D.colors2[g];
    render(currentFi);
  });
  pick.addEventListener('input', () => { remembered = pick.value; D.colors2[g] = pick.value; render(currentFi); });
}

// ── Match title bar ───────────────────────────────────────────────────────────
(function () {
  const L        = D.lineup || {};
  const homeName = L['teamname_1'] || '';
  const awayName = L['teamname_2'] || '';
  const titleEl  = document.getElementById('match-title');
  if (!titleEl) return;
  if (!homeName && !awayName) { titleEl.style.display = 'none'; return; }

  const comp = L['match_comp'] || '';
  const venue = L['match_venue'] || '';
  const date = L['match_date'] || '';

  // Plain text, one style throughout: the live score and team colours are on the scoreboard
  let html = '<span class="match-neutral">' + homeName + '&nbsp;&nbsp;vs&nbsp;&nbsp;' + awayName + '</span>';
  if (comp) html += '<span class="match-sep"> | </span><span class="match-neutral">' + comp + '</span>';
  if (venue) html += '<span class="match-sep"> | </span><span class="match-neutral">' + venue + '</span>';
  if (date) html += '<span class="match-sep"> | </span><span class="match-neutral">' + date + '</span>';

  titleEl.innerHTML = html;
})();

colorPick1.addEventListener('input', () => { D.colors['1'] = colorPick1.value; _sync3DColors(); render(currentFi); });
colorPick2.addEventListener('input', () => { D.colors['2'] = colorPick2.value; _sync3DColors(); render(currentFi); });
colorPickB.addEventListener('input', () => { D.colors['4'] = colorPickB.value; _sync3DColors(); render(currentFi); });

// ── Tails toggle ─────────────────────────────────────────────────────────────
const btnTails    = document.getElementById('btn-tails');
const tailLenWrap = document.getElementById('tail-length-wrap');
const tailLenInp  = document.getElementById('tail-length');

btnTails.addEventListener('click', () => {
  showTails = !showTails;
  tailLenWrap.style.display = showTails ? 'flex' : 'none';
  btnTails.classList.toggle('btn-primary',   showTails);
  btnTails.classList.toggle('btn-secondary', !showTails);
  render(currentFi);
});

tailLenInp.addEventListener('change', () => {
  tailLength = Math.max(1, Math.min(500, parseInt(tailLenInp.value, 10) || 50));
  tailLenInp.value = tailLength;
  render(currentFi);
});

// ── Overlay text size control ────────────────────────────────────────────────
const overlayTextSizeSlider = document.getElementById('overlay-text-size-slider');
const overlayTextSizeVal = document.getElementById('overlay-text-size-val');

overlayTextSizeSlider.addEventListener('input', () => {
  overlayTextSize = parseFloat(overlayTextSizeSlider.value);
  overlayTextSizeVal.textContent = overlayTextSize.toFixed(1) + 'x';
  render(currentFi);
});

// ── In-view toggle (3-state cycle) ───────────────────────────────────────────
const btnInview = document.getElementById('btn-inview');

const _inViewLabels = [
  '&#128065; In-view only',
  '&#128065; In-view only',
  '&#128065; Dim out-of-view',
];

function _applyInViewStyle() {
  if (inViewMode === 0) {
    btnInview.className = 'btn btn-secondary';
    btnInview.style.borderColor = '';
  } else if (inViewMode === 1) {
    btnInview.className = 'btn btn-primary';
    btnInview.style.borderColor = '';
  } else {
    // Mode 2: amber border to distinguish from mode 1
    btnInview.className = 'btn btn-secondary';
    btnInview.style.borderColor = '#FAA51A';
    btnInview.style.color = '#FAA51A';
  }
  btnInview.innerHTML = _inViewLabels[inViewMode];
}

const hasBvData = D.entities.some(e => e._bvSet !== null);
if (!hasBvData) {
  btnInview.style.display = 'none';
} else {
  btnInview.addEventListener('click', () => {
    inViewMode    = (inViewMode + 1) % 3;
    _applyInViewStyle();
    render(currentFi);
  });
}

// ── Events panel ─────────────────────────────────────────────────────────────
// ── Mutual-exclusion helper for the two bottom panels ────────────────────────
function _closeAllBottomPanels() {
  // Only hide body + filters — never the wrap, which contains the toggle button
  [
    { name: 'phases', body: 'phases-body',     filters: 'phases-filters' },
    { name: 'events', body: 'events-body',     filters: 'events-filters' },
    { name: 'runs',   body: 'runs-body-table', filters: 'runs-filters-row' },
  ].forEach(({name, body, filters}) => {
    const b = document.getElementById(body);
    const f = document.getElementById(filters);
    if (b) b.style.display = 'none';
    if (f) f.style.display = 'none';
    const btn = document.getElementById('btn-' + name + '-toggle');
    if (btn) btn.className = 'btn btn-secondary';
  });
}

// ── Runs table panel ─────────────────────────────────────────────────────────
(function () {
  if (!D.runs || Object.keys(D.runs).length === 0) return;

  const wrap       = document.getElementById('runs-wrap');
  const body       = document.getElementById('runs-body-table');
  const filters    = document.getElementById('runs-filters-row');
  const btnToggle  = document.getElementById('btn-runs-toggle');
  const countBadge = document.getElementById('runs-table-count');
  const tbody      = document.getElementById('runs-tbody');
  let activeRow    = null;

  const allRuns = [];
  for (const [period, rs] of Object.entries(D.runs)) {
    for (const r of rs) allRuns.push({ period: parseInt(period), ...r });
  }
  allRuns.sort((a, b) => a.period !== b.period ? a.period - b.period : a.s - b.s);

  wrap.style.display = 'block';
  countBadge.textContent = '(' + allRuns.length + ')';

  const periods  = [...new Set(allRuns.map(r => r.period))].sort((a,b) => a-b);
  const labels   = [...new Set(allRuns.map(r => r.label).filter(Boolean))].sort();
  const types    = [...new Set(allRuns.map(r => r.type).filter(Boolean))].sort();
  const teams    = [...new Set(allRuns.filter(r => r.g).map(r => r.g))].sort((a,b) => a-b);
  const players  = [...new Set(allRuns.map(r => r.player).filter(Boolean))].sort();

  const ruFltPeriod = document.getElementById('ru-flt-period');
  const ruFltLabel  = document.getElementById('ru-flt-label');
  const ruFltType   = document.getElementById('ru-flt-type');
  const ruFltTeam   = document.getElementById('ru-flt-team');
  const ruFltPlayer = document.getElementById('ru-flt-player');
  const ruFltDlb    = document.getElementById('ru-flt-dlb');
  const ruFltMlb    = document.getElementById('ru-flt-mlb');

  periods.forEach(p  => { const o = document.createElement('option'); o.value = p; o.textContent = 'Period ' + p; ruFltPeriod.appendChild(o); });
  labels.forEach(l   => { const o = document.createElement('option'); o.value = l; o.textContent = formatRunLabel(l); ruFltLabel.appendChild(o); });
  types.forEach(t    => { const o = document.createElement('option'); o.value = t; o.textContent = formatRunType(t);  ruFltType.appendChild(o); });
  teams.forEach(g    => {
    const o = document.createElement('option'); o.value = g;
    o.textContent = g === 1 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                             : (D.lineup && D.lineup['teamname_2'] || 'Away');
    ruFltTeam.appendChild(o);
  });
  players.forEach(n  => { const o = document.createElement('option'); o.value = n; o.textContent = n; ruFltPlayer.appendChild(o); });

  [ruFltPeriod, ruFltLabel, ruFltType, ruFltTeam, ruFltPlayer, ruFltDlb, ruFltMlb].forEach(s => s.addEventListener('change', renderTable));

  function _lineBrokenStr(v) { return v === 1 ? 'Yes' : 'No'; }  // absent = No

  function renderTable() {
    const fp  = ruFltPeriod.value;
    const fl  = ruFltLabel.value;
    const ft  = ruFltType.value;
    const fg  = ruFltTeam.value;
    const fpl = ruFltPlayer.value;
    const fdl = ruFltDlb.value;
    const fml = ruFltMlb.value;

    const filtered = allRuns.filter(r => {
      if (fp  && r.period !== parseInt(fp, 10)) return false;
      if (fl  && r.label  !== fl)              return false;
      if (ft  && r.type   !== ft)              return false;
      if (fg  && r.g      !== parseInt(fg, 10)) return false;
      if (fpl && r.player !== fpl)             return false;
      if (fdl !== '' && (fdl === '1' ? r.dlb !== 1 : r.dlb === 1)) return false;
      if (fml !== '' && (fml === '1' ? r.mlb !== 1 : r.mlb === 1)) return false;
      return true;
    });

    tbody.innerHTML = '';
    activeRow = null;

    filtered.forEach(r => {
      const matchMin = String(Math.floor(r.s / 60) + (r.period - 1) * 45).padStart(2, '0');
      const matchSec = String(Math.floor(r.s % 60)).padStart(2, '0');
      const teamStr  = r.g === 1 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                     : r.g === 2 ? (D.lineup && D.lineup['teamname_2'] || 'Away') : '—';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + (r.runId !== undefined ? r.runId : '—') + '</td>' +
        '<td>P' + r.period + '</td>' +
        '<td>' + matchMin + ':' + matchSec + '</td>' +
        '<td>' + formatRunLabel(r.label) + '</td>' +
        '<td>' + formatRunType(r.type)   + '</td>' +
        '<td>' + teamStr + '</td>' +
        '<td>' + (r.player || '—') + '</td>' +
        '<td>' + (r.j || '—') + '</td>' +
        '<td>' + _lineBrokenStr(r.dlb)  + '</td>' +
        '<td>' + _lineBrokenStr(r.mlb)  + '</td>';
      tr.addEventListener('click', () => {
        stopPlayback();
        const fi = findFrameByTime(r.period, parseInt(matchMin, 10), parseInt(matchSec, 10));
        render(fi);
        if (activeRow) activeRow.classList.remove('run-active');
        tr.classList.add('run-active');
        activeRow = tr;
      });
      tbody.appendChild(tr);
    });
  }

  btnToggle.addEventListener('click', () => {
    const isOpen = body.style.display === 'block';
    if (!isOpen) {
      _closeAllBottomPanels();
      body.style.display    = 'block';
      filters.style.display = 'flex';
      btnToggle.className   = 'btn btn-primary';
      btnToggle.innerHTML   = '&#9660; Runs (' + allRuns.length + ')';
      if (tbody.children.length === 0) renderTable();
    } else {
      body.style.display    = 'none';
      filters.style.display = 'none';
      btnToggle.className   = 'btn btn-secondary';
      btnToggle.innerHTML   = '&#9654; Runs (' + allRuns.length + ')';
    }
  });
})();

// ── Phases panel ─────────────────────────────────────────────────────────────
(function () {
  if (!D.phases || Object.keys(D.phases).length === 0) return;

  const wrap       = document.getElementById('phases-wrap');
  const body       = document.getElementById('phases-body');
  const filters    = document.getElementById('phases-filters');
  const btnToggle  = document.getElementById('btn-phases-toggle');
  const countBadge = document.getElementById('phases-count');
  const tbody      = document.getElementById('phases-tbody');
  let panelOpen    = false;
  let activeRow    = null;

  // Flatten period-keyed phases into a single sorted list
  const allPhases = [];
  for (const [period, phases] of Object.entries(D.phases)) {
    for (const ph of phases) {
      allPhases.push({ period: parseInt(period), ...ph });
    }
  }
  allPhases.sort((a, b) => a.period !== b.period ? a.period - b.period : a.s - b.s);

  wrap.style.display = 'block';
  countBadge.textContent = '(' + allPhases.length + ')';

  // Populate filter dropdowns
  const periods   = [...new Set(allPhases.map(p => p.period))].sort((a,b) => a-b);
  const types     = [...new Set(allPhases.map(p => p.l))].sort();
  const teams     = [...new Set(allPhases.filter(p => p.possG).map(p => p.possG))].sort((a,b) => a-b);

  const phFltPeriod = document.getElementById('ph-flt-period');
  const phFltType   = document.getElementById('ph-flt-type');
  const phFltTeam   = document.getElementById('ph-flt-team');
  const phFltInit   = document.getElementById('ph-flt-init');
  const phFltGoal     = document.getElementById('ph-flt-goal');
  const phFltShots    = document.getElementById('ph-flt-shots');
  const phFltOverload = document.getElementById('ph-flt-overload');

  periods.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = 'Period ' + p; phFltPeriod.appendChild(o); });
  types.forEach(t   => { const o = document.createElement('option'); o.value = t; o.textContent = t; phFltType.appendChild(o); });
  teams.forEach(g   => {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = g === 1 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                             : (D.lineup && D.lineup['teamname_2'] || 'Away');
    phFltTeam.appendChild(o);
  });
  // Initiating Player dropdown — unique non-empty names, sorted
  const initPlayers = [...new Set(allPhases.map(p => p.init).filter(Boolean))].sort();
  initPlayers.forEach(name => {
    const o = document.createElement('option'); o.value = name; o.textContent = name; phFltInit.appendChild(o);
  });

  [phFltPeriod, phFltType, phFltTeam, phFltInit, phFltGoal, phFltShots, phFltOverload].forEach(s => s.addEventListener('change', renderTable));

  function renderTable() {
    const fp  = phFltPeriod.value;
    const ft  = phFltType.value;
    const fg  = phFltTeam.value;
    const fi  = phFltInit.value;
    const fgl = phFltGoal.value;
    const fsh = phFltShots.value;
    const fol = phFltOverload.value;

    const filtered = allPhases.filter(ph => {
      if (fp  && ph.period !== parseInt(fp, 10)) return false;
      if (ft  && ph.l !== ft) return false;
      if (fg  && ph.possG !== parseInt(fg, 10)) return false;
      if (fi  && ph.init !== fi) return false;
      if (fgl && ph.goal  !== fgl) return false;
      if (fsh && ph.shots !== fsh) return false;
      if (fol) {
        const hasOverload = ph.ol && ph.ol.length > 0;
        if (fol === '1' && !hasOverload) return false;
        if (fol === '0' &&  hasOverload) return false;
      }
      return true;
    });

    tbody.innerHTML = '';
    activeRow = null;

    filtered.forEach(ph => {
      const matchMin = String(Math.floor(ph.s / 60) + (ph.period - 1) * 45).padStart(2, '0');
      const matchSec = String(Math.floor(ph.s % 60)).padStart(2, '0');
      const teamStr  = ph.possG === 1 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                     : ph.possG === 2 ? (D.lineup && D.lineup['teamname_2'] || 'Away') : '—';
      const initStr  = ph.init  || '—';
      const goalStr  = ph.goal  === 'True' ? 'Yes' : ph.goal  === 'False' ? 'No' : '—';
      const shotsStr = ph.shots === 'True' ? 'Yes' : ph.shots === 'False' ? 'No' : '—';

      const tr = document.createElement('tr');
      const jerseyStr  = ph.initJ !== null && ph.initJ !== undefined ? ph.initJ : '—';
      const overloadStr = ph.ol && ph.ol.length > 0 ? 'Yes' : 'No';
      tr.innerHTML = '<td>' + (ph.phId !== undefined ? ph.phId : '—') + '</td><td>P' + ph.period + '</td><td>' + matchMin + ':' + matchSec + '</td><td>' + ph.l + '</td><td>' + teamStr + '</td><td>' + initStr + '</td><td>' + jerseyStr + '</td><td>' + goalStr + '</td><td>' + shotsStr + '</td><td>' + overloadStr + '</td>';
      tr.addEventListener('click', () => {
        stopPlayback();
        const frameIdx = findFrameByTime(ph.period, parseInt(matchMin, 10), parseInt(matchSec, 10));
        render(frameIdx);
        if (activeRow) activeRow.classList.remove('ph-active');
        tr.classList.add('ph-active');
        activeRow = tr;
      });
      tbody.appendChild(tr);
    });
  }

  btnToggle.addEventListener('click', () => {
    const isOpen = body.style.display === 'block';
    if (!isOpen) {
      _closeAllBottomPanels();
      body.style.display    = 'block';
      filters.style.display = 'flex';
      btnToggle.className   = 'btn btn-primary';
      btnToggle.innerHTML   = '&#9660; Phases (' + allPhases.length + ')';
      if (tbody.children.length === 0) renderTable();
    } else {
      body.style.display    = 'none';
      filters.style.display = 'none';
      btnToggle.className   = 'btn btn-secondary';
      btnToggle.innerHTML   = '&#9654; Phases (' + allPhases.length + ')';
    }
  });
})();

// ── Events panel ─────────────────────────────────────────────────────────────
(function () {
  if (!D.events || D.events.length === 0) return;

  const wrap       = document.getElementById('events-wrap');
  const body       = document.getElementById('events-body');
  const filters    = document.getElementById('events-filters');
  const btnToggle  = document.getElementById('btn-events-toggle');
  const countBadge = document.getElementById('events-count');
  const tbody      = document.getElementById('events-tbody');
  let panelOpen    = false;
  let activeRow    = null;

  wrap.style.display = 'block';
  countBadge.textContent = '(' + D.events.length + ')';

  // Populate filter dropdowns
  const periods = [...new Set(D.events.map(e => e.p))].sort((a,b) => a-b);
  const types   = [...new Set(D.events.map(e => e.t))].sort();
  const teams   = [...new Set(D.events.filter(e => e.ti !== null).map(e => e.ti))].sort((a,b) => a-b);
  const players = [...new Set(
    D.events.filter(e => e.jn !== null).map(e => e.g + ':' + e.jn)
  )].sort((a,b) => {
    const [ag, aj] = a.split(':').map(Number);
    const [bg, bj] = b.split(':').map(Number);
    return ag !== bg ? ag - bg : aj - bj;
  });
  const qualifiersMap = {}; // id -> name
  D.events.forEach(e => {
    if (e.quals && Array.isArray(e.quals)) {
      e.quals.forEach(q => {
        if (q.id && q.name) qualifiersMap[q.id] = q.name;
      });
    }
  });
  const qualifiers = Object.entries(qualifiersMap)
    .map(([id, name]) => ({ id: parseInt(id), name: name }))
    .sort((a,b) => a.id - b.id);

  const fltPeriod = document.getElementById('flt-period');
  const fltType   = document.getElementById('flt-type');
  const fltTeam   = document.getElementById('flt-team');
  const fltPlayer = document.getElementById('flt-player');
  const fltQualifier = document.getElementById('flt-qualifier');

  periods.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = 'Period ' + p; fltPeriod.appendChild(o); });
  types.forEach(t   => { const o = document.createElement('option'); o.value = t; o.textContent = t; fltType.appendChild(o); });
  teams.forEach(ti  => {
    const o = document.createElement('option');
    o.value = ti;
    o.textContent = ti === 0 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                              : (D.lineup && D.lineup['teamname_2'] || 'Away');
    fltTeam.appendChild(o);
  });
  players.forEach(pk => {
    const parts = pk.split(':');
    const o = document.createElement('option');
    const team = parts[0] === '1' ? (D.lineup && D.lineup['teamname_1'] || 'Home')
               : parts[0] === '2' ? (D.lineup && D.lineup['teamname_2'] || 'Away') : 'T' + parts[0];
    const name = D.lineup && D.lineup[pk];   // same lookup the table's Player column uses
    o.value = pk; o.textContent = team + ' #' + parts[1] + (name ? ' ' + name : ''); fltPlayer.appendChild(o);
  });
  qualifiers.forEach(q => {
    const o = document.createElement('option');
    o.value = q.id; o.textContent = q.name + ' (' + q.id + ')'; fltQualifier.appendChild(o);
  });

  [fltPeriod, fltType, fltTeam, fltPlayer, fltQualifier].forEach(s => s.addEventListener('change', renderTable));

  function renderTable() {
    const fp  = fltPeriod.value;
    const ft  = fltType.value;
    const fg  = fltTeam.value;
    const fpl = fltPlayer.value;
    const fq  = fltQualifier.value;

    const filtered = D.events.filter(e => {
      if (fp  && e.p !== parseInt(fp,  10)) return false;
      if (ft  && e.t !== ft)                return false;
      if (fg  && e.ti !== parseInt(fg,  10)) return false;
      if (fpl) {
        const parts = fpl.split(':').map(Number);
        if (e.g !== parts[0] || e.jn !== parts[1]) return false;
      }
      if (fq) {
        const fqId = parseInt(fq, 10);
        if (!e.quals || !e.quals.some(q => q.id === fqId)) return false;
      }
      return true;
    });

    tbody.innerHTML = '';
    activeRow = null;

    filtered.forEach(ev => {
      const pStart  = D.periodStartTimes[String(ev.p)] || 0;
      const relSec  = Math.max(0, D.meta.time[ev.fi] - pStart);
      const mm      = String(Math.floor(relSec / 60)).padStart(2, '0');
      const ss      = String(Math.floor(relSec % 60)).padStart(2, '0');
      const teamStr   = ev.ti === 0 ? (D.lineup && D.lineup['teamname_1'] || 'Home')
                      : ev.ti === 1 ? (D.lineup && D.lineup['teamname_2'] || 'Away') : '—';
      const playerStr = ev.jn !== null && ev.jn !== undefined
        ? (D.lineup && D.lineup[ev.g + ':' + ev.jn] || '#' + ev.jn)
        : '—';
      const qualifiersStr = (ev.quals && ev.quals.length > 0) ? ev.quals.map(q => q.name).join(', ') : '—';

      const tr = document.createElement('tr');
      const eventIdStr = ev.eid !== null && ev.eid !== undefined ? ev.eid : '—';
      const evJerseyStr = ev.jn !== null && ev.jn !== undefined ? ev.jn : '—';
      tr.innerHTML = '<td>P' + ev.p + '</td><td>' + mm + ':' + ss + '</td><td>' + ev.t + '</td><td>' + teamStr + '</td><td>' + playerStr + '</td><td>' + evJerseyStr + '</td><td>' + qualifiersStr + '</td><td>' + eventIdStr + '</td>';
      tr.addEventListener('click', () => {
        stopPlayback();
        render(ev.fi);
        if (activeRow) activeRow.classList.remove('ev-active');
        tr.classList.add('ev-active');
        activeRow = tr;
      });
      tbody.appendChild(tr);
    });
  }

  btnToggle.addEventListener('click', () => {
    const isOpen = body.style.display === 'block';
    if (!isOpen) {
      _closeAllBottomPanels();
      body.style.display    = 'block';
      filters.style.display = 'flex';
      btnToggle.className   = 'btn btn-primary';
      btnToggle.innerHTML   = '&#9660; Events (' + D.events.length + ')';
      if (tbody.children.length === 0) renderTable();
    } else {
      body.style.display    = 'none';
      filters.style.display = 'none';
      btnToggle.className   = 'btn btn-secondary';
      btnToggle.innerHTML   = '&#9654; Events (' + D.events.length + ')';
    }
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
//  GIF + Video Export
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const statusEl  = document.getElementById('gif-status');
  const barWrap   = document.getElementById('gif-progress-bar-wrap');
  const bar       = document.getElementById('gif-progress-bar');
  const btnGen    = document.getElementById('btn-gen-gif');
  const btnVid    = document.getElementById('btn-gen-vid');
  const btnSync   = document.getElementById('btn-gif-sync');

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function setProgress(p) {
    if (!barWrap || !bar) return;
    barWrap.style.display = p > 0 && p < 1 ? 'block' : 'none';
    bar.style.width = Math.round(p * 100) + '%';
  }

  function loadGifJs(cb) {
    if (window.GIF && window._gifWorkerUrl) { cb(); return; }
    setStatus('Loading GIF encoder…');
    const s = document.createElement('script');
    s.src = VENDOR.gif;
    s.onerror = () => setStatus('Failed to load GIF encoder. Could not load gif.js.');
    s.onload = () => {
      // Fetch worker script and wrap in a blob: URL so it loads same-origin,
      // bypassing the cross-origin restriction that causes encoding to stall at 0%.
      fetch(VENDOR.gifWorker)
        .then(r => r.text())
        .then(text => {
          const blob = new Blob([text], { type: 'application/javascript' });
          window._gifWorkerUrl = URL.createObjectURL(blob);
          setStatus('');
          cb();
        })
        .catch(() => {
          // Fallback to direct URL if fetch fails
          window._gifWorkerUrl = VENDOR.gifWorker;
          setStatus('');
          cb();
        });
    };
    document.head.appendChild(s);
  }

  if (!btnGen) return;

  // Mark user-edited when any time field changes; ↺ button resets and resyncs
  ['gif-period','gif-start-min','gif-start-sec','gif-end-min','gif-end-sec'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { _gifTimeUserEdited = true; });
  });
  if (btnSync) {
    btnSync.addEventListener('click', () => {
      _gifTimeUserEdited = false;
      _syncGifTimes();
    });
  }

  // Helper: read current time inputs
  function readTimes() {
    const period    = parseInt(document.getElementById('gif-period').value,    10) || 1;
    const startMin  = parseInt(document.getElementById('gif-start-min').value,  10) || 0;
    const startSec  = parseInt(document.getElementById('gif-start-sec').value,  10) || 0;
    const endMin    = parseInt(document.getElementById('gif-end-min').value,    10) || 0;
    const endSec    = parseInt(document.getElementById('gif-end-sec').value,    10) || 5;
    const fps       = parseInt(document.getElementById('gif-fps').value,        10) || 10;
    const scale     = parseFloat(document.getElementById('gif-scale').value)        || 0.5;
    const speedMult = parseFloat(document.getElementById('vid-speed').value)        || 1;
    return { period, startMin, startSec, endMin, endSec, fps, scale, speedMult };
  }

  // ── Video (WebM via MediaRecorder) ─────────────────────────────────────────
  if (btnVid) {
    btnVid.addEventListener('click', () => {
      if (!window.MediaRecorder) { setStatus('MediaRecorder not supported in this browser.'); return; }
      const { period, startMin, startSec, endMin, endSec, fps, speedMult } = readTimes();
      const startFi = findFrameByTime(period, startMin, startSec);
      const endFi   = findFrameByTime(period, endMin,   endSec);
      if (endFi <= startFi) { setStatus('End time must be after start.'); return; }

      const mimeType = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']
        .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

      // Crop to pitch area — no black letterbox bars in the saved video.
      // captureStream(fps) drives timestamps from the wall clock so the encoder
      // produces a correctly-timed video; requestFrame() hints encourage capture
      // immediately after each render rather than between renders.
      const pr = pitchRect();
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width  = pr.w;
      cropCanvas.height = pr.h;
      const cropCtx  = cropCanvas.getContext('2d');
      const stream   = cropCanvas.captureStream(fps);
      const track    = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks   = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const ext  = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
        const blob = new Blob(chunks, { type: mimeType });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'animation_P' + period + '_' + startMin + 'm' + startSec + 's_' + speedMult + 'x.' + ext;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus('Done! Video downloaded (' + mimeType.split(';')[0] + ', ' + speedMult + '×, ' + pr.w + '×' + pr.h + ').');
        setProgress(0);
        btnVid.disabled = false; btnGen.disabled = false;
        render(currentFi);
      };

      // speedMult compresses the clip: at 3× a 30s clip becomes a 10s video
      const step  = Math.max(1, Math.round(BASE_FPS / fps * speedMult));
      const delay = Math.round(1000 / fps);
      const frames = [];
      for (let fi = startFi; fi <= endFi; fi += step) frames.push(fi);
      const total = frames.length;

      // Pre-seed the crop canvas with the first frame before recorder.start()
      // so the stream is never empty when recording begins.
      stopPlayback();
      render(frames[0]);
      cropCtx.drawImage(canvas, pr.x, pr.y, pr.w, pr.h, 0, 0, pr.w, pr.h);
      if (track.requestFrame) track.requestFrame();

      recorder.start();
      btnVid.disabled = true; btnGen.disabled = true;
      setStatus('Recording frame 1 / ' + total + '…');
      setProgress(0);

      let idx = 0;
      function recNext() {
        if (idx >= frames.length) {
          // Extra delay before stop so the last requestFrame has time to flush
          setTimeout(() => recorder.stop(), delay * 4);
          return;
        }
        stopPlayback();
        render(frames[idx]);
        cropCtx.drawImage(canvas, pr.x, pr.y, pr.w, pr.h, 0, 0, pr.w, pr.h);
        // Push this canvas state as a video frame — synchronises capture with render
        if (track.requestFrame) track.requestFrame();
        setStatus('Recording frame ' + (idx + 1) + ' / ' + total);
        setProgress((idx + 1) / total);
        idx++;
        setTimeout(recNext, delay);
      }
      recNext();
    });
  }

  // ── GIF button ─────────────────────────────────────────────────────────────
  btnGen.addEventListener('click', () => {
    loadGifJs(() => {
      const { period, startMin, startSec, endMin, endSec, fps, scale } = readTimes();

      const startFi = findFrameByTime(period, startMin, startSec);
      const endFi   = findFrameByTime(period, endMin,   endSec);
      if (endFi <= startFi) { setStatus('End time must be after start time.'); return; }

      const step  = Math.max(1, Math.round(BASE_FPS / fps * speedMult));
      const delay = Math.round(1000 / fps);
      // Crop to pitch area (no black bars), then apply the user's scale factor
      const pr = pitchRect();
      const W  = Math.max(1, Math.round(pr.w * scale));
      const H  = Math.max(1, Math.round(pr.h * scale));

      // Offscreen canvas for downscaling
      const tmp    = document.createElement('canvas');
      tmp.width    = W; tmp.height = H;
      const tmpCtx = tmp.getContext('2d');

      const gif = new GIF({
        workers:      2,
        quality:      10,
        width:        W,
        height:       H,
        workerScript: window._gifWorkerUrl,
      });

      // Collect frame indices to capture
      const frames = [];
      for (let fi = startFi; fi <= endFi; fi += step) frames.push(fi);
      const total = frames.length;

      setStatus('Capturing frame 0 / ' + total + '…');
      setProgress(0);
      btnGen.disabled = true;

      // Async frame capture — yields to event loop between frames so UI stays responsive
      let idx = 0;
      function captureNext() {
        if (idx >= frames.length) {
          setStatus('Encoding GIF (' + total + ' frames)…');
          gif.render();
          return;
        }
        stopPlayback();
        render(frames[idx]);
        tmpCtx.clearRect(0, 0, W, H);
        // Blit only the pitch region from the main canvas, scaled to output size
        tmpCtx.drawImage(canvas, pr.x, pr.y, pr.w, pr.h, 0, 0, W, H);
        gif.addFrame(tmpCtx, { copy: true, delay });
        idx++;
        setStatus('Capturing frame ' + idx + ' / ' + total);
        setProgress(idx / total * 0.5);  // first 50% = capture phase
        setTimeout(captureNext, 0);
      }

      gif.on('progress', p => {
        setStatus('Encoding: ' + Math.round(p * 100) + '%');
        setProgress(0.5 + p * 0.5);
      });

      gif.on('finished', blob => {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = 'animation_P' + period + '_' + startMin + 'm' + startSec + 's.gif';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus('Done! ' + total + ' frames, ' + W + '×' + H + 'px.');
        setProgress(0);
        btnGen.disabled = false;
        render(currentFi);  // restore current frame
      });

      captureNext();
    });
  });

  // Initialise inputs to the current playback position on load
  _syncGifTimes();
})();

resizeCanvas();
// Canvas text needs the faces loaded before it can use them: load them, then redraw once.
if (document.fonts && document.fonts.load) {
  Promise.all(['300 16px "Roboto"', '400 16px "Roboto"', '700 16px "Roboto"'].map(f => document.fonts.load(f).catch(() => [])))
    .then(() => render(currentFi));
}

// ── Auto-fit the host iframe to the content ──────────────────────────────────
// Opening overlays / tables grows the page; resize the frame so nothing is cut off.
// Falls back to the fixed height (with internal scrolling) if the frame is not reachable.
(function () {
  const app = document.getElementById('app');
  const frame = window.frameElement;
  if (!app || !frame || !window.ResizeObserver) return;
  const MIN_H = 700;
  let last = 0;
  function fit() {
    const h = Math.max(MIN_H, Math.ceil(app.getBoundingClientRect().height) + 8);
    if (h === last) return;
    last = h;
    try { frame.style.height = h + 'px'; frame.setAttribute('height', h); } catch (e) { /* cross-origin: keep fixed height */ }
  }
  new ResizeObserver(fit).observe(app);
  fit();
})();
