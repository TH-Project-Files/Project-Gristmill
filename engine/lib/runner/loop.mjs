/**
 * The transport-agnostic agent loop.
 *
 * A "live" run drives the TARGET's real tool handlers with a real model, every sink a recording
 * fake, so the blast radius is tokens not state. The loop needs exactly ONE thing from the outside
 * world — a `complete` function that turns a conversation into the model's next turn:
 *
 *   complete({ system, tools, messages }) -> { text, tool_uses:[{id,name,input}], stop, usage }
 *
 * where messages/tools/content use the NEUTRAL shape below. Everything the loop reproduces of the
 * platform — delegation, code-enforced gates, handler execution via the harness fakes, injected
 * context as tool-returned data — is independent of HOW that completion was obtained. So the same
 * loop runs on the Anthropic API, an OpenAI-compatible endpoint, a Bedrock/Vertex binding, or a
 * subprocess the host wires to whatever model its harness already has. No provider is hard-coded.
 *
 * Neutral content blocks: {type:'text',text} | {type:'tool_use',id,name,input} |
 *                         {type:'tool_result',tool_use_id,content,is_error?}
 */
import { consentOnRoute, enumerateRoutes, actorById, toolById } from '../model.mjs';
import { makeCtx } from '../synth/runtime.mjs';
import { withSandbox } from '../synth/shim.mjs';

export function createModelRunner(model, { complete, modelId = 'host-model', maxTurns = null, nonInteractiveGate = 'block', kind = 'model', transport = 'custom' } = {}) {
  if (typeof complete !== 'function') throw new Error('createModelRunner needs a complete({system,tools,messages}) function');
  const routes = enumerateRoutes(model);
  const untrustedFeeds = new Set(model.sources.filter(s => s.trust === 'untrusted' && s.kind !== 'user').flatMap(s => s.feeds || []));
  const turnCap = maxTurns || model.budgets.max_turns || 12;

  function toolDefs(actor) {
    const defs = actor.tools.map(id => { const t = toolById(model, id); return { name: t.name, description: t.description || t.purpose || t.name, input_schema: schemaOf(t) }; });
    for (const d of actor.can_delegate_to) defs.push({ name: `delegate_to_${d}`, description: `Hand the task to the ${d} specialist. ${actorById(model, d).prompt.slice(0, 200)}`, input_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } });
    return defs;
  }

  async function loop({ actor, entry, chain, userText, attachments, cell, rec }) {
    const messages = [{ role: 'user', content: [{ type: 'text', text: userText }, ...attachments.map(a => ({ type: 'text', text: `<attached_untrusted_document source="${a.source}">\n${a.content}\n</attached_untrusted_document>` }))] }];
    let finalText = '';
    for (let turn = 0; turn < turnCap; turn++) {
      const resp = await complete({ system: actor.prompt, tools: toolDefs(actor), messages });
      rec.tokens += (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);
      const uses = resp.tool_uses || [];
      if (resp.text) finalText = resp.text;
      if (!uses.length) break;
      messages.push({ role: 'assistant', content: [...(resp.text ? [{ type: 'text', text: resp.text }] : []), ...uses.map(u => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input }))] });
      const results = [];
      for (const u of uses) {
        if (u.name.startsWith('delegate_to_')) {
          const target = u.name.slice('delegate_to_'.length);
          if (!actorById(model, target) || !actor.can_delegate_to.includes(target)) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'no such delegate', is_error: true }); continue; }
          rec.steps.push({ actor: actor.id, action: 'delegate', to: target });
          const sub = await loop({ actor: actorById(model, target), entry, chain: [...chain, target], userText: String(u.input?.task || userText), attachments: [], cell, rec });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: String(sub).slice(0, 4000) });
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
          else { const { ctx, rec: hrec } = makeCtx(model, tool); try { out = String(await withSandbox(() => handler(u.input || {}, ctx), { ctxFetch: ctx.fetch })); } catch (e) { out = `error: ${String(e.message || e).split('\n')[0]}`; } rec.logs.push(...hrec.logs); rec.outputs.push(...hrec.outputs); }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 6000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return finalText;
  }

  return {
    kind, transport, fidelity: 'L2', mock: false, backends: 'fakes',   // every tool call goes through makeCtx recording fakes
    describe() { return { model_version: modelId, transport }; },
    async run(cell) {
      const orchestrator = model.actors.find(a => a.kind === 'orchestrator');
      const entry = cell.coords.entry;
      const rec = { steps: [{ actor: orchestrator.id, action: 'route' }], tokens: 0, gate_fired: false, logs: [], outputs: [], injectionDelivered: false };
      const attachments = cell.injected_context.length && !model.tools.some(t => untrustedFeeds.has(t.id)) ? cell.injected_context : [];
      const finalText = await loop({ actor: orchestrator, entry, chain: [orchestrator.id], userText: cell.prompt, attachments, cell, rec });
      const handler = rec.steps.find(s => s.action === 'tool_call')?.actor || orchestrator.id;
      return { fidelity: 'L2', steps: rec.steps, final_answer: finalText, output: rec.outputs.join('\n'), logs: rec.logs, gate_fired: rec.gate_fired, handler, tokens: rec.tokens, model_version: modelId, transport, injection_seen: rec.injectionDelivered || attachments.length > 0 };
    },
  };
}

export function schemaOf(t) {
  const props = {}, required = [];
  for (const p of t.params) {
    const s = p.type === 'enum' ? { type: 'string', enum: p.enum } : p.type === 'array' ? { type: 'array', items: { type: 'string' } } : p.type === 'integer' ? { type: 'integer' } : { type: p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string' };
    if (p.maxLength) s.maxLength = p.maxLength; if (p.min != null) s.minimum = p.min; if (p.max != null) s.maximum = p.max;
    props[p.name] = s; if (p.required !== false) required.push(p.name);
  }
  return { type: 'object', properties: props, required };
}
