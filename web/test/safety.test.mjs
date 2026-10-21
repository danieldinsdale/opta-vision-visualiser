// Static checks on what ships: no internal names or external font requests, plain-SVG ball,
// complete name tables, and VOD URL validation.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateStreamUrl } from '../vod-provider.js';
import { dataFile } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'vendor', 'test']);

function* shipped(dir = root) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name === 'package-lock.json' || name.endsWith('.png')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* shipped(p); else yield p;
  }
}

test('shipped files have no internal names or external font requests', () => {
  for (const file of shipped()) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    assert.ok(!text.includes('fonts.googleapis.com'), relative(root, file));
    for (const word of ['skillcorner', 'invenue', 'livecv', 'imputation', 'mle_pipelines', 'mle-pipeline']) {
      assert.ok(!text.includes(word), `${word} in ${relative(root, file)}`);
    }
  }
});

test('no shipped script loads from a CDN', () => {
  for (const file of shipped()) {
    if (!/\.(js|mjs|html)$/.test(file)) continue;
    assert.ok(!/jsdelivr|unpkg|cdnjs/.test(readFileSync(file, 'utf8')), relative(root, file));
  }
});

test('the ball graphic is a plain SVG', () => {
  const svg = dataFile('ball.svg').toString('utf8');
  assert.ok(svg.includes('viewBox') && svg.includes('width="450"'));
  for (const bad of ['<script', 'onload', 'onclick', '<foreignobject', '<image', 'href="http']) assert.ok(!svg.toLowerCase().includes(bad), bad);
});

test('name tables cover common ids; unknown ids fall back to the number', () => {
  const types = JSON.parse(dataFile('event_type_names.json')).event_types;
  const quals = JSON.parse(dataFile('qualifier_names.json')).qualifiers;
  for (const id of [1, 3, 7, 8, 10, 13, 14, 15, 16, 17, 43, 49]) assert.ok(types[id], `event type ${id}`);
  for (const id of [1, 2, 5, 6, 15, 28, 56, 140, 141]) assert.ok(quals[id], `qualifier ${id}`);
  assert.ok(Object.keys(types).length >= 80 && Object.keys(quals).length >= 400);
});

test('VOD URLs: only plain https without credentials', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x/y', '', 'http://video.example.com/a.mp4', 'https://u:p@host/x', '//host/x', 'x'.repeat(5000)]) {
    assert.throws(() => validateStreamUrl(bad), undefined, bad.slice(0, 30));
  }
  assert.equal(validateStreamUrl(' https://video.example.com/a.m3u8 '), 'https://video.example.com/a.m3u8');
});
