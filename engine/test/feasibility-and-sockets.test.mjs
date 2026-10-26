/**
 * Two accuracy fixes from the DeepSight campaign:
 *  1. the sandbox must refuse RAW SOCKETS (database/Redis/LDAP drivers never touch fetch);
 *  2. the evidence ceiling must be known BEFORE model turns are spent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { withSandbox } from '../lib/synth/shim.mjs';
import { feasibility, scanTarget } from '../lib/feasibility.mjs';
import { runQuick } from '../lib/quick.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'gm2fs-'));

test('sandbox refuses raw TCP, TLS and DNS while package code runs, and restores them after', async () => {
  const blocked = [];
  const tcp = await withSandbox(() => new Promise(res => { const s = net.connect(6379, '127.0.0.1'); s.on('error', e => res(e.code)); s.on('connect', () => res('CONNECTED')); }), { blocked });
  assert.equal(tcp, 'GRISTMILL_SANDBOX');
  await assert.rejects(withSandbox(async () => tls.connect(443, 'example.com'), { blocked }), /outbound connection refused \(tls/);
  await assert.rejects(withSandbox(() => dns.promises.lookup('example.com'), { blocked }), /outbound connection refused \(dns/);
  assert.ok(blocked.some(b => b.startsWith('tcp')) && blocked.some(b => b.startsWith('tls')) && blocked.some(b => b.startsWith('dns')), blocked.join(','));
  // Restored: a normal connect to a closed port fails with the OS error, not the sandbox's.
  const after = await new Promise(res => { const s = net.connect(1, '127.0.0.1'); s.on('error', e => res(e.code)); s.on('connect', () => res('CONNECTED')); });
  assert.notEqual(after, 'GRISTMILL_SANDBOX');
});

test('a handler that opens its own socket fails closed inside the harness and the attempt is recorded', async () => {
  const { normalizeModel } = await import('../lib/model.mjs');
  const { probeTool } = await import('../lib/synth/runtime.mjs');
  const m = normalizeModel({ target: { name: 'x' }, entries: [{ id: 'chat', kind: 'chat' }], actors: [{ id: 'orchestrator', kind: 'orchestrator', tools: ['t'] }],
    tools: [{ id: 't', name: 't', kind: 'read', params: [], sinks: [{ kind: 'output' }], handler: async (_a, ctx) => new Promise((res, rej) => { const s = net.connect(5432, 'db.internal'); s.on('error', rej); s.on('connect', () => res(ctx.output('reached db'))); }) }], gates: [], env: [], budgets: {} });
  const r = await probeTool(m, m.tools[0], m._handlers.t);
  const exec = r.observations.filter(o => o.check === 'EXECUTED');
  assert.ok(exec.length && exec.every(o => /refused/.test(o.detail)), exec.map(o => o.detail).join(' | '));
});

function fakePackage(dir, { src = true, backends = [] } = {}) {
  mkdirSync(join(dir, src ? 'src' : 'dist'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"id":"fp","version":"1"}');
  const imports = backends.map((b, i) => `import x${i} from '${b}';`).join('\n');
  writeFileSync(join(dir, src ? 'src/index.ts' : 'dist/index.js'), `${imports}\nexport function createTools(env) { return []; }\n`);
  return dir;
}

test('feasibility: a clean source package reaches L1 under sandboxed execution', () => {
  const f = feasibility(fakePackage(join(tmp, 'clean')));
  assert.deepEqual(f.backends, []);
  assert.equal(f.rows[1].ceiling, 'L1');
  assert.match(f.verdict, /end to end/);
});

test('feasibility: a backend-coupled compiled package is honest about its L0 dry ceiling and names the unlocks', () => {
  const f = feasibility(fakePackage(join(tmp, 'coupled'), { src: false, backends: ['@prisma/client', 'ioredis'] }));
  assert.ok(f.backends.some(b => /Prisma/.test(b.label)) && f.backends.some(b => /Redis/.test(b.label)));
  assert.equal(f.rows[0].ceiling, 'L0');
  assert.match(f.rows[0].unlock, /--allow-exec/);
  assert.equal(f.rows[1].ceiling, 'L1 (partial)');
  assert.match(f.rows[1].blocks, /Prisma.*Redis|Redis.*Prisma/);
  assert.match(f.rows[2].unlock, /--handoff/);
  assert.match(f.verdict, /UNCERTAIN findings \(0 confirmed by construction\)/);
});

test('scanTarget ignores node_modules and tests, and detects raw socket use', () => {
  const d = join(tmp, 'raw'); mkdirSync(join(d, 'src'), { recursive: true }); mkdirSync(join(d, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'pg', 'index.js'), "import x from 'pg';");
  writeFileSync(join(d, 'src', 'a.ts'), "const s = net.connect(389, host); tls.connect({ host });");
  const s = scanTarget(d);
  assert.ok(s.backends.some(b => b.label === 'raw TCP socket') && s.backends.some(b => b.label === 'raw TLS socket'));
  assert.ok(!s.backends.some(b => /Postgres/.test(b.label)), 'dependency sources are not scanned');
});

test('the quick brief carries the evidence ceiling', async () => {
  const r = await runQuick({ target: 'fixtures/compiled-agent', out: join(tmp, 'q'), render: false });
  assert.ok(r.brief.includes('## Evidence ceiling'));
  assert.ok(r.brief.includes('--allow-exec'));
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
