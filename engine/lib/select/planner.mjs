/**
 * Open-world selection planner — the statistical bridge from free deterministic layers to the
 * (expensive) semantic runs.
 *
 *  score(cell) = severity_weight × uncertainty × (1 + disagreement)
 *    uncertainty  = p(1-p) + 0.25·(1-confidence)      // peaks where the simulator is unsure
 *    disagreement = 1 when structural findings touch the cell but the simulator predicts safe
 *                   (or vice versa) — the two deterministic layers contradict each other
 *
 *  Budget B runs is allocated across strata (target_tool) by Neyman allocation
 *    n_h ∝ N_h · σ_h,  σ_h = sqrt(mean p(1-p) in stratum)
 *  then the top-scoring cells inside each stratum are chosen. The emitted plan also carries the
 *  sequential rule the operator (or the LLM controller) follows:
 *    pass on a confident prior → close the cell; neighbours' priors shrink (smoothness, stated)
 *    fail → escalate to K repeats → rate with Wilson CI (the only place "significant" is earned)
 *    stop a stratum when its Wilson width < target or budget exhausted
 */
import { groupBy, wilson, estTokens } from '../util.mjs';
import { promptMass } from '../model.mjs';
import { deriveDimensions, isValidCoords } from '../lattice/dimensions.mjs';
import { instantiate } from '../lattice/instantiate.mjs';
import { simulateCell } from '../simulate/policy.mjs';

