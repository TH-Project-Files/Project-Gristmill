/**
 * Build a self-contained Claude Code Workflow script for one campaign.
 * ===================================================================
 * Workflow scripts have no imports and no filesystem, so this inlines everything a run needs:
 * runner/core.js (exports stripped), the role prompts, mode packs, rubrics, schemas, the
 * run-config, the adapter's data (describe model, validated target profile, evidence blocks,
 * executed probes) and the campaign's current append-only memory (so the fingerprint gate sees
 * the full history). The same inputs are written to workflow/inputs.json for runner/replay.mjs.
 *
 * Usage:
 *   node runner/bundle.mjs --campaign workspace/<campaign_id> --adapter target-adapters/<x>.adapter.mjs
 * Writes:
 *   workspace/<campaign_id>/workflow/campaign.workflow.js   (pass as the Workflow tool's scriptPath)
 *   workspace/<campaign_id>/workflow/inputs.json            (replay.mjs reads this)
 * Then launch with Workflow({ scriptPath, args: { now: "<ISO time from the real clock>" } }).
 *
 * The adapter module must export adapterData({ campaignDir }) returning
 * { name, model, target_profile, blocks:[{title,text}], probes:[...] } — plain data only.
 * Adapters with execute() are refused: the workflow engine never runs the target (L2/L3 goes
 * only through safety/safe-execute.mjs).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateValue } from './validate.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEMORY_READ_BY_RUNNER = ['scenario_fingerprints.jsonl', 'score_timeseries.jsonl', 'long_term_findings.jsonl'];
const RUBRICS = ['axes.md', 'fidelity-ladder.md', 'statistics.md'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const readText = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function argv() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return out;
}

/** The campaign's memory files the runner reads, keyed by the kit-relative path memoryIo uses. */
export function memorySeed(campaignDir, campaignId) {
  const seed = {};
  for (const f of MEMORY_READ_BY_RUNNER) {
    const p = path.join(campaignDir, 'memory', f);
    if (existsSync(p)) seed[`workspace/${campaignId}/memory/${f}`] = readFileSync(p, 'utf8');
  }
  return seed;
}

/** One hash over the seed, so replay can refuse if memory moved since bundling. */
export function seedHash(seed) {
  return sha(Object.keys(seed).sort().map(k => `${k}\n${sha(seed[k])}`).join('\n'));
}

/** core.js as an inlineable script body: no export keywords. */
export function coreBody() {
  const src = readText(path.join(KIT, 'runner', 'core.js'));
  const body = src.replace(/^export \{[\s\S]*?\};\s*$/m, '');
  if (/^\s*(import|export)\s/m.test(body)) throw new Error('core.js still has import/export statements after stripping');
  return body;
}

export async function buildInputs({ campaignDir, adapterPath }) {
  const config = JSON.parse(readText(path.join(campaignDir, 'run-config.json')));
  const cfgErr = validateValue('run-config.schema.json', config);
  if (cfgErr.length) throw new Error(`run-config.json is schema-invalid:\n  ${cfgErr.join('\n  ')}`);
  if (path.resolve(campaignDir) !== path.resolve(KIT, 'workspace', config.campaign_id)) {
    throw new Error(`campaign dir must be workspace/${config.campaign_id} (runCampaign writes there)`);
  }
  const mod = await import(pathToFileURL(path.resolve(adapterPath)).href);
  if (mod.execute) throw new Error('adapter exports execute(): refused. The workflow engine never runs the target; L2/L3 goes only through safety/safe-execute.mjs.');
  if (!mod.adapterData) throw new Error('adapter must export adapterData({ campaignDir })');
  const adapter = await mod.adapterData({ campaignDir });
  const profErr = validateValue('target-profile.schema.json', adapter.target_profile);
  if (profErr.length) throw new Error(`adapter target_profile is schema-invalid:\n  ${profErr.join('\n  ')}`);

  const roles = {};
  for (const f of readdirSync(path.join(KIT, 'roles')).filter(f => f.endsWith('.md')).sort()) roles[f] = readText(path.join(KIT, 'roles', f));
  const modes = {};
  for (const m of config.evaluation_modes) modes[m] = readText(path.join(KIT, 'modes', `${m}.md`));
  const rubrics = {};
  for (const f of RUBRICS) rubrics[f] = readText(path.join(KIT, 'rubrics', f));
  const schemas = {};
  for (const f of readdirSync(path.join(KIT, 'schemas')).filter(f => f.endsWith('.schema.json')).sort()) schemas[f] = JSON.parse(readText(path.join(KIT, 'schemas', f)));

  const memory_seed = memorySeed(campaignDir, config.campaign_id);
  const inputs = { config, adapter: JSON.parse(JSON.stringify(adapter)), texts: { roles, modes, rubrics }, schemas, memory_seed, memory_seed_sha: seedHash(memory_seed), core_sha: sha(coreBody()) };
  inputs.inputs_sha = sha(JSON.stringify({ ...inputs, inputs_sha: undefined }));
  return inputs;
}

