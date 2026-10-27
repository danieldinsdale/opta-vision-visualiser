// Opta event feed (``remoteevents`` JSON): parsing, direction of play and placement on the
// EPTS timeline. Port of readers/events.py - see that file for the validation notes.
//
// Event x/y arrive on the Opta 0-100 scale, relative to the acting team's attack. They are
// converted to metres (centre origin) and rotated 180 degrees for teams attacking right-to-left.
// Placement order: exact event id on EPTS ball rows, then video time minus the per-period
// offset learned from those matches, then the period-relative match clock.
import { InputError, MAX_JSON_BYTES } from './limits.js';
import { median, roundHalfEven } from './util.js';

/** Parse a JSON feed from bytes/text with a size guard. */
export function loadJson(data, what) {
  const len = typeof data === 'string' ? data.length : data.byteLength;
  if (len > MAX_JSON_BYTES) throw new InputError(`${what} exceeds the ${MAX_JSON_BYTES / (1024 * 1024)} MB limit`);
  try {
    return JSON.parse(typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data));
  } catch (e) {
    throw new InputError(`${what} is not valid JSON (${e.message})`);
  }
}

const toFloat = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isNaN(n) ? NaN : n;
};
const toInt = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new Error('int');
  return n;
};

/** ``remoteevents`` payload -> array of event objects. ``names`` = {eventTypes, qualifiers}. */
export function parseRemoteEvents(feed, names) {
  const raw = ((feed && feed.liveData) || {}).event || [];
  const out = [];
  for (const e of raw) {
    let typeId, eventId, period;
    try {
      typeId = toInt(e.typeId); eventId = toInt(e.id);
      period = e.periodId === undefined ? 0 : toInt(e.periodId);
    } catch { continue; }
    const quals = [];
    for (const q of e.qualifier || []) {
      let qid;
      try { qid = toInt(q.qualifierId); } catch { continue; }
      const qual = { id: qid, name: names.qualifiers[qid] ?? String(qid) };
      if (qid === 277) qual.value = String(q.value ?? '');   // MINUTES: the added minutes on an injury-time announcement
      quals.push(qual);
    }
    let periodSeconds;
    try {
      periodSeconds = (toInt(e.timeMin ?? 0) - Math.max(period - 1, 0) * 45) * 60 + toInt(e.timeSec ?? 0);
    } catch { periodSeconds = NaN; }
    out.push({
      opta_event_id: eventId,
      event_type_id: typeId,
      event_type_desc: names.eventTypes[typeId] ?? `type_${typeId}`,
      period,
      contestant_id: e.contestantId || '',
      player_uuid: e.playerId || '',
      player_name: e.playerName || '',
      event_x: toFloat(e.x) * 1.05 - 52.5,
      event_y: toFloat(e.y) * 0.68 - 34.0,
      outcome: e.outcome ?? null,
      qualifiers: quals,
      video_time_ms: toFloat(e.trackingDataVideoTimeMs),
      period_seconds: periodSeconds,
    });
  }
  return out;
}

/** Rotate events of teams attacking right-to-left. ``directions``: Map "period|team" -> +1 / -1. */
export function applyAttackingDirection(events, directions) {
  const missing = new Set();
  for (const e of events) if (!directions.has(`${e.period}|${e.contestant_id}`)) missing.add(`${e.period}|${e.contestant_id}`);
  if (missing.size) {
    throw new InputError(`No direction of play in the EPTS metadata for (period, team): ${[...missing].sort().slice(0, 3).join(', ')}`);
  }
  return events.map((e) => {
    const s = directions.get(`${e.period}|${e.contestant_id}`);
    return { ...e, event_x: e.event_x * s, event_y: e.event_y * s };
  });
}

/**
 * Attach ``implied`` (100 Hz frame count) to each event using the tracking timeline.
 * ``tracking``: {implied, eventIds} per line (see epts.js). Returns {events, stats}.
 */
export function placeEvents(events, tracking) {
  const stats = { total: events.length, matched: 0, estimated: 0, dropped: 0 };
  if (!events.length) return { events: [], stats };

  const idToFrame = new Map();
  for (let i = 0; i < tracking.nLines; i++) {
    const ids = tracking.eventIds[i];
    if (!ids) continue;
    for (const token of ids.split('|')) {
      if (/^\d+$/.test(token.trim())) idToFrame.set(Number(token.trim()), tracking.implied[i]);
    }
  }

  const frames = events.map((e) => idToFrame.get(e.opta_event_id) ?? NaN);
  const matched = frames.map((f) => !Number.isNaN(f));
  stats.matched = matched.filter(Boolean).length;

  // Per-period clock offset between feed video time and tracking time (centiseconds).
  const diffs = new Map();
  events.forEach((e, i) => {
    if (matched[i] && !Number.isNaN(e.video_time_ms)) {
      if (!diffs.has(e.period)) diffs.set(e.period, []);
      diffs.get(e.period).push(e.video_time_ms / 10 - frames[i]);
    }
  });
  const offsets = new Map([...diffs].map(([p, d]) => [p, median(d)]));

  const placed = [];
  events.forEach((e, i) => {
    let f = frames[i];
    if (!matched[i]) {
      const viaVideo = offsets.has(e.period) ? e.video_time_ms / 10 - offsets.get(e.period) : NaN;
      f = Number.isNaN(viaVideo) ? e.period_seconds * 100 : viaVideo;
      if (!Number.isNaN(f)) stats.estimated++;
    }
    if (Number.isNaN(f)) { stats.dropped++; return; }
    placed.push({ ...e, implied: roundHalfEven(f) });
  });
  return { events: placed, stats };
}
