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
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';

/**
 * Host variables a JS package or a child process may legitimately need that carry no secret.
 * Everything else in the host environment (API keys, cloud credentials, tokens) is hidden.
 */
const SAFE_HOST_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'TZ', 'NODE_ENV'];
export function scrubbedEnv(host = process.env) { const e = {}; for (const k of SAFE_HOST_ENV) if (host[k] != null) e[k] = host[k]; return e; }

/**
 * Run `fn` with the package's view of the world locked down:
 *   - global fetch goes to `ctxFetch` (recording fake) — or, when none is given (module import,
 *     createTools() setup), is REFUSED and recorded, so loading a package never touches the network;
 *   - process.env is replaced by a scrubbed copy, so code that reads process.env directly (instead of
 *     the env it was handed) sees no host secret; child processes inherit the scrubbed copy too.
 * Both are restored in `finally`, even on throw. Network that bypasses global fetch is still NOT
 * intercepted; the hidden host env is what keeps such a call from authenticating.
 */
export async function withSandbox(fn, { ctxFetch = null, blocked = null } = {}) {
  const originalFetch = globalThis.fetch, originalEnv = process.env;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!ctxFetch) { if (blocked) blocked.push(url); throw new Error(`gristmill sandbox: network refused during package load (${url})`); }
    const r = await ctxFetch(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  process.env = scrubbedEnv(originalEnv);
  // Raw sockets are the hole `fetch` interception leaves open: database drivers, Redis clients,
  // LDAP, SMB and vendored HTTP libraries all open their own TCP/TLS connections. While package
  // code runs, every outbound connect is refused and recorded, so a handler cannot reach a real
  // backend even when it bypasses fetch entirely. (Same-process servers are unaffected.)
  const restoreNet = blockSockets(blocked);
  try { return await fn(); } finally { restoreNet(); globalThis.fetch = originalFetch; process.env = originalEnv; }
}

function blockSockets(blocked) {
  const refuse = (what) => { if (blocked) blocked.push(what); const e = new Error(`gristmill sandbox: outbound connection refused (${what})`); e.code = 'GRISTMILL_SANDBOX'; return e; };
  const patches = [];
  const patch = (obj, key, impl) => { if (!obj || typeof obj[key] !== 'function') return; const orig = obj[key]; obj[key] = impl(orig); patches.push(() => { obj[key] = orig; }); };
  const describeTarget = (args) => { const a = args[0]; if (a && typeof a === 'object') return `${a.host || a.path || '?'}:${a.port || ''}`; return `${a}:${typeof args[1] === 'number' || typeof args[1] === 'string' ? args[1] : ''}`; };
  // net.Socket.prototype.connect is the choke point for net.connect/createConnection and every
  // client built on them; tls.connect and the dns resolvers are patched for drivers that go around it.
  patch(net.Socket.prototype, 'connect', () => function (...args) { const err = refuse('tcp ' + describeTarget(args)); process.nextTick(() => this.emit('error', err)); return this; });
  patch(tls, 'connect', () => function (...args) { throw refuse('tls ' + describeTarget(args)); });
  patch(dns, 'lookup', () => function (host, ...rest) { const cb = rest.find(x => typeof x === 'function'); const err = refuse('dns ' + host); if (cb) { process.nextTick(() => cb(err)); return; } throw err; });
  patch(dns.promises, 'lookup', () => async function (host) { throw refuse('dns ' + host); });
  patch(dns.promises, 'resolve', () => async function (host) { throw refuse('dns ' + host); });
  return () => { for (const undo of patches.reverse()) undo(); };
}

/** Back-compat name: route global fetch through the recording fake (now also hides host env). */
export const withFetch = (ctxFetch, fn) => withSandbox(fn, { ctxFetch });

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
export async function bindAll(model, createTools) {
  let probe;
  const blocked = [];
  try { probe = await withSandbox(async () => createTools(new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'probe' : undefined) })), { blocked }); } catch { probe = []; }
  if (blocked.length) { model.extraction = model.extraction || {}; model.extraction.notes = [...(model.extraction.notes || []), `createTools() attempted ${blocked.length} network call(s) while building its tools; refused by the sandbox (${[...new Set(blocked)].slice(0, 3).join(', ')})`]; }
  const names = new Set((Array.isArray(probe) ? probe : []).map(t => t?.name).filter(Boolean));
  let bound = 0;
  for (const t of model.tools) if (names.has(t.name)) { t.handler = bindFranciscoTool(createTools, t.name); bound++; }
  model.extraction = model.extraction || {};
  model.extraction.notes = [...(model.extraction.notes || []), `${bound}/${model.tools.length} handlers bound from the package's createTools() via the fetch/env shim (network outside global fetch is not intercepted)`];
  return model;
}
