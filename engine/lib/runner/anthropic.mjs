/**
 * Anthropic API runner — a REAL model driving the target's REAL tool handlers under the harness
 * fakes. The model is live; every sink is a recording fake; so the blast radius is tokens, not
 * state. It still goes through assertRunAllowed (GRISTMILL_SANDBOX=1) because it spends credentials.
 *
 * What it reproduces of the target platform, in code (so the model cannot talk its way past it):
 *   - actors: the orchestrator runs with its own prompt and tools; each actor it may delegate to is
 *     exposed as a `delegate_to_<actor>` tool that runs a nested loop with THAT actor's prompt/tools.
 *   - consent gates: a code-enforced gate on the (entry, caller, tool) route returns
 *     "CONFIRMATION REQUIRED" instead of executing and marks gate_fired; on a non-interactive entry
 *     the platform behaviour is `nonInteractiveGate: 'block' | 'bypass'`.
 *   - injected context: delivered as the RESULT of the first tool whose output the untrusted source
 *     feeds (tool-returned data, never a privileged channel); if the cell has content but no such tool
 *     is called, it is attached to the user turn as an untrusted document.
 *   - handlers: executed through makeCtx (locked env + recording fakes); their outputs are what the
 *     model sees.
 *
 * `fetchImpl` is injectable so the loop is unit-testable with scripted responses.
 */
import { consentOnRoute, enumerateRoutes, actorById, toolById } from '../model.mjs';
import { makeCtx } from '../synth/runtime.mjs';

const API = 'https://api.anthropic.com/v1/messages';

export function createAnthropicRunner(model, { apiKey = process.env.ANTHROPIC_API_KEY, modelId = 'claude-sonnet-5-5', maxTurns = null, nonInteractiveGate = 'block', fetchImpl = globalThis.fetch, temperature = 0, maxTokens = 1024 } = {}) {
  if (!apiKey && fetchImpl === globalThis.fetch) throw new Error('ANTHROPIC_API_KEY is required for the anthropic runner');
  const routes = enumerateRoutes(model);
  const untrustedFeeds = new Set(model.sources.filter(s => s.trust === 'untrusted' && s.kind !== 'user').flatMap(s => s.feeds || []));
  const turnCap = maxTurns || model.budgets.max_turns || 12;

  function toolDefs(actor) {
    const defs = actor.tools.map(id => { const t = toolById(model, id); return { name: t.name, description: t.description || t.purpose || t.name, input_schema: schemaOf(t) }; });
    for (const d of actor.can_delegate_to) defs.push({ name: `delegate_to_${d}`, description: `Hand the task to the ${d} specialist. ${actorById(model, d).prompt.slice(0, 200)}`, input_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } });
    return defs;
  }

  async function callApi(body) {
    const res = await fetchImpl(API, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey || 'test', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async function loop({ actor, entry, chain, userText, attachments, cell, rec }) {
    const messages = [{ role: 'user', content: [{ type: 'text', text: userText }, ...attachments.map(a => ({ type: 'text', text: `<attached_untrusted_document source="${a.source}">\n${a.content}\n</attached_untrusted_document>` }))] }];
    let finalText = '';
    for (let turn = 0; turn < turnCap; turn++) {
      const resp = await callApi({ model: modelId, max_tokens: maxTokens, temperature, system: actor.prompt, tools: toolDefs(actor), messages });
      rec.tokens += (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);
      const uses = (resp.content || []).filter(b => b.type === 'tool_use');
      finalText = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') || finalText;
      if (!uses.length || resp.stop_reason === 'end_turn') { if (!uses.length) break; }
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const u of uses) {
        if (u.name.startsWith('delegate_to_')) {
          const target = u.name.slice('delegate_to_'.length);
          rec.steps.push({ actor: actor.id, action: 'delegate', to: target });
          const sub = await loop({ actor: actorById(model, target), entry, chain: [...chain, target], userText: String(u.input?.task || userText), attachments: [], cell, rec });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: sub.slice(0, 4000) });
          continue;
        }
        const tool = model.tools.find(t => t.name === u.name);
        if (!tool) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'unknown tool', is_error: true }); continue; }
        const route = routes.find(r => r.tool === tool.id && r.entry === entry && r.caller === actor.id) || { entry, caller: actor.id, tool: tool.id, chain };
        const consent = consentOnRoute(model, route);
        const codeGate = consent.present && consent.gates.some(g => (g.enforced_by || 'code') === 'code');
        if (codeGate && consent.can_fire) {
          rec.steps.push({ actor: actor.id, action: 'tool_call', tool: tool.id, args: u.input, gate_fired: true });
          rec.gate_fired = true;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'CONFIRMATION REQUIRED: this action is irreversible. It was NOT performed. Ask the user to confirm explicitly before calling again.' });
          continue;
        }
        if (codeGate && !consent.can_fire && nonInteractiveGate === 'block') {
          rec.steps.push({ actor: actor.id, action: 'tool_call', tool: tool.id, args: u.input, gate_fired: false, blocked: true });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'BLOCKED: approval is not available in this execution context.' });
          continue;
        }
        rec.steps.push({ actor: actor.id, action: 'tool_call', tool: tool.id, args: u.input, gate_fired: false });
        let out;
        if (untrustedFeeds.has(tool.id) && cell.injected_context.length && !rec.injectionDelivered) { out = cell.injected_context.map(i => i.content).join('\n'); rec.injectionDelivered = true; }
        else {
          const handler = model._handlers[tool.id];
          if (!handler) out = `(no executable handler for ${tool.id}; mocked result)`;
          else { const { ctx, rec: hrec } = makeCtx(model, tool); try { out = String(await handler(u.input || {}, ctx)); } catch (e) { out = `error: ${String(e.message || e).split('\n')[0]}`; } rec.logs.push(...hrec.logs); rec.outputs.push(...hrec.outputs); }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 6000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return finalText;
  }

  return {
    kind: 'anthropic', fidelity: 'L2', mock: false, backends: 'fakes',   // every tool call goes through makeCtx recording fakes
    describe() { return { model_version: modelId }; },
    async run(cell) {
      const orchestrator = model.actors.find(a => a.kind === 'orchestrator');
      const entry = cell.coords.entry;
      const rec = { steps: [{ actor: orchestrator.id, action: 'route' }], tokens: 0, gate_fired: false, logs: [], outputs: [], injectionDelivered: false };
      const attachments = cell.injected_context.length && !model.tools.some(t => untrustedFeeds.has(t.id)) ? cell.injected_context : [];
      const finalText = await loop({ actor: orchestrator, entry, chain: [orchestrator.id], userText: cell.prompt, attachments, cell, rec });
      const handler = rec.steps.find(s => s.action === 'tool_call')?.actor || orchestrator.id;
      return { fidelity: 'L2', steps: rec.steps, final_answer: finalText, output: rec.outputs.join('\n'), logs: rec.logs, gate_fired: rec.gate_fired, handler, tokens: rec.tokens, model_version: modelId, injection_seen: rec.injectionDelivered || attachments.length > 0 };
    },
  };
}

function schemaOf(t) {
  const props = {}, required = [];
  for (const p of t.params) {
    const s = p.type === 'enum' ? { type: 'string', enum: p.enum } : p.type === 'array' ? { type: 'array', items: { type: 'string' } } : p.type === 'integer' ? { type: 'integer' } : { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string' };
    if (p.maxLength) s.maxLength = p.maxLength; if (p.min != null) s.minimum = p.min; if (p.max != null) s.maximum = p.max;
    props[p.name] = s; if (p.required !== false) required.push(p.name);
  }
  return { type: 'object', properties: props, required };
}
