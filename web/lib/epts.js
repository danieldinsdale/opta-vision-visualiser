// EPTS tracking reader: XML format specification + raw 25 Hz text frames.
// Port of readers/epts.py. Output is column-oriented (typed arrays), not row objects, so a
// 150 MB tracking file stays manageable in the browser.
import { childText, findPath, iterAll, parseXml } from './xml.js';
import { InputError, MAX_BAD_LINE_FRACTION } from './limits.js';
import { Grow, roundHalfEven } from './util.js';

export const BALL_GROUP = 4;
export const BALL_JERSEY = -1;

const textOf = (x) => (typeof x === 'string' ? x : new TextDecoder('utf-8', { fatal: true }).decode(x));

function playerName(player) {
  for (const tag of ['Shortname', 'ShortName', 'Name', 'LastName', 'FirstName']) {
    const el = player.children.find((c) => c.name === tag);
    if (el && el.text.trim()) return el.text.trim();
  }
  return '';
}

const toInt = (s) => {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error('int');
  return Number(t);
};
const toFloat = (s) => {
  if (s === '') return NaN;
  const v = Number(s);
  if (Number.isNaN(v)) throw new Error('float');
  return v;
};

/** Parse the EPTS XML into player / team / direction lookups. */
export function parseEptsMetadata(xml) {
  let root;
  try { root = parseXml(textOf(xml)); } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError('EPTS metadata XML could not be parsed');
  }
  const meta = { players: new Map(), teamGroups: new Map(), matchUuid: '', directions: new Map() };

  for (const param of iterAll(root, 'ProviderParameter')) {
    const name = param.children.find((c) => c.name === 'Name');
    const value = param.children.find((c) => c.name === 'Value');
    if (name && name.text === 'match_uuid' && value && value.text) { meta.matchUuid = value.text.trim(); break; }
  }

  for (const player of iterAll(root, 'Player')) {
    const uuid = player.attrs.id, team = player.attrs.teamId;
    const shirt = player.children.find((c) => c.name === 'ShirtNumber');
    const ptype = findPath(player, 'ProviderPlayerParameters/ProviderParameter/Value');
    if (!uuid || !team || !shirt || !ptype) throw new InputError(`Player entry '${uuid}' is missing id, team, shirt number or type`);
    let jersey, typeCode;
    try { jersey = toInt(shirt.text); typeCode = toInt(ptype.text); } catch {
      throw new InputError(`Player '${uuid}' has a non-numeric shirt number or type`);
    }
    // Provider type codes: 0 home outfield, 1 away outfield, 3 home GK, 4 away GK
    const isGk = typeCode === 3 || typeCode === 4;
    const group = (isGk ? typeCode - 3 : typeCode) + 1;
    if (group !== 1 && group !== 2) throw new InputError(`Player '${uuid}' has unsupported provider type ${typeCode}`);
    meta.players.set(uuid, { team, jersey, group, isGk, name: playerName(player) });
    meta.teamGroups.set(team, group);
  }
  if (!meta.players.size) throw new InputError('EPTS metadata contains no players');

  for (const dop of iterAll(root, 'DirectionsOfPlay')) {
    for (const period of dop.children.filter((c) => c.name === 'Period')) {
      let periodId;
      try { periodId = toInt(period.attrs.id ?? ''); } catch { continue; }
      for (const team of period.children.filter((c) => c.name === 'Team')) {
        const value = (childText(team, 'DirectionOfPlay') || '').trim();
        if (team.attrs.id && (value === 'LeftToRight' || value === 'RightToLeft')) {
          meta.directions.set(`${periodId}|${team.attrs.id}`, value === 'LeftToRight' ? 1 : -1);
        }
      }
    }
  }
  if (!meta.directions.size) throw new InputError('EPTS metadata has no DirectionsOfPlay');
  return meta;
}

/**
 * Parse the raw frame text. Returns column arrays:
 *   per line (frame):  period, implied (100 Hz frame count), ballX/Y/Z, eventIds, possG/possJ
 *   per entity row:    rowLine, rowEntity, x, y, vis      (players only; the ball is per line)
 *   entities:          [{g, j, gk}] indexed by rowEntity
 */
