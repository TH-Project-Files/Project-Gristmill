/**
 * Transports — the ONLY provider-specific code. Each returns a neutral
 *   complete({ system, tools, messages }) -> { text, tool_uses:[{id,name,input}], stop, usage }
 * so the loop (loop.mjs) never names a provider. `detectTransport` picks one from the environment
 * the host harness already runs in, so the engine "just runs in that context" instead of demanding
 * its own key. When nothing is detected, the portable escape hatch is a subprocess the host wires
 * to whatever model access it has (Bedrock, Vertex, a subscription CLI, a gateway).
 */
import { spawn } from 'node:child_process';

/* ----------------------------- Anthropic Messages ----------------------------- */
// The neutral shape IS the Anthropic content shape, so this is almost identity.
export function anthropicTransport({ apiKey = process.env.ANTHROPIC_API_KEY, authToken = process.env.ANTHROPIC_AUTH_TOKEN, baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', modelId = 'claude-sonnet-5-5', maxTokens = 1024, temperature = 0, fetchImpl = globalThis.fetch, extraHeaders = {} } = {}) {
  const url = baseUrl.replace(/\/$/, '') + '/v1/messages';
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...extraHeaders };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`; else headers['x-api-key'] = apiKey || 'test';
  return { id: 'anthropic', modelId, async complete({ system, tools, messages }) {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, max_tokens: maxTokens, temperature, system, tools, messages }) });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const blocks = j.content || [];
    return { text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'), tool_uses: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} })), stop: j.stop_reason === 'tool_use' ? 'tool_use' : 'end', usage: { input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 } };
  } };
}

/* ----------------------------- OpenAI-compatible ----------------------------- */
export function openaiTransport({ apiKey = process.env.OPENAI_API_KEY, baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', modelId = process.env.OPENAI_MODEL || 'gpt-5', maxTokens = 1024, temperature = 0, fetchImpl = globalThis.fetch } = {}) {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  return { id: 'openai', modelId, async complete({ system, tools, messages }) {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey || 'test'}` }, body: JSON.stringify({ model: modelId, max_tokens: maxTokens, temperature, tools: tools.map(toOpenAiTool), messages: toOpenAiMessages(system, messages) }) });
    if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const m = j.choices?.[0]?.message || {};
    return { text: m.content || '', tool_uses: (m.tool_calls || []).map(c => ({ id: c.id, name: c.function.name, input: safeParse(c.function.arguments) })), stop: m.tool_calls?.length ? 'tool_use' : 'end', usage: { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0 } };
  } };
}
const toOpenAiTool = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });
function toOpenAiMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      const results = m.content.filter(b => b.type === 'tool_result');
      if (results.length) for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: String(r.content) });
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}
const safeParse = s => { try { return JSON.parse(s); } catch { return {}; } };

/* ----------------------------- Subprocess (the universal hook) ----------------------------- */
// Write the neutral request as one JSON line to the command's stdin; read the neutral response as
// JSON from its stdout. The host points `cmd` at anything with model access — a Bedrock/Vertex
// signer, a subscription CLI wrapper, a gateway client. The engine stays dependency-free and
// provider-blind; the glue lives in the host's one-line command, where its credentials already are.
export function subprocessTransport({ cmd, modelId = 'host-subprocess', timeoutMs = 120000 } = {}) {
  if (!cmd) throw new Error('subprocess transport needs a command (--complete-cmd)');
  return { id: 'subprocess', modelId, async complete(request) {
    const out = await runCmd(cmd, JSON.stringify(request) + '\n', timeoutMs);
    let j; try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { throw new Error(`complete-cmd did not return JSON on stdout. Got: ${out.slice(0, 200)}`); }
    return { text: j.text || '', tool_uses: (j.tool_uses || []).map(u => ({ id: u.id || `tu_${Math.random().toString(36).slice(2)}`, name: u.name, input: u.input || {} })), stop: j.tool_uses?.length ? 'tool_use' : 'end', usage: j.usage || {} };
  } };
}
function runCmd(cmd, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`complete-cmd timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`complete-cmd exited ${code}: ${stderr.slice(0, 200)}`)); });
    child.stdin.end(input);
  });
}

/* ----------------------------- Auto-detection ----------------------------- */
/**
 * Pick a transport from explicit opts, then the environment. Returns { transport, how } or throws a
 * message that tells the host exactly how to supply access in its harness.
 */
export function detectTransport(opts = {}, env = process.env) {
  const modelId = opts.model;
  if (opts.completeCmd) return { transport: subprocessTransport({ cmd: opts.completeCmd, modelId }), how: `subprocess (--complete-cmd)` };
  if (opts.transport === 'anthropic' || (!opts.transport && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN))) return { transport: anthropicTransport({ modelId: modelId || 'claude-sonnet-5-5' }), how: env.ANTHROPIC_BASE_URL ? `anthropic (gateway ${env.ANTHROPIC_BASE_URL})` : `anthropic (ANTHROPIC_API_KEY)` };
  if (opts.transport === 'openai' || (!opts.transport && env.OPENAI_API_KEY)) return { transport: openaiTransport({ modelId }), how: env.OPENAI_BASE_URL ? `openai-compatible (${env.OPENAI_BASE_URL})` : `openai (OPENAI_API_KEY)` };
  throw new Error(
    'No model transport detected. The boundary runner uses whatever model access your harness has.\n' +
    '  • Anthropic key/gateway: set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN)\n' +
    '  • OpenAI-compatible:      set OPENAI_API_KEY (and OPENAI_BASE_URL / OPENAI_MODEL if not api.openai.com)\n' +
    "  • Bedrock / Vertex / a subscription CLI / anything else: pass --complete-cmd '<command>' that reads a\n" +
    '    JSON request on stdin and writes {text, tool_uses} on stdout (see engine/docs/PORTABLE_RUNNER.md).\n' +
    '  • No model at all: use the mock runner (omit --live) to validate the engine on planted boundaries.'
  );
}
