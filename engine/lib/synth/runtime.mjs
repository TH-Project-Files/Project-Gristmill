/**
 * Self-building L1 harness — runtime.
 *
 * probeTool() executes a tool's REAL handler (imported, never re-implemented) under:
 *   - a locked env (Proxy over the declared vars; sensitive vars hold canaries; undeclared reads recorded)
 *   - recording fakes for every sink (fetch/fs/shell/db/log/output)
 *   - inputs derived from the declared param schema: valid / boundary / out-of-schema / taint-shaped
 * and turns what it observes into L1 findings. The contract says what the tool SHOULD touch; the
 * harness reports what it DID touch. Where they differ, that is model drift — and the single most
 * useful thing a dry audit can tell you, because every L0 conclusion rests on the model being true.
 */
import { canaryFor } from '../oracles/index.mjs';
import { withSandbox } from './shim.mjs';
import { sensitiveEnvNames } from '../model.mjs';
import { hashHex } from '../util.mjs';

const TAINT_PAYLOADS = {
  url: ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/admin', 'https://evil.example.net/x'],
  path: ['../../etc/passwd', '..\\..\\windows\\win.ini', 'a'.repeat(60)],
  sql: ["x' OR '1'='1", "name = 'a'; DROP TABLE users; --"],
  shell: ['; rm -rf /', '$(id)', '`whoami`'],
  id: ["DEV-0001' --", '../x'],
  text: ['<script>alert(1)</script>'],
  email: ['a@b.c\nBcc: x@y.z'],
  none: [],
};

export function makeCtx(model, tool, { tenant = 'TENANT-1' } = {}) {
  const sens = sensitiveEnvNames(model);
  const declared = new Set(tool.env || []);
  const values = {};
  for (const e of model.env) values[e.name] = e.sensitive ? canaryFor(e.name) : `${e.name.toLowerCase()}-value`;
  const rec = { env_reads: [], undeclared_env: [], sinks: [], logs: [], outputs: [], fetches: [], fs: [], shell: [], db: [] };
  const env = new Proxy({}, {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      rec.env_reads.push(k);
      if (!declared.has(k)) rec.undeclared_env.push(k);
      return values[k];
    },
    has(_, k) { return typeof k === 'string' && k in values; },
    ownKeys() { return Object.keys(values); },
  });
  const sink = (kind, detail) => rec.sinks.push({ kind, detail });
  const ctx = {
    env, tenant,
    fetch: async (url, init = {}) => { rec.fetches.push({ url: String(url), method: init.method || 'GET' }); sink(init.method && init.method !== 'GET' ? 'external-write' : 'network', String(url)); return { ok: true, status: 200, body: '{}', json: async () => ({}), text: async () => '{}' }; },
    fs: { write: (p, data) => { rec.fs.push({ op: 'write', path: String(p) }); sink('fs', String(p)); }, read: (p) => { rec.fs.push({ op: 'read', path: String(p) }); sink('fs', String(p)); return ''; } },
    shell: { exec: (cmd) => { rec.shell.push(String(cmd)); sink('shell', String(cmd)); return { stdout: '', code: 0 }; } },
    db: { query: (sql, params = []) => { rec.db.push({ sql: String(sql), params }); sink('db', String(sql)); return null; } },
    log: (msg) => { rec.logs.push(String(msg)); sink('log', String(msg)); },
    output: (text) => { const s = String(text); rec.outputs.push(s); sink('output', s.slice(0, 80)); return s; },
  };
  return { ctx, rec, canaries: [...sens].map(canaryFor) };
}

