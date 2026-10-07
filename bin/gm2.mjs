#!/usr/bin/env node
/**
 * gm2 — Gristmill V2 command line.
 *
 *   gm2 audit   --target <module.mjs | francisco-dir> --out <dir> [--strength 2] [--budget 40] [--traces x.jsonl] [--now ISO]
 *   gm2 extract --target ... --out <dir>              # model.json + graph.json only
 *   gm2 analyze --target ... --out <dir>              # + structural findings
 *   gm2 lattice --target ... --out <dir>              # + cells with priors
 *   gm2 synth   --target ... --out <dir>              # + L1 harness (module targets)
 *   gm2 replay  --target ... --out <dir> --traces f   # + L2 replay
 *   gm2 rank    --target ... --out <dir>              # everything except the open-world plan
 *
 * No network, no LLM, no credentials. Deterministic: same inputs ⇒ byte-identical artifacts.
 */
import { runPipeline } from '../lib/pipeline.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const has = (name) => args.includes(`--${name}`);

const STAGES = {
  audit: null,
  extract: [],
  analyze: ['analyze'],
  lattice: ['analyze', 'lattice'],
  synth: ['analyze', 'lattice', 'synth'],
  replay: ['analyze', 'lattice', 'synth', 'replay'],
  rank: ['analyze', 'lattice', 'synth', 'replay'],
};

if (!cmd || !(cmd in STAGES) || has('help')) {
  console.log(`usage: gm2 <${Object.keys(STAGES).join('|')}> --target <path> --out <dir> [--kind module|francisco] [--strength N] [--budget N] [--traces file.jsonl] [--now ISO] [--full-if-at-most N] [--quiet]`);
  process.exit(cmd ? 1 : 0);
}
const target = opt('target'); const out = opt('out');
if (!target || !out) { console.error('--target and --out are required'); process.exit(2); }

try {
  const r = await runPipeline({
    target, out, kind: opt('kind'), strength: +opt('strength', 2), budget: +opt('budget', 40), traces: opt('traces'), now: opt('now'),
    fullIfAtMost: +opt('full-if-at-most', 2000), stages: STAGES[cmd], log: has('quiet') ? () => {} : (s) => console.log('  ' + s),
  });
  console.log(`\nwrote ${r.outDir}`);
  console.log(`  model.json graph.json findings.jsonl cells.jsonl plan.json open_world_plan.json summary.md harness/`);
  const top = (r.plan.groups || []).slice(0, 6);
  if (top.length) { console.log(`\nTop tasks (${r.plan.fixes.length} fixes in ${r.plan.groups.length} tasks):`); for (const g of top) console.log(`  ${g.order}. ${g.group_id}  (closes ${g.closes_findings} findings / ${g.closes_cells} cells, cum ${Math.round(g.cumulative_efficacy * 100)}%)`); }
} catch (e) {
  console.error('gm2 failed:', e.message);
  if (has('debug')) console.error(e.stack);
  process.exit(1);
}
