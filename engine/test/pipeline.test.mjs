import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPipeline } from '../lib/pipeline.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gm2-'));
const FILES = ['model.json', 'graph.json', 'findings.jsonl', 'cells.jsonl', 'plan.json', 'open_world_plan.json', 'summary.md'];

test('full audit is deterministic: two runs produce byte-identical artifacts', async () => {
  const a = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'a'), traces: 'fixtures/example-agent/recorded_traces.jsonl' });
  const b = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'b'), traces: 'fixtures/example-agent/recorded_traces.jsonl' });
  for (const f of FILES) assert.equal(readFileSync(join(a.outDir, f), 'utf8'), readFileSync(join(b.outDir, f), 'utf8'), f);
  const ha = readdirSync(join(a.outDir, 'harness')), hb = readdirSync(join(b.outDir, 'harness'));
  assert.deepEqual(ha, hb);
  for (const f of ha) assert.equal(readFileSync(join(a.outDir, 'harness', f), 'utf8'), readFileSync(join(b.outDir, 'harness', f), 'utf8'));
});

test('the plan puts the consent gate first once replay supplies L2 evidence, and the fixed twin carries less failure mass', async () => {
  const seeded = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'c'), traces: 'fixtures/example-agent/recorded_traces.jsonl' });
  const fixed = await runPipeline({ target: 'fixtures/example-agent/agent-fixed.mjs', out: join(tmp, 'd') });
  assert.equal(seeded.plan.fixes[0].fix_id, 'gate:consent@reset_device');
  assert.ok(seeded.plan.fixes[0].rules.includes('L2-GATE-MISSING'));
  assert.ok(fixed.plan.total_weight < seeded.plan.total_weight * 0.5, `${fixed.plan.total_weight} vs ${seeded.plan.total_weight}`);
  assert.equal(seeded.plan.fixes.at(-1).cumulative_efficacy, 1);
  assert.ok(seeded.lattice.valid_cells_total > 10000 && seeded.lattice.enumerated_cells < 100);
  assert.ok(seeded.openWorld.selected_runs <= 40);
  assert.ok(['directional', 'high-confidence'].includes(seeded.plan.evidence_confidence));
});

test('generated harness tests are runnable node:test files that import the real target', async () => {
  const r = await runPipeline({ target: 'fixtures/example-agent/agent.mjs', out: join(tmp, 'e'), stages: ['analyze', 'lattice', 'synth'] });
  const files = readdirSync(join(r.outDir, 'harness'));
  assert.equal(files.length, 11);
  const src = readFileSync(join(r.outDir, 'harness', 'get_source_config.test.mjs'), 'utf8');
  assert.ok(src.includes("from 'node:test'") && src.includes('probeTool') && src.includes('SECRET-IN-OUTPUT'));
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
