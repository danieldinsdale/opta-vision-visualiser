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
