import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { probeTool, observationsToFindings, generateCases } from '../lib/synth/runtime.mjs';

const seeded = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const fixed = normalizeModel(await loadTargetModule('fixtures/example-agent/agent-fixed.mjs'));
const probe = async (m, id) => { const t = m.tools.find(x => x.id === id); const r = await probeTool(m, t, m._handlers[id]); return { r, checks: new Set(r.observations.filter(o => !o.ok).map(o => o.check)) }; };

test('cases are derived from the declared schema: valid, boundary, out-of-schema, taint', () => {
  const cs = generateCases(seeded.tools.find(t => t.id === 'fetch_vendor_page'));
  const kinds = new Set(cs.map(c => c.kind));
  assert.deepEqual([...kinds].sort(), ['boundary', 'out-of-schema', 'taint', 'valid']);
  assert.ok(cs.some(c => c.kind === 'taint' && String(c.args.url).includes('169.254.169.254')));
});

test('harness catches the secret leak, the undeclared log sink and the undeclared env read (L1, CONFIRMED)', async () => {
  const { r, checks } = await probe(seeded, 'get_source_config');
  for (const c of ['SECRET-IN-OUTPUT', 'SECRET-IN-LOG', 'SINK-UNDECLARED', 'ENV-UNDECLARED']) assert.ok(checks.has(c), c);
  assert.ok(r.observations.filter(o => !o.ok).every(o => o.verify_status === 'CONFIRMED'), 'deterministic handler ⇒ CONFIRMED');
});

test('taint payloads reach the sink on the deny-listed fetch and the unsanitized path, but NOT on the allow-listed SQL', async () => {
  assert.ok((await probe(seeded, 'fetch_vendor_page')).checks.has('TAINT-REACHED-SINK'));
  assert.ok((await probe(seeded, 'run_report')).checks.has('TAINT-REACHED-SINK'));
  assert.ok((await probe(seeded, 'run_report')).checks.has('RAW-ERROR'));
  const sql = await probe(seeded, 'search_users');
  assert.ok(!sql.checks.has('TAINT-REACHED-SINK') && !sql.checks.has('SCHEMA-NOT-ENFORCED'), [...sql.checks].join(','));
  const id = await probe(seeded, 'get_device');
  assert.ok(!id.checks.has('TAINT-REACHED-SINK') && !id.checks.has('SCOPE-NOT-BOUND'), [...id.checks].join(','));
});

test('uncapped output and scope binding are observed, not inferred', async () => {
  assert.ok((await probe(seeded, 'list_devices')).checks.has('UNCAPPED-OUTPUT'));
  assert.ok((await probe(seeded, 'lookup_user')).checks.has('SCOPE-NOT-BOUND'));
});

test('the fixed twin is clean where it was fixed', async () => {
  const gsc = await probe(fixed, 'get_source_config');
  assert.ok(!gsc.checks.has('SECRET-IN-OUTPUT') && !gsc.checks.has('SECRET-IN-LOG') && !gsc.checks.has('ENV-UNDECLARED') && !gsc.checks.has('SINK-UNDECLARED'), [...gsc.checks].join(','));
  const ld = await probe(fixed, 'list_devices');
  assert.ok(!ld.checks.has('UNCAPPED-OUTPUT') && !ld.checks.has('LIMIT-NOT-ENFORCED'), [...ld.checks].join(','));
  const fvp = await probe(fixed, 'fetch_vendor_page');
  assert.ok(!fvp.checks.has('TAINT-REACHED-SINK') && !fvp.checks.has('RAW-ERROR'), [...fvp.checks].join(','));
  const rr = await probe(fixed, 'run_report');
  assert.ok(!rr.checks.has('TAINT-REACHED-SINK') && !rr.checks.has('RAW-ERROR') && !rr.checks.has('SCHEMA-NOT-ENFORCED'), [...rr.checks].join(','));
});

test('observations collapse into one L1 finding per tool × rule × fix', async () => {
  const { r } = await probe(seeded, 'fetch_vendor_page');
  const fs = observationsToFindings([r]);
  const taint = fs.filter(f => f.rule === 'HAR-TAINT');
  assert.equal(taint.length, 1);
  assert.ok(taint[0].evidence.cases.length >= 2, 'several payloads folded into one finding');
  assert.equal(taint[0].fidelity, 'L1');
});
