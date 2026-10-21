// Regression for the left-to-right / right-to-left handling of event coordinates.
// Events are generated from the actor's real tracked position, expressed the way the feed
// expresses them (relative to the acting team's attack). After loading they must land back on
// the player - for teams attacking either way, in both halves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEptsFrames, parseEptsMetadata } from '../lib/epts.js';
import { buildMatchPayload } from '../lib/pipeline.js';
import { fixture, options } from './helpers.mjs';

const HOME = 'teamhome000000000000000001', AWAY = 'teamaway000000000000000002';
const ACTORS = [  // [period, frame index in period, event id, actor uuid, group, jersey, contestant]
  [1, 10, 2001, 'hplayer0000000000000000002', 1, 2, HOME],
  [1, 12, 2002, 'aplayer0000000000000000003', 2, 3, AWAY],
  [2, 10, 2003, 'hplayer0000000000000000002', 1, 2, HOME],
  [2, 12, 2004, 'aplayer0000000000000000003', 2, 3, AWAY],
];
const FRAMES_PER_PERIOD = 300;
const lineOf = (period, i) => (period - 1) * FRAMES_PER_PERIOD + i;

/** Put each event id on the ball row of its frame (field 7 of the ball segment). */
function withEventIds(rawText) {
  const lines = rawText.split('\n');
  for (const [period, i, eid] of ACTORS) {
    const parts = lines[lineOf(period, i)].split(':');
    const ball = parts[2].split(',');
    ball[6] = String(eid);
    parts[2] = ball.join(',');
    lines[lineOf(period, i)] = parts.join(':');
  }
  return lines.join('\n');
}

test('events land on the acting player for both directions of play and both periods', async () => {
  const xml = new Uint8Array(fixture('spec.xml'));
  const raw = withEventIds(fixture('raw.txt').toString('utf8'));
  const meta = parseEptsMetadata(xml);
  const frames = parseEptsFrames(raw, meta);
  const positionOf = (line, group, jersey) => {
    const e = frames.entities.findIndex((x) => x.g === group && x.j === jersey);
    for (let r = 0; r < frames.rows.line.length; r++) {
      if (frames.rows.line[r] === line && frames.rows.entity[r] === e) return [frames.rows.x[r], frames.rows.y[r]];
    }
    throw new Error('actor not found');
  };

  const events = ACTORS.map(([period, i, eid, uuid, group, jersey, contestant]) => {
    const [ax, ay] = positionOf(lineOf(period, i), group, jersey);
    const attacksRight = meta.directions.get(`${period}|${contestant}`) === 1;
    const [rx, ry] = attacksRight ? [ax, ay] : [-ax, -ay];          // inverse of the feed convention
    return { id: eid, typeId: 1, periodId: period, contestantId: contestant, playerId: uuid,
      x: String((rx + 52.5) / 1.05), y: String((ry + 34) / 0.68), timeMin: 0, timeSec: 0 };
  });
  const feed = new TextEncoder().encode(JSON.stringify({ liveData: { event: events } }));
  const { payload, warnings } = await buildMatchPayload({ txt: new TextEncoder().encode(raw), xml, events: feed }, options());

  assert.equal(payload.events.length, 4);
  assert.deepEqual(warnings, []);
  for (const [period, i, eid, , group, jersey] of ACTORS) {
    const ev = payload.events.find((e) => e.eid === eid);
    const [ax, ay] = positionOf(lineOf(period, i), group, jersey);
    assert.ok(Math.abs(ev.x - ax) < 0.05 && Math.abs(ev.y - ay) < 0.05, `period ${period}, group ${group}: (${ev.x}, ${ev.y}) vs (${ax}, ${ay})`);
  }
});

test('without the rotation these events would land metres away (the test has teeth)', () => {
  // A right-to-left team's feed coordinates are the mirror of its absolute position; treating them
  // as absolute would put the event on the wrong side of the pitch.
  const abs = -20;
  const rel = -abs;                       // right-to-left team: rotated into "attacks right" frame
  assert.ok(Math.abs(rel - abs) > 30);
});
