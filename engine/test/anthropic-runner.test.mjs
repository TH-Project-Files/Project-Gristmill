/**
 * The Anthropic runner loop, driven with a SCRIPTED fetch (no network, no key). Proves the loop
 * shape: it exposes tools + delegate tools, enforces the code gate in code (returns CONFIRMATION
 * REQUIRED instead of executing), executes real handlers through the harness fakes, and scores.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions } from '../lib/lattice/dimensions.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';
import { createAnthropicRunner } from '../lib/runner/anthropic.mjs';
import { runCell } from '../lib/runner/index.mjs';
import { baseCoordsFor } from '../lib/boundary/refine.mjs';

const model = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const dims = deriveDimensions(model);

// A scripted API: first response calls the tool named in the script, second ends the turn.
function scriptedFetch(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i++, script.length - 1)];
    const content = step.tool ? [{ type: 'tool_use', id: `tu${i}`, name: step.tool, input: step.input || {} }] : [{ type: 'text', text: step.text || 'done' }];
    return { ok: true, json: async () => ({ content, stop_reason: step.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
}

test('code-enforced gate is enforced in the runner, not left to the model', async () => {
  const runner = createAnthropicRunner(model, { apiKey: 'test', fetchImpl: scriptedFetch([{ tool: 'reset_device', input: { device_id: 'DEV-0042' } }, { text: 'I need confirmation.' }]), maxTurns: 4 });
  const cell = instantiate(model, baseCoordsFor(model, dims, 'reset_device', { entry: 'chat' }));
  const obs = await runCell(runner, model, cell, { env: { GRISTMILL_SANDBOX: '1' } });
  assert.equal(obs.gate_fired, true, 'the orchestrator route gate fired in code');
  assert.equal(obs.sensitive_ungated, false);
});

test('real handler executes through the harness fakes and the secret leak is caught', async () => {
  const runner = createAnthropicRunner(model, { apiKey: 'test', fetchImpl: scriptedFetch([{ tool: 'get_source_config', input: { source: 'SOURCE-1' } }, { text: 'Here is the config.' }]), maxTurns: 4 });
  const cell = instantiate(model, baseCoordsFor(model, dims, 'get_source_config', { entry: 'chat' }));
  const obs = await runCell(runner, model, cell, { env: { GRISTMILL_SANDBOX: '1' } });
  assert.ok(obs.violations.includes('SECRET-IN-OUTPUT') || obs.violations.includes('SECRET-SHAPED-OUTPUT'), `violations: ${obs.violations}`);
});

test('the runner refuses to run without a declared sandbox', async () => {
  const runner = createAnthropicRunner(model, { apiKey: 'test', fetchImpl: scriptedFetch([{ text: 'hi' }]) });
  const cell = instantiate(model, baseCoordsFor(model, dims, 'get_device', { entry: 'chat' }));
  await assert.rejects(() => runCell(runner, model, cell, { env: {} }), /no sandbox declared/);
});
