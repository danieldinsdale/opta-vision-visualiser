// Read the two EPTS files out of a .tar.gz / .tar / .zip bundle, entirely in memory.
// Nothing is written to disk, so path-traversal entries in a hostile archive have no effect;
// members are matched by suffix and size-capped. Uses the built-in DecompressionStream.
import { InputError, MAX_ARCHIVE_MEMBER_BYTES } from './limits.js';

export const EPTS_XML_SUFFIX = '_epts_format_specification.xml';
export const EPTS_TXT_SUFFIX = '_epts_raw_data.txt';

const concat = (chunks, total) => {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

async function inflate(bytes, format, cap, what) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel(); throw new InputError(`Archive member ${what} exceeds the size limit`); }
    chunks.push(value);
  }
  return concat(chunks, total);
}

const ascii = (b, s, e) => {
  let out = '';
  for (let i = s; i < e && b[i] !== 0; i++) out += String.fromCharCode(b[i]);
  return out;
};

function tarSize(b, off) {
  if (b[off] & 0x80) {                       // base-256 size (files > 8 GB)
    let n = 0;
    for (let i = off + 1; i < off + 12; i++) n = n * 256 + b[i];
    return n;
  }
  return parseInt(ascii(b, off, off + 12).trim() || '0', 8);
}

function readTar(b) {
  const found = {};
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= b.length) {
    if (b.subarray(off, off + 512).every((v) => v === 0)) break;
    const size = tarSize(b, off + 124);
    const type = String.fromCharCode(b[off + 156] || 48);
    if (!Number.isFinite(size) || size < 0) throw new InputError('File is not a valid tar/tar.gz/zip archive');
    const dataStart = off + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataStart + size > b.length) throw new InputError('File is not a valid tar/tar.gz/zip archive');
    if (type === 'L') longName = ascii(b, dataStart, dataStart + size);
    else if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(b.subarray(dataStart, dataStart + size)));
      paxPath = m ? m[1] : null;
    } else if (type === '0' || type === '\0' || type === '7') {
      let name = paxPath ?? longName ?? (ascii(b, off + 345, off + 500) ? `${ascii(b, off + 345, off + 500)}/` : '') + ascii(b, off, off + 100);
      longName = paxPath = null;
      for (const [key, suffix] of [['txt', EPTS_TXT_SUFFIX], ['xml', EPTS_XML_SUFFIX]]) {
        if (name.endsWith(suffix) && !found[key]) {
          if (size > MAX_ARCHIVE_MEMBER_BYTES) throw new InputError(`Archive member '${name}' exceeds the size limit`);
          found[key] = b.slice(dataStart, dataStart + size);
        }
      }
    }
    off = next;
  }
  return found;
}

async function readZip(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new InputError('File is not a valid tar/tar.gz/zip archive');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new InputError('Zip64 archives are not supported');
  const found = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new InputError('File is not a valid tar/tar.gz/zip archive');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    for (const [key, suffix] of [['txt', EPTS_TXT_SUFFIX], ['xml', EPTS_XML_SUFFIX]]) {
      if (!name.endsWith(suffix) || found[key]) continue;
      if (usize > MAX_ARCHIVE_MEMBER_BYTES) throw new InputError(`Archive member '${name}' exceeds the size limit`);
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = b.subarray(start, start + csize);
      if (method === 0) found[key] = raw.slice();
      else if (method === 8) found[key] = await inflate(raw, 'deflate-raw', MAX_ARCHIVE_MEMBER_BYTES, `'${name}'`);
      else throw new InputError('Unsupported zip compression method');
    }
  }
  return found;
}

/** Returns ``{txt, xml}`` (Uint8Arrays) from a tar / tar.gz / zip bundle. */
export async function readEptsBundle(bytes) {
  let found;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) found = await readZip(bytes);
  else {
    const tarBytes = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? await inflate(bytes, 'gzip', MAX_ARCHIVE_MEMBER_BYTES * 2, 'archive').catch((e) => {
        if (e instanceof InputError) throw e;
        throw new InputError('File is not a valid tar/tar.gz/zip archive');
      })
      : bytes;
    found = readTar(tarBytes);
  }
  if (!found.txt || !found.xml) {
    throw new InputError(`Archive must contain a '*${EPTS_TXT_SUFFIX}' and a '*${EPTS_XML_SUFFIX}' file`);
  }
  return found;
}
