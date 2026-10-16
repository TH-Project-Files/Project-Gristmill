/**
 * Platform model: normalization, route enumeration, gate coverage, graph queries.
 * This is the closed world. Every analyzer, the lattice and the simulator read from here.
 */
import { uniq } from './util.mjs';

const TOOL_DEFAULTS = {
  purpose: '', description: '', tags: [], params: [], sinks: [], env: [], gates: [],
  limit_param: null, batch_of: null, retries: null, errors: 'unknown', scoped: null, cost_hint: 1,
};

export function normalizeModel(raw) {
  const m = structuredCloneSafe(raw);
  m.extraction = { method: 'manual', confidence: 'heuristic', notes: [], ...(m.extraction || {}) };
  m.entries = (m.entries || []).map(e => ({ interactive: e.kind === 'chat' || e.kind === 'cli', ...e }));
  m.actors = (m.actors || []).map(a => ({ model: 'unknown', prompt: '', tools: [], can_delegate_to: [], ...a }));
  m.tools = (m.tools || []).map(t => ({ ...TOOL_DEFAULTS, ...t, params: (t.params || []).map(p => ({ required: true, taint: 'none', ...p })), sinks: (t.sinks || []).map(s => ({ params: [], sanitized_by: null, ...s })) }));
  m.gates = (m.gates || []).map(g => ({ via: null, params: [], enforced_by: 'code', scope: 'call', ...g }));
  m.env = m.env || [];
  m.policies = uniq(m.policies || []);
  // Prompt policies are defenses too — just ones the model can be talked out of. Materialize them as
  // VIRTUAL gates with enforced_by:'prompt' so every engine sees the same defense inventory and can
  // tell structural from wishful. consentOnRoute() counts only code-enforced gates as "present".
  const sensitiveIds = m.tools.filter(t => t.kind === 'write' || t.kind === 'external-action').map(t => t.id);
  const sensEnv = new Set(m.env.filter(e => e.sensitive).map(e => e.name));
  if (m.policies.includes('confirm-before-write') && sensitiveIds.length) m.gates.push({ id: 'policy:confirm-before-write', kind: 'confirm', enforced_by: 'prompt', scope: 'call', virtual: true, applies_to: sensitiveIds, via: null, params: [] });
  if (m.policies.includes('never-echo-secrets')) { const holders = m.tools.filter(t => (t.env || []).some(e => sensEnv.has(e))).map(t => t.id); if (holders.length) m.gates.push({ id: 'policy:never-echo-secrets', kind: 'redaction', enforced_by: 'prompt', scope: 'call', virtual: true, applies_to: holders, via: null, params: [] }); }
  for (const t of m.tools) if (!Array.isArray(t.produces)) t.produces = t.kind === 'read' && /lookup|search|find|list|resolve|get_/.test(t.id) && t.params.some(p => p.taint === 'text' || p.taint === 'id' || p.taint === 'email') ? ['id'] : [];
  m.sources = m.sources || [{ id: 'user', kind: 'user', trust: 'untrusted' }];
  m.budgets = { call_budget: null, max_turns: null, output_char_limit: null, ...(m.budgets || {}) };
  m.known_outages = m.known_outages || [];
  m.multi_tenant = !!m.multi_tenant;
  m.policies = uniq(m.policies || []);
  // Handlers are kept on a side table so the model itself stays plain data.
  m._handlers = {};
  for (const t of m.tools) if (typeof t.handler === 'function') { m._handlers[t.id] = t.handler; delete t.handler; }
  validateModel(m);
  return m;
}

function structuredCloneSafe(v) {
  // Keep functions (handlers) — structuredClone would drop/throw on them.
  if (Array.isArray(v)) return v.map(structuredCloneSafe);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = structuredCloneSafe(v[k]); return o; }
  return v;
}