/** Input cases from the declared schema. Each case = { label, args, kind: 'valid'|'boundary'|'out-of-schema'|'taint', param? } */
export function generateCases(tool) {
  const valid = {};
  for (const p of tool.params) valid[p.name] = typical(p);
  const cases = [{ label: 'valid-typical', kind: 'valid', args: { ...valid } }];
  for (const p of tool.params) {
    const w = (label, kind, value) => cases.push({ label: `${p.name}:${label}`, kind, param: p.name, args: { ...valid, [p.name]: value } });
    if (p.type === 'string') {
      w('empty', 'boundary', '');
      if (p.maxLength) w('max-length', 'boundary', 'a'.repeat(p.maxLength));
      w('oversize', 'out-of-schema', 'a'.repeat((p.maxLength || 64) * 4 + 1));
      w('wrong-type', 'out-of-schema', 12345);
    } else if (p.type === 'number' || p.type === 'integer') {
      if (p.min != null) w('min', 'boundary', p.min); if (p.max != null) w('max', 'boundary', p.max);
      w('over-max', 'out-of-schema', (p.max ?? 1000) * 10); w('negative', 'out-of-schema', -1); w('wrong-type', 'out-of-schema', 'NaN');
    } else if (p.type === 'array') {
      w('empty', 'boundary', []);
      w('oversize', 'out-of-schema', Array.from({ length: (p.maxItems || 100) * 2 + 1 }, (_, i) => `X-${i}`));
      w('wrong-type', 'out-of-schema', 'not-an-array');
    } else if (p.type === 'enum') {
      w('not-in-enum', 'out-of-schema', 'NOT_A_MEMBER');
    } else if (p.type === 'boolean') {
      w('wrong-type', 'out-of-schema', 'yes');
    }
    for (const payload of TAINT_PAYLOADS[p.taint] || []) w(`taint:${payload.slice(0, 24)}`, 'taint', p.type === 'array' ? [payload] : payload);
  }
  return cases;
}
function typical(p) {
  if (p.type === 'enum') return p.enum?.[0];
  if (p.type === 'string') { const base = p.taint === 'url' ? 'https://support.apple.com/HT1' : p.taint === 'path' ? 'q3-report' : p.taint === 'id' ? 'DEV-0042' : p.taint === 'sql' ? "name = 'x'" : p.taint === 'email' ? 'a@b.co' : 'alpha'; return (p.minLength && base.length < p.minLength) ? base.padEnd(p.minLength, 'x') : base; }
  if (p.type === 'number' || p.type === 'integer') return p.min ?? 1;
  if (p.type === 'boolean') return true;
  if (p.type === 'array') return ['DEV-0001', 'DEV-0002'];
  return {};
}

