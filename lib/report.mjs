/**
 * summary.md — written for the person who will act on the audit. Leads with the ranked fixes,
 * states exactly how strong the closed-world claim is, and never dresses an L0 prediction as a fact.
 */
import { RULE_CATALOG } from './analyzers/index.mjs';
import { enumerateRoutes } from './model.mjs';

export function writeReport({ model, lattice, structural, harness, harnessFindings, replay, plan, openWorld, now }) {
  const L = [];
  const h = (n, s) => L.push(`${'#'.repeat(n)} ${s}`, '');
  const p = (s) => L.push(s, '');
  const routes = enumerateRoutes(model);
  h(1, `Gristmill V2 dry audit — ${model.target.name} ${model.target.version || ''}`);
  p(`Generated ${now}. Extraction: **${model.extraction.method}** (${model.extraction.confidence}). Evidence confidence: **${plan.evidence_confidence}**.`);
  if (model.extraction.notes?.length) { p('Extraction notes:'); for (const n of model.extraction.notes) L.push(`- ${n}`); L.push(''); }

  h(2, 'What to fix first');
  p('Ranked by severity-weighted set cover: each row is the change that closes the most remaining failure mass given the rows above it. Efficacy is computed over the enumerated closed world, not estimated.');
  L.push('| # | Fix | Locus | Closes | Cells | Efficacy | Cum. | Min fidelity | Effort | Regression risk |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const f of plan.fixes.slice(0, 12)) L.push(`| ${f.rank} | \`${f.fix_id}\` | ${f.locus} | ${f.closes_findings.length} (${f.rules.join(', ')}) | ${f.closes_cells} | ${pct(f.efficacy)} | ${pct(f.cumulative_efficacy)} | ${f.min_fidelity} | ${f.effort} | ${f.regression_risk} |`);
  L.push('');
  for (const f of plan.fixes.slice(0, 6)) L.push(`- **${f.fix_id}** — ${f.description}`);
  L.push('');

  h(2, 'How strong is the closed-world claim?');
  if (lattice) {
    L.push(`- Structural rules ran over **${routes.length} routes**, ${model.tools.length} tools, ${model.tools.reduce((a, t) => a + t.params.length, 0)} params, ${model.gates.length} gates, ${model.env.length} env vars — every element visited (exhaustive by construction).`);
    L.push(`- Semantic lattice: ${lattice.dimensions.length} dimensions, product ${lattice.product}, **${lattice.valid_cells_total} valid cells**. Enumerated **${lattice.enumerated_cells}** via ${lattice.method}${lattice.method === 'full-product' ? ' (100% of cells)' : ` (every ${lattice.strength}-way interaction covered${lattice.uncovered_interactions ? `, ${lattice.uncovered_interactions} unsatisfiable under constraints` : ''})`}.`);
    L.push(`- Dimensions: ${lattice.dimensions.map(d => `${d.name}[${d.values.length}]`).join(' × ')}.`);
    L.push('- What stays open: novel phrasing within a cell, and emergent model behaviour. Those are what the open-world plan below samples. An L0 finding here is a *reachable, ungated* fact — never a claim that the model *would* take that path.');
  } else L.push('- Lattice stage skipped.');
  L.push('');

  h(2, `Structural findings (L0) — ${structural.length}`);
  const byRule = new Map();
  for (const f of structural) { if (!byRule.has(f.rule)) byRule.set(f.rule, []); byRule.get(f.rule).push(f); }
  L.push('| Rule | What | n | Max sev | Subjects |', '|---|---|---|---|---|');
  for (const [r, fs] of [...byRule.entries()].sort()) L.push(`| ${r} | ${RULE_CATALOG[r] || ''} | ${fs.length} | ${Math.max(...fs.map(f => f.severity))} | ${[...new Set(fs.map(f => f.subject.tool || f.subject.route || '—'))].slice(0, 6).join(', ')} |`);
  L.push('');
  for (const f of structural.filter(f => f.severity >= 4)) L.push(`- **[${f.rule} sev ${f.severity}]** ${f.summary}`);
  L.push('');

  h(2, `Self-built harness (L1) — ${harnessFindings.length} findings`);
  if (harness.length) {
    p(`Executed the real handlers of ${harness.length} tools over ${harness.reduce((a, r) => a + r.cases, 0)} schema-derived cases (valid / boundary / out-of-schema / taint-shaped), twice each under a locked env with recording fakes. Generated tests live in \`harness/\` — rerun one tool with \`node --test harness/<tool>.test.mjs\`.`);
    for (const f of harnessFindings) L.push(`- **[${f.rule} sev ${f.severity} ${f.verify_status}]** ${f.summary}`);
    const drift = harnessFindings.filter(f => f.mode === 'model-drift');
    if (drift.length) { L.push(''); p(`**Model drift:** ${drift.length} handler behaviours the contract does not declare. Every L0 conclusion assumes the contract is true; fix the contract (or the handler) before trusting the structural table.`); }
  } else p('No executable handlers on this extraction path (heuristic extraction yields L0 only). Point the module extractor at an export of the real tool handlers to unlock L1.');
  L.push('');

  if (replay) {
    h(2, `Replayed traces (L2) — ${replay.findings.length} findings`);
    const ok = replay.observations.filter(o => !o.error);
    p(`${ok.length} recorded traces scored by the mechanical oracles; ${ok.filter(o => o.pass).length} passed. Cells touched had their priors updated (Wilson intervals recorded on the cell).`);
    for (const f of replay.findings) L.push(`- **[${f.rule} sev ${f.severity} ${f.verify_status}]** ${f.summary}`);
    L.push('');
  }

  if (openWorld) {
    h(2, 'Open-world plan (where to spend LLM runs)');
    p(`${openWorld.selected_runs} first-pass runs out of ${openWorld.total_cells} cells (${pct(openWorld.coverage_of_cells_first_pass)}), chosen by ${openWorld.method}. Estimated ${openWorld.token_estimate.first_pass.toLocaleString()} tokens for the first pass (~${openWorld.token_estimate.per_run}/run, ${pct(openWorld.token_estimate.cacheable_fraction_per_run)} of each run is cache-stable prompt mass); worst case with escalation ≈ ${openWorld.token_estimate.worst_case_with_escalation.toLocaleString()}.`);
    L.push('| Stratum (tool) | Cells | σ | Allocated | Mean prior p(fail) |', '|---|---|---|---|---|');
    for (const s of openWorld.strata) L.push(`| ${s.stratum} | ${s.cells} | ${s.sigma} | ${s.allocated} | ${s.mean_p_fail} |`);
    L.push('', '**Sequential rule:**');
    for (const [k, v] of Object.entries(openWorld.sequential_rule)) L.push(`- *${k}*: ${v}`);
    L.push('', '**First ten runs:**', '', '| # | Score | p(fail) | Conf | Disagree | Cell | Prompt |', '|---|---|---|---|---|---|---|');
    for (const r of openWorld.runs.slice(0, 10)) L.push(`| ${r.order} | ${r.score} | ${r.p_fail} | ${r.confidence} | ${r.disagreement ? 'yes' : ''} | ${r.stratum} / ${r.coords.scope} / ${r.coords.subject_ambiguity} / ${r.coords.source_state} / ${r.coords.injection} / ${r.coords.authority} / ${r.coords.entry} | ${r.prompt.replace(/\|/g, '/').slice(0, 90)}${r.prompt.length > 90 ? '…' : ''} |`);
    L.push('');
  }

  h(2, 'Honesty notes');
  L.push('- "Exhaustive" applies to the closed world: the structural graph and the equivalence lattice. It does not apply to phrasing or to emergent behaviour.');
  L.push('- L0 findings are reachable-and-ungated facts about the model. L1 findings executed a real mechanism. Only L2+ speaks to what the whole agent does.');
  L.push('- `evidence_confidence` follows V1: *directional* unless the top fixes rest on executed evidence; *significant* is never set by a dry audit (it needs repeated trials with reported variance — see the open-world plan).');
  if (model.extraction.confidence === 'heuristic') L.push('- This model was extracted heuristically (regex over source). Treat every inferred sink/gate/env as a hypothesis to confirm; the fastest way to upgrade is to export a `describeAgent()` from the package and rerun with the module extractor.');
  L.push('');
  return L.join('\n');
}
const pct = x => `${Math.round((x || 0) * 100)}%`;
