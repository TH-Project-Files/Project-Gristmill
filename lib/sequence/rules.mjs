/**
 * Sequence rules — temporal properties over explored paths. Each is a total check over every
 * reachable state to the search depth; the witness is the shortest path that violates it.
 *
 *   SEQ-01 tainted context -> sensitive action without a code gate   (the blast-radius rule)
 *   SEQ-02 approval reuse: a session-scoped gate's approval spent on another subject
 *   SEQ-03 leak chain: secret in context -> outbound without code redaction
 *   SEQ-04 tainted handoff: untrusted content crosses into an actor holding an ungated sensitive tool
 *   SEQ-05 delegation cycle with no turn/call budget (livelock)
 *   SEQ-06 unwinnable: an actor holds an id-taking tool but no way to produce the id
 */
import { hashHex } from '../util.mjs';
import { toolById, actorById, isSensitiveTool, enumerateRoutes, consentOnRoute } from '../model.mjs';

const mk = (rule, severity, summary, subject, evidence, fixes, mode = 'security') => ({ finding_id: `${rule}-${hashHex([rule, subject.tool || '', subject.actor || '', subject.entry || ''].join('|'))}`, rule, mode, severity, fidelity: 'L0', verify_status: 'UNCERTAIN', summary, subject, evidence, cells: [], fix_candidates: fixes });

export function sequenceRules(model, explored, cycles) {
  const out = new Map();
  const put = f => { const e = out.get(f.finding_id); if (!e || (e.evidence.path?.length ?? 99) > (f.evidence.path?.length ?? 99)) out.set(f.finding_id, f); };
  for (const { entry, states, depth } of explored) {
    for (const { state: s, path } of states) {
      const u = s.just_ungated;
      if (u && u.tainted) put(mk('SEQ-01', 5, `${toolById(model, u.tool).name} executes ${u.reason === 'prompt-only' ? 'behind a prompt-only defense' : u.reason === 'gate-cannot-fire' ? 'with a gate that cannot fire on this entry' : 'ungated'} via ${u.actor} after untrusted content entered context (entry ${entry}, ${path.length} steps). If the model is hijacked, nothing in code stops this.`, { tool: u.tool, actor: u.actor, entry }, { path, depth, reason: u.reason }, [`gate:code-enforced@${u.tool}`, `gate:consent@${u.tool}`]));
      const r = s.just_reused;
      if (r) put(mk('SEQ-02', 4, `${toolById(model, r.tool).name}: approval granted for ${r.approved_for} is reused for ${r.used_for} without a new gate (session-scoped consent).`, { tool: r.tool, actor: r.actor, entry }, { path, depth }, [`gate:per-call@${r.tool}`]));
      const lk = s.just_leaked;
      if (lk) put(mk('SEQ-03', 5, `A sensitive value read earlier in the session leaves via an outbound call to ${toolById(model, lk.tool).name} with no code redaction in between (entry ${entry}, ${path.length} steps).`, { tool: lk.tool, entry }, { path, depth }, [`redact:env@${lk.tool}`]));
      const h = s.just_handoff;
      if (h) {
        const to = actorById(model, h.to);
        const open = to.tools.filter(id => isSensitiveTool(toolById(model, id))).filter(id => { const rt = enumerateRoutes(model).find(x => x.tool === id && x.caller === h.to && x.entry === entry); return rt && !consentOnRoute(model, rt).present; });
        for (const id of open) put(mk('SEQ-04', 4, `Untrusted content crosses from ${h.from} to ${h.to}, which holds ${toolById(model, id).name} ungated; the taint label does not survive the handoff.`, { tool: id, actor: h.to, entry }, { path, depth, from: h.from }, [`gate:code-enforced@${id}`]));
      }
    }
  }
  const findings = [...out.values()];
  if (model.budgets.max_turns == null && model.budgets.call_budget == null) for (const c of cycles) findings.push(mk('SEQ-05', 3, `Delegation cycle ${c.join(' <-> ')} with no turn or call budget: ping-pong has no terminator.`, { actor: c[0] }, { cycle: c, path: [] }, [`cycle:budget@${c.join('+')}`, 'budget:call_budget'], 'efficiency'));
  for (const a of model.actors.filter(x => x.kind === 'subagent')) {
    if (a.tools.some(id => (toolById(model, id).produces || []).includes('id'))) continue;
    for (const t of a.tools.map(id => toolById(model, id)).filter(t => t.params.some(p => p.taint === 'id'))) findings.push(mk('SEQ-06', 2, `${a.id} can call ${t.name}, which needs an identifier, but holds no tool that resolves names to identifiers; it depends on the caller passing one correctly.`, { tool: t.id, actor: a.id }, { path: [] }, [`route:unwinnable@${a.id}.${t.id}`], 'efficiency'));
  }
  findings.sort((x, y) => y.severity - x.severity || x.rule.localeCompare(y.rule) || x.finding_id.localeCompare(y.finding_id));
  return findings;
}