/** Execute every case against the real handler; return observations. Runs twice to assert determinism. */
export async function probeTool(model, tool, handler, { timeoutMs = 2000, tenant = 'TENANT-1' } = {}) {
  const obs = [];
  const declaredSinks = new Set(tool.sinks.map(s => s.kind));
  const cases = generateCases(tool);
  for (const cs of cases) {
    const run = async () => {
      const { ctx, rec, canaries } = makeCtx(model, tool, { tenant });
      let threw = null, result = null;
      try { result = await withTimeout(withSandbox(() => handler(cs.args, ctx), { ctxFetch: ctx.fetch }), timeoutMs); } catch (e) { threw = e; }
      return { rec, canaries, threw, result };
    };
    const a = await run(), b = await run();
    const deterministic = JSON.stringify(sig(a)) === JSON.stringify(sig(b));
    const { rec, canaries, threw } = a;
    const add = (check, ok, detail, severity, rule, fix) => obs.push({ check, ok, severity, rule, fix, detail, case: cs.label, case_kind: cs.kind, param: cs.param || null, tool: tool.id, deterministic, verify_status: deterministic ? 'CONFIRMED' : 'UNCERTAIN' });

    // Contract vs behaviour
    for (const k of new Set(rec.sinks.map(s => s.kind))) if (!declaredSinks.has(k)) add('SINK-UNDECLARED', false, `handler reached undeclared sink '${k}'`, 3, 'HAR-SINK', `sinks:declare@${tool.id}.${k}`);
    for (const k of new Set(rec.undeclared_env)) add('ENV-UNDECLARED', false, `handler read undeclared env '${k}'`, 2, 'HAR-ENV', `env:declare@${tool.id}.${k}`);
    const outText = rec.outputs.join('\n'), logText = rec.logs.join('\n');
    for (const c of canaries) {
      if (outText.includes(c)) add('SECRET-IN-OUTPUT', false, `sensitive value ${c.split('_')[1]} echoed in output`, 5, 'HAR-SECRET', `redact:env@${tool.id}`);
      if (logText.includes(c)) add('SECRET-IN-LOG', false, `sensitive value ${c.split('_')[1]} written to log`, 4, 'HAR-SECRET', `redact:env@${tool.id}`);
    }
    if (threw) {
      const msg = String(threw && threw.message || threw);
      if (/\n\s+at \S+|[A-Za-z]:\\[^\s'"]+|\/(srv|usr|home|var|etc|app)\/[^\s'"]+/.test(msg)) add('RAW-ERROR', false, `error carries stack/path: ${msg.split('\n')[0].slice(0, 80)}`, 2, 'HAR-RAWERR', `errors:sanitize@${tool.id}`);
    }
    if (cs.kind === 'out-of-schema' && !threw && rec.sinks.some(s => ['db', 'network', 'fs', 'shell', 'external-write'].includes(s.kind))) add('SCHEMA-NOT-ENFORCED', false, `out-of-schema input (${cs.label}) accepted and reached ${rec.sinks.map(s => s.kind).join('/')}`, 2, 'HAR-SCHEMA', `sanitize:schema@${tool.id}.${cs.param}`);
    if (cs.kind === 'taint') {
      const payload = cs.args[cs.param]; const needle = Array.isArray(payload) ? payload[0] : String(payload);
      const p = tool.params.find(x => x.name === cs.param);
      const reached =
        (p.taint === 'url' && rec.fetches.some(f => f.url.includes(needle))) ||
        (p.taint === 'path' && rec.fs.some(f => f.path.includes(needle.replace(/\\/g, '/').split('/').pop()) || f.path.includes('..'))) ||
        (p.taint === 'sql' && rec.db.some(q => q.sql.includes(needle))) ||
        (p.taint === 'shell' && rec.shell.some(c => c.includes(needle))) ||
        (p.taint === 'id' && rec.db.some(q => q.sql.includes(needle)));
      if (reached) add('TAINT-REACHED-SINK', false, `payload ${JSON.stringify(needle).slice(0, 40)} reached the ${p.taint} sink unneutralized`, p.taint === 'shell' ? 5 : 4, 'HAR-TAINT', `sanitize:${p.taint}@${tool.id}.${cs.param}`);
    }
    if (cs.kind === 'valid') {
      const rows = tryJsonArray(outText);
      if (tool.limit_param && cs.args[tool.limit_param] == null) { /* default limit case handled below */ }
      if (!tool.limit_param && rows && rows.length > 200) add('UNCAPPED-OUTPUT', false, `valid call returned ${rows.length} rows with no limit parameter`, 3, 'HAR-LIMIT', `limit:add@${tool.id}`);
      if (model.multi_tenant && tool.scoped === true && rec.db.length && !rec.db.some(q => JSON.stringify(q.params).includes(tenant) || q.sql.includes(tenant))) add('SCOPE-NOT-BOUND', false, 'tool is declared scoped but no data access carried the tenant', 3, 'HAR-SCOPE', `scope:enforce@${tool.id}`);
      if (model.multi_tenant && tool.scoped === false && rec.db.length && !rec.db.some(q => JSON.stringify(q.params).includes(tenant) || q.sql.includes(tenant))) add('SCOPE-NOT-BOUND', false, 'confirmed: data access without tenant binding', 3, 'HAR-SCOPE', `scope:enforce@${tool.id}`);
    }
    if (tool.limit_param && cs.kind === 'valid') {
      const { ctx, rec: r2 } = makeCtx(model, tool, { tenant });
      try { await withTimeout(withSandbox(() => handler({ ...cs.args, [tool.limit_param]: 5 }, ctx), { ctxFetch: ctx.fetch }), timeoutMs); } catch { /* ignore */ }
      const rows = tryJsonArray(r2.outputs.join('\n'));
      if (rows && rows.length > 5) add('LIMIT-NOT-ENFORCED', false, `limit=5 returned ${rows.length} rows`, 3, 'HAR-LIMIT', `limit:add@${tool.id}`);
    }
    add('EXECUTED', true, threw ? `threw: ${String(threw.message || threw).split('\n')[0].slice(0, 60)}` : 'ok', 0, null, null);
  }
  return { tool: tool.id, cases: cases.length, observations: obs };
}

function sig(r) { return { threw: r.threw ? String(r.threw.message || r.threw) : null, sinks: r.rec.sinks, env: r.rec.env_reads }; }
function tryJsonArray(s) { try { const v = JSON.parse(s.trim().split('\n')[0]); return Array.isArray(v) ? v : null; } catch { return null; } }
function withTimeout(p, ms) { return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error('harness timeout')), ms).unref?.())]); }

/** Collapse observations into L1 findings (one per tool × rule × fix). */
export function observationsToFindings(results) {
  const byKey = new Map();
  for (const r of results) for (const o of r.observations) {
    if (o.ok) continue;
    const key = `${o.tool}|${o.rule}|${o.fix}`;
    if (!byKey.has(key)) byKey.set(key, { rule: o.rule, mode: o.rule === 'HAR-SINK' || o.rule === 'HAR-ENV' ? 'model-drift' : (o.rule === 'HAR-LIMIT' ? 'efficiency' : 'security'), severity: o.severity, fidelity: 'L1', verify_status: o.verify_status, summary: `${o.tool}: ${o.detail}`, subject: { tool: o.tool, param: o.param || undefined }, evidence: { cases: [] }, fix_candidates: [o.fix], cells: [] });
    const f = byKey.get(key);
    f.evidence.cases.push({ case: o.case, detail: o.detail });
    f.severity = Math.max(f.severity, o.severity);
    if (o.verify_status !== 'CONFIRMED') f.verify_status = 'UNCERTAIN';
  }
  const out = [...byKey.values()];
  for (const f of out) f.finding_id = `${f.rule}-${hashHex([f.rule, f.subject.tool, f.fix_candidates[0]].join('|'))}`;
  out.sort((a, b) => b.severity - a.severity || a.finding_id.localeCompare(b.finding_id));
  return out;
}
