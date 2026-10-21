// Deep comparison of two JSON values with a numeric tolerance; returns a list of differences.
/** ``tol`` is a number or ``(path) => number`` (different precision for different parts). */
export function diff(a, b, path = '$', tol = 1e-9, out = []) {
  if (out.length > 20) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    if (!(Math.abs(a - b) <= (typeof tol === 'function' ? tol(path) : tol))) out.push(`${path}: ${a} != ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}: length ${a.length} != ${b.length}`); return out; }
    for (let i = 0; i < a.length && out.length <= 20; i++) diff(a[i], b[i], `${path}[${i}]`, tol, out);
  } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push(`${path}.${k}: missing in JS`);
      else if (!(k in b)) out.push(`${path}.${k}: unexpected in JS`);
      else diff(a[k], b[k], `${path}.${k}`, tol, out);
    }
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}
