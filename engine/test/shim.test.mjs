import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModel } from '../lib/model.mjs';
import { probeTool } from '../lib/synth/runtime.mjs';
import { bindAll, withFetch } from '../lib/synth/shim.mjs';

// A stand-in for a Francisco package: createTools(env) returning MCP-shaped tools that close over
// env and call GLOBAL fetch — the shape real packages have.
function createTools(env) {
  return [
    { name: 'get_status', description: 'status', handler: async (args) => {
      const r = await fetch(`https://backend.example/status/${args.id}`, { headers: { authorization: `Bearer ${env.API_TOKEN}` } });
      const j = await r.json();
      return { content: [{ type: 'text', text: `status ok ${JSON.stringify(j)} token=${env.API_TOKEN}` }] };
    } },
  ];
}

const raw = {
  target: { name: 'ShimDemo', version: '0' },
  extraction: { method: 'module', confidence: 'heuristic' },
  entries: [{ id: 'chat', kind: 'chat', interactive: true }],
  actors: [{ id: 'orchestrator', kind: 'orchestrator', prompt: '', tools: ['get_status'], can_delegate_to: [] }],
  tools: [{ id: 'get_status', name: 'get_status', kind: 'read', params: [{ name: 'id', type: 'string', taint: 'id', maxLength: 32 }], sinks: [{ kind: 'network', params: ['id'] }, { kind: 'output' }], env: ['API_TOKEN'] }],
  gates: [], env: [{ name: 'API_TOKEN', sensitive: true }], sources: [{ id: 'user', kind: 'user', trust: 'untrusted' }], budgets: {}, known_outages: [], policies: [],
};

test('withFetch routes global fetch through the recording fake and always restores it', async () => {
  const before = globalThis.fetch;
  const seen = [];
  const out = await withFetch(async (url) => { seen.push(url); return { ok: true, status: 200, body: '{"a":1}' }; }, async () => (await (await fetch('https://x.example/y')).json()));
  assert.deepEqual(out, { a: 1 });
  assert.deepEqual(seen, ['https://x.example/y']);
  assert.equal(globalThis.fetch, before);
  await assert.rejects(() => withFetch(async () => ({}), async () => { throw new Error('boom'); }));
  assert.equal(globalThis.fetch, before, 'restored after throw');
});

test('bindAll gives a package-shaped tool real L1 coverage: recorded network, canary env, secret leak caught', async () => {
  const model = normalizeModel(bindAll(structuredClone(raw), createTools));
  assert.ok(model._handlers.get_status, 'handler bound');
  const r = await probeTool(model, model.tools[0], model._handlers.get_status);
  const fails = new Set(r.observations.filter(o => !o.ok).map(o => o.check));
  assert.ok(fails.has('SECRET-IN-OUTPUT'), 'the package echoes its token; the canary proves it');
  assert.ok(r.observations.some(o => o.check === 'EXECUTED' && o.ok), 'handlers actually ran');
  assert.ok(model.extraction.notes.some(n => n.includes('1/1 handlers bound')));
});
