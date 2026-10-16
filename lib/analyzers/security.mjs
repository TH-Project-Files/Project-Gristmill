/**
 * Security analyzers — EXHAUSTIVE over the closed world.
 * Each rule is a total query over routes / tools / params / env: it visits every element, so
 * "no finding" means "no element of the model has this property", not "we didn't sample it".
 * Everything here is L0 (a structural fact about the model). The harness upgrades what it can to L1.
 */
import { enumerateRoutes, gatesOnRoute, consentOnRoute, isSensitiveTool, sensitiveEnvNames, toolById, untrustedOutputTools, codeRedaction } from '../model.mjs';

const TAINT_SINK = { url: ['network'], path: ['fs'], sql: ['db'], shell: ['shell'] };

export function securityAnalyzers() {
  return [ruleUngatedSensitive, ruleSideRoute, ruleTaintToSink, ruleSecretToOutput, ruleRawErrors, ruleUnscoped, ruleConsentCannotFire, ruleInjectionSurface, rulePromptOnlyDefense, ruleSessionScopedGate];
}

/** SEC-10: the only consent defense on a route to a sensitive tool is a prompt sentence. */
export function rulePromptOnlyDefense(m) {
  const out = [], seen = new Set();
  for (const r of enumerateRoutes(m)) {
    const c = consentOnRoute(m, r);
    if (!c.prompt_only || !isSensitiveTool(toolById(m, r.tool))) continue;
    const key = r.tool + '|' + r.caller; if (seen.has(key)) continue; seen.add(key);
    out.push(mk('SEC-10', 4, `${toolById(m, r.tool).name} via ${r.caller} is defended only by prompt policy (${c.prompt_gates.map(g => g.id).join(', ')}); a hijacked or pressured model can ignore it.`, { tool: r.tool, route: r.route_id }, { prompt_gates: c.prompt_gates.map(g => g.id), caller: r.caller }, [`gate:code-enforced@${r.tool}`, `gate:consent@${r.tool}`]));
  }
  return out;
}

/** SEC-11: a session-scoped consent gate lets one approval cover later calls on other subjects. */
export function ruleSessionScopedGate(m) {
  return m.gates.filter(g => (g.kind === 'hitl' || g.kind === 'confirm') && g.scope === 'session' && (g.enforced_by || 'code') === 'code')
    .flatMap(g => g.applies_to.map(t => mk('SEC-11', 4, `${toolById(m, t).name}: consent gate ${g.id} is session-scoped; an approval for one subject is reused for every later call.`, { tool: t }, { gate: g.id }, [`gate:per-call@${t}`])));
}

function mk(rule, severity, summary, subject, evidence, fixes) {
  return { rule, mode: 'security', severity, fidelity: 'L0', verify_status: 'UNCERTAIN', summary, subject, evidence, fix_candidates: fixes };
}

/** SEC-01: a write/external-action tool with NO consent gate on ANY route. */
export function ruleUngatedSensitive(m) {
  const routes = enumerateRoutes(m);
  const out = [];
  for (const t of m.tools.filter(isSensitiveTool)) {
    const rs = routes.filter(r => r.tool === t.id);
    if (!rs.length) continue;
    if (rs.some(r => consentOnRoute(m, r).present)) continue; // handled by SEC-02 if partial
    const sev = t.sinks.some(s => s.kind === 'external-write') ? 5 : 4;
    out.push(mk('SEC-01', sev, `${t.name} (${t.kind}) is reachable on ${rs.length} route(s) and none carries a consent gate.`, { tool: t.id }, { routes: rs.map(r => r.route_id) }, [`gate:consent@${t.id}`]));
  }
  return out;
}

/** SEC-02: consent gate present on some routes to a sensitive tool but absent on others (side-route bypass). */
export function ruleSideRoute(m) {
  const routes = enumerateRoutes(m);
  const out = [];
  for (const t of m.tools.filter(isSensitiveTool)) {
    const rs = routes.filter(r => r.tool === t.id);
    const gated = rs.filter(r => consentOnRoute(m, r).present), open = rs.filter(r => !consentOnRoute(m, r).present);
    if (!gated.length || !open.length) continue;
    out.push(mk('SEC-02', 5, `${t.name} is consent-gated via ${[...new Set(gated.map(r => r.caller))].join('/')} but reachable ungated via ${[...new Set(open.map(r => r.caller))].join('/')}.`, { tool: t.id, route: open[0].route_id }, { gated_routes: gated.map(r => r.route_id), open_routes: open.map(r => r.route_id) }, [`gate:consent@${t.id}`]));
  }
  return out;
}