export function validateModel(m) {
  const errs = [];
  const toolIds = new Set(m.tools.map(t => t.id));
  const actorIds = new Set(m.actors.map(a => a.id));
  const gateIds = new Set(m.gates.map(g => g.id));
  if (!m.target?.name) errs.push('target.name missing');
  if (!m.actors.some(a => a.kind === 'orchestrator')) errs.push('no orchestrator actor');
  for (const a of m.actors) {
    for (const t of a.tools) if (!toolIds.has(t)) errs.push(`actor ${a.id} lists unknown tool ${t}`);
    for (const d of a.can_delegate_to) if (!actorIds.has(d)) errs.push(`actor ${a.id} delegates to unknown actor ${d}`);
  }
  for (const g of m.gates) {
    for (const t of g.applies_to) if (!toolIds.has(t)) errs.push(`gate ${g.id} protects unknown tool ${t}`);
    for (const v of g.via || []) if (!actorIds.has(v)) errs.push(`gate ${g.id} via unknown actor ${v}`);
  }
  for (const t of m.tools) {
    for (const g of t.gates) if (!gateIds.has(g)) errs.push(`tool ${t.id} names unknown gate ${g}`);
    for (const s of t.sinks) {
      if (s.sanitized_by && !gateIds.has(s.sanitized_by)) errs.push(`tool ${t.id} sink ${s.kind} sanitized_by unknown gate ${s.sanitized_by}`);
      for (const p of s.params) if (!t.params.some(x => x.name === p)) errs.push(`tool ${t.id} sink ${s.kind} references unknown param ${p}`);
    }
    if (t.batch_of && !toolIds.has(t.batch_of)) errs.push(`tool ${t.id} batch_of unknown tool ${t.batch_of}`);
  }
  if (errs.length) throw new Error('Invalid platform model:\n  ' + errs.join('\n  '));
  return true;
}

export const toolById = (m, id) => m.tools.find(t => t.id === id);
export const actorById = (m, id) => m.actors.find(a => a.id === id);
export const gateById = (m, id) => m.gates.find(g => g.id === id);

/**
 * Enumerate every route: entry -> actor chain -> tool. Finite because actors form a small
 * delegation graph; cycles are cut (an actor appears at most once per chain).
 */
export function enumerateRoutes(m) {
  const routes = [];
  const orchestrators = m.actors.filter(a => a.kind === 'orchestrator');
  const walk = (entry, chain) => {
    const actor = actorById(m, chain[chain.length - 1]);
    for (const tid of actor.tools) {
      routes.push({ route_id: `${entry.id}>${chain.join('>')}>${tid}`, entry: entry.id, chain: [...chain], caller: actor.id, tool: tid });
    }
    for (const d of actor.can_delegate_to) if (!chain.includes(d)) walk(entry, [...chain, d]);
  };
  for (const e of m.entries) for (const o of orchestrators) walk(e, [o.id]);
  return routes;
}

/** Gates that actually protect a given route (tool + caller). */
export function gatesOnRoute(m, route) {
  const tool = toolById(m, route.tool);
  const out = [];
  for (const g of m.gates) {
    const protects = g.applies_to.includes(route.tool) || tool.gates.includes(g.id);
    if (!protects) continue;
    if (g.via && !g.via.includes(route.caller)) continue;
    out.push(g);
  }
  return out;
}

/**
 * Does this route have a *consent* gate (hitl/confirm) that can fire on its entry?
 * Only CODE-enforced gates count as present; prompt-enforced ones are reported separately so the
 * engines can say "the only defense here is a sentence the model may ignore".
 */
export function consentOnRoute(m, route) {
  const entry = m.entries.find(e => e.id === route.entry);
  const all = gatesOnRoute(m, route).filter(g => g.kind === 'hitl' || g.kind === 'confirm');
  const gs = all.filter(g => (g.enforced_by || 'code') === 'code');
  const prompt = all.filter(g => g.enforced_by === 'prompt');
  return { gates: gs, prompt_gates: prompt, present: gs.length > 0, prompt_only: gs.length === 0 && prompt.length > 0, can_fire: gs.length > 0 && !!entry?.interactive, session_scoped: gs.some(g => g.scope === 'session') };
}

