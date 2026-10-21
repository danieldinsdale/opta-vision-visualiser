// Builds the compact JSON payload the animation reads. Port of viz.build_payload and
// loader.build_match; the animation component itself is shared with the Python version.
import { InputError } from './limits.js';
import { pyRound, roundHalfEven, roundTo } from './util.js';

const TEAM_COLORS = { 1: '#4682b4', 2: '#cd5c5c', 4: '#f5c518' };
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const SOURCE_ID = 'epts';
// Rendering style of the (single) tracking source - mirrors config/data_type_config.yaml.
const SOURCE_STYLE = { label: 'EPTS', fill: true, alpha: 0.9, dash: false, prefix: '', suffix: '' };

/** Defuse markup in feed-supplied strings (the component renders some labels via innerHTML). */
export function neutralise(value) {
  if (typeof value === 'string') {
    let out = '';
    for (const ch of value) if (ch >= ' ' || ch === '\t') out += ch;
    return out.replace(/</g, '‹').replace(/>/g, '›');
  }
  if (Array.isArray(value)) return value.map(neutralise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [neutralise(k), neutralise(v)]));
  }
  return value;
}

const r2 = (v) => roundTo(v, 2);

/**
 * ``frames``: parseEptsFrames output; ``events``: placed events; returns the payload object.
 * ``extras``: {lineup, panels:{phasesByPeriod, runsByPeriod, pressures}, teamColors, vodUrls, ballImage}.
 */
export function buildPayload(frames, events, extras) {
  const { nLines, period, implied, rows, entities } = frames;
  if (!nLines) throw new InputError('No tracking positions to display');

  // ── Continuous frame count: 25 Hz frames, running on across periods ───────────
  const frames25 = new Int32Array(nLines);
  const maxPerPeriod = new Map();
  for (let i = 0; i < nLines; i++) {
    frames25[i] = Math.floor(implied[i] / 4);
    maxPerPeriod.set(period[i], Math.max(maxPerPeriod.get(period[i]) ?? -Infinity, frames25[i]));
  }
  const periodOffset = new Map();
  let running = 0;
  for (const p of [...maxPerPeriod.keys()].sort((a, b) => a - b)) {
    periodOffset.set(p, running);
    running += maxPerPeriod.get(p) + 1;
  }
  const cont = new Float64Array(nLines);
  for (let i = 0; i < nLines; i++) cont[i] = frames25[i] + periodOffset.get(period[i]);

  // ── Frame index from ball rows (first line per continuous frame, sorted) ──────
  const firstLineOfCont = new Map();
  for (let i = 0; i < nLines; i++) if (!firstLineOfCont.has(cont[i])) firstLineOfCont.set(cont[i], i);
  const frameIds = [...firstLineOfCont.keys()].sort((a, b) => a - b);
  const rank = new Map(frameIds.map((c, i) => [c, i]));
  const lineFi = new Int32Array(nLines);
  for (let i = 0; i < nLines; i++) lineFi[i] = rank.get(cont[i]);
  const nFrames = frameIds.length;
  const repLines = frameIds.map((c) => firstLineOfCont.get(c));

  const minImplied = new Map();
  for (const l of repLines) minImplied.set(period[l], Math.min(minImplied.get(period[l]) ?? Infinity, implied[l]));
  const periodFrameOffsets = {};
  for (const p of [...minImplied.keys()].sort((a, b) => a - b)) {
    periodFrameOffsets[p] = (p === 1 ? 10000 : (p - 1) * 100000) - minImplied.get(p);
  }
  const meta = {
    period: repLines.map((l) => period[l]),
    time: repLines.map((l) => r2(implied[l] / 100)),
    impliedFrame: repLines.map((l) => implied[l]),
    periodFrameOffsets,
    inPlay: new Array(nFrames).fill(true),
  };

  // ── Possession and "in view" per frame ───────────────────────────────────────
  const possession = new Array(nFrames).fill(null);
  for (let i = 0; i < nLines; i++) {
    if (frames.possG[i] > 0 && possession[lineFi[i]] === null) possession[lineFi[i]] = { g: frames.possG[i], j: frames.possJ[i] };
  }
  const detected = new Array(nFrames).fill(null);
  const entityKey = entities.map((e) => `${e.g}:${e.j}`);
  for (let r = 0; r < rows.line.length; r++) {
    if (!rows.vis[r]) continue;
    const fi = lineFi[rows.line[r]];
    (detected[fi] ||= []).push(entityKey[rows.entity[r]]);
  }

  // ── Entities: sparse positions indexed by frame index ────────────────────────
  const acc = entities.map(() => ({ fi: [], x: [], y: [], z: [], bv: [], anyZ: false }));
  for (let r = 0; r < rows.line.length; r++) {
    const a = acc[rows.entity[r]];
    const fi = lineFi[rows.line[r]];
    if (rows.vis[r]) a.bv.push(fi);
    if (Number.isNaN(rows.x[r]) || Number.isNaN(rows.y[r])) continue;
    a.fi.push(fi); a.x.push(r2(rows.x[r])); a.y.push(r2(rows.y[r]));
  }
  const ball = acc[frames.ballEntity];
  for (let i = 0; i < nLines; i++) {
    const fi = lineFi[i];
    if (!Number.isNaN(frames.ballZ[i])) ball.anyZ = true;
    if (frames.ballVis[i]) ball.bv.push(fi);
    if (Number.isNaN(frames.ballX[i]) || Number.isNaN(frames.ballY[i])) continue;
    ball.fi.push(fi); ball.x.push(r2(frames.ballX[i])); ball.y.push(r2(frames.ballY[i]));
    ball.z.push(Number.isNaN(frames.ballZ[i]) ? 0 : r2(frames.ballZ[i]));
  }
  const order = entities.map((_, i) => i).sort((p, q) => entities[p].g - entities[q].g || entities[p].j - entities[q].j);
  const entityOut = [];
  for (const idx of order) {
    const e = entities[idx], a = acc[idx];
    if (!a.fi.length) continue;
    const entry = { fi: a.fi, x: a.x, y: a.y };
    if (a.anyZ) entry.z = a.z;
    const out = { g: e.g, j: e.j, s: { [SOURCE_ID]: entry } };
    if (e.gk) out.gk = true;
    if (a.bv.length) out.bv = a.bv;
    entityOut.push(out);
  }

  const periodStartTimes = {};
  for (const [p, v] of [...minImplied].sort((a, b) => a[0] - b[0])) periodStartTimes[String(p)] = pyRound(v / 100, 2);

  const lineup = extras.lineup || {};
  const { phasesByPeriod, runsByPeriod, pressures } = extras.panels;

  const colors = { ...TEAM_COLORS };
  for (const [k, v] of Object.entries(extras.teamColors || {})) if (k in colors && typeof v === 'string' && HEX_RE.test(v)) colors[k] = v;

  const payload = {
    pitch: { L: 105.0, W: 68.0 },
    sources: [{ id: SOURCE_ID, label: SOURCE_STYLE.label, fill: SOURCE_STYLE.fill, alpha: SOURCE_STYLE.alpha, dash: SOURCE_STYLE.dash,
      prefix: SOURCE_STYLE.prefix, suffix: SOURCE_STYLE.suffix, possession, detected }],
    colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [String(k), v])),
    frameIds,
    meta,
    entities: entityOut,
    events: eventsPayload(events, frameIds, periodOffset, lineup),
    lineup,
    phases: phasesByPeriod,
    runs: runsByPeriod,
    pressures,
    vodUrls: extras.vodUrls || {},
    ballImage: extras.ballImage || '',
    periodStartTimes,
    kickoffFrameCounts: { 1: 10000, 2: 100000, 3: 2000000, 4: 3000000 },
  };
  for (const key of ['sources', 'lineup', 'events', 'phases', 'runs', 'pressures']) payload[key] = neutralise(payload[key]);
  return payload;
}

