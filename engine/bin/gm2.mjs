#!/usr/bin/env node
/**
 * gm2 — Gristmill V2 command line.
 *
 *   gm2 quick   [--target <agent>] [--out <dir>] [--allow-exec]   # NO DECISIONS: dry, full offline mapping, low effort, plain brief
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

// `boundary` drives the open world: it probes a runner (mock by default; --live uses the Anthropic
// runner, which refuses to run without GRISTMILL_SANDBOX=1) and measures defense SHAPES.
// `quick` is the no-decisions default: dry, every offline mapping layer, low effort, plain-language
// brief. --target is optional (defaults to the current directory when it looks like an agent).
if (cmd === 'quick') {
  const { runQuick } = await import('../lib/quick.mjs');
  try {
    const r = await runQuick({ target: opt('target'), out: opt('out'), allowExec: has('allow-exec'), now: opt('now'), log: has('verbose') ? s => console.log('  ' + s) : () => {} });
    console.log('\n' + r.brief);
    console.log(`(written to ${r.outDir}${process.platform === 'win32' ? '\\' : '/'}quick.md)`);
    process.exit(0);
  } catch (e) { console.error('\n' + e.message + '\n'); process.exit(2); }
}

if (cmd === 'boundary') {
  const target = opt('target'), out = opt('out');
  if (!target || !out) { console.error('--target and --out are required'); process.exit(2); }
  const { loadModel } = await import('../lib/pipeline.mjs');
  const { runBoundaryCampaign } = await import('../lib/boundary/index.mjs');
  const { runSequenceEngine } = await import('../lib/sequence/index.mjs');
  const { resolve } = await import('node:path');
  const { model } = await loadModel(target, opt('kind'), { allowExec: has('allow-exec') });
  let adapter;
  if (has('live') || has('handoff')) {
    const { createLiveRunner } = await import('../lib/runner/live.mjs');
    const { resolve: rpath } = await import('node:path');
    const handoff = has('handoff') ? rpath(opt('handoff') || rpath(opt('out'), 'mailbox')) : null;
    try { adapter = createLiveRunner(model, { model: opt('model'), transport: opt('transport'), completeCmd: opt('complete-cmd'), handoff, handoffTimeoutMs: opt('handoff-timeout') ? +opt('handoff-timeout') * 1000 : undefined, nonInteractiveGate: opt('nonint-gate', 'block') }); }
    catch (e) { console.error('\n' + e.message + '\n'); process.exit(2); }
    console.log(`  live runner via ${adapter.how}; model ${adapter.describe().model_version}`);
    if (handoff) console.log(`  HANDOFF: answer the turns in ${handoff} (see ${handoff}${process.platform === 'win32' ? '\\' : '/'}MAILBOX.md). Run this command in the background and answer between your tool calls.`);
  }
  else { const { createMockRunner } = await import('../lib/runner/mock.mjs'); adapter = createMockRunner(model, {}); console.log('  (mock runner — synthetic agent; use --live for a real model via your harness)'); }
  const sequence = runSequenceEngine({ model, depth: +opt('depth', 5) });
  const r = await runBoundaryCampaign({ model, adapter, outDir: resolve(out), rounds: +opt('rounds', 2), budget: +opt('budget', 120), sequence, now: opt('now'), log: has('quiet') ? () => {} : s => console.log('  ' + s) });
  console.log(`\nwrote ${resolve(out)}: boundaries.json thresholds.json radius.json boundary_findings.jsonl threshold_baseline.json next_probes.json observations.jsonl`);
  console.log(`\nDefense shapes:`);
  for (const b of r.boundaries.filter(b => b.sensitive)) console.log(`  ${b.tool}: ${b.class}${b.min_pressure_to_break != null ? ` (breaks at pressure ${b.min_pressure_to_break})` : ''}`);
  for (const f of r.findings.slice(0, 6)) console.log(`  [${f.rule} sev${f.severity}] ${f.summary.slice(0, 100)}`);
  process.exit(0);
}

const STAGES = {
  audit: null,
  extract: [],
  analyze: ['analyze'],
  lattice: ['analyze', 'lattice'],
  synth: ['analyze', 'lattice', 'synth'],
  replay: ['analyze', 'lattice', 'synth', 'replay'],
  sequence: ['analyze', 'lattice', 'sequence'],
  rank: ['analyze', 'lattice', 'synth', 'replay', 'sequence'],
};

if (!cmd || !(cmd in STAGES) || has('help')) {
  console.log(`usage: gm2 quick [--target <agent>]          (start here: no decisions, dry, plain-language result)
       gm2 <${Object.keys(STAGES).join('|')}> --target <path> --out <dir> [--kind module|francisco] [--strength N] [--budget N] [--traces file.jsonl] [--now ISO] [--full-if-at-most N] [--quiet]`);
  process.exit(cmd ? 1 : 0);
}
const target = opt('target'); const out = opt('out');
if (!target || !out) { console.error('--target and --out are required'); process.exit(2); }

try {
  const r = await runPipeline({
    target, out, kind: opt('kind'), strength: +opt('strength', 2), budget: +opt('budget', 40), traces: opt('traces'), now: opt('now'),
    fullIfAtMost: +opt('full-if-at-most', 2000), depth: +opt('depth', 5), boundaryFindings: opt('boundary-findings'), allowExec: has('allow-exec'), stages: STAGES[cmd], log: has('quiet') ? () => {} : (s) => console.log('  ' + s),
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
