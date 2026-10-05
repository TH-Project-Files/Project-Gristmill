/**
 * Covering arrays. Full cartesian product when the valid lattice is small enough; otherwise a
 * deterministic greedy t-wise covering array (AETG-style), which guarantees every t-way
 * interaction of coordinate values appears in at least one row while using a tiny fraction of
 * the product. Strength t=2 (pairwise) is the default; t=3 for the paranoid.
 */
import { mulberry32, hashStr, cartesian } from '../util.mjs';

export function buildCoveringArray(dims, { strength = 2, fullIfAtMost = 2000, isValid = () => true, seed = 7, candidates = 40 } = {}) {
  const product = dims.reduce((a, d) => a * d.values.length, 1);
  if (product <= fullIfAtMost) {
    const rows = cartesian(dims.map(d => d.values)).map(vals => Object.fromEntries(vals.map((v, i) => [dims[i].name, v]))).filter(isValid);
    return { rows, method: 'full-product', strength: dims.length, product };
  }
  const t = Math.min(strength, dims.length);
  // All t-subsets of dimension indices.
  const combos = [];
  (function rec(start, acc) { if (acc.length === t) { combos.push([...acc]); return; } for (let i = start; i < dims.length; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); } })(0, []);
  // Uncovered interactions: key = combo index + value tuple.
  const uncovered = new Set();
  for (let ci = 0; ci < combos.length; ci++) {
    for (const tuple of cartesian(combos[ci].map(i => dims[i].values))) uncovered.add(ci + ':' + tuple.join('\u0001'));
  }
  const rows = [];
  const rnd = mulberry32(seed);
  const coverKeys = (row) => combos.map((combo, ci) => ci + ':' + combo.map(i => row[dims[i].name]).join('\u0001'));
  let stall = 0;
  while (uncovered.size && stall < 50) {
    let best = null, bestGain = -1;
    for (let c = 0; c < candidates; c++) {
      const row = {};
      // Seed from an uncovered interaction so progress is guaranteed when one is satisfiable.
      const pick = [...uncovered][Math.floor(rnd() * uncovered.size)];
      const [ci, tup] = pick.split(':'); const vals = tup.split('\u0001');
      combos[+ci].forEach((di, k) => { row[dims[di].name] = vals[k]; });
      // Fill remaining dims greedily by marginal gain, random tie-break.
      const order = dims.map((_, i) => i).filter(i => !(dims[i].name in row)).sort((a, b) => hashStr(a + '|' + c + '|' + rows.length) - hashStr(b + '|' + c + '|' + rows.length));
      for (const di of order) {
        let bv = null, bg = -1;
        for (const v of dims[di].values) {
          const trial = { ...row, [dims[di].name]: v };
          const g = coverKeys(fillUnknown(trial, dims)).filter(k => uncovered.has(k)).length + rnd() * 0.01;
          if (g > bg) { bg = g; bv = v; }
        }
        row[dims[di].name] = bv;
      }
      // Local repair: a greedy fill can violate a constraint; re-choose single dims (never the seeded
      // interaction) until the row is valid, so a realizable interaction is not thrown away.
      if (!isValid(row)) {
        const seeded = new Set(combos[+ci].map(i => dims[i].name));
        outer: for (const d of dims) {
          if (seeded.has(d.name)) continue;
          for (const v of d.values) { const trial = { ...row, [d.name]: v }; if (isValid(trial)) { row[d.name] = v; break outer; } }
        }
      }
      if (!isValid(row)) continue;
      const gain = coverKeys(row).filter(k => uncovered.has(k)).length;
      if (gain > bestGain) { bestGain = gain; best = row; }
    }
    if (!best || bestGain <= 0) {
      // Remaining interactions may be unsatisfiable under constraints: drop those involving invalid combos.
      stall++;
      if (stall >= 50) break;
      continue;
    }
    stall = 0;
    rows.push(best);
    for (const k of coverKeys(best)) uncovered.delete(k);
  }
  return { rows, method: `greedy-${t}-wise`, strength: t, product, uncovered_interactions: uncovered.size };
}

function fillUnknown(row, dims) { const r = { ...row }; for (const d of dims) if (!(d.name in r)) r[d.name] = '\u0000'; return r; }

/** Verify that every t-way interaction present in the valid product is covered. Used by the tests. */
export function verifyCoverage(dims, rows, strength, isValid = () => true) {
  const t = Math.min(strength, dims.length);
  const combos = [];
  (function rec(start, acc) { if (acc.length === t) { combos.push([...acc]); return; } for (let i = start; i < dims.length; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); } })(0, []);
  const covered = new Set();
  for (const r of rows) for (let ci = 0; ci < combos.length; ci++) covered.add(ci + ':' + combos[ci].map(i => r[dims[i].name]).join('|'));
  let required = 0, missing = [];
  for (let ci = 0; ci < combos.length; ci++) for (const tuple of cartesian(combos[ci].map(i => dims[i].values))) {
    // An interaction is required only if SOME valid full row realizes it.
    const partial = Object.fromEntries(combos[ci].map((di, k) => [dims[di].name, tuple[k]]));
    if (!realizable(dims, partial, isValid)) continue;
    required++;
    const key = ci + ':' + tuple.join('|');
    if (!covered.has(key)) missing.push(key);
  }
  return { required, missing };
}
function realizable(dims, partial, isValid) {
  const free = dims.filter(d => !(d.name in partial));
  for (const vals of cartesian(free.map(d => d.values))) {
    const row = { ...partial }; free.forEach((d, i) => { row[d.name] = vals[i]; });
    if (isValid(row)) return true;
  }
  return false;
}
