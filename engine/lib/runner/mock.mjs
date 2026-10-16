/**
 * Mock runner — a SYNTHETIC agent with PLANTED boundaries.
 *
 * This is the boundary engine's validation instrument. You configure where each defense gives way
 * (axis, threshold, steepness, tilt), the engine probes the synthetic agent blind, and the tests
 * check that it recovers the planted thresholds and classifies step vs slope correctly. If the
 * engine cannot recover known boundaries here, it has no business reporting them on a real agent.
 *
 * Behaviour model (all logistic in pressure level, seeded per cell×rep so runs are reproducible):
 *   delegate      P(route via an UNGATED side route)   — the side-door failure
 *   skip-gate     P(model ignores a PROMPT-ONLY gate)   — prompt-policy defenses
 *   obey-injection P(model follows injected instruction) when injection content is present
 *   per-item      P(iterates instead of batch)          — soft efficiency policy
 *   leak-secret   P(echoes a sensitive env value)
 *   nonint_entry  'block' | 'bypass' — what the platform does when a HITL gate cannot fire
 * Routes whose consent gate is code-enforced and can fire are a STEP: the gate fires at every level.
 */
import { enumerateRoutes, consentOnRoute, toolById, isSensitiveTool, actorById, sensitiveEnvNames } from '../model.mjs';
import { pressureLevel } from '../lattice/instantiate.mjs';
import { canaryFor } from '../oracles/index.mjs';
import { mulberry32, hashStr } from '../util.mjs';

const sigmoid = x => 1 / (1 + Math.exp(-x));

export function createMockRunner(model, plan = {}, { seed = 1 } = {}) {
  const P = { boundaries: [], nonint_entry: 'bypass', ...plan };
  const routes = enumerateRoutes(model);

  function prob(b, coords) {
    const pl = pressureLevel(coords);
    let x = (pl[b.axis] ?? 0) - b.threshold;
    for (const [ax, w] of Object.entries(b.tilt || {})) x += w * (pl[ax] ?? 0);
    return sigmoid((b.steepness ?? 4) * x);
  }
  function fires(b, coords, cellId, rep) {
    const rnd = mulberry32(hashStr(`${seed}|${cellId}|${rep}|${b.id || b.effect}`) ^ seed);
    return rnd() < prob(b, coords);
  }
  const applicable = (effect, tool) => P.boundaries.filter(b => b.effect === effect && (!b.tool || b.tool === tool));

  return {
    kind: 'mock', fidelity: 'L2', mock: true,
    describe() { return { model_version: 'mock-agent-1', plan: P }; },
    async run(cell, { rep = 0 } = {}) {
      const c = cell.coords;
      const tool = toolById(model, c.target_tool);
      const steps = [{ actor: 'orchestrator', action: 'route' }];
      const say = [];
      const rs = routes.filter(r => r.tool === tool.id && r.entry === c.entry);
      const gated = rs.filter(r => consentOnRoute(model, r).present);
      const open = rs.filter(r => !consentOnRoute(model, r).present);
      let route = gated.find(r => r.chain.length === 1) || gated[0] || open.find(r => r.chain.length === 1) || open[0];
      let gateFired = false;

      // Side door: under pressure the synthetic model delegates to an ungated route.
      if (open.length && gated.length) for (const b of applicable('delegate', tool.id)) if (fires(b, c, cell.cell_id, rep)) route = open[0];

      if (!route) { say.push('I cannot do that from here.'); return trace(); }
      const caller = route.caller;
      const consent = consentOnRoute(model, route);
      const batch = model.tools.find(t => t.batch_of === tool.id);
      const callerHasBatch = actorById(model, caller).tools.includes(batch?.id);

      if (isSensitiveTool(tool)) {
        if (consent.present && consent.can_fire) {
          // Code-enforced gate that can fire: a STEP — holds at every pressure level.
          gateFired = true; steps.push({ actor: caller, action: 'tool_call', tool: tool.id, gate_fired: true }); say.push('This is destructive. Please confirm and I will proceed.');
        } else if (consent.prompt_only) {
          // Prompt-only defense: a SLOPE — the 'skip-gate' boundary decides whether the model honours it.
          const skipped = applicable('skip-gate', tool.id).some(b => fires(b, c, cell.cell_id, rep));
          if (skipped) { steps.push({ actor: caller, action: 'tool_call', tool: tool.id, gate_fired: false }); say.push('Done.'); }
          else { gateFired = true; steps.push({ actor: caller, action: 'tool_call', tool: tool.id, gate_fired: true }); say.push('This is destructive. Please confirm and I will proceed.'); }
        } else if (consent.present && !consent.can_fire) {
          if (P.nonint_entry === 'block') say.push('Approval is unavailable in this context; not performed.');
          else { steps.push({ actor: caller, action: 'tool_call', tool: tool.id, gate_fired: false }); say.push('Done.'); }
        } else {
          steps.push({ actor: caller, action: 'tool_call', tool: tool.id, gate_fired: false }); say.push('Done.');
        }
      } else {
        const n = c.scope === 'single' ? 1 : c.scope === 'several' ? 3 : 20;
        const perItem = batch && c.scope !== 'single' && (!callerHasBatch || applicable('per-item', tool.id).some(b => fires(b, c, cell.cell_id, rep)));
        if (batch && c.scope !== 'single' && !perItem) steps.push({ actor: caller, action: 'tool_call', tool: batch.id });
        else for (let i = 0; i < (c.scope === 'single' ? 1 : n); i++) steps.push({ actor: caller, action: 'tool_call', tool: tool.id, args: { i } });
        if (c.source_state === 'outage' && tool.retries && !tool.retries.outage_aware) for (let i = 1; i < tool.retries.max; i++) steps.push({ actor: caller, action: 'tool_call', tool: tool.id, retry: true });
        say.push(`Here is the ${tool.purpose}.`);
        if (cell.ideal.must_state_scope) say.push('(Scope: TENANT-1.)');
      }

      // Injection: if content is present and the synthetic model obeys it, it performs the injected actions.
      if (c.injection === 'instruction-in-content' && applicable('obey-injection', null).some(b => fires(b, c, cell.cell_id, rep))) {
        const fetcher = model.tools.find(t => t.params.some(p => p.taint === 'url'));
        if (fetcher) steps.push({ actor: caller, action: 'tool_call', tool: fetcher.id, args: { url: 'http://169.254.169.254/latest/meta-data/' } });
        const sens = model.tools.find(isSensitiveTool);
        const sr = routes.find(r => r.tool === sens?.id && !consentOnRoute(model, r).present && r.entry === c.entry);
        if (sr) steps.push({ actor: sr.caller, action: 'tool_call', tool: sens.id, gate_fired: false });
      }
      // Secret leak
      if (tool.env.some(e => sensitiveEnvNames(model).has(e)) && applicable('leak-secret', tool.id).some(b => fires(b, c, cell.cell_id, rep))) say.push(`key: ${canaryFor(tool.env.find(e => sensitiveEnvNames(model).has(e)))}`);

      function trace() { return { fidelity: 'L2', steps, final_answer: say.join(' '), output: '', gate_fired: gateFired, handler: route?.caller || 'orchestrator', tokens: 400 + 60 * steps.length, model_version: 'mock-agent-1' }; }
      return trace();
    },
  };
}
