/**
 * Extractor B — Francisco agent package (HEURISTIC, no dependencies, no TypeScript compiler).
 *
 * Reads manifest.json + scans src/**\/*.ts for `tool('name', 'description', { zod shape }, handler)`
 * and the subagent definitions, then infers sinks/env/gates from the handler window by pattern:
 *   fetch(/axios/got           -> network        exec/spawn/execFile       -> shell
 *   fs./writeFile/readFile     -> fs             db_query/pool.query/sql   -> db
 *   env.X / process.env.X      -> env reads      log(/logger./console.     -> log
 *   ALLOW|allowlist|whitelist  -> allowlist gate DENY|blocklist|blacklist  -> denylist gate
 * Everything it infers is tagged confidence:'heuristic' and listed in extraction.notes so the
 * report never presents a regex guess as a fact. Handlers are NOT loaded (that needs tsx and the
 * package's deps) — so this path yields L0 only; the L1 harness needs the module extractor.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export function extractFrancisco(root) {
  const notes = [];
  const manifestPath = join(root, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  if (!existsSync(manifestPath)) notes.push('no manifest.json found; capabilities/env unknown');
  const files = walk(join(root, 'src')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
  const env = [];
  for (const g of manifest.environment?.groups || []) for (const v of g.variables || g.vars || []) env.push({ name: v.name || v.key, sensitive: !!v.sensitive });
  for (const list of ['variables', 'required', 'optional']) for (const v of manifest.environment?.[list] || []) if (v && (v.name || v.key)) env.push({ name: v.name || v.key, sensitive: !!v.sensitive });
  const envNames = new Set(env.map(e => e.name));

  const tools = [], gates = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const fileHasShell = /from\s+['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)|from\s+['"]execa['"]|from\s+['"]zx['"]/.test(src);
    const re = /tool\(\s*(['"`])([A-Za-z0-9_\-.]+)\1\s*,/g;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index;
      const next = src.slice(start + 5).search(/\n\s*tool\(\s*['"`]/);
      const window = src.slice(start, next === -1 ? Math.min(src.length, start + 12000) : start + 5 + next);
      const name = m[2];
      const desc = (window.match(/,\s*((?:'[^']*'|"[^"]*"|`[^`]*`)(?:\s*\+\s*(?:'[^']*'|"[^"]*"|`[^`]*`))*)\s*,\s*\{/) || [])[1] || '';
      const description = desc.replace(/\s*\+\s*/g, '').replace(/^['"`]|['"`]$/g, '').replace(/['"`]['"`]/g, '').slice(0, 600);
      const params = parseZodParams(window);
      const sinks = [], envReads = new Set();
      const low = window;
      if (/\bfetch\(|axios\.|\bgot\(|https?\.request|undici/.test(low)) sinks.push({ kind: /method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(low) ? 'external-write' : 'network', params: params.filter(p => p.taint === 'url').map(p => p.name), sanitized_by: null });
      // RegExp.prototype.exec is not a shell: require a child_process/execa import in the file AND a bare (non-member) call.
      if (fileHasShell && /(?<![\w.$])(exec|execFile|spawn|execSync|spawnSync|execFileSync|execa|\$)\s*\(|child_process\.\w+\(/.test(low)) sinks.push({ kind: 'shell', params: params.filter(p => ['shell', 'text', 'id'].includes(p.taint)).map(p => p.name), sanitized_by: null });
      if (/\bfs\.|writeFile|readFile|createWriteStream|mkdirSync/.test(low)) sinks.push({ kind: 'fs', params: params.filter(p => p.taint === 'path').map(p => p.name), sanitized_by: null });
      if (/db_query|db_execute|pool\.query|\.query\(\s*`|sql`/.test(low)) sinks.push({ kind: 'db', params: params.filter(p => p.taint === 'sql').map(p => p.name), sanitized_by: null });
      if (/\blog\(|logger\.|console\.(log|info|warn|error)/.test(low)) sinks.push({ kind: 'log', params: [], sanitized_by: null });
      if (/emitAuditEvent|audit\(/.test(low)) sinks.push({ kind: 'audit', params: [], sanitized_by: null });
      sinks.push({ kind: 'output', params: [], sanitized_by: null });
      for (const em of low.matchAll(/\b(?:env|process\.env|ctx\.env|cfg)\.([A-Z][A-Z0-9_]{2,})/g)) envReads.add(em[1]);
      for (const n of envReads) if (!envNames.has(n)) { env.push({ name: n, sensitive: /KEY|SECRET|TOKEN|PASS|PWD|CRED/i.test(n) }); envNames.add(n); }
      const id = name;
      // Gate detection keys on CODE identifiers, not prose, so a description saying "forbidden" does not become a gate.
      // Strip '…' and "…" literals and comments (keep template literals: their ${…} interpolations are code).
      const code = window.replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const allow = /\b[A-Z_]*ALLOW(ED|LIST)[A-Z_]*\b|\ballow(ed)?(list|Hosts|Verbs|Shapes|Patterns)\b|\bisAllowed\w*\(|\bwhitelist\w*|\b\w*(Verdict|evaluateOutbound|validateUrl|assertSafe|assertAllowed|checkAllowed|sanitize\w*)\s*\(/i.test(code);
      const deny = /\b[A-Z_]*(DENY|BLOCK)(ED|LIST)[A-Z_]*\b|\b(deny|block)(ed)?(list|Hosts|Verbs|Patterns)\b|\bisBlocked\w*\(|\bblacklist\w*/i.test(code);
      if (allow) { gates.push({ id: `${id}-allowlist`, kind: 'allowlist', applies_to: [id], params: params.filter(p => p.taint !== 'none').map(p => p.name) }); for (const s of sinks) if (['network', 'fs', 'db', 'shell'].includes(s.kind)) s.sanitized_by = `${id}-allowlist`; }
      else if (deny) { gates.push({ id: `${id}-denylist`, kind: 'denylist', applies_to: [id], params: params.filter(p => p.taint !== 'none').map(p => p.name) }); for (const s of sinks) if (['network', 'fs', 'db', 'shell'].includes(s.kind)) s.sanitized_by = `${id}-denylist`; }
      const verbs = name.toLowerCase().split(/[_\-.]/);
      const WRITE = new Set(['delete', 'remove', 'reset', 'wipe', 'create', 'update', 'set', 'push', 'send', 'initiate', 'trigger', 'disable', 'enable', 'revoke', 'assign', 'unassign', 'add', 'kill', 'quarantine', 'isolate', 'reboot', 'restart', 'install', 'uninstall', 'redline', 'write', 'post', 'patch', 'put']);
      const READ_LEAD = new Set(['get', 'list', 'find', 'search', 'read', 'fetch', 'lookup', 'query', 'describe', 'export', 'check', 'analyze', 'analyse', 'summary', 'summarize', 'diagnose', 'trace', 'triage', 'report', 'whoami', 'capability']);
      const isWrite = verbs.some(v => WRITE.has(v)) && !verbs.some(v => READ_LEAD.has(v));
      const kind = isWrite ? (sinks.some(s => s.kind === 'external-write' || s.kind === 'shell') ? 'external-action' : 'write') : (sinks.some(s => s.kind === 'shell') ? 'external-action' : 'read');
      const limitParam = params.find(p => /^(limit|max|top|page_size|max_results|max_chars|count)$/i.test(p.name))?.name || null;
      // A handler-side cap (slice/take/$top/pageSize/MAX_ROWS…) is not a contract parameter, but it does bound the pull.
      const implicitCap = !limitParam && /\.slice\(\s*0\s*,|\.take\(|\$top=|[?&]top=|\btop\s*[:=]\s*\d|pageSize|page_size|MAX_(ROWS|RESULTS|ITEMS|RECORDS)|maxResults|max_results|\bLIMIT\s+\d|limit\s*[:=]\s*\d/i.test(low);
      const retriesMatch = low.match(/(?:retries|maxRetries|attempts|MAX_RETRIES)\s*[:=]\s*(\d+)/);
      tools.push({ id, name, kind, description, purpose: description.split(/[.!?]/)[0].slice(0, 120), tags: tagsFrom(name, description), params, sinks: dedupeSinks(sinks), env: [...envReads], gates: [], limit_param: limitParam, implicit_cap: implicitCap, batch_of: null, retries: retriesMatch ? { max: +retriesMatch[1], backoff: /backoff|delay\s*\*|2\s*\*\*/i.test(low), outage_aware: /outage|circuit|breaker|cooldown|unavailable_until/i.test(low) } : null, errors: /sanitize|safeError|String\(e\)\.split|\.message\.split\('\\n'\)\[0\]/.test(low) ? 'sanitized' : (/\$\{(e|err|error)(\.stack)?\}|\.stack/.test(low) ? 'raw' : 'unknown'), scoped: null, cost_hint: /(^|_)(list|export|sweep|scan|search|inventory|all|fleet|bulk|batch)(_|$)/i.test(name) ? 3 : 1, _file: relative(root, f) });
    }
  }
  // Batch relations by name convention: foo + foo_batch / foos / foo_many
  for (const t of tools) { const base = t.id.replace(/_(batch|many|bulk)$/i, '').replace(/s$/, ''); if (base !== t.id) { const item = tools.find(x => x.id === base || x.id === base + '_single'); if (item) t.batch_of = item.id; } }
  if (!tools.length) notes.push('no tool(...) calls found under src/');

  // Subagents: look for AgentDefinition objects with tools: [...] arrays and a description/prompt.
  // Subagents: one AgentDefinition per file under src/subagents (export const X = {...} or export function buildX() { return {...} }),
  // identified by its `tools: [...]` array; the array may be hundreds of lines below the export, so we do not window it.
  const actors = [];
  for (const f of files.filter(f => /subagents?[\\/]/i.test(f))) {
    const src = readFileSync(f, 'utf8');
    const exp = src.match(/export\s+(?:const|function)\s+([A-Za-z0-9_]+)/);
    if (!exp) continue;
    const toolArrays = [...src.matchAll(/\btools\s*:\s*\[([\s\S]*?)\]/g)].map(m => m[1]);
    const toolNames = [...new Set(toolArrays.flatMap(a => [...a.replace(/\/\/[^\n]*/g, '').matchAll(/['"`]([^'"`\n]+)['"`]/g)].map(x => x[1])).map(stripMcpPrefix).filter(n => tools.some(t => t.id === n)))];
    if (!toolNames.length) continue;
    const id = exp[1].replace(/^build/, '').replace(/^./, c => c.toLowerCase()).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    const prompt = (src.match(/prompt\s*:\s*`([\s\S]{0,4000}?)`/) || [])[1] || (src.match(/description\s*:\s*(['"`])([\s\S]{0,600}?)\1/) || [])[2] || '';
    const model = (src.match(/model\s*:\s*['"`]([^'"`]+)['"`]/) || [])[1] || 'unknown';
    actors.push({ id, kind: 'subagent', model, prompt, tools: toolNames, can_delegate_to: [], _file: relative(root, f) });
  }
  const promptsFile = files.find(f => /prompts?\.ts$/.test(f));
  const orchPrompt = promptsFile ? (readFileSync(promptsFile, 'utf8').match(/`([\s\S]{200,20000}?)`/) || [])[1] || '' : '';
  // The orchestrator holds every tool not exclusively owned by a subagent, unless index.ts shows an explicit orchestrator list.
  const owned = new Set(actors.flatMap(a => a.tools));
  const indexFile = files.find(f => /[\\/]index\.ts$/.test(f) && /createTools/.test(readFileSync(f, 'utf8')));
  const orchestratorTools = indexFile ? orchestratorToolList(readFileSync(indexFile, 'utf8'), tools) : null;
  actors.unshift({ id: 'orchestrator', kind: 'orchestrator', model: manifest.model || 'unknown', prompt: orchPrompt, tools: orchestratorTools?.length ? orchestratorTools : tools.map(t => t.id).filter(id => !owned.has(id) || actors.length === 0), can_delegate_to: actors.map(a => a.id) });
  if (!orchestratorTools?.length && actors.length > 1) notes.push('orchestrator tool list inferred as "every tool no subagent owns"; if the orchestrator really holds all tools, routes via subagents are under-counted');
  if (!actors.some(a => a.kind === 'subagent')) notes.push('no subagent definitions recognized; routes are orchestrator-only');

  const entries = [{ id: 'chat', kind: 'chat', interactive: manifest.permissionMode !== 'bypassPermissions' }];
  if (manifest.permissionMode === 'bypassPermissions') notes.push("permissionMode=bypassPermissions: HITL cards never fire, so every route is treated as non-interactive (consent gates cannot fire)");
  if (manifest.schedule) entries.push({ id: 'scheduled', kind: 'scheduled', interactive: false });
  if (manifest.webhook || manifest.mode === 'webhook') entries.push({ id: 'webhook', kind: 'webhook', interactive: false });

  // HITL gates from manifest toolApprovals, if present.
  const approvals = manifest.toolApprovals || manifest.permissions?.toolApprovals || {};
  for (const [tname, v] of Object.entries(approvals)) { const t = tools.find(x => x.id === tname.replace(/^mcp__\w+__/, '')); if (t && (v === 'ask' || v === 'hitl' || v?.approval === 'ask')) { gates.push({ id: `hitl-${t.id}`, kind: 'hitl', applies_to: [t.id], via: null }); } }
  if (manifest.capabilities?.requiresApproval && !gates.some(g => g.kind === 'hitl')) notes.push('manifest says requiresApproval but no per-tool approval map was found; consent gates could not be attributed to tools');

  const policies = [];
  const allPrompt = actors.map(a => a.prompt).join('\n').toLowerCase();
  if (/aggregate|batch first|fleet-wide tool|one call for many/.test(allPrompt)) policies.push('aggregate-first');
  if (/confirm before|require(s)? (explicit )?(approval|confirmation)|ask before/.test(allPrompt)) policies.push('confirm-before-write');
  if (/never (echo|print|reveal|expose) (credential|secret|key|token)|redact/.test(allPrompt)) policies.push('never-echo-secrets');
  if (/tenant|scope you are|which org/.test(allPrompt)) policies.push('state-scope');
  if (/outage|circuit|unavailable.*(do not|don't) retry|cached outage/.test(allPrompt)) policies.push('outage-cache-first');

  return {
    target: { name: manifest.id || manifest.name || root, version: manifest.version || 'unknown' },
    extraction: { method: 'francisco-heuristic', confidence: 'heuristic', notes: [...notes, `${tools.length} tools, ${actors.length - 1} subagents, ${env.length} env vars recognized across ${files.length} source files`] },
    entries, actors, tools, gates, env, sources: [{ id: 'user', kind: 'user', trust: 'untrusted' }, ...(tools.some(t => t.sinks.some(s => s.kind === 'network')) ? [{ id: 'web', kind: 'web', trust: 'untrusted', feeds: tools.filter(t => t.sinks.some(s => s.kind === 'network') && t.kind === 'read').map(t => t.id) }] : [])],
    budgets: { call_budget: manifest.maxToolCalls ?? null, max_turns: manifest.maxTurns ?? null, output_char_limit: manifest.outputCharLimit ?? null },
    known_outages: [], multi_tenant: false, policies,
  };
}

/** If index.ts carries an explicit orchestrator allow-list (e.g. ORCHESTRATOR_TOOLS = [...] or allowedTools: [...]), use it. */
function orchestratorToolList(src, tools) {
  const m = src.match(/(?:ORCHESTRATOR_TOOLS|orchestratorTools|allowedTools|ORCHESTRATOR_ALLOWED)\s*[:=]\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return [...new Set([...m[1].replace(/\/\/[^\n]*/g, '').matchAll(/['"`]([^'"`\n]+)['"`]/g)].map(x => stripMcpPrefix(x[1])).filter(n => tools.some(t => t.id === n)))];
}
/** 'mcp__<server>__<tool>' (server may contain hyphens) -> '<tool>'; plain names pass through. */
function stripMcpPrefix(n) { const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(n); return m ? m[1] : n; }

function parseZodParams(window) {
  const params = [];
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\.([a-z]+)\(([^)]*)\)((?:\.[a-zA-Z]+\([^)]*\))*)/gm;
  let m;
  while ((m = re.exec(window))) {
    const [, name, ztype, inner, chain] = m;
    const type = ({ string: 'string', number: 'number', boolean: 'boolean', array: 'array', enum: 'enum', object: 'object', coerce: 'string' })[ztype] || 'string';
    const p = { name, type, required: !/\.optional\(\)/.test(chain), taint: guessTaint(name, chain + inner) };
    const min = chain.match(/\.min\((\d+)\)/), max = chain.match(/\.max\((\d+)\)/);
    if (type === 'string') { if (min) p.minLength = +min[1]; if (max) p.maxLength = +max[1]; }
    else if (type === 'number') { if (min) p.min = +min[1]; if (max) p.max = +max[1]; if (/\.int\(\)/.test(chain)) p.type = 'integer'; }
    else if (type === 'array') { if (max) p.maxItems = +max[1]; }
    else if (type === 'enum') { p.enum = [...inner.matchAll(/['"`]([^'"`]+)['"`]/g)].map(x => x[1]); }
    params.push(p);
  }
  return params;
}
function guessTaint(name, hint) {
  const n = name.toLowerCase();
  if (/url|uri|href|endpoint|host/.test(n) || /\.url\(\)/.test(hint)) return 'url';
  if (/path|file|dir|folder|filename/.test(n)) return 'path';
  if (/sql|query_expr|expr|where|filter_expr|cypher|kql/.test(n)) return 'sql';
  if (/cmd|command|script|shell|args/.test(n)) return 'shell';
  if (/email|mail|upn/.test(n) || /\.email\(\)/.test(hint)) return 'email';
  if (/_id$|^id$|hostname|device|user|name|serial|sid|guid/.test(n)) return 'id';
  return 'text';
}
// Name tokens carry the shape words (list/export/scan…); the description contributes DOMAIN nouns only, so prose like "all devices" does not mark a single-object getter as a fleet pull.
function tagsFrom(name, desc) { return [...new Set([...name.split(/[_\-.]/), ...(desc.toLowerCase().match(/\b(device|user|identity|software|advisory|web|config|group|policy|sign-in|signin|audit|report)\b/g) || [])].map(s => s.toLowerCase()).filter(s => s.length > 2))]; }
function dedupeSinks(s) { const seen = new Set(); return s.filter(x => { if (seen.has(x.kind)) return false; seen.add(x.kind); return true; }); }
function walk(dir) { if (!existsSync(dir)) return []; const out = []; for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === 'node_modules' || e === 'dist') continue; if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p); } return out; }