/** Events as {fi, t, x, y, g, p, jn, ti, eid, quals} sorted by frame index. */
function eventsPayload(events, frameIds, periodOffset, lineup) {
  if (!events || !events.length || !frameIds.length) return [];
  const ev = events.filter((e) => periodOffset.has(e.period));
  if (!ev.length) return [];
  const n = frameIds.length;
  const placed = ev.map((e) => {
    const c = Math.floor(e.implied / 4) + periodOffset.get(e.period);
    let pos = 0;
    if (n > 1) {
      let lo = 0, hi = n;                       // searchsorted (left), then clip to [1, n-1]
      while (lo < hi) { const mid = (lo + hi) >> 1; if (frameIds[mid] < c) lo = mid + 1; else hi = mid; }
      pos = Math.min(Math.max(lo, 1), n - 1);
      pos = Math.abs(c - frameIds[pos - 1]) <= Math.abs(frameIds[pos] - c) ? pos - 1 : pos;
    }
    return { e, fi: pos };
  });
  placed.sort((a, b) => a.fi - b.fi);           // stable
  return placed.map(({ e, fi }) => {
    const gj = lineup[`gj_${e.player_uuid}`] || '';
    let group = null, jersey = null;
    if (gj) [group, jersey] = gj.split(':').map(Number);
    else if (e.contestant_id && `ctg_${e.contestant_id}` in lineup) group = Number(lineup[`ctg_${e.contestant_id}`]);
    return {
      fi, t: e.event_type_desc, x: pyRound(e.event_x, 2), y: pyRound(e.event_y, 2),
      g: group || 0, p: e.period, jn: jersey,
      ti: group === 1 || group === 2 ? group - 1 : null,
      eid: e.opta_event_id, quals: e.qualifiers,
    };
  });
}

export { roundHalfEven };
