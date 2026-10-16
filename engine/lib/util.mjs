/**
 * Deterministic primitives shared by every V2 module.
 * No Date.now(), no Math.random(): same inputs ⇒ byte-identical artifacts.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function hashHex(s) { return hashStr(s).toString(16).padStart(8, '0'); }

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

/** Wilson 95% interval for k successes in n trials. Returns {lo, hi, p}. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: clamp(centre - half, 0, 1), hi: clamp(centre + half, 0, 1) };
}

/** Stable JSON: keys sorted recursively so artifacts diff cleanly. */
export function stableStringify(v, indent = 2) {
  return JSON.stringify(sortKeys(v), null, indent);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (typeof v[k] === 'function') continue;
      o[k] = sortKeys(v[k]);
    }
    return o;
  }
  return v;
}

/** Fixed clock. The operator supplies `--now`; otherwise a constant so output is reproducible. */
export const DEFAULT_NOW = '2026-01-01T00:00:00.000Z';

/** Rough token estimate (chars/4) — good enough to rank prompt mass, not to bill. */
export function estTokens(s) { return Math.ceil((s || '').length / 4); }

export function uniq(xs) { return [...new Set(xs)]; }

export function groupBy(xs, keyFn) {
  const m = new Map();
  for (const x of xs) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

/** Cartesian product of arrays of values. */
export function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap(prefix => list.map(v => [...prefix, v])), [[]]);
}
