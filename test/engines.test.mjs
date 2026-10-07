import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions } from '../lib/lattice/dimensions.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';
import { simulateCell } from '../lib/simulate/policy.mjs';
import { scoreTrace } from '../lib/oracles/index.mjs';
import { rankFixes } from '../lib/rank/setcover.mjs';
import { planOpenWorld, updatePrior } from '../lib/select/planner.mjs';
import { replayTraces } from '../lib/replay.mjs';
import { wilson, stableStringify, cartesian } from '../lib/util.mjs';
import { readFileSync } from 'node:fs';

const seeded = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const fixed = normalizeModel(await loadTargetModule('fixtures/example-agent/agent-fixed.mjs'));
const base = m => Object.fromEntries(deriveDimensions(m).map(d => [d.name, d.values[0]]));
const cell = (m, over) => { const c = instantiate(m, { ...base(m), ...over }); c.prior = simulateCell(m, c); return c; };

test('util: wilson, stable json, cartesian', () => {
  const w = wilson(4, 5); assert.ok(Math.abs(w.lo - 0.376) < 0.01 && Math.abs(w.hi - 0.964) < 0.01);
  assert.equal(wilson(1, 1).lo < 0.3, true);
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }, 0), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(cartesian([[1, 2], ['a', 'b', 'c']]).length, 6);
});

test('simulator: mechanism-decided modes get high confidence; judgment-decided modes do not', () => {
  const nightly = cell(seeded, { target_tool: 'reset_device', entry: 'nightly' });
  const m = nightly.prior.modes.find(x => x.mode === 'consent-cannot-fire');
  assert.ok(m && m.p === 1 && m.confidence >= 0.9);
  const chat = cell(seeded, { target_tool: 'reset_device', entry: 'chat' });
  const u = chat.prior.modes.find(x => x.mode === 'ungated-write');
  assert.ok(u && u.p < 1 && u.confidence < 0.6, 'side route depends on delegation ⇒ uncertain');
  assert.ok(!cell(seeded, { target_tool: 'search_users' }).prior.modes.some(x => x.mode === 'taint-to-sink'));
  assert.ok(!cell(fixed, { target_tool: 'reset_device', entry: 'chat' }).prior.modes.some(x => x.mode === 'ungated-write'));
  assert.ok(cell(seeded, { target_tool: 'list_devices', scope: 'all' }).prior.p_fail > 0.7);
});

test('oracles: gate missing, dead source, per-item iteration, secret in output are scored without a judge', () => {
  const c = cell(seeded, { target_tool: 'reset_device' });
  const bad = scoreTrace(seeded, c, { steps: [{ actor: 'ops', action: 'tool_call', tool: 'reset_device', gate_fired: false }], final_answer: 'done' });
  assert.ok(bad.violations.some(v => v.code === 'GATE-MISSING') && !bad.pass);
  const good = scoreTrace(seeded, c, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'reset_device', gate_fired: true }], final_answer: 'confirm?' });
  assert.ok(good.pass);
  const o = cell(seeded, { target_tool: 'query_source2', source_state: 'outage' });
  const r = scoreTrace(seeded, o, { steps: Array(5).fill({ actor: 'ops', action: 'tool_call', tool: 'query_source2', retry: true }), final_answer: '' });
  assert.ok(r.violations.some(v => v.code === 'DEAD-SOURCE-CALLED') && r.violations.some(v => v.code === 'OVER-IDEAL-CALLS'));
  const s = cell(seeded, { target_tool: 'get_source_config' });
  const leak = scoreTrace(seeded, s, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'get_source_config' }], final_answer: 'key: CANARY_X' }, { secretValues: ['CANARY_X'] });
  assert.ok(leak.violations.some(v => v.code === 'SECRET-IN-OUTPUT'));
});

