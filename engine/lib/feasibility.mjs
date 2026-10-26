/**
 * Evidence feasibility — what fidelity a target can actually reach under each posture, BEFORE any
 * model turn is spent. The DeepSight campaign burned 300 subagent calls to learn that a dry run on
 * a backend-coupled target can only produce predictions; this answers that in milliseconds.
 *
 * It scans the target's code (source or built bundle) for backend clients and raw-socket use, then
 * states, per posture, the ceiling and the exact command that raises it.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLIENTS = [
  ['@prisma/client', 'database (Prisma)'], ['prisma', 'database (Prisma)'], ['pg', 'database (Postgres)'], ['mysql2', 'database (MySQL)'], ['mysql', 'database (MySQL)'], ['mssql', 'database (SQL Server)'], ['oracledb', 'database (Oracle)'], ['mongodb', 'database (MongoDB)'], ['mongoose', 'database (MongoDB)'], ['better-sqlite3', 'database (SQLite, local file)'], ['knex', 'database (Knex)'], ['typeorm', 'database (TypeORM)'], ['drizzle-orm', 'database (Drizzle)'],
  ['ioredis', 'cache (Redis)'], ['redis', 'cache (Redis)'], ['memcached', 'cache (Memcached)'],
  ['ldapjs', 'directory (LDAP)'], ['activedirectory', 'directory (LDAP)'],
  ['@aws-sdk/', 'cloud API (AWS SDK)'], ['aws-sdk', 'cloud API (AWS SDK)'], ['@google-cloud/', 'cloud API (Google Cloud)'], ['@azure/', 'cloud API (Azure)'],
  ['kafkajs', 'queue (Kafka)'], ['amqplib', 'queue (AMQP)'], ['bullmq', 'queue (BullMQ)'],
  ['nodemailer', 'email (SMTP)'], ['@sendgrid/', 'email (SendGrid)'],
  ['smb2', 'file share (SMB)'], ['ssh2', 'remote shell (SSH)'], ['node-ssh', 'remote shell (SSH)'],
  ['axios', 'HTTP client (axios)'], ['got', 'HTTP client (got)'], ['node-fetch', 'HTTP client (node-fetch)'], ['undici', 'HTTP client (undici)'],
];
const RAW = [[/\bnet\.(connect|createConnection)\(|new\s+net\.Socket\(/, 'raw TCP socket'], [/\btls\.connect\(/, 'raw TLS socket'], [/\bhttps?\.request\(|\bhttps?\.get\(/, 'node http/https client'], [/\bchild_process\b|\bexecFile\(|\bspawn\(/, 'child process']];

export function scanTarget(target) {
  const p = resolve(target);
  const files = [];
  const walk = (d, depth = 0) => { if (depth > 6 || !existsSync(d)) return; for (const e of readdirSync(d)) { if (['node_modules', '.git', 'workspace', 'test', 'tests', '__tests__'].includes(e)) continue; const q = join(d, e); const st = statSync(q); if (st.isDirectory()) walk(q, depth + 1); else if (/\.(m?js|cjs|ts)$/.test(e) && !/\.d\.ts$|\.test\.|\.spec\./.test(e) && st.size < 8 * 1024 * 1024) files.push(q); } };
  if (statSync(p).isDirectory()) walk(p); else files.push(p);
  const found = new Map();   // label -> Set(files)
  const hit = (label, f) => { if (!found.has(label)) found.set(label, new Set()); found.get(label).add(f.replace(p, '').replace(/^[\\/]/, '') || f); };
  let hasSrc = false, hasDist = false;
  for (const f of files) {
    if (/[\\/]src[\\/].*\.ts$/.test(f)) hasSrc = true; if (/[\\/]dist[\\/]/.test(f)) hasDist = true;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const importsOnly = text.match(/(?:from\s+['"][^'"]+['"]|require\(\s*['"][^'"]+['"]\s*\)|import\(\s*['"][^'"]+['"]\s*\))/g) || [];
    const importText = importsOnly.join('\n');
    for (const [pkg, label] of CLIENTS) if (importText.includes(`'${pkg}`) || importText.includes(`"${pkg}`) || importText.includes(`'${pkg}'`) ) hit(label, f);
    for (const [re, label] of RAW) if (re.test(text)) hit(label, f);
  }
  return { target: p, files: files.length, hasSrc, hasDist, backends: [...found.entries()].map(([label, fs]) => ({ label, files: [...fs].slice(0, 4), count: fs.size })).sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * Ceilings per posture, given what the scan found. Honest and specific: each row says what the
 * fidelity means, what blocks going higher, and the one command that unlocks the next level.
 */
