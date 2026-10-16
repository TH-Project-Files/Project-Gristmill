import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { explore, delegationCycles } from '../lib/sequence/search.mjs';
import { sequenceRules } from '../lib/sequence/rules.mjs';
import { sequenceCoveringArray } from '../lib/sequence/sca.mjs';
import { runSequenceEngine } from '../lib/sequence/index.mjs';

const seeded = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const fixed = normalizeModel(await loadTargetModule('fixtures/example-agent/agent-fixed.mjs'));
const engine = m => runSequenceEngine({ model: m, depth: 5 });
const seq = engine(seeded), seqFixed = engine(fixed);
const has = (r, rule, tool) => r.findings.some(f => f.rule === rule && (tool === undefined || f.subject.tool === tool));

test('bounded search is finite and deterministic, keeping the shortest path to each state', () => {
  const a = explore(seeded, { depth: 5 }), b = explore(seeded, { depth: 5 });
  assert.deepEqual(a.map(e => e.distinct), b.map(e => e.distinct));
  assert.ok(a[0].distinct > 10 && a[0].distinct < 5000, `states=${a[0].distinct}`);
});

test('SEQ-01: tainted context reaches an ungated sensitive action, with a witness path', () => {
  assert.ok(has(seq, 'SEQ-01', 'reset_device'));
  const f = seq.findings.find(f => f.rule === 'SEQ-01');
  assert.ok(f.evidence.path.length >= 2 && f.evidence.path.some(s => /fetch_vendor_page|query_source2/.test(s)), f.evidence.path.join(' '));
  assert.ok(f.evidence.path.at(-1).includes('reset_device'));
});

test('SEQ-02: session-scoped approval is reused across subjects', () => {
  const f = seq.findings.find(f => f.rule === 'SEQ-02');
  assert.ok(f, 'reuse found');
  assert.deepEqual(f.evidence.path, ['call reset_device(SUBJ-1)', 'call reset_device(SUBJ-2)']);
});

test('SEQ-03: a secret read earlier leaves via an outbound call, deduped to the leak sink', () => {
  assert.ok(has(seq, 'SEQ-03'));
  const leaks = seq.findings.filter(f => f.rule === 'SEQ-03');
  assert.ok(leaks.every(f => f.evidence.path[0].includes('get_source_config')), 'every leak path starts at the secret read');
  assert.ok(leaks.every(f => f.evidence.path.at(-1).match(/fetch_vendor_page|query_source2|reset_device/)), 'ends on a real outbound tool');
});

test('SEQ-04: untrusted content handed to a subagent holding an ungated sensitive tool', () => {
  assert.ok(has(seq, 'SEQ-04', 'reset_device'));
});

test('SEQ-06: a subagent holds an id-taking tool but no resolver', () => {
  assert.ok(has(seq, 'SEQ-06'));
});

test('the fixed twin clears the multi-step security sequences', () => {
  for (const r of ['SEQ-01', 'SEQ-02', 'SEQ-03', 'SEQ-04']) assert.ok(!has(seqFixed, r), `${r} should be gone after the fixes`);
  assert.ok(seqFixed.findings.length < seq.findings.length);
});

test('delegation cycles: none in the acyclic fixture, detected when present', () => {
  assert.deepEqual(delegationCycles(seeded), []);
  const cyclic = { actors: [{ id: 'orchestrator', kind: 'orchestrator', can_delegate_to: ['ops'] }, { id: 'ops', kind: 'subagent', can_delegate_to: ['inventory'] }, { id: 'inventory', kind: 'subagent', can_delegate_to: ['ops'] }] };
  const cycles = delegationCycles(cyclic);
  assert.ok(cycles.length >= 1 && cycles[0].includes('ops') && cycles[0].includes('inventory'));
});

test('sequence covering array covers every ordered event pair with few sequences', () => {
  const events = ['read_web', 'read_secret', 'delegate', 'reset', 'send'];
  const { sequences, uncovered } = sequenceCoveringArray(events);
  assert.equal(uncovered, 0);
  assert.ok(sequences.length <= events.length, `${sequences.length} sequences for ${events.length} events`);
  const pairs = new Set();
  for (const s of sequences) for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) pairs.add(s[i] + '>' + s[j]);
  for (const a of events) for (const b of events) if (a !== b) assert.ok(pairs.has(a + '>' + b), `${a} before ${b} missing`);
});

test('scripts are emitted for the top-severity paths', () => {
  assert.ok(seq.scripts.length >= 1);
  assert.ok(seq.scripts.every(s => s.turns.length >= 1 && s.severity >= 4));
});
