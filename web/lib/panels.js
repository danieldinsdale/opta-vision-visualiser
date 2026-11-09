// Phases-of-play, player-run and pressure payload builders.
// Port of panels.py: raw feed structures -> compact, period-relative form for the pitch component.
import { pyRound } from './util.js';

const num = (v, d = 0) => { const n = Number(v ?? d); return Number.isNaN(n) ? d : Math.trunc(n); };
const sec = (ms, off, digits = 3) => pyRound((num(ms) - off) / 1000, digits);
const gj = (value) => {
  if (!value) return [0, 0];
  const parts = value.split(':').map(Number);
  return parts.length === 2 && parts.every(Number.isInteger) ? parts : [0, 0];
};

const SHAPE_STATS = ['goals', 'attempts', 'openPlayCross', 'touches', 'lbp', 'midfieldLbp', 'defensiveLbp', 'xT', 'xG', 'passes', 'successfulPasses'];

/**
 * ``remoteshape`` feed -> {<group>: {ip: [segment], oop: [segment]}} from the ``shapeHistory`` node only
 * (the segments of a team's in- and out-of-possession shape). A segment is
 * {p, s, e, l, f, o, r}: period, start and end (seconds into the period), shape label, formation, the feed's own
 * statistics for the segment (out of possession these are the ``...Conceded`` fields, keyed without the suffix)
 * and the roles [{j: shirt number, r: role description, x, y}] at the average role position
 * (``averageRolePositionX/Y``, 0-100 in the team's attacking direction). Nothing is calculated.
 */
export function buildShapes(lineup, feed) {
  const list = (feed && feed.liveData && feed.liveData.shapeHistory && feed.liveData.shapeHistory.contestant) || (Array.isArray(feed) ? feed : []);
  const map = lineup || {};
  const n = (v) => { const x = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(x) ? null : x; };
  const out = {};
  for (const c of list) {
    const g = num(map[`ctg_${(c && c.id) ?? ''}`], 0);
    if (g !== 1 && g !== 2) continue;
    const sides = {};
    for (const [key, short, suffix] of [['inPossession', 'ip', ''], ['outOfPossession', 'oop', 'Conceded']]) {
      const segs = [];
      for (const sh of ((c[key] || {}).shape || [])) {
        const roles = (((sh.shapeRole || {}).role) || []).map((r) => ({ j: num(r.shirtNumber, -1), r: r.roleDescription ?? '', x: n(r.averageRolePositionX), y: n(r.averageRolePositionY) }))
          .filter((r) => r.j >= 0 && r.x !== null && r.y !== null);
        const pid = num(sh.periodId);
        if (!pid || !roles.length) continue;
        const o = {};
        for (const k of SHAPE_STATS) {
          const v = n((sh.shapeOutcome || {})[k + suffix]);
          if (v !== null) o[k] = Math.round(v * 1000) / 1000;
        }
        segs.push({ p: pid, s: num(sh.periodStart), e: num(sh.periodEnd), l: String(sh.label ?? '').trim(), f: sh.formation ?? '', o, r: roles });
      }
      segs.sort((a, b) => a.p - b.p || a.s - b.s);
      sides[short] = segs;
    }
    out[g] = sides;
  }
  return out;
}

