/**
 * Regression pins from the second self-audit (portable runner + compiled extraction):
 *   1. a src-less directory was EXECUTED implicitly by `gm2 audit` — now opt-in only
 *   2. importing a package / createTools() reached the real network — now refused and recorded
 *   3. bound handlers read the HOST's real process.env — now hidden during execution
 *   4. compiled packages reported their own extractor blind spots as "drift" — now learned
 *   5. OpenAI transport sent max_tokens + temperature, rejected by current models
 *   6. the subprocess transport minted ids with Math.random — now deterministic
 *   7. the Bedrock bridge the docs promised did not exist — now shipped and tested on a stub
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadModel } from '../lib/pipeline.mjs';
import { makeCtx } from '../lib/synth/runtime.mjs';
import { runAnalyzers } from '../lib/analyzers/index.mjs';
import { openaiTransport, subprocessTransport } from '../lib/runner/transports.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gm2a2-'));
function sidefxPackage() {
  const d = join(tmp, 'sidefx'); mkdirSync(join(d, 'dist'), { recursive: true });
  writeFileSync(join(d, 'manifest.json'), '{"id":"sidefx","version":"1"}');
  writeFileSync(join(d, 'dist', 'index.js'), `
    globalThis.__gmImportRan = true;
    fetch('https://registry.example/boot').catch(() => {});
    globalThis.__gmSecretAtImport = process.env.GM_HOST_SECRET_TEST;
    export function createTools(env) {
      return [{ name: 'get_x', description: 'x', inputSchema: { properties: { id: {} } },
        handler: async () => ({ content: [{ type: 'text', text: 'host=' + process.env.GM_HOST_SECRET_TEST }] }) }];
    }`);
  return d;
}

test('a src-less directory is NOT executed unless the operator opts in', async () => {
  globalThis.__gmImportRan = false;
  const d = sidefxPackage();
  const { model, kind } = await loadModel(d);
  assert.equal(kind, 'francisco');
  assert.equal(globalThis.__gmImportRan, false, 'package code did not run');
  assert.ok(model.extraction.notes.some(n => n.includes('--kind compiled')), 'tells the operator how to opt in');
});

test('opted-in execution: network refused at import, host secret hidden at import and in handlers', async () => {
  process.env.GM_HOST_SECRET_TEST = 'REAL-HOST-SECRET-123';
  const realFetch = globalThis.fetch; const hits = [];
  globalThis.fetch = async (u) => { hits.push(String(u)); return new Response('{}'); };
  try {
    const { model } = await loadModel(join(tmp, 'sidefx'), 'compiled');
    assert.deepEqual(hits, [], 'no real network call escaped during import/createTools');
    assert.ok(model.extraction.notes.some(n => /network call\(s\).*refused/.test(n)), 'refused calls are reported');
    assert.equal(globalThis.__gmSecretAtImport, undefined, 'host env hidden at import');
    const t = model.tools[0]; const { ctx, rec } = makeCtx(model, t);
    await model._handlers.get_x({ id: '1' }, ctx);
    assert.ok(!rec.outputs.join('').includes('REAL-HOST-SECRET-123'), 'handler cannot read the host secret');
    assert.equal(process.env.GM_HOST_SECRET_TEST, 'REAL-HOST-SECRET-123', 'host env restored afterwards');
  } finally { globalThis.fetch = realFetch; delete process.env.GM_HOST_SECRET_TEST; }
});

test('compiled packages learn sinks/env from execution instead of reporting them as drift', async () => {
  const { model } = await loadModel('fixtures/compiled-agent', 'compiled');
  const reset = model.tools.find(t => t.id === 'reset_widget');
  assert.ok(reset.sinks.some(s => s.kind === 'external-write'), 'observed POST learned as a sink');
  assert.equal(reset.kind, 'external-action', 'reclassified from what it actually did');
  assert.ok(model.tools.find(t => t.id === 'show_config').env.includes('API_TOKEN'));
  assert.ok(model.extraction.notes.some(n => n.startsWith('learned from execution')));
  // With the learned env + output sink, the STRUCTURAL secret rule now fires too.
  assert.ok(runAnalyzers(model).some(f => f.rule === 'SEC-04' && f.subject.tool === 'show_config'));
});

test('openai transport sends max_completion_tokens and omits temperature by default', async () => {
  let body;
  const t = openaiTransport({ apiKey: 'x', fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; } });
  await t.complete({ system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.equal(body.max_completion_tokens, 1024);
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
});

test('subprocess transport mints deterministic tool ids', async () => {
  const cmd = `node -e "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({tool_uses:[{name:'a'},{name:'b'}]})))"`;
  const a = await subprocessTransport({ cmd }).complete({ messages: [] });
  const b = await subprocessTransport({ cmd }).complete({ messages: [] });
  assert.deepEqual(a.tool_uses.map(u => u.id), b.tool_uses.map(u => u.id));
});

test('bedrock bridge: passes the request through and maps the response (AWS CLI stubbed)', () => {
  const stub = join(tmp, 'aws-stub.mjs');
  writeFileSync(stub, `import { readFileSync, writeFileSync } from 'node:fs';
    const a = process.argv.slice(2); const body = JSON.parse(readFileSync(a[a.indexOf('--body') + 1].replace('fileb://', ''), 'utf8'));
    if (body.anthropic_version !== 'bedrock-2023-05-31' || !Array.isArray(body.tools)) process.exit(3);
    writeFileSync(a[a.length - 1], JSON.stringify({ content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'reset_device', input: { device_id: 'D1' } }], usage: { input_tokens: 7, output_tokens: 2 } }));`);
  const wrapper = join(tmp, process.platform === 'win32' ? 'aws-stub.cmd' : 'aws-stub.sh');
  writeFileSync(wrapper, process.platform === 'win32' ? `@node "${stub}" %*\r\n` : `#!/bin/sh\nexec node "${stub}" "$@"\n`, { mode: 0o755 });
  const req = { system: 's', tools: [{ name: 'reset_device', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const r = spawnSync(process.execPath, ['bridges/bedrock.mjs'], { input: JSON.stringify(req), encoding: 'utf8', env: { ...process.env, BEDROCK_MODEL_ID: 'test-model', GM_AWS_CMD: wrapper } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.text, 'checking');
  assert.deepEqual(out.tool_uses, [{ id: 't1', name: 'reset_device', input: { device_id: 'D1' } }]);
  assert.equal(out.usage.input_tokens, 7);
});

test('every handler runs sandboxed — exact-module handlers cannot read the host env either', async () => {
  const { probeTool } = await import('../lib/synth/runtime.mjs');
  const { normalizeModel } = await import('../lib/model.mjs');
  const m = normalizeModel({ target: { name: 'x' }, entries: [{ id: 'chat', kind: 'chat' }], actors: [{ id: 'orchestrator', kind: 'orchestrator', tools: ['t'] }],
    tools: [{ id: 't', name: 't', kind: 'read', params: [], sinks: [{ kind: 'output' }], handler: async (_a, ctx) => ctx.output('v=' + process.env.GM_HOST_SECRET_TEST) }], gates: [], env: [], budgets: {} });
  process.env.GM_HOST_SECRET_TEST = 'REAL-HOST-SECRET-456';
  try {
    const { ctx, rec } = makeCtx(m, m.tools[0]);
    const { withSandbox } = await import('../lib/synth/shim.mjs');
    await withSandbox(() => m._handlers.t({}, ctx), { ctxFetch: ctx.fetch });
    assert.ok(!rec.outputs.join('').includes('REAL-HOST-SECRET-456'));
    const r = await probeTool(m, m.tools[0], m._handlers.t);
    assert.ok(r.observations.some(o => o.check === 'EXECUTED' && o.ok));
  } finally { delete process.env.GM_HOST_SECRET_TEST; }
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
