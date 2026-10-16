/**
 * Radius of validity — how far does one observation's verdict generalize?
 *
 * For every observed cell, look at observed neighbours at lattice distance 1 (one coordinate
 * differs; for ordered axes, +/-1 level) and distance 2. The cell's radius is the largest distance
 * at which >= 90% of neighbours share its majority verdict. Aggregated per tool, a near-zero radius
 * around a sensitive action is the geometric signature of "testing cannot cover this; code must".
 */
import { indexByCell } from './observations.mjs';
import { isSensitiveTool, toolById } from '../model.mjs';

export function cellDistance(dims, a, b) {
  let d = 0;
  for (const dim of dims) {
    if (a[dim.name] === b[dim.name]) continue;
    if (dim.ordered) { const ia = dim.values.indexOf(a[dim.name]), ib = dim.values.indexOf(b[dim.name]); d += Math.abs(ia - ib); }
    else d += 1;
    if (d > 2) return d;
  }
  return d;
}

export function computeRadius(model, dims, observations, { agreement = 0.9, minNeighbours = 1 } = {}) {
  const idx = indexByCell(observations);
  const cells = [...idx.values()].map(e => ({ ...e, verdict: e.p_fail >= 0.5 ? 'fail' : 'pass' }));
  const out = [];
  for (const c of cells) {
    const d1 = [], d2 = [];
    for (const o of cells) { if (o === c || o.coords.target_tool !== c.coords.target_tool) continue; const d = cellDistance(dims, c.coords, o.coords); if (d === 1) d1.push(o); else if (d === 2) d2.push(o); }
    const agree = xs => xs.length ? xs.filter(o => o.verdict === c.verdict).length / xs.length : null;
    const a1 = agree(d1), a2 = agree(d2);
    let radius = null;
    if (d1.length >= minNeighbours) { radius = a1 >= agreement ? 1 : 0; if (radius === 1 && d2.length >= minNeighbours && a2 >= agreement) radius = 2; }
    out.push({ key: c.key, coords: c.coords, tool: c.coords.target_tool, verdict: c.verdict, n: c.n, p_fail: +c.p_fail.toFixed(3), neighbours_d1: d1.length, agree_d1: a1 == null ? null : +a1.toFixed(2), neighbours_d2: d2.length, agree_d2: a2 == null ? null : +a2.toFixed(2), radius });
  }
  const byTool = {};
  for (const tool of new Set(out.map(c => c.tool))) {
    const mine = out.filter(c => c.tool === tool), known = mine.filter(c => c.radius != null);
    const t = toolById(model, tool);
    byTool[tool] = { sensitive: !!(t && isSensitiveTool(t)), cells: mine.length, known: known.length, mean_radius: known.length ? +(known.reduce((a, c) => a + c.radius, 0) / known.length).toFixed(2) : null, zero_fraction: known.length ? +(known.filter(c => c.radius === 0).length / known.length).toFixed(2) : null };
    byTool[tool].testing_futile = byTool[tool].sensitive && known.length >= 3 && byTool[tool].zero_fraction >= 0.5;
  }
  return { cells: out, by_tool: byTool };
}
