/**
 * The V2 pipeline: extract → analyze (exhaustive L0) → lattice (closed-world cells + priors)
 *   → synth harness (L1, real handlers) → replay (L2, recorded traces) → rank (set cover)
 *   → select (open-world plan) → report.
 * No LLM is called anywhere in this file. Every artifact is deterministic for a given input.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeModel, buildGraph, enumerateRoutes } from './model.mjs';
import { loadTargetModule } from './extract/from-module.mjs';
import { extractFrancisco } from './extract/from-francisco.mjs';
import { runAnalyzers } from './analyzers/index.mjs';
import { deriveDimensions, isValidCoords, latticeSize } from './lattice/dimensions.mjs';
import { buildCoveringArray } from './lattice/covering.mjs';
import { instantiate } from './lattice/instantiate.mjs';
import { simulateCell } from './simulate/policy.mjs';
import { probeTool, observationsToFindings } from './synth/runtime.mjs';
import { emitHarnessTests } from './synth/generate.mjs';
import { replayTraces } from './replay.mjs';
import { rankFixes } from './rank/setcover.mjs';
import { planOpenWorld } from './select/planner.mjs';
import { runSequenceEngine } from './sequence/index.mjs';
import { writeReport } from './report.mjs';
import { stableStringify, DEFAULT_NOW } from './util.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));

export async function loadModel(target, kind) {
  const p = resolve(target);
  const k = kind || (existsSync(p) && statSync(p).isDirectory() ? 'francisco' : 'module');
  const raw = k === 'francisco' ? extractFrancisco(p) : await loadTargetModule(p);
  return { model: normalizeModel(raw), kind: k, path: p };
}

export async function runPipeline(opts) {
  const { target, out, kind, strength = 2, fullIfAtMost = 2000, budget = 40, traces, now = DEFAULT_NOW, stages = null, log = () => {} } = opts;
  const run = s => !stages || stages.includes(s);
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const art = (name, data) => { writeFileSync(join(outDir, name), typeof data === 'string' ? data : stableStringify(data) + '\n'); };

  // 1. Extract
  const { model, kind: k, path } = await loadModel(target, kind);
  log(`extract: ${model.target.name}@${model.target.version} via ${k} (${model.extraction.confidence}) — ${model.tools.length} tools, ${model.actors.length} actors, ${enumerateRoutes(model).length} routes`);
  const publicModel = { ...model }; delete publicModel._handlers;
  art('model.json', publicModel);
  art('graph.json', buildGraph(model));

  // 2. Exhaustive structural analysis (L0)
  let structural = [];
  if (run('analyze')) { structural = runAnalyzers(model); log(`analyze: ${structural.length} structural findings`); }

  // 3. Lattice + priors
  let cells = [], lattice = null;
  if (run('lattice')) {
    const dims = deriveDimensions(model);
    const size = latticeSize(model, dims);
    const ca = buildCoveringArray(dims, { strength, fullIfAtMost, isValid: c => isValidCoords(model, c) });
    cells = ca.rows.map(coords => instantiate(model, coords));
    for (const c of cells) c.prior = simulateCell(model, c);
    cells.sort((a, b) => a.cell_id.localeCompare(b.cell_id));
    lattice = { dimensions: dims, product: size.product, valid_cells_total: size.valid, enumerated_cells: cells.length, method: ca.method, strength: ca.strength, uncovered_interactions: ca.uncovered_interactions || 0, coverage_fraction: +(cells.length / size.valid).toFixed(4) };
    log(`lattice: ${size.valid} valid cells (product ${size.product}); enumerated ${cells.length} via ${ca.method}`);
    attachCells(model, structural, cells);
  }

  // 4. Self-built L1 harness (module targets only)
  let harnessFindings = [], harness = [];
  if (run('synth') && Object.keys(model._handlers).length) {
    for (const t of model.tools) if (model._handlers[t.id]) harness.push(await probeTool(model, t, model._handlers[t.id]));
    harnessFindings = observationsToFindings(harness);
    attachCells(model, harnessFindings, cells);
    const files = emitHarnessTests({ outDir, model, targetPath: path, runtimePath: join(LIB, 'synth', 'runtime.mjs'), results: harness });
    log(`synth: probed ${harness.length} handlers over ${harness.reduce((a, r) => a + r.cases, 0)} cases → ${harnessFindings.length} L1 findings; ${files.length} test files emitted`);
  } else if (run('synth')) log('synth: skipped (no executable handlers on this extraction path — L0 only)');

  // 5. Replay recorded traces (L2)
  let replay = null, replayFindings = [];
  if (run('replay') && traces) {
    const records = readFileSync(resolve(traces), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    replay = replayTraces(model, cells, records);
    replayFindings = replay.findings;
    log(`replay: ${records.length} records → ${replayFindings.length} L2 findings`);
  }

  // 5b. Sequence engine (multi-step closed world). Offline, deterministic; no runner needed.
  let sequence = null;
  if (run('sequence')) { sequence = runSequenceEngine({ model, outDir, depth: opts.depth || 5, now, log }); attachCells(model, sequence.findings, cells); }
  const sequenceFindings = sequence?.findings || [];

  const findings = [...structural, ...harnessFindings, ...replayFindings, ...sequenceFindings];
  art('findings.jsonl', findings.map(f => JSON.stringify(f)).join('\n') + '\n');
  art('cells.jsonl', cells.map(c => JSON.stringify(c)).join('\n') + '\n');

  // 6. Rank by set cover
  const ranking = rankFixes(findings);
  const plan = {
    target: model.target, generated_at: now, extraction: model.extraction,
    fixes: ranking.fixes, groups: ranking.groups, total_weight: ranking.total_weight, uncovered_findings: ranking.uncovered_findings,
    coverage: lattice ? { closed_world_total_cells: lattice.valid_cells_total, closed_world_cells_enumerated: lattice.enumerated_cells, closed_world_strength: lattice.method, structural_findings: structural.length, harness_findings: harnessFindings.length, replay_findings: replayFindings.length } : undefined,
    evidence_confidence: evidenceConfidence(model, ranking.fixes, replayFindings),
    open_world_plan_ref: 'open_world_plan.json',
  };
  art('plan.json', plan);
  log(`rank: ${ranking.fixes.length} fixes cover ${Math.round((ranking.fixes.at(-1)?.cumulative_efficacy ?? 0) * 100)}% of failure mass`);

  // 7. Open-world plan
  let openWorld = null;
  if (run('select') && cells.length) { openWorld = planOpenWorld(model, cells, findings, { budget_runs: budget }); art('open_world_plan.json', openWorld); log(`select: ${openWorld.selected_runs} semantic runs planned (${openWorld.token_estimate.first_pass} tokens first pass)`); }

  // 8. Report
  const md = writeReport({ model, lattice, structural, harness, harnessFindings, replay, sequence, plan, openWorld, now });
  art('summary.md', md);
  return { outDir, model, structural, cells, lattice, harness, harnessFindings, replay, sequence, findings, plan, openWorld };
}

/** Attach lattice cells to findings so set cover can report how many cells each fix closes. */
function attachCells(model, findings, cells) {
  for (const f of findings) {
    const t = f.subject?.tool;
    let mine = [];
    if (t) mine = cells.filter(c => c.coords.target_tool === t);
    else if (f.rule === 'EFF-01') mine = cells.filter(c => c.coords.scope === 'all');
    if (f.rule === 'SEC-08') { const e = f.evidence?.entry; mine = mine.filter(c => c.coords.entry === e); }
    if (f.rule === 'EFF-02') mine = mine.filter(c => c.coords.source_state === 'outage');
    if (f.rule === 'EFF-04' || f.rule === 'EFF-06') mine = mine.filter(c => c.coords.scope !== 'single');
    if (f.rule === 'SEC-07') mine = mine.filter(c => c.coords.subject_ambiguity === 'name-collision');
    if (f.rule === 'SEC-09' || f.rule === 'SEQ-01' || f.rule === 'SEQ-04') mine = mine.filter(c => c.coords.injection === 'instruction-in-content');
    if (f.rule === 'SEQ-03') mine = cells.filter(c => c.coords.target_tool === t);
    if (f.subject?.entry) mine = mine.filter(c => c.coords.entry === f.subject.entry);
    f.cells = mine.map(c => c.cell_id);
  }
}

function evidenceConfidence(model, fixes, replayFindings) {
  if (model.extraction.confidence !== 'exact') return 'directional';
  const top = fixes.slice(0, 3);
  if (top.length && top.every(f => f.min_fidelity !== 'L0' || f.rules.some(r => r.startsWith('HAR-') || r.startsWith('L2-')))) return 'high-confidence';
  return 'directional';
}
