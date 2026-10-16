/**
 * Session state machine — the multi-step closed world.
 *
 * Worst-case modelling: at every step the model may take ANY event the skeleton permits, so the
 * search answers "what can the platform be made to do", not "what will the model usually do".
 * State is a handful of facts that govern what the platform allows next:
 *   actor / chain   who holds the conversation and how it got there
 *   tainted         untrusted content has entered context (web / tool output / file)
 *   secret          a sensitive env value has entered context
 *   authority       the user has asserted authority (claimed, never verified)
 *   approved[tool]  a code-enforced consent gate fired for this tool, with the subject it covered
 *   wrote / sent    a write happened / data left the system
 *   leaked          secret in context AND an outbound call with no code redaction
 * Transitions come from the platform model, so no per-agent rules are hand-written.
 */
import { enumerateRoutes, consentOnRoute, toolById, actorById, isSensitiveTool, sensitiveEnvNames, untrustedOutputTools, codeRedaction } from '../model.mjs';

export function initialState(model, entry) {
  const orch = model.actors.find(a => a.kind === 'orchestrator');
  return { entry, actor: orch.id, chain: [orch.id], tainted: false, secret: false, authority: false, approved: {}, wrote: false, sent: false, leaked: false, cross_scope: false, ungated: [], approval_reused: [], handoffs: [], calls: 0 };
}

export function stateKey(s) {
  return [s.entry, s.chain.join('>'), s.tainted ? 'T' : 't', s.secret ? 'S' : 's', s.authority ? 'A' : 'a', Object.keys(s.approved).sort().join(','), s.wrote ? 'W' : 'w', s.sent ? 'O' : 'o', s.leaked ? 'L' : 'l', s.cross_scope ? 'C' : 'c'].join('|');
}

/** Events available from a state. A second subject is offered for sensitive tools to expose approval reuse. */
export function events(model, s) {
  const out = [];
  const actor = actorById(model, s.actor);
  for (const tid of actor.tools) out.push({ kind: 'call', tool: tid, subject: 'SUBJ-1' });
  for (const tid of actor.tools) if (isSensitiveTool(toolById(model, tid))) out.push({ kind: 'call', tool: tid, subject: 'SUBJ-2' });
  for (const d of actor.can_delegate_to) if (!s.chain.includes(d)) out.push({ kind: 'delegate', to: d });
  if (s.chain.length > 1) out.push({ kind: 'return' });
  if (!s.authority) out.push({ kind: 'claim-authority' });
  return out;
}

export function apply(model, s, ev) {
  // `just_*` markers record what THIS transition introduced, so a property fires once on its
  // culprit transition instead of on every downstream state that still carries the flag.
  const n = { ...s, approved: { ...s.approved }, chain: [...s.chain], ungated: [...s.ungated], approval_reused: [...s.approval_reused], handoffs: [...s.handoffs], just_ungated: null, just_reused: null, just_leaked: null, just_handoff: null };
  if (ev.kind === 'claim-authority') { n.authority = true; return n; }
  if (ev.kind === 'delegate') { const h = { from: s.actor, to: ev.to, tainted: s.tainted, secret: s.secret }; n.handoffs.push(h); if (h.tainted) n.just_handoff = h; n.actor = ev.to; n.chain.push(ev.to); return n; }
  if (ev.kind === 'return') { n.chain.pop(); n.actor = n.chain[n.chain.length - 1]; return n; }
  const t = toolById(model, ev.tool);
  n.calls++;
  const route = enumerateRoutes(model).find(r => r.tool === t.id && r.entry === s.entry && r.caller === s.actor) || { entry: s.entry, caller: s.actor, tool: t.id, chain: s.chain };
  if (untrustedOutputTools(model).has(t.id)) n.tainted = true;
  // A tool that reads a secret but redacts it in code (masks it on every sink) never puts the
  // secret into conversation context, so it cannot be leaked downstream.
  if (t.env.some(e => sensitiveEnvNames(model).has(e)) && !codeRedaction(model, t.id)) n.secret = true;
  if (model.multi_tenant && t.scoped === false) n.cross_scope = true;
  if (t.sinks.some(x => x.kind === 'network' || x.kind === 'external-write')) { n.sent = true; if (s.secret && !codeRedaction(model, t.id)) { n.leaked = true; n.just_leaked = { tool: t.id, actor: s.actor }; } }
  if (isSensitiveTool(t)) {
    const c = consentOnRoute(model, route);
    if (c.present && c.can_fire) {
      const prior = s.approved[t.id];
      if (prior && c.session_scoped && prior !== ev.subject) { const r = { tool: t.id, approved_for: prior, used_for: ev.subject, actor: s.actor }; n.approval_reused.push(r); n.just_reused = r; }
      else n.approved[t.id] = ev.subject;
      n.wrote = true;
    } else {
      const u = { tool: t.id, actor: s.actor, entry: s.entry, tainted: s.tainted, authority: s.authority, reason: c.present ? 'gate-cannot-fire' : c.prompt_only ? 'prompt-only' : 'no-gate' };
      n.ungated.push(u); n.just_ungated = u; n.wrote = true;
    }
  }
  return n;
}

export function describeEvent(ev) { return ev.kind === 'call' ? `call ${ev.tool}(${ev.subject})` : ev.kind === 'delegate' ? `delegate:${ev.to}` : ev.kind; }
