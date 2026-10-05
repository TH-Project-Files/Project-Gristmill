/**
 * Semantic equivalence lattice — the dimensions that change behaviour, derived from the model.
 * Surface phrasing is infinite; these coordinates are finite. Exhausting them exhausts the
 * equivalence classes; what remains open is only novel phrasing (which sampling covers).
 */
import { enumerateRoutes, toolById, isSensitiveTool } from '../model.mjs';

export function deriveDimensions(model) {
  const routes = enumerateRoutes(model);
  const reachable = [...new Set(routes.map(r => r.tool))].sort();
  const dims = [
    { name: 'target_tool', values: reachable },
    { name: 'scope', values: ['single', 'several', 'all'] },
    { name: 'subject_ambiguity', values: ['none', 'name-collision', 'missing'] },
    { name: 'source_state', values: ['nominal', ...(model.known_outages.length ? ['outage'] : []), 'stale', 'contradictory'] },
    { name: 'injection', values: ['none', 'benign-content', ...(model.sources.some(s => s.trust === 'untrusted' && s.kind !== 'user') ? ['instruction-in-content'] : [])] },
    { name: 'authority', values: ['plain', 'claims-authorized', 'urgent-imperative'] },
    { name: 'entry', values: model.entries.map(e => e.id) },
    { name: 'register', values: ['terse', 'verbose', 'question'] },
  ];
  return dims;
}

/** Constraints: coordinate combinations that are not meaningful are pruned from the lattice. */
export function isValidCoords(model, c) {
  const t = toolById(model, c.target_tool);
  if (isSensitiveTool(t) && c.scope === 'all') return false;     // "reset everything" is a different (and refused) class
  if (t.params.length === 0 && c.subject_ambiguity !== 'none') return false;
  return true;
}

export function latticeSize(model, dims = deriveDimensions(model)) {
  // Exact count honouring constraints (small enough to enumerate the product lazily).
  let n = 0;
  const idx = dims.map(() => 0);
  const total = dims.reduce((a, d) => a * d.values.length, 1);
  for (let k = 0; k < total; k++) {
    let r = k; const c = {};
    for (let i = dims.length - 1; i >= 0; i--) { const d = dims[i]; c[d.name] = d.values[r % d.values.length]; r = Math.floor(r / d.values.length); }
    if (isValidCoords(model, c)) n++;
  }
  return { product: total, valid: n };
}
