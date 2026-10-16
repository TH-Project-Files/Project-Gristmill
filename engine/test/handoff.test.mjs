/**
 * The handoff transport: the engine writes each model turn to a mailbox and a HOST answerer fills
 * it — no key, no network. This test IS the host agent, scripted: a watcher answers req/*.json by
 * standing in for the target model. It proves the gate logic runs end to end over the mailbox, and
 * that the fidelity label flows through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadTargetModule } from '../lib/extract/from-module.mjs';
import { normalizeModel } from '../lib/model.mjs';
import { deriveDimensions } from '../lib/lattice/dimensions.mjs';
import { instantiate } from '../lib/lattice/instantiate.mjs';
import { createModelRunner } from '../lib/runner/loop.mjs';
import { handoffTransport, detectTransport } from '../lib/runner/transports.mjs';
import { runCell } from '../lib/runner/index.mjs';
import { baseCoordsFor } from '../lib/boundary/refine.mjs';

const model = normalizeModel(await loadTargetModule('fixtures/example-agent/agent.mjs'));
const dims = deriveDimensions(model);
const SB = { GRISTMILL_SANDBOX: '1' };
const tmp = mkdtempSync(join(tmpdir(), 'gm2h-'));

// A scripted "host agent": given a request, decide the turn. `answer(request) -> {text,tool_uses}`.
function startAnswerer(mailbox, answer) {
  const reqDir = join(mailbox, 'req'), respDir = join(mailbox, 'resp');
  const done = new Set();
  const timer = setInterval(() => {
    if (!existsSync(reqDir)) return;
    for (const f of readdirSync(reqDir)) {
      if (!f.endsWith('.json') || done.has(f)) continue;
      const resp = join(respDir, f);
      if (existsSync(resp)) { done.add(f); continue; }
      let req; try { req = JSON.parse(readFileSync(join(reqDir, f), 'utf8')); } catch { continue; }
      writeFileSync(resp, JSON.stringify(answer(req)));
      done.add(f);
    }
  }, 10);
  return () => clearInterval(timer);
}

test('handoff transport creates the mailbox and writes host instructions', () => {
  const mb = join(tmp, 'mb0');
  handoffTransport({ mailbox: mb });
  assert.ok(existsSync(join(mb, 'req')) && existsSync(join(mb, 'resp')));
  const md = readFileSync(join(mb, 'MAILBOX.md'), 'utf8');
  assert.ok(md.includes('resp/NNNN.json') && md.includes('fresh context'));
});

test('a gated write over handoff: the host answers, the engine enforces the gate in code', async () => {
  const mb = join(tmp, 'mb1');
  const transport = handoffTransport({ mailbox: mb, pollMs: 5 });
  const stop = startAnswerer(mb, (req) => {
    // Act as the target: if we have not yet called reset, call it; after the gate reply, stop.
    const calledReset = req.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.name === 'reset_device'));
    return calledReset ? { text: 'Please confirm.', tool_uses: [] } : { tool_uses: [{ name: 'reset_device', input: { device_id: 'DEV-0042' } }] };
  });
  try {
    const runner = createModelRunner(model, { complete: (r) => transport.complete(r), modelId: transport.modelId });
    const cell = instantiate(model, baseCoordsFor(model, dims, 'reset_device', { entry: 'chat' }));
    const obs = await runCell(runner, model, cell, { env: SB });
    assert.equal(obs.gate_fired, true, 'the code gate fired on the host-driven call');
    assert.equal(obs.sensitive_ungated, false);
    assert.equal(obs.model_version, 'handoff:host-agent');
  } finally { stop(); }
});

test('an ungated side route over handoff is caught as a security failure', async () => {
  const mb = join(tmp, 'mb2');
  const transport = handoffTransport({ mailbox: mb, pollMs: 5 });
  // The host delegates to ops, then calls reset there (ops route has no code gate on this entry).
  const stop = startAnswerer(mb, (req) => {
    const actor = req.system || '';
    const didReset = req.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && b.name === 'reset_device'));
    if (/remediation tasks/.test(actor)) return didReset ? { text: 'done', tool_uses: [] } : { tool_uses: [{ name: 'reset_device', input: { device_id: 'DEV-0042' } }] };
    const delegated = req.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use' && String(b.name).startsWith('delegate_to_')));
    return delegated ? { text: 'handled', tool_uses: [] } : { tool_uses: [{ name: 'delegate_to_ops', input: { task: 'reset DEV-0042' } }] };
  });
  try {
    const runner = createModelRunner(model, { complete: (r) => transport.complete(r), modelId: transport.modelId });
    const cell = instantiate(model, baseCoordsFor(model, dims, 'reset_device', { entry: 'chat' }));
    const obs = await runCell(runner, model, cell, { env: SB });
    assert.equal(obs.sensitive_ungated, true, 'reset via the ungated ops route is flagged');
  } finally { stop(); }
});

test('detectTransport selects handoff and --handoff implies it even without keys', () => {
  const { transport, how } = detectTransport({ handoff: join(tmp, 'mb3') }, {});
  assert.equal(transport.id, 'handoff');
  assert.match(how, /host agent answers/);
});

test('handoff times out with a clear message when nobody answers', async () => {
  const transport = handoffTransport({ mailbox: join(tmp, 'mb4'), timeoutMs: 40, pollMs: 5 });
  await assert.rejects(() => transport.complete({ system: 's', tools: [], messages: [] }), /no answer for req\/0001\.json/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
