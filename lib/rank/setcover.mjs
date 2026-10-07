/**
 * Severity-weighted greedy set cover over findings. Because the closed world is enumerated, a fix's
 * efficacy is COMPUTED (which findings and how many lattice cells it closes), not estimated.
 * Weight(finding) = severity × fidelity weight (V1 ladder: L0 0.6, L1 0.8, L2 1.0, L3 1.0),
 * discounted ×0.5 when REFUTED. Greedy picks the fix with the largest remaining weight; ties go
 * to lower effort, then lexical id (deterministic).
 */
import { fixMeta } from '../fixes.mjs';

const FID_W = { L0: 0.6, L1: 0.8, L2: 1.0, L3: 1.0 };

export function rankFixes(findings, { maxFixes = 200 } = {}) {
  const weight = f => f.severity * (FID_W[f.fidelity] || 0.6) * (f.verify_status === 'REFUTED' ? 0 : 1);
  const total = findings.reduce((a, f) => a + weight(f), 0);
  const remaining = new Map(findings.map(f => [f.finding_id, f]));
  const byFix = new Map();
  for (const f of findings) for (const fx of f.fix_candidates || []) { if (!byFix.has(fx)) byFix.set(fx, new Set()); byFix.get(fx).add(f.finding_id); }
  const ranked = [];
  let covered = 0;
  while (remaining.size && ranked.length < maxFixes) {
    let best = null, bestW = 0, bestEffort = 9;
    for (const [fx, ids] of byFix) {
      const live = [...ids].filter(id => remaining.has(id));
      const w = live.reduce((a, id) => a + weight(remaining.get(id)), 0);
      const effort = fixMeta(fx).effort;
      if (w > bestW + 1e-9 || (Math.abs(w - bestW) < 1e-9 && best && (effort < bestEffort || (effort === bestEffort && fx < best)))) { best = fx; bestW = w; bestEffort = effort; }
    }
    if (!best || bestW <= 0) break;
    const closes = [...byFix.get(best)].filter(id => remaining.has(id));
    const cells = new Set(); let minFid = 'L3';
    for (const id of closes) { const f = remaining.get(id); for (const c of f.cells || []) cells.add(c); if (fidLess(f.fidelity, minFid)) minFid = f.fidelity; remaining.delete(id); }
    covered += bestW;
    const meta = fixMeta(best);
    ranked.push({ ...meta, rank: ranked.length + 1, closes_findings: closes.sort(), closes_cells: cells.size, closed_weight: +bestW.toFixed(2), efficacy: +(total ? bestW / total : 0).toFixed(3), cumulative_efficacy: +(total ? covered / total : 0).toFixed(3), min_fidelity: minFid, rules: [...new Set(closes.map(id => findings.find(f => f.finding_id === id).rule))].sort() });
  }
  return { fixes: ranked, groups: groupFixes(ranked), total_weight: +total.toFixed(2), uncovered_findings: [...remaining.keys()] };
}

/**
 * Presentation grouping: many fixes of the same KIND (e.g. `limit:add@…` for 45 tools) are one
 * engineering task applied N times. Group them so the plan reads as tasks, while every individual
 * fix row stays in `fixes` for traceability. A group keeps the best rank among its members.
 */
export function groupFixes(ranked, { minGroup = 3 } = {}) {
  const byKind = new Map();
  for (const f of ranked) { if (!byKind.has(f.kind)) byKind.set(f.kind, []); byKind.get(f.kind).push(f); }
  const groups = [];
  for (const [kind, fs] of byKind) {
    if (fs.length < minGroup) { for (const f of fs) groups.push({ group_id: f.fix_id, kind, members: [f.fix_id], rank: f.rank, locus: f.locus, closes_findings: f.closes_findings.length, closes_cells: f.closes_cells, efficacy: f.efficacy, min_fidelity: f.min_fidelity, effort: f.effort, regression_risk: f.regression_risk, description: f.description, rules: f.rules }); continue; }
    const cells = new Set(); let eff = 0, nF = 0; const rules = new Set(); let minFid = 'L3';
    for (const f of fs) { eff += f.efficacy; nF += f.closes_findings.length; f.rules.forEach(r => rules.add(r)); if (['L0', 'L1', 'L2', 'L3'].indexOf(f.min_fidelity) < ['L0', 'L1', 'L2', 'L3'].indexOf(minFid)) minFid = f.min_fidelity; }
    for (const f of fs) cells.add(f.closes_cells); // cells are per-fix counts; sum them
    groups.push({ group_id: `${kind}@(${fs.length} subjects)`, kind, members: fs.map(f => f.fix_id), rank: Math.min(...fs.map(f => f.rank)), locus: fs[0].locus, closes_findings: nF, closes_cells: fs.reduce((a, f) => a + f.closes_cells, 0), efficacy: +eff.toFixed(3), min_fidelity: minFid, effort: Math.max(...fs.map(f => f.effort)), regression_risk: fs.some(f => f.regression_risk === 'high') ? 'high' : fs.some(f => f.regression_risk === 'medium') ? 'medium' : 'low', description: `${fixMeta(`${kind}@each listed subject`).description} Applied to ${fs.length} subjects: ${fs.slice(0, 5).map(f => f.fix_id.split('@')[1]).join(', ')}${fs.length > 5 ? ', …' : ''}.`, rules: [...rules].sort() });
  }
  groups.sort((a, b) => b.efficacy - a.efficacy || a.rank - b.rank);
  let cum = 0;
  for (const [i, g] of groups.entries()) { cum += g.efficacy; g.order = i + 1; g.cumulative_efficacy = +Math.min(1, cum).toFixed(3); }
  return groups;
}
function fidLess(a, b) { return ['L0', 'L1', 'L2', 'L3'].indexOf(a) < ['L0', 'L1', 'L2', 'L3'].indexOf(b); }
