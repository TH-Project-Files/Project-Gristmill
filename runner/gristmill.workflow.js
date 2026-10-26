/**
 * Gristmill reference runner
 * ==========================
 * A runnable orchestration of one polishing campaign: characterize -> (generate -> run ->
 * score -> verify -> cluster) x rounds -> plan -> skeptic-gate -> regression pack. It writes the
 * full artifact chain under workspace/<campaign_id>/ using the schemas in ../schemas.
 *
 * TWO ENGINES, one control flow (all of it lives in ./core.js, import-free):
 *   - workflowEngine: each role is a real subagent call via the Workflow `agent()` global.
 *     Launch it through the Claude Code Workflow tool with a bundle from runner/bundle.mjs, then
 *     write the artifacts with runner/replay.mjs (see runner/README.md).
 *   - offlineEngine:  each role is a deterministic, dependency-free stand-in driven by the
 *     built-in SimulationAdapter. No LLM, no network. This is what `node gristmill.workflow.js`
 *     runs, so the loop, the schemas, the fingerprint/non-repetition engine, the scoring math,
 *     and the artifact chain are all verifiable offline.
 *
 * The control flow (runCampaign) is identical for both engines — swapping the engine swaps
 * prediction-quality, not structure. That is the point: the methodology is engine-agnostic.
 *
 * This file is the node host: it gives runCampaign a filesystem-backed `io` and the kit root.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as core from './core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(__dirname, '..');

/** Workflow-tool metadata (harmless as a plain export under node). */
export const meta = {
  name: 'gristmill-campaign',
  description: 'Run one closed-loop agent-polishing campaign to a prioritized, gated improvement plan',
  phases: [
    { title: 'Characterize' },
    { title: 'Round' },
    { title: 'Plan' },
    { title: 'Regress' },
  ],
};

/** Filesystem io for runCampaign. Append is a real append: memory/*.jsonl is never rewritten. */
export const nodeIo = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, s) => writeFileSync(p, s),
  append: (p, s) => appendFileSync(p, s),
  exists: (p) => existsSync(p),
  mkdirp: (p) => mkdirSync(p, { recursive: true }),
};

/** runCampaign with node defaults (filesystem io, the kit root). */
export function runCampaign(opts) {
  return core.runCampaign({ io: nodeIo, kitDir: KIT, ...opts });
}

export const {
  offlineEngine, workflowEngine, makeSimulationAdapter, dataAdapter, memoryIo, fingerprintSimilarity,
  normalizedTextTrigramCosine, redactForBlindJudge, agreementWithin1, pickPromotions,
} = core;

// ---------------------------------------------------------------------------
// CLI entry (offline). Usage: node gristmill.workflow.js [path/to/run-config.json]
// ---------------------------------------------------------------------------

function defaultConfig() {
  return {
    target_name: 'ExampleAgent', campaign_id: 'example-campaign', adapter: 'simulation',
    evaluation_modes: ['efficiency', 'agent-logic', 'security', 'stall-conditions'],
    fidelity: { default_level: 'L0', real_execution_sample_rate: 0.25, sample_strategy: 'highest-risk-first' },
    scenario_plan: { count_per_round: 12, mix: { realistic: 0.4, adversarial: 0.4, edge_case: 0.2 }, max_repeat_similarity: 0.82, seed_sets: ['internal_templates'] },
    scoring: { axes: core.AXES, judge_panel_size: 3, blind_fraction: 0.5, weighting_profile: 'default' },
    stopping_rule: { dry_rounds: 2, min_samples_per_cell: 3, max_rounds: 4 },
    memory_mode: 'append_only',
  };
}

async function main() {
  const argPath = process.argv[2];
  const config = argPath ? JSON.parse(readFileSync(argPath, 'utf8')) : defaultConfig();
  const res = await runCampaign({ config, engine: core.offlineEngine(), adapter: core.makeSimulationAdapter() });
  console.log(JSON.stringify(res, null, 2));
}

// Run main() only under plain node, not when imported.
const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) { main().catch(e => { console.error(e); process.exit(1); }); }
