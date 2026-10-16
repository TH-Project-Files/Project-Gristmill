/**
 * Extractor C — compiled package (RUNTIME introspection).
 *
 * Many shipped agents contain only a built dist/index.js, so the regex-over-src heuristic sees
 * nothing. This path IMPORTS the package and calls its `createTools(env)` with a locked probe env,
 * then reads each tool's real name, description and parameter names at runtime — no guessing about
 * which tools exist. Sinks can't be read without the handler body, so they stay coarse (inferred
 * from param taint + description); binding the handlers (synth/shim.mjs → L1) then corrects them by
 * executing each one against the recording fakes. Manifest env / approvals / entries are merged in.
 *
 * If createTools throws while loading (it reaches for a DB, a registry, a client), that is reported
 * honestly and the tool list is empty — the fix is to stub those in a describe.mjs, not to guess.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WRITE = new Set(['delete', 'remove', 'reset', 'wipe', 'create', 'update', 'set', 'push', 'send', 'initiate', 'trigger', 'disable', 'enable', 'revoke', 'assign', 'unassign', 'add', 'kill', 'quarantine', 'isolate', 'reboot', 'restart', 'install', 'uninstall', 'redline', 'write', 'post', 'patch', 'put']);
const READ = new Set(['get', 'list', 'find', 'search', 'read', 'fetch', 'lookup', 'query', 'describe', 'export', 'check', 'analyze', 'analyse', 'summary', 'summarize', 'diagnose', 'trace', 'triage', 'report', 'whoami', 'capability']);

export async function extractCompiled(root, { entry } = {}) {
  const dir = resolve(root);
  const manifest = readJson(join(dir, 'manifest.json')) || {};
  const notes = [];
  const entryPath = entry ? resolve(dir, entry) : resolveEntry(dir, manifest);
  if (!entryPath) throw new Error(`no compiled entry found under ${dir} (looked at manifest.main, dist/index.js, package.json main)`);

  const mod = await import(pathToFileURL(entryPath).href);
  const createTools = mod.createTools || mod.default?.createTools || mod.default;
  if (typeof createTools !== 'function') throw new Error(`${entryPath} does not export createTools()`);

  // Env from the manifest; sensitive ones get a flag. Probe env records reads and never holds a real secret.
  const env = [];
  for (const g of manifest.environment?.groups || []) for (const v of g.variables || g.vars || []) env.push({ name: v.name || v.key, sensitive: !!v.sensitive });
  for (const list of ['variables', 'required', 'optional']) for (const v of manifest.environment?.[list] || []) if (v && (v.name || v.key)) env.push({ name: v.name || v.key, sensitive: !!v.sensitive });
  const envRead = new Set();
  const probeEnv = new Proxy({}, { get(_, k) { if (typeof k === 'string') { envRead.add(k); return `probe-${k}`; } return undefined; }, has: () => true });

  let defs;
  try { defs = createTools(probeEnv); } catch (e) { notes.push(`createTools() threw during load (${String(e.message || e).split('\n')[0].slice(0, 120)}); stub its dependencies in a describe.mjs to list tools`); defs = []; }
  if (!Array.isArray(defs)) { notes.push('createTools() did not return an array'); defs = []; }
  for (const n of envRead) if (!env.some(e => e.name === n)) env.push({ name: n, sensitive: /KEY|SECRET|TOKEN|PASS|PWD|CRED/i.test(n) });

  const tools = [];
  for (const d of defs) {
    if (!d || typeof d.name !== 'string') continue;
    const name = d.name, description = String(d.description || '').slice(0, 600);
    const params = readParams(d);
    const verbs = name.toLowerCase().split(/[_\-.]/);
    const isWrite = verbs.some(v => WRITE.has(v)) && !verbs.some(v => READ.has(v));
    const sinks = inferSinks(params, name, description);
    const kind = isWrite ? (sinks.some(s => s.kind === 'external-write' || s.kind === 'shell') ? 'external-action' : 'write') : (sinks.some(s => s.kind === 'shell') ? 'external-action' : 'read');
    tools.push({ id: name, name, kind, description, purpose: description.split(/[.!?]/)[0].slice(0, 120), tags: tagsFrom(name, description), params, sinks, env: [], gates: [], limit_param: params.find(p => /^(limit|max|top|page_size|max_results|max_chars|count)$/i.test(p.name))?.name || null, batch_of: null, retries: null, errors: 'unknown', scoped: null, cost_hint: /(^|_)(list|export|sweep|scan|search|inventory|all|fleet|bulk|batch)(_|$)/i.test(name) ? 3 : 1 });
  }
  if (!tools.length && !notes.length) notes.push('createTools() returned no tools');

  // Actors: orchestrator holds everything; subagents from the heuristic src scan if any src exists.
  const actors = [{ id: 'orchestrator', kind: 'orchestrator', model: manifest.model || 'unknown', prompt: readPrompt(dir), tools: tools.map(t => t.id), can_delegate_to: [] }];
  const entries = [{ id: 'chat', kind: 'chat', interactive: manifest.permissionMode !== 'bypassPermissions' }];
  if (manifest.permissionMode === 'bypassPermissions') notes.push('permissionMode=bypassPermissions: HITL cards never fire, so every route is non-interactive');
  if (manifest.schedule || manifest.schedules) entries.push({ id: 'scheduled', kind: 'scheduled', interactive: false });

  const gates = [];
  const approvals = manifest.toolApprovals || manifest.permissions?.toolApprovals || {};
  for (const [tname, v] of Object.entries(approvals)) { const t = tools.find(x => x.id === tname.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')); if (t && (v === 'ask' || v === 'hitl' || v?.approval === 'ask')) gates.push({ id: `hitl-${t.id}`, kind: 'hitl', applies_to: [t.id], via: null, enforced_by: 'code' }); }

  return {
    target: { name: manifest.id || manifest.name || dir, version: manifest.version || 'unknown' },
    extraction: { method: 'compiled-runtime', confidence: 'heuristic', notes: [...notes, `${tools.length} tools listed from createTools(); ${env.length} env vars; sinks are coarse until handlers are bound (synth/shim.mjs)`] },
    entries, actors, tools, gates, env,
    sources: [{ id: 'user', kind: 'user', trust: 'untrusted' }, ...(tools.some(t => t.sinks.some(s => s.kind === 'network')) ? [{ id: 'web', kind: 'web', trust: 'untrusted', feeds: tools.filter(t => t.sinks.some(s => s.kind === 'network') && t.kind === 'read').map(t => t.id) }] : [])],
    budgets: { call_budget: manifest.maxToolCalls ?? null, max_turns: manifest.maxTurns ?? null, output_char_limit: manifest.outputCharLimit ?? null },
    known_outages: [], multi_tenant: false, policies: [],
    _compiledEntry: entryPath, _createTools: createTools,
  };
}

function resolveEntry(dir, manifest) {
  const cands = [manifest.main, 'dist/index.js', 'dist/index.mjs', readJson(join(dir, 'package.json'))?.main, 'index.js', 'index.mjs'].filter(Boolean);
  for (const c of cands) { const p = resolve(dir, c); if (existsSync(p) && statSync(p).isFile()) return p; }
  return null;
}
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function readPrompt(dir) { for (const p of ['dist/prompt.txt', 'PROMPT.md', 'prompt.md']) { try { return readFileSync(join(dir, p), 'utf8').slice(0, 4000); } catch { /* */ } } return ''; }

