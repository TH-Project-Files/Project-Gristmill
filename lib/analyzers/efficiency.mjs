/**
 * Efficiency analyzers — EXHAUSTIVE over the closed world (see security.mjs header).
 * These find the structural causes of waste: missing budgets, dead-source retries, duplicate
 * tools, per-item routes where a batch form exists, uncapped reads, dead tools, prompt mass.
 */
import { enumerateRoutes, toolById, purposeOverlap, promptMass, unreachableTools } from '../model.mjs';
import { estTokens } from '../util.mjs';

export const EFF_DEFAULTS = { duplicate_overlap: 0.6, prompt_mass_tokens: 6000, uncapped_cost_hint: 3 };

export function efficiencyAnalyzers(opts = {}) {
  const o = { ...EFF_DEFAULTS, ...opts };
  return [ruleNoBudget, m => ruleRetryKnownOutage(m), m => ruleDuplicateTools(m, o), ruleIterateWhereBatch, m => rulePromptMass(m, o), m => ruleUncappedRead(m, o), ruleUnreachable, ruleDualRoute];
}

function mk(rule, severity, summary, subject, evidence, fixes) {
  return { rule, mode: 'efficiency', severity, fidelity: 'L0', verify_status: 'UNCERTAIN', summary, subject, evidence, fix_candidates: fixes };
}

/** EFF-01: no session call budget. */
export function ruleNoBudget(m) {
  return m.budgets.call_budget == null ? [mk('EFF-01', 3, 'No session-wide tool-call budget: wide tasks can run unbounded (cost, latency, worker exhaustion).', {}, {}, ['budget:call_budget'])] : [];
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** EFF-02: a tool that retries against a source the model lists as down, without outage awareness. */
export function ruleRetryKnownOutage(m) {
  const out = [];
  const outages = m.known_outages.map(norm);
  for (const t of m.tools) {
    if (!t.retries) continue;
    const hay = norm([t.id, t.name, t.purpose, ...(t.tags || [])].join(' '));
    const hit = outages.find(o => o && hay.includes(o));
    if (!t.retries.outage_aware && hit) out.push(mk('EFF-02', 3, `${t.name} retries up to ${t.retries.max}× without consulting outage state, and its source (${hit}) is a known outage: a guaranteed retry loop.`, { tool: t.id }, { retries: t.retries, outage: hit }, [`retries:outage-aware@${t.id}`]));
    else if (!t.retries.backoff && t.retries.max > 2) out.push(mk('EFF-02', 2, `${t.name} retries ${t.retries.max}× with no backoff.`, { tool: t.id }, { retries: t.retries }, [`retries:outage-aware@${t.id}`]));
  }
  return out;
}

/** EFF-03: two tools with overlapping purpose both reachable by the same actor. */
export function ruleDuplicateTools(m, o) {
  const out = [];
  const seen = new Set();
  for (const a of m.actors) {
    const ts = a.tools.map(id => toolById(m, id));
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const A = ts[i], B = ts[j];
      if (A.batch_of === B.id || B.batch_of === A.id) continue; // batch pairs are intentional
      const ov = purposeOverlap(A, B);
      if (ov < o.duplicate_overlap) continue;
      const key = [A.id, B.id].sort().join('+');
      if (seen.has(key)) continue; seen.add(key);
      out.push(mk('EFF-03', 2, `${A.name} and ${B.name} overlap (${ov.toFixed(2)}) and are both offered to ${a.id}: context cost plus double-dispatch risk.`, { tool: A.id }, { pair: [A.id, B.id], overlap: +ov.toFixed(3), actor: a.id }, [`tool:merge@${key}`]));
    }
  }
  return out;
}

/** EFF-04: a per-item tool is reachable where a batch form exists, without an aggregate-first policy. */
export function ruleIterateWhereBatch(m) {
  const out = [];
  const hasPolicy = m.policies.includes('aggregate-first');
  for (const batch of m.tools.filter(t => t.batch_of)) {
    const item = toolById(m, batch.batch_of);
    for (const a of m.actors) {
      if (!a.tools.includes(item.id)) continue;
      const perItemPrompt = /one call per|per[- ]item|each device|for each/i.test(a.prompt);
      if (!a.tools.includes(batch.id)) out.push(mk('EFF-04', 3, `${a.id} can call ${item.name} but not its batch form ${batch.name}: N-item tasks become N calls on this route.`, { tool: item.id }, { actor: a.id, batch: batch.id }, [`routing:expose-batch@${a.id}.${batch.id}`]));
      else if (!hasPolicy || perItemPrompt) out.push(mk('EFF-04', perItemPrompt ? 3 : 2, `${a.id} holds both ${item.name} and ${batch.name} but ${perItemPrompt ? 'its prompt instructs per-item calls' : 'no aggregate-first policy prefers the batch form'}.`, { tool: item.id }, { actor: a.id, batch: batch.id, per_item_prompt: perItemPrompt }, [`policy:aggregate-first@${a.id}`]));
    }
  }
  return out;
}

/** EFF-05: prompt mass per actor above threshold, or a tool carried by 3+ actors. */
export function rulePromptMass(m, o) {
  const out = [];
  for (const pm of promptMass(m, estTokens)) {
    if (pm.total > o.prompt_mass_tokens) out.push(mk('EFF-05', 2, `${pm.actor} carries ~${pm.total} tokens of prompt+tool text every turn (${pm.tools} tools).`, {}, pm, [`prompt:trim@${pm.actor}`]));
  }
  const carriers = new Map();
  for (const a of m.actors) for (const t of a.tools) carriers.set(t, (carriers.get(t) || 0) + 1);
  for (const [t, n] of carriers) if (n >= 3) out.push(mk('EFF-05', 1, `${toolById(m, t).name} is carried by ${n} actors; its description is paid for ${n}× per turn.`, { tool: t }, { carriers: n }, [`routing:single-owner@${t}`]));
  return out;
}

/** EFF-06: a heavy / list-shaped read with no limit parameter. */
export function ruleUncappedRead(m, o) {
  return m.tools.filter(t => t.kind === 'read' && !t.limit_param && (t.cost_hint >= o.uncapped_cost_hint || (t.tags || []).some(x => ['list', 'fleet', 'all', 'scan', 'export'].includes(x))))
    .map(t => mk('EFF-06', 3, `${t.name} returns an uncapped result set (no limit/pagination parameter): context flood or truncation on wide queries.`, { tool: t.id }, {}, [`limit:add@${t.id}`]));
}

/** EFF-07: tools no entry can reach. */
export function ruleUnreachable(m) {
  return unreachableTools(m).map(t => mk('EFF-07', 1, `${t.name} is unreachable from every entry: dead weight.`, { tool: t.id }, {}, [`routing:single-owner@${t.id}`]));
}

/** EFF-08: a READ tool reachable both directly from the orchestrator and via a subagent (double-dispatch risk). */
export function ruleDualRoute(m) {
  const routes = enumerateRoutes(m);
  const out = [];
  for (const t of m.tools.filter(t => t.kind === 'read')) {
    const callers = [...new Set(routes.filter(r => r.tool === t.id).map(r => r.caller))];
    const orch = m.actors.filter(a => a.kind === 'orchestrator').map(a => a.id);
    if (callers.some(c => orch.includes(c)) && callers.some(c => !orch.includes(c)))
      out.push(mk('EFF-08', 2, `${t.name} is callable directly by the orchestrator AND via ${callers.filter(c => !orch.includes(c)).join('/')}: both may fire for one question.`, { tool: t.id }, { callers }, [`routing:single-owner@${t.id}`]));
  }
  return out;
}