/** SEC-03 (unsanitized) / SEC-05 (deny-list): tainted param flows to a matching dangerous sink. */
export function ruleTaintToSink(m) {
  const out = [];
  for (const t of m.tools) for (const p of t.params) {
    const sinkKinds = TAINT_SINK[p.taint]; if (!sinkKinds) continue;
    for (const s of t.sinks) {
      if (!sinkKinds.includes(s.kind) || !s.params.includes(p.name)) continue;
      const g = s.sanitized_by ? m.gates.find(x => x.id === s.sanitized_by) : null;
      if (g && g.kind !== 'denylist') continue; // allowlist/schema/scope-sanitized: clean
      const sev = p.taint === 'shell' ? 5 : p.taint === 'sql' ? 4 : 4;
      if (!g) out.push(mk('SEC-03', sev, `${t.name}.${p.name} (${p.taint}-tainted, user-controllable) reaches the ${s.kind} sink with no sanitizer.`, { tool: t.id, param: p.name }, { sink: s.kind, taint: p.taint }, [`sanitize:${p.taint}@${t.id}.${p.name}`]));
      else out.push(mk('SEC-05', sev - 1, `${t.name}.${p.name} (${p.taint}) reaches ${s.kind} behind a DENY-list (${g.id}); unlisted variants pass.`, { tool: t.id, param: p.name }, { sink: s.kind, gate: g.id, taint: p.taint }, [`validator:allowlist@${t.id}.${p.name}`]));
    }
  }
  return out;
}

/** SEC-04: a tool that reads a sensitive env var and has an output/log sink with no redaction gate. */
export function ruleSecretToOutput(m) {
  const sens = sensitiveEnvNames(m);
  const out = [];
  for (const t of m.tools) {
    const secrets = t.env.filter(e => sens.has(e)); if (!secrets.length) continue;
    const exposing = t.sinks.filter(s => s.kind === 'output' || s.kind === 'log'); if (!exposing.length) continue;
    if (codeRedaction(m, t.id)) continue;   // prompt-only redaction is a policy, not a defense
    out.push(mk('SEC-04', 4, `${t.name} reads ${secrets.join(', ')} and writes to ${exposing.map(s => s.kind).join('/')} with no redaction gate.`, { tool: t.id, env: secrets[0] }, { secrets, sinks: exposing.map(s => s.kind) }, [`redact:env@${t.id}`]));
  }
  return out;
}

/** SEC-06: raw error policy. */
export function ruleRawErrors(m) {
  return m.tools.filter(t => t.errors === 'raw').map(t => mk('SEC-06', 2, `${t.name} surfaces raw errors (stack / path / connection-string disclosure).`, { tool: t.id }, {}, [`errors:sanitize@${t.id}`]));
}

/** SEC-07: multi-tenant target with a tool that does not bind calls to the caller's scope. */
export function ruleUnscoped(m) {
  if (!m.multi_tenant) return [];
  return m.tools.filter(t => t.scoped === false).map(t => mk('SEC-07', isSensitiveTool(t) ? 4 : 3, `${t.name} is not scope-bound in a multi-tenant target; name collisions resolve to the wrong tenant.`, { tool: t.id }, {}, [`scope:enforce@${t.id}`]));
}

/** SEC-08: a consent gate exists on a route whose entry is non-interactive — the gate cannot fire. */
export function ruleConsentCannotFire(m) {
  const out = [];
  for (const r of enumerateRoutes(m)) {
    const c = consentOnRoute(m, r);
    if (c.present && !c.can_fire) out.push(mk('SEC-08', 4, `${toolById(m, r.tool).name} is consent-gated but reachable from non-interactive entry '${r.entry}' via ${r.caller}; the gate cannot fire there (platform either blocks silently or bypasses).`, { tool: r.tool, route: r.route_id }, { entry: r.entry, gates: c.gates.map(g => g.id) }, [`entry:block-writes@${r.entry}`]));
  }
  return out;
}

/** SEC-09: an actor that both ingests untrusted content (web/tool-output) and holds an ungated sensitive tool — the injection surface. */
export function ruleInjectionSurface(m) {
  const untrusted = untrustedOutputTools(m);
  const routes = enumerateRoutes(m);
  const out = [];
  for (const a of m.actors) {
    const ingest = a.tools.filter(t => untrusted.has(t)); if (!ingest.length) continue;
    for (const tid of a.tools.filter(t => isSensitiveTool(toolById(m, t)))) {
      const rs = routes.filter(r => r.tool === tid && r.caller === a.id);
      if (!rs.length || rs.every(r => consentOnRoute(m, r).present)) continue;
      out.push(mk('SEC-09', 3, `${a.id} ingests untrusted content via ${ingest.join('/')} and can call ${toolById(m, tid).name} ungated: an indirect-injection path to a sensitive action.`, { tool: tid, route: rs[0].route_id }, { actor: a.id, ingest }, [`gate:consent@${tid}`]));
    }
  }
  return out;
}
