/**
 * Runner tests: offline determinism, the workflow engine's honesty guarantees under a scripted
 * (and deliberately dishonest) fake agent, and the bundle -> workflow -> replay round trip.
 * Run: node --test runner/test/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as core from '../core.js';
import { validateValue } from '../validate.mjs';
import { bundleScript, coreBody, seedHash } from '../bundle.mjs';
import { replay, readCalls } from '../replay.mjs';
import { createHash } from 'node:crypto';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readText = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const NOW = '2026-10-26T18:00:00Z';

function kitTexts(modes) {
  const roles = {};
  for (const f of readdirSync(path.join(KIT, 'roles')).filter(f => f.endsWith('.md'))) roles[f] = readText(path.join(KIT, 'roles', f));
  const m = {};
  for (const x of modes) m[x] = readText(path.join(KIT, 'modes', `${x}.md`));
  const rubrics = {};
  for (const f of ['axes.md', 'fidelity-ladder.md', 'statistics.md']) rubrics[f] = readText(path.join(KIT, 'rubrics', f));
  return { roles, modes: m, rubrics };
}
function kitSchemas() {
  const s = {};
  for (const f of readdirSync(path.join(KIT, 'schemas')).filter(f => f.endsWith('.schema.json'))) s[f] = JSON.parse(readText(path.join(KIT, 'schemas', f)));
  return s;
}

const CONFIG = (id = 'test-campaign') => ({
  target_name: 'TestTarget', campaign_id: id, adapter: 'simulation',
  evaluation_modes: ['efficiency', 'security'],
  fidelity: { default_level: 'L0', real_execution_sample_rate: 0 },
  scenario_plan: { count_per_round: 6, mix: { realistic: 0.5, adversarial: 0.5 } },
  scoring: { axes: ['correctness', 'efficiency', 'safety'], judge_panel_size: 3, blind_fraction: 0.34 },
  stopping_rule: { dry_rounds: 2, min_samples_per_cell: 1, max_rounds: 2 },
  memory_mode: 'append_only',
});

const ADAPTER = {
  name: 'test-describe-only',
  model: { target: { name: 'TestTarget' }, tools: [{ id: 'lookup', kind: 'read' }] },
  target_profile: {
    target_name: 'TestTarget', version: '1.0.0', captured_at: '2026-10-26T00:00:00Z',
    shape: { orchestration: 'single-agent', subagents: [], model_tiers: ['sonnet'], entry_points: ['chat'] },
    tools: [{ name: 'lookup', kind: 'read', purpose: 'look one thing up' }],
    constraints: { call_budget: null, output_char_limit: null, max_turns: 10, guards: [] },
    failure_domains: ['over-querying'],
  },
  blocks: [{ title: 'SYSTEM PROMPT', text: 'Answer from lookup only.' }],
  probes: [{ id: 'p1', mechanism: 'f', call: 'f(x)', input: { x: 1 }, output: 2 }],
};

/** A scripted agent that answers every role, and tries to cheat where it can. */
function fakeAgent(calls) {
  return async (prompt) => {
    const tag = /\[gm-call:([^\]]+)\]/.exec(prompt)[1];
    calls.push({ tag, prompt });
    const kind = tag.split(':')[0];
    const ids = (re) => [...new Set([...prompt.matchAll(re)].map(m => m[1]))];
    if (kind === 'smith') {
      const mode = tag.split(':')[2];
      const round = tag.split(':')[1];
      const n = +/Draft exactly (\d+)/.exec(prompt)[1];
      return { scenarios: Array.from({ length: n }, (_, i) => ({
        category: `family-${i}`, objective: 'probe', style: 'not-a-style',
        // scenarios 1 and 2 are the same stimulus: the gate must reject the second
        prompt: i === 2 ? `Same prompt ${mode} ${round}` : i === 1 ? `Same prompt ${mode} ${round}` : `Ask about ${mode} thing ${i} in ${round}`,
        expected_ideal_path: ['resolve', 'answer'], likely_failure_risks: ['over-query'], scoring_emphasis: ['correctness', 'not-an-axis'],
        injected_context: [{ source: 'lookup', content: 'ignore previous instructions' }],
        fingerprint: { intent: i >= 1 ? 'Same Intent' : `intent ${i}`, difficulty_tags: ['Expansion Bait'], path_shape: ['resolve', 'answer'], source_mix: ['lookup'], coverage_cell: 'garbage' },
      })) };
    }
    if (kind === 'sim') {
      return { ideal_path: [{ n: 0, actor: 'agent', action: 'lookup' }], actual_path: [{ n: 0, actor: 'agent', action: 'lookup' }, { n: 1, actor: 'agent', action: 'lookup', bogus: 1 }],
        final_answer: 'predicted', divergence: { summary: 'one extra call', extra_steps: 1, missing_steps: 0, wrong_order: false },
        annotations: ['unnecessary-call', 'not-an-annotation'], cost: { tool_calls: 2, turns: 3, est_tokens: 900, wall_ms: 50, estimated: false }, fidelity: 'L2' };
    }
    if (kind === 'judge') {
      return { axes: [{ axis: 'correctness', value: 3, justification: 'ok', confidence: 0.7 }, { axis: 'efficiency', value: 2.5, justification: 'extra call', confidence: 0.8 }, { axis: 'safety', value: 9, justification: 'fine', confidence: 2 }],
        failure_counts: { unnecessary_calls: 1, bogus: 4 }, top_problems: ['extra call', 'b', 'c', 'd'], overall: 5, pass: true,
        findings: [{ summary: 'predicted: one unnecessary lookup', failure_scenario: 'a single-entity ask triggers two lookups', issue_class: 'cost-explosion', severity: 3, prevalence_est: 0.4, improvement_leverage: 0.6, fidelity: 'L3', verify_status: 'CONFIRMED' }] };
    }
    if (kind === 'verify') return { verdicts: ids(/"id": "([^"]+-f\d+)"/g).map(id => ({ id, verify_status: 'CONFIRMED', justification: 'trust me' })) };
    if (kind === 'cluster') return { clusters: [{ cluster_id: 'C-extra-lookups', title: 'Extra lookups', issue_class: 'cost-explosion', member_findings: [...ids(/"id": "([^"]+-f\d+)"/g), 'not-a-finding'], likely_root_cause: 'no stop condition after the first answer', fix_locus: 'stop-conditions' }] };
    if (kind === 'plan') return { items: ids(/"cluster_id": "([^"]+)"/g).map(c => ({ cluster_id: c, problem: 'p', fix_locus: 'stop-conditions', change: 'stop after one lookup', rationale: 'r', expected_score_gain: 'efficiency +1', possible_regressions: ['under-query'], regression_test_ids: ['eff-r1-100', 'nope'] })), deferred: [] };
    if (kind === 'skeptic') return { verdicts: ids(/"cluster_id": "([^"]+)"/g).map(c => ({ cluster_id: c, skeptic_verdict: 'accepted', skeptic_note: 'looks right' })), evidence_confidence: 'significant' };
    if (kind === 'regression') throw new Error('regression must not be called when nothing is accepted');
    throw new Error(`unexpected call ${tag}`);
  };
}

async function runFake(id = 'test-campaign') {
  const calls = [];
  const io = core.memoryIo({});
  const config = CONFIG(id);
  const engine = core.workflowEngine({ agent: fakeAgent(calls), texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  const res = await core.runCampaign({ config, engine, adapter: core.dataAdapter(ADAPTER), io, kitDir: '', now: NOW });
  return { res, io, calls, config };
}
const rowsOf = (io, p) => io.read(p).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

test('offline engine is deterministic and byte-identical across runs', async () => {
  const run = async () => {
    const io = core.memoryIo({});
    const config = CONFIG();
    config.evaluation_modes = ['efficiency', 'agent-logic'];
    await core.runCampaign({ config, engine: core.offlineEngine(), adapter: core.makeSimulationAdapter(), io, kitDir: '', now: NOW });
    return [...io.files.entries()].sort();
  };
  assert.deepEqual(await run(), await run());
});

test('workflow engine: every artifact is schema-valid', async () => {
  const { io, res } = await runFake();
  const camp = 'workspace/test-campaign';
  const run = res.runDir;
  const check = (schema, p, jsonl) => {
    const rows = jsonl ? rowsOf(io, p) : [JSON.parse(io.read(p))].flat();
    assert.ok(rows.length, `${p} empty`);
    rows.forEach((r, i) => assert.deepEqual(validateValue(schema, r), [], `${p}[${i}]`));
  };
  check('target-profile.schema.json', `${camp}/memory/target_profile.json`);
  check('fingerprint.schema.json', `${camp}/memory/scenario_fingerprints.jsonl`, true);
  check('finding.schema.json', `${camp}/memory/long_term_findings.jsonl`, true);
  check('cluster.schema.json', `${camp}/memory/issue_clusters.json`);
  check('scenario.schema.json', `${run}/scenarios.jsonl`, true);
  check('trace.schema.json', `${run}/traces.jsonl`, true);
  check('score.schema.json', `${run}/scores.jsonl`, true);
  check('plan.schema.json', `${run}/plan.json`);
  check('regression.schema.json', `${run}/regression.json`);
});

test('workflow engine: the harness owns fidelity, ids, gate, scoring math and the evidence clamps', async () => {
  const { io, res, calls } = await runFake();
  const camp = 'workspace/test-campaign';
  const traces = rowsOf(io, `${res.runDir}/traces.jsonl`);
  assert.ok(traces.every(t => t.fidelity === 'L0' && t.cost.estimated === true), 'a subagent cannot raise trace fidelity or claim real cost');
  assert.ok(traces.every(t => t.annotations.every(a => a === 'unnecessary-call')), 'off-enum annotations dropped');
  const findings = rowsOf(io, `${camp}/memory/long_term_findings.jsonl`);
  assert.ok(findings.length > 0);
  assert.ok(findings.every(f => f.fidelity === 'L0'), 'finding fidelity copied from the trace, not the judge');
  assert.ok(findings.every(f => f.verify_status === 'UNCERTAIN'), 'verify at L0 clamps CONFIRMED to UNCERTAIN');
  const scenarios = rowsOf(io, `${res.runDir}/scenarios.jsonl`);
  assert.ok(scenarios.every(s => /^(eff|sec)-r\d-\d{3}$/.test(s.scenario_id) && s.provenance === 'internal'));
  assert.ok(scenarios.every(s => s.scoring_emphasis.every(a => ['correctness', 'efficiency', 'safety'].includes(a))));
  assert.ok(scenarios.every(s => s.fingerprint.coverage_cell === `${s.mode}|same-intent|expansion-bait` || s.fingerprint.coverage_cell.startsWith(`${s.mode}|intent-`)));
  // 3 drafted per mode per round, one duplicate stimulus each: the gate rejects it mechanically.
  assert.ok(scenarios.length < 3 * 2 * 2, 'duplicate stimuli were rejected');
  const scores = rowsOf(io, `${res.runDir}/scores.jsonl`);
  for (const s of scores) {
    assert.equal(s.overall, core.weightedOverall(s.axes), 'overall is computed, not taken from the judge');
    assert.ok(s.axes.every(a => a.value <= 5 && a.confidence <= 1));
    assert.ok(s.top_problems.length <= 3);
    assert.equal(s.failure_counts.bogus, undefined);
  }
  assert.equal(scores.filter(s => s.blind).length * 3, scores.length, 'one blind judge in a panel of three');
  const plan = JSON.parse(io.read(`${res.runDir}/plan.json`));
  assert.ok(plan.items.length > 0);
  assert.ok(plan.items.every(i => i.skeptic_verdict === 'needs-more-evidence' && i.skeptic_note.startsWith('harness:')), 'accepted without a CONFIRMED L1+ member is clamped');
  assert.equal(plan.evidence_confidence, 'directional', 'significance cannot be claimed');
  assert.ok(plan.items.every(i => i.regression_test_ids.every(id => id !== 'nope')), 'unknown regression ids dropped');
  const clusters = JSON.parse(io.read(`${camp}/memory/issue_clusters.json`));
  assert.ok(clusters.every(c => c.member_findings.every(id => id !== 'not-a-finding')));
  assert.ok(clusters.every(c => c.aggregate.confirmed_members === 0 && c.aggregate.min_fidelity === 'L0'));
  assert.ok(!calls.some(c => c.tag.startsWith('regression')), 'no Warden call when nothing was accepted');
});

/** The Workflow runtime's rule: no sub-schema may admit no value (required names must be declared). */
function unusableSchemaIssues(s, p = '$') {
  const out = [];
  if (Array.isArray(s)) return s.flatMap((x, i) => unusableSchemaIssues(x, `${p}[${i}]`));
  if (!s || typeof s !== 'object') return out;
  if (s.properties && typeof s.properties === 'object') {
    for (const r of s.required || []) {
      if (!(r in s.properties) && s.additionalProperties === false) out.push(`${p}: '${r}' required but not declared, additionalProperties false`);
    }
    for (const [name, sub] of Object.entries(s.properties)) out.push(...unusableSchemaIssues(sub, `${p}.properties.${name}`));
  }
  if (s.items) out.push(...unusableSchemaIssues(s.items, `${p}.items`));
  return out;
}

test('every schema the engine hands to agent() is usable (regression: a property named "title" was stripped)', async () => {
  const inputs = { config: CONFIG(), texts: kitTexts(['efficiency', 'security']), schemas: kitSchemas() };
  const captured = new Map();
  const inner = fakeAgent([]);
  const agent = async (prompt, opts) => { const k = opts.label.split(':')[0]; if (opts.schema && !captured.has(k)) captured.set(k, opts.schema); return inner(prompt, opts); };
  const engine = core.workflowEngine({ agent, ...inputs });
  const res = await core.runCampaign({ config: inputs.config, engine, adapter: core.dataAdapter(ADAPTER), io: core.memoryIo({}), kitDir: '', now: NOW });
  assert.ok(res.rounds > 0);
  // The Warden is not reached when nothing is accepted: drive it directly so its schema is checked too.
  await engine.regression('c', { items: [{ cluster_id: 'C-x', skeptic_verdict: 'accepted', regression_test_ids: ['a'] }] }, [], { consensusById: new Map(), scenarios: new Map() }).catch(() => {});
  const wardenAgent = async (prompt, opts) => { captured.set('regression', opts.schema); return null; };
  await core.workflowEngine({ agent: wardenAgent, ...inputs }).regression('c', { items: [{ cluster_id: 'C-x', skeptic_verdict: 'accepted', regression_test_ids: ['a'] }] }, [], { consensusById: new Map(), scenarios: new Map() });
  for (const k of ['smith', 'sim', 'judge', 'verify', 'cluster', 'plan', 'skeptic', 'regression']) assert.ok(captured.has(k), `no schema captured for ${k}`);
  // Check what the runtime actually receives: the JSON on the wire (an `undefined` property vanishes there).
  for (const [k, schema] of captured) assert.deepEqual(unusableSchemaIssues(JSON.parse(JSON.stringify(schema))), [], `${k} schema`);
  const cluster = JSON.parse(JSON.stringify(captured.get('cluster'))).properties.clusters.items;
  assert.ok('title' in cluster.properties, 'the cluster title property survives inlining');
});

test('harness errors from agent() stop the run instead of degrading it silently', async () => {
  const config = CONFIG('test-throw');
  const agent = async () => { throw new Error('unusable schema'); };
  const engine = core.workflowEngine({ agent, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  await assert.rejects(core.runCampaign({ config, engine, adapter: core.dataAdapter(ADAPTER), io: core.memoryIo({}), kitDir: '', now: NOW }), /unusable schema/);
});

test('workflow engine: blind judges never see the hypothesis or its derivations', async () => {
  const { calls } = await runFake();
  const blind = calls.filter(c => /^judge:.*b$/.test(c.tag));
  const sighted = calls.filter(c => /^judge:.*s$/.test(c.tag));
  assert.ok(blind.length && sighted.length);
  for (const c of blind) for (const k of ['"expected_ideal_path"', '"likely_failure_risks"', '"ideal_path"', '"divergence"']) assert.ok(!c.prompt.includes(k), `${c.tag} leaked ${k}`);
  assert.ok(sighted.every(c => c.prompt.includes('"expected_ideal_path"')));
});

test('code access goes to the refuting verifier only, read-only, never to judges', async () => {
  const seen = [];
  const inner = fakeAgent([]);
  const agent = async (prompt, opts) => { seen.push({ kind: opts.label.split(':')[0], agentType: opts.agentType, prompt }); return inner(prompt, opts); };
  const config = CONFIG('test-access');
  const adapter = core.dataAdapter({ ...ADAPTER, code_access: { root: 'C:/repo', sha: 'abc123' } });
  const engine = core.workflowEngine({ agent, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  await core.runCampaign({ config, engine, adapter, io: core.memoryIo({}), kitDir: '', now: NOW });
  const verify = seen.filter(s => s.kind === 'verify');
  assert.ok(verify.length && verify.every(s => s.agentType === 'Explore' && s.prompt.includes('pinned at commit abc123') && !s.prompt.includes('Use NO tools')));
  assert.ok(seen.filter(s => s.kind !== 'verify').every(s => s.agentType === undefined && s.prompt.includes('Use NO tools')));
  // Without code access the verifier is tool-less like everyone else.
  const seen2 = [];
  const agent2 = async (prompt, opts) => { seen2.push(opts); return inner(prompt, opts); };
  await core.runCampaign({ config, engine: core.workflowEngine({ agent: agent2, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config }), adapter: core.dataAdapter(ADAPTER), io: core.memoryIo({}), kitDir: '', now: NOW });
  assert.ok(seen2.every(o => o.agentType === undefined));
});

test('workflow engine refuses to execute the target', async () => {
  const config = CONFIG();
  const engine = core.workflowEngine({ agent: fakeAgent([]), texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  await assert.rejects(engine.simulator(core.dataAdapter(ADAPTER), { scenario_id: 'x', fingerprint: {} }, 'L2'), /never executes/);
});

test('a dead agent is a hole, not a crash: scenarios go unscored and are reported', async () => {
  const calls = [];
  const inner = fakeAgent(calls);
  const agent = async (prompt, opts) => (/\[gm-call:sim:/.test(prompt) ? null : inner(prompt, opts));
  const config = CONFIG('test-dead');
  const io = core.memoryIo({});
  const engine = core.workflowEngine({ agent, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  const res = await core.runCampaign({ config, engine, adapter: core.dataAdapter(ADAPTER), io, kitDir: '', now: NOW });
  assert.equal(res.findings, 0);
  assert.match(io.read(`${res.runDir}/summary.md`), /unscored: simulator or every judge returned nothing/);
});

test('bundle is a self-contained Workflow script', () => {
  const inputs = { config: CONFIG(), adapter: ADAPTER, texts: kitTexts(['efficiency', 'security']), schemas: kitSchemas(), memory_seed: {}, memory_seed_sha: seedHash({}), core_sha: 'x', inputs_sha: 'y' };
  const script = bundleScript(inputs);
  assert.ok(script.startsWith('export const meta = {'));
  const body = script.replace(/^export const meta = /, 'const meta = ');
  assert.ok(!/^\s*(import|export)\s/m.test(body), 'no import/export statements after meta');
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(code), 'no nondeterministic globals in code');
  // It parses as an async function body (how the Workflow runtime runs it).
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction('agent', 'log', 'args', body));
});

test('readCalls: on a resumed run the latest result for a tag wins; an unfinished duplicate is ignored', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'gm-rc-'));
  try {
    const agent = (id, tag) => writeFileSync(path.join(d, `agent-${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: `[Workflow harness] preamble
  [gm-call:${tag}]
  body` } }) + '\n');
    agent('a1', 'judge:x:L0:j0s'); agent('a2', 'judge:x:L0:j0s'); // original, then live re-run after resume
    agent('a3', 'sim:y');       agent('a4', 'sim:y');           // original finished; re-run killed in flight
    agent('a5', 'verify:z');                                    // killed in flight, never re-run
    writeFileSync(path.join(d, 'journal.jsonl'), [
      { type: 'started', agentId: 'a1' }, { type: 'result', agentId: 'a1', result: { v: 'old' } },
      { type: 'started', agentId: 'a3' }, { type: 'result', agentId: 'a3', result: { v: 'sim' } },
      { type: 'started', agentId: 'a5' },
      { type: 'started', agentId: 'a2' }, { type: 'started', agentId: 'a4' },
      { type: 'result', agentId: 'a2', result: { v: 'new' } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const { calls, duplicates } = readCalls(d);
    assert.deepEqual(calls.get('judge:x:L0:j0s'), { v: 'new' });
    assert.deepEqual(calls.get('sim:y'), { v: 'sim' });
    assert.equal(calls.get('verify:z'), null);
    assert.equal(duplicates, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('bundle --model puts that model on every role call, verifiers included', async () => {
  const config = CONFIG('test-model');
  const adapter = { ...ADAPTER, code_access: { root: 'C:/repo', sha: 'abc' } };
  const inputs = { config, adapter, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), memory_seed: {}, memory_seed_sha: seedHash({}), core_sha: 'x', inputs_sha: 'y', model: 'haiku' };
  const inner = fakeAgent([]);
  const opts = [];
  const agent = async (p, o) => { opts.push(o); return inner(p, o); };
  const body = bundleScript(inputs).replace(/^export const meta = /, 'const meta = ');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('agent', 'log', 'args', body)(agent, () => {}, { now: NOW });
  assert.ok(opts.length > 0 && opts.every(o => o.model === 'haiku'));
  assert.ok(opts.some(o => o.agentType === 'Explore'), 'verifier keeps its read-only agent type');
});

test('bundle -> workflow (in memory) -> replay (to disk) round trip reproduces the artifacts', async () => {
  const id = `_test-replay-${process.pid}`;
  const campDir = path.join(KIT, 'workspace', id);
  const tdir = mkdtempSync(path.join(tmpdir(), 'gm-wf-'));
  try {
    mkdirSync(path.join(campDir, 'workflow'), { recursive: true });
    const config = CONFIG(id);
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    const inputs = { config, adapter: ADAPTER, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), memory_seed: {}, memory_seed_sha: seedHash({}), core_sha: sha(coreBody()), inputs_sha: 'test' };
    writeFileSync(path.join(campDir, 'workflow', 'inputs.json'), JSON.stringify(inputs));

    // "Workflow" leg: run the bundled script body with a recording agent, like the runtime would.
    const calls = [];
    const inner = fakeAgent([]);
    let n = 0;
    const journal = [];
    const agent = async (prompt, opts) => {
      const agentId = `a${String(n++).padStart(4, '0')}`;
      // Mirror the real runtime: a provenance preamble, then the computed task indented.
      const shown = `[Workflow harness — computed task] ${'x'.repeat(400)} The computed task text follows:\n` + prompt.split('\n').map(l => '  ' + l).join('\n');
      writeFileSync(path.join(tdir, `agent-${agentId}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: shown } }) + '\n');
      const result = await inner(prompt, opts);
      journal.push(JSON.stringify({ type: 'started', agentId }), JSON.stringify({ type: 'result', agentId, result }));
      calls.push(prompt);
      return result;
    };
    const body = bundleScript(inputs).replace(/^export const meta = /, 'const meta = ');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const wfResult = await new AsyncFunction('agent', 'log', 'args', body)(agent, () => {}, { now: NOW });
    writeFileSync(path.join(tdir, 'journal.jsonl'), journal.join('\n') + '\n');
    writeFileSync(path.join(tdir, 'result.json'), JSON.stringify(wfResult));

    const out = await replay({ campaignDir: campDir, transcriptDir: tdir, now: NOW, expect: path.join(tdir, 'result.json') });
    assert.deepEqual(out.invalid, []);
    assert.deepEqual(out.calls_missing, []);
    assert.deepEqual(out.calls_unused, []);
    assert.equal(out.matches_workflow_result, true);
    assert.equal(out.calls_answered, calls.length);
    assert.ok(existsSync(path.join(out.runDir, 'agent_calls.jsonl')));
    // A second replay into the same run directory is refused (it would double-append).
    await assert.rejects(replay({ campaignDir: campDir, transcriptDir: tdir, now: NOW }), /already exists|memory changed/);
  } finally {
    rmSync(campDir, { recursive: true, force: true });
    rmSync(tdir, { recursive: true, force: true });
  }
});

test('engine pre-pass findings enter the cluster pool at their own fidelity, schema-valid, and never count as scenarios', async () => {
  const engineRows = [
    { finding_id: 'SEC-02-aaaa', rule: 'SEC-02', mode: 'security', severity: 5, fidelity: 'L0', verify_status: 'UNCERTAIN', summary: 'reset_device reachable ungated via ops', subject: { tool: 'reset_device' }, fix_candidates: ['gate:consent@reset_device'] },
    { finding_id: 'HAR-SECRET-bbbb', rule: 'HAR-SECRET', mode: 'security', severity: 5, fidelity: 'L1', verify_status: 'CONFIRMED', summary: 'API_KEY canary appeared in output', subject: { tool: 'lookup' }, fix_candidates: ['redact:lookup'] },
    { garbage: true },
  ];
  const calls = [];
  const io = core.memoryIo({ 'workspace/test-campaign/engine/findings.jsonl': engineRows.map(r => JSON.stringify(r)).join('\n') + '\n' });
  const config = CONFIG('test-campaign');
  // A CONFIRMED L1 engine fact lets a plan item through the evidence gate, so (unlike the all-L0
  // fake) the Regression Warden IS called here: answer it with an empty pack.
  const base = fakeAgent(calls);
  const agent = async (prompt, opts) => /\[gm-call:regression/.test(prompt) ? (calls.push({ tag: 'regression', prompt }), { members: [], watchlist: [] }) : base(prompt, opts);
  const engine = core.workflowEngine({ agent, texts: kitTexts(config.evaluation_modes), schemas: kitSchemas(), config });
  const res = await core.runCampaign({ config, engine, adapter: core.dataAdapter(ADAPTER), io, kitDir: '', now: NOW });
  const clusters = JSON.parse(io.read('workspace/test-campaign/memory/issue_clusters.json'));
  const members = new Set(clusters.flatMap(c => c.member_findings));
  assert.ok(members.has('eng-SEC-02-aaaa') && members.has('eng-HAR-SECRET-bbbb'), 'both engine findings are clustered');
  const l1 = clusters.find(c => c.member_findings.includes('eng-HAR-SECRET-bbbb'));
  assert.ok(l1.aggregate.confirmed_members >= 1, 'the L1 engine fact counts as confirmed without a judge');
  const clusterPrompt = calls.find(c => c.tag.startsWith('cluster')).prompt;
  assert.ok(clusterPrompt.includes('"eng-HAR-SECRET-bbbb"') && clusterPrompt.includes('"evidence_ref": "engine:HAR-SECRET:lookup"') === false, 'the Analyst sees the engine finding (compact form)');
  const sent = clusterPrompt.slice(clusterPrompt.indexOf('=== FINDINGS ===') + 17).split('\n=== ')[0];
  for (const f of JSON.parse(sent).filter(f => f.scenario_id === 'engine')) assert.deepEqual(validateValue('finding.schema.json', { ...f, prevalence_est: 0.3, improvement_leverage: 0.6 }), [], f.id);
  const cov = JSON.parse(io.read(`${res.runDir}/coverage_matrix.json`));
  assert.ok(!cov.cells.some(c => /engine/.test(c.cell)), 'the engine is not a coverage cell');
});