export function bundleScript(inputs) {
  const id = inputs.config.campaign_id;
  const maxRounds = inputs.config.stopping_rule.max_rounds ?? 3;
  const phases = [{ title: 'Characterize' }];
  for (let r = 1; r <= maxRounds; r++) phases.push({ title: `Round ${r}` });
  phases.push({ title: 'Plan' }, { title: 'Regress' });
  const meta = {
    name: `gristmill-${id}`,
    description: `Gristmill campaign ${id}: roles as subagents, gates and scoring math in code, describe-only (no target execution)`,
    phases,
  };
  return [
    `export const meta = ${JSON.stringify(meta, null, 2)}`,
    '',
    '// Generated by runner/bundle.mjs. Do not edit: rebuild from the campaign instead.',
    coreBody(),
    `const INPUTS = ${JSON.stringify(inputs)};`,
    '',
    "if (!args || typeof args.now !== 'string' || !/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ$/.test(args.now)) {",
    "  throw new Error('pass args: { now: \"<UTC ISO time from the real clock, e.g. 2026-10-26T18:04:00Z>\" }');",
    '}',
    'const io = memoryIo(INPUTS.memory_seed);',
    'const engine = workflowEngine({ agent, texts: INPUTS.texts, schemas: INPUTS.schemas, config: INPUTS.config });',
    'const res = await runCampaign({ config: INPUTS.config, engine, adapter: dataAdapter(INPUTS.adapter), io, kitDir: "", now: args.now, log });',
    'return { ...res, now: args.now, inputs_sha: INPUTS.inputs_sha, summary: io.read(res.runDir + "/summary.md") };',
    '',
  ].join('\n');
}

async function main() {
  const a = argv();
  if (!a.campaign || !a.adapter) { console.error('usage: node runner/bundle.mjs --campaign workspace/<id> --adapter <adapter.mjs>'); process.exit(2); }
  const campaignDir = path.resolve(a.campaign);
  const inputs = await buildInputs({ campaignDir, adapterPath: a.adapter });
  const outDir = path.join(campaignDir, 'workflow');
  mkdirSync(outDir, { recursive: true });
  const script = bundleScript(inputs);
  writeFileSync(path.join(outDir, 'inputs.json'), JSON.stringify(inputs));
  writeFileSync(path.join(outDir, 'campaign.workflow.js'), script);
  console.log(JSON.stringify({
    script: path.join(outDir, 'campaign.workflow.js'), bytes: script.length, inputs_sha: inputs.inputs_sha,
    memory_files: Object.keys(inputs.memory_seed).length, probes: (inputs.adapter.probes || []).length,
    launch: 'Workflow({ scriptPath: <script>, args: { now: "<UTC ISO from the real clock>" } }), then node runner/replay.mjs --campaign <dir> --transcripts <workflow transcript dir> --now <same>',
  }, null, 2));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main().catch(e => { console.error(e.message || e); process.exit(1); });
