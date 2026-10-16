/**
 * Runner adapters — the ONE place the open world is executed.
 *
 *   adapter = { kind, fidelity: 'L2', mock: boolean, run(cell, { rep }) -> Promise<Trace>, describe() }
 *
 * runCell() wraps an adapter: it applies the kit's ONE blast-radius guard (../../../safety), executes,
 * scores the trace with the mechanical oracles and returns an OBSERVATION — the record the boundary
 * engine consumes. The adapter never scores itself.
 *
 * Every adapter declares where its TOOL CALLS land:
 *   backends: 'none'  — mock runner, no model, no tools        → always allowed
 *   backends: 'fakes' — real model, tools hit recording fakes  → sandbox must be declared
 *   backends: <url>   — real model, tools hit a real backend   → sandbox declared AND the endpoint
 *                       must be recognizably non-production (fail-closed on unknown), exactly the
 *                       rule V1's safe-execute enforces for L2/L3 runs.
 * An adapter that declares nothing is treated as hitting an unknown backend and refused.
 */
import { scoreTrace, canaries } from '../oracles/index.mjs';
import { toolById } from '../model.mjs';
import { assertSandboxActive, isSandboxActive, BlastRadiusError } from '../../../safety/blast-radius-guard.mjs';

export { BlastRadiusError };

export function sandboxDeclared(env = process.env, opts = {}) { return isSandboxActive({ sandbox: opts.sandbox }, env); }

export function assertRunAllowed(adapter, env = process.env, opts = {}) {
  const backends = adapter.backends ?? (adapter.mock ? 'none' : undefined);
  if (backends === 'none') return true;
  if (backends === 'fakes') {
    if (!sandboxDeclared(env, opts)) throw new BlastRadiusError(`Refusing ${adapter.kind} (${adapter.fidelity}) run: no sandbox declared. Its tools hit recording fakes, but it spends real credentials; set GRISTMILL_SANDBOX=1 to confirm.`);
    return true;
  }
  // Real backend (or undeclared ⇒ unknown): the full V1 rule, fail-closed.
  return assertSandboxActive({ fidelity: adapter.fidelity === 'L3' ? 'L3' : 'L2', targetEndpoint: backends, sandbox: opts.sandbox }, env);
}

export async function runCell(adapter, model, cell, { rep = 0, env = process.env, opts = {} } = {}) {
  assertRunAllowed(adapter, env, opts);
  const trace = await adapter.run(cell, { rep });
  const scored = scoreTrace(model, cell, trace, { secretValues: canaries(model) });
  const calls = (trace.steps || []).filter(s => s.action === 'tool_call');
  const sensitive = calls.filter(s => { const t = toolById(model, s.tool); return t && (t.kind === 'write' || t.kind === 'external-action'); });
  // Per-step gate flags are authoritative: one gated call must never mask an ungated sibling.
  // The trace-level flag is only a fallback for traces whose steps carry no gate information.
  const stepsCarryGateInfo = sensitive.some(s => 'gate_fired' in s);
  return {
    cell_id: cell.cell_id, coords: cell.coords, rep,
    pass: scored.pass, violations: scored.violations.map(v => v.code), axes: scored.axes,
    gate_fired: sensitive.some(s => s.gate_fired) || !!trace.gate_fired,
    sensitive_called: sensitive.length > 0,
    sensitive_ungated: stepsCarryGateInfo ? sensitive.some(s => s.gate_fired !== true && !s.blocked) : (sensitive.length > 0 && !trace.gate_fired),
    calls: calls.length, tokens: trace.tokens ?? null,
    handler: trace.handler ?? null,
    fidelity: adapter.fidelity, runner: adapter.kind, model_version: trace.model_version ?? adapter.describe?.().model_version ?? 'unknown',
  };
}
