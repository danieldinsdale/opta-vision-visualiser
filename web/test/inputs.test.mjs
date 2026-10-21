// Hostile or malformed inputs must be rejected with a clear message, never crash or hang.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readEptsBundle } from '../lib/archive.js';
import { parseEptsFrames, parseEptsMetadata } from '../lib/epts.js';
import { loadJson } from '../lib/events.js';
import { parseXml } from '../lib/xml.js';
import { fixture } from './helpers.mjs';

const enc = (s) => new TextEncoder().encode(s);
const meta = () => parseEptsMetadata(new Uint8Array(fixture('spec.xml')));

test('metadata: directions, players and match id are read', () => {
  const m = meta();
  assert.equal(m.players.size, 8);
  assert.equal(m.directions.size, 4);
  assert.equal(m.matchUuid, 'synthmatch0000000000000001');
});

test('xml: DOCTYPE / entity bombs are rejected outright', () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><r>&b;</r>';
  assert.throws(() => parseXml(bomb), /DOCTYPE/);
  assert.throws(() => parseXml('<r>&unknown;</r>'), /entities/);
  assert.throws(() => parseXml('<a><b></a>'), /mismatched/);
  assert.throws(() => parseXml('<a>'), /unclosed/);
  assert.throws(() => parseXml(`${'<a>'.repeat(200)}`), /deeply/);
});

test('xml: predefined entities, CDATA, comments and attributes', () => {
  const r = parseXml("<?xml version='1.0'?><!-- c --><r a='1' b=\"x&amp;y\"><t>a &lt; b <![CDATA[<raw>]]></t><e/></r>");
  assert.deepEqual(r.attrs, { a: '1', b: 'x&y' });
  assert.equal(r.children[0].text, 'a < b <raw>');
  assert.equal(r.children[1].name, 'e');
});

test('metadata: missing directions or players is an error', () => {
  assert.throws(() => parseEptsMetadata(enc('<r><Players/></r>')), /no players/);
  const noDirs = new TextDecoder().decode(fixture('spec.xml')).replace(/<DirectionsOfPlay>[\s\S]*<\/DirectionsOfPlay>/, '');
  assert.throws(() => parseEptsMetadata(enc(noDirs)), /DirectionsOfPlay/);
});

test('frames: empty and mostly-malformed files are rejected', () => {
  assert.throws(() => parseEptsFrames('\n\n', meta()), /empty/);
  assert.throws(() => parseEptsFrames('not:a:valid\nline\n', meta()), /could not be parsed/);
});

test('frames: a few bad lines are tolerated, players outside the metadata are dropped', () => {
  const good = new TextDecoder().decode(fixture('raw.txt')).split('\n').filter(Boolean);
  const lines = [...good, ...Array(2).fill('garbage')];            // 2 / 602 < 1 %
  const f = parseEptsFrames(lines.join('\n'), meta());
  assert.equal(f.nLines, 600);
  const unknown = good[0].replace(/^(\d+:)/, '$1ghost,1,1,1,1;');
  assert.equal(parseEptsFrames(unknown, meta()).entities.length, parseEptsFrames(good[0], meta()).entities.length);
});

test('frames: repeated frames never duplicate an entity', () => {
  const first = new TextDecoder().decode(fixture('raw.txt')).split('\n')[0];
  const f = parseEptsFrames(`${first}\n${first}\n`, meta());
  assert.equal(f.nLines, 1);
  assert.equal(f.rows.line.length, 8);
});

test('bundles: not an archive / missing members are rejected', async () => {
  await assert.rejects(readEptsBundle(enc('definitely not an archive')), /archive|tar|zip/i);
  await assert.rejects(readEptsBundle(new Uint8Array(1024)), /must contain/);
  const { txt, xml } = await readEptsBundle(new Uint8Array(fixture('bundle.zip')));
  assert.equal(new TextDecoder().decode(xml), new TextDecoder().decode(fixture('spec.xml')));
  assert.equal(txt.length, fixture('raw.txt').length);
});

test('json: invalid JSON gives a readable error', () => {
  assert.throws(() => loadJson('{nope', 'Events feed'), /Events feed is not valid JSON/);
  assert.deepEqual(loadJson('{"a":1}', 'x'), { a: 1 });
});
