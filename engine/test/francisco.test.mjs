import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFrancisco } from '../lib/extract/from-francisco.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { runAnalyzers } from '../lib/analyzers/index.mjs';

const raw = extractFrancisco('fixtures/francisco-mini');
const m = normalizeModel(raw);
const t = id => m.tools.find(x => x.id === id);

test('heuristic extractor recognizes tools, zod params, env vars, subagents and approvals from a Francisco package', () => {
  assert.equal(m.extraction.confidence, 'heuristic');
  assert.deepEqual(m.tools.map(x => x.id).sort(), ['fetch_page', 'list_hosts', 'parse_version', 'run_script']);
  assert.equal(t('list_hosts').implicit_cap, true, 'handler-side slice is an implicit cap');
  assert.equal(t('fetch_page').implicit_cap, false, 'a real limit param is not an implicit cap');
  const url = t('fetch_page').params.find(p => p.name === 'url');
  assert.equal(url.taint, 'url'); assert.equal(url.maxLength, 2048); assert.equal(url.required, true);
  assert.equal(t('fetch_page').params.find(p => p.name === 'max_chars').type, 'integer');
  assert.ok(t('fetch_page').sinks.some(s => s.kind === 'network' && s.sanitized_by === 'fetch_page-allowlist'), 'ALLOWED_HOSTS ⇒ allowlist gate');
  assert.deepEqual(t('fetch_page').env, ['API_TOKEN']);
  assert.ok(m.env.find(e => e.name === 'API_TOKEN').sensitive && !m.env.find(e => e.name === 'LOG_LEVEL').sensitive);
  assert.equal(t('run_script').kind, 'external-action');
  assert.ok(t('run_script').sinks.some(s => s.kind === 'shell'));
  assert.equal(t('run_script').errors, 'raw');
  assert.ok(!t('parse_version').sinks.some(s => s.kind === 'shell'), 'RegExp.exec is not a shell');
  assert.equal(t('parse_version').kind, 'read');
  const sub = m.actors.find(a => a.kind === 'subagent');
  assert.ok(sub && sub.id === 'web-researcher');
  assert.deepEqual(sub.tools.sort(), ['fetch_page', 'parse_version']);
  assert.ok(m.gates.some(g => g.kind === 'hitl' && g.applies_to.includes('run_script')), 'toolApprovals ⇒ hitl gate');
  assert.ok(m.policies.includes('confirm-before-write') && m.policies.includes('never-echo-secrets'));
});

test('analyzers run on a heuristic model and the obvious structural facts surface', () => {
  const F = runAnalyzers(m);
  assert.ok(F.some(f => f.rule === 'SEC-04' && f.subject.tool === 'fetch_page'), 'token reaches output/log with no redaction');
  assert.ok(F.some(f => f.rule === 'SEC-06' && f.subject.tool === 'run_script'));
  assert.ok(!F.some(f => f.rule === 'SEC-01' && f.subject.tool === 'run_script'), 'run_script is hitl-gated');
  assert.ok(F.some(f => f.rule === 'EFF-01'));
  const cap = F.find(f => f.rule === 'EFF-06' && f.subject.tool === 'list_hosts');
  assert.ok(cap && cap.severity === 1 && cap.evidence.implicit_cap, 'implicitly capped list is informational, not severity 3');
});
