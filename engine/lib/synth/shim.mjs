/**
 * Binding a REAL agent package's handlers to the harness, without refactoring the package.
 *
 * Francisco-style handlers close over `env` from createTools(env) and call global `fetch`. The
 * harness needs both to go through its recording fakes. Two pieces:
 *
 *   bindFranciscoTool(createTools, toolName) -> handler(args, ctx)
 *     calls createTools(ctx.env) per case (so the package only ever sees the locked env, whose
 *     sensitive values are canaries), finds the named tool, and runs its handler under withFetch.
 *
 *   withFetch(ctxFetch, fn)
 *     swaps globalThis.fetch for one that records through ctx.fetch and returns a real Response,
 *     then restores it — even on throw.
 *
 * Limits, stated plainly: network that bypasses global fetch (node:https, ldapjs, SMB, a vendored
 * HTTP client) is NOT intercepted. That is why the env holds canaries only: an escaped call cannot
 * authenticate with a real secret. Run L1 binding on a machine with no real credentials in reach.
 */

export async function withFetch(ctxFetch, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const r = await ctxFetch(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

/** Text out of an MCP-style tool result ({ content: [{ type:'text', text }] }) or anything else. */
export function resultText(res) {
  if (res == null) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) return res.content.map(c => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n');
  return JSON.stringify(res);
}

export function bindFranciscoTool(createTools, toolName) {
  return async (args, ctx) => withFetch(ctx.fetch, async () => {
    const tools = createTools(ctx.env);
    const def = (Array.isArray(tools) ? tools : []).find(t => t && t.name === toolName);
    if (!def || typeof def.handler !== 'function') throw new Error(`createTools() did not return a tool named ${toolName}`);
    const res = await def.handler(args, {});
    return ctx.output(resultText(res));
  });
}

/** Attach bound handlers to every tool of a (heuristic) model whose name createTools provides. */
export function bindAll(model, createTools) {
  let probe;
  try { probe = createTools(new Proxy({}, { get: () => 'probe' })); } catch { probe = []; }
  const names = new Set((Array.isArray(probe) ? probe : []).map(t => t?.name).filter(Boolean));
  let bound = 0;
  for (const t of model.tools) if (names.has(t.name)) { t.handler = bindFranciscoTool(createTools, t.name); bound++; }
  model.extraction = model.extraction || {};
  model.extraction.notes = [...(model.extraction.notes || []), `${bound}/${model.tools.length} handlers bound from the package's createTools() via the fetch/env shim (network outside global fetch is not intercepted)`];
  return model;
}
