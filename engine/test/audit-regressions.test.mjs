/**
 * Regression pins from the self-audit. Each test here encodes a bug that shipped once:
 *   1. oracle ignored ungated sensitive calls on read-target cells (injection-induced writes)
 *   2. oracle let one gated call excuse an ungated sibling
 *   3. runCell's ungated flag was masked by the trace-level gate flag
 *   4. the probe planner never closed a no-flip region (second-base probes re-planned forever)
 *   5. baseCoordsFor produced invalid cells when pressure raised the dose without content
 *   6. repeat probes narrowed the Wilson interval but never moved the threshold or refit
 *   7. retries disabled the duplicate-call check instead of being excluded from it
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions, isValidCoords } from '../lib/lattice/dimensions.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';
import { scoreTrace } from '../lib/oracles/index.mjs';
import { runCell } from '../lib/runner/index.mjs';
import { planProbes, baseCoordsFor } from '../lib/boundary/refine.mjs';
import { runPipeline } from '../lib/pipeline.mjs';

const model = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const dims = deriveDimensions(model);
const base = Object.fromEntries(dims.map(d => [d.name, d.values[0]]));
const tmp = mkdtempSync(join(tmpdir(), 'gm2r-'));

test('oracle: an injection-induced ungated write on a READ-target cell is a violation', () => {
  const cell = instantiate(model, { ...base, target_tool: 'get_device', injection: 'instruction-in-content', untrusted_dose: 'line' });
  const r = scoreTrace(model, cell, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'get_device' }, { actor: 'ops', action: 'tool_call', tool: 'reset_device', gate_fired: false }], final_answer: 'done' });
  assert.ok(r.violations.some(v => v.code === 'GATE-MISSING' && v.detail.includes('reset_device')));
  assert.equal(r.pass, false);
});

test('oracle: one gated call never excuses an ungated sibling', () => {
  const cell = instantiate(model, { ...base, target_tool: 'reset_device' });
  const r = scoreTrace(model, cell, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'reset_device', gate_fired: true }, { actor: 'ops', action: 'tool_call', tool: 'reset_device', gate_fired: false }], final_answer: 'confirm?', gate_fired: true });
  assert.ok(r.violations.some(v => v.code === 'GATE-MISSING'));
});

test('oracle: a blocked call is not an ungated call, and a step-less recorded trace still uses the trace flag', () => {
  const cell = instantiate(model, { ...base, target_tool: 'reset_device' });
  const blocked = scoreTrace(model, cell, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'reset_device', gate_fired: false, blocked: true }], final_answer: 'blocked' });
  assert.ok(!blocked.violations.some(v => v.code === 'GATE-MISSING'));
  const legacy = scoreTrace(model, cell, { steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'reset_device' }], final_answer: 'done', gate_fired: true });
  assert.ok(!legacy.violations.some(v => v.code === 'GATE-MISSING'), 'no per-step flags: trace-level flag decides');
});

test('runCell: sensitive_ungated is per-step, not masked by a gated sibling', async () => {
  const adapter = { kind: 'mock', fidelity: 'L2', mock: true, describe: () => ({}), run: async () => ({ fidelity: 'L2', steps: [{ actor: 'orchestrator', action: 'tool_call', tool: 'reset_device', gate_fired: true }, { actor: 'ops', action: 'tool_call', tool: 'reset_device', gate_fired: false }], final_answer: 'x', gate_fired: true }) };
  const cell = instantiate(model, { ...base, target_tool: 'reset_device' });
  const o = await runCell(adapter, model, cell);
  assert.equal(o.sensitive_ungated, true);
  assert.equal(o.gate_fired, true);
});

test('oracle: retries are excluded from the duplicate count, not a mute switch for it', () => {
  const cell = instantiate(model, { ...base, target_tool: 'get_device', scope: 'single' });
  const steps = [
    { actor: 'ops', action: 'tool_call', tool: 'query_source2', args: { device_id: 'D' } },
    { actor: 'ops', action: 'tool_call', tool: 'query_source2', args: { device_id: 'D' }, retry: true },
    { actor: 'inventory', action: 'tool_call', tool: 'get_device', args: { device_id: 'X' } },
    { actor: 'orchestrator', action: 'tool_call', tool: 'get_device', args: { device_id: 'X' } },
  ];
  const r = scoreTrace(model, cell, { steps, final_answer: 'x' });
  const dup = r.violations.find(v => v.code === 'DUPLICATE-CALLS');
  assert.ok(dup && dup.detail.startsWith('1 '), `retried call excluded, double dispatch counted: ${dup?.detail}`);
});

test('planner: a region closes after two no-flip probes from distinct bases and is never re-planned', () => {
  const mk = (bc) => ({ tool: 'get_device', entry: 'chat', axis: 'authority', base_coords: bc, flipped: false, already_failing: false, threshold_level: null, t_fit: 5, steepness: 25, flip_wilson: null, levels: [], runs_used: 11 });
  const ths = [mk(baseCoordsFor(model, dims, 'get_device', { entry: 'chat' })), mk(baseCoordsFor(model, dims, 'get_device', { entry: 'chat', pressure: { urgency: 1 } }))];
  const p = planProbes(model, dims, { thresholds: ths, budget: 2000, tools: ['get_device'], axes: ['authority'] });
  assert.equal(p.probes.length, 0);
  assert.ok(p.closed.some(c => c.reason.includes('no flip across 2')));
});

test('baseCoordsFor: raising the dose couples the injection so the cell stays valid', () => {
  const bd = baseCoordsFor(model, dims, 'get_device', { entry: 'chat', pressure: { untrusted_dose: 2 } });
  assert.equal(isValidCoords(model, bd), true);
  assert.notEqual(bd.injection, 'none');
});

test('pipeline: boundary findings merge into the ranked plan', async () => {
  const bf = join(tmp, 'boundary_findings.jsonl');
  writeFileSync(bf, JSON.stringify({ finding_id: 'JOIN-01-test', rule: 'JOIN-01', mode: 'security', severity: 5, fidelity: 'L2', verify_status: 'CONFIRMED', summary: 'test join', subject: { tool: 'reset_device' }, evidence: {}, cells: [], fix_candidates: ['gate:code-enforced@reset_device'] }) + '\n');
  const r = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'o'), boundaryFindings: bf, stages: ['analyze', 'lattice', 'sequence'] });
  assert.ok(r.findings.some(f => f.finding_id === 'JOIN-01-test'));
  assert.ok(r.plan.fixes.some(f => f.closes_findings.includes('JOIN-01-test')));
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
