import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions, isValidCoords, latticeSize } from '../lib/lattice/dimensions.mjs';
import { buildCoveringArray, verifyCoverage } from '../lib/lattice/covering.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';

const model = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const dims = deriveDimensions(model);
const valid = c => isValidCoords(model, c);

test('pairwise covering array covers every realizable 2-way interaction with a tiny row count', () => {
  const ca = buildCoveringArray(dims, { strength: 2, fullIfAtMost: 10, isValid: valid });
  assert.equal(ca.method, 'greedy-2-wise');
  assert.ok(ca.rows.every(valid), 'all rows satisfy constraints');
  const v = verifyCoverage(dims, ca.rows, 2, valid);
  assert.deepEqual(v.missing, [], 'no realizable pair left uncovered');
  assert.ok(ca.rows.length < 200 && ca.rows.length >= 16, `rows=${ca.rows.length}`);
});

test('3-wise covering array also covers every realizable triple', () => {
  const ca = buildCoveringArray(dims, { strength: 3, fullIfAtMost: 10, isValid: valid });
  const v = verifyCoverage(dims, ca.rows, 3, valid);
  assert.deepEqual(v.missing, []);
  assert.ok(ca.rows.length > 100);
});

test('full product is used when the lattice is small enough, and equals the exact valid count', () => {
  const small = dims.slice(0, 4);
  const ca = buildCoveringArray(small, { strength: 2, fullIfAtMost: 100000, isValid: valid });
  assert.equal(ca.method, 'full-product');
  const expected = latticeSize(model, small).valid;
  assert.equal(ca.rows.length, expected);
});

test('covering arrays and prompt instantiation are deterministic', () => {
  const a = buildCoveringArray(dims, { strength: 2, fullIfAtMost: 10, isValid: valid });
  const b = buildCoveringArray(dims, { strength: 2, fullIfAtMost: 10, isValid: valid });
  assert.deepEqual(a.rows, b.rows);
  const c1 = instantiate(model, a.rows[0]), c2 = instantiate(model, a.rows[0]);
  assert.deepEqual(c1, c2);
  assert.ok(c1.prompt.length > 10 && c1.cell_id.startsWith('cell-'));
});

test('ideal is mechanically derived: batch tool preferred for multi-item scopes, gate required for writes', () => {
  const several = instantiate(model, { ...Object.fromEntries(dims.map(d => [d.name, d.values[0]])), target_tool: 'get_device', scope: 'several' });
  assert.deepEqual(several.ideal.tools, ['get_devices_batch']);
  assert.equal(several.ideal.max_calls, 1);
  const write = instantiate(model, { ...Object.fromEntries(dims.map(d => [d.name, d.values[0]])), target_tool: 'reset_device' });
  assert.equal(write.ideal.gate_required, true);
  const outage = instantiate(model, { ...Object.fromEntries(dims.map(d => [d.name, d.values[0]])), target_tool: 'query_source2', source_state: 'outage' });
  assert.deepEqual(outage.ideal.must_not_call, ['query_source2']);
});
