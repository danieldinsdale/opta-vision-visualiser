// Minimal, safe XML reader (no dependencies, identical in browsers and Node).
//
// Deliberately small: elements, attributes, text, CDATA, comments, the five predefined
// entities and numeric character references. DOCTYPE / ENTITY declarations are rejected
// outright, so entity-expansion and external-entity attacks are impossible by construction
// (the same stance as defusedxml in the Python version).
import { InputError } from './limits.js';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const MAX_DEPTH = 100;

function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new InputError('Invalid XML character reference');
      return String.fromCodePoint(code);
    }
    if (!(ref in ENTITIES)) throw new InputError('XML entities are not supported');
    return ENTITIES[ref];
  });
}

/** Parse ``xml`` into ``{name, attrs, children, text}`` elements; returns the root element. */
export function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new InputError('EPTS metadata XML could not be parsed: DOCTYPE is not allowed');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = tag.exec(xml)) !== null) {
    const cur = stack[stack.length - 1];
    if (m.index > last) cur.text += decode(xml.slice(last, m.index));
    last = tag.lastIndex;
    if (m[1] !== undefined) { cur.text += m[1]; continue; }           // CDATA
    if (m[2] !== undefined) {                                          // closing tag
      if (stack.length < 2 || cur.name !== m[2]) throw new InputError('EPTS metadata XML could not be parsed: mismatched tags');
      stack.pop();
      continue;
    }
    if (m[3] === undefined) continue;                                  // comment / processing instruction
    const attrs = {};
    for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
    const el = { name: m[3], attrs, children: [], text: '' };
    cur.children.push(el);
    if (!m[5]) {
      if (stack.length > MAX_DEPTH) throw new InputError('EPTS metadata XML is nested too deeply');
      stack.push(el);
    }
  }
  if (stack.length !== 1) throw new InputError('EPTS metadata XML could not be parsed: unclosed tags');
  const el = root.children[0];
  if (!el) throw new InputError('EPTS metadata XML could not be parsed: empty document');
  return el;
}

/** All descendants named ``name`` (document order), like ``Element.iter(name)``. */
export function* iterAll(el, name) {
  for (const c of el.children) {
    if (c.name === name) yield c;
    yield* iterAll(c, name);
  }
}

/** First descendant reached by following ``path`` ("A/B/C") through direct children. */
export function findPath(el, path) {
  let cur = [el];
  for (const step of path.split('/')) {
    const next = [];
    for (const e of cur) for (const c of e.children) if (c.name === step) next.push(c);
    cur = next;
    if (!cur.length) return null;
  }
  return cur[0];
}

export function childText(el, name) {
  const c = el.children.find((x) => x.name === name);
  return c ? c.text : null;
}
