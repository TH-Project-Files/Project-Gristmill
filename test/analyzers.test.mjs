import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { runAnalyzers } from '../lib/analyzers/index.mjs';

const seeded = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const fixed = normalizeModel(await loadTargetModule('fixtures/example-agent/agent-fixed.mjs'));
const F = runAnalyzers(seeded), G = runAnalyzers(fixed);
const has = (rows, rule, tool) => rows.some(f => f.rule === rule && (tool === undefined || f.subject.tool === tool));

test('every seeded defect is found by exactly the rule that owns it', () => {
  assert.ok(has(F, 'SEC-02', 'reset_device'), 'side-route bypass on reset_device');
  assert.ok(!has(F, 'SEC-01', 'reset_device'), 'partial gating is SEC-02, not SEC-01');
  assert.ok(has(F, 'SEC-03', 'run_report'), 'path taint → fs unsanitized');
  assert.ok(has(F, 'SEC-04', 'get_source_config'), 'secret env → output');
  assert.ok(has(F, 'SEC-05', 'fetch_vendor_page'), 'deny-list on url');
  assert.ok(has(F, 'SEC-06', 'fetch_vendor_page') && has(F, 'SEC-06', 'run_report'), 'raw errors');
  assert.ok(has(F, 'SEC-07', 'lookup_user'), 'unscoped in multi-tenant');
  assert.ok(F.some(f => f.rule === 'SEC-08' && f.evidence.entry === 'nightly'), 'consent cannot fire on scheduled entry');
  assert.ok(has(F, 'SEC-09', 'reset_device'), 'injection surface on ops');
  assert.ok(has(F, 'EFF-01'), 'no call budget');
  assert.ok(has(F, 'EFF-02', 'query_source2'), 'retry against known outage');
  assert.ok(F.some(f => f.rule === 'EFF-03' && f.evidence.pair.includes('find_user') && f.evidence.pair.includes('lookup_user')), 'duplicate tools');
  assert.equal(F.filter(f => f.rule === 'EFF-04').length, 2, 'per-item: inventory prompt + orchestrator lacks batch');
  assert.deepEqual(F.filter(f => f.rule === 'EFF-06').map(f => f.subject.tool), ['list_devices'], 'uncapped read');
  assert.equal(F.filter(f => f.rule === 'EFF-08').length, 2, 'dual routes for get_device and list_devices');
});

test('clean tools produce no findings (no false positives)', () => {
  for (const clean of ['search_users', 'get_devices_batch']) assert.deepEqual(F.filter(f => f.subject.tool === clean).map(f => f.rule), [], clean);
  assert.ok(!has(F, 'EFF-07'), 'nothing unreachable');
  assert.ok(!has(F, 'EFF-05'), 'prompt mass under threshold');
});

test('the fixed twin clears the seeded structural defects', () => {
  for (const r of ['SEC-02', 'SEC-03', 'SEC-04', 'SEC-05', 'SEC-06', 'SEC-07', 'SEC-09', 'EFF-01', 'EFF-02', 'EFF-03']) assert.ok(!has(G, r), `${r} should be gone`);
  assert.ok(G.length < F.length);
});

test('finding ids are deterministic and unique', () => {
  const again = runAnalyzers(seeded);
  assert.deepEqual(again.map(f => f.finding_id), F.map(f => f.finding_id));
  assert.equal(new Set(F.map(f => f.finding_id)).size, F.length);
});
