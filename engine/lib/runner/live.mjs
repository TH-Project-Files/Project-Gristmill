/**
 * The live runner: a real model driving the target's real handlers under the harness fakes, over
 * whatever transport the host harness provides. `createLiveRunner` auto-detects the transport from
 * the environment (see transports.mjs) so the same command works under Claude Code, Codex,
 * Antigravity or a bare shell — each supplies its own model access, none is hard-coded.
 */
import { createModelRunner } from './loop.mjs';
import { detectTransport } from './transports.mjs';

export function createLiveRunner(model, opts = {}, env = process.env) {
  const { transport, how } = detectTransport(opts, env);
  const runner = createModelRunner(model, { complete: (req) => transport.complete(req), modelId: transport.modelId, nonInteractiveGate: opts.nonInteractiveGate || 'block', maxTurns: opts.maxTurns, kind: 'live', transport: transport.id });
  runner.how = how;
  return runner;
}