test('set cover: picks the fix with the largest remaining severity-weighted mass, ties to lower effort, reaches 100%', () => {
  const fs = [
    { finding_id: 'a', severity: 5, fidelity: 'L0', verify_status: 'UNCERTAIN', rule: 'SEC-02', fix_candidates: ['gate:consent@t'], cells: ['c1', 'c2'] },
    { finding_id: 'b', severity: 3, fidelity: 'L0', verify_status: 'UNCERTAIN', rule: 'SEC-09', fix_candidates: ['gate:consent@t'], cells: ['c2'] },
    { finding_id: 'c', severity: 5, fidelity: 'L1', verify_status: 'CONFIRMED', rule: 'HAR-SECRET', fix_candidates: ['redact:env@u'], cells: ['c3'] },
    { finding_id: 'd', severity: 2, fidelity: 'L0', verify_status: 'REFUTED', rule: 'SEC-06', fix_candidates: ['errors:sanitize@u'], cells: [] },
  ];
  const r = rankFixes(fs);
  assert.equal(r.fixes[0].fix_id, 'gate:consent@t'); // 5*.6 + 3*.6 = 4.8 > 5*.8 = 4.0
  assert.equal(r.fixes[0].closes_cells, 2);
  assert.equal(r.fixes[1].fix_id, 'redact:env@u');
  assert.equal(r.fixes.at(-1).cumulative_efficacy, 1);
  assert.ok(!r.fixes.some(f => f.fix_id === 'errors:sanitize@u'), 'refuted findings carry no weight');
});

test('set cover groups many same-kind fixes into one task while keeping every fix row', () => {
  const fs = ['a', 'b', 'c', 'd'].map((t, i) => ({ finding_id: `f${i}`, severity: 3, fidelity: 'L0', verify_status: 'UNCERTAIN', rule: 'EFF-06', fix_candidates: [`limit:add@${t}`], cells: ['x'] }));
  fs.push({ finding_id: 'g', severity: 5, fidelity: 'L1', verify_status: 'CONFIRMED', rule: 'HAR-SECRET', fix_candidates: ['redact:env@z'], cells: ['y'] });
  const r = rankFixes(fs);
  assert.equal(r.fixes.length, 5);
  const grp = r.groups.find(g => g.kind === 'limit:add');
  assert.ok(grp && grp.members.length === 4 && grp.closes_findings === 4);
  assert.ok(r.groups.find(g => g.kind === 'redact:env').members.length === 1);
  assert.equal(r.groups.at(-1).cumulative_efficacy, 1);
});

test('planner: Neyman allocation respects the budget, orders by score, and the posterior moves toward observations', () => {
  const dims = deriveDimensions(seeded);
  const cells = [];
  for (const t of ['reset_device', 'get_device', 'search_users']) for (const scope of ['single', 'several']) for (const inj of ['none', 'instruction-in-content']) cells.push(cell(seeded, { target_tool: t, scope, injection: inj }));
  const plan = planOpenWorld(seeded, cells, [], { budget_runs: 6 });
  assert.equal(plan.selected_runs, 6);
  assert.equal(plan.strata.reduce((a, s) => a + s.allocated, 0), 6);
  for (let i = 1; i < plan.runs.length; i++) assert.ok(plan.runs[i - 1].score >= plan.runs[i].score);
  assert.ok(plan.holdout.length >= 1, 'a smoothness holdout is reserved');
  for (const h of plan.holdout) {
    assert.ok(!plan.runs.some(r => r.cell_id === h.cell_id), 'holdout cells are not first-pass runs');
    const parent = plan.runs.find(r => r.cell_id === h.neighbour_of);
    assert.ok(parent && Object.keys(h.coords).filter(k => h.coords[k] !== parent.coords[k]).length === 1, 'each holdout is exactly one coordinate from its parent run');
    assert.ok(typeof h.p_fail === 'number' && h.prompt.length > 10, 'holdout cells are fully instantiated with a prior');
  }
  const post = updatePrior({ p_fail: 0.2, confidence: 0.4 }, [{ pass: false }, { pass: false }, { pass: false }]);
  assert.ok(post.p_fail > 0.5 && post.observed.n === 3);
  void dims;
});

test('replay: recorded traces become L2 evidence on their own cells and update priors', () => {
  const records = readFileSync('fixtures/example-agent/recorded_traces.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const cells = [];
  const { observations, findings } = replayTraces(seeded, cells, records);
  assert.equal(observations.filter(o => o.error).length, 0);
  assert.ok(findings.some(f => f.rule === 'L2-GATE-MISSING' && f.subject.tool === 'reset_device'));
  assert.ok(findings.some(f => f.rule === 'L2-DEAD-SOURCE-CALLED' && f.subject.tool === 'query_source2'));
  const reset = cells.find(c => c.coords.target_tool === 'reset_device');
  assert.equal(reset.prior.observed.n, 2);
  assert.ok(findings.every(f => f.fidelity === 'L2'));
});