/** Read parameter names from a tool def's schema — JSON schema or a zod object, best effort. */
function readParams(d) {
  const sch = d.inputSchema ?? d.input_schema ?? d.parameters ?? d.schema;
  const names = schemaKeys(sch);
  return names.map(name => ({ name, type: 'string', required: true, taint: guessTaint(name) }));
}
function schemaKeys(sch) {
  if (!sch || typeof sch !== 'object') return [];
  if (sch.properties && typeof sch.properties === 'object') return Object.keys(sch.properties);        // JSON schema
  if (sch.shape && typeof sch.shape === 'object') return Object.keys(sch.shape);                        // zod (new)
  try { if (typeof sch._def?.shape === 'function') return Object.keys(sch._def.shape()); } catch { /* */ }  // zod (older)
  if (sch._def?.shape && typeof sch._def.shape === 'object') return Object.keys(sch._def.shape);
  return [];
}
function guessTaint(name) {
  const n = name.toLowerCase();
  if (/url|uri|href|endpoint|host/.test(n)) return 'url';
  if (/path|file|dir|folder|filename/.test(n)) return 'path';
  if (/sql|expr|where|filter_expr|cypher|kql|query_expr/.test(n)) return 'sql';
  if (/cmd|command|script|shell/.test(n)) return 'shell';
  if (/email|mail|upn/.test(n)) return 'email';
  if (/_id$|^id$|hostname|device|user|name|serial|sid|guid/.test(n)) return 'id';
  return 'text';
}
function inferSinks(params, name, desc) {
  const sinks = [{ kind: 'output', params: [] }];
  const hay = (name + ' ' + desc).toLowerCase();
  if (params.some(p => p.taint === 'url') || /fetch|http|url|web|advisory|download/.test(hay)) sinks.unshift({ kind: 'network', params: params.filter(p => p.taint === 'url').map(p => p.name), sanitized_by: null });
  if (params.some(p => p.taint === 'path') || /file|report|export|write/.test(hay)) sinks.unshift({ kind: 'fs', params: params.filter(p => p.taint === 'path').map(p => p.name), sanitized_by: null });
  if (params.some(p => p.taint === 'sql')) sinks.unshift({ kind: 'db', params: params.filter(p => p.taint === 'sql').map(p => p.name), sanitized_by: null });
  if (params.some(p => p.taint === 'shell')) sinks.unshift({ kind: 'shell', params: params.filter(p => p.taint === 'shell').map(p => p.name), sanitized_by: null });
  return sinks;
}
function tagsFrom(name, desc) { return [...new Set([...name.split(/[_\-.]/), ...(desc.toLowerCase().match(/\b(device|user|identity|software|advisory|web|config|group|policy|signin|audit|report)\b/g) || [])].map(s => s.toLowerCase()).filter(s => s.length > 2))]; }