export function planOpenWorld(model, cells, findings, { budget_runs = 40, repeats_on_fail = 5, ci_width_target = 0.3, per_run_overhead_tokens = 1500, holdout_fraction = 0.1 } = {}) {
  const touched = new Map();
  for (const f of findings) for (const c of f.cells || []) touched.set(c, (touched.get(c) || 0) + f.severity);
  const scored = cells.map(cell => {
    const p = cell.prior.p_fail, conf = cell.prior.confidence;
    const uncertainty = p * (1 - p) + 0.25 * (1 - conf);
    const structural = touched.get(cell.cell_id) || 0;
    const disagreement = (structural > 0 && p < 0.3) || (structural === 0 && p > 0.7) ? 1 : 0;
    const score = cell.severity_weight * uncertainty * (1 + disagreement);
    return { cell_id: cell.cell_id, stratum: cell.coords.target_tool, coords: cell.coords, p_fail: p, confidence: conf, structural_weight: structural, disagreement, score: +score.toFixed(4), prompt: cell.prompt, injected_context: cell.injected_context };
  });
  // Neyman allocation
  const strata = groupBy(scored, s => s.stratum);
  const sig = new Map();
  let denom = 0;
  for (const [h, xs] of strata) { const s = Math.sqrt(xs.reduce((a, x) => a + x.p_fail * (1 - x.p_fail), 0) / xs.length) || 0.05; sig.set(h, s); denom += xs.length * s; }
  // Strata ranked by importance: the riskiest cell they hold, then Neyman weight, then name.
  const maxScore = h => Math.max(...strata.get(h).map(x => x.score));
  const order = [...strata.keys()].sort((a, b) => maxScore(b) - maxScore(a) || (strata.get(b).length * sig.get(b)) - (strata.get(a).length * sig.get(a)) || a.localeCompare(b));
  // The one-run floor can only be honoured for as many strata as the budget can pay for. With more
  // strata than runs (e.g. 211 tools, 20 runs), the most important strata are funded first and the
  // rest are reported as unfunded — never silently looped over.
  const funded = new Set(order.slice(0, Math.min(budget_runs, order.length)));
  const alloc = new Map();
  let assigned = 0;
  for (const [h, xs] of strata) { const n = funded.has(h) ? Math.max(1, Math.round(budget_runs * (xs.length * sig.get(h)) / denom)) : 0; alloc.set(h, Math.min(n, xs.length)); assigned += alloc.get(h); }
  // Trim/extend to the budget deterministically. Each pass must make progress or it stops.
  while (assigned > budget_runs) { let shrank = false; for (const h of [...order].reverse()) { if (assigned <= budget_runs) break; if (alloc.get(h) > 1) { alloc.set(h, alloc.get(h) - 1); assigned--; shrank = true; } } if (!shrank) break; }
  while (assigned < budget_runs) { let grew = false; for (const h of order) { if (assigned >= budget_runs) break; if (alloc.get(h) < strata.get(h).length) { alloc.set(h, alloc.get(h) + 1); assigned++; grew = true; } } if (!grew) break; }
  const unfunded = order.filter(h => alloc.get(h) === 0);
  const selected = [];
  for (const [h, xs] of strata) { xs.sort((a, b) => b.score - a.score || a.cell_id.localeCompare(b.cell_id)); selected.push(...xs.slice(0, alloc.get(h)).map(x => ({ ...x, stratum_n: xs.length, stratum_alloc: alloc.get(h) }))); }
  selected.sort((a, b) => b.score - a.score || a.cell_id.localeCompare(b.cell_id));
  selected.forEach((s, i) => { s.order = i + 1; });

  // Smoothness holdout: the sequential rule lowers neighbours' priors when a cell passes. That is an
  // ASSUMPTION (behaviour varies smoothly across one coordinate change). Reserve a deterministic 10%
  // of the cells the rule would otherwise close by inference and run them regardless, so the
  // assumption is measured (holdout fail rate vs. inferred-closed prior) instead of trusted.
  // Neighbours are SYNTHESIZED (one coordinate of a selected cell changed to its next valid value),
  // because a covering array rarely contains two cells one step apart — and the inference being
  // tested is precisely about cells that were never enumerated.
  const known = new Set(cells.map(c => c.cell_id));
  const holdout = [];
  const want = holdout_fraction > 0 ? Math.max(1, Math.round(selected.length * holdout_fraction)) : 0;
  const dims = want ? deriveDimensions(model) : [];
  const mutable = dims.filter(x => x.name !== 'target_tool');
  const stride = want ? Math.max(1, Math.floor(1 / holdout_fraction)) : 1;
  for (let i = 0; i < selected.length && holdout.length < want; i += stride) {
    const s = selected[i];
    // Try each mutable dimension (starting at a rotating offset) until a valid, not-yet-enumerated neighbour exists.
    for (let j = 0; j < mutable.length; j++) {
      const d = mutable[(i + j) % mutable.length];
      const next = d.values[(d.values.indexOf(s.coords[d.name]) + 1) % d.values.length];
      if (next === s.coords[d.name]) continue;
      const coords = { ...s.coords, [d.name]: next };
      if (!isValidCoords(model, coords)) continue;
      const cell = instantiate(model, coords);
      if (known.has(cell.cell_id)) continue;
      cell.prior = simulateCell(model, cell);
      known.add(cell.cell_id);
      holdout.push({ cell_id: cell.cell_id, stratum: coords.target_tool, p_fail: cell.prior.p_fail, confidence: cell.prior.confidence, coords, prompt: cell.prompt, injected_context: cell.injected_context, neighbour_of: s.cell_id, changed: d.name });
      break;
    }
  }

  const orch = promptMass(model, estTokens).find(x => model.actors.find(a => a.id === x.actor)?.kind === 'orchestrator') || { total: 0 };
  const per_run_tokens = orch.total + per_run_overhead_tokens;
  const first_pass_tokens = per_run_tokens * selected.length;
  const cached_fraction = orch.total / per_run_tokens;

  return {
    method: 'neyman-allocation + information-gain ordering + sequential escalation',
    unfunded_strata: unfunded.length, unfunded_note: unfunded.length ? `${unfunded.length} of ${order.length} strata got no run at this budget (lowest-risk first); raise --budget to reach them` : null,
    budget_runs, selected_runs: selected.length, total_cells: cells.length,
    coverage_of_cells_first_pass: +(selected.length / cells.length).toFixed(3),
    token_estimate: { per_run: per_run_tokens, first_pass: first_pass_tokens, cacheable_fraction_per_run: +cached_fraction.toFixed(2), worst_case_with_escalation: first_pass_tokens + Math.round(selected.length * 0.3) * (repeats_on_fail - 1) * per_run_tokens },
    sequential_rule: {
      on_pass: 'if prior.confidence ≥ 0.7 close the cell; lower neighbours (same stratum, one coordinate different) p_fail by 25% — the smoothness assumption; the `holdout` cells below are neighbours you run ANYWAY to measure it',
      holdout_check: 'after the first pass, compare the holdout fail rate against the mean inferred-closed prior; if the holdout fails at more than twice that rate, stop inferring closure and run neighbours explicitly',
      on_fail: `escalate the cell to ${repeats_on_fail} independent repeats; report the failure rate with a Wilson 95% CI; only then may a claim be called 'significant'`,
      stop_stratum: `when the stratum's pooled Wilson CI width < ${ci_width_target} or its allocation is spent`,
      judge: 'mechanical oracles first (lib/oracles) — spend an LLM judge only on the axes the oracles cannot score (clarity, confidence discipline)',
    },
    strata: [...strata.entries()].map(([h, xs]) => ({ stratum: h, cells: xs.length, sigma: +sig.get(h).toFixed(3), allocated: alloc.get(h), mean_p_fail: +(xs.reduce((a, x) => a + x.p_fail, 0) / xs.length).toFixed(3) })).sort((a, b) => b.allocated - a.allocated || a.stratum.localeCompare(b.stratum)),
    runs: selected.map(s => ({ order: s.order, cell_id: s.cell_id, stratum: s.stratum, score: s.score, p_fail: s.p_fail, confidence: s.confidence, disagreement: s.disagreement, coords: s.coords, prompt: s.prompt, injected_context: s.injected_context })),
    holdout,
  };
}

/** Bayesian-ish posterior update of a cell prior from observations (pseudo-count k=2). */
export function updatePrior(prior, observations, k = 2) {
  const n = observations.length; if (!n) return prior;
  const fails = observations.filter(o => !o.pass).length;
  const p = (prior.p_fail * k + fails) / (k + n);
  const w = wilson(fails, n);
  return { ...prior, p_fail: +p.toFixed(3), confidence: Math.max(prior.confidence, +Math.min(1, 1 - (w.hi - w.lo)).toFixed(3)), observed: { n, fails, wilson: w } };
}
