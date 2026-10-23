// End-to-end: raw inputs (bytes) -> animation payload. Runs identically in the browser worker
// and in Node (used by the tests and the comparison against the Python implementation).
import { readEptsBundle } from './archive.js';
import { parseEptsFrames, parseEptsMetadata } from './epts.js';
import { applyAttackingDirection, loadJson, parseRemoteEvents, placeEvents } from './events.js';
import { buildLineup, extractPhases, extractPressureEvents, extractRuns } from './feeds.js';
import { buildContextPanels } from './panels.js';
import { buildPayload } from './payload.js';

/**
 * ``inputs``: {bundle?, txt?, xml?, events?, matchstats?, phases?, runs?} (Uint8Array / string).
 * ``options``: {names: {eventTypes, qualifiers}, ballImage, vodUrls}.
 * Returns {payload, warnings, eventStats}.
 */
export async function buildMatchPayload(inputs, options, progress = () => {}) {
  let { txt, xml } = inputs;
  if (inputs.bundle) ({ txt, xml } = await readEptsBundle(inputs.bundle));
  progress('Reading metadata');
  const meta = parseEptsMetadata(xml);
  progress('Parsing tracking frames');
  const frames = parseEptsFrames(txt, meta);

  const warnings = [];
  let events = [], eventStats = {}, pressures = [];
  if (inputs.events) {
    progress('Placing events');
    const eventsFeed = loadJson(inputs.events, 'Events feed');
    const directions = meta.directions;
    const playedPeriods = new Set([...directions.keys()].map((k) => Number(k.split('|')[0])));
    let parsed = parseRemoteEvents(eventsFeed, options.names)
      .filter((e) => e.event_type_desc !== 'deleted_event' && !Number.isNaN(e.event_x) && !Number.isNaN(e.event_y))
      // Pre-/post-match periods in the feed (e.g. 14, 16) have no tracking, so no pitch position.
      .filter((e) => playedPeriods.has(e.period));
    parsed = applyAttackingDirection(parsed, directions);
    ({ events, stats: eventStats } = placeEvents(parsed, frames));
    pressures = extractPressureEvents(eventsFeed, directions);
    if (eventStats.dropped) warnings.push(`${eventStats.dropped} events could not be placed on the tracking timeline.`);
  }

  const matchstats = inputs.matchstats ? loadJson(inputs.matchstats, 'Match stats feed') : null;
  const lineup = buildLineup(meta, matchstats, events);
  const teamColors = {};
  for (const g of [1, 2]) if (lineup[`kit_${g}`]) teamColors[g] = lineup[`kit_${g}`];
  const teamColors2 = {};            // second colour per team; only when it differs from the first
  for (const g of [1, 2]) {
    const c2 = lineup[`kit2_${g}`];
    if (c2 && c2.toLowerCase() !== String(lineup[`kit_${g}`] || '').toLowerCase()) teamColors2[g] = c2;
  }

  const phases = inputs.phases ? extractPhases(loadJson(inputs.phases, 'Phases feed')) : [];
  const runs = inputs.runs ? extractRuns(loadJson(inputs.runs, 'Runs feed')) : [];
  progress('Building the animation data');
  const panels = buildContextPanels(lineup, phases, runs, pressures);
  const payload = buildPayload(frames, events, {
    lineup, panels, teamColors, teamColors2, vodUrls: options.vodUrls, ballImage: options.ballImage,
  });
  return { payload, warnings, eventStats, matchUuid: meta.matchUuid };
}
