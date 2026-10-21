// The JavaScript pipeline must produce the same animation payload as the Python implementation
// (fixtures are regenerated with `python tests/export_golden.py`; synthetic data only).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMatchPayload } from '../lib/pipeline.js';
import { diff } from './compare.mjs';
import { fixture, inputs, options } from './helpers.mjs';

// Python rounds float32 columns in float32 arithmetic, so ties can differ by 0.01 m.
const tolerance = (p) => (/\.entities\[\d+\]\.s\.epts\.[xyz]\[/.test(p) ? 0.0101 : 2e-6);

test('payload matches the Python implementation', async () => {
  const { payload } = await buildMatchPayload(inputs(), options());
  const expected = JSON.parse(fixture('expected_payload.json'));
  assert.deepEqual(diff(JSON.parse(JSON.stringify(payload)), expected, '$', tolerance), []);
});

test('tar.gz and zip bundles give the same payload as separate files', async () => {
  const separate = (await buildMatchPayload(inputs(), options())).payload;
  for (const name of ['bundle.tar.gz', 'bundle.zip']) {
    const { txt, xml, ...rest } = inputs();
    const { payload } = await buildMatchPayload({ ...rest, bundle: new Uint8Array(fixture(name)) }, options());
    assert.deepEqual(payload.frameIds, separate.frameIds, name);
    assert.equal(payload.entities.length, separate.entities.length, name);
  }
});

test('tracking alone loads (events, stats, phases and runs are optional)', async () => {
  const { payload, warnings } = await buildMatchPayload({ txt: inputs().txt, xml: inputs().xml }, options());
  assert.equal(payload.events.length, 0);
  assert.deepEqual(payload.phases, {});
  assert.deepEqual(warnings, []);
});

test('markup in feed strings is neutralised', async () => {
  const { payload } = await buildMatchPayload(inputs(), options());
  assert.ok(!JSON.stringify(payload.lineup).includes('<'));
  assert.ok(!JSON.stringify(payload.phases).includes('<'));
  assert.ok(!JSON.stringify(payload.events).includes('<'));
});

test('events in pre- and post-match periods are ignored', async () => {
  const { payload } = await buildMatchPayload(inputs(), options());
  assert.ok(payload.events.every((e) => e.p === 1 || e.p === 2));
  assert.ok(payload.pressures.every((p) => p.p === 1 || p.p === 2));
});
