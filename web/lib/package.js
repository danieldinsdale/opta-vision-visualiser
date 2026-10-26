// Finds the match files inside whatever the user supplies: a data package (.zip, optionally containing a
// .tar.gz of the EPTS data), a bare tar / tar.gz, or loose files. Files are recognised by name, so users
// do not have to say which file is which. Everything stays in memory; nothing is written to disk, so
// path-traversal entries in a hostile archive have no effect. Depth, file-count and size limits apply.
import { EPTS_TXT_SUFFIX, EPTS_XML_SUFFIX, listArchive, looksLikeArchive } from './archive.js';
import { InputError, MAX_ARCHIVE_DEPTH, MAX_PACKAGE_BYTES } from './limits.js';

/** The files a match can have, in display order. ``required`` ones must be present to load. */
export const ROLES = [
  { key: 'epts', label: 'EPTS tracking', required: true },
  { key: 'events', label: 'Events', prefix: 'remoteevents', names: ['remoteevents', 'events'] },
  { key: 'matchstats', label: 'Match stats', prefix: 'matchstats', names: ['matchstats'] },
  { key: 'phases', label: 'Phases of play', prefix: 'remotephasesofplay', names: ['remotephasesofplay', 'phasesofplay', 'phases'] },
  { key: 'runs', label: 'Player runs', prefix: 'remoteplayerruns', names: ['remoteplayerruns', 'playerruns', 'runs'] },
];

const GAME_ID = /^[A-Za-z0-9]{10,40}$/;
const baseName = (name) => name.replace(/\\/g, '/').split('/').pop();
const isJunk = (name) => {
  const n = name.replace(/\\/g, '/');
  return n.split('/').some((p) => p === '__MACOSX' || p.startsWith('._') || p === '.DS_Store' || p === 'Thumbs.db');
};

/**
 * What is this file? Returns {role, gameId} where role is 'txt', 'xml', 'events', 'matchstats', 'phases',
 * 'runs' or 'archive', or null when it is not something we use. ``gameId`` is '' when the name carries none.
 */
export function classifyName(name) {
  if (isJunk(name)) return null;
  const base = baseName(name);
  const lower = base.toLowerCase();
  if (lower.endsWith(EPTS_TXT_SUFFIX)) return { role: 'txt', gameId: idBefore(base, EPTS_TXT_SUFFIX) };
  if (lower.endsWith(EPTS_XML_SUFFIX)) return { role: 'xml', gameId: idBefore(base, EPTS_XML_SUFFIX) };
  if (/\.(zip|tar|tgz|tar\.gz)$/.test(lower)) return { role: 'archive', gameId: '' };
  if (lower.endsWith('.json')) {
    const stem = base.slice(0, -5);
    for (const r of ROLES) {
      for (const n of r.names || []) {
        if (stem.toLowerCase() === n) return { role: r.key, gameId: '' };
        if (stem.toLowerCase().startsWith(`${n}_`) || stem.toLowerCase().startsWith(`${n}-`)) {
          const id = stem.slice(n.length + 1);
          return { role: r.key, gameId: GAME_ID.test(id) ? id : '' };
        }
      }
    }
  }
  return null;
}

function idBefore(base, suffix) {
  const id = base.slice(0, base.length - suffix.length);
  return GAME_ID.test(id) ? id : '';
}

/**
 * Looks through ``files`` ([{name, bytes}]) and any archives inside them and returns what it found:
 *   found:  {txt, xml, events, matchstats, phases, runs} -> {name, bytes, gameId}
 *   extras: names of recognised files that were ignored (duplicates)
 *   skipped: number of other files that were not used
 */
export async function scanFiles(files) {
  const found = {}, extras = [];
  let skipped = 0, unpacked = 0;

  async function visit(name, bytes, depth) {
    const c = classifyName(name);
    const archive = c ? c.role === 'archive' : (!isJunk(name) && looksLikeArchive(bytes) && !/\.(json|txt|xml)$/i.test(name));
    if (archive) {
      if (depth >= MAX_ARCHIVE_DEPTH) throw new InputError('This package has archives nested too deeply');
      for (const entry of await listArchive(bytes)) {
        if (isJunk(entry.name)) continue;
        const ec = classifyName(entry.name);
        if (!ec) { skipped++; continue; }                         // never unpack what we would not use
        unpacked += entry.size;
        if (unpacked > MAX_PACKAGE_BYTES) throw new InputError('This package is larger than expected when unpacked');
        await visit(`${name}/${entry.name}`, await entry.read(), depth + 1);
      }
      return;
    }
    if (!c) { if (!isJunk(name)) skipped++; return; }
    if (found[c.role]) { extras.push(baseName(name)); return; }
    found[c.role] = { name: baseName(name), bytes, gameId: c.gameId };
  }

  for (const f of files) await visit(f.name, f.bytes, 0);
  return { found, extras, skipped };
}

/**
 * Turns a scan into what the sidebar shows and what gets loaded.
 * Files whose game id differs from the tracking data's are listed as 'other match' and left out.
 * Returns {items: [{key, label, state, name, note}], inputs, ready, errors, notes}.
 */
export function summarise({ found, extras, skipped }) {
  const errors = [], notes = [];
  const have = (k) => found[k];
  const eptsId = (have('txt') && have('txt').gameId) || (have('xml') && have('xml').gameId) || '';
  const items = [];

  // EPTS needs both files; say precisely what is missing
  const eptsOk = have('txt') && have('xml');
  if (eptsOk && have('txt').gameId && have('xml').gameId && have('txt').gameId !== have('xml').gameId) {
    items.push({ key: 'epts', label: 'EPTS tracking', state: 'mismatch', name: have('txt').name, note: 'raw data and spec are for different matches' });
    errors.push('The tracking data and its format specification are for different matches.');
  } else if (eptsOk) items.push({ key: 'epts', label: 'EPTS tracking', state: 'found', name: have('txt').name, note: 'required' });
  else {
    const missing = [!have('txt') && `a file ending ${EPTS_TXT_SUFFIX}`, !have('xml') && `a file ending ${EPTS_XML_SUFFIX}`].filter(Boolean).join(' and ');
    items.push({ key: 'epts', label: 'EPTS tracking', state: 'missing', name: '', note: 'required' });
    errors.push(`No EPTS tracking found. Expected ${missing}.`);
  }

  const inputs = {};
  if (eptsOk && !errors.length) { inputs.txt = found.txt.bytes; inputs.xml = found.xml.bytes; }

  for (const r of ROLES.slice(1)) {
    const f = have(r.key);
    if (!f) { items.push({ key: r.key, label: r.label, state: 'absent', name: '', note: 'not included' }); continue; }
    if (eptsId && f.gameId && f.gameId !== eptsId) {
      items.push({ key: r.key, label: r.label, state: 'mismatch', name: f.name, note: 'other match' });
      notes.push(`${f.name} is for a different match than the tracking data. It was not used. Remove it or pick the matching file.`);
      continue;
    }
    items.push({ key: r.key, label: r.label, state: 'found', name: f.name, note: r.prefix });
    inputs[r.key] = f.bytes;
  }
  if (extras.length) notes.push(`More than one file for the same item was found. Only the first was used (ignored: ${extras.join(', ')}).`);

  const absent = items.filter((i) => i.state === 'absent').map((i) => i.label.toLowerCase());
  if (absent.length && eptsOk && !errors.length) notes.push(`${absent.join(', ')} not included. Those overlays will be unavailable.`);
  return { items, inputs, ready: !errors.length && !!inputs.txt, errors, notes, skipped };
}