/** Code-enforced redaction on a tool? (prompt-enforced redaction is a policy, not a gate) */
export function codeRedaction(m, toolId) { return m.gates.some(g => g.kind === 'redaction' && (g.enforced_by || 'code') === 'code' && g.applies_to.includes(toolId)); }

export function isSensitiveTool(t) { return t.kind === 'write' || t.kind === 'external-action'; }

export function sensitiveEnvNames(m) { return new Set(m.env.filter(e => e.sensitive).map(e => e.name)); }

/** Tools nobody can reach from any entry (dead context weight). */
export function unreachableTools(m, routes = enumerateRoutes(m)) {
  const reached = new Set(routes.map(r => r.tool));
  return m.tools.filter(t => !reached.has(t.id));
}

/** Overlap between two tools' purposes: tag jaccard blended with name-token overlap. */
export function purposeOverlap(a, b) {
  const tok = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2);
  const tags = jaccardArr(a.tags, b.tags);
  const words = jaccardArr(tok(a.purpose + ' ' + a.name), tok(b.purpose + ' ' + b.name));
  return 0.7 * tags + 0.3 * words;
}
function jaccardArr(a, b) {
  const A = new Set(a || []), B = new Set(b || []);
  if (!A.size && !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

/** Prompt mass per actor: system prompt + the descriptions of the tools it carries. */
export function promptMass(m, estTokens) {
  return m.actors.map(a => {
    const toolText = a.tools.map(id => { const t = toolById(m, id); return `${t.name} ${t.description || t.purpose} ${JSON.stringify(t.params)}`; }).join('\n');
    return { actor: a.id, prompt_tokens: estTokens(a.prompt), tool_tokens: estTokens(toolText), tools: a.tools.length, total: estTokens(a.prompt) + estTokens(toolText) };
  });
}

/** Build a plain node/edge graph for reporting and for sink-reachability queries. */
export function buildGraph(m) {
  const nodes = [], edges = [];
  const add = (id, kind, label) => nodes.push({ id, kind, label: label || id });
  for (const e of m.entries) add(`entry:${e.id}`, 'entry', e.id);
  for (const a of m.actors) add(`actor:${a.id}`, a.kind, a.id);
  for (const t of m.tools) add(`tool:${t.id}`, 'tool', t.name);
  for (const g of m.gates) add(`gate:${g.id}`, 'gate', g.id);
  for (const s of m.sources) add(`source:${s.id}`, 'source', s.id);
  const sinkKinds = uniq(m.tools.flatMap(t => t.sinks.map(s => s.kind)));
  for (const k of sinkKinds) add(`sink:${k}`, 'sink', k);
  for (const e of m.entries) for (const o of m.actors.filter(a => a.kind === 'orchestrator')) edges.push({ from: `entry:${e.id}`, to: `actor:${o.id}`, kind: 'enters' });
  for (const a of m.actors) {
    for (const d of a.can_delegate_to) edges.push({ from: `actor:${a.id}`, to: `actor:${d}`, kind: 'delegates' });
    for (const t of a.tools) {
      const gs = gatesOnRoute(m, { tool: t, caller: a.id, entry: m.entries[0]?.id });
      edges.push({ from: `actor:${a.id}`, to: `tool:${t}`, kind: 'invokes', gated_by: gs.map(g => g.id) });
    }
  }
  for (const t of m.tools) {
    for (const s of t.sinks) edges.push({ from: `tool:${t.id}`, to: `sink:${s.kind}`, kind: 'flows', params: s.params, sanitized_by: s.sanitized_by });
    for (const p of t.params) if (p.taint !== 'none') edges.push({ from: 'source:user', to: `tool:${t.id}`, kind: 'taints', param: p.name, taint: p.taint });
  }
  for (const s of m.sources) for (const f of s.feeds || []) edges.push({ from: `tool:${f}`, to: `source:${s.id}`, kind: 'produces' });
  return { nodes, edges };
}

/** Tool-output sources that are untrusted: which tools' outputs carry untrusted content. */
export function untrustedOutputTools(m) {
  return new Set(m.sources.filter(s => s.trust === 'untrusted' && s.kind !== 'user').flatMap(s => s.feeds || []));
}
