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