export function parseEptsFrames(rawBytesOrText, meta) {
  const text = textOf(rawBytesOrText);
  const L = {
    period: new Grow(Int16Array), implied: new Grow(Int32Array),
    ballX: new Grow(Float32Array), ballY: new Grow(Float32Array), ballZ: new Grow(Float32Array),
    ballVis: new Grow(Uint8Array), possG: new Grow(Int8Array), possJ: new Grow(Int16Array),
    eventIds: [],
  };
  const R = { line: new Grow(Int32Array), entity: new Grow(Int16Array), x: new Grow(Float32Array), y: new Grow(Float32Array), vis: new Grow(Uint8Array) };
  const entityIndex = new Map();
  const entities = [];
  const entityFor = (g, j, gk) => {
    const key = g * 1000 + j;
    let idx = entityIndex.get(key);
    if (idx === undefined) { idx = entities.length; entityIndex.set(key, idx); entities.push({ g, j, gk }); }
    else if (gk) entities[idx].gk = true;
    return idx;
  };
  const ballEntity = entityFor(BALL_GROUP, BALL_JERSEY, false);

  // (period, implied) -> the first line that used it, used to drop the rare duplicate rows
  // (same period / frame / entity) exactly as the Python version does.
  const seenFrames = new Map();
  let total = 0, bad = 0, pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end).trim();
    pos = end + 1;
    if (!line) { if (end >= text.length) break; continue; }
    total++;
    try {
      const parts = line.split(':');
      if (parts.length !== 4) throw new Error('shape');
      const ball = parts[2].split(',');
      if (ball.length !== 10) throw new Error('shape');
      toInt(parts[0]);
      const period = toInt(ball[5]);
      const matched = toInt(ball[9]);
      const chunks = parts[1].split(';');
      const rows = [];
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const f = chunk.split(',');
        if (f.length !== 5) throw new Error('shape');
        rows.push([f[0], toFloat(f[1]), toFloat(f[2]), toFloat(f[3]), toInt(f[4])]);
      }
      const bx = toFloat(ball[0]), by = toFloat(ball[1]), bz = toFloat(ball[2]);
      toFloat(ball[3]); const bvis = toInt(ball[4]);

      const implied = roundHalfEven(matched / 10);
      const key = period * 1e9 + implied;
      let frame = seenFrames.get(key);
      if (!frame) {
        // First line for this (period, frame): it supplies the ball, events and possession.
        frame = { line: L.period.n, entities: null, start: R.line.n, end: 0, done: false };
        L.period.push(period); L.implied.push(implied);
        L.ballX.push(bx); L.ballY.push(by); L.ballZ.push(bz); L.ballVis.push(bvis);
        L.eventIds.push(ball[6]);
        const pl = meta.players.get(ball[8]);
        L.possG.push(pl ? pl.group : 0); L.possJ.push(pl ? pl.jersey : 0);
        seenFrames.set(key, frame);
      } else if (!frame.entities) {
        // A second line for the same frame: its rows are kept only for entities not yet seen
        // (the Python version drops exact duplicates the same way).
        frame.entities = new Set();
        for (let r = frame.start; r < frame.end; r++) frame.entities.add(R.entity.a[r]);
      }
      const inLine = frame.entities || new Set();
      for (const [uuid, x, y, , vis] of rows) {
        const p = meta.players.get(uuid);
        if (!p) continue;                        // players not in the metadata cannot be identified
        const e = entityFor(p.group, p.jersey, p.isGk);
        if (inLine.has(e)) continue;
        inLine.add(e);
        R.line.push(frame.line); R.entity.push(e); R.x.push(x); R.y.push(y); R.vis.push(vis);
      }
      if (!frame.done) { frame.end = R.line.n; frame.done = true; }
    } catch {
      bad++;
    }
    if (end >= text.length) break;
  }
  if (total === 0) throw new InputError('EPTS raw data file is empty');
  if (bad / total > MAX_BAD_LINE_FRACTION) {
    throw new InputError(`${bad} of ${total} EPTS lines could not be parsed - is this a 25 Hz EPTS raw data file?`);
  }
  return {
    nLines: L.period.n,
    period: L.period.view, implied: L.implied.view,
    ballX: L.ballX.view, ballY: L.ballY.view, ballZ: L.ballZ.view, ballVis: L.ballVis.view,
    possG: L.possG.view, possJ: L.possJ.view, eventIds: L.eventIds,
    rows: { line: R.line.view, entity: R.entity.view, x: R.x.view, y: R.y.view, vis: R.vis.view },
    entities, ballEntity,
  };
}
