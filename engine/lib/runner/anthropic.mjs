/**
 * Back-compat shim. The real logic now lives in loop.mjs (transport-agnostic agent loop) and
 * transports.mjs (provider adapters). `createAnthropicRunner` remains for callers and tests that
 * want the Anthropic transport specifically, including a scripted `fetchImpl`. New code should use
 * `createLiveRunner` from live.mjs, which auto-detects whatever model access the host harness has.
 */
import { createModelRunner } from './loop.mjs';
import { anthropicTransport } from './transports.mjs';

export function createAnthropicRunner(model, { apiKey = process.env.ANTHROPIC_API_KEY, modelId = 'claude-sonnet-5-5', maxTurns = null, nonInteractiveGate = 'block', fetchImpl = globalThis.fetch, temperature = 0, maxTokens = 1024 } = {}) {
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN && fetchImpl === globalThis.fetch) throw new Error('ANTHROPIC_API_KEY is required for the anthropic runner (or use createLiveRunner / --complete-cmd)');
  const transport = anthropicTransport({ apiKey, modelId, maxTokens, temperature, fetchImpl });
  return createModelRunner(model, { complete: (req) => transport.complete(req), modelId, maxTurns, nonInteractiveGate, kind: 'anthropic', transport: 'anthropic' });
}
