// Ancillary match feeds: phases, runs, pressure events and the lineup lookup.
// Port of readers/feeds.py. Every extractor accepts either the full feed payload (object) or
// the already-extracted list, so files saved from the API or hand-trimmed both work.
import { InputError } from './limits.js';
import { pyRound } from './util.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pystr = (v) => (v === undefined ? '' : v === null ? 'None' : String(v));

export function extractPhases(feed) {
  if (Array.isArray(feed)) return feed.filter(isObj);
  if (isObj(feed)) return [...(((feed.liveData || {}).phaseByPhase || {}).phase || [])];
  return [];
}

export function extractRuns(feed) {
  if (Array.isArray(feed)) return feed.filter(isObj);
  if (isObj(feed)) return [...(((feed.liveData || {}).runByRun || {}).run || [])];
  return [];
}

const periodOf = (e) => {
  const n = Number(e.periodId);
  return Number.isInteger(n) && e.periodId !== null && e.periodId !== '' ? n : null;
};

/**
 * Events carrying a ``pressure`` node. Positions are relative to the event team's attacking
 * direction, so they are rotated 180 degrees (``v -> 100 - v``) for teams attacking
 * right-to-left (``directions`` from the EPTS XML) to match absolute tracking coordinates.
 */
export function extractPressureEvents(eventsFeed, directions) {
  let events;
  if (isObj(eventsFeed)) events = (eventsFeed.liveData || {}).event || [];
  else if (Array.isArray(eventsFeed)) events = eventsFeed;
  else return [];
  const played = new Set([...directions.keys()].map((k) => Number(k.split('|')[0])));
  const flip = (v) => {
    const n = Number(v);
    return v === null || v === '' || v === undefined || Number.isNaN(n) ? v : String(pyRound(100 - n, 2));
  };
  const out = [];
  for (const e of events) {
    if (!isObj(e) || !((e.pressure || {}).player || []).length || !played.has(periodOf(e))) continue;
    const direction = directions.get(`${periodOf(e) ?? 0}|${e.contestantId ?? ''}`);
    if (direction === undefined) throw new InputError('No direction of play in the EPTS metadata for a pressure event.');
    if (direction === -1) {
      const c = structuredClone(e);
      c.x = flip(c.x); c.y = flip(c.y);
      for (const prs of c.pressure.player) { prs.positionX = flip(prs.positionX); prs.positionY = flip(prs.positionY); }
      out.push(c);
    } else out.push(e);
  }
  return out;
}

/**
 * Flat lookup consumed by the pitch component. Keys:
 *   teamname_1 / teamname_2, ctg_<contestantId> -> group, gj_<playerUuid> -> "group:jersey",
 *   <playerUuid> and "<group>:<jersey>" -> display name, kit_1 / kit_2, match_* (title bar).
 * Names come from the match stats feed, else the events feed, else are left blank (#jersey).
 */
export function buildLineup(meta, matchstats, events) {
  const lookup = {};
  for (const [team, group] of meta.teamGroups) lookup[`ctg_${team}`] = String(group);
  for (const [uuid, p] of meta.players) {
    lookup[`gj_${uuid}`] = `${p.group}:${p.jersey}`;
    if (p.name) { lookup[uuid] = p.name; lookup[`${p.group}:${p.jersey}`] = p.name; }
  }
  const setName = (uuid, name) => {
    const p = meta.players.get(uuid);
    if (!(uuid && name && p)) return;
    lookup[uuid] = name;
    lookup[`${p.group}:${p.jersey}`] = name;
  };

  if (events && events.length) {
    const seen = new Set();
    for (const e of events) {
      const k = `${e.player_uuid}\u0000${e.player_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      setName(e.player_uuid, e.player_name);
    }
  }

  if (matchstats) {
    const info = matchstats.matchInfo || {};
    const contestantGroup = {};
    for (const c of info.contestant || []) {
      const cid = c.id ?? '', pos = c.position ?? '';
      const group = pos === 'home' ? 1 : pos === 'away' ? 2 : 0;
      if (cid && group) {
        contestantGroup[cid] = group;
        lookup[`teamname_${group}`] = c.name || c.shortName || '';
        lookup[`ctg_${cid}`] = String(group);
      }
    }
    const live = matchstats.liveData || {};
    const total = (((live.matchDetails || {}).scores || {}).total) || {};
    lookup.match_home_score = pystr(total.home);
    lookup.match_away_score = pystr(total.away);
    const comp = info.competition || {};
    lookup.match_comp = comp.knownName || comp.name || '';
    const venue = info.venue || {};
    lookup.match_venue = venue.shortName || venue.longName || venue.name || '';
    lookup.match_date = pystr(info.date).replace(/Z+$/, '');
    for (const team of live.lineUp || []) {
      const group = contestantGroup[team.contestantId ?? ''] || 0;
      if (!group) continue;
      const colour = (team.kit || {}).colour1 ?? '';
      if (typeof colour === 'string' && colour.length === 7 && colour.startsWith('#')) lookup[`kit_${group}`] = colour;
      for (const player of team.player || []) {
        const pid = player.playerId ?? '', shirt = player.shirtNumber, name = player.matchName ?? '';
        setName(pid, name);
        const shirtNo = shirt === undefined || shirt === null ? null : Math.trunc(Number(shirt));
        if (pid && shirtNo !== null && !Number.isNaN(shirtNo) && !(`gj_${pid}` in lookup)) lookup[`gj_${pid}`] = `${group}:${shirtNo}`;
        if (shirtNo !== null && !Number.isNaN(shirtNo) && name) {
          lookup[`${group}:${shirtNo}`] = name;
          if (!(pid in lookup)) lookup[pid] = name;
        }
      }
    }
  }
  return lookup;
}