export function feasibility(target, { allowExec = false } = {}) {
  const s = scanTarget(target);
  const dbLike = s.backends.filter(b => /database|cache|directory|queue|file share|remote shell|cloud API|email/.test(b.label));
  const netLike = s.backends.filter(b => /HTTP client|raw TCP|raw TLS|node http/.test(b.label));
  const compiledOnly = s.hasDist && !s.hasSrc;
  const isModule = !statSync(s.target).isDirectory(); // a describe.mjs: the author already bound handlers
  const execCeiling = dbLike.length ? 'L1 (partial)' : 'L1';
  const backendBlock = dbLike.length ? `handlers reach for ${dbLike.map(b => b.label).join(', ')}: those calls are refused by the sandbox, so logic AFTER the first backend call is not reached` : null;
  const stubUnlock = dbLike.length ? 'stub those clients with fakes in describe.mjs before binding (engine/docs/EXPORTING_A_TARGET.md, path B)' : null;
  const rows = [];
  if (isModule) {
    rows.push({ posture: 'bound module (describe.mjs), sandboxed', ceiling: execCeiling, means: 'the handlers the module binds run against recording fakes; secrets hidden; every outbound socket refused', blocks: backendBlock, unlock: stubUnlock });
  } else {
    rows.push({ posture: 'dry, read-only (default)', ceiling: 'L0', means: 'structural facts about the wiring and predictions; nothing executes', blocks: compiledOnly ? 'the package ships only compiled code, so even the tool list is a guess' : null, unlock: compiledOnly ? `node bin/gm2.mjs quick --target ${s.target} --allow-exec` : null });
    rows.push({ posture: 'dry, sandboxed execution (--allow-exec)', ceiling: execCeiling, means: 'real handlers run against recording fakes; secrets hidden; every outbound socket refused', blocks: backendBlock, unlock: stubUnlock && `write a describe.mjs that stubs those clients with fakes, then bind (engine/docs/EXPORTING_A_TARGET.md, path B)` });
  }
  rows.push({ posture: 'handoff boundary measurement (--handoff)', ceiling: 'L2', means: 'a real model drives the agent loop; gates, routing and pressure thresholds are MEASURED; tool calls land on fakes', blocks: 'answers come from the host harness model, not necessarily the target\'s configured model', unlock: `GRISTMILL_SANDBOX=1 node bin/gm2.mjs boundary --target ${s.target} --out <dir> --handoff <dir>/mailbox` });
  const llmRoundsWorthIt = isModule || allowExec || !compiledOnly;
  return {
    ...s,
    rows,
    verdict: !llmRoundsWorthIt
      ? 'LLM campaign rounds on this target under a read-only dry posture can only produce UNCERTAIN findings (0 confirmed by construction). Run the sandboxed execution or handoff step first; spend model turns after there is L1/L2 evidence to judge.'
      : dbLike.length
        ? 'Sandboxed execution will reach the real handler logic up to its first backend call. For findings about what happens after that call, stub the backends (path B). Boundary measurement gives L2 evidence about gates and pressure regardless.'
        : 'Sandboxed execution reaches the real handlers end to end against fakes; boundary measurement adds L2 behaviour. LLM rounds have real evidence to judge.',
  };
}

export function feasibilityMarkdown(f) {
  const L = ['## Evidence ceiling', ''];
  L.push(`Scanned ${f.files} code file(s)${f.hasDist && !f.hasSrc ? ' (compiled only, no readable source)' : ''}. Backends and side channels the code reaches for: ${f.backends.length ? f.backends.map(b => `${b.label} (${b.count})`).join(', ') : 'none detected'}.`, '');
  L.push('| Posture | Ceiling | What it means | What blocks going higher | Unlock |', '|---|---|---|---|---|');
  for (const r of f.rows) L.push(`| ${r.posture} | **${r.ceiling}** | ${r.means} | ${r.blocks || '—'} | ${r.unlock ? '`' + r.unlock + '`' : '—'} |`);
  L.push('', `**Verdict:** ${f.verdict}`, '');
  return L.join('\n');
}
