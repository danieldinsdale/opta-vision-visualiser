import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => readFileSync(join(here, 'fixtures', name));
export const dataFile = (name) => readFileSync(join(here, '..', 'data', name));

export function options() {
  const names = {
    eventTypes: Object.fromEntries(Object.entries(JSON.parse(dataFile('event_type_names.json')).event_types)),
    qualifiers: Object.fromEntries(Object.entries(JSON.parse(dataFile('qualifier_names.json')).qualifiers)),
  };
  const ballImage = 'data:image/svg+xml;base64,' + dataFile('ball.svg').toString('base64');
  return { names, ballImage, vodUrls: {} };
}

export function inputs(extra = {}) {
  return {
    txt: new Uint8Array(fixture('raw.txt')), xml: new Uint8Array(fixture('spec.xml')),
    events: new Uint8Array(fixture('events.json')), matchstats: new Uint8Array(fixture('matchstats.json')),
    phases: new Uint8Array(fixture('phases.json')), runs: new Uint8Array(fixture('runs.json')), ...extra,
  };
}

// ── Synthetic archive builders (no real match data is ever used in tests) ────────────────────────
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

/** entries: [{name, data (Buffer/Uint8Array)}] -> zip bytes (deflate; names ending '/' are folders). */
export function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0) } of entries) {
    const nm = Buffer.from(name), raw = Buffer.from(data), comp = raw.length ? deflateRawSync(raw) : raw;
    const method = raw.length ? 8 : 0, crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** entries: [{name, data}] -> tar.gz bytes. */
export function makeTarGz(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    const raw = Buffer.from(data), h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(raw.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const v of h) sum += v;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, raw, Buffer.alloc((512 - (raw.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

const GAME = 'synthmatch0000000000000001';
/** A package shaped like the ones we send: zip > folder > tar.gz(EPTS) + JSON feeds, plus macOS junk. */
export function samplePackage({ id = GAME, omit = [], extra = [] } = {}) {
  const tar = makeTarGz([
    { name: `${id}_epts_raw_data.txt`, data: fixture('raw.txt') },
    { name: `${id}_epts_format_specification.xml`, data: fixture('spec.xml') },
  ]);
  const dir = `${id}_sample/`;
  const all = [
    { name: dir }, { name: `${dir}${id}-epts-0123456789abcdef.tar.gz`, data: tar },
    { name: `${dir}remoteevents_${id}.json`, data: fixture('events.json') },
    { name: `${dir}matchstats_${id}.json`, data: fixture('matchstats.json') },
    { name: `${dir}remotephasesofplay_${id}.json`, data: fixture('phases.json') },
    { name: `${dir}remoteplayerruns_${id}.json`, data: fixture('runs.json') },
    { name: `__MACOSX/${dir}._remoteevents_${id}.json`, data: Buffer.from('junk') },
    { name: `${dir}.DS_Store`, data: Buffer.from('junk') },
  ];
  return makeZip([...all.filter((e) => !omit.some((o) => e.name.includes(o))), ...extra]);
}
