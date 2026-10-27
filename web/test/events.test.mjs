import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteEvents } from '../lib/events.js';

const names = { eventTypes: { 70: 'injury_time_announcement', 1: 'pass' }, qualifiers: { 277: 'MINUTES', 1: 'LONG_BALL' } };
const feed = { liveData: { event: [
  { id: 1, typeId: 70, periodId: 2, timeMin: 90, timeSec: 0, qualifier: [{ qualifierId: 277, value: '4' }] },
  { id: 2, typeId: 1, periodId: 1, timeMin: 3, timeSec: 5, qualifier: [{ qualifierId: 1, value: 'x' }] },
] } };

test('added minutes are kept from qualifier 277 only', () => {
  const [announce, pass] = parseRemoteEvents(feed, names);
  assert.equal(announce.event_type_desc, 'injury_time_announcement');
  assert.deepEqual(announce.qualifiers, [{ id: 277, name: 'MINUTES', value: '4' }]);
  assert.deepEqual(pass.qualifiers, [{ id: 1, name: 'LONG_BALL' }]);   // other qualifiers keep the old shape
});
