// Small numeric helpers shared by the loaders (match the Python/numpy behaviour exactly).

/** Round half to even (numpy ``round`` / Python ``round`` on ties), to a whole number. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** ``round(x, digits)`` as numpy does it (scale, round half even, unscale). */
export function roundTo(x, digits) {
  const m = 10 ** digits;
  return roundHalfEven(x * m) / m;
}

/**
 * Python's built-in ``round(x, digits)``: rounds the exact binary value of ``x`` (so 2.675 -> 2.67)
 * and breaks exact ties to even. Differs from the scale-and-round numpy form in rare ties.
 */
export function pyRound(x, digits) {
  if (!Number.isFinite(x)) return x;
  const s = x.toFixed(Math.min(100, digits + 30));          // exact decimal expansion
  const dot = s.indexOf('.');
  const tail = s.slice(dot + 1 + digits);
  if (!/^50*$/.test(tail)) return Number(x.toFixed(digits)); // not an exact tie: nearest wins
  const lower = Number(s.slice(0, dot + 1 + digits));        // exact tie: pick the even neighbour
  const m = 10 ** digits;
  return Math.round(Math.abs(lower) * m) % 2 === 0 ? lower : lower + Math.sign(x) / m;
}

/** Median of a numeric array (mean of the middle pair when even), like ``numpy.median``. */
export function median(values) {
  const a = Float64Array.from(values).sort();
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Growable typed array (amortised O(1) push) so big tracking files stay compact in memory. */
export class Grow {
  constructor(Type, capacity = 1 << 16) { this.Type = Type; this.a = new Type(capacity); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get view() { return this.a.subarray(0, this.n); }
}
