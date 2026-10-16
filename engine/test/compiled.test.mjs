/**
 * Compiled-package extraction: a package that ships only dist/index.js (no readable src) must still
 * yield its real tools AND L1 coverage, by importing createTools() and binding the handlers. This is
 * the DeepSight case the heuristic path saw as "0 tools".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel } from '../lib/pipeline.mjs';
import { runAnalyzers } from '../lib/analyzers/index.mjs';
import { probeTool, observationsToFindings } from '../lib/synth/runtime.mjs';

const { model, kind } = await loadModel('fixtures/compiled-agent', null, { allowExec: true });

test('with --allow-exec, a compiled package lists its real tools with kinds learned from execution', () => {
  assert.equal(kind, 'compiled');
  assert.equal(model.extraction.method, 'compiled-runtime');
  assert.deepEqual(model.tools.map(t => t.id).sort(), ['fetch_doc', 'get_widget', 'reset_widget', 'show_config']);
  assert.equal(model.tools.find(t => t.id === 'reset_widget').kind, 'external-action', 'it POSTs, so execution reclassifies it');
  assert.ok(model.tools.find(t => t.id === 'fetch_doc').params.some(p => p.name === 'url' && p.taint === 'url'));
});

test('the manifest approval becomes a code gate; env sensitivity is read from the manifest', () => {
  assert.ok(model.gates.some(g => g.kind === 'hitl' && g.applies_to.includes('reset_widget')));
  assert.ok(model.env.find(e => e.name === 'API_TOKEN').sensitive);
});

test('handlers are bound, so the L1 harness catches the secret leak and the SSRF taint', async () => {
  assert.ok(model._handlers.show_config && model._handlers.fetch_doc, 'handlers bound from createTools()');
  const probe = async id => { const t = model.tools.find(x => x.id === id); return observationsToFindings([await probeTool(model, t, model._handlers[id])]); };
  const leak = await probe('show_config');
  assert.ok(leak.some(f => f.rule === 'HAR-SECRET'), 'secret echoed in output caught via the canary');
  const ssrf = await probe('fetch_doc');
  assert.ok(ssrf.some(f => f.rule === 'HAR-TAINT'), 'url taint reaches the network sink');
});

test('runs the full analyzer suite on a compiled model without error', () => {
  const findings = runAnalyzers(model);
  assert.ok(Array.isArray(findings));
});
