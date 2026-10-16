/**
 * Transports are offline-testable with a scripted fetch (Anthropic + OpenAI) and a scripted
 * subprocess (the universal hook). Each must drive the SAME loop to the SAME observation, proving
 * the loop is provider-blind and the engine runs on whatever model access a harness supplies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions } from '../lib/lattice/dimensions.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';
import { createModelRunner } from '../lib/runner/loop.mjs';
import { anthropicTransport, openaiTransport, detectTransport } from '../lib/runner/transports.mjs';
import { runCell } from '../lib/runner/index.mjs';
import { baseCoordsFor } from '../lib/boundary/refine.mjs';

const model = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const dims = deriveDimensions(model);
const resetCell = instantiate(model, baseCoordsFor(model, dims, 'reset_device', { entry: 'chat' }));
const leakCell = instantiate(model, baseCoordsFor(model, dims, 'get_source_config', { entry: 'chat' }));
const SB = { GRISTMILL_SANDBOX: '1' };

// Scripted Anthropic API: step[i] -> one message (a tool_use, then a final text).
function anthropicFetch(script) { let i = 0; return async () => { const s = script[Math.min(i++, script.length - 1)]; const content = s.tool ? [{ type: 'tool_use', id: `tu${i}`, name: s.tool, input: s.input || {} }] : [{ type: 'text', text: s.text || 'done' }]; return { ok: true, json: async () => ({ content, stop_reason: s.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }) }; }; }
// Scripted OpenAI chat: same script, OpenAI message shape.
function openaiFetch(script) { let i = 0; return async () => { const s = script[Math.min(i++, script.length - 1)]; const message = s.tool ? { content: null, tool_calls: [{ id: `tc${i}`, type: 'function', function: { name: s.tool, arguments: JSON.stringify(s.input || {}) } }] } : { content: s.text || 'done' }; return { ok: true, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) }; }; }

const runnerFrom = (transport) => createModelRunner(model, { complete: (req) => transport.complete(req), modelId: transport.modelId });

test('anthropic transport: code gate fires, not left to the model', async () => {
  const t = anthropicTransport({ apiKey: 'x', fetchImpl: anthropicFetch([{ tool: 'reset_device', input: { device_id: 'DEV-0042' } }, { text: 'need confirm' }]) });
  const o = await runCell(runnerFrom(t), model, resetCell, { env: SB });
  assert.equal(o.gate_fired, true);
  assert.equal(o.sensitive_ungated, false);
});

test('openai transport drives the SAME loop to the SAME verdict on the secret leak', async () => {
  const t = openaiTransport({ apiKey: 'x', fetchImpl: openaiFetch([{ tool: 'get_source_config', input: { source: 'SOURCE-1' } }, { text: 'here is the config' }]) });
  const o = await runCell(runnerFrom(t), model, leakCell, { env: SB });
  assert.ok(o.violations.includes('SECRET-IN-OUTPUT') || o.violations.includes('SECRET-SHAPED-OUTPUT'), o.violations.join(','));
  assert.equal(o.transport, undefined); // runner-level field; observation carries fidelity/runner
});

test('subprocess transport: a host command that reads stdin JSON and writes {text,tool_uses}', async () => {
  // A tiny node one-liner standing in for a harness wrapper: first turn calls the tool, then stops.
  const script = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);const called=r.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_use'));if(called){process.stdout.write(JSON.stringify({text:'done'}))}else{process.stdout.write(JSON.stringify({tool_uses:[{name:'reset_device',input:{device_id:'DEV-0042'}}]}))}})"`;
  const { transport, how } = detectTransport({ completeCmd: script }, {});
  assert.match(how, /subprocess/);
  const o = await runCell(runnerFrom(transport), model, resetCell, { env: SB });
  assert.equal(o.gate_fired, true);
});

test('detectTransport reads the environment and explains itself when nothing is present', () => {
  assert.equal(detectTransport({}, { ANTHROPIC_API_KEY: 'x' }).transport.id, 'anthropic');
  assert.equal(detectTransport({}, { OPENAI_API_KEY: 'x' }).transport.id, 'openai');
  assert.equal(detectTransport({}, { ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_AUTH_TOKEN: 't' }).transport.id, 'anthropic');
  assert.equal(detectTransport({ completeCmd: 'cat' }, {}).transport.id, 'subprocess');
  assert.throws(() => detectTransport({}, {}), /No model transport detected[\s\S]*complete-cmd/);
});
