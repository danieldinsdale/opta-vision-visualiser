// Data packages: files are found by name, also inside a zip that holds a tar.gz, and problems are explained.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyName, scanFiles, summarise } from '../lib/package.js';
import { buildMatchPayload } from '../lib/pipeline.js';
import { fixture, makeTarGz, makeZip, options, samplePackage } from './helpers.mjs';

const enc = (s) => new TextEncoder().encode(s);
const scan = (bytes, name = 'package.zip') => scanFiles([{ name, bytes }]).then(summarise);

test('names: every feed is recognised, case-insensitively, with or without a game id', () => {
  const id = 'synthmatch0000000000000001';
  assert.deepEqual(classifyName(`remoteevents_${id}.json`), { role: 'events', gameId: id });
  assert.deepEqual(classifyName(`MatchStats_${id}.JSON`), { role: 'matchstats', gameId: id });
  assert.deepEqual(classifyName(`remotephasesofplay_${id}.json`), { role: 'phases', gameId: id });
  assert.deepEqual(classifyName(`remoteplayerruns_${id}.json`), { role: 'runs', gameId: id });
  assert.deepEqual(classifyName('events.json'), { role: 'events', gameId: '' });
  assert.deepEqual(classifyName(`phases_${id}.json`), { role: 'phases', gameId: id });     // older name still works
  assert.deepEqual(classifyName(`${id}_epts_raw_data.txt`), { role: 'txt', gameId: id });
  assert.equal(classifyName(`${id}-epts-abc.tar.gz`).role, 'archive');
  for (const junk of ['__MACOSX/x/._remoteevents_a.json', '._remoteevents.json', '.DS_Store', 'readme.pdf', 'notes.txt']) assert.equal(classifyName(junk), null, junk);
});

test('a package (zip > folder > tar.gz + feeds, with macOS junk) is read in full', async () => {
  const s = await scan(samplePackage());
  assert.equal(s.ready, true);
  assert.deepEqual(s.items.map((i) => [i.key, i.state]), [['epts', 'found'], ['events', 'found'], ['matchstats', 'found'], ['phases', 'found'], ['runs', 'found']]);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.notes, []);
  const { payload } = await buildMatchPayload(s.inputs, options());     // and it really loads
  assert.ok(payload.events.length > 0 && payload.frameIds.length > 0);
});

test('a package with only tracking data loads and says what is missing', async () => {
  const s = await scan(samplePackage({ omit: ['remotephasesofplay', 'remoteplayerruns'] }));
  assert.equal(s.ready, true);
  assert.deepEqual(s.items.map((i) => i.state), ['found', 'found', 'found', 'absent', 'absent']);
  assert.match(s.notes.join(' '), /phases of play, player runs not included/);
});

test('no tracking data: a clear error naming what was expected', async () => {
  const s = await scan(samplePackage({ omit: ['.tar.gz'] }));
  assert.equal(s.ready, false);
  assert.match(s.errors[0], /No EPTS tracking found.*_epts_raw_data\.txt.*_epts_format_specification\.xml/);
  assert.equal(s.items[0].state, 'missing');
});

test('a feed for a different match is flagged and not used', async () => {
  const s = await scan(samplePackage({ omit: ['matchstats'], extra: [{ name: 'x/matchstats_othermatch0000000000002.json', data: fixture('matchstats.json') }] }));
  assert.equal(s.ready, true);
  const stats = s.items.find((i) => i.key === 'matchstats');
  assert.equal(stats.state, 'mismatch');
  assert.equal(s.inputs.matchstats, undefined);
  assert.match(s.notes.join(' '), /different match/);
});

test('loose files and a bare tar.gz work the same way', async () => {
  const files = [
    { name: 'a_epts_raw_data.txt', bytes: new Uint8Array(fixture('raw.txt')) },
    { name: 'a_epts_format_specification.xml', bytes: new Uint8Array(fixture('spec.xml')) },
    { name: 'remoteevents.json', bytes: new Uint8Array(fixture('events.json')) },
  ];
  const s = summarise(await scanFiles(files));
  assert.equal(s.ready, true);
  assert.equal(s.items.find((i) => i.key === 'events').state, 'found');
  const tar = makeTarGz([{ name: 'm_epts_raw_data.txt', data: fixture('raw.txt') }, { name: 'm_epts_format_specification.xml', data: fixture('spec.xml') }]);
  assert.equal((await scan(tar, 'bundle.tar.gz')).ready, true);
});

test('duplicates: the first file wins and the user is told', async () => {
  const dup = { name: 'again/remoteevents_x.json', data: fixture('events.json') };
  const s = await scan(samplePackage({ extra: [dup] }));
  assert.match(s.notes.join(' '), /More than one file/);
});

test('safety: nesting beyond two levels, junk archives and non-archives are rejected cleanly', async () => {
  const inner = makeZip([{ name: 'remoteevents.json', data: enc('{}') }]);
  let deep = inner;
  for (let i = 0; i < 3; i++) deep = makeZip([{ name: `l${i}.zip`, data: deep }]);
  await assert.rejects(scan(deep), /nested too deeply/);
  await assert.rejects(scan(enc('PK not really a zip'), 'broken.zip'), /not a valid/);
  const s = await scan(enc('hello'), 'notes.txt');
  assert.equal(s.ready, false);
  const many = makeZip(Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.txt`, data: enc('x') })));
  await assert.rejects(scan(many), /too many files/);
});