/** Returns ``{phasesByPeriod, runsByPeriod, pressures}``. */
export function buildContextPanels(lineup, phases, runs, pressures) {
  const map = lineup || {};

  // ── Phases of play ─────────────────────────────────────────────────────────
  const phasesByPeriod = {};
  const sorted = [...(phases || [])].sort((a, b) => num(a.startTime) - num(b.startTime));
  for (const ph of sorted) {
    const pid = num(ph.periodId);
    if (!((ph.phaseLabel || {}).value || '') || !pid) continue;
    (phasesByPeriod[String(pid)] ||= []).push(ph);
  }
  for (const key of Object.keys(phasesByPeriod)) {
    const raw = phasesByPeriod[key];
    const off = num(raw[0].startTime);          // first startTime = period offset (cumulative ms)
    phasesByPeriod[key] = raw.map((ph) => {
      const stats = Object.fromEntries(((ph.phaseSummary || {}).stat || []).map((s) => [s.type, s.value]));
      const seg = (list) => (list || []).map((s) => ({ s: sec(s.startTime, off), e: sec(s.endTime, off), _: s }));
      const dc = seg((ph.defensiveCompactnessSummary || {}).defensiveCompactness)
        .map(({ s, e, _ }) => ({ s, e, v: _.label ?? '', adc: _.averageDefensiveAreaCoverage ?? '' }));
      const fp = seg((ph.fastPassingTempoSummary || {}).fastPassingTempo).map(({ s, e }) => ({ s, e }));
      const dp = seg((ph.directPassingSummary || {}).directPassing).map(({ s, e }) => ({ s, e }));
      const ol = seg((ph.overloadSummary || {}).overload)
        .map(({ s, e, _ }) => ({ s, e, t: _.overloadType ?? '', att: _.attackerCount ?? '', def: _.defenderCount ?? '' }));
      const possG = num(map[`ctg_${ph.possessionContestantId ?? ''}`], 0);
      const initUuid = ph.initiatorPlayerId ?? '';
      const initGj = map[`gj_${initUuid}`] ?? '';
      let initJ = null;
      if (initGj) { const j = Number(initGj.split(':')[1]); initJ = Number.isInteger(j) ? j : null; }
      return {
        phId: ph.id ?? '',
        s: sec(ph.startTime, off), e: sec(ph.endTime, off),
        l: (ph.phaseLabel || {}).value ?? '',
        init: map[initUuid] ?? '', initJ,
        first: map[ph.firstTouchPlayerId ?? ''] ?? '',
        passes: stats.numberPasses ?? '', goal: stats.includesGoal ?? '', shots: stats.includesShots ?? '',
        possG, defG: possG === 1 || possG === 2 ? 3 - possG : 0,
        dc, fp, dp, ol,
      };
    });
  }

  // ── Runs (P1 offset 0, P2 offset 2,700,000 ms) ─────────────────────────────
  const runsByPeriod = {};
  if (runs && runs.length) {
    const offsets = { 1: 0, 2: 2700000 };
    const qint = (v) => { const n = Number(v); return v === '' || v === null || v === undefined || Number.isNaN(n) ? -1 : Math.trunc(n); };
    for (const r of [...runs].sort((a, b) => num(a.startTime) - num(b.startTime))) {
      const pid = num(r.periodId);
      if (!pid) continue;
      const off = offsets[pid] ?? 0;
      const master = ((r.labels || {}).label || []).find((l) => l.type === 'master');
      const playerId = r.playerId ?? '';
      const [g, j] = gj(map[`gj_${playerId}`]);
      const quals = {};
      for (const q of (r.qualifiers || {}).qualifier || []) if ('type' in q) quals[q.type] = q.value ?? '';
      (runsByPeriod[String(pid)] ||= []).push({
        runId: r.id ?? '',
        s: sec(r.startTime, off), e: sec(r.endTime, off),
        player: map[playerId] ?? '', label: master ? master.value : '', type: r.type ?? '',
        g, j, dlb: qint(quals.defensiveLineBroken ?? ''), mlb: qint(quals.midfieldLineBroken ?? ''),
      });
    }
  }

  // ── Pressure events (Opta 0-100 -> metres, period-relative seconds) ────────
  const toPitch = (x, y) => [pyRound((x / 100) * 105 - 52.5, 2), pyRound((y / 100) * 68 - 34, 2)];
  const pressuresOut = [];
  for (const ev of pressures || []) {
    const pid = num(ev.periodId);
    if (!pid) continue;
    const tRel = pyRound((num(ev.timeMin) - (pid - 1) * 45) * 60 + num(ev.timeSec), 1);
    const [rx, ry] = toPitch(Number(ev.x ?? 0), Number(ev.y ?? 0));
    const [rg, rj] = gj(map[`gj_${ev.playerId ?? ''}`]);
    const prsList = ((ev.pressure || {}).player || []).map((prs) => {
      const [px, py] = toPitch(Number(prs.positionX ?? 0), Number(prs.positionY ?? 0));
      const [g, j] = gj(map[`gj_${prs.playerId ?? ''}`]);
      return { x: px, y: py, g, j };
    });
    if (prsList.length) {
      pressuresOut.push({
        p: pid, t: tRel, rx, ry, rg, rj,
        pr: (((ev.pressure || {}).pressureReceived) || {}).value ?? '',
        prs: prsList,
      });
    }
  }
  return { phasesByPeriod, runsByPeriod, pressures: pressuresOut };
}

/** Period offsets (minutes) of the momentum feed's running match minute: period 2 starts at 45, extra time at 90 and 105. */
const MOMENTUM_OFFSET = { 1: 0, 2: 45, 3: 90, 4: 105 };

/**
 * Optional momentum feed -> [[period, minute within the period (1 = its first minute), combined]] sorted by time.
 * ``combined`` is the feed's own "Combined" value (home minus away: positive favours the home side). Nothing is calculated.
 */
export function buildMomentum(feed) {
  const list = Array.isArray(feed) ? feed : ((feed || {}).liveData || {}).predictions || [];
  const seen = new Map();
  for (const item of list) {
    if (!item || item.type !== 'Momentum') continue;
    const p = Number(item.periodId), m = Number(item.timeMin) - (MOMENTUM_OFFSET[p] ?? NaN);
    const combined = (item.prediction || []).find((x) => x && x.type === 'Combined');
    const c = combined ? Number(combined.probability) : NaN;
    if (!Number.isInteger(p) || !Number.isInteger(m) || m < 1 || !Number.isFinite(c)) continue;
    seen.set(`${p}|${m}`, [p, m, c]);
  }
  return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
