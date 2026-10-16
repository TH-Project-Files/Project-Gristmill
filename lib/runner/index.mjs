/**
 * Runner adapters — the ONE place the open world is executed.
 *
 *   adapter = { kind, fidelity: 'L2', mock: boolean, run(cell, { rep }) -> Promise<Trace>, describe() }
 *
 * runCell() wraps an adapter: it applies V1's blast-radius discipline (a non-mock L2 runner refuses
 * to run unless a sandbox is declared), executes, scores the trace with the mechanical oracles and
 * returns an OBSERVATION — the record the boundary engine consumes. The adapter never scores itself.
 */
import { scoreTrace, canaries } from '../oracles/index.mjs';
import { toolById } from '../model.mjs';

export class BlastRadiusError extends Error { constructor(m) { super(m); this.name = 'BlastRadiusError'; } }

export function sandboxDeclared(env = process.env, opts = {}) {
  const flag = String(env.GRISTMILL_SANDBOX ?? '').trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'active'].includes(flag) || opts.sandbox?.active === true;
}

export function assertRunAllowed(adapter, env = process.env, opts = {}) {
  if (adapter.mock) return true;
  if (!sandboxDeclared(env, opts)) throw new BlastRadiusError(`Refusing ${adapter.kind} (${adapter.fidelity}) run: no sandbox declared. Set GRISTMILL_SANDBOX=1 only when the runner's tool backends are fakes or a throwaway tenant.`);
  return true;
}

export async function runCell(adapter, model, cell, { rep = 0, env = process.env, opts = {} } = {}) {
  assertRunAllowed(adapter, env, opts);
  const trace = await adapter.run(cell, { rep });
  const scored = scoreTrace(model, cell, trace, { secretValues: canaries(model) });
  const calls = (trace.steps || []).filter(s => s.action === 'tool_call');
  const sensitive = calls.filter(s => { const t = toolById(model, s.tool); return t && (t.kind === 'write' || t.kind === 'external-action'); });
  return {
    cell_id: cell.cell_id, coords: cell.coords, rep,
    pass: scored.pass, violations: scored.violations.map(v => v.code), axes: scored.axes,
    gate_fired: sensitive.some(s => s.gate_fired) || !!trace.gate_fired,
    sensitive_called: sensitive.length > 0,
    sensitive_ungated: sensitive.some(s => !s.gate_fired) && !trace.gate_fired,
    calls: calls.length, tokens: trace.tokens ?? null,
    handler: trace.handler ?? null,
    fidelity: adapter.fidelity, runner: adapter.kind, model_version: trace.model_version ?? adapter.describe?.().model_version ?? 'unknown',
  };
}
