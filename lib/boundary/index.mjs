/**
 * Boundary campaign — plan probes, run them through an adapter, fit shapes, compute radius, apply
 * rules; round after round until the refinement controller has nothing left to ask or the budget
 * is spent. Thresholds and observations persist in outDir so a later session continues the work.
 */
import { join } from 'node:path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { deriveDimensions } from '../lattice/dimensions.mjs';
import { loadObservations, appendObservations } from './observations.mjs';
import { findThreshold, evaluateLevel, defaultFail, securityFail } from './threshold.mjs';
import { fitBoundaries } from './fit.mjs';
import { computeRadius } from './radius.mjs';
import { planProbes } from './refine.mjs';
import { boundaryRules } from './rules.mjs';
import { baselineFromBoundaries } from './regression.mjs';
import { stableStringify } from '../util.mjs';
import { isSensitiveTool, toolById } from '../model.mjs';

export async function runBoundaryCampaign({ model, adapter, outDir, rounds = 2, budget = 60, reps = 2, repsAtFlip = 5, tools = null, sequence = null, now, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const dims = deriveDimensions(model);
  const obsFile = join(outDir, 'observations.jsonl');
  const thFile = join(outDir, 'thresholds.json');
  const thresholds = existsSync(thFile) ? JSON.parse(readFileSync(thFile, 'utf8')) : [];
  let observations = loadObservations(obsFile);
  let boundaries = fitBoundaries(model, thresholds);
  let radius = observations.length ? computeRadius(model, dims, observations) : null;
  let roundsRun = 0;

  for (let round = 1; round <= rounds; round++) {
    const plan = planProbes(model, dims, { thresholds, boundaries, radius, budget, reps, repsAtFlip, tools });
    if (!plan.probes.length) { log(`boundary round ${round}: nothing left to probe (${plan.closed.length} regions closed)`); break; }
    roundsRun++;
    log(`boundary round ${round}: ${plan.probes.length} probes (~${plan.est_runs} runs) via ${adapter.kind}`);
    const fresh = [];
    for (const p of plan.probes) {
      const failPredicate = isSensitiveTool(toolById(model, p.tool)) ? securityFail : defaultFail;
      if (p.type === 'bisect') {
        const th = await findThreshold({ adapter, model, dims, base: p.base_coords, axis: p.axis, reps: p.reps, repsAtFlip: p.repsAtFlip, failPredicate });
        fresh.push(...th.observations.map(o => ({ ...o, probe: `${p.tool}/${p.axis}/${p.entry}`, source: 'bisect' })));
        const { observations: _drop, ...rec } = th;
        thresholds.push({ ...rec, reason: p.reason, round });
      } else {
        const s = await evaluateLevel({ adapter, model, dims, base: p.base_coords, axis: p.axis, level: p.level, reps: p.reps, failPredicate, repOffset: 100 * round });
        fresh.push(...s.observations.map(o => ({ ...o, probe: `${p.tool}/${p.axis}/${p.entry}`, source: 'repeat' })));
        const th = thresholds.filter(t => t.tool === p.tool && t.axis === p.axis && t.entry === p.entry).at(-1);
        const lv = th?.levels.find(l => l.level === p.level);
        if (lv) { lv.n += s.n; lv.fails += s.fails; lv.p = +(lv.fails / lv.n).toFixed(3); lv.wilson = { lo: +s.wilson.lo.toFixed(3), hi: +s.wilson.hi.toFixed(3) }; th.flip_wilson = lv.wilson; th.runs_used += s.n; }
      }
    }
    appendObservations(obsFile, fresh, now);
    observations = observations.concat(fresh);
    boundaries = fitBoundaries(model, thresholds);
    radius = computeRadius(model, dims, observations);
    log(`boundary round ${round}: ${fresh.length} runs, ${thresholds.length} thresholds, ${boundaries.length} shapes`);
  }
  const findings = boundaryRules(model, { boundaries, radius, thresholds, sequence });
  const next = planProbes(model, dims, { thresholds, boundaries, radius, budget, reps, repsAtFlip, tools });
  const baseline = baselineFromBoundaries(boundaries, { model_version: adapter.describe?.().model_version, generated_at: now });
  writeFileSync(thFile, stableStringify(thresholds) + '\n');
  writeFileSync(join(outDir, 'boundaries.json'), stableStringify(boundaries) + '\n');
  writeFileSync(join(outDir, 'radius.json'), stableStringify(radius || {}) + '\n');
  writeFileSync(join(outDir, 'next_probes.json'), stableStringify(next) + '\n');
  writeFileSync(join(outDir, 'threshold_baseline.json'), stableStringify(baseline) + '\n');
  writeFileSync(join(outDir, 'boundary_findings.jsonl'), findings.map(f => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''));
  return { dims, observations, thresholds, boundaries, radius, findings, next, baseline, rounds_run: roundsRun };
}
