/**
 * The no-decisions path, plus pins for the two bugs it exposed on a real 211-tool agent:
 *   - the planner looped forever when there were more strata (tools) than budgeted runs
 *   - the covering array rescored every combo for every candidate value (minutes on big agents)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQuick, resolveQuickTarget, QUICK_PRESET } from '../lib/quick.mjs';
import { planOpenWorld } from '../lib/select/planner.mjs';
import { buildCoveringArray, verifyCoverage } from '../lib/lattice/covering.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gm2q-'));

test('quick is dry, full-mapping and low-effort by construction', () => {
  assert.equal(QUICK_PRESET.allowExec, false);
  assert.equal(QUICK_PRESET.strength, 2);
  assert.ok(QUICK_PRESET.depth <= 4 && QUICK_PRESET.budget <= 20);
});

test('quick on an exact module: every layer runs and the brief has the four sections', async () => {
  const r = await runQuick({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'q1') });
  for (const h of ['## What it looked at', '## Fix first', '## How much to trust it', '## Next steps']) assert.ok(r.brief.includes(h), h);
  assert.ok(r.sequence && r.lattice && r.harness.length > 0 && r.openWorld, 'structural + sequence + lattice + L1 + plan');
  assert.ok(existsSync(join(r.outDir, 'quick.md')));
  assert.ok(!r.brief.includes('--allow-exec'), 'no exec hint for a module target');
});

test('quick never executes a compiled package unless asked, and says how to opt in', async () => {
  globalThis.__gmImportRan = false;
  const r = await runQuick({ target: 'fixtures/compiled-agent', out: join(tmp, 'q2') });
  assert.equal(r.model.tools.length, 0);
  assert.ok(r.brief.includes('It saw no tools'));
  assert.ok(r.brief.includes('--allow-exec'));
  const r2 = await runQuick({ target: 'fixtures/compiled-agent', out: join(tmp, 'q3'), allowExec: true });
  assert.equal(r2.model.tools.length, 4);
  assert.ok(r2.brief.includes('executed inside the sandbox'));
});

test('quick resolves the current directory as the target when it looks like an agent', () => {
  assert.equal(resolveQuickTarget(null, join(process.cwd(), 'fixtures', 'francisco-mini')), join(process.cwd(), 'fixtures', 'francisco-mini'));
  assert.equal(resolveQuickTarget(null, tmp), null);
});

test('planner terminates and funds the riskiest strata when strata outnumber the budget', () => {
  const cells = Array.from({ length: 60 }, (_, i) => ({ cell_id: `c${i}`, coords: { target_tool: `t${i}` }, prior: { p_fail: (i % 10) / 10, confidence: 0.5 }, severity_weight: i === 7 ? 9 : 1, prompt: 'p', injected_context: [] }));
  const model = { actors: [{ id: 'o', kind: 'orchestrator', prompt: '', tools: [] }], tools: [] };
  const plan = planOpenWorld(model, cells, [], { budget_runs: 10, holdout_fraction: 0 });
  assert.equal(plan.selected_runs, 10);
  assert.equal(plan.unfunded_strata, 50);
  assert.ok(plan.runs.some(r => r.stratum === 't7'), 'the highest-risk stratum is funded');
});

test('covering array scales: 150 values on one dimension covers every pair in seconds', () => {
  const dims = [{ name: 'tool', values: Array.from({ length: 150 }, (_, i) => `t${i}`) }, ...['a', 'b', 'c', 'd', 'e', 'f'].map(n => ({ name: n, values: ['0', '1', '2'] }))];
  const t0 = Date.now();
  const ca = buildCoveringArray(dims, { strength: 2, fullIfAtMost: 10 });
  const ms = Date.now() - t0;
  assert.deepEqual(verifyCoverage(dims, ca.rows, 2).missing, []);
  assert.ok(ms < 20000, `took ${ms}ms`);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
