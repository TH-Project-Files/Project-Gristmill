/**
 * Replay — score RECORDED real traces (eval runs, audit logs) against the oracles. L2 evidence at
 * zero token cost. A record is { cell_id? , coords?, prompt?, steps:[...], final_answer?, output?, fidelity? }.
 * Records without a cell_id are matched to the nearest lattice cell by coordinate overlap.
 */
import { scoreTrace, canaries } from './oracles/index.mjs';
import { updatePrior } from './select/planner.mjs';
import { hashHex } from './util.mjs';
import { deriveDimensions } from './lattice/dimensions.mjs';
import { instantiate, cellId } from './lattice/instantiate.mjs';
import { simulateCell } from './simulate/policy.mjs';

export function replayTraces(model, cells, records) {
  const byId = new Map(cells.map(c => [c.cell_id, c]));
  const observations = [];
  for (const [i, rec] of records.entries()) {
    let cell = rec.cell_id ? byId.get(rec.cell_id) : null;
    if (!cell && rec.coords && rec.coords.target_tool) {
      // A recorded trace defines its own cell: instantiate it deterministically from the coords
      // (filling unspecified dimensions with their first value) and add it to the lattice if new.
      const coords = {};
      for (const d of deriveDimensions(model)) coords[d.name] = d.values.includes(rec.coords[d.name]) ? rec.coords[d.name] : d.values[0];
      const id = cellId(coords);
      cell = byId.get(id);
      if (!cell) { cell = instantiate(model, coords); cell.prior = simulateCell(model, cell); cells.push(cell); byId.set(id, cell); }
    }
    if (!cell) { observations.push({ record: i, error: 'no cell match (give cell_id, or coords with target_tool)' }); continue; }
    const trace = { fidelity: rec.fidelity || 'L2', ...rec };
    const result = scoreTrace(model, cell, trace, { secretValues: canaries(model) });
    observations.push({ record: i, cell_id: cell.cell_id, fidelity: trace.fidelity, pass: result.pass, violations: result.violations, axes: result.axes });
  }
  // Fold observations back into the cells' priors and emit L2 findings for violations.
  const findings = [];
  for (const cell of cells) {
    const mine = observations.filter(o => o.cell_id === cell.cell_id && !o.error);
    if (!mine.length) continue;
    cell.observations = mine;
    cell.prior = updatePrior(cell.prior, mine);
    const viol = new Map();
    for (const o of mine) for (const v of o.violations) { const k = v.code; if (!viol.has(k)) viol.set(k, { ...v, n: 0 }); viol.get(k).n++; }
    for (const v of viol.values()) findings.push({ finding_id: `L2-${v.code}-${hashHex(cell.cell_id + v.code)}`, rule: `L2-${v.code}`, mode: ['OVER-IDEAL-CALLS', 'OVER-BUDGET', 'DEAD-SOURCE-CALLED', 'PER-ITEM-WHERE-BATCH', 'DUPLICATE-CALLS', 'TRUNCATION'].includes(v.code) ? 'efficiency' : 'security', severity: v.severity, fidelity: 'L2', verify_status: v.n >= 2 ? 'CONFIRMED' : 'UNCERTAIN', summary: `[replayed ${v.n}/${mine.length}] ${cell.coords.target_tool}: ${v.detail}`, subject: { tool: cell.coords.target_tool }, evidence: { cell: cell.cell_id, n: v.n, of: mine.length }, cells: [cell.cell_id], fix_candidates: fixFor(v.code, cell.coords.target_tool) });
  }
  return { observations, findings };
}

function fixFor(code, tool) {
  return ({
    'GATE-MISSING': [`gate:consent@${tool}`], 'SECRET-IN-OUTPUT': [`redact:env@${tool}`], 'SECRET-SHAPED-OUTPUT': [`redact:env@${tool}`],
    'SCOPE-NOT-STATED': ['policy:state-scope'], 'ERROR-DISCLOSURE': [`errors:sanitize@${tool}`],
    'OVER-IDEAL-CALLS': ['budget:call_budget'], 'OVER-BUDGET': ['budget:call_budget'], 'DEAD-SOURCE-CALLED': [`retries:outage-aware@${tool}`],
    'PER-ITEM-WHERE-BATCH': ['policy:aggregate-first'], 'DUPLICATE-CALLS': [`routing:single-owner@${tool}`], 'TRUNCATION': [`limit:add@${tool}`],
    'WRONG-HANDLER': [`routing:single-owner@${tool}`], 'GUESSED-NOT-CLARIFIED': ['policy:clarify-missing-subject'],
  })[code] || [`policy:review@${tool}`];
}
